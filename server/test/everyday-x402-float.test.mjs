// t621 #6 / #8: x402 amounts learned from the 402 are re-checked against the everyday limits before signing; the float counts as spent.
import test from 'node:test';import assert from 'node:assert/strict';import {getAddress} from 'viem';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {engineFor,USDC} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';import {createEverydayLimits} from '../src/v5/everyday-limits.mjs';
const PAY=getAddress('0x00110000000000000000000000000000000000aa');
const req=(amount,payTo)=>({scheme:'exact',network:'eip155:84532',amount:String(amount),asset:USDC,payTo,maxTimeoutSeconds:60,extra:{name:'USDC',version:'2'}});
const v2=a=>({status:402,headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify({x402Version:2,resource:{url:'https://m.example/x'},accepts:a})).toString('base64')}});
function mk(state,ev){const seen=[];const f=async(u,i)=>{const h=Object.entries(i?.headers??{}).find(([k])=>/payment/i.test(k));if(!h)return new Response('',v2([req(state.amount,state.payTo)]));seen.push(h);
    return new Response('ok',{status:200,headers:{'PAYMENT-RESPONSE':Buffer.from(JSON.stringify({success:true,transaction:'0x'+'ab'.repeat(32),network:'eip155:84532'})).toString('base64')}});};
  const m=new Map();const EVD=createEverydayLimits({kv:{get:k=>m.get(k),set:(k,v)=>m.set(k,v),del:k=>m.delete(k)},wallet:'0xAbc',floor:()=>({single:500_000_000n,daily:900_000_000n})});EVD.set({...ev,term:ev.term??'500000000'});
  const e=engineFor({fetch:f,ownerRulesDir:mkdtempSync(join(tmpdir(),'x4e-')),everydayCheck:a=>EVD.check(a),everydayGet:()=>EVD.get()},{bal:1000000000n},{openSingle:'500000000',openDaily:'900000000',single:'500000000',daily:'900000000',term:'900000000'});
  const ok=()=>{for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);};e.engine.mandates.propose({items:BEGINNER_DEFAULTS.map(d=>({...d}))});ok();
  return {...e,seen,ok,buy:createBuy(e.engine,{sleep:async()=>{},waitMs:0})};}
const b=(n,url)=>({item:'api',merchant:'M',url,idempotencyKey:'idem-ev-'+n});
test('#6 x402: an approved payee whose 402 asks for more than the everyday single limit is refused before signing',async()=>{
  const s={amount:1_000_000,payTo:PAY};const {buy,ok,seen}=mk(s,{single:'3000000',daily:'4000000'});
  await buy.buy(b('0001','https://m.example/1'),'g');ok();assert.equal((await buy.buy(b('0001','https://m.example/1'),'g')).state,'paid');const n0=seen.length;
  s.amount=3_500_000;const r=await buy.buy(b('0002','https://m.example/2'),'g');assert.notEqual(r.state,'paid');assert.equal(r.nothingPaid,true);
  assert.match(JSON.stringify(r),/EVERYDAY_SINGLE_LIMIT|ask_owner/);assert.equal(seen.length,n0,'no payment header sent');});
test('#6 x402: the 24h everyday total includes x402 payments',async()=>{
  const s={amount:2_500_000,payTo:PAY};const {buy,ok,seen}=mk(s,{single:'3000000',daily:'4000000'});
  await buy.buy(b('0101','https://m.example/1'),'g');ok();assert.equal((await buy.buy(b('0101','https://m.example/1'),'g')).state,'paid');const n0=seen.length;
  const r=await buy.buy(b('0102','https://m.example/3'),'g');assert.notEqual(r.state,'paid');assert.equal(r.nothingPaid,true);assert.match(JSON.stringify(r),/EVERYDAY_DAILY_LIMIT|ask_owner/);assert.equal(seen.length,n0);});
test('#8 float: funding over the everyday 24h limit is refused, nothing funded',async()=>{
  const {engine}=mk({amount:1,payTo:PAY},{single:'3000000',daily:'4000000'});
  const r=await engine.floatFund({amount:'5000000'});assert.equal(r.state,'rejected');assert.equal(r.reason,'EVERYDAY_DAILY_LIMIT');assert.equal(r.nothingPaid,true);});
