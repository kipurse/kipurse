import test from 'node:test';import assert from 'node:assert/strict';import {createDeposit} from '../src/v5/deposit.mjs';
const W='0x00000000000000000000000000000000000000a1',O='0x00000000000000000000000000000000000000b2',USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const reg={get:w=>w.toLowerCase()===W?{wallet:W,owner:O}:null};
const get=async(D,url,lang='zh-CN')=>{let code,b='';await D.handle({method:'GET',headers:{'accept-language':lang}},{writeHead(c){code=c;},end(x){b=String(x??'');}},new URL('https://x'+url));return {code,b};};
const on={session:async()=>({url:'https://pay.coinbase.com/x'})};
const mk=(o,w)=>createDeposit({reg,token:USDC,script:()=>'js',usdcOf:async a=>a.toLowerCase()===O?o:w,qr:async()=>'<svg>qr</svg>',purchaseGate:async()=>null,onramp:on});
const noEx=b=>{assert.doesNotMatch(b,/Coinbase App|Coinbase app|mode=send|buy=1|id=buy|pay\.coinbase\.com|银行卡|Apple Pay/);};
test('t886: wallet-transfer page has no exchange / Coinbase-app / Onramp entries (zh+en)',async()=>{for(const l of ['zh-CN','en-US']){const r=await get(mk(14_304_957n,0n),'/deposit?w='+W+'&mode=tap',l);assert.match(r.b,/id=go/);noEx(r.b);}});
test('t886: amount param pre-selects; capped at balance; recipient stays the registered wallet',async()=>{const D=mk(14_304_957n,0n);
  let r=await get(D,'/deposit?w='+W+'&mode=tap&amount=10000000');assert.match(r.b,/id=amt inputmode=decimal autocomplete=off value="10"/);assert.match(r.b,/data-a=10 class=on>/);assert.match(r.b,new RegExp('"wallet":"'+W,'i'));
  r=await get(D,'/deposit?w='+W+'&mode=tap&amount=99999999999');assert.match(r.b,/value="14\.304957"/);assert.match(r.b,/data-a="14\.304957" class=on>/);
  r=await get(D,'/deposit?w='+W+'&mode=tap&amount=14304957');assert.match(r.b,/data-a="14\.304957" class=on>/);
  for(const bad of ['-1','0','1e9','abc','1.5','%3Cx%3E']){r=await get(D,'/deposit?w='+W+'&mode=tap&amount='+bad);assert.doesNotMatch(r.b,/ value="/);assert.doesNotMatch(r.b,/class=on/);}
  r=await get(D,'/deposit?w='+W+'&mode=tap');assert.doesNotMatch(r.b,/ value="/);});
test('t886: wallet-only zero balance -> own address, no buy / exchange; default page unchanged',async()=>{
  const r=await get(mk(0n,0n),'/deposit?w='+W+'&mode=tap&amount=5000000');assert.match(r.b,/你的 Coinbase 钱包里没有 USDC/);assert.match(r.b,/<svg>qr<\/svg>/);assert.match(r.b,/id=cp/);assert.doesNotMatch(r.b,/id=go/);noEx(r.b);
  const e=await get(mk(0n,0n),'/deposit?w='+W+'&mode=tap','en-US');assert.match(e.b,/Your Coinbase Wallet has no USDC/);noEx(e.b);
  assert.match((await get(mk(0n,0n),'/deposit?w='+W)).b,/id=buy/);});
