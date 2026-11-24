// SPDX-License-Identifier: AGPL-3.0-only
// t1278 S1: an aborted request must give its inflight slot back (it never emits 'finish'); a leak used to end in a permanent 503.
// The public agent server gets request / headers timeouts.
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import net from 'node:net';import fs from 'node:fs';
import {createObs,applyServerTimeouts,SERVER_TIMEOUTS} from '../src/v5/obs.mjs';

test('t1278 S1: aborted requests release their inflight slot exactly once; finished ones still count in metrics',async()=>{
  const O=createObs({out:()=>{},maxInflight:3});let release;const gate=new Promise(r=>{release=r;});
  const srv=http.createServer(O.wrap(async(req,res)=>{if(req.url==='/slow'){await gate;if(!res.destroyed){res.writeHead(200);res.end('late');}return;}res.writeHead(200);res.end('ok');}));
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const port=srv.address().port;
  try{
    // 5 clients open /slow and hang up before an answer: more than maxInflight in total
    for(let i=0;i<5;i++){const s=net.connect(port,'127.0.0.1');await new Promise(r=>s.on('connect',r));s.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n');
      await new Promise(r=>setTimeout(r,20));s.destroy();await new Promise(r=>setTimeout(r,20));}
    /* t1279 R7 (§6#139): an aborted request keeps its slot while its handler still runs (3 = maxInflight; the other 2 were shed with 503) */
    await new Promise(r=>setTimeout(r,50));assert.equal(O.inflight(),3,'aborted but still running -> still counted');
    release();for(let i=0;i<50&&O.inflight()!==0;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(O.inflight(),0,'every aborted request gave its slot back once its handler finished');await new Promise(r=>setTimeout(r,20));assert.equal(O.inflight(),0,'never below zero (decrement once)');
    const ok=await fetch(`http://127.0.0.1:${port}/x`);assert.equal(ok.status,200,'not stuck at 503');assert.equal(await ok.text(),'ok');
    await new Promise(r=>setTimeout(r,10));assert.equal(O.inflight(),0);assert.match(O.metrics(),/kipurse_http_requests_total\{route="other",code="2xx"\} 1/);
  }finally{srv.close();}});

test('t1278 S1: server timeouts are set (request 30 s, headers 20 s) and the launcher applies them to the agent server',()=>{
  const s=applyServerTimeouts(http.createServer());assert.equal(s.requestTimeout,SERVER_TIMEOUTS.requestTimeoutMs);assert.equal(s.headersTimeout,SERVER_TIMEOUTS.headersTimeoutMs);
  assert.ok(s.requestTimeout<=30000&&s.headersTimeout<=s.requestTimeout);
  const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');assert.match(L,/applyServerTimeouts\(agentSrv\)/);});
