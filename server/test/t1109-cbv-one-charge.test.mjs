// t1109u (owner 2026-11-11): Coinbase Verified Account check has no off switch (new + legacy opening), and one opening = one charge
// (opening + first wallet safety limits + first phone key). Logic only; no UI change.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {getAddress,encodeFunctionData} from 'viem';
import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';
import {createOnboarding} from '../src/v5/onboard.mjs';
import {DETERMINISTIC_DEPLOYER,WALLET_ABI,approverInit} from '../src/v5/phone-signer.mjs';
import {openingFeeUSDC,OPENING_WITH_FIRST_KEY_GAS,feeRepayCall,vaultSeedCall} from '../src/v5/usdc-gas.mjs';
import {checkLimits} from '../src/v5/limits-public.mjs';
import {kvKey} from '../src/v5/store.mjs';import {selfCall,ownerUpgradeTopLevel} from '../src/v5/owner-selfcall.mjs';
const A='0x1B1BF0E5D1C6a2b74C3D9E8f07a1b2c3D4e5f606';
const X='0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',Y='0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
const mapKV=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v),del:k=>m.delete(k)};};
const call=async(N,method,url,body={})=>{let code,b;const res={writeHead(c){code=c;},end(x){b=x?JSON.parse(x):null;}};await N.handle({method,headers:{}},res,new URL('https://x'+url),{readBody:async()=>body});return {code,b};};

test('new opening: no checker wired = refused (fails closed, never "off")',async()=>{
  const kv=mapKV();const N=createNewWalletOnboarding({enabled:true,kv,base:()=>'https://x',script:()=>'',quote:async()=>({}),reg:{byOwner:()=>[]},pub:{readContract:async()=>{throw Error('reached wallet build');},getCode:async()=>'0x'}});
  kv.put(kvKey('onbnew',null,'i1'),{x:'1',y:'2',expect:A,choice:{single:'1',daily:'1',term:'1',days:90},state:'start'});
  const r=await call(N,'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.equal(r.code,400);assert.equal(r.b.error,'verify_unavailable');
  assert.doesNotMatch(r.b.detail??'',/reached wallet build/);});

test('launch: no KIPURSE_REQUIRE_CBV kill switch; new and legacy opening both get the server-side checker',()=>{
  const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(s,/KIPURSE_REQUIRE_CBV/);
  assert.match(s,/createNewWalletOnboarding\(\{appAttest:APP_ATTEST,verified:\(o=>checkVerifiedMulti\(/);
  assert.match(s,/createOnboarding\(\{verified:o=>checkVerifiedMulti\(\[pub,\.\.\.CBV_PUBS\]/);
  const ob=fs.readFileSync(new URL('../src/v5/onboard-new.mjs',import.meta.url),'utf8');assert.doesNotMatch(ob,/reason:'off'/);});

test('legacy /onboard (re)opening: missing / down / not verified refused before anything is built; verified passes the gate',async()=>{
  const mk=verified=>createOnboarding({verified,S:{},save(){},pub:{},wallet:'0x2222222222222222222222222222222222222222',owner:A,trust:'0x5555555555555555555555555555555555555555',base:()=>'https://x',phone:{},plan:async()=>{throw Error('plan built');},enabled:true});
  await assert.rejects(mk(null).start({x:X,y:Y,single:'1',daily:'1',term:'1'}),e=>e.code==='verify_unavailable');
  await assert.rejects(mk(async()=>{throw Error('rpc down');}).start({x:X,y:Y,single:'1',daily:'1',term:'1'}),e=>e.code==='verify_unavailable'&&/nothing was charged/i.test(e.message));
  for(const reason of ['none','revoked','expired','wrong_attester'])await assert.rejects(mk(async()=>({verified:false,reason})).start({x:X,y:Y,single:'1',daily:'1',term:'1'}),e=>e.code==='not_verified',reason);
  let seen=null;await assert.rejects(mk(async o=>{seen=o;return {verified:true,reason:'ok'};}).start({x:X,y:Y}),e=>e.code==='bad_amount','gate passed, then normal validation');
  assert.equal(getAddress(seen),getAddress(A),'checks the owner Base Account itself');});

test('one opening = one charge: exactly one USDC fee transfer, and it covers caps + first phone key',async()=>{
  const W='0x2222222222222222222222222222222222222222',TRUST='0x5555555555555555555555555555555555555555',GP=6_000_000n,ETH=2_500_00000000n;
  const kv=mapKV();const pub={getCode:async()=>'0x',getBlock:async()=>({timestamp:1_700_000_000n}),getBlockNumber:async()=>1n,getGasPrice:async()=>GP,getBalance:async()=>0n,
    readContract:async({functionName})=>functionName==='getAddress'?W:functionName==='vaultAddress'?'0x3333333333333333333333333333333333333333':functionName==='fees'?'0x9999999999999999999999999999999999999999':functionName==='feePpm'?0n:functionName==='latestRoundData'?[0n,ETH,0n,BigInt(Math.floor(Date.now()/1000)),0n]:functionName==='balanceOf'?10_000_000n:functionName==='nextOwnerIndex'?0n:false};
  const policy=()=>({executor:'0x8888888888888888888888888888888888888888',guardian:'0x0000000000000000000000000000000000000000',registry:'0x0000000000000000000000000000000000000000',maxFeePpm:'3000',maxNetworkFee:'50000',openSingle:'1000000',openDaily:'1000000',verifiedSingle:'1000000',verifiedDaily:'1000000'});
  const N=createNewWalletOnboarding({enabled:true,kv,pub,cfg:{adapter:'0x4444444444444444444444444444444444444444',trust:TRUST,token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',manager:'0x7777777777777777777777777777777777777777',approverVersion:'v2'},policy,reg:{byOwner:()=>[]},base:()=>'https://x',script:()=>'',sponsor:null,verified:async()=>({verified:true}),noteFirstKey:()=>{},quote:async()=>({})});
  await assert.rejects(N.start({x:X,y:Y,owner:A}),e=>e.code==='bad_amount','no opening without the first wallet safety limits');
  const st=await N.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:A});const pr=await N.prepare(st.id,A);
  const fee=openingFeeUSDC({gasPriceWei:GP,ethUsd8:ETH,gas:OPENING_WITH_FIRST_KEY_GAS}).fee;
  /* t1185u §6#86: the owner's own 0.15 USDC into his vault (fee reserve) is NOT a fee: exactly one, LAST, to his vault; the fee rule is unchanged */
  const seeds=pr.calls.filter(c=>String(c.data).toLowerCase()===vaultSeedCall('0x3333333333333333333333333333333333333333').data.toLowerCase());
  assert.equal(seeds.length,1,'one fee-reserve seed');assert.equal(pr.calls.at(-1).data.toLowerCase(),seeds[0].data.toLowerCase(),'seed is the last step');
  const transfers=pr.calls.filter(c=>String(c.data).toLowerCase().startsWith('0xa9059cbb')&&!seeds.includes(c));
  assert.equal(transfers.length,1,'one fee transfer only');assert.equal(transfers[0].data.toLowerCase(),feeRepayCall(fee).data.toLowerCase());
  const caps=checkLimits({single:'2',daily:'5',term:'30',days:90});
  const ap=approverInit({wallet:pr.wallet,trust:TRUST,x:X,y:Y,maxSingle:caps.single,maxDaily:caps.daily,version:'v2'});
  assert.ok(pr.calls.some(c=>getAddress(c.to)===getAddress(DETERMINISTIC_DEPLOYER)),'first phone key deployed in the same batch');
  assert.ok(pr.calls.some(c=>getAddress(c.to)===getAddress(pr.wallet)&&String(c.data).toLowerCase()===selfCall(pr.wallet,encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[ap.address]})).data.toLowerCase()),'first phone key added in the same batch (t1238 §6#106: wallet self-call)');
  assert.deepEqual(ownerUpgradeTopLevel(pr.calls),[],'no top-level owner/upgrade call (Coinbase refuses them)');
  assert.ok(pr.calls.some(c=>getAddress(c.to)===getAddress(pr.wallet)&&String(c.data).toLowerCase().startsWith('0x34fcd5be')),'first wallet safety limits set in the same batch');});
