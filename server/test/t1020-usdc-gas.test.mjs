// Option A (t1020): user pays gas in USDC via the CDP ERC-20 paymaster; Kipurse nets $0; never ETH; fail closed.
import test from 'node:test';import assert from 'node:assert/strict';import {encodeFunctionData,parseAbi} from 'viem';
import {approveCall,depositCall,usdcCallProblem,withErc20Context,tokenPaymentProblem,usdcGasMode,USDC_BASE,CDP_ERC20_PAYMASTER,USDC_GAS_APPROVE_CAP} from '../src/v5/usdc-gas.mjs';
import {createOnboardSponsor} from '../src/v5/onboard-sponsor.mjs';
const W='0x00000000000000000000000000000000000bee01',O='0x00000000000000000000000000000000000000a1';
const A=parseAbi(['function approve(address,uint256) returns (bool)']);
test('switch off by default; on only with erc20_usdc',()=>{assert.equal(usdcGasMode({}),false);assert.equal(usdcGasMode({KIPURSE_GAS_PAYMASTER:'erc20_usdc'}),true);});
test('only approve(CDP paymaster, <=0.25) and transfer(this wallet) are allowed USDC steps',()=>{
  assert.equal(usdcCallProblem(approveCall(),{wallet:W}),null);assert.equal(usdcCallProblem(depositCall(W,1_000_000n),{wallet:W}),null);
  assert.equal(usdcCallProblem({to:USDC_BASE,value:'0x0',data:encodeFunctionData({abi:A,functionName:'approve',args:[O,1n]})},{wallet:W}),'approve');
  assert.equal(usdcCallProblem({to:USDC_BASE,value:'0x0',data:encodeFunctionData({abi:A,functionName:'approve',args:[CDP_ERC20_PAYMASTER,USDC_GAS_APPROVE_CAP+1n]})},{wallet:W}),'approve');
  assert.equal(usdcCallProblem(depositCall(O,5n),{wallet:W}),'transfer');assert.throws(()=>approveCall(USDC_GAS_APPROVE_CAP+1n));});
test('context is forced to USDC; answer must be a USDC token payment within the cap',()=>{
  assert.deepEqual(withErc20Context([{},'0xep','0x2105',{sponsor:true}])[3],{erc20:USDC_BASE.toLowerCase()});
  assert.equal(tokenPaymentProblem({tokenPayment:{address:USDC_BASE,maxFee:'0xa7c8',decimals:6}}),null);
  assert.equal(tokenPaymentProblem({paymasterAndData:'0x'}),'no_token_payment');assert.equal(tokenPaymentProblem({tokenPayment:{address:O,maxFee:'0x1'}}),'not_usdc');
  assert.equal(tokenPaymentProblem({tokenPayment:{address:USDC_BASE,maxFee:'0xF4240'}}),'max_fee');});
test('proxy: forwards with erc20 context, refuses a sponsored (non-USDC) answer, no Kipurse caps or dues',async()=>{
  const m=new Map();const kv={get:k=>m.get(k),put:(k,v)=>m.set(k,v)};let sent=null,answer={tokenPayment:{address:USDC_BASE,maxFee:'0x7530',decimals:6},paymasterAndData:'0x2faeb0'};
  const fetchImpl=async(_u,o)=>{sent=JSON.parse(o.body);return {json:async()=>({jsonrpc:'2.0',id:1,result:answer})};};
  const S=createOnboardSponsor({cfg:{url:'https://x.invalid/pm',maxPerDay:0,maxUsdPerDay:0,maxUsdPerOp:0},kv,reg:{byOwner:()=>[]},ethUsd8:async()=>0n,lookup:()=>undefined,fetchImpl,onboardOn:false,usdcGas:true});
  assert.equal(S.usdcGas,true);assert.equal(S.withdrawAvailable(),true,'no Kipurse day caps: the user pays');
  const calls=[approveCall(),{to:W,value:'0x0',data:'0x1234'}];const id=S.registerUsdcGas('p1',{kind:'withdraw',owner:O,wallet:W,calls});
  const EX=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);
  const callData=encodeFunctionData({abi:EX,functionName:'executeBatch',args:[calls.map(c=>({target:c.to,value:0n,data:c.data}))]});
  const op={sender:O,callData,maxFeePerGas:'0x1'};const body=m=>({jsonrpc:'2.0',id:1,method:m,params:[op,'0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789','0x2105',{}]});
  const r=await S.rpc(id,body('pm_getPaymasterData'));assert.ok(r.result,JSON.stringify(r));assert.deepEqual(sent.params[3],{erc20:USDC_BASE.toLowerCase()});
  answer={paymasterAndData:'0xsponsored'};const r2=await S.rpc(id,body('pm_getPaymasterData'));assert.equal(r2.error?.code,-32004);
  S.addDue(W,50000n,'onboarding_fee');assert.equal(S.dues(W),0n);
  const bad=[{to:USDC_BASE,value:'0x0',data:encodeFunctionData({abi:A,functionName:'approve',args:[O,1n]})}];const id2=S.registerUsdcGas('p2',{kind:'withdraw',owner:O,wallet:W,calls:bad});
  const cd2=encodeFunctionData({abi:EX,functionName:'executeBatch',args:[bad.map(c=>({target:c.to,value:0n,data:c.data}))]});
  const r3=await S.rpc(id2,{jsonrpc:'2.0',id:1,method:'pm_getPaymasterData',params:[{sender:O,callData:cd2,maxFeePerGas:'0x1'},'0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789','0x2105']});assert.match(r3.error?.message??'',/usdc_call/);});
