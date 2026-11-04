// t735: calm withdraw flow. Recoverable states are friendly cards (never red); the fee step shows before signing;
// the page script keeps the /t/<wallet> API prefix even when it runs on the pinned sign host at path "/".
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createOwnerWithdraw} from '../src/v5/owner-withdraw.mjs';
const W='0x1000000000000000000000000000000000000004',O='0x2000000000000000000000000000000000000002',T='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',F='0xc0dedd749573f2e967a4ba53190c27ffbc2f8b31';
const pub=ob=>({readContract:async({functionName,args})=>functionName==='isOwnerAddress'?true:functionName==='balanceOf'?(args[0]===W?20_000_000n:ob):[0n,300000000000n,0n,0n,0n],estimateGas:async()=>60000n,getGasPrice:async()=>10_000_000n});
const get=async(M,lang='zh')=>{let b='';await M.handle({method:'GET',headers:{'accept-language':lang==='zh'?'zh-CN':'en-US'}},{writeHead(){},setHeader(){},end(x){b=String(x);}},new URL('https://x/owner/withdraw'),{readBody:async()=>({}),ip:'1'});return b;};
test('withdraw page: fee step shown up front only when the owner account is short; money shown as safe; no red',async()=>{
  const low=await get(createOwnerWithdraw({pub:pub(0n),wallet:W,owner:O,token:T,feed:F,script:()=>''}));
  assert.match(low,/id=kpw-fee/);assert.match(low,/先准备一点手续费/);assert.match(low,/钱一直在你的钱包里/);assert.match(low,/0x1000…0004/);assert.match(low,/0x2000…0002/);
  const ok=await get(createOwnerWithdraw({pub:pub(50_000n),wallet:W,owner:O,token:T,feed:F,script:()=>''}));assert.doesNotMatch(ok,/id=kpw-fee/);assert.match(ok,/id=kpw-box/);
  for(const h of [low,ok,await get(createOwnerWithdraw({pub:pub(0n),wallet:W,owner:O,token:T,feed:F,script:()=>''}),'en')])assert.doesNotMatch(h,/#c81e1e/i);});
test('withdraw script: switch account, fee check, friendly cards, never red',()=>{for(const f of ['owner-sign/consent/withdraw.js','owner-sign/static/withdraw.js']){const s=fs.readFileSync(f,'utf8');
  assert.doesNotMatch(s.split('/* /KPVH-GUARD */')[1],/#c81e1e/i,f);assert.match(s,/disconnect/,f);assert.match(s,/ownerCanPayUSDC/,f);assert.match(s,/KPVH-GUARD v1/,f);}
  const src=fs.readFileSync('owner-sign/consent/withdraw.js','utf8');assert.match(src,/换账户/);assert.match(src,/钱还在你的钱包里，没有动/);assert.match(src,/复制地址/);});
test('withdraw script: API base keeps /t/<wallet> on the sign host (path "/"), never "//owner"',()=>{
  const src=fs.readFileSync('owner-sign/consent/withdraw.js','utf8');const fromSrc=src.match(/const from=(\(\(\)=>\{[\s\S]*?\}\)\(\));/)[1],baseSrc=src.match(/const b0=[^\n]*?const api=p=>base\+'\/owner\/withdraw\/'\+p;/)[0];
  const calc=(pathname,hash)=>new Function('location',`const from=${fromSrc};${baseSrc};return api('plan');`)({pathname,hash});
  const w='/t/0x000000000000000000000000000000000000dead';
  assert.equal(calc('/','#u='+encodeURIComponent(w+'/owner/withdraw?plan=1&lang=zh')+'&vh=00'),w+'/owner/withdraw/plan');
  assert.equal(calc(w+'/owner/withdraw',''),w+'/owner/withdraw/plan');
  assert.equal(calc('/v2'+w+'/owner/withdraw','#u='+encodeURIComponent(w+'/owner/withdraw')),w+'/owner/withdraw/plan');
  assert.equal(calc('/owner/withdraw',''),'/owner/withdraw/plan');assert.equal(calc('/',''),'/owner/withdraw/plan');
  for(const bad of ['//evil.example/owner/withdraw','/t/0x12/owner/withdraw','/x/owner/withdraw'])assert.ok(!calc('/','#u='+encodeURIComponent(bad)).startsWith('//'),bad);});
