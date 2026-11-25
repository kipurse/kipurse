// t1238 (decision 108 / decision 109): Face ID key seat behind KIPURSE_KEY_SEAT. Every batch handed to the Base Account must pass the
// Coinbase popup rule (keys.coinbase.com, 2026-11-20): no addOwnerAddress / addOwnerPublicKey / removeOwnerAtIndex / removeLastOwner /
// upgradeToAndCall / initialize at any depth of execute / executeBatch (deeper than 4 = refused too); no call to the Base Account itself;
// no top-level call to the SpendPermissionManager.
import test from 'node:test';import assert from 'node:assert/strict';
import {decodeFunctionData,encodeAbiParameters,encodeFunctionData,getAddress,parseAbi,pad} from 'viem';
import {createNewWalletOnboarding,CB_FACTORY} from '../src/v5/onboard-new.mjs';
import {createPhoneEnrollment,DETERMINISTIC_DEPLOYER} from '../src/v5/phone-signer.mjs';
import {seatInit,seatOwners,SEAT_ABI,SEAT_VERSION} from '../src/v5/key-seat.mjs';
import {kvKey} from '../src/v5/store.mjs';

const CBSW=parseAbi(['function execute(address target,uint256 value,bytes data)','function executeBatch((address target,uint256 value,bytes data)[] calls)','function addOwnerAddress(address owner)']);
import {coinbaseRefuses} from '../src/v5/coinbase-rule.mjs';

import * as P256 from 'ox/P256';
const h64=v=>'0x'+BigInt(v).toString(16).padStart(64,'0');
const K1=P256.getPublicKey({privateKey:'0x'+'11'.repeat(32)}),K2=P256.getPublicKey({privateKey:'0x'+'22'.repeat(32)});
const X=h64(K1.x),Y=h64(K1.y),X2=h64(K2.x),Y2=h64(K2.y);
const OWNER='0x00000000000000000000000000000000000000A1',TRUST='0x5555555555555555555555555555555555555555',SPM='0x7777777777777777777777777777777777777777';
const mapKV=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v),del:k=>m.delete(k)};};

test('the popup-rule mirror refuses what Coinbase refused on 2026-11-20 and passes plain calls',()=>{
  const W='0x2222222222222222222222222222222222222222';
  const add=encodeFunctionData({abi:CBSW,functionName:'addOwnerAddress',args:[TRUST]});
  assert.equal(coinbaseRefuses([{to:W,data:add}],OWNER,SPM),'owner');                                                          // 1st refusal
  assert.equal(coinbaseRefuses([{to:W,data:encodeFunctionData({abi:CBSW,functionName:'execute',args:[W,0n,add]})}],OWNER,SPM),'owner');   // 2nd refusal (self-call)
  assert.equal(coinbaseRefuses([{to:W,data:encodeFunctionData({abi:CBSW,functionName:'execute',args:[TRUST,0n,'0x16c38b3c'+'0'.repeat(63)+'1']})}],OWNER,SPM),false);
});

test('KEY SEAT opening: wallet = factory address for [owner, seat, SPM]; one batch creates it, deploys the seat, sets limits, registers THIS phone; Coinbase rule passes',async()=>{
  const seat=seatInit({factory:CB_FACTORY,owner:OWNER,spm:SPM,trust:TRUST});
  let askedOwners=null;const W='0x2222222222222222222222222222222222222222',GP=6_000_000n,ETH=2_500_00000000n;
  const pub={getCode:async()=>'0x',getBlock:async()=>({timestamp:1_700_000_000n}),getBlockNumber:async()=>1n,getGasPrice:async()=>GP,getBalance:async()=>0n,
    readContract:async({functionName,args})=>{if(functionName==='getAddress'){askedOwners=args[0];return W;}return functionName==='vaultAddress'?'0x3333333333333333333333333333333333333333':functionName==='fees'?'0x9999999999999999999999999999999999999999':functionName==='feePpm'?0n:functionName==='latestRoundData'?[0n,ETH,0n,BigInt(Math.floor(Date.now()/1000)),0n]:functionName==='balanceOf'?10_000_000n:false;}};
  const policy=()=>({executor:'0x8888888888888888888888888888888888888888',guardian:'0x0000000000000000000000000000000000000000',registry:'0x0000000000000000000000000000000000000000',maxFeePpm:'3000',maxNetworkFee:'50000',openSingle:'1000000',openDaily:'1000000',verifiedSingle:'1000000',verifiedDaily:'1000000'});
  let noted=null;const kv=mapKV();
  const N=createNewWalletOnboarding({enabled:true,kv,pub,cfg:{adapter:'0x4444444444444444444444444444444444444444',trust:TRUST,token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',manager:SPM,approverVersion:'v3',keySeat:true},
    policy,reg:{byOwner:()=>[]},base:()=>'https://x',script:()=>'',sponsor:null,verified:async()=>({verified:true}),noteFirstKey:n=>{noted=n;},quote:async()=>({})});
  const st=await N.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:OWNER});const pr=await N.prepare(st.id,OWNER);
  assert.deepEqual(askedOwners.map(String),seatOwners(OWNER,seat.address,SPM).map(String),'wallet address asked for [owner, seat, SPM]');
  const create=pr.calls.find(c=>getAddress(c.to)===getAddress(CB_FACTORY));assert.ok(create,'wallet created in this batch');
  const dc=decodeFunctionData({abi:parseAbi(['function createAccount(bytes[] owners,uint256 nonce)']),data:create.data});
  assert.deepEqual(dc.args[0].map(String),seatOwners(OWNER,seat.address,SPM).map(String));assert.equal(dc.args[1],0n);
  assert.ok(pr.calls.some(c=>getAddress(c.to)===getAddress(DETERMINISTIC_DEPLOYER)&&c.data.toLowerCase()===seat.deployData.toLowerCase()),'seat deployed (code without any phone key)');
  const sk=pr.calls.filter(c=>getAddress(c.to)===getAddress(W)).map(c=>decodeFunctionData({abi:CBSW,data:c.data})).filter(d=>d.functionName==='execute'&&getAddress(d.args[0])===getAddress(seat.address));
  assert.equal(sk.length,1,'exactly one seat call');const inner=decodeFunctionData({abi:SEAT_ABI,data:sk[0].args[2]});
  assert.equal(inner.functionName,'setKey');assert.equal(inner.args[0],BigInt(X));assert.equal(inner.args[1],BigInt(Y));
  assert.equal(coinbaseRefuses(pr.calls,OWNER,SPM),false,'Coinbase popup rule passes');
  assert.equal(pr.calls.filter(c=>String(c.data).toLowerCase().startsWith('0xa9059cbb')).length>=1,true,'the one opening fee leg is still there');
  assert.equal(noted.seat,seat.address);assert.equal(noted.version,SEAT_VERSION);
  assert.equal(kv.get(kvKey('onbnew',null,st.id)).seat,seat.address);});

test('switch OFF: opening batch is exactly the old shape (no seat, approver + self-call)',async()=>{
  const W='0x2222222222222222222222222222222222222222';let askedOwners=null;
  const pub={getCode:async()=>'0x',getBlock:async()=>({timestamp:1_700_000_000n}),getBlockNumber:async()=>1n,getGasPrice:async()=>6_000_000n,getBalance:async()=>0n,
    readContract:async({functionName,args})=>{if(functionName==='getAddress'){askedOwners=args[0];return W;}return functionName==='vaultAddress'?'0x3333333333333333333333333333333333333333':functionName==='fees'?'0x9999999999999999999999999999999999999999':functionName==='feePpm'?0n:functionName==='latestRoundData'?[0n,2_500_00000000n,0n,BigInt(Math.floor(Date.now()/1000)),0n]:functionName==='balanceOf'?10_000_000n:false;}};
  const policy=()=>({executor:'0x8888888888888888888888888888888888888888',guardian:'0x0000000000000000000000000000000000000000',registry:'0x0000000000000000000000000000000000000000',maxFeePpm:'3000',maxNetworkFee:'50000',openSingle:'1000000',openDaily:'1000000',verifiedSingle:'1000000',verifiedDaily:'1000000'});
  const N=createNewWalletOnboarding({enabled:true,kv:mapKV(),pub,cfg:{adapter:'0x4444444444444444444444444444444444444444',trust:TRUST,token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',manager:SPM,approverVersion:'v3'},
    policy,reg:{byOwner:()=>[]},base:()=>'https://x',script:()=>'',sponsor:null,verified:async()=>({verified:true}),noteFirstKey:()=>{},quote:async()=>({})});
  const st=await N.start({x:X,y:Y,single:'2',daily:'5',term:'30',days:90,owner:OWNER});const pr=await N.prepare(st.id,OWNER);
  assert.equal(askedOwners.length,1,'old wallet address = owner only');
  assert.equal(coinbaseRefuses(pr.calls,OWNER,SPM),'owner','the old shape is what Coinbase refuses (why the seat exists)');});

function seatWorld({key=[0n,0n]}={}){
  const W='0x2222222222222222222222222222222222222222',SEAT='0x6666666666666666666666666666666666666666';let k={x:key[0],y:key[1]};
  const pub={getGasPrice:async()=>6_000_000n,getBalance:async()=>0n,getCode:async()=>'0x60',
    readContract:async({address,functionName,args})=>{if(getAddress(address)===getAddress(SEAT)){if(functionName==='x')return k.x;if(functionName==='y')return k.y;if(functionName==='wallet')return W;}
      if(functionName==='latestRoundData')return [0n,2_500_00000000n,0n,BigInt(Math.floor(Date.now()/1000)),0n];if(functionName==='balanceOf')return 10_000_000n;
      if(functionName==='nextOwnerIndex')return 3n;if(functionName==='ownerAtIndex')return [pad(OWNER),pad(SEAT),pad(SPM)][Number(args[0])].toLowerCase();if(functionName==='isOwnerAddress')return [OWNER,SEAT,SPM].map(getAddress).includes(getAddress(args[0]));return 0n;}};
  const S={phone:{pending:{},active:key[0]?{approver:SEAT,index:1,x:'0x'+key[0].toString(16).padStart(64,'0'),y:'0x'+key[1].toString(16).padStart(64,'0'),version:SEAT_VERSION}:null,seat:SEAT}};
  const ph=createPhoneEnrollment({S,save:()=>{},pub,wallet:W,trust:TRUST,owner:OWNER,chainId:8453,base:()=>'https://x',caps:()=>({single:1n,daily:1n}),script:()=>'',approverVersion:'v3',afterOpening:'wallet',
    feeTo:'0xf14ef5dc4723245866c22c749a0a84afceba0dd9',sponsor:{available:()=>true,register:async()=>'https://x/onboard/new/paymaster?id=1'}});
  return {ph,S,W,SEAT,setKey:(x,y)=>{k={x:BigInt(x),y:BigInt(y)};}};}

test('KEY SEAT new phone: ONE wallet.execute(seat, setKey) + wallet-pays fee leg; no owner change; Coinbase rule passes; confirm reads the seat',async()=>{
  const w=seatWorld({key:[BigInt(X),BigInt(Y)]});
  const same=await w.ph.enroll({x:X,y:Y});assert.equal(same.already,true,'same key as on chain -> nothing to sign, no fee');
  const r=await w.ph.enroll({x:X2,y:Y2});assert.equal(r.version,SEAT_VERSION);assert.ok(BigInt(r.fee)>0n&&BigInt(r.fee)<=50_000n,'actual-cost fee, capped at 0.05 (decision 66)');
  assert.equal(r.walletPays,true);assert.equal(r.calls.length,2);
  const d=decodeFunctionData({abi:CBSW,data:r.calls[0].data});assert.equal(d.functionName,'execute');assert.equal(getAddress(d.args[0]),getAddress(w.SEAT));
  const inner=decodeFunctionData({abi:SEAT_ABI,data:d.args[2]});assert.equal(inner.functionName,'setKey');assert.equal(inner.args[0],BigInt(X2));
  assert.equal(coinbaseRefuses(r.calls,OWNER,SPM),false);
  assert.deepEqual(await w.ph.confirm(r.id),{ok:false,detail:'not on chain yet'});
  w.setKey(X2,Y2);const c=await w.ph.confirm(r.id);assert.equal(c.ok,true);assert.equal(c.version,SEAT_VERSION);assert.equal(c.index,1);
  const pc=await w.ph.payCapable();assert.equal(pc.ok,true,'owner payments use the seat (index 1)');});

test('KEY SEAT Face ID off: wallet.execute(seat, clearKey); no owner change; payments by phone stop; the seat stays (forget keeps it)',async()=>{
  const w=seatWorld({key:[BigInt(X),BigInt(Y)]});
  const rc=await w.ph.revokeCalls();assert.equal(rc.length,1);const d=decodeFunctionData({abi:CBSW,data:rc[0].data});
  assert.equal(decodeFunctionData({abi:SEAT_ABI,data:d.args[2]}).functionName,'clearKey');assert.equal(coinbaseRefuses(rc,OWNER,SPM),false);
  assert.deepEqual(await w.ph.revokeConfirm(),{ok:false,detail:'still an owner'});
  w.setKey(0n,0n);assert.deepEqual(await w.ph.revokeConfirm(),{ok:true});assert.equal((await w.ph.payCapable()).ok,false);
  assert.equal(await w.ph.retiringCalls(),null);assert.deepEqual(await w.ph.deadOwners(),[]);
  w.ph.forget();assert.equal(w.S.phone.seat,w.SEAT,'the seat is an owner forever; forget keeps it');});

test('KEY SEAT: a seat that belongs to another wallet is refused (nothing to sign)',async()=>{
  const w=seatWorld({key:[0n,0n]});const pub0=w.ph;   // mutate the seat's wallet answer
  const W2='0x9999999999999999999999999999999999999999';
  const bad=createPhoneEnrollment({S:{phone:{pending:{},active:null,seat:w.SEAT}},save:()=>{},pub:{getGasPrice:async()=>1n,getBalance:async()=>0n,readContract:async({functionName})=>functionName==='wallet'?W2:0n},
    wallet:w.W,trust:TRUST,owner:OWNER,chainId:8453,base:()=>'https://x',caps:()=>({single:1n,daily:1n}),script:()=>'',afterOpening:'wallet'});
  await assert.rejects(bad.enroll({x:X,y:Y}),e=>e.code==='mismatch');assert.ok(pub0);});
