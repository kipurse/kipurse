// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';import assert from 'node:assert/strict';
import {createAnomalyGuard,pauseMsOf,PAUSE_CHOICES} from '../src/v5/anomaly.mjs';import {createMemoryKV} from '../src/v5/store.mjs';
import {withdrawCalls,checkWithdrawCalls,createOwnerWithdraw} from '../src/v5/owner-withdraw.mjs';
const W='0x1000000000000000000000000000000000000004',O='0x2000000000000000000000000000000000000002',X='0x2000000000000000000000000000000000000004',T='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',F='0xc0dedd749573f2e967a4ba53190c27ffbc2f8b31';
test('pause durations: 24h / 48h / 7d expire on time, until_resume lasts, resume early works',()=>{
  let t=1_000_000;const kv=createMemoryKV({now:()=>t});const g=createAnomalyGuard({kv,now:()=>t});
  for(const [c,h] of [['24h',24],['48h',48],['7d',168]]){g.pause(W,'owner_stop',pauseMsOf(c));t+=h*3600e3-1000;assert.ok(g.paused(W),c+' still paused just before');t+=2000;assert.equal(g.paused(W),null,c+' over after');}
  g.pause(W,'owner_stop',pauseMsOf('until_resume'));t+=365*86400e3;assert.ok(g.paused(W),'indefinite');assert.equal(g.paused(W).until,null);
  assert.ok(g.check(W,'x'),'payments blocked while paused');g.resume(W);assert.equal(g.paused(W),null);assert.equal(g.check(W,'x'),null);
  g.pause(W,'owner_stop',pauseMsOf('7d'));g.pause(W,'owner_stop',pauseMsOf('24h'));t+=25*3600e3;assert.equal(g.paused(W),null,'owner choice replaces');
  g.pause(W,'owner_stop',null);g.pause(W,'too_many_payments',3600e3);t+=7200e3;assert.ok(g.paused(W),'auto pause never shortens');
  assert.equal(pauseMsOf('1y'),undefined);assert.equal(pauseMsOf(undefined),PAUSE_CHOICES['24h']);});
test('withdraw batch: only the owner can be the destination',()=>{
  const c=withdrawCalls({wallet:W,owner:O,token:T,amount:5n});assert.equal(checkWithdrawCalls(c,{wallet:W,owner:O,token:T}),null);
  assert.equal(checkWithdrawCalls(withdrawCalls({wallet:W,owner:X,token:T,amount:5n}),{wallet:W,owner:O,token:T}),'destination_not_owner');
  assert.equal(checkWithdrawCalls([...c,...c],{wallet:W,owner:O,token:T}),'one_call_only');assert.throws(()=>withdrawCalls({wallet:W,owner:O,token:T,amount:0n}));});
const fakePub=({owner=true,bal={[W]:7_500_000n,[O]:0n}}={})=>({readContract:async({functionName,args})=>functionName==='isOwnerAddress'?owner:functionName==='balanceOf'?(bal[args[0]]??0n):[0n,300000000000n,0n,0n,0n],
  estimateGas:async()=>60000n,getGasPrice:async()=>10_000_000n,bal});
const call=async(M,method,path,body)=>{let code,out;const res={writeHead:c=>{code=c;},end:b=>{out=b;}};const u=new URL('http://x'+path);
  await M.handle({method,headers:{'accept-language':'zh-CN'}},res,u,{readBody:async()=>body??{},ip:'1'});return {code,out};};
test('withdraw module: destination fixed, inputs ignored, owner checked on chain, page has no editable field',async()=>{
  const pub=fakePub();const M=createOwnerWithdraw({pub,wallet:W,owner:O,token:T,feed:F,script:()=>''});
  const q=await M.quote();assert.equal(q.to,O);assert.equal(q.amount,'7500000');assert.ok(BigInt(q.feeUsdc)>0n);
  const r=JSON.parse((await call(M,'POST','/owner/withdraw/prepare',{to:X,owner:X,amount:'1'})).out);
  assert.equal(r.owner,O);assert.equal(r.amount,'7500000');assert.equal(checkWithdrawCalls(r.calls,{wallet:W,owner:O,token:T}),null);assert.ok(!r.calls[0].data.toLowerCase().includes(X.slice(2).toLowerCase()));
  const pg=await call(M,'GET','/owner/withdraw?to='+X);assert.equal(pg.code,200);assert.ok(!/<input|<textarea/.test(pg.out));assert.ok(!pg.out.toLowerCase().includes(X.slice(2).toLowerCase()));
  assert.equal(JSON.parse((await call(M,'POST','/owner/withdraw/confirm',{id:r.id})).out).ok,false);pub.bal[W]=0n;pub.bal[O]=7_500_000n;
  assert.equal(JSON.parse((await call(M,'POST','/owner/withdraw/confirm',{id:r.id})).out).ok,true);
  const bad=createOwnerWithdraw({pub:fakePub({owner:false}),wallet:W,owner:O,token:T,feed:F,script:()=>''});await assert.rejects(bad.quote(),/not an owner/);
  assert.equal((await call(bad,'GET','/owner/withdraw')).code,503);assert.equal(JSON.parse((await call(bad,'POST','/owner/withdraw/prepare')).out).error,'owner_mismatch');
  const empty=createOwnerWithdraw({pub:fakePub({bal:{}}),wallet:W,owner:O,token:T,feed:F,script:()=>''});assert.equal(JSON.parse((await call(empty,'POST','/owner/withdraw/prepare')).out).error,'empty');});
test('withdraw includes the fee reserve: sweep + transfer in one batch, plan by id, still only to the owner',async()=>{
  const V='0x3000000000000000000000000000000000000003';const bal={[W]:7_500_000n,[O]:0n};let unres=200_000n;
  const pub={readContract:async({address,functionName,args})=>functionName==='isOwnerAddress'?true:functionName==='unreserved'?unres:functionName==='balanceOf'?(bal[args[0]]??0n):[0n,300000000000n,0n,0n,0n],
    getCode:async({address})=>address.toLowerCase()===V?'0x60':'0x',estimateGas:async()=>60000n,getGasPrice:async()=>10_000_000n};
  const M=createOwnerWithdraw({pub,wallet:W,owner:O,vault:V,token:T,feed:F,script:()=>''});
  const q=await M.quote();assert.equal(q.amount,'7700000');assert.equal(q.reserve,'200000');assert.equal(q.inWallet,'7500000');
  const pq=JSON.parse((await call(M,'POST','/owner/withdraw/quote',{to:X})).out);assert.equal(pq.to,O);assert.equal(pq.amount,'7700000');
  const r=JSON.parse((await call(M,'POST','/owner/withdraw/prepare',{to:X})).out);assert.equal(r.calls.length,2);assert.equal(checkWithdrawCalls(r.calls,{wallet:W,owner:O,token:T,vault:V}),null);
  assert.equal(checkWithdrawCalls(r.calls,{wallet:W,owner:O,token:T}),'one_call_only','sweep only allowed for the known vault');
  assert.equal(checkWithdrawCalls(r.calls,{wallet:W,owner:O,token:T,vault:X}),'not_sweep');
  assert.equal(checkWithdrawCalls([r.calls[0],...withdrawCalls({wallet:W,owner:X,token:T,amount:1n})],{wallet:W,owner:O,token:T,vault:V}),'destination_not_owner');
  const pl=JSON.parse((await call(M,'POST','/owner/withdraw/plan',{id:r.id})).out);assert.deepEqual(pl.calls,r.calls);
  assert.equal((await call(M,'POST','/owner/withdraw/plan',{id:'nope'})).code,404);
  const pg=await call(M,'GET','/owner/withdraw?plan='+r.id);assert.ok(pg.out.includes('确认取回'));assert.ok(!/execute|target|calldata|0x[0-9a-f]{40}/i.test(pg.out.replace(/<script[^>]*><\/script>/g,'')),'no jargon or full hex on the page');
  // fee paid in USDC by the owner: owner gets amount - fee; wallet empty + reserve swept counts as done; result stays readable
  bal[W]=0n;bal[O]=7_690_000n;unres=0n;const c1=JSON.parse((await call(M,'POST','/owner/withdraw/confirm',{id:r.id})).out);assert.equal(c1.ok,true);assert.equal(c1.amount,'7700000');
  assert.equal(JSON.parse((await call(M,'POST','/owner/withdraw/confirm',{id:r.id})).out).ok,true,'idempotent');});
