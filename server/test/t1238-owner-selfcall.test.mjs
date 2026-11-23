// t1238 (the owner's decision log §6#106): every batch we hand to the Base Account must have NO top-level owner/upgrade call
// (keys.coinbase.com: "Account owner or upgrade calls are not allowed."). Owner changes are wallet.execute(wallet,0,...) self-calls.
import test from 'node:test';import assert from 'node:assert/strict';
import {encodeFunctionData,decodeFunctionData,getAddress,parseAbi,pad} from 'viem';
import {selfCall,ownerUpgradeTopLevel,assertNoTopLevelOwnerCall,OWNER_SELECTOR_NAMES} from '../src/v5/owner-selfcall.mjs';
import {createPhoneEnrollment,WALLET_ABI} from '../src/v5/phone-signer.mjs';
const W='0x2222222222222222222222222222222222222222',A1='0x1111111111111111111111111111111111111111';
const EX=parseAbi(['function execute(address target, uint256 value, bytes data)']);
test('selfCall = wallet.execute(wallet, 0, data) addressed to the wallet',()=>{
  const inner=encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[A1]});const c=selfCall(W,inner);
  assert.equal(getAddress(c.to),getAddress(W));assert.equal(c.value,'0x0');
  const d=decodeFunctionData({abi:EX,data:c.data});assert.equal(d.functionName,'execute');assert.equal(getAddress(d.args[0]),getAddress(W));assert.equal(d.args[1],0n);assert.equal(d.args[2].toLowerCase(),inner.toLowerCase());
  assert.deepEqual(ownerUpgradeTopLevel([c]),[]);});
test('every owner/upgrade selector at top level is caught, and the assert refuses the batch',()=>{
  const raw=[encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[A1]}),encodeFunctionData({abi:WALLET_ABI,functionName:'removeOwnerAtIndex',args:[5n,pad(A1)]}),
    '0x29565e3b','0xb8197367','0x4f1ef286','0x3659cfe6'];
  for(const d of raw){assert.deepEqual(ownerUpgradeTopLevel([{to:W,data:d}]),[0],d.slice(0,10));assert.throws(()=>assertNoTopLevelOwnerCall([{to:W,data:d}]),e=>e.code==='owner_call_top_level');}
  assert.ok(OWNER_SELECTOR_NAMES.length>=10);});
test('phone key revoke / retiring / dead-approver cleanup and enroll calls carry no top-level owner call',async()=>{
  const AP='0x9999999999999999999999999999999999999999';const S={phone:{pending:{},active:{approver:AP,index:5,version:'v3'},retiring:{approver:'0x8888888888888888888888888888888888888888',index:4},dead:['0x7777777777777777777777777777777777777777']}};
  const pub={readContract:async({functionName,args})=>functionName==='nextOwnerIndex'?6n:functionName==='ownerAtIndex'?pad([ '0x'+'00'.repeat(20),'0x'+'00'.repeat(20),'0x'+'00'.repeat(20),'0x'+'00'.repeat(20),'0x8888888888888888888888888888888888888888',AP][Number(args[0])]??'0x'+'00'.repeat(20)):functionName==='isOwnerAddress'?true:false};
  let ph;try{ph=createPhoneEnrollment({S,save:()=>{},pub,wallet:W,owner:A1,trust:A1,chainId:8453,base:()=>'https://x',token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'});}catch(e){return assert.fail('createPhoneEnrollment signature changed: '+e.message);}
  const rv=await ph.revokeCalls();assert.ok(rv&&rv.length===1);assert.deepEqual(ownerUpgradeTopLevel(rv),[]);
  const inner=decodeFunctionData({abi:EX,data:rv[0].data});assert.equal(getAddress(inner.args[0]),getAddress(W));
  const rm=decodeFunctionData({abi:WALLET_ABI,data:inner.args[2]});assert.equal(rm.functionName,'removeOwnerAtIndex');assert.equal(rm.args[0],5n);
  const rt=await ph.retiringCalls();assert.ok(rt&&rt.length===1);assert.deepEqual(ownerUpgradeTopLevel(rt),[]);
  const rc=ph.removeCall({approver:AP,index:5});assert.deepEqual(ownerUpgradeTopLevel([rc]),[]);});
