import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {createOAuth,connectText,firstConnectText,firstConnectDigest} from '../kit/oauth.mjs';
import {createEverydayLimits,consentSpend} from '../src/v5/everyday-limits.mjs';
import {p256VerifyDigest,fingerprint} from '../src/v5/phone-signer.mjs';
const W='0x1000000000000000000000000000000000000001';
const FLOOR={single:10_000_000n,daily:50_000_000n,term:200_000_000n};
const key=()=>{const k=generateKeyPairSync('ec',{namedCurve:'P-256'});const j=k.publicKey.export({format:'jwk'});const h=b=>'0x'+Buffer.from(b,'base64url').toString('hex');
  const x=h(j.x),y=h(j.y);return {x,y,fingerprint:fingerprint(x,y),approver:'0x'+'ab'.repeat(20),
    sig:text=>{const s=sign('sha256',Buffer.from(text),{key:k.privateKey,dsaEncoding:'ieee-p1363'});const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;let sv=BigInt('0x'+s.subarray(32).toString('hex'));if(sv>N/2n)sv=N-sv;
      return {r:'0x'+s.subarray(0,32).toString('hex'),s:'0x'+sv.toString(16).padStart(64,'0')};}};};
function harness({throwOnAgent=false,authorized=false}={}){const phone=key(),S={},agents=[];const mem=new Map();
  const kv={get:k=>mem.get(k),set:(k,v)=>mem.set(k,v),del:k=>mem.delete(k)};
  const ev=createEverydayLimits({kv,wallet:W,floor:()=>FLOOR,now:()=>1710000000000});
  if(authorized)ev.set({single:'2000000',daily:'5000000',term:'30000000'});
  const commitSpend=amounts=>{const keyName=[...mem.keys()][0];const prior=keyName?mem.get(keyName):undefined;const r=ev.set({single:amounts.single,daily:amounts.daily,term:amounts.total});if(!r.ok)return r;
    const view=consentSpend(ev.get());return {ok:true,limits:{perPayment:view.perPayment,perDay:view.perDay,termTotal:view.termTotal,at:view.at??null},undo(){if(prior===undefined)ev.forget();else mem.set([...mem.keys()][0],prior);}};};
  const O=createOAuth({S,save:()=>{},base:()=>'https://pay.example',network:'main',wallet:W,ownerAddress:'0x2222',verifyOwner:async()=>false,
    createAgentKey:(n,k)=>{if(throwOnAgent)throw Error('agent failed');agents.push(k);return k;},isAgentLive:()=>true,caps:()=>null,ownerSession:()=>null,
    spendAuthorization:()=>consentSpend(ev.get()),commitSpend,
    phoneApprover:{active:()=>phone,onChain:async()=>true,verify:(a,d,r,s)=>p256VerifyDigest(a,d,r,s)}});
  const call=async(path,body,method='POST')=>{let out,code,hdr;const res={writeHead(c,h){code=c;hdr=h;},end(b){out=b;}};
    await O.handle({method,headers:{}},res,new URL('https://pay.example'+path),{readBody:async()=>body,ip:'203.0.113.9'});return {code,out:hdr?.['content-type']?.includes('json')?JSON.parse(out):out};};
  return {S,O,phone,agents,ev,mem,call};}
const AMOUNTS={single:'2500000',daily:'7000000',total:'15000000'};
test('first-connect text binds wallet, client, agent, request, redirect, amounts, action, nonce and expiry',()=>{
  const text=firstConnectText({wallet:'0xAB',clientId:'kpc_1',agent:'Siri',request:'req1',redirect:'https://kipurse.com/connect/Siri',single:'2500000',daily:'7000000',total:'15000000',action:'approve',nonce:'n1',exp:1700000000.9});
  assert.equal(text,'Kipurse approve first connection v1\nwallet:0xab\nclient:kpc_1\nagent:Siri\nrequest:req1\nredirect:https://kipurse.com/connect/Siri\nsingle:2500000\ndaily:7000000\ntotal:15000000\naction:approve\nnonce:n1\nexp:1700000000');
  assert.equal(firstConnectDigest({wallet:'0xab',clientId:'kpc_1',agent:'Siri',request:'req1',redirect:'https://kipurse.com/connect/Siri',single:'2500000',daily:'7000000',total:'15000000',action:'approve',nonce:'n1',exp:1700000000}),'0x'+createHash('sha256').update(text).digest('hex'));
  assert.notEqual(text,connectText({wallet:'0xab',req:'req1',clientId:'kpc_1',name:'Siri',redirect:'https://kipurse.com/connect/Siri',exp:1700000000,action:'approve'}));});
test('signature writes the policy and the connection together; a bad signature, expiry, or reject writes neither',async()=>{
  const t=harness();const started=await t.call('/oauth/first',{agent:'siri',...AMOUNTS});
  assert.equal(started.code,200);assert.equal(started.out.mode,'first');assert.equal(t.ev.get().authorized,false);assert.equal(t.agents.length,0);
  const bad=await t.call('/oauth/phone-decide',{req:started.out.req,approve:true,r:'0x'+'11'.repeat(32),s:'0x'+'22'.repeat(32)});
  assert.equal(bad.out.error,'bad_signature');assert.equal(t.ev.get().authorized,false);assert.equal(t.agents.length,0);assert.equal(t.S.oauth.pending[started.out.req].status,'pending');
  const v1=connectText({wallet:W,req:started.out.req,clientId:started.out.clientId,name:'Siri',redirect:started.out.redirect,exp:started.out.exp,action:'approve'});
  const old=await t.call('/oauth/phone-decide',{req:started.out.req,approve:true,...t.phone.sig(v1)});
  assert.equal(old.out.error,'bad_signature');assert.equal(t.ev.get().authorized,false);assert.equal(t.agents.length,0);
  const reject=firstConnectText({wallet:W,clientId:started.out.clientId,agent:'Siri',request:started.out.req,redirect:started.out.redirect,single:AMOUNTS.single,daily:AMOUNTS.daily,total:AMOUNTS.total,action:'reject',nonce:started.out.nonce,exp:started.out.exp});
  const denied=await t.call('/oauth/phone-decide',{req:started.out.req,approve:false,...t.phone.sig(reject)});
  assert.equal(denied.out.status,'denied');assert.equal(t.ev.get().authorized,false);assert.equal(t.agents.length,0);
  const again=await t.call('/oauth/first',{agent:'muse',...AMOUNTS});
  t.S.oauth.pending[again.out.req].exp=Date.now()/1000-5;
  const expired=await t.call('/oauth/phone-decide',{req:again.out.req,approve:true,...t.phone.sig(firstConnectText({wallet:W,clientId:again.out.clientId,agent:'Muse',request:again.out.req,redirect:again.out.redirect,...AMOUNTS,action:'approve',nonce:again.out.nonce,exp:again.out.exp}))});
  assert.equal(expired.code,400);assert.equal(t.ev.get().authorized,false);
  const ok=await t.call('/oauth/first',{agent:'claude',...AMOUNTS});
  const text=firstConnectText({wallet:W,clientId:ok.out.clientId,agent:'Claude',request:ok.out.req,redirect:ok.out.redirect,...AMOUNTS,action:'approve',nonce:ok.out.nonce,exp:ok.out.exp});
  assert.equal(ok.out.digest,firstConnectDigest({wallet:W,clientId:ok.out.clientId,agent:'Claude',request:ok.out.req,redirect:ok.out.redirect,...AMOUNTS,action:'approve',nonce:ok.out.nonce,exp:ok.out.exp}));
  const done=await t.call('/oauth/phone-decide',{req:ok.out.req,approve:true,...t.phone.sig(text)});
  assert.equal(done.code,200);assert.equal(done.out.status,'approved');assert.equal(t.ev.get().authorized,true);assert.equal(t.ev.get().term,'15000000');assert.deepEqual(t.agents,['claude-desktop']);});
test('a failed connection rolls the new policy back and leaves the request pending',async()=>{
  const t=harness({throwOnAgent:true});const ok=await t.call('/oauth/first',{agent:'siri',...AMOUNTS});
  const text=firstConnectText({wallet:W,clientId:ok.out.clientId,agent:'Siri',request:ok.out.req,redirect:ok.out.redirect,...AMOUNTS,action:'approve',nonce:ok.out.nonce,exp:ok.out.exp});
  await assert.rejects(()=>t.call('/oauth/phone-decide',{req:ok.out.req,approve:true,...t.phone.sig(text)}));
  assert.equal(t.ev.get().authorized,false);assert.equal(t.agents.length,0);assert.equal(t.S.oauth.pending[ok.out.req].status,'pending');});
test('limits that changed after the statement was issued approve neither the policy nor the connection',async()=>{
  const t=harness();const ok=await t.call('/oauth/first',{agent:'grok',...AMOUNTS});
  t.ev.set({single:'2000000',daily:'5000000',term:'30000000'});
  const text=firstConnectText({wallet:W,clientId:ok.out.clientId,agent:'Grok Bot',request:ok.out.req,redirect:ok.out.redirect,...AMOUNTS,action:'approve',nonce:ok.out.nonce,exp:ok.out.exp});
  const d=await t.call('/oauth/phone-decide',{req:ok.out.req,approve:true,...t.phone.sig(text)});
  assert.equal(d.out.error,'ai_limits_stale');assert.equal(t.ev.get().term,'30000000');assert.equal(t.agents.length,0);assert.equal(t.S.oauth.pending[ok.out.req].status,'pending');});
test('an already confirmed policy still uses the v1 statement and is not rewritten',async()=>{
  const t=harness({authorized:true});const r=await t.call('/oauth/register',{client_name:'Muse',redirect_uris:['https://muse.ai/api/hatch/oauth/callback']});
  await t.call(`/oauth/authorize?response_type=code&client_id=${r.out.client_id}&redirect_uri=${encodeURIComponent('https://muse.ai/api/hatch/oauth/callback')}&code_challenge=${'A'.repeat(43)}&code_challenge_method=S256`,null,'GET');
  const id=Object.keys(t.S.oauth.pending)[0];const prep=await t.call('/oauth/phone-prepare',{req:id,...AMOUNTS});
  assert.equal(prep.out.mode,'reuse');assert.equal(prep.out.digest,'0x'+createHash('sha256').update(connectText({wallet:W,req:id,clientId:r.out.client_id,name:'Muse',redirect:'https://muse.ai/api/hatch/oauth/callback',exp:t.S.oauth.pending[id].exp,action:'approve'})).digest('hex'));
  const before=t.ev.get().at;const d=await t.call('/oauth/phone-decide',{req:id,approve:true,...t.phone.sig(connectText({wallet:W,req:id,clientId:r.out.client_id,name:'Muse',redirect:'https://muse.ai/api/hatch/oauth/callback',exp:t.S.oauth.pending[id].exp,action:'approve'}))});
  assert.equal(d.out.status,'approved');assert.equal(t.ev.get().at,before);assert.equal(t.ev.get().term,'30000000');});
test('amounts above the floor write nothing and create no connection',async()=>{
  const t=harness();const ok=await t.call('/oauth/first',{agent:'siri',single:'20000000',daily:'60000000',total:'60000000'});
  const text=firstConnectText({wallet:W,clientId:ok.out.clientId,agent:'Siri',request:ok.out.req,redirect:ok.out.redirect,single:'20000000',daily:'60000000',total:'60000000',action:'approve',nonce:ok.out.nonce,exp:ok.out.exp});
  const d=await t.call('/oauth/phone-decide',{req:ok.out.req,approve:true,...t.phone.sig(text)});
  assert.equal(d.code,403);assert.equal(t.ev.get().authorized,false);assert.equal(t.agents.length,0);});
