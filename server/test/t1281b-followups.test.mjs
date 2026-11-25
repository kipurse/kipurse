// SPDX-License-Identifier: AGPL-3.0-only
// t1281 follow-ups (decision 141 (2)): (1) a spending sum that FAILS must not read as "nothing spent" (fail closed; only a missing
// table/column in an older schema counts as zero); (2) the spending report also states what really left the wallet (amount + fees);
// (3) the mainnet app purchase list carries fee / networkFee for the app's local fallback (SpendCost).
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {V4Ledger} from '../src/v4/ledger.mjs';
import {missingOk} from '../src/v5/spend-cost.mjs';
import {spendingReport} from '../src/v5/buy.mjs';
const payee='0x'+'11'.repeat(20);
const row=(amount,ref)=>({standard:'direct',chainId:8453,payee,amount,merchantOrderId:ref});
test('missingOk: only "no such table/column" is zero; any other error is thrown (refuse, nothing paid)',()=>{
  assert.equal(missingOk(new Error('no such table: float_vouchers')),0n);
  assert.equal(missingOk(new Error('SQLITE_ERROR: no such column: fee_reserve')),0n);
  assert.throws(()=>missingOk(new Error('disk I/O error')),/disk I\/O/);
  assert.throws(()=>missingOk(new Error('database is locked')),/locked/);});
test('a broken spending query makes the AI total check refuse instead of treating it as nothing spent',()=>{
  const db=new V4Ledger(join(mkdtempSync(join(tmpdir(),'kp-')),'l.sqlite'));
  assert.equal(db.claimWithin('k1',row(6_000_000n,'o1'),null,'siri',10_000_000n).admitted,true);
  const prep=db.db.prepare.bind(db.db);
  db.db.prepare=q=>{if(/FROM payment_hold/.test(q))throw new Error('disk I/O error');return prep(q);};
  assert.throws(()=>db.committedSpend(),/disk I\/O/,'old code: catch{} -> the hold sum silently became 0');
  db.db.prepare=prep;db.close();});
test('spending report: rows and total also say amount + fee + network fee (same formula as the limits)',()=>{
  const db=new V4Ledger(join(mkdtempSync(join(tmpdir(),'kp-')),'l.sqlite'));
  db.costParams=()=>({ppm:1000n,maxNetworkFee:50_000n});
  db.claimWithin('k1',row(2_000_000n,'o1'),null,'siri',100_000_000n);
  db.db.prepare(`UPDATE purchases SET state='paid',result=? WHERE purchase_key='k1'`).run(JSON.stringify({fee:'2000',networkFee:'3500'}));
  const r=spendingReport({ledger:db,orderFor:()=>({purpose:'food',item:'lunch'})},{period:'30d',format:'csv'});
  assert.equal(r.total,'2');assert.equal(r.totalWithFeesAtomic,'2005500');assert.equal(r.rows[0].chargedAtomic,'2005500');
  assert.match(r.say_to_user,/含全部手续费共 2\.0055 USDC/);assert.match(r.csv.split('\n')[0],/charged_usdc_with_fees$/);assert.match(r.csv.split('\n')[1],/,2\.0055$/);
  db.close();});
test('mainnet app purchase list passes fee / networkFee through',()=>{
  const s=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/amount:r\.amount,fee:r\.fee\?\?null,networkFee:r\.networkFee\?\?null,payee:r\.payee/);});
import {normalizeItem} from '../src/v5/mandates.mjs';
test('review #2: an allowance without a daily gets single + 0.1% + max network fee, so one payment of exactly `single` still fits its day',()=>{
  const i=normalizeItem({kind:'allowance',single:'5'});assert.equal(i.single,'5000000');assert.equal(i.daily,String(5_000_000n+5_000n+50_000n));
  const j=normalizeItem({kind:'allowance',single:'5',daily:'5'});assert.equal(j.daily,'5000000','an explicit daily is kept exactly');});
test('review #1: the app state reports today\'s signed stranger limits (the limits page keeps them instead of resetting to "same as normal")',()=>{
  const s=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/caps:\{single:String\(p\.single\),daily:String\(p\.daily\),term:String\(p\.term\),openSingle:String\(p\.openSingle\)(\/\*[^*]*\*\/)?,openDaily:String\(p\.openDaily\)/);
});
