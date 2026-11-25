// SPDX-License-Identifier: AGPL-3.0-only
// t1281 (decision 141, owner decision): every off-chain limit counts what REALLY leaves the wallet: amount + 0.1% protocol fee +
// network fee, the same as the on-chain daily / term caps. Per-payment (single) caps still compare the amount only (like the chain).
// The app uses the identical formula (KipurseCore SpendCost); the cross-test fixture is checked here.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {getAddress} from 'viem';
import {engineFor,direct,WALLET} from './helpers/v5-fixture.mjs';
import {createEverydayLimits} from '../src/v5/everyday-limits.mjs';
import {costOf,costParts,incomingCost} from '../src/v5/spend-cost.mjs';
const P=i=>getAddress('0x'+String(i).padStart(4,'0')+'c'.repeat(32)+String(i).padStart(4,'0'));
let seq=0;const idem=()=>'idem-t1281-'+String(++seq).padStart(4,'0');
const FEE=500n,NF=3500n;// fixture: 0.1% of 0.5 USDC; network fee = 200000 gas x 7 gwei x 2500 USDC/ETH = 0.0035 USDC
/** engine with the REAL everyday limits (createEverydayLimits) wired like the mainnet launcher does */
function mk({limits,over={}}={}){const m=new Map();
  const ev=createEverydayLimits({kv:{get:k=>m.get(k),set:(k,v)=>m.set(k,v),del:k=>m.delete(k)},wallet:WALLET,floor:()=>({single:'6000000',daily:'12000000',term:'30000000'})});
  if(limits)assert.equal(ev.set(limits).ok,true);
  const calls=[];const e=engineFor({...(limits?{everydayCheck:a=>{calls.push(a);return ev.check(a);},everydayGet:()=>ev.get()}:{}),...over},{bal:100000000n},{openSingle:'6000000',openDaily:'12000000'});/* the on-chain stranger caps are not under test here */
  return {...e,ev,calls};}
const approveAll=M=>{for(const p of M.proposals())if(p.state==='pending')assert.equal(M.approve(p.id,()=>true).ok,true);};
const paidCost=E=>E.listPurchases({state:'paid'}).reduce((a,r)=>a+BigInt(r.amount)+BigInt(r.fee)+BigInt(r.networkFee),0n);

test('t1281 (a): many small payments can no longer go over the everyday daily limit by the sum of their fees',async()=>{
  const e=mk({limits:{single:'1000000',daily:'2000000',term:'30000000'}});const out=[];
  for(let i=1;i<=4;i++){e.engine.mandates.remember(P(i),'Shop '+i);out.push(await e.engine.pay({agentId:'a1',request:direct('500000','a-'+i,P(i)),idempotencyKey:idem()}));}
  assert.deepEqual(out.slice(0,3).map(r=>r.state),['paid','paid','paid'],JSON.stringify(out));
  // amount only: 4 x 0.5 = 2.0 <= 2 would pass; amount + fee + network fee: 3 x 0.504 + 0.5005 > 2
  assert.equal(out[3].reason,'EVERYDAY_DAILY_LIMIT',JSON.stringify(out[3]));assert.equal(out[3].nothingPaid,true);
  assert.equal(e.s.writes.filter(w=>w.fn==='payDirect').length,3);
  const total=paidCost(e.engine);assert.equal(total,3n*(500000n+FEE+NF));assert.ok(total<=2000000n,'what left the wallet stays inside the daily limit');
  // the everyday check was handed the cost, the per-payment check the amount
  assert.ok(e.calls.some(c=>c.amount===500000n&&c.cost===500000n+FEE),'early gate: amount + fee');
  assert.ok(e.calls.some(c=>c.amount===500000n&&c.cost===500000n+FEE+NF),'claim time: amount + fee + quoted network fee');});

test('t1281 (b): the per-AI daily cap counts fees; agents() reports the fee-inclusive spend',async()=>{
  const e=mk();const M=e.engine.mandates;M.propose({items:[{kind:'agent_limits',agentId:'grok',daily:'1',monthly:'10'}]});approveAll(M);
  M.remember(P(11),'Shop A');M.remember(P(12),'Shop B');
  const r1=await e.engine.pay({agentId:'grok',request:direct('500000','b-1',P(11)),idempotencyKey:idem()});assert.equal(r1.state,'paid',JSON.stringify(r1));
  const r2=await e.engine.pay({agentId:'grok',request:direct('500000','b-2',P(12)),idempotencyKey:idem()});
  assert.equal(r2.reason,'AGENT_DAILY_CAP',JSON.stringify(r2));assert.equal(r2.nothingPaid,true);assert.match(r2.detail,/0\.504 \+ 0\.5005 > 1 \(fees included\)/);
  const g=M.agents().find(a=>a.agentId==='grok');assert.equal(g.spentTodayAtomic,String(500000n+FEE+NF));assert.equal(g.spentToday,'0.504');assert.equal(g.spentMonthAtomic,'504000');});

test('t1281 (c): an allowance (mandate) daily limit counts fees; usage() is fee-inclusive',async()=>{
  const e=mk();const M=e.engine.mandates;M.propose({items:[{purpose:'all',single:'1',daily:'1',monthly:'10'}]});approveAll(M);
  M.remember(P(21),'Shop A');M.remember(P(22),'Shop B');
  const r1=await e.engine.pay({agentId:'a1',request:direct('500000','c-1',P(21)),idempotencyKey:idem()});assert.equal(r1.state,'paid',JSON.stringify(r1));assert.equal(r1.payee_tier,'mandate');
  const r2=await e.engine.pay({agentId:'a1',request:direct('500000','c-2',P(22)),idempotencyKey:idem()});
  assert.equal(r2.reason,'MANDATE_OVER_DAILY',JSON.stringify(r2));assert.equal(r2.nothingPaid,true);
  const u=M.list().find(m=>m.purpose==='all').usage;assert.equal(u.todayAtomic,'504000');assert.equal(u.leftTodayAtomic,'496000');assert.equal(u.today,'0.504');});

test('t1281 (d): fits by amount (and amount + fee) but not with the network fee -> refused at claim time, nothing paid',async()=>{
  const e=mk({limits:{single:'1000000',daily:'1000000',term:'30000000'}});e.engine.mandates.remember(P(31),'Shop');
  const r=await e.engine.pay({agentId:'a1',request:direct('998000','d-1',P(31)),idempotencyKey:idem()});
  assert.equal(r.reason,'EVERYDAY_DAILY_LIMIT',JSON.stringify(r));assert.equal(r.nothingPaid,true);
  assert.equal(e.s.writes.length,0,'nothing sent');assert.equal(e.engine.listPurchases({state:'paid'}).length,0);
  const early=e.calls.find(c=>c.cost===998000n+998n);assert.ok(early,'the early gate (amount + fee) let it through');
  assert.equal(e.calls.at(-1).cost,998000n+998n+NF,'the claim-time check counted the quoted network fee');
  // the same for a per-AI daily cap: early check passes, the claim-time check (with the network fee) refuses
  const f=mk();const M=f.engine.mandates;M.propose({items:[{kind:'agent_limits',agentId:'grok',daily:'1',monthly:'10'}]});approveAll(M);M.remember(P(32),'Shop');
  const r2=await f.engine.pay({agentId:'grok',request:direct('998000','d-2',P(32)),idempotencyKey:idem()});
  assert.equal(r2.reason,'AGENT_DAILY_CAP',JSON.stringify(r2));assert.equal(r2.nothingPaid,true);assert.equal(f.s.writes.length,0);});

test('t1281 (e): per-payment (single) caps still compare the amount only, like the chain',async()=>{
  const e=mk({limits:{single:'1000000',daily:'5000000',term:'30000000'}});e.engine.mandates.remember(P(41),'Shop');
  const r=await e.engine.pay({agentId:'a1',request:direct('1000000','e-1',P(41)),idempotencyKey:idem()});assert.equal(r.state,'paid',JSON.stringify(r));
  assert.equal(r.total,String(1000000n+1000n+NF),'it cost more than the single limit, which counts the amount');
  const over=await e.engine.pay({agentId:'a1',request:direct('1000001','e-2',P(41)),idempotencyKey:idem()});assert.equal(over.reason,'EVERYDAY_SINGLE_LIMIT');
  const f=mk();const M=f.engine.mandates;M.propose({items:[{kind:'agent_limits',agentId:'solo',single:'1',daily:'5',monthly:'10'}]});approveAll(M);M.remember(P(42),'Shop');
  assert.equal((await f.engine.pay({agentId:'solo',request:direct('1000000','e-3',P(42)),idempotencyKey:idem()})).state,'paid');
  assert.equal((await f.engine.pay({agentId:'solo',request:direct('1000001','e-4',P(42)),idempotencyKey:idem()})).reason,'AGENT_SINGLE_CAP');});

test('t1281: listPurchases reports fee + networkFee; spendingSummary and the AI total count them',async()=>{
  const e=mk({limits:{single:'1000000',daily:'5000000',term:'30000000'}});e.engine.mandates.remember(P(51),'Shop');
  assert.equal((await e.engine.pay({agentId:'a1',request:direct('500000','l-1',P(51)),idempotencyKey:idem()})).state,'paid');
  const [row]=e.engine.listPurchases({state:'paid'});assert.equal(row.fee,'500');assert.equal(row.networkFee,'3500');
  assert.equal(e.engine.spendingSummary({period:'today'}).total,'0.504');
  assert.equal(e.engine.ledger.committedSpend(),504000n,'AI total (term) = amount + fee + network fee');
  // a float reservation holds its fee reserve and funding network fee too
  const L=e.engine.ledger;assert.equal(L.reserveFloat('rsv-x',1000000,10000000n,{feeReserve:1000n,networkFee:4000n}).ok,true);
  assert.equal(L.committedSpend(),504000n+1000000n+1000n+4000n);L.clearFloatReserve('rsv-x');assert.equal(L.committedSpend(),504000n);});

test('t1281: the one formula (spend-cost.mjs)',()=>{const pr={ppm:1000n,maxNetworkFee:50000n};
  assert.equal(costOf({amount:'500000',result:JSON.stringify({fee:'500',networkFee:'3500'}),state:'paid'},pr),504000n);
  assert.equal(costOf({amount:'500000',result:null,state:'paid'},pr),500500n,'finished without fields: fee computed, network fee 0');
  assert.equal(costOf({amount:'500000',result:null,state:'claimed'},pr),550500n,'in flight without a quote: owner max network fee');
  assert.equal(costOf({amount:'500000',result:{pending:{networkFee:'3900'}},state:'submitted'},pr),504400n);
  assert.equal(costOf({amount:'1',result:null,state:'paid'},pr),2n,'fee rounds up like the adapter');
  assert.deepEqual(costParts({amount:'90000',result:{float:true,fee:'90',networkFee:'0'},state:'paid'},pr),{amount:90000n,fee:90n,networkFee:0n,total:90090n});
  assert.equal(incomingCost(998000n,{ppm:1000n}),998998n);assert.equal(incomingCost(998000n,{ppm:1000n,networkFee:3500n}),1002498n);});

test('t1281: the iOS cross-test fixture is exactly what the server formula generates (scripts/t1281-spend-cost-fixture.mjs)',async()=>{
  const {execFileSync}=await import('node:child_process');const p=new URL('../../../../../../kipurse-ios/Kipurse/Tests/KipurseCoreTests/t1281-spend-cost.json.txt',import.meta.url);
  if(!fs.existsSync(p))return;   // the iOS repo is not next to this checkout (CI / public export)
  const gen=execFileSync(process.execPath,[new URL('../scripts/t1281-spend-cost-fixture.mjs',import.meta.url).pathname],{encoding:'utf8'});
  assert.equal(fs.readFileSync(p,'utf8'),gen);
  for(const c of JSON.parse(gen).cases)assert.equal(costOf({amount:c.amount,result:{...(c.fee!==null?{fee:c.fee}:{}),...(c.networkFee!==null?{networkFee:c.networkFee}:{})},state:c.state},{ppm:BigInt(c.ppm),maxNetworkFee:BigInt(c.maxNetworkFee)}).toString(),c.expected);});
