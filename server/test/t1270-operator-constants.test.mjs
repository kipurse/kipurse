// SPDX-License-Identifier: AGPL-3.0-only
// t1270 (owner 2026-11-22): operator constants come from the operator config; the launcher passes only its own fallback defaults.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {operatorConstants} from '../src/v5/operator-constants.mjs';
const A='0x1000000000000000000000000000000000000001',B='0x2000000000000000000000000000000000000002',C='0x3000000000000000000000000000000000000003';
test('config values win; defaults fill only missing keys',()=>{
  assert.deepEqual({...operatorConstants({feeTo:A,paymasters:[B],ownerPaymasters:[C]},{feeTo:C,paymasters:[],ownerPaymasters:[]})},{feeTo:A,paymasters:[B],ownerPaymasters:[C]});
  assert.deepEqual({...operatorConstants(undefined,{feeTo:A,paymasters:[B],ownerPaymasters:[C]})},{feeTo:A,paymasters:[B],ownerPaymasters:[C]});
  assert.deepEqual({...operatorConstants({paymasters:[C]},{feeTo:A,paymasters:[B]})},{feeTo:A,paymasters:[C],ownerPaymasters:[]});});
test('no fee address anywhere (open-source build without config) -> refuses to start',()=>{
  assert.throws(()=>operatorConstants(undefined,{}),/operatorConstants\.feeTo/);assert.throws(()=>operatorConstants({feeTo:'0x12'}),/feeTo/);
  assert.throws(()=>operatorConstants({feeTo:A,paymasters:['nope']}),/paymasters/);assert.throws(()=>operatorConstants([]),/must be an object/);});
test('launcher wiring: fee address and paymasters only through operatorConstants (no literal fee address in the code paths)',()=>{
  const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(L,/const OP=operatorConstants\(X\.operatorConstants,OPERATOR_DEFAULTS\)/);
  assert.match(L,/paymasters:OP\.paymasters,/);assert.match(L,/ownerPaymasters:OP\.ownerPaymasters,feeTo:OP\.feeTo/);assert.match(L,/cfg\.dues=\{to:OP\.feeTo,/);
  const body=L.replace(/\/\/ OPERATOR_DEFAULTS:BEGIN[\s\S]*?\/\/ OPERATOR_DEFAULTS:END/,'');
  assert.doesNotMatch(body,/0xf14ef5dc/i);assert.doesNotMatch(body,/0x82ecf6e2/i);assert.doesNotMatch(body,/0x28da22dc/i);assert.doesNotMatch(body,/0xc0de9762/i);});
