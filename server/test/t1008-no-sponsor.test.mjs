// t1008/t1014/t1022: Kipurse pays nothing at opening; switch defaults off; 'on' refused at boot; no new dues; same-tx repay may use paymaster.
import test from 'node:test';import assert from 'node:assert/strict';
import {createOnboardSponsor,onboardSponsorOn} from '../src/v5/onboard-sponsor.mjs';import {assertPrinciples} from '../src/v5/principles.mjs';
const kv=(()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v)};})();
test('KIPURSE_ONBOARD_SPONSOR defaults off; on is refused at boot',async()=>{
  assert.equal(onboardSponsorOn({}),false);assert.equal(onboardSponsorOn({KIPURSE_ONBOARD_SPONSOR:'off'}),false);
  await assert.rejects(assertPrinciples({env:{KIPURSE_ONBOARD_SPONSOR:'on'}}),/KIPURSE_ONBOARD_SPONSOR/);
  assert.equal(await assertPrinciples({env:{KIPURSE_ONBOARD_SPONSOR:'off'}}),true);});
test('sponsor off: no free first-limits; no new onboarding dues; same-tx repay may use paymaster (t1022); old dues still repayable on withdraw',()=>{
  const s=createOnboardSponsor({cfg:{url:'https://x.invalid/pm',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25},kv,reg:{byOwner:()=>[]},ethUsd8:async()=>0n,lookup:()=>undefined,onboardOn:false,usdcGas:false});
  const o='0x00000000000000000000000000000000000000aa',w='0x00000000000000000000000000000000000000bb';
  assert.equal(s.firstLimitsAvailable(o),false);assert.equal(s.sameTxRepayAvailable(o),true);
  s.addDue(w,50000n,'onboarding_fee');assert.equal(s.dues(w),0n);
  kv.put('dues:'+w,{owed:'50000',paid:'0',items:[]});assert.equal(s.dues(w),50000n);assert.equal(s.payDue(w,50000n),50000n);});
