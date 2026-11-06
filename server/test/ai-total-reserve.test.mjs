import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {V4Ledger} from '../src/v4/ledger.mjs';
const payee='0x'+'11'.repeat(20);
const row=(amount,ref)=>({standard:'direct',chainId:8453,payee,amount,merchantOrderId:ref});
test('two reserved payments cannot both pass one total, and a released claim stops counting',()=>{
  const db=new V4Ledger(join(mkdtempSync(join(tmpdir(),'kp-')),'l.sqlite'));
  const a=db.claimWithin('k1',row(6_000_000n,'o1'),null,'siri',10_000_000n);
  const b=db.claimWithin('k2',row(6_000_000n,'o2'),null,'siri',10_000_000n);
  assert.equal(a.admitted,true);assert.equal(b.admitted,false);assert.equal(db.get('k1').state,'claimed');assert.equal(db.get('k2').state,'failed');
  assert.equal(db.committedSpend(),6_000_000n);db.close();});
test('a pending hold counts, and a float voucher already stored as a purchase is not counted twice',()=>{
  const db=new V4Ledger(join(mkdtempSync(join(tmpdir(),'kp-')),'l.sqlite'));
  db.claim('k1',row(4_000_000n,'o1'),null,'siri');
  db.db.exec(`CREATE TABLE payment_hold(id TEXT PRIMARY KEY, idem_key TEXT, created_at INTEGER, release_at INTEGER, state TEXT, agent_id TEXT, payee TEXT, amount TEXT, tier TEXT, args_json TEXT, result_json TEXT)`);
  db.db.prepare(`INSERT INTO payment_hold VALUES('h','h',1,2,'pending','siri',?, '3000000','stranger','{}',NULL)`).run(payee);
  db.db.exec(`CREATE TABLE float_vouchers(nonce TEXT PRIMARY KEY, session TEXT, purchase_key TEXT, payee TEXT, amount INTEGER, valid_before INTEGER, state TEXT, at INTEGER)`);
  db.db.exec(`CREATE TABLE float_sessions(session TEXT PRIMARY KEY, float_vault TEXT, funded INTEGER, fee_reserve INTEGER, network_fee INTEGER, fund_tx TEXT, funded_at INTEGER, spent INTEGER, fee INTEGER, reconcile_tx TEXT, reconciled_at INTEGER)`);
  db.db.prepare(`INSERT INTO float_vouchers VALUES('v','sess','k1',?,4000000,1,'signed',1)`).run(payee);
  db.db.prepare(`INSERT INTO float_sessions(session,funded,fund_tx,funded_at) VALUES('sess',9000000,'tx',1)`).run();
  // purchase 4 + hold 3 + unspent float (9 - 4 voucher) = 12. The voucher is the same purchase, so it is not added again.
  assert.equal(db.committedSpend(),12_000_000n);
  const fit=db.admitAmount('k1',4_000_000n,12_000_000n);assert.equal(fit.ok,true);
  db.claim('k3',row(1n,'o3'),null,'siri');
  assert.equal(db.admitAmount('k3',1n,12_000_000n).ok,false);assert.equal(db.get('k3').state,'failed');
  const before=db.db.prepare(`SELECT fund_tx,funded FROM float_sessions WHERE session='sess'`).get();
  assert.equal(db.reserveFloat('sess',1,10_000_000n).error,'reserve_failed');
  assert.deepEqual(db.db.prepare(`SELECT fund_tx,funded FROM float_sessions WHERE session='sess'`).get(),before);db.close();});
test('opening an existing ledger does not rewrite a paid purchase or change the schema',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'kp-')),'l.sqlite');
  const db=new V4Ledger(file);
  db.claim('paid1',row(1_000_000n,'o1'),null,'muse');
  db.db.prepare(`UPDATE purchases SET state='paid', tx_hash='0xabc' WHERE purchase_key='paid1'`).run();
  const tables=db.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(r=>r.name);
  db.close();
  const again=new V4Ledger(file);
  const kept=again.get('paid1');
  assert.equal(kept.state,'paid');assert.equal(kept.tx_hash,'0xabc');
  assert.deepEqual(again.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all().map(r=>r.name),tables);
  again.close();});
