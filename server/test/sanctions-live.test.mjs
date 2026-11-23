import test from 'node:test';import assert from 'node:assert';import fs from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createSanctions,liveReader,loadSnapshot} from '../src/v5/sanctions.mjs';
test('weekly live sanctions file: adds blocks, can never unblock, ignores short/corrupt files, picks up changes',async()=>{
  const d=fs.mkdtempSync(join(tmpdir(),'sx-'));const f=join(d,'live.json');const vend=[...loadSnapshot().set];
  const NEW='0x'+'ab'.repeat(20);const many=n=>Array.from({length:n},(_,i)=>'0x'+i.toString(16).padStart(40,'0'));
  let t=0;const S=()=>createSanctions({live:liveReader(f,{now:()=>t+=61e3})});
  assert.equal(await S().check(NEW),null,'no live file -> vendored only');
  fs.writeFileSync(f,JSON.stringify({snapshotDate:'2026-11-01',addresses:[NEW,...many(60)]}));
  const s=S();assert.match((await s.check(NEW)).source,/^ofac_sdn_live_2026-11-01/);
  assert.ok((await s.check(vend[0])),'vendored still blocked even though the live file omits it');
  fs.writeFileSync(f,JSON.stringify({snapshotDate:'2026-11-08',addresses:[NEW]}));fs.utimesSync(f,new Date(),new Date(Date.now()+5000));
  assert.ok(await s.check(NEW),'a suspiciously short update is ignored (previous list kept)');
  fs.writeFileSync(f,'{broken');assert.ok(await S().check(vend[0]));assert.equal(await S().check(NEW),null,'corrupt file on a fresh start: vendored only, no crash');});
