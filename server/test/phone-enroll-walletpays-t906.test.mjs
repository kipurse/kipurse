// t906: enrollment fee from the Kipurse wallet; Base Account only signs (sponsor fronts gas, the same batch repays the fee address).
import test from 'node:test';import assert from 'node:assert/strict';import {decodeFunctionData,parseAbi,getAddress} from 'viem';
import {createPhoneEnrollment} from '../src/v5/phone-signer.mjs';
import {createOnboardSponsor,callsHash,ENROLL_PREFIX} from '../src/v5/onboard-sponsor.mjs';
const W='0x5e4c116dd45edc2dbed826be8b97a72499d03fc8',O='0x1da2d5293bd418ab06d16890f17711302c7e74f6',FEE='0xf14ef5dc4723245866c22c749a0a84afceba0dd9';
const X='0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',Y='0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';   // P-256 generator (valid point)
const A=parseAbi(['function execute(address,uint256,bytes)','function transfer(address,uint256) returns (bool)']);
const mkPub=(wal,own)=>({readContract:async({functionName,args})=>functionName==='balanceOf'?(String(args[0]).toLowerCase()===W.toLowerCase()?wal:own):functionName==='latestRoundData'?[0n,300000000000n,0n,BigInt(Math.floor(Date.now()/1e3)),0n]:functionName==='nextOwnerIndex'?0n:false,
  getBalance:async()=>0n,getGasPrice:async()=>6000000n,getCode:async()=>'0x'});
const kvMap=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v)};};
function mk({sponsorOn=true,wal=14304957n,own=0n}={}){const kv=kvMap();
  const sp=createOnboardSponsor({cfg:sponsorOn?{url:'https://pm.example',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25}:{url:null},kv,reg:{byOwner:()=>[]},ethUsd8:async()=>300000000000n,lookup:()=>null,gasPrice:async()=>6000000n});
  const S={phone:{pending:{},active:null}};
  const E=createPhoneEnrollment({S,save:()=>{},pub:mkPub(wal,own),wallet:W,trust:'0x6b91dcb27cf3d69b1d9a6fddeb06ed1af2ed0bf9',owner:O,chainId:8453,base:()=>'https://pay.kipurse.com',caps:()=>({single:0n,daily:0n}),script:()=>'',approverVersion:'v3',
    feeTo:FEE,sponsor:{available:()=>sp.withdrawAvailable(),register:async(id,a)=>{const s=sp.registerEnroll(id,a);return s?'https://pay.kipurse.com/onboard/new/paymaster?id='+s:null;}}});
  return {E,sp,S,kv};}
const feeCall=calls=>{const c=calls[calls.length-1];const o=decodeFunctionData({abi:A,data:c.data});const t=decodeFunctionData({abi:A,data:o.args[2]});return {to:getAddress(t.args[0]),n:t.args[1]};};
const page=async(E,id)=>{let b='';await E.handle({method:'GET',headers:{}},{writeHead(){},end(x){b=x;}},new URL('https://pay.kipurse.com/phone/enroll?id='+id+'&lang=zh'),{readBody:async()=>({})});return b;};
test('sponsor on: fee goes to the fixed fee address from the WALLET, page shows 确认 with Base Account at 0 USDC',{skip:'OSS copy: frozen vector/fixture tied to operator addresses or the operator App Attest fixture; regenerate with your own values'},async()=>{const {E}=mk();
  const r=await E.enroll({x:X,y:Y});assert.equal(r.walletPays,true);assert.equal(getAddress(r.feeTo),FEE);
  const f=feeCall(r.calls);assert.equal(f.to,FEE,'repay the sponsor, not the owner');assert.ok(f.n>0n&&f.n<=50000n);
  const q=await E.quote(r.id);assert.equal(q.usdcReady,true);assert.equal(q.walletPays,true);
  const h=await page(E,r.id);assert.match(h,/<button id=go>确认<\/button>/);assert.match(h,/"paymaster":"https:\/\/pay.kipurse.com\/onboard\/new\/paymaster\?id=pe-/);assert.doesNotMatch(h,/id=need/);});
test('sponsor gate accepts exactly that batch from the owner, refuses a changed one, never raises caps',async()=>{const {E,sp}=mk();const r=await E.enroll({x:X,y:Y});const sid=ENROLL_PREFIX+r.id;
  const {encodeFunctionData}=await import('viem');const EX=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[])']);
  const cd=cs=>encodeFunctionData({abi:EX,functionName:'executeBatch',args:[cs.map(c=>({target:c.to,value:0n,data:c.data}))]});
  const op=(cs,sender=O)=>({sender,callData:cd(cs),callGasLimit:'0x1e8480',verificationGasLimit:'0x30000',preVerificationGas:'0x20000',maxFeePerGas:'0x5b8d80'});
  assert.equal(await sp.gate(sid,'pm_getPaymasterStubData',[op(r.calls),'0x0000000071727De22E5E9d8BAf0edAc6f37da032','0x2105']),null);
  assert.equal(await sp.gate(sid,'pm_getPaymasterData',[op(r.calls),'0x0000000071727De22E5E9d8BAf0edAc6f37da032','0x2105']),null);
  const bad=r.calls.slice(0,-1);assert.equal(await sp.gate(sid,'pm_getPaymasterStubData',[op(bad),'0x0000000071727De22E5E9d8BAf0edAc6f37da032','0x2105']),'calls_mismatch');
  assert.equal(await sp.gate(sid,'pm_getPaymasterStubData',[op(r.calls,W),'0x0000000071727De22E5E9d8BAf0edAc6f37da032','0x2105']),'sender');});
test('sponsor off: old path unchanged (refund to the Base Account), page explains instead of a dead end',async()=>{const {E}=mk({sponsorOn:false});const r=await E.enroll({x:X,y:Y});
  assert.equal(r.walletPays,false);assert.equal(feeCall(r.calls).to,getAddress(O));const h=await page(E,r.id);assert.match(h,/id=need/);});
test('wallet too low: 先充值 even when sponsored',async()=>{const {E}=mk({wal:1000n});const r=await E.enroll({x:X,y:Y});const h=await page(E,r.id);assert.match(h,/先充值/);assert.doesNotMatch(h,/id=go/);});
