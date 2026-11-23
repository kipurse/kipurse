// t1158u (handbook §6#77): Siri has the same payment ability as every other AI. Server side:
// a Siri-scoped revocable credential issued on the signed Siri approval (hash only, bound to the phone signer), accepted ONLY by
// POST /siri/buy; revoked by Siri disconnect / emergency stop / pause / a newer Siri approval; trust-list names resolved on the
// server; an owner-approved over-limit Siri payment is completed once with a derived idempotency key.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {generateKeyPairSync,sign} from 'node:crypto';
import {createOAuth,firstConnectText,replaceSiriAgent} from '../kit/oauth.mjs';
import {createEverydayLimits,consentSpend} from '../src/v5/everyday-limits.mjs';
import {p256VerifyDigest,fingerprint} from '../src/v5/phone-signer.mjs';
import {createSiriCred,SIRI_CRED_RE} from '../src/v5/siri-cred.mjs';
import {createSiriAgent,siriPayee} from '../src/v5/siri.mjs';
const W='0x1000000000000000000000000000000000000001';const FLOOR={single:1000_000000n,daily:10000_000000n,term:100000_000000n};
const AM={single:'2000000',daily:'5000000',total:'30000000'};
const req=t=>({headers:t?{authorization:'Bearer '+t}:{}});
const key=()=>{const k=generateKeyPairSync('ec',{namedCurve:'P-256'});const j=k.publicKey.export({format:'jwk'});const h=b=>'0x'+Buffer.from(b,'base64url').toString('hex');const x=h(j.x),y=h(j.y);
  return {x,y,fingerprint:fingerprint(x,y),approver:'0x'+'ab'.repeat(20),sig:text=>{const s=sign('sha256',Buffer.from(text),{key:k.privateKey,dsaEncoding:'ieee-p1363'});const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;let sv=BigInt('0x'+s.subarray(32).toString('hex'));if(sv>N/2n)sv=N-sv;return {r:'0x'+s.subarray(0,32).toString('hex'),s:'0x'+sv.toString(16).padStart(64,'0')};}};};
const cred=(fp='fp1')=>{const S={};let saves=0;const st={fp};const C=createSiriCred({store:S,save:()=>saves++,phoneFp:()=>st.fp});return {S,C,st,saves:()=>saves};};

test('credential: issued once as ksc_…, only its SHA-256 stored, accepted only as Bearer for the current phone',()=>{const {S,C}=cred();const t=C.issue();
  assert.match(t,SIRI_CRED_RE);assert.ok(S.siriCred?.h&&S.siriCred.h.length===64);assert.ok(!JSON.stringify(S).includes(t),'token itself never stored');
  assert.equal(C.check(req(t)),true);assert.equal(C.check(req(t.slice(0,-1)+(t.endsWith('A')?'B':'A'))),false);assert.equal(C.check(req()),false);
  assert.equal(C.check(req('kps_'+'a'.repeat(43))),false,'a phone session token is not a Siri credential');});
test('credential: bound to the phone signer that approved it (new / removed phone voids it); no phone -> nothing issued',()=>{const {C,st}=cred();const t=C.issue();
  st.fp='fp2';assert.equal(C.check(req(t)),false);st.fp=null;assert.equal(C.check(req(t)),false);assert.equal(C.issue(),null);});
test('credential: a newer Siri approval replaces the old one; revoke voids it and clears pending Siri payments',()=>{const {S,C}=cred();const a=C.issue(),b=C.issue();
  assert.equal(C.check(req(a)),false);assert.equal(C.check(req(b)),true);C.remember('apr_1',{amount:'3'});assert.equal(C.revoke('agent_stop'),true);
  assert.equal(C.check(req(b)),false);assert.equal(S.siriCred,undefined);assert.equal(C.take('apr_1'),null);assert.equal(C.revoke('again'),false);});
test('pending Siri payment: taken exactly once; bounded (20) and expires after 7 days',()=>{let n=1e12;const S={};const C=createSiriCred({store:S,phoneFp:()=>'fp',now:()=>n});
  C.remember('a',{x:1});assert.deepEqual(C.take('a'),{x:1});assert.equal(C.take('a'),null);
  for(let i=0;i<25;i++){n+=1;C.remember('p'+i,{i});}assert.equal(Object.keys(S.siriPending).length,20);assert.equal(C.take('p0'),null);assert.deepEqual(C.take('p24'),{i:24});
  C.remember('old',{o:1});n+=8*86400e3;assert.equal(C.take('old'),null);});
const book=[{name:'Corner Cafe',address:'0x00000000000000000000000000000000000000c1',status:'trusted'},{name:'Lab Shop',address:'0x00000000000000000000000000000000000000c2',status:'new'},
  {name:'Twin',address:'0x00000000000000000000000000000000000000c3',status:'verified'},{name:'twin',address:'0x00000000000000000000000000000000000000c4',status:'verified'}];
const E={addressBook:()=>book};
test('payee names: trusted / verified name -> unchanged (kipurse_buy resolvePayeeName pays it inside the limits)',()=>{const a={payee_name:'corner cafe',amount:'1',item:'x'};assert.deepEqual(siriPayee(a,E),a);});
test('payee names: saved-but-unverified name -> its address as a plain payee (no trusted-source claim) -> engine asks the owner',()=>{
  const o=siriPayee({payee_name:'Lab Shop',amount:'1',item:'x'},E);assert.equal(o.to,book[1].address);assert.equal(o.payee_name,undefined);assert.equal(o.merchant,'Lab Shop');});
test('payee names: unknown or ambiguous name / explicit address -> unchanged (kipurse_buy: ask_owner "who?", nothing paid)',()=>{
  for(const a of [{payee_name:'Nobody',amount:'1',item:'x'},{payee_name:'Twin',amount:'1',item:'x'},{to:book[1].address,payee_name:'Lab Shop',amount:'1',item:'x'}])assert.deepEqual(siriPayee(a,E),a);});
test('/siri/buy: 401 without auth; with auth the same kipurse_buy as other AIs under agentId siri',async()=>{const calls=[];const A=createSiriAgent(E,{buyFactory:()=>({buy:async(a,id)=>{calls.push([a,id]);return {decision:'can_pay',state:'paid'};}})});
  assert.deepEqual(await A.handle('/siri/buy',{item:'x',amount:'1',to:book[0].address,idempotencyKey:'siri-abcdefgh'},{authed:false}),[401,{error:'phone_session_required'}]);
  const [st]=await A.handle('/siri/buy',{item:'x',amount:'1',payee_name:'Lab Shop',idempotencyKey:'siri-abcdefgh'},{authed:true});assert.equal(st,200);assert.equal(calls[0][1],'siri');assert.equal(calls[0][0].to,book[1].address);});
test('owner-approved Siri payment completed once: derived key k+":a" (a second completion = same key -> ledger replay), same orderRef',async()=>{const calls=[];
  const A=createSiriAgent(E,{buyFactory:()=>({buy:async(a,id)=>{calls.push([a,id]);return {decision:'can_pay',state:'paid'};}})});const args={item:'x',amount:'3',payee_name:'Corner Cafe',idempotencyKey:'siri-1234-5678'};
  await A.complete(args);await A.complete(args);assert.equal(calls.length,2);for(const [a,id] of calls){assert.equal(id,'siri');assert.equal(a.idempotencyKey,'siri-1234-5678:a');assert.equal(a.orderRef,'siri-1234-5678');}
  assert.equal((await A.complete({item:'x'})).reason,'idempotency_key_required');});
function world(){const phone=key(),S={oauthAgents:{},phone:{active:true},agentLastSeen:{}};const mem=new Map();const kv={get:k=>mem.get(k),set:(k,v)=>mem.set(k,v),del:k=>mem.delete(k)};
  const EVD=createEverydayLimits({kv,wallet:W,floor:()=>FLOOR});let O;const SC=createSiriCred({store:S,phoneFp:()=>phone.fingerprint});
  const createAgentKey=(name,kind,clientId)=>{const r=replaceSiriAgent(S.oauthAgents,{kind,clientId,knownIds:new Set(['siri','muse']),revoke:k=>O.revokeAgent(k)});if(!r.ok)throw Object.assign(Error(r.error),{code:r.error});return r.id;};
  const commitSpend=a=>{const r=EVD.set({single:a.single,daily:a.daily,term:a.total});if(!r.ok)return r;const v=consentSpend(EVD.get());return {ok:true,limits:{perPayment:v.perPayment,perDay:v.perDay,termTotal:v.termTotal,at:v.at??null},undo(){EVD.forget();}};};
  O=createOAuth({S,save:()=>{},base:()=>'https://pay.example',network:'main',wallet:W,ownerAddress:'0x2222',verifyOwner:async()=>false,createAgentKey,isAgentLive:()=>true,caps:()=>null,ownerSession:()=>null,
    spendAuthorization:()=>consentSpend(EVD.get()),commitSpend,everydayView:()=>EVD.get(),approveExtras:n=>n==='Siri'?{siriCredential:SC.issue()}:null,log:()=>{},
    phoneApprover:{active:()=>phone,onChain:async()=>true,verify:(a,d,r,s)=>p256VerifyDigest(a,d,r,s)}});
  const call=async(path,body)=>{let out,code;const res={writeHead(c){code=c;},end(b){out=b;}};await O.handle({method:'POST',headers:{}},res,new URL('https://pay.example'+path),{readBody:async()=>body,ip:'203.0.113.9'});return {code,out:JSON.parse(out)};};
  const connect=async agent=>{const f=await call('/oauth/first',{agent,...AM});assert.equal(f.code,200);
    const text=firstConnectText({wallet:W,clientId:f.out.clientId,agent:f.out.name,request:f.out.req,redirect:f.out.redirect,...AM,action:'approve',nonce:f.out.nonce,exp:f.out.exp});
    return await call('/oauth/phone-decide',{req:f.out.req,approve:true,...phone.sig(text)});};
  return {S,SC,connect};}
test('signed Siri approval (phone-decide) returns a working Siri credential; other AIs get none',async()=>{const w=world();const d=await w.connect('siri');
  assert.equal(d.out.status,'approved');assert.match(d.out.siriCredential,SIRI_CRED_RE);assert.equal(w.SC.check(req(d.out.siriCredential)),true);
  const w2=world();const g=await w2.connect('claude');assert.equal(g.out.status,'approved');assert.equal(g.out.siriCredential,undefined);});
const L=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
test('launcher: credential only for POST /siri/buy (never /mcp, never owner routes); revoked by Siri stop, safety stop, emergency pause',()=>{
  assert.match(L,/const viaCred=!PS\.check\(req\)&&u\.pathname==='\/siri\/buy'&&SC\.check\(req\)/);assert.equal((L.match(/SC\.check\(/g)??[]).length,1,'SC.check used in exactly one place');
  assert.match(L,/if\(id==='siri'\|\|id==='oauth-siri'\)SC\.revoke\('agent_stop'\)/);assert.match(L,/SAFE\.pause\(R\.wallet,'owner_stop',ms\);SC\.revoke\('safety_stop'\)/);
  assert.match(L,/SAFE\.pause\(R\.wallet,'owner_stop',null\);SC\.revoke\('owner_emergency'\)/);assert.match(L,/approveExtras:name=>name==='Siri'\?\{siriCredential:SC\.issue\(\)\}:null/);});
test('launcher: an approved Siri proposal is completed through the same Siri buy path; state lists only trusted / verified payee names',()=>{
  assert.match(L,/SC\.remember\(out\.approvalId,b\)/);assert.match(L,/const pa=SC\.take\(String\(b\?\.id\?\?''\)\);if\(pa\)\{SIRI\?\?=/);assert.match(L,/SIRI\.complete\(pa\)/);
  assert.match(L,/payeeBook:\(\(\)=>\{try\{return \(engine\?\.addressBook\?\.\(\)\?\?\[\]\)\.filter\(x=>x\.status!=='new'\)/);});
test('0A#7 duplicate protection untouched: ledger idempotency, claims, mandates dedupe still in place',()=>{const led=readFileSync(new URL('../src/v4/ledger.mjs',import.meta.url),'utf8');const md=readFileSync(new URL('../src/v5/mandates.mjs',import.meta.url),'utf8');const eng=readFileSync(new URL('../src/v5/engine.mjs',import.meta.url),'utf8');
  assert.match(led,/idempotencyBegin\(key,agent,request\)/);assert.match(led,/claim\(key,n,intentId,agent\)/);assert.match(md,/if\(dedupe\)\{const ex=db\.prepare/);assert.match(eng,/async function withIdem\(idemKey,agentId,request,fn\)/);});
