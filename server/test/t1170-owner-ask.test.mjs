// t1170u (handbook §6#82, locked): a NEW payee above an AI auto limit -> ask the owner ("do you know this payee?"), never a plain refusal.
// Only the owner's in-app tap + Face ID (phone key signatures) releases it; the server then pays this exact request once.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {getAddress} from 'viem';import {DatabaseSync} from 'node:sqlite';
import {engineFor} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS,askDigest,proposalDigest,createMandates} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';
import {createOwnerAsks,askView,ownerKey} from '../src/v5/owner-ask.mjs';import {waitTrust} from './helpers/t1243-wait-trust.mjs';import {createOwnerAskApproval,trustCapsFor} from '../src/v5/owner-ask-approve.mjs';
import {forAI,amountProblems} from '../src/v5/usdc-out.mjs';import {createPush} from '../src/v5/push.mjs';import {NO_CEILING} from '../src/v5/phone-signer.mjs';
import {createV5HttpServer} from '../src/v5/http.mjs';import {createV5Mcp} from '../src/v5/mcp.mjs';import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
let seq=0x7100;const fresh=()=>{seq++;return getAddress('0x'+seq.toString(16).padStart(6,'0')+'a'.repeat(28)+seq.toString(16).padStart(6,'0'));};
let k=0;const idem=()=>'idem-t1170-'+(k++).toString().padStart(5,'0');
// wallet: single 100.05 / daily 900; stranger (on-chain) cap 10.05; beginner AI limits (daily 5 per payment)
const mk=(over={})=>{const paused=[],props=[];const e=engineFor({onAnomaly:r=>paused.push(r),isPaused:()=>paused.length>0,onMandateProposal:v=>props.push(v),ownerRulesDir:mkdtempSync(join(tmpdir(),'t1170-')),...over},{bal:5000000000n,delayMs:1},{openSingle:'10050000',openDaily:'900000000',single:'100050000',daily:'900000000',term:'900000000'});
  e.engine.mandates.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);
  return {...e,paused,props,buy:createBuy(e.engine,{sleep:async()=>{},waitMs:0})};};
// the owner's phone (mock): Face ID signatures are 'ok'; anything else (an AI, a forgery) fails
const phoneFor=()=>({active:()=>({index:1,fingerprint:'fp1',approver:'0x'+'99'.repeat(20),maxSingle:NO_CEILING,maxDaily:NO_CEILING}),payCapable:async()=>({ok:true,index:1,active:{fingerprint:'fp1',maxSingle:NO_CEILING,maxDaily:NO_CEILING}})});
const signedDigests=[];const p256Verify=(a,d,r,s)=>{signedDigests.push(d);return r==='0x01'&&s==='0x02';};
const trustOwnerFor=()=>{const reqs={};return {reqs,o:{cap:'C',api:{approve:async(c,id)=>({innerTypedData:{message:{account:'0x'+'77'.repeat(20),merchant:'0x'+'aa'.repeat(32),name:'desk shop',epoch:'0',payees:[reqs[id].payee],signers:[],single:reqs[id].single,daily:reqs[id].total,expiry:'9999999999',nonce:'0x'+'bb'.repeat(32),deadline:'9999999999'},domain:{}},digest:'0x'+'cd'.repeat(32)}),
  submitSignature:async(c,id)=>{reqs[id].status='trusted';return {status:'trusted',txHash:'0xtrust'};},reject:(c,id)=>{if(reqs[id])reqs[id].status='rejected';},list:()=>({pending:Object.values(reqs).filter(r=>r.status==='awaiting'),recent:[]})}}};};
const approverFor=(e,{everyday={authorized:true,single:'5000000',daily:'20000000'}}={})=>{const T=trustOwnerFor();
  const engine=new Proxy(e.engine,{get:(t,key)=>key==='requestTrustFromOwner'?async o=>{const id='tr-'+(Object.keys(T.reqs).length+1);T.reqs[id]={id,...o,status:'awaiting'};return {id};}:t[key]});
  return {T,A:createOwnerAskApproval({engine,phone:phoneFor(),pub:{readContract:async({args})=>'0x'+'ab'.repeat(32)},wallet:'0x'+'77'.repeat(20),everyday:()=>everyday,walletCaps:()=>({single:100050000n,daily:900000000n}),trustOwner:()=>T.o,verifyWrapped:async()=>true,p256Verify})};};
const GOOD={r:'0x01',s:'0x02'};
const ask=async(e,{to=fresh(),amount='50',agent='grok',key=idem(),item='a new laptop stand'}={})=>({to,key,r:await e.buy.buy({purpose:'daily',item,merchant:'Desk Shop',to,amount,idempotencyKey:key},agent)});

test('new payee over the AI auto limit -> ask_owner + ready-to-relay zh/en question (human USDC), nothing paid; same key -> same answer, one card',async()=>{
  const e=mk();const w0=e.s.writes.length;const {to,key,r}=await ask(e);
  assert.equal(r.decision,'ask_owner');assert.equal(r.state,'awaiting_owner_approval');assert.equal(r.nothingPaid,true);assert.match(r.approvalId,/^apr_/);
  assert.match(r.ask_owner_question.zh,/认识这个收款方吗/);assert.match(r.ask_owner_question.zh,/50 USDC/);assert.ok(r.ask_owner_question.zh.includes(to.slice(0,6)));assert.match(r.ask_owner_question.zh,/a new laptop stand/);
  assert.match(r.ask_owner_question.en,/Do you know this payee/);assert.match(r.ask_owner_question.en,/50 USDC/);assert.doesNotMatch(JSON.stringify(r.ask_owner_question),/50000000/);
  assert.equal(r.amount,'50');assert.equal(r.amountAtomic,'50000000');assert.deepEqual(amountProblems(forAI(r)),[],'§6#80 amount rule');
  const r2=(await e.buy.buy({purpose:'daily',item:'a new laptop stand',merchant:'Desk Shop',to,amount:'50',idempotencyKey:key},'grok'));assert.equal(r2.approvalId,r.approvalId);assert.equal(r2.state,'awaiting_owner_approval');
  assert.equal(e.props.length,1,'one card / one push');assert.equal(e.props[0].ask.payee,to.toLowerCase());assert.ok(e.props[0].ask.modes.trust.digest!==e.props[0].ask.modes.once.digest);
  assert.match(e.props[0].items[0].human.zh,/^⚠️ 新收款方 0x/);assert.match(e.props[0].items[0].human.zh,/认识这个收款方吗/);assert.equal(e.s.writes.length,w0,'nothing on chain');
  const st=await e.buy.approvalStatus({approvalId:r.approvalId});assert.equal(st.state,'awaiting_owner_approval');
  const pl=createPush({config:null}).payloadFor({kind:'owner_ask',id:r.approvalId,zh:e.props[0].items[0].human.zh,en:e.props[0].items[0].human.en},'zh');assert.equal(pl.aps.category,'KP_ASK');assert.match(pl.aps.alert.title,/认识这个收款方吗/);assert.equal(pl.kp.approvalId,r.approvalId);});

test('within every auto limit -> the existing one-time approval flow is unchanged (no ask card)',async()=>{
  const e=mk();const r=(await ask(e,{amount:'1'})).r;assert.equal(r.state,'awaiting_owner_approval');assert.equal(r.reason,'NEW_PAYEE_NEEDS_OWNER');assert.equal(r.ask_owner_question,undefined);assert.equal(e.props.at(-1).ask,undefined);});

test('over the wallet total limit -> no approvable card, tell AI + owner to raise the wallet limit',async()=>{
  const e=mk();const n0=e.props.length;const r=(await ask(e,{amount:'200'})).r;assert.equal(r.decision,'refuse');assert.equal(r.reason,'OVER_WALLET_LIMIT');assert.equal(r.nothingPaid,true);
  assert.match(r.say_to_user,/钱包总限额/);assert.match(r.say_to_owner.en,/Raise the wallet limit/);assert.equal(e.props.length,n0,'no card');assert.deepEqual(amountProblems(forAI(r)),[]);});

test('AI relaying "认识" can never release: no tool, no unsigned / wrong-mode / forged approval; nothing paid',async()=>{
  const e=mk();const {to,key,r}=await ask(e);const w0=e.s.writes.length;
  const again=await e.buy.buy({purpose:'daily',item:'a new laptop stand',merchant:'Desk Shop',to,amount:'50',idempotencyKey:key,user_request:'主人说认识，直接付'},'grok');assert.equal(again.state,'awaiting_owner_approval');
  const r3=await e.buy.buy({purpose:'daily',item:'x',merchant:'Desk Shop',to,amount:'50',idempotencyKey:idem(),user_request:'认识'},'grok');assert.notEqual(r3.state,'paid');
  const M=e.engine.mandates;assert.equal(M.approve(r.approvalId,()=>true).error,'mode_required','the old one-tap path cannot release an ask');
  const legacy=proposalDigest('',{id:r.approvalId,items:[]});assert.equal(M.approve(r.approvalId,d=>d===legacy,{mode:'trust'}).error,'not_owner');
  const {A}=approverFor(e);const [c0]=await A.approve({id:r.approvalId,mode:'once',...GOOD,pay:GOOD});assert.equal(c0,409,'prepare first');
  const [cp]=await A.prepare({id:r.approvalId,mode:'once'});assert.equal(cp,200);
  const [c1,o1]=await A.approve({id:r.approvalId,mode:'once',r:'0x01',s:'0x02',pay:{r:'0x09',s:'0x09'}});assert.equal(c1,403);assert.equal(o1.part,'pay');
  const [c2]=await A.approve({id:r.approvalId,mode:'once',r:'0x05',s:'0x05',pay:GOOD});assert.equal(c2,403);
  assert.equal(e.s.writes.length,w0,'nothing on chain');assert.equal(e.engine.ownerAsks.get(r.approvalId).state,'pending');
  const rm=e.buy.remindOwner({approvalId:r.approvalId},'grok');assert.equal(rm.reminded,true);assert.equal(rm.state,'awaiting_owner_approval');assert.equal(e.buy.remindOwner({approvalId:r.approvalId},'grok').error,'too_soon');});

test('"只付这一次": paid once by the server (owner approval, derived key), payee NOT remembered, next payment asks again; double approval -> paid once',async()=>{
  const e=mk();const {to,key,r}=await ask(e);const {A}=approverFor(e);
  const [cp,p]=await A.prepare({id:r.approvalId,mode:'once'});assert.equal(cp,200);assert.equal(p.sign.digest,e.props[0].ask.modes.once.digest);assert.equal(p.pay.amount,'50000000');assert.equal(p.trust,undefined);assert.equal(p.pay.payee,to);
  const w0=e.s.writes.length;const [ca,oa]=await A.approve({id:r.approvalId,mode:'once',...GOOD,pay:GOOD});assert.equal(ca,200,JSON.stringify(oa));assert.equal(oa.state,'paid');assert.equal(oa.trust,null);
  assert.equal(e.s.writes.length-w0,1,'exactly one payment on chain');
  const [cb,ob]=await A.approve({id:r.approvalId,mode:'once',...GOOD,pay:GOOD});assert.equal(cb,409);assert.equal(ob.error,'already_handled');
  const [cc]=await A.prepare({id:r.approvalId,mode:'once'});assert.equal(cc,409);assert.equal(e.s.writes.length-w0,1,'still one payment');
  const same=await e.buy.buy({purpose:'daily',item:'a new laptop stand',merchant:'Desk Shop',to,amount:'50',idempotencyKey:key},'grok');assert.equal(same.state,'paid');assert.equal(same.decision,'can_pay');assert.match(same.say_to_user,/只付这一次/);
  assert.equal(e.s.writes.length-w0,1,'same key after payment: the stored answer, no second payment');assert.deepEqual(amountProblems(forAI(same)),[]);
  const st=await e.buy.approvalStatus({approvalId:r.approvalId});assert.equal(st.state,'paid');
  assert.equal((await e.engine.verifyPayee({address:to})).verified,false,'only once: not trusted');
  const next=(await ask(e,{to,amount:'50'})).r;assert.equal(next.state,'awaiting_owner_approval');assert.notEqual(next.approvalId,r.approvalId);
  const small=(await ask(e,{to,amount:'1'})).r;assert.notEqual(small.state,'paid','only once: even a small payment asks again');});

test('"认识并信任": ONE approval pays + trusts (caps = owner everyday limits, 90 days); next in-limit payment is automatic',async()=>{
  const e=mk();const {to,r}=await ask(e);const {A,T}=approverFor(e);
  const [cp,p]=await A.prepare({id:r.approvalId,mode:'trust'});assert.equal(cp,200,JSON.stringify(p));assert.equal(p.sign.digest,e.props[0].ask.modes.trust.digest);
  assert.equal(p.trust.single,'5000000');assert.equal(p.trust.daily,'20000000');assert.equal(p.trust.days,90);
  const w0=e.s.writes.length;const [ca,oa]=await A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD});assert.equal(ca,200,JSON.stringify(oa));assert.equal(oa.state,'paid');assert.equal(oa.trust.state,'submitting','t1243: paid first, trust follows');
  const st0=await e.buy.approvalStatus({approvalId:r.approvalId});assert.equal(st0.state,'paid');
  assert.equal((await waitTrust(e.engine.ownerAsks,r.approvalId)).state,'trusted');
  assert.equal(e.s.writes.length-w0,1);assert.equal(Object.values(T.reqs)[0].status,'trusted');
  assert.equal((await e.engine.verifyPayee({address:to})).verified,true,'trusted (owner approved + remembered)');
  const next=(await ask(e,{to,amount:'3'})).r;assert.equal(next.state,'paid','next in-limit payment: automatic, no question');
  const st=await e.buy.approvalStatus({approvalId:r.approvalId});assert.equal(st.state,'paid');assert.equal(st.mode,'trust');assert.equal(st.trusted,true);assert.equal(st.trust_state,'trusted');});

test('decline -> final for the AI; 24 h expiry -> nothing paid, card gone',async()=>{
  const e=mk();const {to,key,r}=await ask(e);const {A}=approverFor(e);assert.equal(A.reject(r.approvalId),true);e.engine.mandates.reject(r.approvalId);
  const d=await e.buy.buy({purpose:'daily',item:'a new laptop stand',merchant:'Desk Shop',to,amount:'50',idempotencyKey:key},'grok');assert.equal(d.state,'rejected');assert.equal(d.reason,'OWNER_DECLINED');assert.equal(d.nothingPaid,true);
  const x=await ask(e);const db=new DatabaseSync(e.engine.ledgerPath);db.prepare(`UPDATE owner_ask SET expires_at=?, created_at=? WHERE approval_id=?`).run(Date.now()-1,Date.now()-86400e3-1,x.r.approvalId);
  db.prepare(`UPDATE mandate_proposal SET created_at=? WHERE id=?`).run(Date.now()-86400e3-1000,x.r.approvalId);db.close();
  const w0=e.s.writes.length;const [cp,op]=await A.prepare({id:x.r.approvalId,mode:'once'});assert.equal(cp,410);assert.equal(op.state,'expired');assert.equal(op.error,'request_gone');   // t1259 §6#129: 410 + plain reason (was 409)
  const ex=await e.buy.approvalStatus({approvalId:x.r.approvalId});assert.equal(ex.state,'expired');assert.equal(ex.nothingPaid,true);
  assert.ok(!e.engine.mandates.proposals().some(p=>p.id===x.r.approvalId),'expired card is not shown');assert.ok(['expired','not_pending'].includes(e.engine.mandates.approve(x.r.approvalId,()=>true,{mode:'once'}).error));assert.equal(e.s.writes.length,w0);});   // t1259: the card is already closed as expired

test('ask_owner outcomes do not count toward the repeated-cap-hit pause; real refusals still do',async()=>{
  const e=mk({tierLimits:{capHits1h:3,newPayees1h:999}});e.engine.mandates.propose({items:[{agentId:'grok',single:'1',daily:'2',monthly:'10'}],by:'owner'});for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);
  for(let i=0;i<6;i++){const r=(await ask(e,{amount:'5'})).r;assert.equal(r.decision,'ask_owner',JSON.stringify(r).slice(0,300));}assert.equal(e.paused.length,0,'asks never pause the wallet');});

test('kipurse_pay (MCP) and /v1/pay-any ask the same way; AI-supplied ownerApproval keeps the old checks',async()=>{
  const e=mk();const {server}=createV5Mcp(e.engine,{agentId:'claude'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);const c=new Client({name:'t1170',version:'1'});await c.connect(ct);
  const to=fresh(),key=idem();const call=async a=>JSON.parse((await c.callTool({name:'kipurse_pay',arguments:a})).content[0].text);
  const r=await call({to,amount:'40',idempotencyKey:key,order:{item:'desk',merchant:'Desk Co',user_request:'buy the desk'}});assert.equal(r.decision,'ask_owner');assert.equal(r.state,'awaiting_owner_approval');assert.equal(r.amount,'40');assert.deepEqual(amountProblems(r),[]);
  const r2=await call({to,amount:'40',idempotencyKey:key,order:{item:'desk',merchant:'Desk Co',user_request:'buy the desk'}});assert.equal(r2.approvalId,r.approvalId);
  const rm=JSON.parse((await c.callTool({name:'kipurse_remind_owner',arguments:{approvalId:r.approvalId}})).content[0].text);assert.equal(rm.reminded,true);
  const fake=await call({to,amount:'40',idempotencyKey:idem(),ownerApproval:{signature:'0x'+'11'.repeat(65),deadline:'9999999999'}});assert.notEqual(fake.state,'paid');await c.close();
  const srv=createV5HttpServer(e.engine,{agentTokens:{'tok-t1170-aaaaaaaa':'a1'}});await new Promise(z=>srv.listen(0,'127.0.0.1',z));const base='http://127.0.0.1:'+srv.address().port;
  const H={authorization:'Bearer tok-t1170-aaaaaaaa','content-type':'application/json','idempotency-key':'idem-t1170-v1-0001'};
  const v=await (await fetch(base+'/v1/pay-any',{method:'POST',headers:H,body:JSON.stringify({payment:{to:fresh(),amount:'30'},merchant:'Shop',orderRef:'o-1',order:{item:'chair',merchant:'Shop'}})})).json();
  srv.close();assert.equal(v.decision,'ask_owner',JSON.stringify(v).slice(0,300));assert.equal(v.state,'awaiting_owner_approval');assert.deepEqual(amountProblems(v),[]);});

test('trust caps follow the everyday limits, capped by wallet + phone ceiling; defaults when no everyday limits',()=>{
  assert.deepEqual(trustCapsFor({everyday:{authorized:true,single:'8000000',daily:'30000000'},wallet:{single:5000000n,daily:900000000n}}),{single:5000000n,daily:30000000n,days:90,source:'everyday'});
  assert.equal(trustCapsFor({everyday:{authorized:false},wallet:{single:100000000n,daily:900000000n}}).single,5000000n);
  assert.equal(trustCapsFor({everyday:{authorized:true,single:'50000000',daily:'10000000'},wallet:{single:900000000n,daily:900000000n}}).single,10000000n,'single never above daily');});

test('owner-ask store: one executor, 24 h validity, key mapping',()=>{let t=1000;const db=new DatabaseSync(':memory:');const S=createOwnerAsks({db,now:()=>t});
  S.put({approvalId:'apr_1',agentId:'a',idem:'k1',spec:{kind:'payAny',args:{}},payee:'0xAB',amount:'5000000',name:'n',note:'x'});S.put({approvalId:'apr_1',agentId:'b',idem:'k2',spec:{kind:'payAny',args:{}},payee:'0xAB',amount:'5000000'});
  assert.equal(S.byKey('b','k2').approvalId,'apr_1');assert.equal(S.byKey('a','k1').agentId,'a');assert.equal(S.claim('apr_1','once'),true);assert.equal(S.claim('apr_1','once'),false,'second approval -> no second execution');
  S.put({approvalId:'apr_2',agentId:'a',idem:'k3',spec:{},payee:'0xCD',amount:'1'});t+=86400e3+1;assert.equal(S.get('apr_2').state,'expired');assert.equal(S.claim('apr_2','once'),false);
  assert.equal(askView(S.get('apr_2')).reason,'ASK_EXPIRED');assert.equal(ownerKey('apr_1'),'owner-ask:apr_1');});

test('wiring: app routes (phone session) + push; no paymaster; the five anti-duplicate layers still in the code',async()=>{const fs=await import('node:fs');
  const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');assert.match(L,/\/safety\/mandates\/ask-prepare/);assert.match(L,/OASK\.approve\(b\)/);assert.match(L,/kind:'owner_ask'/);
  assert.ok(L.indexOf("u.pathname.startsWith('/safety/mandates')")<L.indexOf('/safety/mandates/ask-prepare'),'inside the phone-session block');
  for(const f of ['owner-ask.mjs','owner-ask-approve.mjs'])assert.doesNotMatch(fs.readFileSync(new URL('../src/v5/'+f,import.meta.url),'utf8'),/PAYMASTER/i);
  const led=fs.readFileSync(new URL('../src/v4/ledger.mjs',import.meta.url),'utf8');assert.match(led,/idempotencyBegin/);const md=fs.readFileSync(new URL('../src/v5/mandates.mjs',import.meta.url),'utf8');assert.match(md,/dedupe=\? AND state='pending'/);});
test('a stopped AI never gets an owner ask (refused AGENT_STOPPED, no card, no push); a paused wallet neither',async()=>{
  const e=mk();e.engine.mandates.agentStop('grok',true);const {r}=await ask(e);assert.equal(r.reason,'AGENT_STOPPED');assert.notEqual(r.decision,'ask_owner');assert.equal(e.props.length,0);
  const e2=mk();e2.paused.push({x:1});const {r:r2}=await ask(e2);assert.notEqual(r2.decision,'ask_owner');assert.equal(e2.props.length,0);});
