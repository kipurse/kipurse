// t1259 (decision 129): a payment request that can no longer be paid is closed (request + home-screen card), with a clear reason.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
import {createOwnerAsks} from '../src/v5/owner-ask.mjs';import {createOwnerAskApproval} from '../src/v5/owner-ask-approve.mjs';
const P='0x1768000000000000000000000000000000e9fb00';
test('an ask whose merchant order expiresAt passed reads as expired (seconds and ms); others stay pending',()=>{
  let t=1_800_000_000_000;const A=createOwnerAsks({db:new DatabaseSync(':memory:'),now:()=>t});
  A.put({approvalId:'a1',agentId:'muse',spec:{kind:'payAny',args:{expiresAt:Math.floor(t/1000)+900}},payee:P,amount:'200000'});
  A.put({approvalId:'a2',agentId:'muse',spec:{kind:'payAny',args:{expiresAt:t+900e3}},payee:P,amount:'200000'});
  A.put({approvalId:'a3',agentId:'muse',spec:{kind:'pay',args:{}},payee:P,amount:'200000'});
  assert.equal(A.get('a1').state,'pending');t+=901e3;
  assert.equal(A.get('a1').state,'expired');assert.equal(A.get('a2').state,'expired');assert.equal(A.get('a3').state,'pending');
  assert.equal(A.expire('a3'),true);assert.equal(A.get('a3').state,'expired');assert.equal(A.expire('a3'),false);});
test('prepare on a request that can no longer be paid: 410 request_gone, ask + card closed, nothing paid',async()=>{
  const A=createOwnerAsks({db:new DatabaseSync(':memory:')});A.put({approvalId:'g1',agentId:'muse',spec:{kind:'pay',args:{}},payee:P,amount:'200000'});
  let expired=[];const prop={state:'pending',ask:{modes:{trust:{},once:{}}}};
  const engine={ownerAsks:A,mandates:{getProposal:()=>prop,expire:id=>{expired.push(id);return {ok:true};}},ownerAskApproval:async()=>({ok:false,code:'not_direct'})};
  const S=createOwnerAskApproval({engine,phone:{payCapable:async()=>({ok:true,active:{fingerprint:'f'}})},wallet:'0x4494cEd7F076c523B3Da8e013E6706AC4d9D3aE6'});
  const [st,o]=await S.prepare({id:'g1',mode:'trust'});
  assert.equal(st,410);assert.equal(o.error,'request_gone');assert.equal(o.code,'not_direct');assert.equal(o.nothingPaid,true);assert.match(o.detail,/没有付款/);
  assert.equal(A.get('g1').state,'expired');assert.deepEqual(expired,['g1']);
  const [st2,o2]=await S.prepare({id:'g1',mode:'once'});assert.equal(st2,410);assert.equal(o2.error,'request_gone');});
test('home list drops a card whose request expired',()=>{
  const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/proposals:M\.proposals\(\)\.filter\(p=>\{if\(!p\?\.ask\)return true;let a=null;try\{a=E0\.ownerAsks\?\.get\(p\.id\);\}catch\{\}if\(a\?\.state==='expired'\)\{try\{M\.expire\?\.\(p\.id\);\}catch\{\}return false;\}return true;\}/);});

test('t1260: a merchant-SIGNED order expires the ask at its own deadline (signedOrder.deadline / orderDeadline, also inside payment); ownerApproval is ignored',()=>{
  let t=1_800_000_000_000;const A=createOwnerAsks({db:new DatabaseSync(':memory:'),now:()=>t});const s=Math.floor(t/1000);
  A.put({approvalId:'s1',agentId:'muse',spec:{kind:'pay',args:{signedOrder:{orderId:'ord_3',deadline:s+900}}},payee:P,amount:'200000'});
  A.put({approvalId:'s2',agentId:'muse',spec:{kind:'pay',args:{signedOrder:{orderId:'ord_3',orderDeadline:String(s+900)}}},payee:P,amount:'200000'});
  A.put({approvalId:'s3',agentId:'muse',spec:{kind:'payAny',args:{payment:{signedOrder:{deadline:s+900}}}},payee:P,amount:'200000'});
  A.put({approvalId:'s4',agentId:'muse',spec:{kind:'pay',args:{ownerApproval:{deadline:s+10},signedOrder:{deadline:s+5000}}},payee:P,amount:'200000'});
  for(const id of ['s1','s2','s3','s4'])assert.equal(A.get(id).state,'pending',id);
  t+=901e3;for(const id of ['s1','s2','s3'])assert.equal(A.get(id).state,'expired',id);
  assert.equal(A.get('s4').state,'pending','ownerApproval deadline must not expire the ask');});
