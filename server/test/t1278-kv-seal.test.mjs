// SPDX-License-Identifier: AGPL-3.0-only
// t1278 S8: V5.5 inline trusts (v55inline:<wallet>:<payee>) are personal data: sealed at rest like v54grant; rows written before stay readable.
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {createMemoryKV,sealKV,PERSONAL_KV_SCOPES} from '../src/v5/store.mjs';
const W='0x1000000000000000000000000000000000000001',P='0x2000000000000000000000000000000000000002';

test('t1278 S8: v55inline values are sealed; a plaintext row from before still reads and is sealed on its next write',()=>{
  assert.ok(PERSONAL_KV_SCOPES.includes('v55inline'));const raw=createMemoryKV();const k='v55inline:'+W.toLowerCase()+':'+P.toLowerCase();
  const old={merchant:'0x'+'11'.repeat(32),blob:'0x4b505452aa',single:'5000000',daily:'20000000',expiry:'4102444800',epoch:'0'};raw.put(k,old);
  const kv=sealKV(raw,randomBytes(32));assert.deepEqual(kv.get(k),old,'legacy plaintext row still readable');
  kv.put(k,{...old,epoch:'1'});const stored=raw.get(k);assert.equal(typeof stored.$kpe,'string','sealed at rest');assert.ok(!JSON.stringify(stored).includes('4b505452'));
  assert.equal(kv.get(k).epoch,'1');assert.equal(kv.list('v55inline:'+W.toLowerCase()+':')[0].v.epoch,'1');});
