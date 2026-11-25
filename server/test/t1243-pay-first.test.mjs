// t1243 (decision 113, owner 2026-11-21 20:38 CT"[zh]"): "[zh]" pays FIRST and replies as soon as the payment is known
// (trust {state:'submitting'}); the trust + the V5.4 grant follow in the background strictly AFTER the payment (the vault's userOps never
// overlap), the grant is verified on chain BEFORE it is stored, and the final result is readable by the app / AI. Also: a new APNs token
// replaces this phone's previous one (one push per phone).
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {getAddress} from 'viem';
import {engineFor,direct} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';import {ownerKey} from '../src/v5/owner-ask.mjs';
import {createOwnerAskApproval} from '../src/v5/owner-ask-approve.mjs';import {NO_CEILING} from '../src/v5/phone-signer.mjs';import {merchantMock} from './helpers/t1212-merchant.mjs';import {waitTrust} from './helpers/t1243-wait-trust.mjs';
import {pushTokenList,registerPushToken} from '../src/v5/push-tokens.mjs';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';const rnd=()=>privateKeyToAccount(generatePrivateKey()).address;
let seq=0x3e00;const fresh=()=>{seq++;return getAddress('0x3eb9'+seq.toString(16).padStart(4,'0')+'d'.repeat(28)+'d354');};
let n=0;const uuid=()=>'7c1d2e3f-0000-4000-9000-'+(++n).toString().padStart(12,'0');
const PARAMS={listingId:'lst-1',ownerToken:'0b7f3c2e-aaaa-4bbb-8ccc-123456789abc',targetBid:5,board:'all'};
const mk=()=>{const payee=fresh();const M=merchantMock({payee});const props=[];
  const e=engineFor({fetch:M.fetch,onMandateProposal:v=>props.push(v),ownerRulesDir:mkdtempSync(join(tmpdir(),'t1243-'))},{bal:5000000000n,delayMs:1},{openSingle:'1050000',openDaily:'900000000',single:'100050000',daily:'900000000',term:'900000000'});
  e.engine.mandates.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);
  const B=createBuy(e.engine,{sleep:async()=>{},waitMs:0});
  const order=(o={})=>B.buy({purpose:'promo',item:'bid on the example shop',merchant:'shop.example',origin:M.origin,orderParams:PARAMS,merchantPurchaseId:o.pid??uuid(),idempotencyKey:o.key??('idem-'+uuid())},'claude');
  return {...e,M,payee,props,B,order};};
const phoneFor=()=>({active:()=>({index:1,fingerprint:'fp1',approver:'0x'+'99'.repeat(20),maxSingle:NO_CEILING,maxDaily:NO_CEILING}),payCapable:async()=>({ok:true,index:1,active:{fingerprint:'fp1',maxSingle:NO_CEILING,maxDaily:NO_CEILING}})});
const p256Verify=(a,d,r,s)=>r==='0x01'&&s==='0x02';const GOOD={r:'0x01',s:'0x02'};
// trust owner mock whose on-chain submit waits for `gate` and records when it ran relative to the payment writes
const approverFor=(e,{grant=false,submitFails=false,grantOk=true}={})=>{const reqs={},events=[],logs=[],stored=[];let open;const gate=new Promise(r=>{open=r;});
  const T={cap:'C',api:{approve:async(c,id)=>({innerTypedData:{message:{account:'0x'+'77'.repeat(20),merchant:'0x'+'aa'.repeat(32),name:'shop',epoch:'0',payees:[reqs[id].payee],signers:reqs[id].signers??[],single:reqs[id].single,daily:reqs[id].total,expiry:'9999999999',nonce:'0x'+'bb'.repeat(32),deadline:'9999999999'},domain:{}},digest:'0x'+'cd'.repeat(32)}),
    submitSignature:async(c,id)=>{events.push({ev:'trust_submit_start',writes:e.s.writes.length});await gate;if(submitFails){const x=new Error('boom');x.code='trust_tx_failed';throw x;}reqs[id].status='trusted';events.push({ev:'trust_landed'});return {status:'trusted',txHash:'0xtrust'};},
    reject:(c,id)=>{if(reqs[id])reqs[id].status='rejected';},list:()=>({pending:[],recent:[]})}};
  const SIGNER='0x'+'5a'.repeat(20);
  const engine=new Proxy(e.engine,{get:(t,key)=>key==='requestTrustFromOwner'?async o=>{const id='tr-'+(Object.keys(reqs).length+1);reqs[id]={id,...o,status:'awaiting'};return {id};}:t[key]});
  const sg=grant?{fromTrust:async m=>({message:{...m,epoch:String(BigInt(m.epoch)+1n)},digest:'0x'+'ef'.repeat(32)}),wrapper:()=>'0xwrapped',store:(m,w)=>{events.push({ev:'grant_store'});stored.push({m,w});}}:null;
  const verifyWrapped=async d=>{if(d==='0x'+'ef'.repeat(32)){events.push({ev:'grant_verify'});return grantOk;}return true;};
  const A=createOwnerAskApproval({engine,phone:phoneFor(),pub:{readContract:async()=>'0x'+'ab'.repeat(32)},wallet:'0x'+'77'.repeat(20),everyday:()=>({authorized:true,single:'5000000',daily:'20000000'}),walletCaps:()=>({single:100050000n,daily:900000000n}),
    trustOwner:()=>T,verifyWrapped,p256Verify,signerGrant:sg,log:(k,v)=>logs.push({k,...v})});
  return {A,reqs,events,logs,stored,open,SIGNER};};
const signed=(e,id,signer)=>{const a=e.engine.ownerAsks.get(id);const g=e.engine.ownerAsks.get;e.engine.ownerAsks.get=x=>{const y=g(x);return y&&x===id?{...y,spec:{...y.spec,signer,signerMerchant:'shop.example'}}:y;};return a;};

test('pay first: the reply comes with the payment while the trust is still on its way; the trust starts only after the payment',async()=>{
  const e=mk();const r=await e.order();assert.equal(r.decision,'ask_owner');const S=approverFor(e);
  assert.equal((await S.A.prepare({id:r.approvalId,mode:'trust'}))[0],200);const w0=e.s.writes.length;
  const [c,o]=await S.A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD});
  assert.equal(c,200,JSON.stringify(o));assert.equal(o.state,'paid');assert.equal(o.pay.state,'paid');assert.equal(o.trust.state,'submitting');assert.equal(o.trust.single,'5000000');
  assert.equal(e.s.writes.length-w0,1,'the payment is on chain when the reply comes');assert.equal(Object.values(S.reqs)[0].status,'awaiting','the trust has NOT landed yet');
  await new Promise(r=>setTimeout(r,5));assert.equal(S.events[0]?.ev,'trust_submit_start');assert.equal(S.events[0].writes-w0,1,'trust submitted strictly after the payment');
  const st=await e.B.approvalStatus({approvalId:r.approvalId});assert.equal(st.state,'paid');assert.equal(st.trust_state,'submitting');assert.equal(st.trusted,false);assert.match(st.say_to_user,/信任正在生效/);
  assert.deepEqual(e.engine.ownerAsks.recentTrust().map(x=>[x.id,x.trust.state]),[[r.approvalId,'submitting']]);
  S.open();const t=await waitTrust(e.engine.ownerAsks,r.approvalId);assert.equal(t.state,'trusted');assert.equal(t.txHash,'0xtrust');
  assert.equal(Object.values(S.reqs)[0].status,'trusted');assert.equal(e.s.writes.length-w0,1,'still exactly one payment');
  const st2=await e.B.approvalStatus({approvalId:r.approvalId});assert.equal(st2.trusted,true);assert.equal(st2.trust_state,'trusted');assert.match(st2.say_to_user,/并已加入信任名单/);
  assert.equal(e.engine.ownerAsks.get(r.approvalId).state,'paid','the payment state never changes');assert.equal(e.engine.ownerAsks.get(r.approvalId).result.purchaseKey!=null,true);
  assert.deepEqual(e.engine.ownerAsks.recentTrust().map(x=>x.trust.state),['trusted']);});

test('while the background trust holds the wallet tx lock: an AI payment is told to retry (nothing sent); a 2nd owner approval waits for it, then pays',async()=>{
  const e=mk();const r=await e.order();e.M.payee=rnd();const r2=await e.order();assert.equal(r2.decision,'ask_owner');assert.notEqual(r2.approvalId,r.approvalId);
  const S=approverFor(e);await S.A.prepare({id:r.approvalId,mode:'trust'});await S.A.prepare({id:r2.approvalId,mode:'once'});
  assert.equal((await S.A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD}))[0],200);await new Promise(z=>setTimeout(z,5));const w1=e.s.writes.length;
  const pf=await e.engine.preflight(direct('20000','t1243-mid'));assert.ok((pf.reasons??pf.quote?.reasons??JSON.stringify(pf)).includes('tx_in_flight_retry_later'),JSON.stringify(pf).slice(0,300));
  let second=null;const p2=S.A.approve({id:r2.approvalId,mode:'once',...GOOD,pay:GOOD}).then(x=>{second=x;});
  await new Promise(z=>setTimeout(z,30));assert.equal(second,null,'the 2nd approval waits for the in-flight trust');assert.equal(e.s.writes.length,w1,'nothing sent meanwhile');
  S.open();await p2;assert.equal(second[0],200);assert.equal(second[1].state,'paid',JSON.stringify(second[1]));assert.equal(e.s.writes.length,w1+1);
  assert.equal((await waitTrust(e.engine.ownerAsks,r.approvalId)).state,'trusted');
  const pf2=await e.engine.preflight(direct('20000','t1243-after'));assert.ok(!JSON.stringify(pf2).includes('tx_in_flight'),'lock released');});

test('a repeated approve while the trust is in flight -> already handled; the AI retry gets the paid answer; never a 2nd payment (0A#7 untouched)',async()=>{
  const e=mk();const key='idem-t1243-r';const r=await e.order({key});const S=approverFor(e);await S.A.prepare({id:r.approvalId,mode:'trust'});const w0=e.s.writes.length;
  assert.equal((await S.A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD}))[0],200);
  const [c2,o2]=await S.A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD});assert.equal(c2,409);assert.equal(o2.error,'already_handled');
  const again=await e.order({key});assert.equal(again.state,'paid');assert.equal(e.s.writes.length-w0,1);
  const k=e.engine.ownerAsks.get(r.approvalId);assert.equal(ownerKey(r.approvalId).length>0,true);assert.equal(k.state,'paid');
  S.open();assert.equal((await waitTrust(e.engine.ownerAsks,r.approvalId)).state,'trusted');assert.equal(e.s.writes.length-w0,1);});

test('signed merchant: the grant is verified on chain only after the trust landed, then stored; nothing stored before',async()=>{
  const e=mk();const r=await e.order();const S=approverFor(e,{grant:true});signed(e,r.approvalId,S.SIGNER);
  const [cp,p]=await S.A.prepare({id:r.approvalId,mode:'trust'});assert.equal(cp,200,JSON.stringify(p));assert.ok(p.trust.signerGrant);
  const [c,o]=await S.A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:{...GOOD,signerGrant:GOOD}});assert.equal(c,200,JSON.stringify(o));
  assert.equal(o.trust.state,'submitting');assert.equal(o.trust.merchant,'shop.example');assert.equal(S.stored.length,0);
  S.open();const t=await waitTrust(e.engine.ownerAsks,r.approvalId);assert.equal(t.state,'trusted');assert.equal(t.signerGrant,'stored');assert.equal(S.stored.length,1);
  assert.deepEqual(S.events.map(x=>x.ev),['trust_submit_start','trust_landed','grant_verify','grant_store'],'verify-before-store, after the trust');
  assert.deepEqual(e.engine.ownerAsks.recentTrust()[0].trust,{state:'trusted',merchant:'shop.example',signerGrant:'stored',txHash:'0xtrust'});});

test('grant refused by the wallet -> NOT stored; logged; the payment stays paid',async()=>{
  const e=mk();const r=await e.order();const S=approverFor(e,{grant:true,grantOk:false});signed(e,r.approvalId,S.SIGNER);await S.A.prepare({id:r.approvalId,mode:'trust'});
  const [c,o]=await S.A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:{...GOOD,signerGrant:GOOD}});assert.equal(c,200);assert.equal(o.state,'paid');S.open();
  const t=await waitTrust(e.engine.ownerAsks,r.approvalId);assert.equal(t.signerGrant,'not_accepted');assert.equal(S.stored.length,0);
  assert.ok(S.logs.some(l=>l.k==='owner_ask_trust_failed'&&l.signerGrant==='not_accepted'));assert.equal(e.engine.ownerAsks.get(r.approvalId).state,'paid');});

test('trust submit fails -> logged, trust failed, nothing stored, payment unchanged; the AI is told the trust did not take effect',async()=>{
  const e=mk();const r=await e.order();const S=approverFor(e,{grant:true,submitFails:true});signed(e,r.approvalId,S.SIGNER);await S.A.prepare({id:r.approvalId,mode:'trust'});const w0=e.s.writes.length;
  const [c,o]=await S.A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:{...GOOD,signerGrant:GOOD}});assert.equal(c,200);assert.equal(o.state,'paid');S.open();
  const t=await waitTrust(e.engine.ownerAsks,r.approvalId);assert.equal(t.state,'failed');assert.equal(t.reason,'trust_tx_failed');assert.equal(S.stored.length,0);
  assert.ok(S.logs.some(l=>l.k==='owner_ask_trust_failed'));assert.equal(e.s.writes.length-w0,1);
  const st=await e.B.approvalStatus({approvalId:r.approvalId});assert.equal(st.state,'paid');assert.equal(st.trusted,false);assert.equal(st.trust_state,'failed');assert.match(st.say_to_user,/信任没有生效/);});

test('"once": no trust, no background job (reply unchanged)',async()=>{
  const e=mk();const r=await e.order();const S=approverFor(e);await S.A.prepare({id:r.approvalId,mode:'once'});
  const [c,o]=await S.A.approve({id:r.approvalId,mode:'once',...GOOD,pay:GOOD});assert.equal(c,200);assert.equal(o.trust,null);assert.equal(await S.A.trustSettled(r.approvalId),null);assert.equal(S.events.length,0);
  assert.deepEqual(e.engine.ownerAsks.recentTrust(),[]);});

test('push tokens: a new token replaces this phone\'s previous one in THIS wallet only; junk "replaces" is ignored',()=>{
  const m=new Map();const KV={get:k=>m.get(k),put:(k,v)=>m.set(k,v)};const A=pushTokenList(KV,'push:a:tokens'),B=pushTokenList(KV,'push:b:tokens');
  const prod='aa'.repeat(32),sand='bb'.repeat(32),next='cc'.repeat(32),other='dd'.repeat(32);
  assert.deepEqual(registerPushToken(A,{token:prod}),[200,{ok:true,replaced:false}]);assert.equal(registerPushToken(A,{token:sand})[0],200);assert.equal(A.list().length,2,'without replaces both stay (the duplicate the owner saw)');
  registerPushToken(B,{token:other});registerPushToken(B,{token:sand});
  assert.deepEqual(registerPushToken(A,{token:next,replaces:sand,lang:'en'}),[200,{ok:true,replaced:true}]);
  assert.deepEqual(A.list().map(x=>x.token),[prod,next]);assert.equal(A.list()[1].lang,'en');
  assert.deepEqual(B.list().map(x=>x.token),[other,sand],'another wallet\'s list is never touched');
  assert.deepEqual(registerPushToken(A,{token:next,replaces:next}),[200,{ok:true,replaced:false}],'replaces == token: ignored, token kept');assert.deepEqual(A.list().map(x=>x.token),[prod,next]);
  assert.deepEqual(registerPushToken(A,{token:'ee'.repeat(32),replaces:'not-a-token'}),[200,{ok:true,replaced:false}]);assert.equal(A.list().length,3);
  assert.deepEqual(registerPushToken(A,{token:'zz',replaces:prod}),[400,{error:'bad_token'}]);assert.ok(A.list().some(x=>x.token===prod),'a bad request removes nothing');
  for(let i=0;i<6;i++)registerPushToken(A,{token:String(i).repeat(64)});assert.equal(A.list().length,5,'still at most 5');});

test('the register route needs the phone session and uses the module',async()=>{
  const {readFileSync}=await import('node:fs');const src=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  const i=src.indexOf("u.pathname==='/phone/push/register'");assert.ok(i>0);const seg=src.slice(i,i+400);
  assert.match(seg,/if\(!PS\.check\(req\)\)return j\(401/);assert.match(seg,/registerPushToken\(pushTokens\(R\.wallet\),b\)/);});
