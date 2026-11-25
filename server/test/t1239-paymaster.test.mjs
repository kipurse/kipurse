// t1239 (decision 109): the Base default paymaster must be Circle's USDC paymaster for EntryPoint v0.7 that every Kipurse vault allowlists
// on chain (0x6C97…). The old built-in 0xc0de9762… has no code on Base: every AI payment / trust signed on the server failed with AA30.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {getAddress} from 'viem';
import {CIRCLE_PAYMASTER,ENTRYPOINT_V07} from '../src/v5/userop.mjs';import {BASE} from '../mainnet/v53-deploy.mjs';
test('Base default paymaster = the one the vaults allowlist (V5.3 / V5.4 deploy plans), for EntryPoint v0.7',()=>{
  assert.equal(getAddress(CIRCLE_PAYMASTER[8453].v07),getAddress(BASE.paymaster));assert.equal(getAddress(BASE.entryPoint),getAddress(ENTRYPOINT_V07));
  assert.notEqual(getAddress(CIRCLE_PAYMASTER[8453].v07),getAddress('0xc0de9762a5f06d7f98293b77d74230c750cba078'));});
test('launcher: unprefixed requests follow a moved (retired) legacy wallet; push registration follows a move',()=>{
  const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/createAgentRouter\(\{reg:REG,index:IDX,kv:KV,obs:OBS,tenants:CACHE,legacy:legacyRoute,/);
  assert.match(s,/const legacyRoute=\(\)=>followMoved\(legacy\(\),a=>REG\.get\(a\)\)/);   // t1251 decision 120: every hop, not just one (see t1251-follow-moved)
  assert.match(s,/copyPush\(W0,NW\);REG\.update\(W0,\{retired:true,movedTo:NW\}\)/);assert.match(s,/if\(r0\?\.retired&&r0\.movedTo\)copyPush\(legacy\(\),r0\.movedTo\)/);});
