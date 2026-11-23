import test from 'node:test';import assert from 'node:assert/strict';import {createDeposit,stateOf,fmt,LOW} from '../src/v5/deposit.mjs';import {CJK} from '../src/v5/i18n.mjs';
const W='0x00000000000000000000000000000000000000a1',O='0x00000000000000000000000000000000000000b2',USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const reg={get:w=>w.toLowerCase()===W?{wallet:W,owner:O}:null};
const get=async(D,url,lang='zh-CN',h={})=>{let code,b='',hd={};const ok=await D.handle({method:'GET',headers:{'accept-language':lang,...h}},{writeHead(c,x){code=c;hd=x||{};},end(x){b=String(x??'');}},new URL('https://x'+url));return {ok,code,b,hd};};
const mk=(o,w,extra={})=>createDeposit({reg,token:USDC,script:()=>'js',usdcOf:async a=>a.toLowerCase()===O?o:w,qr:async()=>'<svg>qr</svg>',purchaseGate:async()=>null /* verified owner; gate itself: purchase-gate.test.mjs */,...extra});
const strip=s=>s.replace(/<script type="application\/json"[\s\S]*?<\/script>/,'');
test('deposit: unknown or bad wallet -> 404, other paths not handled',async()=>{const D=mk(0n,0n);
  assert.equal((await get(D,'/deposit?w=0x'+'9'.repeat(40))).code,404);assert.equal((await get(D,'/deposit?w=<x>')).code,404);assert.equal((await get(D,'/other')).ok,false);});
test('deposit: zero balance leads with Coinbase-app send: QR, address, copy, Base warning, check; no one-tap script',async()=>{const D=mk(0n,0n);
  const r=await get(D,'/deposit?w=0x'+'0'.repeat(38)+'a1');assert.equal(r.code,200);
  assert.match(r.b,/从 Coinbase App 转进来/);assert.match(r.b,/<svg>qr<\/svg>/);assert.match(r.b,new RegExp(W,'i'));assert.match(r.b,/id=cp>复制地址/);
  assert.match(r.b,/网络只能选 Base/);assert.match(r.b,/我已转账，查看是否到账/);assert.match(r.b,/启付不收费/);
  assert.doesNotMatch(r.b,/src="\/deposit\.js"/);assert.doesNotMatch(r.b,/id=go/);assert.doesNotMatch(r.b,/银行卡 \/ Apple Pay 购买/);assert.doesNotMatch(r.b,/Base Account/);});
test('deposit: has balance -> one-tap transfer, presets capped by balance, fee copy true, link to send path',async()=>{const D=mk(12_500_000n,3_000_000n);
  const r=await get(D,'/deposit?w='+W);assert.match(r.b,/id=go>转入钱包/);assert.match(r.b,/src="\/deposit\.js"/);assert.match(r.b,/12\.50 USDC/);
  assert.match(r.b,/data-a=5>5</);assert.match(r.b,/data-a=10>10</);assert.match(r.b,/data-a=50 disabled aria-disabled=true>50<small>余额不够/);
  assert.match(r.b,/data-a=100 disabled/);assert.match(r.b,/data-a=1000 disabled[^>]*>1,000<small>余额不够/);assert.doesNotMatch(r.b,/data-a=20/);
  assert.match(r.b,/data-a="12\.5">全部<small>12\.50/);assert.equal((r.b.match(/<button data-a/g)||[]).length,6);assert.match(r.b,/"ob":"12500000"/);assert.match(r.b,/用 USDC 付，不需要 ETH。启付不收任何费用/);
  assert.doesNotMatch(r.b,/mode=send/);assert.match(r.b,new RegExp(USDC));assert.doesNotMatch(r.b,/<svg/);});
test('deposit: too-low balance stays on send path with a secondary one-tap link; mode=tap forces one-tap',async()=>{const D=mk(400_000n,0n);
  const r=await get(D,'/deposit?w='+W);assert.doesNotMatch(r.b,/id=go/);assert.match(r.b,/mode=tap/);assert.match(r.b,/0\.40 USDC/);
  assert.match((await get(D,'/deposit?w='+W+'&mode=tap')).b,/id=go/);assert.doesNotMatch((await get(mk(0n,0n),'/deposit?w='+W+'&mode=tap')).b,/id=go/);
  assert.doesNotMatch((await get(mk(5_000_000n,0n),'/deposit?w='+W+'&mode=send')).b,/id=go/);});
test('deposit: English page has no Chinese in any state',async()=>{for(const [o,w,on] of [[0n,0n,null],[12_000_000n,1n,null],[400_000n,0n,{session:async()=>({url:'https://pay.coinbase.com/x'})}]]){
  const r=await get(mk(o,w,{onramp:on}),'/deposit?w='+W,'en-US');assert.equal(CJK.test(strip(r.b)),false,strip(r.b).match(/.{20}[\u3400-\u9fff].{20}/)?.[0]);assert.match(r.b,/<html lang=en>/);}
  const r=await get(mk(0n,0n),'/deposit?w='+W+'&lang=en');assert.match(r.b,/Send from the Coinbase app/);assert.match(r.b,/on the Base network only/);});
test('deposit: onramp off -> no buy button and ?buy=1 is 404; onramp on -> buy is primary and redirects with wallet + redirectUrl',async()=>{
  assert.equal((await get(mk(0n,0n),'/deposit?w='+W+'&buy=1')).code,404);let seen;
  const D=mk(0n,0n,{onramp:{session:async a=>{seen=a;return {url:'https://pay.coinbase.com/buy/select-asset?sessionToken=t'};}},base:()=>'https://pay.kipurse.com'});
  const p=await get(D,'/deposit?w='+W);assert.match(p.b,/用银行卡 \/ Apple Pay 购买/);assert.ok(p.b.indexOf('id=buy')<p.b.indexOf('id=cp'));
  const r=await get(D,'/deposit?w='+W+'&buy=1&amt=20',undefined,{'cf-connecting-ip':'1.2.3.4'});assert.equal(r.code,302);assert.match(r.hd.location,/^https:\/\/pay\.coinbase\.com\//);
  assert.equal(seen.address.toLowerCase(),W);assert.equal(seen.amount,20);assert.equal(seen.clientIp,'1.2.3.4');assert.match(seen.redirectUrl,/^https:\/\/pay\.kipurse\.com\/deposit\?w=/);
  const bad=mk(0n,0n,{onramp:{session:async()=>{throw Error('x');}}});assert.equal((await get(bad,'/deposit?w='+W+'&buy=1')).code,503);});
test('deposit: ?check=1 returns both balances as strings; RPC failure -> null, page still renders',async()=>{
  const r=await get(mk(7n,9_000_000n),'/deposit?w='+W+'&check=1');assert.deepEqual(JSON.parse(r.b),{wallet:'9000000',owner:'7'});
  const D=createDeposit({reg,token:USDC,script:()=>'js',usdcOf:async()=>{throw Error('rpc');},qr:async()=>''});
  assert.deepEqual(JSON.parse((await get(D,'/deposit?w='+W+'&check=1')).b),{wallet:null,owner:null});const p=await get(D,'/deposit?w='+W);assert.equal(p.code,200);assert.match(p.b,/从 Coinbase App 转进来/);});
test('deposit: helpers',()=>{assert.equal(stateOf(LOW,''),'has');assert.equal(stateOf(LOW-1n,''),'zero');assert.equal(stateOf(null,''),'zero');assert.equal(fmt(1234_560000n),'1,234.56');assert.equal(fmt(0n),'0');});
test('deposit: presets fixed 5/10/50/100/1000; all enabled with a big balance; English hint',async()=>{
  const r=await get(mk(2_000_000_000n,0n),'/deposit?w='+W);assert.doesNotMatch(r.b,/<button data-a=[^>]* disabled/);assert.match(r.b,/data-a=1000>1,000</);assert.match(r.b,/data-a="2000">全部<small>2,000/);
  const e=await get(mk(25_000_000n,0n),'/deposit?w='+W,'en-US');assert.match(e.b,/data-a=50 disabled aria-disabled=true>50<small>Not enough/);assert.match(e.b,/data-a="25">All<small>25/);assert.doesNotMatch(e.b,/data-a=10 disabled/);});
test('deposit.js client: strict 3-digit grouping and balance check',async()=>{const {readFileSync}=await import('node:fs');const js=readFileSync(new URL('../owner-sign/static/deposit.js',import.meta.url),'utf8');
  const src=js.match(/var atomic=(v=>\{.*?return n>0n\?n:null\})/)[1];const atomic=eval(src);
  assert.equal(atomic('2,500'),2_500_000_000n);assert.equal(atomic('1,000,000.5'),1_000_000_500_000n);assert.equal(atomic('25'),25_000_000n);
  for(const bad of ['3,5','35,00','1,00,000','2,5000',',5','12345678','0','abc','1.1234567'])assert.equal(atomic(bad),null,bad);
  assert.match(js,/n>BigInt\(d\.ob\)/);assert.match(js,/if\(b\.disabled\)return;/);});
import {STRAY,returnCalls,checkReturnCalls,fmtU} from '../src/v5/deposit.mjs';import {decodeFunctionData,parseAbi} from 'viem';
const mkS=(sx,extra={})=>mk(0n,0n,{strayOf:async()=>sx,...extra});
test('wrong token: strong USDC-only + Base-only warning on the send page (zh, en)',async()=>{const z=await get(mk(0n,0n),'/deposit?w='+W);
  assert.match(z.b,/只能充 USDC，网络只能选 Base/);assert.match(z.b,/只选 USDC<\/b>（不要选 USDT、ETH/);assert.match(z.b,/启付没法帮你找回/);
  const e=await get(mk(0n,0n),'/deposit?w='+W,'en-US');assert.match(e.b,/USDC only, on the Base network only/);assert.equal(CJK.test(strip(e.b)),false);});
test('wrong token: no stray -> no notice; stray USDT+ETH -> notice + return buttons + script, en has no Chinese',async()=>{
  assert.doesNotMatch((await get(mk(0n,0n),'/deposit?w='+W)).b,/id=stray/);
  const D=mkS({USDT:3_500_000n,ETH:2_000_000_000_000_000n});const r=await get(D,'/deposit?w='+W);
  assert.match(r.b,/收到了 3\.5 USDT，不能用于 AI 支付/);assert.match(r.b,/收到了 0\.002 ETH/);assert.match(r.b,/data-ret="USDT"/);assert.match(r.b,/data-ret="ETH"/);assert.match(r.b,/src="\/deposit\.js"/);
  const e=await get(D,'/deposit?w='+W,'en-US');assert.match(e.b,/Received 3\.5 USDT/);assert.equal(CJK.test(strip(e.b)),false);
  const j=JSON.parse((await get(D,'/deposit?w='+W+'&stray=1')).b);assert.deepEqual(j.stray.map(x=>x.sym),['ETH','USDT']);});
test('wrong token: ?ret builds ONE call to the wallet that pays ONLY the owner; unknown/empty refused',async()=>{const D=mkS({USDT:3_500_000n,ETH:7n});
  const EXA=parseAbi(['function execute(address,uint256,bytes)']);
  const t=JSON.parse((await get(D,'/deposit?w='+W+'&ret=USDT')).b);assert.equal(t.calls.length,1);assert.equal(t.calls[0].to.toLowerCase(),W);
  const a=decodeFunctionData({abi:EXA,data:t.calls[0].data}).args;assert.equal(a[0],STRAY[1].addr);assert.equal(a[1],0n);assert.match(a[2],new RegExp('^0xa9059cbb0{24}'+O.slice(2)));
  const e=JSON.parse((await get(D,'/deposit?w='+W+'&ret=ETH')).b);const b=decodeFunctionData({abi:EXA,data:e.calls[0].data}).args;assert.equal(b[0].toLowerCase(),O);assert.equal(b[1],7n);assert.equal(b[2],'0x');
  assert.equal((await get(D,'/deposit?w='+W+'&ret=USDC')).code,404);assert.equal((await get(D,'/deposit?w='+W+'&ret=DAI')).code,409);});
test('wrong token: checkReturnCalls rejects any other destination, token or shape',()=>{const o={wallet:W,owner:O,asset:STRAY[1]};const ok=returnCalls({...o,amount:5n});assert.equal(checkReturnCalls(ok,o),null);
  const evil='0x00000000000000000000000000000000000000e1';assert.equal(checkReturnCalls(returnCalls({...o,owner:evil,amount:5n}),o),'destination_not_owner');
  assert.equal(checkReturnCalls(returnCalls({...o,asset:STRAY[3],amount:5n}),o),'wrong_token');assert.equal(checkReturnCalls([...ok,...ok],o),'one_call_only');
  assert.equal(checkReturnCalls(returnCalls({wallet:W,owner:evil,asset:STRAY[0],amount:1n}),{...o,asset:STRAY[0]}),'destination_not_owner');
  assert.equal(fmtU(1n,18),'<0.000001');assert.equal(fmtU(1_234_500_000n,6),'1,234.5');});
