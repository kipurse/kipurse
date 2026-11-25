// t1157: after a Siri first-connect (fresh, or U3 with an older oauth-siri record) the owner app sees exactly ONE Siri, connected,
// in state.agents and in GET /safety/mandates; phone-decide returns the saved AI limits (state.everyday shape).
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {generateKeyPairSync,sign} from 'node:crypto';
import {createOAuth,firstConnectText,replaceSiriAgent} from '../kit/oauth.mjs';
import {createEverydayLimits,consentSpend} from '../src/v5/everyday-limits.mjs';
import {p256VerifyDigest,fingerprint} from '../src/v5/phone-signer.mjs';
import {stateAgents,mandateAgents} from '../src/v5/agent-list.mjs';
const W='0x1000000000000000000000000000000000000001';const FLOOR={single:1000_000000n,daily:10000_000000n,term:100000_000000n};
const AM={single:'2000000',daily:'5000000',total:'30000000'};
const key=()=>{const k=generateKeyPairSync('ec',{namedCurve:'P-256'});const j=k.publicKey.export({format:'jwk'});const h=b=>'0x'+Buffer.from(b,'base64url').toString('hex');const x=h(j.x),y=h(j.y);
  return {x,y,fingerprint:fingerprint(x,y),approver:'0x'+'ab'.repeat(20),sig:text=>{const s=sign('sha256',Buffer.from(text),{key:k.privateKey,dsaEncoding:'ieee-p1363'});const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;let sv=BigInt('0x'+s.subarray(32).toString('hex'));if(sv>N/2n)sv=N-sv;return {r:'0x'+s.subarray(0,32).toString('hex'),s:'0x'+sv.toString(16).padStart(64,'0')};}};};
function world({oldSiri=false,others=true,withView=true}={}){
  const phone=key(),S={oauthAgents:{},phone:{active:true},agentLastSeen:{}};const mem=new Map();const kv={get:k=>mem.get(k),set:(k,v)=>mem.set(k,v),del:k=>mem.delete(k)};
  const EVD=createEverydayLimits({kv,wallet:W,floor:()=>FLOOR});let O;
  if(oldSiri)S.oauthAgents['oauth-siri']={id:'oauth-siri',name:'Siri',kind:'custom',clientId:'kpc_OLD',created:'2026-11-14T00:00:00Z'};
  if(others)S.oauthAgents['grok-bot']={id:'grok-bot',name:'Grok Bot',kind:'grok-bot',clientId:'c_grok',created:'2026-11-10T00:00:00Z'};
  const createAgentKey=(name,kind,clientId)=>{const r=replaceSiriAgent(S.oauthAgents,{kind,clientId,knownIds:new Set(['siri','muse']),revoke:k=>O.revokeAgent(k)});if(!r.ok)throw Object.assign(Error(r.error),{code:r.error});return r.id;};
  const commitSpend=a=>{const r=EVD.set({single:a.single,daily:a.daily,term:a.total});if(!r.ok)return r;const v=consentSpend(EVD.get());return {ok:true,limits:{perPayment:v.perPayment,perDay:v.perDay,termTotal:v.termTotal,at:v.at??null},undo(){EVD.forget();}};};
  O=createOAuth({S,save:()=>{},base:()=>'https://pay.example',network:'main',wallet:W,ownerAddress:'0x2222',verifyOwner:async()=>false,createAgentKey,isAgentLive:()=>true,caps:()=>null,ownerSession:()=>null,
    spendAuthorization:()=>consentSpend(EVD.get()),commitSpend,...(withView?{everydayView:()=>EVD.get()}:{}),onConnected:n=>{if(n==='Siri')S.siriAgent={since:new Date().toISOString()};},log:()=>{},
    phoneApprover:{active:()=>phone,onChain:async()=>true,verify:(a,d,r,s)=>p256VerifyDigest(a,d,r,s)}});
  if(oldSiri)S.oauth.tokens.oldtok={type:'access',agentId:'oauth-siri',exp:Date.now()/1000+3600};
  if(others)S.oauth.tokens.grok={type:'access',agentId:'grok-bot',exp:Date.now()/1000+3600};
  const call=async(path,body)=>{let out,code;const res={writeHead(c){code=c;},end(b){out=b;}};await O.handle({method:'POST',headers:{}},res,new URL('https://pay.example'+path),{readBody:async()=>body,ip:'203.0.113.9'});return {code,out:JSON.parse(out)};};
  const agents=()=>stateAgents({tokenAgents:[],oauthAgents:S.oauthAgents,tokens:S.oauth?.tokens,phoneActive:!!S.phone?.active,siriAgent:S.siriAgent,spendOk:()=>EVD.get().authorized===true,lastSeen:S.agentLastSeen});
  const mand=()=>mandateAgents({tokenAgents:[],oauthAgents:S.oauthAgents,siriAgent:S.siriAgent});
  const connect=async()=>{const f=await call('/oauth/first',{agent:'siri',...AM});assert.equal(f.code,200);
    const text=firstConnectText({wallet:W,clientId:f.out.clientId,agent:'Siri',request:f.out.req,redirect:f.out.redirect,...AM,action:'approve',nonce:f.out.nonce,exp:f.out.exp});
    return await call('/oauth/phone-decide',{req:f.out.req,approve:true,...phone.sig(text)});};
  return {S,EVD,agents,mand,connect};}
const siris=list=>list.filter(a=>[a.id,a.kind,a.name].filter(Boolean).some(s=>String(s).toLowerCase().includes('siri')));
for(const oldSiri of [false,true])test(`${oldSiri?'U3 (older oauth-siri record)':'fresh'} Siri connect: state.agents has exactly one Siri, id siri, connected; mandates one Siri`,async()=>{
  const w=world({oldSiri});const d=await w.connect();assert.equal(d.code,200);assert.equal(d.out.status,'approved');
  const s=siris(w.agents());assert.equal(s.length,1,JSON.stringify(w.agents()));assert.equal(s[0].id,'siri');assert.equal(s[0].kind,'siri');assert.equal(s[0].connected,true);
  const m=siris(w.mand());assert.equal(m.length,1,JSON.stringify(w.mand()));assert.equal(m[0].id,'siri');
  const g=w.agents().find(a=>a.id==='grok-bot');assert.equal(g?.connected,true,'other OAuth agents unchanged');assert.ok(w.mand().some(a=>a.id==='grok-bot'));
  assert.ok(w.S.oauthAgents['oauth-siri'],'the record itself is kept (revoke/replace logic untouched)');});
test('phone-decide reply carries the saved AI limits in state.everyday shape',async()=>{const w=world();const d=await w.connect();
  assert.equal(d.out.everyday?.authorized,true);assert.equal(d.out.everyday?.custom,true);assert.ok(Number(d.out.everyday?.at)>0);
  assert.equal(d.out.everyday?.requestedSingle,AM.single);assert.equal(d.out.everyday?.requestedDaily,AM.daily);assert.equal(d.out.everyday?.requestedTerm,AM.total);
  assert.deepEqual(d.out.everyday,w.EVD.get());});
test('without the everydayView hook the reply is unchanged (status + redirect only)',async()=>{const w=world({withView:false});const d=await w.connect();assert.deepEqual(Object.keys(d.out).sort(),['redirect','status']);});
test('before limits are saved Siri is listed once and not connected',()=>{const w=world({oldSiri:true});const s=siris(w.agents());assert.equal(s.length,1);assert.equal(s[0].id,'siri');assert.equal(s[0].connected,false);});
test('no phone, no Siri connection: no Siri row at all',()=>{assert.deepEqual(siris(stateAgents({oauthAgents:{'oauth-siri':{id:'oauth-siri',name:'Siri',clientId:'x'}}})),[]);});
test('stopped Siri stays paused; revoked oauth-siri does not add a mandates Siri',()=>{const l=stateAgents({phoneActive:true,spendOk:()=>true,siriStopped:()=>true});assert.equal(l[0].paused,true);
  assert.deepEqual(mandateAgents({oauthAgents:{'oauth-siri':{revoked:true}}}),[]);});
test('mainnet launcher uses the shared lists and the everydayView hook',()=>{const src=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(src,/AGL\.stateAgents\(/);assert.match(src,/AGL\.mandateAgents\(/);assert.match(src,/everydayView:\(\)=>EVD\.get\(\)/);});
