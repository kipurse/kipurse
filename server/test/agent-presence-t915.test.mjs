// t915: real presence. lastUsed only from real authenticated calls; Siri listed once the Face ID phone signer is active.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createSiriAgent} from '../src/v5/siri.mjs';
test('siri: every authenticated Siri call marks it seen; unauthenticated calls never do',async()=>{const seen=[];
  const S=createSiriAgent({}, {buyFactory:()=>({buy:async()=>({ok:1}),orderStatus:async()=>({ok:1}),allowances:()=>({ok:1})})});
  await S.handle('/siri/allowances',{}, {authed:false,seen:id=>seen.push(id)});assert.deepEqual(seen,[]);
  await S.handle('/siri/allowances',{}, {authed:true,seen:id=>seen.push(id)});
  await S.handle('/siri/status',{purchaseKey:'k'},{authed:true,seen:id=>seen.push(id)});
  await S.handle('/siri/buy',{item:'x'},{authed:true,seen:id=>seen.push(id)});assert.deepEqual(seen,['siri','siri','siri']);});
test('wallet state: Siri entry comes from the active phone signer, lastUsed from real calls only',()=>{const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/if\(S\.phone\?\.active\|\|S\.siriAgent\)/);
  assert.match(s,/connected:!!S\.phone\?\.active&&spendOk/,'an enrolled phone is not AI spend permission until an explicit total policy exists');
  assert.match(s,/lastUsed:S\.agentLastSeen\[a\.id\]\?\?null/);assert.match(s,/if\(a\)seen\(a\.id\)/,'MCP calls mark the agent seen');});
