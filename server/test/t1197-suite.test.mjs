// t1197u (handbook §6#92): new wallets on V5.3; 0x5150 and every wallet registered before stay on V5.2. Guard tests - never delete.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {getAddress} from 'viem';
const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
const S=JSON.parse(fs.readFileSync(new URL('../mainnet/v53-suite.json',import.meta.url),'utf8'));
const P=JSON.parse(fs.readFileSync(new URL('../mainnet/v53-deploy-plan.json',import.meta.url),'utf8'));
test('v53-suite.json = the deployed V5.3 suite (same factory/adapter as the owner-signed deploy plan)',()=>{
  assert.equal(getAddress(S.factory),getAddress(P.factory));assert.equal(getAddress(S.adapter),getAddress(P.adapter));
  assert.equal(getAddress(S.trust),'0xDa1dCc6677f352bA551fEb8ca0f39d46B41535c3');assert.equal(getAddress(S.vaultImpl),'0x0Bf04254cF9A16C83c10159a79E2420528608cDa');});
test('a tenant record without suite (0x5150, older wallets) is V5.2 = the config adapter/trust, exactly as before',()=>{
  const m=L.match(/const suiteOf=rec=>(.*?);\n/);assert.ok(m);const suiteOf=eval('(X=>rec=>'+m[1]+')');
  const X={adapter:'0x05320BeD08309F66316F7d73e2D0be110400FbB2',trust:'0x65D2cE04DA7aCe81e7C4ab08712509282745eC84'};const f=suiteOf(X);
  assert.deepEqual(f({wallet:'0x515010c2e41F98CdDd76B819EE69DC832c0939B6'}),{name:'v5.2',...X});assert.deepEqual(f(null),{name:'v5.2',...X});
  assert.deepEqual(f({suite:'v5.3'}),{name:'v5.2',...X},'v5.3 needs its own adapter + trust in the record');
  assert.deepEqual(f({suite:'v5.3',adapter:S.adapter,trust:S.trust}),{name:'v5.3',adapter:getAddress(S.adapter),trust:getAddress(S.trust)});});
test('V5.2 tenants get the identical engine config; only V5.3 records override adapter/trust',()=>{
  assert.ok(L.includes("const cfg={...X.engine,...(SU.name==='v5.3'?{adapter:SU.adapter,trust:SU.trust}:{}),...overrides,"));
  const body=L.slice(L.indexOf('async function buildTenant(rec)'),L.indexOf('// ---- global (tenant-less) surface'));
  assert.ok(!/X\.(adapter|trust)\b/.test(body),'inside a tenant every adapter/trust comes from its suite');});
test('new wallets: V5.3 only after the adapter is verified on chain (code + trust + factory), recorded in the registry',()=>{
  assert.ok(L.includes("cfg:{adapter:NS.adapter,trust:NS.trust,"));
  assert.ok(L.includes("...(NS.name==='v5.3'?{suite:'v5.3',adapter:NS.adapter,trust:NS.trust}:{})"));
  assert.ok(/getAddress\(t\)===T&&getAddress\(f\)===Fa/.test(L));assert.ok(L.includes("reason:'v53_not_verified'"));});
test('no gas paymaster switch, fee model untouched',()=>{assert.ok(!/(ENV|process\.env)\.KIPURSE_GAS_PAYMASTER|\['KIPURSE_GAS_PAYMASTER'\]/.test(L));});
