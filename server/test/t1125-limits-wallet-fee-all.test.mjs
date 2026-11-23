import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {limitsWalletFeeForAll,walletPaysLimits} from '../src/v5/limits-fee.mjs';
const W='0x5150000000000000000000000000000000000001',O='0x1111111111111111111111111111111111111111';
test('t1125u: every wallet uses the wallet-fee batch, allowlist or not',()=>{
  assert.equal(walletPaysLimits(O,{}),false);assert.equal(limitsWalletFeeForAll(O),true);assert.equal(limitsWalletFeeForAll(W),true);
  assert.equal(limitsWalletFeeForAll(''),false);assert.equal(limitsWalletFeeForAll(null),false);assert.equal(limitsWalletFeeForAll('0xzz'),false);});
test('t1125u: mainnet launcher no longer gates the limits path on the allowlist',()=>{
  const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/const limitsDirect=\(\)=>LFEE\.limitsWalletFeeForAll\(R\.wallet\);/);assert.doesNotMatch(s,/limitsDirect=\(\)=>LFEE\.walletPaysLimits/);
  assert.match(s,/\?v:OP\.feeTo\)/);});   // t1270: the official fee address comes from operatorConstants (operator config)
