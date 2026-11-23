// SPDX-License-Identifier: AGPL-3.0-only
// t1116u: everyday withdraw = any amount the user picks, or everything. Destination stays the owner; partial confirm needs no zero balance.
import test from 'node:test';import assert from 'node:assert/strict';
import {createOwnerWithdraw,checkWithdrawCalls,checkWalletPaysCalls,WITHDRAW_MAX_WALLET_FEE} from '../src/v5/owner-withdraw.mjs';
import {decodeFunctionData} from 'viem';import {WITHDRAW_WALLET_ABI,WITHDRAW_ERC20_ABI} from '../src/v5/owner-withdraw.mjs';
const W='0x1000000000000000000000000000000000000004',O='0x2000000000000000000000000000000000000002',X='0x2000000000000000000000000000000000000004',T='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',F='0xc0dedd749573f2e967a4ba53190c27ffbc2f8b31',V='0x3000000000000000000000000000000000000003',FEE='0xf14EF5Dc4723245866c22C749A0A84AFCebA0Dd9';
const mk=({bal={[W]:12_340_000n,[O]:0n},unres=0n,vault=null,walletPays=null}={})=>{const st={bal,unres};
  const pub={readContract:async({functionName,args})=>functionName==='isOwnerAddress'?true:functionName==='unreserved'?st.unres:functionName==='balanceOf'?(st.bal[args[0]]??0n):[0n,300000000000n,0n,0n,0n],
    getCode:async({address})=>vault&&address.toLowerCase()===vault.toLowerCase()?'0x60':'0x',estimateGas:async()=>60000n,getGasPrice:async()=>10_000_000n};
  return {st,M:createOwnerWithdraw({pub,wallet:W,owner:O,token:T,feed:F,vault,script:()=>'',...(walletPays?{feeTo:FEE,walletPays}:{})})};};
const call=async(M,method,path,body,lang='zh-CN')=>{let code,out;const res={writeHead:c=>{code=c;},end:b=>{out=b;}};const u=new URL('http://x'+path);
  await M.handle({method,headers:{'accept-language':lang}},res,u,{readBody:async()=>body??{},ip:'1'});return {code,out,j:(()=>{try{return JSON.parse(out);}catch{return null;}})()};};
const transfers=calls=>calls.map(c=>{const o=decodeFunctionData({abi:WITHDRAW_WALLET_ABI,data:c.data});try{const t=decodeFunctionData({abi:WITHDRAW_ERC20_ABI,data:o.args[2]});return {to:t.args[0],n:t.args[1]};}catch{return null;}}).filter(Boolean);
test('t1116u quote/prepare take the chosen amount; destination still fixed to the owner',async()=>{
  const {M}=mk();const q=(await call(M,'POST','/owner/withdraw/quote',{amount:'5000000',to:X})).j;
  assert.equal(q.amount,'5000000');assert.equal(q.total,'12340000');assert.equal(q.partial,true);assert.equal(q.to,O);
  const r=(await call(M,'POST','/owner/withdraw/prepare',{amount:'5000000',to:X,owner:X})).j;
  assert.equal(r.amount,'5000000');assert.equal(r.owner,O);assert.equal(r.vault,null);assert.equal(checkWithdrawCalls(r.calls,{wallet:W,owner:O,token:T}),null);
  assert.deepEqual(transfers(r.calls),[{to:O,n:5_000_000n}]);assert.ok(!JSON.stringify(r).toLowerCase().includes(X.slice(2).toLowerCase()));});
test('t1116u everything: amount = full balance or no amount (old apps) -> same full plan as before',async()=>{
  const {M}=mk();const a=(await call(M,'POST','/owner/withdraw/prepare',{amount:'12340000'})).j,b=(await call(M,'POST','/owner/withdraw/prepare',{})).j;
  assert.equal(a.amount,'12340000');assert.equal(b.amount,'12340000');assert.deepEqual(a.calls,b.calls);});
test('t1116u refuses: more than the balance, at/below the fee, zero, junk',async()=>{
  const {M}=mk();const q=await M.quote();const fee=BigInt(q.feeUsdc);
  for(const [amt,code] of [['14264496','amount_too_high'],[fee.toString(),'amount_below_fee'],['1','amount_below_fee'],['0','bad_amount'],['-5','bad_amount'],['1.5','bad_amount'],['1e6','bad_amount'],[{x:1},'bad_amount']]){
    const r=await call(M,'POST','/owner/withdraw/prepare',{amount:amt});assert.equal(r.code,400,String(amt));assert.equal(r.j.error,code,String(amt));}
  assert.equal((await call(M,'POST','/owner/withdraw/prepare',{amount:(fee+1n).toString()})).j.amount,(fee+1n).toString());});
test('t1116u partial confirm: succeeds with money left in the wallet (no zero balance needed); not before it moves',async()=>{
  const {M,st}=mk();const r=(await call(M,'POST','/owner/withdraw/prepare',{amount:'5000000'})).j;
  assert.equal((await call(M,'POST','/owner/withdraw/confirm',{id:r.id})).j.ok,false);
  st.bal[W]=7_340_000n;st.bal[O]=5_000_000n-6_000n;   // owner paid the network fee in USDC from what arrived
  const c=(await call(M,'POST','/owner/withdraw/confirm',{id:r.id})).j;assert.equal(c.ok,true);assert.equal(c.amount,'5000000');assert.equal(c.walletLeft,'7340000');});
test('t1116u partial confirm is not fooled by an unrelated wallet drop (owner got nothing)',async()=>{
  const {M,st}=mk();const r=(await call(M,'POST','/owner/withdraw/prepare',{amount:'5000000'})).j;
  st.bal[W]=1_000_000n;assert.equal((await call(M,'POST','/owner/withdraw/confirm',{id:r.id})).j.ok,false);});
test('t1116u full confirm still works by emptying the wallet',async()=>{
  const {M,st}=mk();const r=(await call(M,'POST','/owner/withdraw/prepare',{amount:'12340000'})).j;st.bal[W]=0n;
  assert.equal((await call(M,'POST','/owner/withdraw/confirm',{id:r.id})).j.ok,true);});
test('t1116u reserve: partial from the wallet alone leaves the reserve; above the wallet sweeps it',async()=>{
  const {M,st}=mk({bal:{[W]:7_500_000n,[O]:0n},unres:200_000n,vault:V});
  const a=(await call(M,'POST','/owner/withdraw/prepare',{amount:'7000000'})).j;assert.equal(a.calls.length,1);assert.equal(a.vault,null);assert.equal(checkWithdrawCalls(a.calls,{wallet:W,owner:O,token:T}),null);
  const b=(await call(M,'POST','/owner/withdraw/prepare',{amount:'7600000'})).j;assert.equal(b.calls.length,2);assert.equal(b.vault.toLowerCase(),V.toLowerCase());assert.equal(checkWithdrawCalls(b.calls,{wallet:W,owner:O,token:T,vault:V}),null);
  assert.deepEqual(transfers(b.calls),[{to:O,n:7_600_000n}]);
  st.unres=0n;st.bal[W]=100_000n;st.bal[O]=7_590_000n;assert.equal((await call(M,'POST','/owner/withdraw/confirm',{id:b.id})).j.ok,true);
  const all=(await call(M,'POST','/owner/withdraw/prepare',{})).j;assert.equal(all.amount,'100000');});
test('t1116u the page cannot re-prepare "everything" over a partial plan; plan by id keeps the chosen amount; page shows it',async()=>{
  const reg=[];const {M}=mk({walletPays:{available:()=>true,register:async(id,a)=>{reg.push(a);return 'https://pm';}}});
  const r=(await call(M,'POST','/owner/withdraw/prepare',{amount:'5000000'})).j;assert.equal(r.feeFrom,'owner');
  // t1120u: the page's wallet-pays re-prepare (no amount) keeps THE SAME partial amount (was: refused with partial_pending -> owner-pays fallback)
  const w=await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet'});assert.equal(w.code,200);assert.equal(w.j.feeFrom,'wallet');assert.equal(w.j.amount,'5000000');assert.equal(reg.length,1);
  assert.equal((await call(M,'POST','/owner/withdraw/plan',{id:r.id})).j.amount,'5000000');
  const pg=await call(M,'GET','/owner/withdraw?plan='+r.id);assert.equal(pg.code,200);assert.match(pg.out,/>5 USDC</);assert.doesNotMatch(pg.out,/14\.264495 USDC/);
  const en=await call(M,'GET','/owner/withdraw?plan='+r.id,null,'en');assert.match(en.out,/>5 USDC</);
  // wallet-pays with an explicit amount keeps that amount and the fee ceiling
  const wp=(await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet',amount:'4000000'})).j;assert.equal(wp.feeFrom,'wallet');assert.equal(wp.amount,'4000000');
  assert.equal(checkWalletPaysCalls(wp.calls,{wallet:W,owner:O,token:T,feeTo:FEE}),null);const tr=transfers(wp.calls);assert.equal(tr[0].n+tr[1].n,4_000_000n);assert.ok(tr[0].n<=WITHDRAW_MAX_WALLET_FEE);assert.equal(tr[1].to,O);});
test('t1116u after a full app plan the page fee shape is allowed again (unchanged old behaviour)',async()=>{
  const {M}=mk({walletPays:{available:()=>true,register:async()=>'https://pm'}});
  await call(M,'POST','/owner/withdraw/prepare',{amount:'12340000'});const w=(await call(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet'})).j;assert.equal(w.feeFrom,'wallet');assert.equal(w.amount,'12340000');});
