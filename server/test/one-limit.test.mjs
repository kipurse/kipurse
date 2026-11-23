// ONE LIMIT (owner 2026-10-27 t592u): one overall AI limit; categories are automatic labels only.
import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {getAddress} from 'viem';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createMandates,classifyCategory,CATEGORIES,BEGINNER_DEFAULTS,normalizeItem} from '../src/v5/mandates.mjs';
import {engineFor,direct} from './helpers/v5-fixture.mjs';import {createBuy} from '../src/v5/buy.mjs';
const P=i=>getAddress('0x'+String(i).padStart(4,'0')+'e'.repeat(32)+String(i).padStart(4,'0'));
const U=n=>String(BigInt(Math.round(n*1e6)));
function oldDb(rows){const db=new DatabaseSync(':memory:');createMandates({db});const t=Date.now();
  for(const [i,r] of rows.entries())db.prepare(`INSERT INTO mandate VALUES(?,?,?,?,?,?,?,?,?,0)`).run('old'+i,t,t,r.exp??t+86400e3*30,r.state??'active','allowance',r.purpose,JSON.stringify({single:U(r.s),daily:U(r.d),monthly:U(r.m),payees:r.payees??[],hosts:[],agents:r.agents??[],recurring:null,oneOff:null}),'p'+i);
  return db;}
test('categories are the six labels; beginner default is ONE overall limit',()=>{
  assert.deepEqual(CATEGORIES,['daily','study','promo','dev','work','other']);assert.equal(BEGINNER_DEFAULTS.length,1);assert.equal(BEGINNER_DEFAULTS[0].purpose,'all');
  assert.equal(normalizeItem({single:'5',daily:'20',monthly:'100'}).purpose,'all','no purpose needed');
  assert.equal(normalizeItem({purpose:'study',single:'2'}).purpose,'all','a plain allowance is always the overall limit');});
test('auto classification from purpose / item / merchant / host',()=>{
  const c=x=>classifyCategory(x);
  assert.equal(c({purpose:'宣传'}),'promo');assert.equal(c({item:'OpenAI API credits'}),'dev');assert.equal(c({merchant:'Starbucks coffee'}),'daily');
  assert.equal(c({item:'python course'}),'study');assert.equal(c({item:'发票 报销'}),'work');assert.equal(c({item:'something'}),'other');assert.equal(c({}),'other');
  assert.equal(c({host:'api.github.com'}),'dev');assert.equal(c({purpose:'subscription'}),'work');});
test('migration: old category allowances are retired; the ONE limit is the wallet limit (no cap raised)',()=>{
  const db=oldDb([{purpose:'daily',s:5,d:20,m:100},{purpose:'study',s:2,d:5,m:30},{purpose:'promo',s:50,d:60,m:70,payees:['0x'+'1'.repeat(40)]},{purpose:'work',s:99,d:99,m:999,state:'revoked'}]);
  const M=createMandates({db,walletCaps:()=>({single:U(5),daily:U(50),term:U(500)})});assert.equal(db.prepare(`SELECT count(*) n FROM mandate WHERE state='merged'`).get().n,0,'read-only: no ledger writes');
  assert.equal(M.list().length,0,'no per-category allowance is left');const o=M.overall();assert.equal(o.id,'wallet-limit');assert.equal(o.single,U(5));assert.equal(o.daily,U(50));assert.equal(o.monthly,U(500));
  assert.equal(M.match({payee:'0x'+'2'.repeat(40),amount:4000000n}).why,'no_mandate','the wallet limit is applied by the normal rules, not as an allowance that skips owner checks');
  createMandates({db,walletCaps:()=>({single:U(5),daily:U(50),term:U(500)})});assert.equal(createMandates({db}).list().length,0,'idempotent');});
test('an explicit owner overall limit is clamped by the wallet caps, never above them',()=>{
  const db=oldDb([{purpose:'all',s:50,d:10,m:3000}]);const M=createMandates({db,walletCaps:()=>({single:U(5),daily:U(50),term:U(500)})});const o=M.overall();
  assert.equal(o.single,U(5));assert.equal(o.daily,U(10));assert.equal(o.monthly,U(500));});
test('no wallet caps and no overall item -> nothing is auto-paid',()=>{const db=oldDb([]);assert.equal(createMandates({db}).overall(),null);assert.equal(createMandates({db}).match({payee:'0x'+'2'.repeat(40),amount:1n}).ok,false);});
test('pay without a category inside the ONE limit; over it -> one Face ID; summary shows category labels; renewal already paid never falls through',async()=>{
  const e=engineFor({ownerRulesDir:mkdtempSync(join(tmpdir(),'ol-'))},{bal:1000000000n},{openSingle:'500000000',openDaily:'900000000',single:'500000000',daily:'900000000',term:'900000000'});const E=e.engine;
  const ok=()=>true;const approveAll=()=>{for(const p of E.mandates.proposals())E.mandates.approve(p.id,ok);};const buy=createBuy(E,{sleep:async()=>{},waitMs:0});
  E.mandates.propose({items:BEGINNER_DEFAULTS,by:'owner'});approveAll();
  await E.pay({request:direct('1000000','own-1',P(1)),idempotencyKey:'idem-own-0001',agentId:'owner'});
  const r=await buy.buy({item:'OpenAI API credits',merchant:'OpenAI',to:P(1),amount:'2',idempotencyKey:'idem-ol-0001'},'claude');assert.equal(r.state,'paid',JSON.stringify(r));
  const r2=await buy.buy({item:'coffee',merchant:'Cafe',to:P(1),amount:'6',idempotencyKey:'idem-ol-0002'},'claude');assert.equal(r2.decision,'ask_owner');assert.equal(r2.nothingPaid,true);
  const s=E.spendingSummary({period:'today'});const dev=s.categories.find(c=>c.key==='dev');assert.ok(dev,JSON.stringify(s.categories));assert.equal(dev.zh,'开发');assert.equal(dev.amount,'2');
  E.mandates.propose({items:[{purpose:'subscription',single:'3',recurring:{payee:P(2),amount:'3',every:'month',name:'Server'}}],by:'owner'});approveAll();
  assert.equal((await buy.buy({item:'server',merchant:'Server',to:P(2),amount:'3',idempotencyKey:'idem-ol-0003'},'claude')).state,'paid');
  const again=await buy.buy({item:'server',merchant:'Server',to:P(2),amount:'3',idempotencyKey:'idem-ol-0004'},'claude');assert.equal(again.decision,'ask_owner');assert.equal(again.reason,'MANDATE_RECURRING_ALREADY_PAID');});
test('no monthly cap wording for the ONE limit (owner 2026-10-27 14:23): per payment / per day / total',async()=>{
  const {INSTRUCTIONS}=await import('../src/v5/mcp.mjs');assert.match(INSTRUCTIONS,/per payment \/ per day \/ total/);assert.doesNotMatch(INSTRUCTIONS,/per payment \/ per day \/ per month/);
  const M=createMandates({db:new DatabaseSync(':memory:'),walletCaps:()=>({single:U(5),daily:U(50),term:U(500)})});const o=M.overall();assert.equal(o.total,U(500));
  const h=M.human({kind:'allowance',purpose:'all',single:U(5),daily:U(50),monthly:U(500),payees:[],hosts:[]});assert.match(h.zh,/总额 500/);assert.doesNotMatch(h.zh,/每月/);assert.match(h.en,/500 total/);assert.doesNotMatch(h.en,/month/);});
