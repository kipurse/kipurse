// t1137u: /oauth/phone-prepare (first connection with amounts) must return the nonce that its digest binds.
// Before the fix it returned `nonce` undefined (dropped from JSON), so the App stopped with
// 「这台服务器不能同时确认额度和连接，没有批准。」 and nothing could be approved.
import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,sign} from 'node:crypto';
import {createOAuth,firstConnectText,firstConnectDigest} from '../kit/oauth.mjs';
import {createEverydayLimits,consentSpend} from '../src/v5/everyday-limits.mjs';
import {p256VerifyDigest,fingerprint} from '../src/v5/phone-signer.mjs';
const W='0x1000000000000000000000000000000000000001';
const FLOOR={single:10_000_000n,daily:50_000_000n,term:200_000_000n};
const key=()=>{const k=generateKeyPairSync('ec',{namedCurve:'P-256'});const j=k.publicKey.export({format:'jwk'});const h=b=>'0x'+Buffer.from(b,'base64url').toString('hex');
  const x=h(j.x),y=h(j.y);return {x,y,fingerprint:fingerprint(x,y),approver:'0x'+'ab'.repeat(20),
    sig:text=>{const s=sign('sha256',Buffer.from(text),{key:k.privateKey,dsaEncoding:'ieee-p1363'});const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;let sv=BigInt('0x'+s.subarray(32).toString('hex'));if(sv>N/2n)sv=N-sv;
      return {r:'0x'+s.subarray(0,32).toString('hex'),s:'0x'+sv.toString(16).padStart(64,'0')};}};};
function harness(){const phone=key(),S={},agents=[];const mem=new Map();
  const kv={get:k=>mem.get(k),set:(k,v)=>mem.set(k,v),del:k=>mem.delete(k)};
  const ev=createEverydayLimits({kv,wallet:W,floor:()=>FLOOR,now:()=>1710000000000});
  const commitSpend=a=>{const r=ev.set({single:a.single,daily:a.daily,term:a.total});if(!r.ok)return r;const v=consentSpend(ev.get());return {ok:true,limits:{perPayment:v.perPayment,perDay:v.perDay,termTotal:v.termTotal,at:v.at??null},undo(){ev.forget();}};};
  const O=createOAuth({S,save:()=>{},base:()=>'https://pay.example',network:'main',wallet:W,ownerAddress:'0x2222',verifyOwner:async()=>false,
    createAgentKey:(n,k)=>{agents.push(k);return k;},isAgentLive:()=>true,caps:()=>null,ownerSession:()=>null,
    spendAuthorization:()=>consentSpend(ev.get()),commitSpend,
    phoneApprover:{active:()=>phone,onChain:async()=>true,verify:(a,d,r,s)=>p256VerifyDigest(a,d,r,s)}});
  const call=async(path,body,method='POST')=>{let out,code,hdr;const res={writeHead(c,h){code=c;hdr=h;},end(b){out=b;}};
    await O.handle({method,headers:{}},res,new URL('https://pay.example'+path),{readBody:async()=>body,ip:'203.0.113.9'});return {code,out:hdr?.['content-type']?.includes('json')?JSON.parse(out):out};};
  return {S,phone,agents,ev,call};}
const AMOUNTS={single:'2500000',daily:'7000000',total:'15000000'};
async function pendingFromAI(t){const r=await t.call('/oauth/register',{client_name:'Muse',redirect_uris:['https://muse.ai/api/hatch/oauth/callback']});
  await t.call(`/oauth/authorize?response_type=code&client_id=${r.out.client_id}&redirect_uri=${encodeURIComponent('https://muse.ai/api/hatch/oauth/callback')}&code_challenge=${'A'.repeat(43)}&code_challenge_method=S256`,null,'GET');
  return Object.keys(t.S.oauth.pending).find(k=>t.S.oauth.pending[k].client_id===r.out.client_id);}
test('t1137u: prepare with amounts returns mode first + the nonce its digest binds; the App-style signature approves both',async()=>{
  const t=harness();const id=await pendingFromAI(t);
  const prep=await t.call('/oauth/phone-prepare',{req:id,...AMOUNTS});
  assert.equal(prep.code,200);assert.equal(prep.out.mode,'first');
  assert.equal(typeof prep.out.nonce,'string');assert.ok(prep.out.nonce.length>=8,'nonce present');
  assert.equal(prep.out.nonce,t.S.oauth.pending[id].proposal.nonce);
  for(const k of ['single','daily','total'])assert.equal(prep.out[k],AMOUNTS[k]);
  // What the App does: rebuild the statement from the response fields alone and compare with the server digest.
  const f={wallet:prep.out.wallet,clientId:prep.out.clientId,agent:prep.out.name,request:id,redirect:prep.out.redirect,...AMOUNTS,action:'approve',nonce:prep.out.nonce,exp:prep.out.exp};
  assert.equal(firstConnectDigest(f),prep.out.digest);
  assert.equal(firstConnectDigest({...f,action:'reject'}),prep.out.rejectDigest);
  const d=await t.call('/oauth/phone-decide',{req:id,approve:true,...t.phone.sig(firstConnectText(f))});
  assert.equal(d.out.status,'approved');assert.equal(t.ev.get().authorized,true);assert.equal(t.ev.get().term,'15000000');assert.equal(t.agents.length,1);});
test('t1137u: reject from the first-connect statement writes nothing',async()=>{
  const t=harness();const id=await pendingFromAI(t);
  const prep=await t.call('/oauth/phone-prepare',{req:id,...AMOUNTS});
  const f={wallet:prep.out.wallet,clientId:prep.out.clientId,agent:prep.out.name,request:id,redirect:prep.out.redirect,...AMOUNTS,action:'reject',nonce:prep.out.nonce,exp:prep.out.exp};
  const d=await t.call('/oauth/phone-decide',{req:id,approve:false,...t.phone.sig(firstConnectText(f))});
  assert.equal(d.out.status,'denied');assert.equal(t.ev.get().authorized,false);assert.equal(t.agents.length,0);});
