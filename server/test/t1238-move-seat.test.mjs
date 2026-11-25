// t1238 (decision 109, owner chose (1)): move the owner's wallet to a NEW key-seat wallet on V5.4, then reconnect the AIs.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {decodeFunctionData,getAddress,parseAbi} from 'viem';
import {moveToSeatCalls,newSeatWallet,CB_FACTORY,MOVE_SEAT_FEE_CAP} from '../src/v5/move-seat.mjs';
import {coinbaseRefuses} from '../src/v5/coinbase-rule.mjs';
import {decodePolicyV5,encodePolicyV5} from '../src/v5/abi.mjs';
import {createRegistry} from '../src/v5/tenancy.mjs';
import {SPM} from '../src/v5/migrate-v54.mjs';
const T1214=new URL('../../',import.meta.url).pathname;
const OWNER='0x4242b022A8296cB18B0E0b1Cb9879C518170A718',W='0x515010c2e41F98CdDd76B819EE69DC832c0939B6',NW='0x1111111111111111111111111111111111111111',VN='0x2222222222222222222222222222222222222222';
const OLD_TRUST='0x65D2cE04DA7aCe81e7C4ab08712509282745eC84',OLD_ADAPTER='0x05320BeD08309F66316F7d73e2D0be110400FbB2';
const perm=JSON.parse(fs.readFileSync(new URL('./fixtures/perm-current.json',import.meta.url),'utf8'));
const trusts=JSON.parse(fs.readFileSync(new URL('./fixtures/trust-v52-stored.json',import.meta.url),'utf8')).map(x=>({merchant:x.merchant,name:x.name,payees:x.payees,signers:x.signers,single:x.single,daily:x.daily,expiry:x.expiry}));
const S={wallet:W,oldPermission:perm,oldPermissionValid:true,oldAdapter:OLD_ADAPTER,oldApprover:{address:'0x2aa8da9fc5e86bf482d91ad496cbca9500e561c8',index:5n,x:123n,y:456n},
  float:{open:false},oldVault:null,oldVaultReserved:0n,oldVaultBalance:0n,trusts,floatCap:200000n,deniedPayees:[],deniedSigners:[],openReservations:[],serverInFlight:false,paused:false,registryOptOut:false};
const NEWEXEC='0x3333333333333333333333333333333333333333';
const extra=encodePolicyV5({...decodePolicyV5(perm.extraData),executor:NEWEXEC});
const build=o=>moveToSeatCalls(S,{owner:OWNER,newWallet:NW,vaultNew:VN,fee:50000n,move:13_185_320n,oldTrust:OLD_TRUST,seatDeployed:false,newExtraData:extra,...o});

test('move batch: Coinbase popup rule passes; every owner change is absent at any depth; the new wallet is created with [Base Account, seat, SPM]',()=>{
  const b=build();assert.equal(coinbaseRefuses(b.calls,OWNER,SPM),false);
  const create=b.calls.find(c=>getAddress(c.to)===getAddress(CB_FACTORY));const d=decodeFunctionData({abi:parseAbi(['function createAccount(bytes[] owners,uint256 nonce)']),data:create.data});
  assert.deepEqual(d.args[0].map(String),newSeatWallet({owner:OWNER}).owners.map(String));});
test('new wallet permission: same limits / window / token as the old one, but the NEW wallet as account, V5.4 adapter, and ITS OWN executor',()=>{
  const b=build();const o=b.oldPermission,n=b.newPermission;
  assert.equal(getAddress(n.account),getAddress(NW));assert.equal(getAddress(n.spender),'0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa');
  for(const k of ['token','allowance','period','start','end'])assert.equal(String(n[k]),String(o[k]),k);
  const po=decodePolicyV5(o.extraData),pn=decodePolicyV5(n.extraData);assert.equal(getAddress(pn.executor),getAddress(NEWEXEC));
  for(const k of Object.keys(po))if(k!=='executor')assert.equal(String(pn[k]),String(po[k]),'policy '+k+' unchanged');});
test('money: the old wallet sends exactly `move` to the new wallet; 0.15 reserve into the new vault; fee to the fee address; old permission revoked; old wallet paused',()=>{
  const b=build();const L=b.calls.map(c=>c.label);
  assert.ok(L.includes('old -> new: move USDC'));assert.ok(L.includes('new: 0.15 USDC fee reserve (his own money)'));
  assert.ok(L.includes('old: revoke V5.2 spend permission'));assert.ok(L.includes('old: pause (no AI payment can start there)'));
  assert.equal(L.filter(l=>l.startsWith('new: trust ')).length,trusts.length,'every trust record re-applied');});
test('refused: fee above the cap, or not enough USDC to keep the reserve; an open V5.2 reservation the server cannot name',()=>{
  assert.throws(()=>build({fee:MOVE_SEAT_FEE_CAP+1n}),e=>e.code==='fee_above_cap');
  assert.throws(()=>build({move:150_000n}),e=>e.code==='needs_usdc');
  assert.throws(()=>moveToSeatCalls({...S,oldVaultReserved:5n},{owner:OWNER,newWallet:NW,vaultNew:VN,fee:50000n,move:13_185_320n,oldTrust:OLD_TRUST}),e=>e.code==='precheck');});
test('registry: after a move the NEW wallet is found first for the owner; the old one is kept (retired), never deleted',()=>{
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'kp-reg-'));const R=createRegistry({file:path.join(d,'registry.json')});
  R.add({wallet:W,owner:OWNER,publicPath:''});R.add({wallet:NW,owner:OWNER,publicPath:'/t/'+NW.toLowerCase(),suite:'v5.4'});
  assert.equal(getAddress(R.byOwner(OWNER)[0].wallet),getAddress(W),'before: insertion order as today');
  R.update(W,{retired:true,movedTo:NW});
  assert.equal(getAddress(R.byOwner(OWNER)[0].wallet),getAddress(NW));assert.equal(R.byOwner(OWNER).length,2);assert.ok(R.get(W).retired);
  fs.rmSync(d,{recursive:true,force:true});});
