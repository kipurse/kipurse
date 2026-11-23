// t1264: owner-ask money paths: unknown payment outcome, restart reconcile of executing asks + their trusts, dedupe that never returns a
// dead card or merges two orders, "trust" remembers the payee only after the payment AND the trust, approve + claim in one transaction.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {getAddress} from 'viem';import {DatabaseSync} from 'node:sqlite';
import {engineFor} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS,createMandates} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';
import {createOwnerAsks,askView} from '../src/v5/owner-ask.mjs';import {createOwnerAskApproval} from '../src/v5/owner-ask-approve.mjs';import {createEngineV5} from '../src/v5/engine.mjs';
import {waitTrust} from './helpers/t1243-wait-trust.mjs';import {NO_CEILING} from '../src/v5/phone-signer.mjs';
let seq=0x9264;const fresh=()=>{seq++;return getAddress('0x'+seq.toString(16).padStart(6,'0')+'b'.repeat(28)+seq.toString(16).padStart(6,'0'));};
let k=0;const idem=()=>'idem-t1264a-'+(k++).toString().padStart(5,'0');
const mk=(over={})=>{const props=[];const e=engineFor({onMandateProposal:v=>props.push(v),ownerRulesDir:mkdtempSync(join(tmpdir(),'t1264a-')),reconcileOnStart:false,...over},{bal:5000000000n,delayMs:1},{openSingle:'10050000',openDaily:'900000000',single:'100050000',daily:'900000000',term:'900000000'});
  e.engine.mandates.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);
  return {...e,props,buy:createBuy(e.engine,{sleep:async()=>{},waitMs:0})};};
const phoneFor=()=>({active:()=>({index:1,fingerprint:'fp1',approver:'0x'+'99'.repeat(20),maxSingle:NO_CEILING,maxDaily:NO_CEILING}),payCapable:async()=>({ok:true,index:1,active:{fingerprint:'fp1',maxSingle:NO_CEILING,maxDaily:NO_CEILING}})});
const p256Verify=(a,d,r,s)=>r==='0x01'&&s==='0x02';
const trustOwnerFor=()=>{const reqs={};return {reqs,o:{cap:'C',api:{approve:async(c,id)=>({innerTypedData:{message:{account:'0x'+'77'.repeat(20),merchant:'0x'+'aa'.repeat(32),name:'desk shop',epoch:'0',payees:[reqs[id].payee],signers:[],single:reqs[id].single,daily:reqs[id].total,expiry:'9999999999',nonce:'0x'+'bb'.repeat(32),deadline:'9999999999'},domain:{}},digest:'0x'+'cd'.repeat(32)}),
  submitSignature:async(c,id)=>{reqs[id].status='trusted';return {status:'trusted',txHash:'0xtrust'};},reject:(c,id)=>{if(reqs[id])reqs[id].status='rejected';},list:()=>({pending:Object.values(reqs).filter(r=>r.status==='awaiting'),recent:[]})}}};};
const approverFor=(e,o={})=>{const T=trustOwnerFor();
  const engine=new Proxy(e.engine,{get:(t,key)=>key==='requestTrustFromOwner'?async x=>{const id='tr-'+(Object.keys(T.reqs).length+1);T.reqs[id]={id,...x,status:'awaiting'};return {id};}:t[key]});
  return {T,A:createOwnerAskApproval({engine,phone:phoneFor(),pub:{readContract:async()=>'0x'+'ab'.repeat(32)},wallet:'0x'+'77'.repeat(20),everyday:()=>({authorized:true,single:'5000000',daily:'20000000'}),walletCaps:()=>({single:100050000n,daily:900000000n}),trustOwner:()=>T.o,verifyWrapped:async()=>true,p256Verify,reconcileOnStart:false,...o})};};
const GOOD={r:'0x01',s:'0x02'};
const ask=async(e,{to=fresh(),amount='50',agent='grok',key=idem(),orderRef}={})=>({to,key,r:await e.buy.buy({purpose:'daily',item:'a desk',merchant:'Desk Shop',to,amount,idempotencyKey:key,...(orderRef?{orderRef}:{})},agent)});
const loseAnswer=e=>{const orig=e.client.write;e.client.write=async(fn,args,o={})=>{if(fn!=='payDirect')return orig(fn,args,o);const h='0x'+'d'.repeat(56)+Date.now().toString(16).slice(-8);await o.beforeSend?.(h);throw Error('userOp receipt timeout');};return ()=>{e.client.write=orig;};};
const pays=s=>s.writes.filter(w=>w.fn==='payDirect').length;

test('t1264 #2/#3: approved ask whose payment answer was lost -> ask stays executing with state unknown (never failed, never "nothing paid"); reconcile -> paid; AI sees paid',async()=>{
  const e=mk();const {to,key,r}=await ask(e);const {A}=approverFor(e);assert.equal((await A.prepare({id:r.approvalId,mode:'once'}))[0],200);
  const undo=loseAnswer(e);const [c,o]=await A.approve({id:r.approvalId,mode:'once',...GOOD,pay:GOOD});undo();
  assert.equal(c,200);assert.equal(o.state,'unknown',JSON.stringify(o));assert.equal(o.nothingPaid,false);
  const a=e.engine.ownerAsks.get(r.approvalId);assert.equal(a.state,'executing');assert.equal(a.result.state,'unknown');
  const v=askView(a);assert.equal(v.state,'unknown');assert.equal(v.nothingPaid,false);assert.match(v.next_step,/do_not_pay_again/);
  const st=await e.buy.approvalStatus({approvalId:r.approvalId});assert.equal(st.state,'unknown','not confirmed yet');assert.equal(st.nothingPaid,false);
  const rm=e.buy.remindOwner({approvalId:r.approvalId},'grok');assert.equal(rm.nothingPaid,false);
  const again=await e.buy.buy({purpose:'daily',item:'a desk',merchant:'Desk Shop',to:to.toLowerCase(),amount:'50',idempotencyKey:key},'grok');assert.equal(again.state,'unknown',JSON.stringify(again));assert.equal(again.nothingPaid,false);assert.equal(pays(e.s),0,'nothing re-sent');
  const row=e.engine.ledger.get(a.result.purchaseKey);e.s.used.add(JSON.parse(row.result).pending.onchainPurchaseKey);
  const st2=await e.buy.approvalStatus({approvalId:r.approvalId});assert.equal(st2.state,'paid',JSON.stringify(st2));assert.equal(e.engine.ownerAsks.get(r.approvalId).state,'paid');});

test('t1264 #3: after a restart, an ask left executing is finished from the ledger of its derived key (paid / never started -> failed, nothing paid)',async()=>{
  const e=mk();const {r}=await ask(e);const {A}=approverFor(e);await A.prepare({id:r.approvalId,mode:'once'});
  const undo=loseAnswer(e);await A.approve({id:r.approvalId,mode:'once',...GOOD,pay:GOOD});undo();
  const a=e.engine.ownerAsks.get(r.approvalId);e.s.used.add(JSON.parse(e.engine.ledger.get(a.result.purchaseKey).result).pending.onchainPurchaseKey);
  const e2=createEngineV5({...e.cfg,reconcileOnStart:false},{ledgerFile:e.engine.ledgerPath,client:e.client,agentDefault:'a1'});
  await e2.reconcileSubmitted();const out=await e2.reconcileOwnerAsks();assert.equal(out.find(x=>x.id===r.approvalId).state,'paid');assert.equal(e2.ownerAsks.get(r.approvalId).state,'paid');
  /* the server stopped between "executing" and sending anything: no ledger row, no answer -> failed (nothing paid) once stale */
  const {r:r2}=await ask(e);assert.equal(e.engine.ownerAsks.claim(r2.approvalId,'once'),true);
  e.engine.ledger.db.prepare(`UPDATE owner_ask SET decided_at=? WHERE approval_id=?`).run(Date.now()-11*60e3,r2.approvalId);
  const o2=await e.engine.reconcileOwnerAsks();assert.equal(o2.find(x=>x.id===r2.approvalId).state,'failed');const v=askView(e.engine.ownerAsks.get(r2.approvalId));assert.equal(v.nothingPaid,true);assert.equal(v.reason,'interrupted_before_payment');
  const {r:r3}=await ask(e);e.engine.ownerAsks.claim(r3.approvalId,'once');assert.equal((await e.engine.reconcileOwnerAsks()).find(x=>x.id===r3.approvalId).state,'executing','recent: left alone');});

test('t1264 #4: dedupe never returns an expired / handled card: mandates make a new proposal; an expired ask gets a fresh ask (new approval id)',async()=>{
  let t=1.8e12;const db=new DatabaseSync(':memory:');const M=createMandates({db,now:()=>t});const payee=fresh().toLowerCase();
  const req=()=>M.propose({items:[{purpose:'daily',single:'5',oneOff:{payee,host:null,remember:true}}],by:'agent:x',dedupe:'buy|'+payee+'|5000000|daily'});
  const p1=req();t+=86400e3+1;const p2=req();assert.notEqual(p2.id,p1.id);assert.equal(M.getProposal(p1.id).state,'expired');
  const A=createOwnerAsks({db:new DatabaseSync(':memory:')});A.put({approvalId:'apr_1',agentId:'g',idem:'k1',spec:{},payee,amount:'5'});A.reject('apr_1');
  assert.equal(A.put({approvalId:'apr_1',agentId:'g',idem:'k2',spec:{},payee,amount:'5'}).stale,true,'a handled ask is never reused');
  const e=mk();const to=fresh();const {r}=await ask(e,{to,orderRef:'ord-x'});
  e.engine.ledger.db.prepare(`UPDATE owner_ask SET expires_at=0 WHERE approval_id=?`).run(r.approvalId);
  const {r:rb}=await ask(e,{to,orderRef:'ord-x',agent:'claude'});assert.equal(rb.state,'awaiting_owner_approval');assert.notEqual(rb.approvalId,r.approvalId,'fresh ask');
  assert.equal(e.engine.ownerAsks.get(rb.approvalId).state,'pending');assert.equal(e.engine.mandates.getProposal(r.approvalId).state,'expired');});

test('t1264 #8: two different orders (same payee + amount + purpose) never merge into one card; the same order from two AIs still does; a key reused for another request never reports that ask',async()=>{
  const e=mk();const to=fresh();
  const {r:a}=await ask(e,{to,orderRef:'order-A'});const {r:b}=await ask(e,{to,orderRef:'order-B'});assert.notEqual(a.approvalId,b.approvalId,'two orders -> two cards');
  const {r:c}=await ask(e,{to,orderRef:'order-A',agent:'claude'});assert.equal(c.approvalId,a.approvalId,'same order, other AI -> same card');
  const {key,r:d}=await ask(e,{to,orderRef:'order-C'});
  const other=await e.buy.buy({purpose:'daily',item:'a desk',merchant:'Desk Shop',to:fresh(),amount:'50',orderRef:'order-C',idempotencyKey:key},'grok');
  assert.equal(other.reason,'idempotency_key_reused_with_different_request');assert.equal(other.nothingPaid,true);assert.notEqual(other.approvalId,d.approvalId);});

test('t1264 #5: "trust" does not remember the payee at approval; only after the payment succeeded AND the trust took effect; approve + claim are one transaction',async()=>{
  const db=new DatabaseSync(':memory:');const M=createMandates({db});const payee=fresh().toLowerCase();
  const p=M.propose({items:[{purpose:'daily',single:'50',oneOff:{payee,host:null,remember:false,ask:true}}],by:'agent:g'});
  assert.equal(M.approve(p.id,()=>true,{mode:'trust',also:()=>false}).ok,false,'claim lost -> nothing approved');assert.equal(M.getProposal(p.id).state,'pending');
  assert.equal(M.approve(p.id,()=>true,{mode:'trust'}).ok,true);assert.equal(M.isRemembered(payee),false,'not remembered before any payment');
  // payment fails (on-chain revert), trust lands -> NOT remembered
  const e=mk();const {to,r}=await ask(e);const {A}=approverFor(e);await A.prepare({id:r.approvalId,mode:'trust'});e.s.revertOnChain=1;
  const [c,o]=await A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD});assert.equal(c,200);assert.equal(o.state,'failed');
  assert.equal((await waitTrust(e.engine.ownerAsks,r.approvalId)).state,'trusted');assert.equal(e.engine.mandates.isRemembered(to),false,'payment failed: not remembered');
  // payment ok + trust ok -> remembered
  const {to:to2,r:r2}=await ask(e);await A.prepare({id:r2.approvalId,mode:'trust'});const [c2,o2]=await A.approve({id:r2.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD});assert.equal(o2.state,'paid',JSON.stringify(o2));
  assert.equal((await waitTrust(e.engine.ownerAsks,r2.approvalId)).state,'trusted');assert.equal(e.engine.mandates.isRemembered(to2),true);});

test('t1264 #9: a trust left "submitting" by a restart is settled from the chain (trusted -> trusted + remembered; not on chain after the grace -> failed)',async()=>{
  const e=mk();const ASK=e.engine.ownerAsks;const p1=fresh(),p2=fresh();
  for(const [id,payee,at] of [['apr_t9a',p1,Date.now()],['apr_t9b',p2,Date.now()-20*60e3]]){ASK.put({approvalId:id,agentId:'g',idem:id,spec:{},payee,amount:'5000000'});ASK.claim(id,'trust');
    ASK.finish(id,'paid',{state:'paid',purchaseKey:'x',trust:{state:'submitting',payee:getAddress(payee),inline:false,requestId:null,startedAt:at}});}
  e.s.trusted[p1.toLowerCase()]=true;/* p1's trust landed on chain before the restart; p2's never did */
  const {A}=approverFor(e);const out=await A.reconcile();
  assert.equal(out.trusts.find(x=>x.id==='apr_t9a').trust,'trusted');assert.equal(ASK.get('apr_t9a').result.trust.state,'trusted');assert.equal(e.engine.mandates.isRemembered(p1),true);
  assert.equal(out.trusts.find(x=>x.id==='apr_t9b').trust,'failed');assert.equal(ASK.get('apr_t9b').result.trust.state,'failed');assert.equal(e.engine.mandates.isRemembered(p2),false);
  assert.equal(askView(ASK.get('apr_t9b')).state,'paid','the payment result is untouched');});
