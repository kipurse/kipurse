// t1212 (decision 97, owner 2026-11-19 20:59 CT"[zh]"): an AI order payment (merchant order API, decision 93) to a
// NEW payee above an AI auto limit gets the decision 82 card: ONE Face ID trusts (if chosen) AND approves exactly this payment on chain; the server pays it
// once (derived key owner-ask:<approvalId>). Before: approving only made an allowance, the on-chain new-payee cap refused again, and a new card came.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {getAddress} from 'viem';
import {engineFor} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';import {ownerKey} from '../src/v5/owner-ask.mjs';
import {createOwnerAskApproval} from '../src/v5/owner-ask-approve.mjs';import {waitTrust} from './helpers/t1243-wait-trust.mjs';import {NO_CEILING} from '../src/v5/phone-signer.mjs';import {merchantMock} from './helpers/t1212-merchant.mjs';
let seq=0x2e00;const fresh=()=>{seq++;return getAddress('0x2eb9'+seq.toString(16).padStart(4,'0')+'c'.repeat(28)+'c354');};
let n=0;const uuid=()=>'7c1d2e3f-0000-4000-8000-'+(++n).toString().padStart(12,'0');
const PARAMS={listingId:'lst-1',ownerToken:'0b7f3c2e-aaaa-4bbb-8ccc-123456789abc',targetBid:5,board:'all'};
// wallet: single 100.05 / daily 900; ON-CHAIN new-payee (stranger) cap 1.05 USDC; beginner AI limits
const mk=()=>{const payee=fresh();const M=merchantMock({payee});const props=[];
  const e=engineFor({fetch:M.fetch,onMandateProposal:v=>props.push(v),ownerRulesDir:mkdtempSync(join(tmpdir(),'t1212-'))},{bal:5000000000n,delayMs:1},{openSingle:'1050000',openDaily:'900000000',single:'100050000',daily:'900000000',term:'900000000'});
  e.engine.mandates.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);
  const B=createBuy(e.engine,{sleep:async()=>{},waitMs:0});
  const order=(o={})=>B.buy({purpose:'promo',item:'bid on the example shop',merchant:'shop.example',origin:M.origin,orderParams:PARAMS,merchantPurchaseId:o.pid??uuid(),idempotencyKey:o.key??('idem-'+uuid()),...o.extra},o.agent??'claude');
  return {...e,M,payee,props,B,order};};
// the owner's phone (mock): Face ID signatures are 'ok'; anything else fails (same mocks as t1170)
const phoneFor=()=>({active:()=>({index:1,fingerprint:'fp1',approver:'0x'+'99'.repeat(20),maxSingle:NO_CEILING,maxDaily:NO_CEILING}),payCapable:async()=>({ok:true,index:1,active:{fingerprint:'fp1',maxSingle:NO_CEILING,maxDaily:NO_CEILING}})});
const p256Verify=(a,d,r,s)=>r==='0x01'&&s==='0x02';
const approverFor=e=>{const reqs={};const T={cap:'C',api:{approve:async(c,id)=>({innerTypedData:{message:{account:'0x'+'77'.repeat(20),merchant:'0x'+'aa'.repeat(32),name:'exampleshop',epoch:'0',payees:[reqs[id].payee],signers:[],single:reqs[id].single,daily:reqs[id].total,expiry:'9999999999',nonce:'0x'+'bb'.repeat(32),deadline:'9999999999'},domain:{}},digest:'0x'+'cd'.repeat(32)}),
  submitSignature:async(c,id)=>{reqs[id].status='trusted';return {status:'trusted',txHash:'0xtrust'};},reject:(c,id)=>{if(reqs[id])reqs[id].status='rejected';},list:()=>({pending:[],recent:[]})}};
  const engine=new Proxy(e.engine,{get:(t,key)=>key==='requestTrustFromOwner'?async o=>{const id='tr-'+(Object.keys(reqs).length+1);reqs[id]={id,...o,status:'awaiting'};return {id};}:t[key]});
  return {reqs,A:createOwnerAskApproval({engine,phone:phoneFor(),pub:{readContract:async()=>'0x'+'ab'.repeat(32)},wallet:'0x'+'77'.repeat(20),everyday:()=>({authorized:true,single:'5000000',daily:'20000000'}),walletCaps:()=>({single:100050000n,daily:900000000n}),trustOwner:()=>T,verifyWrapped:async()=>true,p256Verify})};};
const GOOD={r:'0x01',s:'0x02'};
const paidRows=e=>e.engine.listPurchases({limit:50}).filter(r=>r.state==='paid');

test('merchant order to a NEW payee above the on-chain new-payee cap -> ONE card (the decision 82 ask), text says trust + pay this 5 USDC; nothing paid; same key -> same card, no new order',async()=>{
  const e=mk();const key='idem-a1',pid=uuid();const r=await e.order({key,pid});
  assert.equal(r.decision,'ask_owner');assert.equal(r.state,'awaiting_owner_approval');assert.equal(r.nothingPaid,true);assert.equal(r.route,'merchant_order');assert.match(r.approvalId,/^apr_/);
  assert.equal(r.amount,'5');assert.equal(r.payee.toLowerCase(),e.payee.toLowerCase());assert.match(r.ask_owner_question.zh,/认识这个收款方吗/);
  assert.equal(e.props.length,1,'one card / one push');const v=e.props[0];assert.ok(v.ask,'the decision 82 card (trust / once / decline)');assert.equal(v.ask.payee,e.payee.toLowerCase());assert.equal(v.ask.amount,'5000000');
  assert.match(v.items[0].human.zh,/一次 Face ID 就信任“shop\.example”并付这笔 5 USDC/);assert.match(v.items[0].human.en,/ONE Face ID trusts "shop\.example" and pays this 5 USDC/);
  assert.match(v.items[0].human.zh,/^⚠️ 新收款方 0x/);assert.equal(e.s.writes.length,0,'nothing on chain');assert.equal(paidRows(e).length,0);
  const posts=()=>e.M.calls.filter(c=>c.method==='POST').length;const p0=posts();
  const r2=await e.order({key,pid});assert.equal(r2.approvalId,r.approvalId);assert.equal(r2.state,'awaiting_owner_approval');assert.equal(posts(),p0,'same key: stored answer, no new merchant order');assert.equal(e.props.length,1);
  assert.ok(!JSON.stringify(r).includes(PARAMS.ownerToken),'AI order secrets never echoed');assert.equal(r._askSpec,undefined);});

test('ONE Face ID ("认识并信任") -> trusted AND this exact payment paid once (derived key); repeat approve -> 409; AI retry -> paid answer, no 2nd payment',async()=>{
  const e=mk();const key='idem-b1';const r=await e.order({key});const {A,reqs}=approverFor(e);
  const [cp,p]=await A.prepare({id:r.approvalId,mode:'trust'});assert.equal(cp,200,JSON.stringify(p));assert.equal(p.pay.amount,'5000000');assert.equal(p.pay.payee.toLowerCase(),e.payee.toLowerCase());
  const w0=e.s.writes.length;const [ca,oa]=await A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD});assert.equal(ca,200,JSON.stringify(oa));assert.equal(oa.state,'paid');assert.equal(oa.trust.state,'submitting');
  assert.equal((await waitTrust(e.engine.ownerAsks,r.approvalId)).state,'trusted','t1243: the trust lands after the reply');
  assert.equal(e.s.writes.length-w0,1,'exactly one payment on chain');assert.equal(Object.values(reqs)[0].status,'trusted');
  const pd=paidRows(e);assert.equal(pd.length,1);assert.equal(String(pd[0].amount),'5000000');assert.equal(pd[0].payee.toLowerCase(),e.payee.toLowerCase());assert.equal(e.engine.ownerAsks.get(r.approvalId).result.purchaseKey,pd[0].purchaseKey,'the payment the server made for this card');
  assert.equal(e.engine.ownerAsks.get(r.approvalId).state,'paid');
  const [c2]=await A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD});assert.equal(c2,409,'second approval: already handled');
  const [c3]=await A.prepare({id:r.approvalId,mode:'once'});assert.equal(c3,409);
  const again=await e.order({key});assert.equal(again.state,'paid');assert.equal(again.approvalId,r.approvalId);assert.equal(e.s.writes.length-w0,1,'no second payment');assert.equal(paidRows(e).length,1);
  const st=await e.B.approvalStatus({approvalId:r.approvalId});assert.equal(st.state,'paid');assert.equal(st.mode,'trust');});

test('"只付这一次" pays only this one (no trust); the next over-cap order asks again',async()=>{
  const e=mk();const r=await e.order();const {A,reqs}=approverFor(e);assert.equal((await A.prepare({id:r.approvalId,mode:'once'}))[0],200);
  const [ca,oa]=await A.approve({id:r.approvalId,mode:'once',...GOOD,pay:GOOD});assert.equal(ca,200,JSON.stringify(oa));assert.equal(oa.state,'paid');assert.equal(Object.keys(reqs).length,0,'no trust');
  const next=await e.order();assert.equal(next.decision,'ask_owner');assert.notEqual(next.approvalId,r.approvalId);assert.equal(paidRows(e).length,1);});

test('tamper: a bad payment signature pays nothing; the merchant changing the amount later cannot change what was approved; a different amount is a different card',async()=>{
  const e=mk();const r=await e.order();const {A}=approverFor(e);await A.prepare({id:r.approvalId,mode:'trust'});
  const [c1,o1]=await A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:{r:'0x09',s:'0x09'},trust:GOOD});assert.equal(c1,403);assert.equal(o1.part,'pay');
  const [c2]=await A.approve({id:r.approvalId,mode:'trust',r:'0x05',s:'0x05',pay:GOOD,trust:GOOD});assert.equal(c2,403);assert.equal(e.s.writes.length,0);assert.equal(e.engine.ownerAsks.get(r.approvalId).state,'pending');
  e.M.amountAtomic='6000000';const other=await e.order();assert.equal(other.decision,'ask_owner');assert.notEqual(other.approvalId,r.approvalId,'6 USDC is its own card');assert.equal(other.amount,'6');
  const [ca,oa]=await A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD});assert.equal(ca,200,JSON.stringify(oa));assert.equal((await waitTrust(e.engine.ownerAsks,r.approvalId)).state,'trusted');
  const pd=paidRows(e);assert.equal(pd.length,1);assert.equal(String(pd[0].amount),'5000000','exactly the approved amount + payee');assert.equal(pd[0].payee.toLowerCase(),e.payee.toLowerCase());
  e.M.payee=fresh();const sw=await e.order();assert.notEqual(sw.approvalId,r.approvalId,'another payee: its own card');assert.equal(paidRows(e).length,1);});

test('another AI cannot remind / release it; only the server pays, once',async()=>{
  const e=mk();const r=await e.order({key:'idem-c1'});assert.equal(e.B.remindOwner({approvalId:r.approvalId},'grok').error,'not_found');
  const rm=e.B.remindOwner({approvalId:r.approvalId},'claude');assert.equal(rm.reminded,true);
  const g=await e.order({key:'idem-c1',agent:'grok'});assert.notEqual(g.state,'paid');assert.equal(e.s.writes.length,0,'nothing paid by any AI call');
  const {A}=approverFor(e);await A.prepare({id:r.approvalId,mode:'once'});assert.equal((await A.approve({id:r.approvalId,mode:'once',...GOOD,pay:GOOD}))[0],200);
  await e.order({key:'idem-c1',agent:'grok'});assert.equal(paidRows(e).length,1,'one payment in total');});

test('caps otherwise unchanged: after "trust", an order within the on-chain cap pays directly; a later over-cap order still asks (no endless allowance cards)',async()=>{
  const e=mk();const r=await e.order();const {A}=approverFor(e);await A.prepare({id:r.approvalId,mode:'trust'});assert.equal((await A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD}))[0],200);assert.equal((await waitTrust(e.engine.ownerAsks,r.approvalId)).state,'trusted');
  e.M.amountAtomic='1000000';const small=await e.order();assert.equal(small.state,'paid','within the cap: no question');assert.equal(paidRows(e).length,2);
  e.M.amountAtomic='5000000';const big=await e.order();assert.equal(big.decision,'ask_owner','over the cap: the owner is asked again');assert.ok(e.props.at(-1).ask,'the one-Face-ID card, not an allowance card that cannot pay');
  assert.equal(paidRows(e).length,2);});

test('new payee within every auto limit: the existing one-approval flow is unchanged',async()=>{
  const e=mk();e.M.amountAtomic='1000000';const r=await e.order();assert.equal(r.state,'awaiting_owner_approval');assert.equal(r.reason,'NEW_PAYEE_NEEDS_OWNER');assert.equal(r.ask_owner_question,undefined);assert.equal(e.props.at(-1).ask,undefined);
  assert.equal(e.engine.mandates.approve(r.approvalId,()=>true).ok,true);const r2=await e.order({pid:r.merchantPurchaseId});assert.equal(r2.state,'paid','one approval, then paid');});

test('the old loop: an allowance approved for this payee (pre-fix card) + the on-chain cap still refusing -> the one-Face-ID card, not yet another allowance card',async()=>{
  const e=mk();const M=e.engine.mandates;const pr=M.propose({items:[{purpose:'promo',single:'5',oneOff:{payee:e.payee.toLowerCase(),host:null,remember:true,aiName:'shop.example'}}],by:'agent:claude',dedupe:'old-card'});assert.equal(M.approve(pr.id,()=>true).ok,true);
  const n0=e.props.length;const r=await e.order();assert.equal(r.decision,'ask_owner');assert.ok(e.props.at(-1).ask);assert.equal(e.props.length,n0+1);assert.equal(e.s.writes.length,0);});
