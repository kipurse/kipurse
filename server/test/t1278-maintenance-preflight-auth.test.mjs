// SPDX-License-Identifier: AGPL-3.0-only
// t1278 S10: fee collection is operator / keeper only (no agent MCP tool, no agent HTTP route); the float is never funded while paused.
// t1278 S11: a preflight that throws fails CLOSED (retry later, nothing sent); a reverting simulation blocks the payment.
// t1278 S12: the agent HTTP API never trusts X-Agent-Id: no agent auth config -> it does not start; 'owner' / 'siri' are never an AI's id.
import test from 'node:test';import assert from 'node:assert/strict';
import {createV5Mcp} from '../src/v5/mcp.mjs';import {createV5HttpServer,RESERVED_AGENT_IDS} from '../src/v5/http.mjs';import {engineFor,direct} from './helpers/v5-fixture.mjs';
const serve=async(engine,opts)=>{const srv=createV5HttpServer(engine,opts);await new Promise(r=>srv.listen(0,'127.0.0.1',r));return {srv,url:`http://127.0.0.1:${srv.address().port}`};};

test('t1278 S10: no kipurse_collect_fees agent tool and no /v1/maintenance/collect-fees route',async()=>{
  const e=engineFor();const {server}=createV5Mcp(e.engine,{agentId:'a1'});const names=Object.keys(server._registeredTools??{});
  assert.ok(names.length>10&&names.includes('kipurse_settle_routine'));assert.ok(!names.includes('kipurse_collect_fees'));
  const {srv,url}=await serve(e.engine,{agentTokens:{'tok-t1278-s10-aaaaaaa':'a1'}});
  try{const r=await fetch(url+'/v1/maintenance/collect-fees',{method:'POST',headers:{authorization:'Bearer tok-t1278-s10-aaaaaaa'},body:'{}'});assert.equal(r.status,404);}finally{srv.close();}
  assert.ok(!e.s.writes.some(w=>w.fn==='collectFees'));});

test('t1278 S10: floatFund refuses while AI payments are paused; nothing funded',async()=>{
  let paused=true;const e=engineFor({isPaused:()=>paused},{floatCap:500000n});const r=await e.engine.floatFund({amount:'100000'});
  assert.equal(r.state,'rejected');assert.equal(r.reason,'wallet_paused_for_safety');assert.equal(r.nothingPaid,true);assert.ok(!e.s.writes.some(w=>w.fn==='fundFloat'));});

test('t1278 S11: preflight throwing (chain read) -> retry_later, nothing claimed or sent; reverting simulation -> refused before sending',async()=>{
  const e=engineFor();const rd=e.client.read;e.client.read=async(f,a)=>{if(f==='termSpent')throw Error('rpc 503');return rd(f,a);};const w0=e.s.writes.length;
  const r=await e.engine.pay({agentId:'owner',request:direct('20000','s11-a'),idempotencyKey:'idem-t1278-s11-1'});
  assert.equal(r.state,'retry_later',JSON.stringify(r));assert.equal(r.reason,'preflight_failed');assert.equal(r.nothingPaid,true);assert.equal(e.s.writes.length,w0);
  const e2=engineFor({},{simRevert:'boom'});const s=await e2.engine.pay({agentId:'owner',request:direct('20000','s11-b'),idempotencyKey:'idem-t1278-s11-2'});
  assert.equal(s.state,'rejected',JSON.stringify(s));assert.equal(s.reason,'simulation_reverted');assert.equal(e2.s.writes.length,0);});

test('t1278 S12: no agent auth config -> the agent API does not start; X-Agent-Id is ignored; owner / siri ids refused',async()=>{
  assert.throws(()=>createV5HttpServer({}),e=>e.code==='agent_auth_config_required');assert.throws(()=>createV5HttpServer({},{}),e=>e.code==='agent_auth_config_required');
  assert.ok(RESERVED_AGENT_IDS.has('owner')&&RESERVED_AGENT_IDS.has('siri'));
  const seen=[];const engine={limits:async({agentId})=>{seen.push(agentId);return {ok:true};}};
  const {srv,url}=await serve(engine,{agentTokens:{'tok-t1278-s12-aaaaaaa':'a1','tok-t1278-s12-owner00':'owner','tok-t1278-s12-siri000':'Siri'}});
  try{const g=(tok,h={})=>fetch(url+'/v1/limits',{headers:{...(tok?{authorization:'Bearer '+tok}:{}),...h}});
    assert.equal((await g(null,{'x-agent-id':'owner'})).status,401,'a header alone is nothing');
    assert.equal((await g('tok-t1278-s12-aaaaaaa',{'x-agent-id':'owner'})).status,200);assert.deepEqual(seen,['a1'],'the token decides, not the header');
    assert.equal((await g('tok-t1278-s12-owner00')).status,403);assert.equal((await g('tok-t1278-s12-siri000')).status,403);assert.equal(seen.length,1);}
  finally{srv.close();}});
