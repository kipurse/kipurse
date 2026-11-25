// t991: a withdrawal that already succeeded on chain must never show "[zh]" because the status poll was rate limited.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {writeLimited,WRITE_LIMITS} from '../src/v5/router.mjs';import {createMemoryKV} from '../src/v5/store.mjs';

test('router: withdraw status polls have their own budget (40 polls after 4 writes are not limited)',()=>{
  const kv=createMemoryKV(),ip='203.0.113.9';
  for(const p of ['quote','prepare','plan','submitted'])assert.equal(writeLimited(kv,'/t/0x'+'1'.repeat(40)+'/owner/withdraw/'+p,ip),null);
  for(let i=0;i<40;i++)assert.equal(writeLimited(kv,'/t/0x'+'1'.repeat(40)+'/owner/withdraw/confirm',ip),null,'poll '+i);
  const poll=WRITE_LIMITS.find(l=>l.name==='owner-poll');assert.ok(poll&&poll.re.test('/owner/withdraw/confirm'));
  assert.ok(!WRITE_LIMITS.find(l=>l.name==='owner-anon').re.test('/owner/withdraw/confirm'));});

test('router: money-moving withdraw steps keep the strict 10 per 10 min limit',()=>{
  const kv=createMemoryKV(),ip='203.0.113.10';let hit=null;
  for(let i=0;i<11;i++)hit=writeLimited(kv,'/owner/withdraw/prepare',ip);assert.equal(hit,'owner-anon');});

test('owner-withdraw handler: confirm polls use a separate per-minute bucket',()=>{
  const s=fs.readFileSync('src/v5/owner-withdraw.mjs','utf8');
  assert.match(s,/limited\(ip\?\?'',p==='\/owner\/withdraw\/confirm'\)/);assert.match(s,/poll\?60:20/);});

test('withdraw page: a failed or limited poll after sending is not a failure (source and shipped bundle)',()=>{
  const src=fs.readFileSync('owner-sign/consent/withdraw.js','utf8');
  assert.match(src,/post\(api\('confirm'\),\{id:pl\.id\}\)\.catch\(\(\)=>\(\{ok:false\}\)\)/);
  const b=fs.readFileSync('owner-sign/static/withdraw.js','utf8');
  assert.match(b,/Qa\(ei\("confirm"\),\{id:r\.id\}\)\.catch\(\(\)=>\(\{ok:!1\}\)\)/);});

test('withdraw page copy: fee wording (no 垫)',()=>{
  const s=fs.readFileSync('src/v5/owner-withdraw.mjs','utf8');
  assert.match(s,/手续费以 USDC 从余额中扣除，Kipurse 不另收费。/);assert.doesNotMatch(s,/不垫/);});
