import test from 'node:test';import assert from 'node:assert/strict';import {liveAgentEngine,AGENT_READ} from '../kit/pause.mjs';
const mk=()=>{const calls=[];return {calls,e:{status:async()=>({ok:1}),pay:async()=>{calls.push('pay');return {state:'paid'}},payAny:async()=>{calls.push('payAny');return {state:'paid'}},setLimits:async()=>{calls.push('l')}}};};
test('t934: pause applied AFTER a session opened still blocks spending (SSE session reuse)',async()=>{
  const {e,calls}=mk();const agent={id:'a1',name:'Muse',paused:false};const p=liveAgentEngine(e,()=>agent);
  assert.equal((await p.pay({amount:1})).state,'paid');
  agent.paused=true;for(const k of ['pay','payAny','setLimits']){const r=await p[k]({amount:1});assert.equal(r.reason,'agent_paused');}
  assert.deepEqual(await p.status(),{ok:1});assert.deepEqual(calls,['pay']);
  agent.paused=false;assert.equal((await p.pay({amount:1})).state,'paid');});
test('t934: revoked / deleted agent can no longer spend on an open session',async()=>{
  const {e,calls}=mk();let agent={id:'a1',name:'Muse'};const p=liveAgentEngine(e,()=>agent);
  agent.revoked=true;assert.equal((await p.pay({amount:1})).reason,'agent_revoked');agent=undefined;assert.equal((await p.payAny({amount:1})).reason,'agent_revoked');assert.deepEqual(calls,[]);});
test('t934: spend tools never in the read allowlist',()=>{for(const k of ['pay','payAny','payMerchantOrder','requestWithdrawal','executeWithdrawal','setLimits','trustSubmit','floatFund'])assert.ok(!AGENT_READ.has(k),k);});
