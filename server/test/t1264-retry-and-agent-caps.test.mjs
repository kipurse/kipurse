// t1264 (follow-up): transient "retry later" answers are never the key's stored final answer (the SAME key really retries); per-AI caps
// count only the AI's own payments (not owner-approved asks / owner / withdrawal rows).
import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {engineFor,direct} from './helpers/v5-fixture.mjs';import {createMandates} from '../src/v5/mandates.mjs';
let n=0;const idem=t=>'idem-t1264r-'+t+'-'+(n++).toString().padStart(4,'0');
const pays=s=>s.writes.filter(w=>w.fn==='payDirect').length;
const stored=(e,k)=>e.engine.ledger.db.prepare(`SELECT response FROM idempotency WHERE idem_key=?`).get(k)?.response??null;

test('t1264: tx_in_flight retry_later is not stored; the same key pays once the wallet is free',async()=>{
  const e=engineFor();const k=idem('tf');let release;const held=new Promise(z=>{release=z;});
  const hold=e.engine.withWalletTx(()=>held);
  const r=await e.engine.pay({agentId:'owner',request:direct('20000','t1264r-tf'),idempotencyKey:k});assert.equal(r.state,'retry_later',JSON.stringify(r));assert.equal(r.reason,'tx_in_flight');
  assert.equal(stored(e,k),null,'not stored');release();await hold;
  const r2=await e.engine.pay({agentId:'owner',request:direct('20000','t1264r-tf'),idempotencyKey:k});assert.equal(r2.state,'paid',JSON.stringify(r2));assert.equal(pays(e.s),1);
  const r3=await e.engine.pay({agentId:'owner',request:direct('20000','t1264r-tf'),idempotencyKey:k});assert.equal(r3.state,'paid');assert.equal(pays(e.s),1,'terminal answer replayed, never paid twice');});

test('t1264: gas_spike retry_later is not stored; the same key pays when gas is back under the cap',async()=>{
  const e=engineFor({gasPricing:{usdcPerEth:'2500000000',gasPriceWei:'7000000',fixedAtomic:'60000'}});const k=idem('gs');
  const r=await e.engine.pay({agentId:'owner',request:direct('20000','t1264r-gs'),idempotencyKey:k});assert.equal(r.state,'retry_later');assert.equal(r.reason,'gas_spike');assert.equal(stored(e,k),null);
  delete e.cfg.gasPricing.fixedAtomic;const r2=await e.engine.pay({agentId:'owner',request:direct('20000','t1264r-gs'),idempotencyKey:k});assert.equal(r2.state,'paid',JSON.stringify(r2));assert.equal(pays(e.s),1);});

test('t1264: daily operations used up (decision wait, retryable) is not stored; the same key pays after the reset; a policy refusal stays stored',async()=>{
  const e=engineFor();const k=idem('op');const orig=e.client.write;let full=true;
  e.client.write=async(fn,a,o)=>{if(full&&fn==='payDirect')throw Object.assign(Error('DAILY_OPERATIONS_USED_UP'),{code:'daily_ops_used_up',cap:'500',used:'500',resetsAt:new Date(Date.now()+3600e3).toISOString()});return orig(fn,a,o);};
  const r=await e.engine.pay({agentId:'owner',request:direct('20000','t1264r-op'),idempotencyKey:k});assert.equal(r.reason,'DAILY_OPERATIONS_USED_UP');assert.equal(r.decision,'wait');assert.equal(stored(e,k),null);
  full=false;const r2=await e.engine.pay({agentId:'owner',request:direct('20000','t1264r-op'),idempotencyKey:k});assert.equal(r2.state,'paid',JSON.stringify(r2));
  const k2=idem('pol');const p=await e.engine.pay({agentId:'owner',request:direct('999000000','t1264r-pol'),idempotencyKey:k2});assert.equal(p.state,'rejected');assert.ok(stored(e,k2),'policy refusal is terminal: stored');});

test('t1264: per-AI caps (agentSpent) count only the AI\'s own payments, not owner-approved asks / owner / withdrawal rows',()=>{
  const db=new DatabaseSync(':memory:');let t=1.8e12;db.exec(`CREATE TABLE purchases(purchase_key TEXT PRIMARY KEY, state TEXT NOT NULL);CREATE TABLE purchase_order(purchase_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL, agent_id TEXT, payee TEXT, amount TEXT, tier TEXT, address_status TEXT, order_json TEXT NOT NULL)`);
  const M=createMandates({db,now:()=>t});const p=M.propose({items:[{kind:'agent_limits',agentId:'grok',daily:'10',monthly:'100'}],by:'owner'});assert.equal(M.approve(p.id,()=>true).ok,true);
  const add=(k,amt,origin)=>{db.prepare(`INSERT INTO purchases VALUES(?,'paid')`).run(k);db.prepare(`INSERT INTO purchase_order VALUES(?,?,?,?,?,?,?,?)`).run(k,t,'grok','0x1',String(amt),'x',null,'{}');if(origin)db.prepare(`INSERT INTO purchase_origin VALUES(?,?)`).run(k,origin);};
  add('ai1',4000000,null);add('ask1',50000000,'owner_ask');add('own1',20000000,'owner');add('wd1',30000000,'withdrawal');add('ai2',1000000,'ai');
  assert.equal(M.agents().find(a=>a.agentId==='grok').spentTodayAtomic,'5000000','only the AI rows');
  assert.equal(M.agentCheck('grok',5000000n),null,'5 + 5 <= 10: the owner-approved 50 USDC does not use up the AI cap');
  assert.equal(M.agentCheck('grok',5000001n)?.reason,'AGENT_DAILY_CAP');});
