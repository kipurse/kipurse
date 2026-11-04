// t595 item 1: x402 (HTTP 402, exact / EIP-3009 on Base USDC) through the SAME pay entry and rules.
import test from 'node:test';import assert from 'node:assert/strict';import {getAddress} from 'viem';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {engineFor,USDC} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';
import {detect} from '../src/v4/detector.mjs';import {x402Header} from '../src/v5/engine.mjs';
const PAY=getAddress('0x00110000000000000000000000000000000000aa');const SCAM=getAddress('0x101ce0cedd142f199c9ef61739ae59b6611a0fc0');
const req=(amount,payTo,o={})=>({scheme:'exact',network:'eip155:84532',amount:String(amount),asset:USDC,payTo,maxTimeoutSeconds:60,extra:{name:'USDC',version:'2',...o}});
const v2=accepts=>({status:402,headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify({x402Version:2,resource:{url:'https://m.example/x'},accepts})).toString('base64')}});
function mk(state){const seen=[];const f=async(u,i)=>{const h=Object.entries(i?.headers??{}).find(([k])=>/payment/i.test(k));
    if(!h){const r=v2([req(state.amount,state.payTo)]);return new Response('',r);}seen.push(h);
    return new Response('content',{status:200,headers:{'PAYMENT-RESPONSE':Buffer.from(JSON.stringify({success:true,transaction:'0x'+'ab'.repeat(32),network:'eip155:84532'})).toString('base64')}});};
  const e=engineFor({fetch:f,ownerRulesDir:mkdtempSync(join(tmpdir(),'x4-'))},{bal:1000000000n},{openSingle:'500000000',openDaily:'900000000',single:'500000000',daily:'900000000',term:'900000000'});
  const ok=()=>{for(const p of e.engine.mandates.proposals())assert.equal(e.engine.mandates.approve(p.id,()=>true).ok,true);};
  e.engine.mandates.propose({items:BEGINNER_DEFAULTS.map(d=>({...d}))});ok();
  return {...e,seen,ok,buy:createBuy(e.engine,{sleep:async()=>{},waitMs:0})};}
test('detector: exact/eip3009 only; permit2-first list falls through to eip3009; permit2-only, other asset, other chain refused',()=>{
  const n=detect(v2([req(1,PAY,{assetTransferMethod:'permit2'}),req(1,PAY)]),{chains:[84532]});assert.equal(n.ok,true);assert.equal(n.mode,'eip3009');
  assert.match(detect(v2([req(1,PAY,{assetTransferMethod:'permit2'})]),{chains:[84532]}).detail??'',/unsupported_transfer_method/);
  assert.equal(detect(v2([{...req(1,PAY),asset:'0x0000000000000000000000000000000000000001'}]),{chains:[84532]}).ok,false);
  assert.equal(detect(v2([{...req(1,PAY),network:'eip155:8453'}]),{chains:[84532]}).ok,false);});
test('header builder: v2 PAYMENT-SIGNATURE / v1 X-PAYMENT, signature = reserved digest, from = vault',()=>{
  const n=detect(v2([req(5,PAY)]),{chains:[84532]});const a={from:'0xV',to:PAY,value:'5',validAfter:'0',validBefore:'9',nonce:'0x01'};
  const h=x402Header(n,'0xd1',a);assert.equal(h.name,'PAYMENT-SIGNATURE');const p=JSON.parse(Buffer.from(h.value,'base64').toString());
  assert.equal(p.x402Version,2);assert.equal(p.payload.signature,'0xd1');assert.deepEqual(p.payload.authorization,a);assert.equal(p.accepted.payTo,PAY);
  const h1=x402Header({...n,standard:'x402-v1',raw:{network:'base-sepolia'}},'0xd1',a);assert.equal(h1.name,'X-PAYMENT');assert.equal(JSON.parse(Buffer.from(h1.value,'base64').toString()).x402Version,1);});
test('pay entry: new x402 payee = ONE Face ID, then paid with 0.1% fee + actual gas, header carries vault + digest, PAYMENT-RESPONSE read',async()=>{
  const s={amount:2_000_000,payTo:PAY};const {buy,ok,seen}=mk(s);
  const r0=await buy.buy({item:'api call',merchant:'M',url:'https://m.example/1',idempotencyKey:'idem-x4-0001'},'g');assert.equal(r0.decision,'ask_owner');assert.equal(r0.nothingPaid,true);assert.equal(seen.length,0);
  ok();const r=await buy.buy({item:'api call',merchant:'M',url:'https://m.example/1',idempotencyKey:'idem-x4-0001'},'g');
  assert.equal(r.state,'paid',JSON.stringify(r));assert.equal(r.route,'x402');assert.equal(r.fee,'2000','0.1% of 2 USDC');assert.equal(r.gasRecovery,'0','no markup');
  assert.equal(BigInt(r.total),2_000_000n+2000n+BigInt(r.networkFee));assert.equal(seen.length,1);assert.equal(seen[0][0],'PAYMENT-SIGNATURE');
  const p=JSON.parse(Buffer.from(seen[0][1],'base64').toString());assert.equal(p.payload.signature,r.digest);assert.equal(p.payload.authorization.from,r.auth.from);assert.equal(p.payload.authorization.value,'2000000');
  assert.equal(r.settlement?.transaction,'0x'+'ab'.repeat(32),'PAYMENT-RESPONSE parsed');assert.doesNotMatch(r.say_to_user,/额度内/);});
test('pay entry: over the ONE limit asks (nothing paid); payTo swap asks; scam payTo refused; nothing signed in any case',async()=>{
  const s={amount:2_000_000,payTo:PAY};const {buy,ok,seen}=mk(s);
  await buy.buy({item:'a',merchant:'M',url:'https://m.example/1',idempotencyKey:'idem-x4-0101'},'g');ok();
  assert.equal((await buy.buy({item:'a',merchant:'M',url:'https://m.example/1',idempotencyKey:'idem-x4-0101'},'g')).state,'paid');const n0=seen.length;
  s.amount=6_000_000;const big=await buy.buy({item:'b',merchant:'M',url:'https://m.example/2',idempotencyKey:'idem-x4-0102'},'g');assert.equal(big.decision,'ask_owner','6 > 5 per payment');assert.equal(big.nothingPaid,true);
  s.amount=1_000_000;s.payTo=getAddress('0x00220000000000000000000000000000000000bb');const sw=await buy.buy({item:'c',merchant:'M',url:'https://m.example/3',idempotencyKey:'idem-x4-0103'},'g');assert.equal(sw.decision,'ask_owner');assert.equal(sw.nothingPaid,true);
  s.payTo=SCAM;const sc=await buy.buy({item:'d',merchant:'M',url:'https://m.example/4',idempotencyKey:'idem-x4-0104'},'g');assert.notEqual(sc.state,'paid');assert.equal(sc.nothingPaid,true);
  assert.equal(seen.length,n0,'no payment header sent for any refused case');});
