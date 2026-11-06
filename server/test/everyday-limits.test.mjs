import test from 'node:test';import assert from 'node:assert/strict';
import {createEverydayLimits,changeCost,clampEveryday,EVERYDAY_WHY,consentSpend,explicitEveryday} from '../src/v5/everyday-limits.mjs';import {PRINCIPLES,assertPrinciples} from '../src/v5/principles.mjs';
const kv=()=>{const m=new Map();return {get:k=>m.get(k),set:(k,v)=>m.set(k,v),del:k=>m.delete(k)};};
let F={single:10_000_000n,daily:50_000_000n};const mk=()=>createEverydayLimits({kv:kv(),wallet:'0xAbc',floor:()=>F});
test('unset everyday is not the floor and not 10/50/200',()=>{const e=createEverydayLimits({kv:kv(),wallet:'0xAbc',floor:()=>({single:10_000_000n,daily:50_000_000n,term:200_000_000n})});const g=e.get();
  assert.equal(g.authorized,false);assert.equal(g.explicit,false);assert.equal(g.single,null);assert.equal(g.daily,null);assert.equal(g.term,null);
  assert.equal(g.floor.single,'10000000');assert.equal(g.floor.daily,'50000000');
  assert.equal(e.check({amount:1n}).reason,'AI_LIMITS_UNCONFIRMED');assert.equal(e.check({amount:10_000_000n}).nothingPaid,true);
  assert.equal(consentSpend(g).authorized,false);assert.equal(consentSpend({authorized:true,single:'10000000',daily:'50000000',term:'200000000',at:1}).perPayment,'10');});
test('set under floor: free + instant; raise & lower both free',()=>{const e=mk();assert.equal(e.set({single:'2000000',daily:'5000000'}).free,true);assert.equal(e.get().single,'2000000');assert.equal(e.set({single:'9000000',daily:'40000000'}).ok,true);});
test('above floor rejected with why',()=>{const e=mk();const r=e.set({single:'20000000',daily:'60000000'});assert.equal(r.error,'above_floor');assert.match(r.why.zh,/区块链上/);});
test('floor lowered on chain -> everyday clamped on read',()=>{const e=mk();e.set({single:'9000000',daily:'40000000'});F={single:3_000_000n,daily:6_000_000n};assert.deepEqual([e.get().single,e.get().daily],['3000000','6000000']);F={single:10_000_000n,daily:50_000_000n};});
test('engine check blocks over single / over 24h, nothing paid',()=>{const e=mk();e.set({single:'2000000',daily:'5000000'});assert.equal(e.check({amount:3_000_000n}).reason,'EVERYDAY_SINGLE_LIMIT');assert.equal(e.check({amount:2_000_000n,spent24h:4_000_000n}).reason,'EVERYDAY_DAILY_LIMIT');assert.equal(e.check({amount:1_000_000n,spent24h:1n}),null);});
test('free vs charged preview',()=>{assert.equal(changeCost({next:{single:'1',daily:'1'},floor:{single:'5',daily:'5'}}).free,true);const c=changeCost({next:{single:'9',daily:'1'},floor:{single:'5',daily:'5'},feeUSDC:7258n});assert.equal(c.free,false);assert.equal(c.feeUSDC,'7258');});
test('invariant locked',async()=>{assert.equal(PRINCIPLES.everydayBelowFloor??PRINCIPLES.principles?.everydayBelowFloor??true,true);const c=clampEveryday({single:99n,daily:99n},{single:1n,daily:2n});assert.deepEqual(c,{single:1n,daily:2n});assert.doesNotMatch(EVERYDAY_WHY.zh,/ETH/);});
test('t1074 saved AI limits stay distinct from the chain floor on every field',()=>{const floor=()=>({single:10_000_000n,daily:50_000_000n,term:200_000_000n});
  const m=new Map();const store={get:k=>m.get(k),set:(k,v)=>m.set(k,v),del:k=>m.delete(k)};
  const e=createEverydayLimits({kv:store,wallet:'0xabc',floor,now:()=>1710000000000});
  // Exact build-43 POST body: atomic strings, no term, no confirmed flag.
  const saved=e.set({single:'2500000',daily:'7000000'});assert.equal(saved.ok,true);
  const key=[...m.keys()][0];const legacy={single:'2500000',daily:'7000000',at:1710000000000};m.set(key,legacy);
  const g=e.get();assert.equal(g.authorized,true);assert.equal(g.requestedSingle,'2500000');assert.equal(g.requestedDaily,'7000000');assert.equal(g.requestedTerm,null);assert.equal(g.term,null);
  const shown=consentSpend(g);assert.equal(shown.perPayment,'2.5');assert.equal(shown.perDay,'7');assert.equal(shown.termTotal,null);
  assert.notEqual(shown.perPayment,'10');assert.notEqual(shown.perDay,'50');
  // A stored total that is not the floor is kept and shown. A later app save that omits term does not delete it or copy the floor.
  m.set(key,{single:'2500000',daily:'7000000',term:'15000000',at:1710000000000});
  const all=e.get();assert.equal(all.requestedTerm,'15000000');assert.equal(all.term,'15000000');assert.equal(consentSpend(all).termTotal,'15');
  assert.equal(e.set({single:'2500000',daily:'7000000'}).requestedTerm,'15000000');
  // Floor lowered under the save: enforcement clamps, the saved policy stays visible.
  const low=createEverydayLimits({kv:store,wallet:'0xabc',floor:()=>({single:1_000_000n,daily:2_000_000n,term:3_000_000n}),now:()=>1710000000000});
  const c=low.get();assert.equal(c.requestedSingle,'2500000');assert.equal(c.requestedDaily,'7000000');assert.equal(c.requestedTerm,'15000000');
  assert.equal(c.single,'1000000');assert.equal(c.daily,'2000000');assert.equal(c.term,'3000000');assert.equal(c.clamped,true);
  assert.equal(consentSpend(c).perPayment,'2.5');assert.equal(consentSpend(c).termTotal,'15');
  assert.equal(c.floor.single,'1000000');assert.equal(low.check({amount:1_500_000n}).reason,'EVERYDAY_SINGLE_LIMIT');
  // Unset still does not adopt the floor, including its term.
  m.delete(key);const none=e.get();assert.equal(none.authorized,false);assert.equal(none.term,null);assert.equal(consentSpend(none).authorized,false);});
test('t1073 explicit save is kept; numbers alone are not confirmation',()=>{const m=new Map();const store={get:k=>m.get(k),set:(k,v)=>m.set(k,v),del:k=>m.delete(k)};
  const e=createEverydayLimits({kv:store,wallet:'0xAbc',floor:()=>({single:10_000_000n,daily:50_000_000n,term:200_000_000n}),now:()=>1700000000000});
  const saved=e.set({single:'2000000',daily:'5000000',term:'30000000'});assert.equal(saved.authorized,true);assert.equal(saved.term,'30000000');assert.equal(consentSpend(e.get()).termTotal,'30');
  const key=[...m.keys()][0];const legacy={...m.get(key)};delete legacy.confirmed;m.set(key,legacy);
  assert.equal(e.get().authorized,true);assert.equal(e.get().single,'2000000');assert.equal(explicitEveryday(legacy).at,1700000000000);
  m.set(key,{single:'10000000',daily:'50000000',term:'200000000'});assert.equal(e.get().authorized,false);assert.equal(e.get().single,null);assert.equal(e.check({amount:1n}).reason,'AI_LIMITS_UNCONFIRMED');
  m.set(key,{single:'10000000',daily:'50000000',term:'200000000',confirmed:true});assert.equal(e.get().explicit,false);
  m.set(key,{single:'10000000',daily:'1',at:1});assert.equal(e.get().authorized,false);
  m.set(key,{single:'9000000',daily:'40000000',at:2,confirmed:false});assert.equal(e.get().authorized,false);});
