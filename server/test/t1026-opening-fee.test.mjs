import test from 'node:test';import assert from 'node:assert/strict';
import {openingFeeUSDC,fmtOpeningFeeUSDC,openingFeeNote,feeRepayCall,OPENING_FEE_CAP_USDC,OPENING_FEE_BUFFER_BPS,OPENING_GAS} from '../src/v5/usdc-gas.mjs';
test('t1026u: opening fee = gas*price+L1 → USDC +20% buffer, hard-capped, never fixed 0.05',()=>{
  // 0.006 gwei (=6e6 wei), ETH=$2500 → wei = 2.3e6 * 6e6 + 1e12 = 1.38e13 + 1e12 = 1.48e13
  // usdc raw = ceil(1.48e13 * 2500e8 / 1e20) = ceil(3.7e24 / 1e20) = ceil(37000) = 37000 (=0.037 USDC)
  // +20% = 44400 (=0.0444)
  const r=openingFeeUSDC({gasPriceWei:6_000_000n,ethUsd8:2500_00000000n});
  assert.equal(r.raw,37_000n);assert.equal(r.fee,44_400n);assert.equal(r.capped,false);
  assert.equal(fmtOpeningFeeUSDC(r.fee),'0.0444');
  const note=openingFeeNote(r.fee);
  assert.match(note.zh,/0\.0444 USDC/);assert.match(note.zh,/实时报价/);assert.match(note.zh,/不出这笔钱/);
  assert.doesNotMatch(note.zh,/免费|垫付|赞助|0\.05/);
  // hard cap: huge gas price → fee == cap
  const hi=openingFeeUSDC({gasPriceWei:10n**12n,ethUsd8:10_000_00000000n});
  assert.equal(hi.fee,OPENING_FEE_CAP_USDC);assert.equal(hi.capped,true);
  // feeRepayCall requires explicit fee
  assert.equal(feeRepayCall(r.fee).to.toLowerCase(),'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  assert.throws(()=>feeRepayCall());assert.throws(()=>feeRepayCall(0n));assert.throws(()=>feeRepayCall(OPENING_FEE_CAP_USDC+1n));
  assert.equal(OPENING_FEE_BUFFER_BPS,2000n);assert.equal(OPENING_GAS,2_300_000n);
});
