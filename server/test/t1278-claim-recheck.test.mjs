// SPDX-License-Identifier: AGPL-3.0-only
// t1278 S4: the AI checks (everyday 24h, per-AI caps, one-off / recurring allowances) ran before the claim and read only FINISHED order rows,
// so a payment claimed by another request in between was not counted. They now run again inside the claim's BEGIN IMMEDIATE, the provisional
// order row is written in that same transaction, and a one-off approval is consumed at claim time (given back after a definite failure).
// The concurrent payment is simulated by writing its claim between this payment's checks and its claim (hook on a read in that window).
import test from 'node:test';import assert from 'node:assert/strict';import {engineFor,direct} from './helpers/v5-fixture.mjs';import {V4Ledger} from '../src/v4/ledger.mjs';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
let n=0;const idem=()=>'idem-t1278-s4-'+(++n);
const fresh=()=>'0x'+[...crypto.getRandomValues(new Uint8Array(20))].map(b=>b.toString(16).padStart(2,'0')).join('');
/** run `fn` once, right after this payment's AI checks and before its claim (payNormalized reads isValid in that window) */
const between=(e,fn)=>{const rd=e.client.read;let done=false;e.client.read=async(f,a)=>{if(f==='isValid'&&!done){done=true;fn();}return rd(f,a);};};
/** another request of agent `agent` claimed `amount` to `payee` (in flight: claimed + its provisional order row) */
const otherInFlight=(e,{agent='a1',payee,amount,tier='trust_list',order={}})=>{const k='ff'.repeat(31)+String(++n).padStart(2,'0');const L=e.engine.ledger;
  L.claim(k,{standard:'direct',chainId:84532,payee,amount:BigInt(amount),merchantOrderId:'other-'+n},null,agent);
  L.db.prepare(`INSERT INTO purchase_order VALUES(?,?,?,?,?,?,?,?)`).run(k,Date.now(),agent,payee,String(amount),tier,null,JSON.stringify({__claim:1,...order}));return k;};
const approveAll=M=>{for(const p of M.proposals())M.approve(p.id,()=>true);};

test('t1278 S4 ledger: claim(check, after) run inside the claim transaction; a refusal writes nothing',()=>{
  const L=new V4Ledger(join(mkdtempSync(join(tmpdir(),'t1278l-')),'l.sqlite'));const row={standard:'direct',chainId:84532,payee:'0x'+'1'.repeat(40),amount:5n,merchantOrderId:'o'};
  let inTx=null;const r=L.claim('k1',row,null,'a',{check:()=>{inTx=L.db.isTransaction;return {state:'rejected',reason:'X'};}});
  assert.equal(inTx,true,'check runs inside BEGIN IMMEDIATE');assert.equal(r.won,false);assert.equal(r.refused.reason,'X');assert.equal(L.get('k1'),undefined,'nothing written');
  let after=0;const ok=L.claimWithin('k2',row,null,'a',100n,{check:()=>null,after:()=>{after++;assert.equal(L.db.isTransaction,true);}});assert.equal(ok.admitted,true);assert.equal(after,1);
  const no=L.claimWithin('k3',{...row,amount:200n},null,'a',100n,{after:()=>{after++;}});assert.equal(no.admitted,false);assert.equal(after,1,'after() only for an admitted claim');});

test('t1278 S4: per-AI daily cap is re-checked at claim time, counting another in-flight payment of the same AI',async()=>{
  const e=engineFor();const M=e.engine.mandates;M.propose({items:[{kind:'agent_limits',agentId:'a1',daily:'0.1',monthly:'10'}]});approveAll(M);
  const P=fresh();M.remember(P,'Shop');const w0=e.s.writes.length;between(e,()=>otherInFlight(e,{payee:P,amount:60001}));/* t1280: not the same amount, so this tests the per-AI cap, not the duplicate guard */
  const r=await e.engine.pay({agentId:'a1',request:direct('60000','s4-a',P),idempotencyKey:idem()});
  assert.equal(r.state,'rejected',JSON.stringify(r));assert.equal(r.reason,'AGENT_DAILY_CAP');assert.equal(r.nothingPaid,true);assert.equal(e.s.writes.length,w0,'nothing sent');
  // without the other payment the same request pays, and its order row is complete (not provisional)
  const e2=engineFor();e2.engine.mandates.propose({items:[{kind:'agent_limits',agentId:'a1',daily:'0.1',monthly:'10'}]});approveAll(e2.engine.mandates);e2.engine.mandates.remember(P,'Shop');
  const ok=await e2.engine.pay({agentId:'a1',request:direct('60000','s4-b',P),idempotencyKey:idem()});assert.equal(ok.state,'paid',JSON.stringify(ok));
  const row=e2.engine.ledger.db.prepare(`SELECT * FROM purchase_order WHERE purchase_key=?`).get(ok.purchaseKey);assert.equal(row.tier,'trust_list');assert.ok(!row.order_json.includes('__claim'),'recordOrder completed it');});

test('t1278 S4: the everyday 24h limit is re-checked at claim time (in-flight payments + pending holds count)',async()=>{
  const seen=[];const e=engineFor({everydayCheck:({amount,spent24h})=>{seen.push(spent24h);return spent24h+amount>100000n?{state:'rejected',reason:'EVERYDAY_DAILY_LIMIT',nothingPaid:true,capHit:true}:null;}});
  const P=fresh();e.engine.mandates.remember(P,'Shop');between(e,()=>otherInFlight(e,{payee:P,amount:70000}));
  const r=await e.engine.pay({agentId:'a1',request:direct('50000','s4-c',P),idempotencyKey:idem()});
  assert.equal(r.reason,'EVERYDAY_DAILY_LIMIT',JSON.stringify(r));assert.equal(seen[0],0n,'the pre-check saw nothing');assert.equal(seen.at(-1),70000n+70n+50000n,'the claim-time check saw the in-flight payment (t1281: amount + 0.1% fee + maxNetworkFee placeholder while it has no quote)');
  // a pending 10-minute hold counts too
  const e2=engineFor({everydayCheck:({amount,spent24h})=>spent24h+amount>100000n?{state:'rejected',reason:'EVERYDAY_DAILY_LIMIT',nothingPaid:true}:null});e2.engine.mandates.remember(P,'Shop');
  between(e2,()=>e2.engine.ledger.db.prepare(`INSERT INTO payment_hold VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).run('hold_x','k-x',Date.now(),Date.now()+600e3,'pending','a1',P,'70000','trust_list','{}'));
  assert.equal((await e2.engine.pay({agentId:'a1',request:direct('50000','s4-d',P),idempotencyKey:idem()})).reason,'EVERYDAY_DAILY_LIMIT');});

test('t1278 S4: a one-off approval is consumed at claim time: a second payment that matched it first is refused; a definite failure gives it back',async()=>{
  const e=engineFor();const M=e.engine.mandates;const P=fresh();M.propose({items:[{purpose:'daily',single:'0.05',oneOff:{payee:P}}]});approveAll(M);
  const one=()=>e.engine.ledger.db.prepare(`SELECT id,uses,state FROM mandate WHERE kind='one_off'`).get();assert.equal(one().uses,0);
  // another payment consumed it between this payment's check and its claim
  between(e,()=>assert.equal(M.consume(one().id),true));const w0=e.s.writes.length;
  const r=await e.engine.pay({agentId:'a1',request:direct('50000','s4-e',P),idempotencyKey:idem()});
  assert.equal(r.state,'rejected',JSON.stringify(r));assert.match(r.reason,/^MANDATE_/);assert.equal(e.s.writes.length,w0,'nothing sent');
  // give it back; an on-chain revert (definite failure) releases it; the retry then pays and closes it
  M.release(one().id);assert.equal(one().uses,0);e.s.revertOnChain=1;
  const f=await e.engine.pay({agentId:'a1',request:direct('50000','s4-f',P),idempotencyKey:idem()});assert.equal(f.state,'failed',JSON.stringify(f));assert.equal(one().uses,0,'released after the revert');
  const ok=await e.engine.pay({agentId:'a1',request:direct('50000','s4-g',P),idempotencyKey:idem()});assert.equal(ok.state,'paid',JSON.stringify(ok));
  assert.equal(one().uses,1,'closed once (uses not double-counted)');assert.equal(one().state,'used');});
