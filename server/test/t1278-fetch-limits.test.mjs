// SPDX-License-Identifier: AGPL-3.0-only
// t1278 S5: every merchant / x402 / discovery request has a default 15 s deadline and reads at most 256 KB of body AFTER decompression
// (a gzip bomb stops at the cap; nothing is inflated past it).
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import zlib from 'node:zlib';
import {pinnedFetch,guardFetch,readCapped,FETCH_LIMITS} from '../src/v5/ssrf.mjs';import {discoverMerchant} from '../src/v5/discovery.mjs';
import {engineFor} from './helpers/v5-fixture.mjs';

test('t1278 S5: limits are 15 s and 256 KB',()=>{assert.equal(FETCH_LIMITS.timeoutMs,15000);assert.equal(FETCH_LIMITS.maxBodyBytes,256*1024);});

test('t1278 S5: pinnedFetch caps the DECOMPRESSED body (gzip bomb) and has a default deadline',async()=>{
  const bomb=zlib.gzipSync(Buffer.alloc(8*1024*1024,0x61));let hang=null;
  const srv=http.createServer((q,s)=>{if(q.url==='/bomb'){s.writeHead(200,{'content-encoding':'gzip'});return s.end(bomb);}if(q.url==='/small'){s.writeHead(200);return s.end('hello');}hang=s;});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const port=srv.address().port;const F=pinnedFetch({address:'127.0.0.1',family:4},{timeoutMs:300});
  try{assert.ok(bomb.length<64*1024,'the compressed bomb itself is small');
    const b=await readCapped(await F(`http://x.invalid:${port}/bomb`));assert.equal(b.truncated,true);assert.ok(b.text.length<=FETCH_LIMITS.maxBodyBytes);
    await assert.rejects((await F(`http://x.invalid:${port}/bomb`)).text(),'reading past the cap fails');
    assert.deepEqual(await readCapped(await F(`http://x.invalid:${port}/small`)),{text:'hello',truncated:false});
    const t0=Date.now();await assert.rejects(F(`http://x.invalid:${port}/hang`));assert.ok(Date.now()-t0<3000,'default deadline fired');}
  finally{hang?.destroy();srv.close();}});

test('t1278 S5: guardFetch adds a default deadline signal; readCapped stops at the cap for any Response',async()=>{
  let seen=null;const f=guardFetch(async(u,o)=>{seen=o;return new Response('x'.repeat(300*1024));},{resolve:async()=>[{address:'93.184.216.34'}]});
  const r=await f('https://shop.example/a');assert.ok(seen.signal instanceof AbortSignal,'a deadline is always attached');
  const c=await readCapped(r);assert.equal(c.truncated,true);assert.equal(c.text.length,256*1024);});

test('t1278 S5: a merchant doc larger than 256 KB is not parsed (discovery); an oversize 402 body pays nothing',async()=>{
  const big={paths:{},pad:'y'.repeat(300*1024)};const f=async u=>new Response(JSON.stringify(big),{status:200,headers:{'content-type':'application/json'}});
  await assert.rejects(discoverMerchant('https://merchant.mock',{fetch:f}),e=>e.code==='no_merchant_docs');
  const e=engineFor({fetch:async()=>new Response('{"x402Version":2,"pad":"'+'z'.repeat(300*1024)+'"}',{status:402})});const w0=e.s.writes.length;
  const r=await e.engine.paidFetch({agentId:'a1',url:'https://api.example/r/1',idempotencyKey:'idem-t1278-s5-1'});
  assert.equal(r.state,'rejected');assert.equal(r.reason,'x402_response_too_large');assert.equal(r.nothingPaid,true);assert.equal(e.s.writes.length,w0);});
