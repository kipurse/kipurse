import test from 'node:test';import assert from 'node:assert/strict';
import {createOnboardSponsor,ONBOARD_FEE_USDC} from '../src/v5/onboard-sponsor.mjs';import {duesAmount} from '../src/v5/userop.mjs';import {DUES_SLOT,DUES_SLOT_NOTE} from '../src/v5/onboard-new.mjs';
const mkKv=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v),del:k=>m.delete(k)};};
test('t852: fixed 0.05 USDC opening fee, same for every user, owed once and taken whole in ONE op',()=>{
  const kv=mkKv();const S=createOnboardSponsor({cfg:{url:'https://x.invalid',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25},kv,reg:{byOwner:()=>[]},ethUsd8:async()=>224475500000n});
  for(const [i,usd] of [[1,0.0123],[2,0.2]].entries()){const id='on'+i,o='0x'+String(i+1).repeat(40),w='0x'+String(i+5).repeat(40);
    kv.put('sponsor:op:'+id,{usd:usd[1]});kv.put('sponsor:owner:'+o,{state:'reserved',id,at:Date.now()});S.markDone(id,o,w);assert.equal(S.dues(w),ONBOARD_FEE_USDC,'same fee whatever the gas was');
    S.markDone(id,o,w);assert.equal(S.dues(w),ONBOARD_FEE_USDC,'never owed twice');}
  assert.equal(ONBOARD_FEE_USDC,DUES_SLOT.maxPerOp,'fits the on-chain per-op fee slot');
  const w='0x'+'6'.repeat(40);const take=duesAmount({due:S.dues(w),feeTo:DUES_SLOT.to,opsTo:DUES_SLOT.to,maxFee:DUES_SLOT.maxPerOp,netCap:250000n,balance:10_000_000n,reserved:0n,gasKeep:250000n});
  assert.equal(take,50_000n,'whole fee in the first AI payment');S.payDue(w,take);assert.equal(S.dues(w),0n,'nothing more ever');
  assert.match(DUES_SLOT_NOTE.zh,/实时报价/);assert.match(DUES_SLOT_NOTE.zh,/不出这笔钱/);assert.doesNotMatch(DUES_SLOT_NOTE.zh,/每笔最多|扣完为止|ETH|免费|垫付|赞助/);});

import {ONBOARD_FEE_WAIVED, onboardFeeWaived} from '../src/v5/onboard-sponsor.mjs';
test('t854: existing user 0xdEaD is waived (recorded), new wallets are not', () => {
  assert.equal(ONBOARD_FEE_WAIVED['0x000000000000000000000000000000000000dead'], 'waived-t854');
  assert.ok(onboardFeeWaived('0x000000000000000000000000000000000000dEaD'));
  assert.ok(!onboardFeeWaived('0x1111111111111111111111111111111111111111'));
});
