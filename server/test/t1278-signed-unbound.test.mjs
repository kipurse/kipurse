// SPDX-License-Identifier: AGPL-3.0-only
// t1278 S2: a signed order the AI hands in must be bound to THIS wallet (payer = wallet) on EVERY suite, not only V5.4 with the grant hook.
// An unbound order (payer 0) from a merchant signer the owner trusts could be someone else's order planted for this wallet's AI.
// Server-fetched orders (autoSignedOrder / signed54 / attestor / layered) carry an internal flag the AI cannot set.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {zeroAddress} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {engineFor,ADAPTER,WALLET,MERCH} from './helpers/v5-fixture.mjs';
const T={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},{name:'adapter',type:'address'},{name:'payer',type:'address'}]};
const PAYEE='0x0000000000000000000000000000000000127801';let n=0;const idem=()=>'idem-t1278-s2-'+(++n);
async function order(acct,payer,i){const msg={payee:PAYEE,amount:500000n,orderId:'0x'+String(i).padStart(64,'0'),deadline:BigInt(Math.floor(Date.now()/1000)+3600),chainId:84532n,adapter:ADAPTER,payer};
  const signature=await acct.signTypedData({domain:{name:'AgentWalletPaymentOrder',version:'5',chainId:84532,verifyingContract:ADAPTER},types:T,primaryType:'PaymentOrder',message:msg});
  return {signedOrder:{version:'kipurse.signed-order.v1',payee:PAYEE,amount:'500000',orderId:msg.orderId,deadline:String(msg.deadline),chainId:'84532',adapter:ADAPTER,signer:acct.address,signature,payer}};}
/** a V5 wallet (no V5.4 grant hook) whose owner trusts this merchant signer and its payee on chain */
function mk(){const acct=privateKeyToAccount(generatePrivateKey());const e=engineFor({},{trusted:{[PAYEE.toLowerCase()]:true}});const rd=e.client.read;
  e.client.read=async(fn,args)=>fn==='trustedSigner'&&String(args[1]).toLowerCase()===acct.address.toLowerCase()?[MERCH,1n]:rd(fn,args);return {...e,acct};}

test('t1278 S2: an AI-supplied UNBOUND signed order from an owner-trusted signer is refused on a V5 wallet (no grant hook); nothing sent',async()=>{
  const {engine,s,acct}=mk();const w0=s.writes.length;
  const p=await engine.parse((await order(acct,zeroAddress,1)));assert.equal(p.ok,false);assert.equal(p.code,'order_payer_unbound');
  const r=await engine.pay({agentId:'a1',request:await order(acct,zeroAddress,2),idempotencyKey:idem()});
  assert.equal(r.state,'rejected',JSON.stringify(r));assert.equal(r.reason,'order_payer_unbound');assert.equal(s.writes.length,w0,'nothing sent');});

test('t1278 S2: the same merchant order bound to THIS wallet is paid on the signed route',async()=>{
  const {engine,s,acct}=mk();const r=await engine.pay({agentId:'a1',request:await order(acct,WALLET,3),idempotencyKey:idem()});
  assert.equal(r.state,'paid',JSON.stringify(r));assert.ok(s.writes.some(w=>w.fn==='paySigned'));});

test('t1278 S2: only server-made requests carry the bypass flag (a Symbol, never JSON); every server-fetched path uses it',()=>{
  const src=fs.readFileSync(new URL('../src/v5/engine.mjs',import.meta.url),'utf8');
  assert.match(src,/const SERVER_ORDER=Symbol\('serverFetchedOrder'\)/);assert.match(src,/if\(!server&&lc\(o\.payer\?\?ZERO\)===lc\(ZERO\)\)return \{ok:false,code:'order_payer_unbound'/);
  assert.doesNotMatch(src,/!V51&&typeof cfg\.signerGrant==='function'&&lc\(o\.payer\?\?ZERO\)===lc\(ZERO\)/,'no longer V5.4-only');
  for(const re of [/request:serverReq\(so\.signedOrder\)/,/request:serverReq\(so\)\}\);return done\(r,v,\{attested:true\}\)/,/const req=serverReq\(\{version:'kipurse\.signed-order\.v1'/,/idempotencyKey:ik,request:serverReq\(so\)/])assert.match(src,re);
  assert.equal(JSON.parse(JSON.stringify({signedOrder:{},[Symbol('x')]:true})).signedOrder!==undefined,true);});
