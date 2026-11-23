// t1246 (handbook §6#116 F11): push tokens move from the old wallet to the moved wallet ONCE; a restart never brings back pruned tokens.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
const m=src.match(/const copyPush=\(from,to\)=>\{[\s\S]*?\}catch\{\}\};/);
function make(){const kv=new Map(),logs=[];const KV={get:k=>kv.get(k),put:(k,v)=>kv.set(k,v)};const kvKey=(...p)=>p.join(':');const OBS={log:(e,d)=>logs.push([e,d])};
  const copyPush=new Function('KV','kvKey','OBS',m[0]+';return copyPush;')(KV,kvKey,OBS);return {kv,logs,copyPush,KV,kvKey};}
test('copyPush found in launcher',()=>{assert.ok(m,'copyPush definition');});
test('copies once, then never again (pruned tokens stay pruned)',()=>{const {kv,copyPush,kvKey}=make();const A='0xAAA',B='0xBBB';
  kv.set(kvKey('push','0xaaa','tokens'),['t1','t2']);copyPush(A,B);assert.deepEqual(kv.get(kvKey('push','0xbbb','tokens')),['t1','t2']);
  kv.set(kvKey('push','0xbbb','tokens'),[]);copyPush(A,B);assert.deepEqual(kv.get(kvKey('push','0xbbb','tokens')),[],'restart must not re-copy');
  assert.equal(kv.get(kvKey('push','0xbbb','moved')).from,'0xaaa');});
test('new wallet already has its own token -> nothing copied, marked done',()=>{const {kv,copyPush,kvKey,logs}=make();
  kv.set(kvKey('push','0xaaa','tokens'),['old']);kv.set(kvKey('push','0xbbb','tokens'),['new']);copyPush('0xaaa','0xbbb');
  assert.deepEqual(kv.get(kvKey('push','0xbbb','tokens')),['new']);assert.equal(logs.length,0);
  kv.set(kvKey('push','0xbbb','tokens'),[]);copyPush('0xaaa','0xbbb');assert.deepEqual(kv.get(kvKey('push','0xbbb','tokens')),[]);});
