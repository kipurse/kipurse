// t1086: the first phone key is inside the one user-funded opening batch. That key is not charged again.
import test from 'node:test';import assert from 'node:assert/strict';
import {encodeFunctionData,getAddress} from 'viem';
import * as P256 from 'ox/P256';
import {toHex} from 'viem';
import {createOnboarding,ONBOARD_GAS,onboardFee} from '../src/v5/onboard.mjs';
import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';
import {createPhoneEnrollment,DETERMINISTIC_DEPLOYER,WALLET_ABI,upgradeFeeUSDC,approverInit,ANDROID_DEVICE_KEY} from '../src/v5/phone-signer.mjs';
import {checkLimits} from '../src/v5/limits-public.mjs';
import {kvKey} from '../src/v5/store.mjs';

const X='0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
const Y='0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
const OWNER='0x1111111111111111111111111111111111111111';
const W='0x2222222222222222222222222222222222222222';
const TRUST='0x5555555555555555555555555555555555555555';
const TOKEN='0x6666666666666666666666666666666666666666';
const ADAPTER='0x4444444444444444444444444444444444444444';
const MANAGER='0x7777777777777777777777777777777777777777';
const EXEC='0x8888888888888888888888888888888888888888';
const VAULT='0x3333333333333333333333333333333333333333';
const FEES='0x9999999999999999999999999999999999999999';
const GP=1_000_000n,ETH=3_000_00000000n;
const otherKey=()=>{const pk=P256.randomPrivateKey();const p=P256.getPublicKey({privateKey:pk});return {x:toHex(p.x,{size:32}),y:toHex(p.y,{size:32})};};

function opening({usdc=10_000_000n,owned=false}={}){
  const S={phone:{pending:{},active:null}};
  const pub={getGasPrice:async()=>GP,getBalance:async()=>0n,getCode:async()=>'0x',
    readContract:async({functionName,args})=>{
      if(functionName==='latestRoundData')return [0n,ETH,0n,BigInt(Math.floor(Date.now()/1000)),0n];
      if(functionName==='balanceOf')return usdc;
      if(functionName==='isOwnerAddress')return owned&&args&&getAddress(args[0])===getAddress(approverInit({wallet:W,trust:TRUST,x:X,y:Y,maxSingle:2_000_000n,maxDaily:5_000_000n,version:'v2'}).address);
      return false;}};
  const phone=createPhoneEnrollment({S,save:()=>{},pub,wallet:W,trust:TRUST,owner:OWNER,token:TOKEN,base:()=>'https://pay.example',caps:()=>({single:2_000_000n,daily:5_000_000n}),script:()=>'',approverVersion:'v2'});
  const onb=createOnboarding({S,save:()=>{},pub,wallet:W,owner:OWNER,trust:TRUST,token:TOKEN,base:()=>'https://pay.example',enabled:true,phone,script:()=>'',
    plan:async()=>({walletExecuteBatch:{data:'0xabcdef'},calls:[]})});
  return {S,phone,onb};
}

test('opening batch contains the first approver deploy and addOwnerAddress',async()=>{
  const {onb}=opening();
  const r=await onb.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90});
  assert.ok(r.calls.some(c=>getAddress(c.to)===getAddress(DETERMINISTIC_DEPLOYER)&&String(c.data).length>66),'deploy');
  const add=encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[r.approver]}).toLowerCase();
  assert.ok(r.calls.some(c=>String(c.data).toLowerCase()===add),'addOwnerAddress');
  assert.equal(r.calls.length,3);
});

test('one opening quote includes the phone-key gas and is not a second enrollment fee',async()=>{
  const {onb}=opening();
  const r=await onb.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90});
  const one=onboardFee({gas:ONBOARD_GAS,gasPriceWei:GP,ethUsd8:ETH});
  const later=upgradeFeeUSDC({gasPriceWei:GP,ethUsd8:ETH});
  assert.equal(r.quote.gas,ONBOARD_GAS.toString());
  assert.equal(r.quote.includesPhoneApprover,true);
  assert.equal(r.quote.sponsoredByKipurse,false);
  assert.equal(BigInt(r.quote.feeWei),one.wei);
  assert.ok(later.fee>0n);
  assert.ok(one.usdc+later.fee>one.usdc);
  assert.equal(BigInt(r.quote.feeWei),one.wei,'one quote, not opening plus a second enrollment fee');
});

test('the first key is not charged again; a different phone still is',async()=>{
  const {S,phone}=opening();
  phone.addPending({x:X,y:Y,approver:approverInit({wallet:W,trust:TRUST,x:X,y:Y,maxSingle:1n,maxDaily:1n}).address,maxSingle:'1',maxDaily:'1',version:'v2'});
  const again=await phone.enroll({x:X,y:Y});
  assert.equal(again.already,true);assert.equal(again.fee,'0');assert.deepEqual(again.calls,[]);
  assert.equal(Object.values(S.phone.pending).filter(p=>String(p.fee)!=='0').length,0);
  const k=otherKey();const second=await phone.enroll(k);
  assert.notEqual(second.already,true);assert.ok(BigInt(second.fee)>0n);assert.ok(second.calls.length>=3);
  assert.ok(second.calls.some(c=>getAddress(c.to)===getAddress(DETERMINISTIC_DEPLOYER)));
});

test('a key already on chain from opening is not charged again',async()=>{
  const {phone}=opening({owned:true});
  const r=await phone.enroll({x:X,y:Y});
  assert.equal(r.already,true);assert.equal(r.fee,'0');assert.deepEqual(r.calls,[]);
});

test('insufficient USDC refuses the opening batch and charges nothing',async()=>{
  const {S,onb}=opening({usdc:0n});
  await assert.rejects(()=>onb.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90}),e=>e.code==='needs_usdc'&&/USDC/.test(e.message)&&/没有扣钱/.test(e.message));
  assert.equal(Object.keys(S.onboard??{}).length,0);
  assert.equal(Object.keys(S.phone.pending).length,0);
});

test('new-wallet prepare refuses when the single quote says USDC is short, and a funded prepare includes the approver',async()=>{
  const mem=new Map();const kv={get:k=>mem.get(k),put:(k,v)=>mem.set(k,v)};
  const pub={getCode:async()=>'0x',getBlock:async()=>({timestamp:1_700_000_000n}),getBlockNumber:async()=>1n,
    readContract:async({functionName})=>{
      if(functionName==='getAddress')return W;if(functionName==='vaultAddress')return VAULT;if(functionName==='fees')return FEES;
      if(functionName==='feePpm')return 0n;if(functionName==='isOwnerAddress')return false;throw Error(functionName);}};
  const policy=()=>({executor:EXEC,guardian:'0x0000000000000000000000000000000000000000',registry:'0x0000000000000000000000000000000000000000',maxFeePpm:'3000',maxNetworkFee:'50000',openSingle:'1000000',openDaily:'1000000',verifiedSingle:'1000000',verifiedDaily:'1000000'});
  const cfg={adapter:ADAPTER,trust:TRUST,token:TOKEN,manager:MANAGER,approverVersion:'v2'};
  const poor=createNewWalletOnboarding({enabled:true,kv,pub,cfg,policy,reg:{byOwner:()=>[]},base:()=>'https://x',script:()=>'',sponsor:null,verified:async()=>({verified:true}),quote:async()=>({payerCanPayUSDC:false,includesPhoneApprover:true,feeUSDC:'0.03',sponsoredByKipurse:false})});
  const started=await poor.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:OWNER});
  await assert.rejects(()=>poor.prepare(started.id,OWNER),e=>e.code==='needs_usdc');
  assert.equal(kv.get(kvKey('onbnew',null,started.id)).state,'start');
  const rich=createNewWalletOnboarding({enabled:true,kv,pub,cfg,policy,reg:{byOwner:()=>[]},base:()=>'https://x',script:()=>'',sponsor:null,verified:async()=>({verified:true}),quote:async()=>({payerCanPayUSDC:true,includesPhoneApprover:true,feeUSDC:'0.03',sponsoredByKipurse:false,gas:ONBOARD_GAS.toString()})});
  const st=await rich.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:OWNER});
  const pr=await rich.prepare(st.id,OWNER);
  assert.equal(pr.paymaster??null,null);
  assert.ok(pr.calls.some(c=>getAddress(c.to)===getAddress(DETERMINISTIC_DEPLOYER)));
  const caps=checkLimits({single:'2',daily:'5',term:'30',days:90});
  const approver=approverInit({wallet:pr.wallet,trust:TRUST,x:X,y:Y,maxSingle:caps.single,maxDaily:caps.daily,version:'v2'});
  const add=encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[approver.address]}).toLowerCase();
  assert.ok(pr.calls.some(c=>String(c.data).toLowerCase()===add));
  assert.equal(ANDROID_DEVICE_KEY,'todo');
});
