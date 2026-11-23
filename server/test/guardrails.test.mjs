import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeOrder,checkOrder,checkTrial,priceAtomic,merchantTier,priceNote,claimedTier,blacklisted,checkAiVerified} from '../src/v5/guardrails.mjs';
import {getAddress} from 'viem';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {classifyPayee} from '../src/v5/address-trust.mjs';
import {engineFor,direct,PAYEE,TRUSTED} from './helpers/v5-fixture.mjs';
import {INSTRUCTIONS,FIX} from '../src/v5/mcp.mjs';
const CJK=/[\u3400-\u9fff]/;
const ON={requireOrder:true,requireEvidence:true};
const ORD={item:'coffee',merchant:'Blue Cafe',user_request:'帮我买一杯咖啡'};
test('A: order intent required; budget enforced; amount must match',()=>{
  assert.equal(normalizeOrder({}),null);
  assert.equal(checkOrder({cfg:ON,order:null,amount:1n,cfg:ON}).reason,'ORDER_INTENT_REQUIRED');
  assert.equal(checkOrder({cfg:ON,order:{item:'x',user_request:'ab'},amount:1n}).reason,'ORDER_INTENT_REQUIRED');
  assert.equal(checkOrder({cfg:ON,order:{user_request:'buy me a coffee'},amount:1n}).reason,'ORDER_INTENT_REQUIRED');
  const r=checkOrder({cfg:ON,order:null,amount:1n,cfg:ON});assert.match(r.fix,/user_request/);assert.equal(r.nothingPaid,true);
  assert.equal(checkOrder({cfg:ON,order:normalizeOrder({order:ORD}),amount:500000n}),null);
  assert.equal(normalizeOrder({userRequest:'buy it please',product:'pen'}).item,'pen');
  assert.equal(checkOrder({cfg:ON,order:{...ORD,max_price:'1.5'},amount:1600000n}).reason,'OVER_USER_BUDGET');
  assert.equal(checkOrder({cfg:ON,order:{...ORD,max_price:'1.5'},amount:1500000n}),null);
  assert.equal(checkOrder({cfg:ON,order:{...ORD,amount:'2'},amount:1500000n}).reason,'ORDER_AMOUNT_MISMATCH');
  assert.equal(priceAtomic('$12.50'),12500000n);assert.equal(priceAtomic('12.5 USDC'),12500000n);assert.equal(priceAtomic('abc'),undefined);});
test('C: price evidence above 20 USDC: >=2 offers with merchant, price, distinct https urls',()=>{
  const big=25000000n;assert.equal(checkOrder({cfg:ON,order:ORD,amount:big,cfg:ON}).reason,'PRICE_EVIDENCE_REQUIRED');
  const one=[{merchant:'A',price:'25',url:'https://a.example/x'}];assert.equal(checkOrder({cfg:ON,order:{...ORD,price_comparison:one},amount:big}).reason,'PRICE_EVIDENCE_REQUIRED');
  const dup=[...one,{merchant:'B',price:'26',url:'https://a.example/x'}];assert.equal(checkOrder({cfg:ON,order:{...ORD,price_comparison:dup},amount:big}).reason,'PRICE_EVIDENCE_REQUIRED');
  const http=[...one,{merchant:'B',price:'26',url:'http://b.example/x'}];assert.equal(checkOrder({cfg:ON,order:{...ORD,price_comparison:http},amount:big}).reason,'PRICE_EVIDENCE_REQUIRED');
  const ok=[...one,{merchant:'B',price:'24',url:'https://b.example/y'}];assert.equal(checkOrder({cfg:ON,order:{...ORD,price_comparison:ok},amount:big}),null);
  assert.equal(checkOrder({cfg:ON,order:ORD,amount:20000000n,cfg:ON}),null);
  assert.equal(priceNote({price_comparison:ok},big).cheapest,'24');});
test('B: stranger trial caps 1 / 5 USDC; D tiers',()=>{
  assert.equal(checkTrial({amount:1000000n}),null);assert.equal(checkTrial({amount:1000001n}).reason,'STRANGER_TRIAL_LIMIT');
  assert.equal(checkTrial({amount:1000000n,spentToday:4500000n}).reason,'STRANGER_TRIAL_DAILY');assert.match(checkTrial({amount:2000000n}).fix,/kipurse_request_trust/);
  assert.equal(checkTrial({amount:2000000n,cfg:{trialSingle:3000000n}}),null);
  const A='0x000000000000000000000000000000000000dEaD';
  assert.equal(merchantTier(classifyPayee({address:A,known:[{address:A,kind:'trial_paid'}]})),'stranger');
  assert.equal(merchantTier(classifyPayee({address:A,known:[{address:A,kind:'paid_before'}]})),'verified');
  assert.equal(merchantTier(classifyPayee({address:A,known:[{address:A,kind:'trust_list'}]})),'trusted');
  assert.equal(merchantTier(classifyPayee({address:A,tier:'trusted',known:[]})),'trusted');});
test('instructions and fixes: rules present, English only',()=>{
  for(const k of ['user_request','kipurse_request_trust','max_price','owner_chat','ai_verified','held','Face ID'])assert.match(INSTRUCTIONS,new RegExp(k));
  for(const k of ['ORDER_INTENT_REQUIRED','STRANGER_TRIAL','PRICE_EVIDENCE_REQUIRED','OVER_USER_BUDGET'])assert.ok(FIX[k]&&!CJK.test(FIX[k]));});
test('engine NO-AI-TRUST: AI alone never pays a new payee (any order, any source); owner pays; trusted / remembered payees pay; budget; replay',async()=>{
  const {engine,s}=engineFor({},{bal:100000000n,trusted:{[TRUSTED.toLowerCase()]:true}},{openSingle:'6000000',openDaily:'12000000'});const w0=s.writes.length;
  for(const src of [undefined,'ai_verified','from_web','from_document','other']){const r=await engine.pay({order:ORD,addressSource:src,request:direct('20000','g-'+src),idempotencyKey:'idem-g-'+String(src)});assert.equal(r.reason,'NEW_PAYEE_NEEDS_OWNER',String(src));assert.equal(r.nothingPaid,true);assert.match(r.say_to_user,/Face ID/);}
  assert.equal(s.writes.length,w0,'nothing sent on chain');
  const ro=await engine.pay({agentId:'owner',request:direct('1500000','g-8'),idempotencyKey:'idem-g-0008'});assert.equal(ro.state,'paid');
  const rk=await engine.pay({order:ORD,request:direct('500000','g-9'),idempotencyKey:'idem-g-0009'});assert.equal(rk.state,'paid','paid by the owner before = owner-established');
  const r6b=await engine.pay({order:{...ORD,max_price:'0.1'},request:direct('200000','g-6b'),idempotencyKey:'idem-g-006b'});assert.equal(r6b.reason,'OVER_USER_BUDGET');
  const rr=await engine.pay({order:ORD,request:direct('500000','g-9'),idempotencyKey:'idem-g-0009'});assert.equal(rr.purchaseKey,rk.purchaseKey);
  const rt=await engine.pay({order:ORD,request:direct('1500000','g-10',TRUSTED),idempotencyKey:'idem-g-0010'});assert.notEqual(rt.reason,'NEW_PAYEE_NEEDS_OWNER');
  const X=getAddress('0x77'+'7'.repeat(38));assert.equal((await engine.pay({request:direct('100000','g-11',X),idempotencyKey:'idem-g-0011'})).reason,'NEW_PAYEE_NEEDS_OWNER');
  engine.mandates.remember(X,'Tea Shop');const rm=await engine.pay({request:direct('100000','g-11',X),idempotencyKey:'idem-g-0011'});assert.equal(rm.state,'paid',JSON.stringify(rm));});

const P=i=>getAddress('0x'+String(i).padStart(4,'0')+'a'.repeat(32)+String(i).padStart(4,'0'));
const mk=(over={})=>{const paused=[];const e=engineFor({onAnomaly:r=>paused.push(r),ownerRulesDir:mkdtempSync(join(tmpdir(),'gr-')),...over},{bal:over.__bal??1000000000n},{openSingle:'500000000',openDaily:'900000000',single:'500000000',daily:'900000000',term:'900000000'});return {...e,paused};};
test('tiers: claimed source mapping; blacklist bundled',()=>{
  assert.equal(claimedTier('owner_chat'),'owner_direct');assert.equal(claimedTier('user_pasted'),'owner_direct');assert.equal(claimedTier('ai_verified'),'ai_verified');assert.equal(claimedTier('from_web'),'stranger');assert.equal(claimedTier(undefined),'stranger');
  assert.equal(blacklisted('0x101ce0cedd142f199c9ef61739ae59b6611a0fc0'),'scamsniffer');assert.equal(blacklisted('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),null);
  assert.equal(checkAiVerified({amount:20000001n}).reason,'AI_VERIFIED_LIMIT');assert.equal(checkAiVerified({amount:20000000n,spentToday:40000000n}).reason,'AI_VERIFIED_DAILY');assert.equal(checkAiVerified({amount:20000000n,spentToday:30000000n}),null);});
const upAi=async(engine,addr,tag)=>{for(let i=1;i<=3;i++){const r=await engine.pay({addressSource:'ai_verified',request:direct('5000000',tag+'-'+i,addr),idempotencyKey:'idem-'+tag+'-000'+i});assert.equal(r.state,'paid',JSON.stringify(r));}};
/* verified the normal way: paid before by the owner (RT-1: AI-only history keeps AI limits) */
const up=async(engine,addr,tag)=>{const r=await engine.pay({request:direct('5000000',tag+'-1',addr),idempotencyKey:'idem-'+tag+'-0001',agentId:'owner'});assert.equal(r.state,'paid',JSON.stringify(r));};
test('engine: ai_verified / AI payment history never verifies; owner_chat -> owner confirm (nothing paid)',async()=>{
  const {engine}=mk({tierLimits:{newPayees1h:99}});
  for(let i=0;i<4;i++){const r=await engine.pay({addressSource:'ai_verified',request:direct('1000000','ai-'+i,P(1)),idempotencyKey:'idem-ai-000'+i});assert.equal(r.reason,'NEW_PAYEE_NEEDS_OWNER');}
  assert.equal((await engine.verifyPayee({address:P(1)})).verified,false);
  const od=await engine.pay({addressSource:'owner_chat',order:{item:'rent',merchant:'Landlord Li',user_request:'pay my landlord'},request:direct('15000000','od-1',P(3)),idempotencyKey:'idem-od-0001'});
  assert.equal(od.state,'awaiting_owner_confirm',JSON.stringify(od));assert.equal(od.nothingPaid,true);assert.ok(od.trustRequestId);assert.doesNotMatch(od.say_to_user,/0x/);
  const od2=await engine.pay({addressSource:'owner_chat',request:direct('15000000','od-2',P(3)),idempotencyKey:'idem-od-0002'});assert.equal(od2.trustRequestId,od.trustRequestId);
  assert.equal((await engine.verifyPayee({address:P(3)})).verified,false);});

test('engine: hold >= 500 USDC (owner 2026-10-26; 499 is not held) for non-trust-list: held, retry same key = same hold, cancel; second one releases after the hold',async()=>{
  const {engine}=mk({__bal:5000000000n,tierLimits:{holdMs:150,newPayees1h:99}});await up(engine,P(4),'u4');await up(engine,P(5),'u5');
  {const nh=await engine.pay({request:direct('499000000','h-0',P(4)),idempotencyKey:'idem-h-0000'});assert.notEqual(nh.state,'held','499 USDC is below the 500 hold');}
  const h=await engine.pay({request:direct('500000000','h-1',P(4)),idempotencyKey:'idem-h-0001'});assert.equal(h.state,'held',JSON.stringify(h));assert.ok(h.holdId);
  const h2=await engine.pay({request:direct('500000000','h-1',P(4)),idempotencyKey:'idem-h-0001'});assert.equal(h2.holdId,h.holdId);
  assert.equal(engine.listHolds().length,1);assert.equal(engine.cancelHold(h.holdId).ok,true);assert.equal(engine.listHolds().length,0);
  await new Promise(z=>setTimeout(z,250));const h3=await engine.pay({request:direct('500000000','h-1',P(4)),idempotencyKey:'idem-h-0001'});assert.equal(h3.state,'canceled');
  const k=await engine.pay({request:direct('500000000','h-2',P(5)),idempotencyKey:'idem-h-0002'});assert.equal(k.state,'held');
  await new Promise(z=>setTimeout(z,400));const k2=await engine.pay({request:direct('500000000','h-2',P(5)),idempotencyKey:'idem-h-0002'});assert.equal(k2.state,'paid',JSON.stringify(k2));
  const t=await engine.pay({request:direct('500000000','h-3',TRUSTED),idempotencyKey:'idem-h-0003'});assert.notEqual(t.state,'held');});
test('engine: blacklist refused for every tier; anomaly pauses: 5 new payees, cap hits, large outflow; agent pause; summary',async()=>{
  const {engine,paused}=mk();
  const b=await engine.pay({addressSource:'owner_chat',request:direct('100000','b-1',getAddress('0x101ce0cedd142f199c9ef61739ae59b6611a0fc0')),idempotencyKey:'idem-b-0001'});assert.equal(b.reason,'SCAM_BLACKLIST');assert.equal(b.nothingPaid,true);
  for(let i=1;i<=4;i++){engine.mandates.remember(P(10+i),'Shop '+i);const r=await engine.pay({request:direct('100000','n-'+i,P(10+i)),idempotencyKey:'idem-n-000'+i});assert.equal(r.state,'paid',JSON.stringify(r));}
  const n5=await engine.pay({request:direct('100000','n-5',P(15)),idempotencyKey:'idem-n-0005'});assert.equal(n5.reason,'NEW_PAYEE_NEEDS_OWNER');
  const sm=engine.spendingSummary({period:'today'});assert.equal(sm.count,4);assert.equal(sm.total,'0.4');assert.doesNotMatch(sm.say_to_user,/0x/);
  const c=mk({tierLimits:{newPayees1h:99}});c.engine.mandates.remember(P(21),'Big');for(let i=1;i<=3;i++)await c.engine.pay({order:{item:'x',max_price:'1'},request:direct('2000000','c-'+i,P(21)),idempotencyKey:'idem-c-000'+i});assert.deepEqual(c.paused,['repeated_cap_hits']);
  const d=mk({tierLimits:{newPayees1h:99,holdAbove:10n**15n}});await up(d.engine,P(31),'d31');await up(d.engine,P(32),'d32');
  const big=await d.engine.pay({request:direct('400000000','d-1',P(31)),idempotencyKey:'idem-d-0001'});assert.equal(big.state,'paid',JSON.stringify(big));
  const big2=await d.engine.pay({request:direct('400000000','d-2',P(32)),idempotencyKey:'idem-d-0002'});assert.equal(big2.anomaly,'large_outflow');assert.deepEqual(d.paused,['large_outflow']);
  const ap=[];const e=mk({onAgentPause:r=>ap.push(r)});assert.equal(e.engine.agentSafetyPause().ok,true);assert.deepEqual(ap,['agent_pause']);});
