// t1258 (handbook 0A #10, decision 128): ONE daily-cap rule for both trust kinds; the iOS fixture is generated from it.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {trustDailyCap,MAX_FEE_PPM,trustCapsFor} from '../src/v5/owner-ask-approve.mjs';import {withFeeHeadroom} from '../src/v5/abi.mjs';
const rd=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('owner real case: daily 1000 -> 1001 at 0.1%; never more than the owner-signed 0.1%',()=>{
  assert.equal(trustDailyCap(1_000_000_000n,1000n),1_001_000_000n);assert.equal(trustDailyCap(1_000_000_000n,null),1_001_000_000n);
  assert.equal(trustDailyCap(20_000_000n,500n),20_010_000n);assert.equal(trustDailyCap(1n,1000n),2n);assert.equal(MAX_FEE_PPM,1000n);
  for(const d of [1n,999n,5_000_000n,7_777_777n])for(const p of [0n,1n,999n,1000n])assert.equal(trustDailyCap(d,p),withFeeHeadroom(d,p));});
test('inline V5.5 trust uses trustDailyCap with the live fee capped at 0.1%; stored trust uses the same withFeeHeadroom in engine',()=>{
  const s=rd('src/v5/owner-ask-approve.mjs');
  assert.match(s,/const dailyCap=trustDailyCap\(caps\.daily,ppm\);/);assert.match(s,/inlineAskTrust\(\{wallet,payee:a\.payee,name,single:caps\.single,daily:dailyCap,/);
  assert.match(s,/BigInt\(v\)<=MAX_FEE_PPM\)ppm=BigInt\(v\)/);
  assert.match(rd('src/v5/engine.mjs'),/const hd=v=>capsIncludeFee\?BigInt\(v\):withFeeHeadroom\(v,f\.ppm\);/);
  assert.match(rd('mainnet/mainnet-owner-launch.mjs'),/feePpm:async\(\)=>BigInt\(await pub\.readContract\(\{address:'0x8F52D223DF89E388DcB5d39C53f154b9F8F9a67A'/);});
test('the iOS fixture is exactly what this code generates (regenerate with scripts/t1258-trust-caps-fixture.mjs)',async()=>{
  const {execFileSync}=await import('node:child_process');const p=new URL('../../ios/Tests/KipurseCoreTests/t1258-trust-caps.json.txt',import.meta.url);
  if(!fs.existsSync(p))return;   // the iOS repo is not next to this checkout (CI / public export)
  const gen=execFileSync(process.execPath,[new URL('../scripts/t1258-trust-caps-fixture.mjs',import.meta.url).pathname],{encoding:'utf8'});
  assert.equal(fs.readFileSync(p,'utf8'),gen);});
