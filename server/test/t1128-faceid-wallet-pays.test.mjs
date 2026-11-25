import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createPhoneEnrollment,FEE_CAP} from '../src/v5/phone-signer.mjs';
const ps=fs.readFileSync(new URL('../src/v5/phone-signer.mjs',import.meta.url),'utf8');
const ml=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
const W='0x5e4c116dd45edc2dbed826be8b97a72499d03fc8',O='0x1da2d5293bd418ab06d16890f17711302c7e74f6',FEE='0xf14ef5dc4723245866c22c749a0a84afceba0dd9';
const X='0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',Y='0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
const mkPub=({bal=14304957n,gp=6000000n}={})=>({readContract:async({functionName})=>functionName==='balanceOf'?bal:functionName==='latestRoundData'?[0n,300000000000n,0n,BigInt(Math.floor(Date.now()/1e3)),0n]:functionName==='nextOwnerIndex'?0n:false,getBalance:async()=>0n,getGasPrice:async()=>gp,getCode:async()=>'0x'});
const mk=({S={phone:{pending:{},active:null}},pub=mkPub(),avail=true,pm='https://pay.kipurse.com/onboard/new/paymaster?id=en-x',feeTo=FEE}={})=>{let registered=0,lastReg=null;const E=createPhoneEnrollment({S,save:()=>{},pub,wallet:W,trust:'0x6b91dcb27cf3d69b1d9a6fddeb06ed1af2ed0bf9',owner:O,chainId:8453,base:()=>'https://pay.kipurse.com',caps:()=>({single:0n,daily:0n}),script:()=>'',approverVersion:'v3',
  feeTo,afterOpening:'wallet',sponsor:{available:()=>avail,register:async(id,a)=>{registered++;lastReg=a;return pm;}}});return {E,S,reg:()=>registered,lastReg:()=>lastReg};};
test('t1128: mainnet post-opening Face ID is wallet-pays (no refuse)',()=>{
  assert.match(ml,/createPhoneEnrollment\(\{[^]*?afterOpening:'wallet'/);assert.doesNotMatch(ml,/afterOpening:'refuse'/);
  assert.match(ml,/\?v:OP\.feeTo\)/);   // t1270: the official fee address comes from operatorConstants (operator config)
  // limits change never touches phone enrollment (t1125 wallet-fee path stays)
  assert.match(ml,/limitsDirect=\(\)=>LFEE\.limitsWalletFeeForAll\(R\.wallet\)/);
  assert.equal(FEE_CAP,50_000n);});
test('t1128: after opening, a new key gets ONE wallet-pays batch: live fee <= 0.05 to the fee address, sponsor registered with that reimburse',async()=>{
  const {E,S,reg,lastReg}=mk();const r=await E.enroll({x:X,y:Y});
  assert.equal(r.walletPays,true);assert.equal(r.feeTo.toLowerCase(),FEE);assert.ok(BigInt(r.fee)>0n&&BigInt(r.fee)<=FEE_CAP);
  assert.equal(reg(),1);assert.equal(lastReg().reimburse,BigInt(r.fee));assert.equal(lastReg().owner.toLowerCase(),O);
  const last=r.calls.at(-1);assert.equal(last.to.toLowerCase(),W);assert.ok(last.data.toLowerCase().includes(FEE.slice(2)),'fee transfer goes to the fee address');assert.ok(!last.data.toLowerCase().includes(O.slice(2)),'never the owner-fronted refund');
  assert.equal(r.calls.length,3);assert.equal(Object.keys(S.phone.pending).length,1);
  const q=await E.quote(r.id);assert.equal(q.walletPays,true);assert.equal(q.usdcReady,true);assert.equal(q.fee,r.fee);});
test('t1128: the opening-batch key is still "already", free, no sponsor',async()=>{
  const S={phone:{pending:{k:{x:X,y:Y,fee:'0',approver:'0x'+'a'.repeat(40),exp:Date.now()+6e5}},active:null}};const {E,reg}=mk({S});
  const r=await E.enroll({x:X,y:Y});assert.equal(r.already,true);assert.equal(r.fee,'0');assert.deepEqual(r.calls,[]);assert.equal(reg(),0);});
for(const [name,o,code] of [['sponsor off',{avail:false},'wallet_fee_unavailable'],['sponsor register fails',{pm:null},'wallet_fee_unavailable'],['no fee address',{feeTo:null},'wallet_fee_unavailable'],
  ['wallet short',{pub:mkPub({bal:1000n})},'wallet_needs_usdc'],['fee over cap',{pub:mkPub({gp:10_000_000_000n})},'fee_over_cap']])
  test(`t1128: ${name} -> stop with ${code}, no batch, no charge`,async()=>{const {E,S}=mk(o);
    await assert.rejects(E.enroll({x:X,y:Y}),e=>e.code===code&&/Nothing was charged/.test(e.message));assert.equal(Object.keys(S.phone.pending).length,0);});
test('t1128: a stale owner-fronted fee entry cannot be quoted or opened in wallet mode',async()=>{
  const S={phone:{pending:{p1:{x:X,y:Y,fee:'30000',approver:'0x'+'b'.repeat(40),exp:Date.now()+6e5}},active:null}};const {E}=mk({S});
  await assert.rejects(E.quote('p1'),e=>e.code==='wallet_fee_unavailable');
  assert.match(ps,/if\(e&&walletOnly&&BigInt\(e\.fee\?\?0\)>0n&&!e\.paymaster\)\{json\(400,\{error:'wallet_fee_unavailable'\}\)/);});
