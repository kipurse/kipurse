// t1247 (handbook §6#117, App Review 5.1.1(v)): "delete my data" also removes push device tokens and the onramp email/phone verification.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {kvUserParts} from '../src/v5/user-data.mjs';import {createMemoryKV,kvKey} from '../src/v5/store.mjs';
test('erase removes push tokens, move flag, onramp verification and orders of THIS wallet only',async()=>{
  const kv=createMemoryKV();const W='0xAbC0000000000000000000000000000000000001',O='0x00000000000000000000000000000000000000f2';
  kv.put(kvKey('push',W.toLowerCase(),'tokens'),['t1']);kv.put(kvKey('push',W.toLowerCase(),'moved'),{from:'x'});
  kv.put(`onrampv:${W.toLowerCase()}`,{email:'a@b.c',phone:'+1'});kv.put(`onrampo:${W.toLowerCase()}:r1`,{x:1});kv.put(`onrampo:${W.toLowerCase()}:r2`,{x:2});
  kv.put(kvKey('push',O,'tokens'),['other']);kv.put(`onrampv:${O}`,{email:'o'});kv.put(`onrampo:${O}:r1`,{x:3});
  for(const p of kvUserParts(kv))await p.forget(W);
  assert.equal(kv.get(kvKey('push',W.toLowerCase(),'tokens')),undefined);assert.equal(kv.get(kvKey('push',W.toLowerCase(),'moved')),undefined);
  assert.equal(kv.get(`onrampv:${W.toLowerCase()}`),undefined);assert.equal(kv.list(`onrampo:${W.toLowerCase()}:`).length,0);
  assert.deepEqual(kv.get(kvKey('push',O,'tokens')),['other']);assert.ok(kv.get(`onrampv:${O}`));assert.equal(kv.list(`onrampo:${O}:`).length,1);});
test('launcher wires these parts into the erase',()=>{const s=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/parts:\[\{name:'tenant-index'[^\]]*\.\.\.kvUserParts\(KV\)/);});
