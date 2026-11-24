// SPDX-License-Identifier: AGPL-3.0-only
// t1278 S6: error responses carry codes, never raw exception text (RPC / bundler URLs can hold API keys).
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createV5HttpServer} from '../src/v5/http.mjs';import {engineFor,direct} from './helpers/v5-fixture.mjs';
const SECRET='https://base-mainnet.example.invalid/v2/KEY-abc123?api_key=SECRET9';

test('t1278 S6: the public pages answer an error code only (phone-signer, limits, trust approval, owner pay, withdraw, sign surface)',()=>{
  for(const f of ['phone-signer','limits-public','trust-approve-public','owner-pay','owner-withdraw','owner-sign-surface','http']){const s=fs.readFileSync(new URL(`../src/v5/${f}.mjs`,import.meta.url),'utf8');
    assert.doesNotMatch(s,/detail:String\(e(\?)?\.message/,f);assert.doesNotMatch(s,/detail:e\.message/,f);assert.doesNotMatch(s,/error:String\(e\.shortMessage\?\?e\.message\)/,f);}});

test('t1278 S6: agent HTTP 500 says internal_error, never the exception text',async()=>{
  const engine={status:async()=>{throw Error('rpc '+SECRET+' down');}};const srv=createV5HttpServer(engine,{agentTokens:{'tok-t1278-s6-aaaaaaaa':'a1'}});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));try{const res=await fetch(`http://127.0.0.1:${srv.address().port}/v1/status`,{headers:{authorization:'Bearer tok-t1278-s6-aaaaaaaa'}});
    assert.equal(res.status,500);const t=await res.text();assert.equal(JSON.parse(t).error,'internal_error');assert.ok(!t.includes('KEY-abc123')&&!t.includes('SECRET9'));}finally{srv.close();}});

test('t1278 S6: a failed send answers and stores the error without URLs or keys',async()=>{
  const e=engineFor();e.client.write=async()=>{throw Error('bundler '+SECRET+' rejected the op');};
  const r=await e.engine.pay({agentId:'owner',request:direct('20000','s6-1'),idempotencyKey:'idem-t1278-s6-1'});
  assert.equal(r.state,'failed',JSON.stringify(r));assert.ok(!JSON.stringify(r).includes('KEY-abc123'));assert.ok(!JSON.stringify(r).includes('SECRET9'));assert.match(r.error,/<url>/);
  assert.ok(!String(e.engine.ledger.get(r.purchaseKey).result).includes('KEY-abc123'),'stored record scrubbed too');});
