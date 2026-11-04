// t595 item 4: OFAC SDN screening for payments (agent + owner), trust entries and withdrawal destination.
import test from 'node:test';import assert from 'node:assert/strict';import {getAddress} from 'viem';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {engineFor} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';
import {createSanctions,loadSnapshot} from '../src/v5/sanctions.mjs';import {createOwnerWithdraw} from '../src/v5/owner-withdraw.mjs';
const SDN=getAddress('0x0330070FD38Ec3bB94F58FA55D40368271E9e54A');// in the vendored OFAC snapshot
const OK=getAddress('0x00110000000000000000000000000000000000aa');
const mk=()=>{const e=engineFor({ownerRulesDir:mkdtempSync(join(tmpdir(),'sx-'))},{bal:1000000000n},{openSingle:'500000000',openDaily:'900000000',single:'500000000',daily:'900000000',term:'900000000'});
  e.engine.mandates.propose({items:BEGINNER_DEFAULTS.map(d=>({...d}))});for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);return {...e,buy:createBuy(e.engine,{sleep:async()=>{},waitMs:0})};};
test('snapshot is vendored with a date and >100 OFAC ETH addresses',()=>{const s=loadSnapshot();assert.match(s.date,/^\d{4}-\d{2}-\d{2}$/);assert.ok(s.count>=100);assert.ok(s.set.has(SDN.toLowerCase()));});
test('oracle: true blocks, error/timeout never blocks and never unblocks a listed address',async()=>{
  const pub=v=>({readContract:async()=>{if(v instanceof Error)throw v;return v;}});
  assert.equal((await createSanctions({pub:pub(true)}).check(OK)).source,'chainalysis_oracle_base');
  assert.equal(await createSanctions({pub:pub(false)}).check(OK),null);assert.equal(await createSanctions({pub:pub(Error('rpc down'))}).check(OK),null);
  assert.match((await createSanctions({pub:pub(Error('rpc down'))}).check(SDN)).source,/^ofac_sdn_snapshot_/);});
test('AI payment to an SDN address: refused, plain message, nothing paid; even after a Face ID approval attempt',async()=>{const {buy,engine}=mk();
  const r=await buy.buy({item:'x',merchant:'M',to:SDN,amount:'1',idempotencyKey:'idem-sx-0001'},'g');assert.notEqual(r.state,'paid');assert.equal(r.nothingPaid,true);
  assert.match(JSON.stringify(r),/OFAC/);const v=await engine.verifyPayee({address:SDN});assert.equal(v.code,'SANCTIONED_ADDRESS');assert.equal(v.required_action,'refuse');
  for(const p of engine.mandates.proposals())engine.mandates.approve(p.id,()=>true);
  const r2=await buy.buy({item:'x',merchant:'M',to:SDN,amount:'1',idempotencyKey:'idem-sx-0001'},'g');assert.notEqual(r2.state,'paid');});
test('owner direct pay (Face ID) to an SDN address is refused too; normal payee still works',async()=>{const {engine}=mk();
  const r=await engine.pay({agentId:'owner',request:{direct:{chainId:84532,token:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',payee:SDN,amount:'1000000',merchantOrderId:'o:1'}},idempotencyKey:'idem-sx-owner-1'});
  assert.equal(r.reason,'SANCTIONED_ADDRESS');assert.equal(r.nothingPaid,true);
  const ok=await engine.pay({agentId:'owner',request:{direct:{chainId:84532,token:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',payee:OK,amount:'1000000',merchantOrderId:'o:2'}},idempotencyKey:'idem-sx-owner-2'});
  assert.notEqual(ok.reason,'SANCTIONED_ADDRESS');});
test('trust: an SDN payee or signer cannot be put on the trust list',async()=>{const {engine}=mk();
  const r=await engine.trustRequest({merchantId:'shop',payees:[SDN],expiresInDays:30});assert.equal(r.code,'SANCTIONED_ADDRESS');});
test('withdraw: own Base Account allowed unless THAT address is listed',async()=>{
  const mkW=owner=>createOwnerWithdraw({pub:{readContract:async()=>0n,getBalance:async()=>0n},wallet:OK,owner,token:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',chainId:84532,sanctions:createSanctions({})});
  await assert.rejects(mkW(SDN).prepare(),e=>e.code==='SANCTIONED_ADDRESS'&&/OFAC/.test(e.message));
  await assert.rejects(mkW(getAddress('0x00330000000000000000000000000000000000cc')).prepare(),e=>e.code!=='SANCTIONED_ADDRESS');});
