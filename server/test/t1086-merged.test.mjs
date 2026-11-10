// t1086 on the production opening path: one user-USDC quote includes the first phone key.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {encodeFunctionData,getAddress,decodeFunctionData,parseAbi} from 'viem';
import * as P256 from 'ox/P256';
import {toHex} from 'viem';
import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';
import {createPhoneEnrollment,DETERMINISTIC_DEPLOYER,WALLET_ABI,ETH_USD_FEED,approverInit,ANDROID_DEVICE_KEY,upgradeFeeUSDC} from '../src/v5/phone-signer.mjs';
import {openingFeeUSDC,OPENING_GAS,OPENING_WITH_FIRST_KEY_GAS,FIRST_KEY_GAS,feeRepayCall} from '../src/v5/usdc-gas.mjs';
import {checkLimits} from '../src/v5/limits-public.mjs';
import {kvKey} from '../src/v5/store.mjs';

const X='0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
const Y='0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
const OWNER='0x1111111111111111111111111111111111111111';
const W='0x2222222222222222222222222222222222222222';
const TRUST='0x5555555555555555555555555555555555555555';
const TOKEN='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ADAPTER='0x4444444444444444444444444444444444444444';
const MANAGER='0x7777777777777777777777777777777777777777';
const EXEC='0x8888888888888888888888888888888888888888';
const VAULT='0x3333333333333333333333333333333333333333';
const FEES='0x9999999999999999999999999999999999999999';
const GP=6_000_000n, ETH=2_500_00000000n;
const other=()=>{const pk=P256.randomPrivateKey();const p=P256.getPublicKey({privateKey:pk});return {x:toHex(p.x,{size:32}),y:toHex(p.y,{size:32})};};
const USDC=parseAbi(['function transfer(address,uint256) returns (bool)']);

function world({usdc=10_000_000n,owned=false}={}){
  const mem=new Map();const kv={get:k=>mem.get(k),put:(k,v)=>mem.set(k,v)};
  const noted=[];
  const pub={getCode:async()=>'0x',getBlock:async()=>({timestamp:1_700_000_000n}),getBlockNumber:async()=>1n,getGasPrice:async()=>GP,getBalance:async()=>0n,
    readContract:async({functionName,args})=>{
      if(functionName==='getAddress')return W;if(functionName==='vaultAddress')return VAULT;if(functionName==='fees')return FEES;
      if(functionName==='feePpm')return 0n;if(functionName==='latestRoundData')return [0n,ETH,0n,BigInt(Math.floor(Date.now()/1000)),0n];
      if(functionName==='balanceOf')return usdc;
      if(functionName==='isOwnerAddress')return owned&&args&&getAddress(args[0])===getAddress(approverInit({wallet:W,trust:TRUST,x:X,y:Y,maxSingle:2_000_000n,maxDaily:5_000_000n,version:'v2'}).address);
      if(functionName==='nextOwnerIndex')return 0n;return false;}};
  const policy=()=>({executor:EXEC,guardian:'0x0000000000000000000000000000000000000000',registry:'0x0000000000000000000000000000000000000000',maxFeePpm:'3000',maxNetworkFee:'50000',openSingle:'1000000',openDaily:'1000000',verifiedSingle:'1000000',verifiedDaily:'1000000'});
  const cfg={adapter:ADAPTER,trust:TRUST,token:TOKEN,manager:MANAGER,approverVersion:'v2'};
  const N=createNewWalletOnboarding({enabled:true,kv,pub,cfg,policy,reg:{byOwner:()=>[]},base:()=>'https://x',script:()=>'',sponsor:null,verified:async()=>({verified:true}),noteFirstKey:k=>noted.push(k),quote:async()=>({feeUSDC:'0.03',sponsoredByKipurse:false})});
  const S={phone:{pending:{},active:null}};
  const phone=createPhoneEnrollment({S,save:()=>{},pub,wallet:W,trust:TRUST,owner:OWNER,token:TOKEN,base:()=>'https://x',caps:()=>({single:2_000_000n,daily:5_000_000n}),script:()=>'',approverVersion:'v2'});
  return {kv,N,S,phone,noted};
}

test('production feed stays the t1026 Chainlink address',()=>{
  assert.equal(ETH_USD_FEED,'0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70');
  assert.equal(ANDROID_DEVICE_KEY,'todo');
});

test('opening batch contains the approver and the one quote includes that gas',async()=>{
  const {N,noted}=world();
  const st=await N.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:OWNER});
  const pr=await N.prepare(st.id,OWNER);
  assert.equal(pr.paymaster??null,null);
  assert.ok(pr.calls.some(c=>getAddress(c.to)===getAddress(DETERMINISTIC_DEPLOYER)));
  const caps=checkLimits({single:'2',daily:'5',term:'30',days:90});
  const approver=approverInit({wallet:pr.wallet,trust:TRUST,x:X,y:Y,maxSingle:caps.single,maxDaily:caps.daily,version:'v2'});
  const add=encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[approver.address]}).toLowerCase();
  assert.ok(pr.calls.some(c=>String(c.data).toLowerCase()===add));
  const one=openingFeeUSDC({gasPriceWei:GP,ethUsd8:ETH,gas:OPENING_WITH_FIRST_KEY_GAS});
  const bare=openingFeeUSDC({gasPriceWei:GP,ethUsd8:ETH,gas:OPENING_GAS});
  assert.equal(OPENING_WITH_FIRST_KEY_GAS,OPENING_GAS+FIRST_KEY_GAS);
  assert.ok(one.fee>bare.fee,'the single quote is larger than opening without the key');
  assert.ok(one.fee<one.fee+upgradeFeeUSDC({gasPriceWei:GP,ethUsd8:ETH}).fee);
  const repay=pr.calls.find(c=>String(c.data).toLowerCase()===feeRepayCall(one.fee).data.toLowerCase());
  assert.ok(repay,'fee transfer matches the combined quote');
  const decoded=decodeFunctionData({abi:USDC,data:repay.data});
  assert.equal(decoded.args[1],one.fee);
  assert.equal(noted.length,1);assert.equal(noted[0].approver.toLowerCase(),approver.address.toLowerCase());
});

test('the first key is not charged again; a new phone still is',async()=>{
  const {S,phone}=world();
  phone.addPending({x:X,y:Y,approver:approverInit({wallet:W,trust:TRUST,x:X,y:Y,maxSingle:1n,maxDaily:1n,version:'v2'}).address,maxSingle:'1',maxDaily:'1',version:'v2'});
  const again=await phone.enroll({x:X,y:Y});
  assert.equal(again.already,true);assert.equal(again.fee,'0');assert.deepEqual(again.calls,[]);
  assert.equal(Object.values(S.phone.pending).filter(p=>String(p.fee)!=='0').length,0);
  const second=await phone.enroll(other());
  assert.notEqual(second.already,true);assert.ok(BigInt(second.fee)>0n);
  assert.ok(second.calls.some(c=>getAddress(c.to)===getAddress(DETERMINISTIC_DEPLOYER)));
});

test('a key already on chain is not charged again',async()=>{
  const {phone}=world({owned:true});
  const r=await phone.enroll({x:X,y:Y});
  assert.equal(r.fee,'0');assert.equal(r.already,true);assert.deepEqual(r.calls,[]);
});

test('insufficient USDC refuses and stores no calls',async()=>{
  const {kv,N}=world({usdc:0n});
  const st=await N.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:OWNER});
  await assert.rejects(()=>N.prepare(st.id,OWNER),e=>e.code==='needs_usdc'&&/没有扣钱/.test(e.message));
  assert.equal(kv.get(kvKey('onbnew',null,st.id)).state,'start');
});

test('launch wiring is only the named hooks, on the production usdcGas file',()=>{
  const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/spendAuthorization:/);assert.match(s,/commitSpend:/);assert.match(s,/reserveOAuthAgent/);
  assert.match(s,/includesPhoneApprover:true/);assert.match(s,/OPENING_WITH_FIRST_KEY_GAS/);
  assert.match(s,/usdcGas/);assert.match(s,/connected:!!S\.phone\?\.active&&spendOk/);
  assert.doesNotMatch(s,/0xc0dedd749573f2e967a4ba53190c27ffbc2f8b31/);
  const ob=fs.readFileSync(new URL('../src/v5/onboard-new.mjs',import.meta.url),'utf8');
  assert.match(ob,/openingFeeUSDC/);assert.match(ob,/needs_usdc/);assert.doesNotMatch(ob,/先垫付/);
});
