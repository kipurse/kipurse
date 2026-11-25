// t1022: Kipurse paymaster + same-tx USDC fee repay; refuse at zero balance; no dues; erc20_usdc stays off.
import test from 'node:test';import assert from 'node:assert/strict';
import {feeRepayCall,depositCall,usdcCallProblem,usdcGasMode,OPENING_FEE_USDC,KIPURSE_FEE_TO,USDC_BASE} from '../src/v5/usdc-gas.mjs';
import {createOnboardSponsor} from '../src/v5/onboard-sponsor.mjs';
test('erc20_usdc switch stays off by default',()=>assert.equal(usdcGasMode({}),false));
test('fee repay call is allowed USDC step; other recipients refused',()=>{
  assert.equal(usdcCallProblem(feeRepayCall(50_000n),{wallet:'0x00000000000000000000000000000000000bee01'}),null);
  assert.equal(usdcCallProblem(depositCall('0x00000000000000000000000000000000000bee01',1n),{wallet:'0x00000000000000000000000000000000000bee01'}),null);
  assert.ok(usdcCallProblem({to:USDC_BASE,value:'0x0',data:feeRepayCall(1n).data},{wallet:'0x00000000000000000000000000000000000bee01'})===null);
});
test('sameTxRepayAvailable works with onboardOn=off; markDone with feeRepay adds no dues',()=>{
  const m=new Map();const kv={get:k=>m.get(k),put:(k,v)=>m.set(k,v)};
  const id='abc';const lookup=i=>i===id?{feeRepay:String(OPENING_FEE_USDC)}:undefined;
  const S=createOnboardSponsor({cfg:{url:'https://x.invalid/pm',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25},kv,reg:{byOwner:()=>[]},ethUsd8:async()=>0n,lookup,onboardOn:false,usdcGas:false});
  const o='0x00000000000000000000000000000000000000aa',w='0x00000000000000000000000000000000000000bb';
  assert.equal(S.sameTxRepayAvailable(o),true);assert.equal(S.available(o),true);
  kv.put('sponsor:op:'+id,{usd:0.03});kv.put('sponsor:owner:'+o,{state:'reserved',id,at:Date.now()});
  S.markDone(id,o,w);assert.equal(S.dues(w),0n,'no dues when feeRepay present');
});
