// t910 (based on t906 setup): enrollment fee from the Kipurse wallet; Base Account only signs (sponsor fronts gas, the same batch repays the fee address).
import test from 'node:test';import assert from 'node:assert/strict';import {decodeFunctionData,parseAbi,getAddress} from 'viem';
import {createPhoneEnrollment} from '../src/v5/phone-signer.mjs';
import {createOnboardSponsor,callsHash,ENROLL_PREFIX} from '../src/v5/onboard-sponsor.mjs';
const W='0x5e4c116dd45edc2dbed826be8b97a72499d03fc8',O='0x1da2d5293bd418ab06d16890f17711302c7e74f6',FEE='0xf14ef5dc4723245866c22c749a0a84afceba0dd9';
const X='0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',Y='0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';   // P-256 generator (valid point)
const A=parseAbi(['function execute(address,uint256,bytes)','function transfer(address,uint256) returns (bool)']);
const mkPub=(wal,own)=>({readContract:async({functionName,args})=>functionName==='balanceOf'?(String(args[0]).toLowerCase()===W.toLowerCase()?wal:own):functionName==='latestRoundData'?[0n,300000000000n,0n,BigInt(Math.floor(Date.now()/1e3)),0n]:functionName==='nextOwnerIndex'?0n:false,
  getBalance:async()=>0n,getGasPrice:async()=>6000000n,getCode:async()=>'0x'});
const kvMap=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v)};};
function mk({sponsorOn=true,wal=14304957n,own=0n,fetchImpl}={}){const kv=kvMap();
  const sp=createOnboardSponsor({cfg:sponsorOn?{url:'https://pm.example',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25}:{url:null},kv,reg:{byOwner:()=>[]},ethUsd8:async()=>300000000000n,lookup:()=>null,gasPrice:async()=>6000000n,fetchImpl});
  const S={phone:{pending:{},active:null}};
  const E=createPhoneEnrollment({S,save:()=>{},pub:mkPub(wal,own),wallet:W,trust:'0x6b91dcb27cf3d69b1d9a6fddeb06ed1af2ed0bf9',owner:O,chainId:8453,base:()=>'https://pay.kipurse.com',caps:()=>({single:0n,daily:0n}),script:()=>'',approverVersion:'v3',
    feeTo:FEE,sponsor:{available:()=>sp.withdrawAvailable(),register:async(id,a)=>{const s=sp.registerEnroll(id,a);return s?'https://pay.kipurse.com/onboard/new/paymaster?id='+s:null;}}});
  return {E,sp,S,kv};}

const EP='0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const upstream=async()=>({json:async()=>({jsonrpc:'2.0',id:1,result:{sponsor:{name:'Kipurse',icon:'data:x'},paymaster:'0x9d3927128b74460e164a1b1dee445d490e7eca72',paymasterData:'0x01',isFinal:false}})});
async function setup(){const {E,sp}=mk({fetchImpl:upstream});const r=await E.enroll({x:X,y:Y});const sid=ENROLL_PREFIX+r.id;
  const {encodeFunctionData}=await import('viem');const EX=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[])']);
  const op={sender:O,callData:encodeFunctionData({abi:EX,functionName:'executeBatch',args:[r.calls.map(c=>({target:c.to,value:0n,data:c.data}))]}),callGasLimit:'0x1e8480',verificationGasLimit:'0x30000',preVerificationGas:'0x20000',maxFeePerGas:'0x5b8d80'};
  return {sp,sid,op};}
test('t910: Coinbase sees "your Kipurse wallet balance", never "Kipurse" (zh + en, stub + final)',async()=>{const {sp,sid,op}=await setup();
  for(const [lang,name] of [['zh-CN','Your Kipurse balance'],['en-US','Your Kipurse balance'],[undefined,'Your Kipurse balance']])for(const m of ['pm_getPaymasterStubData','pm_getPaymasterData']){
    const r=await sp.rpc(sid,{jsonrpc:'2.0',id:7,method:m,params:[op,EP,'0x2105',{}]},{lang});
    assert.equal(r.error,undefined,JSON.stringify(r));assert.deepEqual(r.result.sponsor,{name,icon:'data:x'},'name replaced, upstream icon kept');assert.equal(r.result.paymaster,'0x9d3927128b74460e164a1b1dee445d490e7eca72');}});
test('t910: unknown sponsor ids are still refused',async()=>{const {sp}=mk({fetchImpl:upstream});
  const r=await sp.rpc('nope',{jsonrpc:'2.0',id:1,method:'pm_getPaymasterStubData',params:[]});assert.ok(r.error,'unknown id still refused');});
test('t910: enroll page says the fee is deducted from the Kipurse wallet balance',async()=>{const {E}=mk();const r=await E.enroll({x:X,y:Y});
  let b='';await E.handle({method:'GET',headers:{}},{writeHead(){},end(x){b=x;}},new URL('https://pay.kipurse.com/phone/enroll?id='+r.id+'&lang=zh'),{readBody:async()=>({})});
  assert.match(b,/从你的启付钱包余额扣除/);assert.doesNotMatch(b,/Base Account 先用 USDC 垫付/);assert.match(b,/<button id=go>确认<\/button>/);});
