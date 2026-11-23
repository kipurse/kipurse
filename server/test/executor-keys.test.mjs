// SPDX-License-Identifier: AGPL-3.0-only
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {randomBytes} from 'node:crypto';import {encodeAbiParameters,parseAbiParameters,getAddress} from 'viem';
import {createExecutorKeyring} from '../src/v5/executor-keys.mjs';import {POLICY_V5_T} from '../src/v5/abi.mjs';
const A='0x1000000000000000000000000000000000000004',B='0x1000000000000000000000000000000000000009';
const permFor=(w,executor)=>{const n=parseAbiParameters(POLICY_V5_T)[0].components?.length??parseAbiParameters(POLICY_V5_T).length;
  const vals=parseAbiParameters(POLICY_V5_T).map((p,i)=>i===0?executor:p.type==='address'?'0x0000000000000000000000000000000000000000':p.type==='bool'?false:0n);
  return {account:w,spender:B,token:B,allowance:'1',period:86400,start:1,end:2,salt:'1',extraData:encodeAbiParameters(parseAbiParameters(POLICY_V5_T),vals)};};
test('per-user executor keys: one key per wallet, encrypted, bound to its own permission, erasable',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ek-'));const key=randomBytes(32);const K=createExecutorKeyring({dir,dataKey:key});
  const a=K.ensure(A),b=K.ensure(B);assert.notEqual(a,b);assert.equal(K.ensure(A),a,'stable');
  const raw=fs.readFileSync(K._file(A));assert.ok(!raw.toString('latin1').includes('"key"'),'encrypted at rest');assert.equal(fs.statSync(K._file(A)).mode&0o077,0);
  assert.equal(K.accountFor(A,permFor(A,a)).address,a);
  assert.throws(()=>K.accountFor(A,permFor(B,b)),/another wallet/);assert.throws(()=>K.accountFor(B,permFor(A,a)),/another wallet/);
  assert.throws(()=>K.accountFor(A,permFor(A,b)),/not this wallet's key/,'A\'s permission naming B\'s key');
  fs.copyFileSync(K._file(A),K._file(B));assert.throws(()=>K.accountFor(B,permFor(B,a)),'swapped file cannot be opened as B');
  const K2=createExecutorKeyring({dir,dataKey:randomBytes(32)});assert.throws(()=>K2.accountFor(A,permFor(A,a)),'wrong data key');
  K.forget(A);assert.equal(fs.existsSync(K._file(A)),false);assert.throws(()=>K.accountFor(A,permFor(A,a)),/no executor key/);
  assert.throws(()=>createExecutorKeyring({dir}),/data key is required/);});
