// t1153: a second Siri first-connect (new client id) replaces the older Siri record like every other agent,
// revokes the old client's tokens, and a failure on that last step is logged and answered with calm copy (nothing saved, nothing charged).
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {generateKeyPairSync,sign} from 'node:crypto';
import {createOAuth,firstConnectText,replaceSiriAgent,reserveOAuthAgent} from '../kit/oauth.mjs';
import {createEverydayLimits,consentSpend} from '../src/v5/everyday-limits.mjs';
import {p256VerifyDigest,fingerprint} from '../src/v5/phone-signer.mjs';
const W='0x1000000000000000000000000000000000000001';
const FLOOR={single:1000_000000n,daily:10000_000000n,term:100000_000000n};
const AM={single:'100000000',daily:'1000000000',total:'1000000000'};
const key=()=>{const k=generateKeyPairSync('ec',{namedCurve:'P-256'});const j=k.publicKey.export({format:'jwk'});const h=b=>'0x'+Buffer.from(b,'base64url').toString('hex');
  const x=h(j.x),y=h(j.y);return {x,y,fingerprint:fingerprint(x,y),approver:'0x'+'ab'.repeat(20),
    sig:text=>{const s=sign('sha256',Buffer.from(text),{key:k.privateKey,dsaEncoding:'ieee-p1363'});const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;let sv=BigInt('0x'+s.subarray(32).toString('hex'));if(sv>N/2n)sv=N-sv;
      return {r:'0x'+s.subarray(0,32).toString('hex'),s:'0x'+sv.toString(16).padStart(64,'0')};}};};
function harness({agents={},createAgentKey=null}={}){const phone=key(),S={},logs=[],revoked=[];const mem=new Map();const kv={get:k=>mem.get(k),set:(k,v)=>mem.set(k,v),del:k=>mem.delete(k)};
  const ev=createEverydayLimits({kv,wallet:W,floor:()=>FLOOR});
  const commitSpend=a=>{const kn=[...mem.keys()][0];const prior=kn?mem.get(kn):undefined;const r=ev.set({single:a.single,daily:a.daily,term:a.total});if(!r.ok)return r;const v=consentSpend(ev.get());
    return {ok:true,limits:{perPayment:v.perPayment,perDay:v.perDay,termTotal:v.termTotal,at:v.at??null},undo(){if(prior===undefined)ev.forget();else mem.set(kn,prior);}};};
  let O;
  const mk=createAgentKey??((name,kind,clientId)=>{const r=replaceSiriAgent(agents,{kind,clientId,knownIds:new Set(['siri','muse']),revoke:k=>{revoked.push(k);O.revokeAgent(k);}});if(!r.ok){const e=Error(r.error);e.code=r.error;throw e;}return r.id;});
  O=createOAuth({S,save:()=>{},base:()=>'https://pay.example',network:'main',wallet:W,ownerAddress:'0x2222',verifyOwner:async()=>false,createAgentKey:mk,isAgentLive:()=>true,caps:()=>null,ownerSession:()=>null,
    spendAuthorization:()=>consentSpend(ev.get()),commitSpend,log:(k,v)=>logs.push([k,v]),phoneApprover:{active:()=>phone,onChain:async()=>true,verify:(a,d,r,s)=>p256VerifyDigest(a,d,r,s)}});
  const call=async(path,body)=>{let out,code,hdr;const res={writeHead(c,h){code=c;hdr=h;},end(b){out=b;}};
    await O.handle({method:'POST',headers:{}},res,new URL('https://pay.example'+path),{readBody:async()=>body,ip:'203.0.113.9'});return {code,out:JSON.parse(out)};};
  return {S,O,phone,ev,call,agents,logs,revoked};}
async function siri(t){const st=await t.call('/oauth/first',{agent:'siri',...AM});assert.equal(st.code,200);
  const text=firstConnectText({wallet:W,clientId:st.out.clientId,agent:'Siri',request:st.out.req,redirect:st.out.redirect,...AM,action:'approve',nonce:st.out.nonce,exp:st.out.exp});
  return {st,d:await t.call('/oauth/phone-decide',{req:st.out.req,approve:true,...t.phone.sig(text)})};}

test('Siri reconnect with an older oauth-siri record: approved, old record replaced and its tokens revoked, other rows untouched',async()=>{
  const phoneRow={id:'siri',clientId:'phone',name:'Siri',kind:'siri'},muse={id:'muse',clientId:'c1',name:'Muse',kind:'muse'};
  const agents={'oauth-siri':{id:'oauth-siri',name:'Siri',kind:'custom',clientId:'kpc_OLD',created:'2026-11-14T00:00:00Z'},siri:{...phoneRow},muse:{...muse}};
  const t=harness({agents});
  t.S.oauth??={clients:{},pending:{},codes:{},tokens:{}};t.S.oauth.tokens.oldtok={agentId:'oauth-siri',exp:Date.now()/1000+3600};
  const {st,d}=await siri(t);
  assert.equal(d.code,200);assert.equal(d.out.status,'approved');
  assert.equal(t.agents['oauth-siri'].clientId,st.out.clientId);assert.deepEqual(t.revoked,['oauth-siri']);
  assert.equal(t.S.oauth.tokens.oldtok,undefined,'old Siri token revoked');
  assert.deepEqual(t.agents.siri,phoneRow);assert.deepEqual(t.agents.muse,muse);
  assert.equal(t.ev.get().authorized,true);assert.equal(t.ev.get().single,AM.single);});
test('fresh Siri first-connect still works and revokes nothing',async()=>{const t=harness();const {d}=await siri(t);assert.equal(d.out.status,'approved');assert.deepEqual(t.revoked,[]);});
test('same Siri client reserving twice keeps one row (idempotent)',()=>{const a={};const r1=replaceSiriAgent(a,{kind:'custom',clientId:'kpc_1'});const r2=replaceSiriAgent(a,{kind:'custom',clientId:'kpc_1'});
  assert.equal(r1.ok&&r2.ok,true);assert.equal(r2.replaced,undefined);assert.equal(Object.keys(a).length,1);});
test('reserveOAuthAgent itself still refuses a clashing client id (guard kept)',()=>{const a={'oauth-siri':{id:'oauth-siri',clientId:'x'}};assert.equal(reserveOAuthAgent(a,{name:'Siri',kind:'custom',clientId:'y'}).error,'agent_id_in_use');});
test('a failure on the last step is logged, answered calmly, and saves nothing',async()=>{
  const t=harness({createAgentKey:()=>{const e=Error('agent_id_in_use');e.code='agent_id_in_use';throw e;}});
  const {st,d}=await siri(t);
  assert.equal(d.code,409);assert.equal(d.out.error,'connect_failed');assert.match(d.out.error_description,/没有保存额度，也没有扣钱/);assert.match(d.out.error_description,/nothing was charged/);
  assert.equal(t.ev.get().authorized,false,'limits rolled back');assert.equal(t.S.oauth.pending[st.out.req].status,'pending');
  assert.deepEqual(t.logs,[['oauth_connect_failed',{route:'/oauth/phone-decide',reason:'agent_id_in_use'}]]);
  assert.doesNotMatch(JSON.stringify(t.logs),/0x[0-9a-f]{40}|kpc_/i,'log carries no address or client id');});
test('mainnet launcher wires replaceSiriAgent with token revoke and passes a log hook',()=>{
  const src=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(src,/replaceSiriAgent\(S\.oauthAgents,\{kind,clientId,knownIds,revoke:k=>OA\.revokeAgent\(k\)\}\)/);
  assert.match(src,/createOAuth\(\{S,save,base:\(\)=>PUBLIC,network:'main',log:\(k,v\)=>OBS\.log\(k,v\)/);});
