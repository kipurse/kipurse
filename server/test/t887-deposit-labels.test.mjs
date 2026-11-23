import test from 'node:test';import assert from 'node:assert/strict';import {createDeposit} from '../src/v5/deposit.mjs';import {SIGN_ORIGIN} from '../src/v5/cors.mjs';
const W='0x00000000000000000000000000000000000000a1',O='0x00000000000000000000000000000000000000b2',USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const reg={get:w=>w.toLowerCase()===W?{wallet:W,owner:O}:null};
const get=async(D,url,lang='zh-CN')=>{let b='';await D.handle({method:'GET',headers:{'accept-language':lang}},{writeHead(){},end(x){b=String(x??'');}},new URL('https://x'+url));return b;};
const mk=(o,w)=>createDeposit({reg,token:USDC,script:()=>'js',usdcOf:async a=>a.toLowerCase()===O?o:w,qr:async()=>'',purchaseGate:async()=>null});
test('t887: from -> to is obvious: Coinbase 钱包 card first, arrow, then 启付钱包 (zh+en)',async()=>{
  const z=await get(mk(14_304_957n,0n),'/deposit?w='+W+'&mode=tap');const i=z.indexOf('id=src'),a=z.indexOf('id=dir'),d=z.indexOf('id=dst');assert.ok(i>0&&i<a&&a<d,'src < arrow < dst');
  assert.match(z,/从：你的 Coinbase 钱包（Base 账户）现在有/);assert.match(z,/14\.30 USDC/);assert.match(z,/Coinbase 钱包 → 启付钱包/);assert.match(z,/到：你的启付钱包现在有/);assert.doesNotMatch(z,/登录用的 Coinbase 账户/);
  const e=await get(mk(14_304_957n,0n),'/deposit?w='+W+'&mode=tap','en-US');assert.match(e,/From: your Coinbase Wallet \(Base Account\) has/);assert.match(e,/Coinbase Wallet → Kipurse wallet/);assert.match(e,/To: your Kipurse wallet has/);assert.doesNotMatch(e,/signed in with/);});
test('t887: zero state says 启付钱包, no ambiguous 钱包现在有',async()=>{const z=await get(mk(0n,0n),'/deposit?w='+W+'&mode=tap');assert.match(z,/启付钱包现在有/);assert.doesNotMatch(z,/>钱包现在有/);});
test('t887: CORS allows the new kipurse.com sign host and keeps the old one',()=>{assert.ok(SIGN_ORIGIN.test('https://sign.kipurse.com'));assert.ok(SIGN_ORIGIN.test('https://kipurse-sign.example.workers.dev'));assert.ok(!SIGN_ORIGIN.test('https://sign.kipurse.com.evil.io'));assert.ok(!SIGN_ORIGIN.test('https://evilsign.kipurse.com'));});
