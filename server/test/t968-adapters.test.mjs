import test from 'node:test';import assert from 'node:assert/strict';
import {TOOLS} from '../sdk/examples/adapters/tools.mjs';import {kipurseOpenAITools} from '../sdk/examples/adapters/openai-agents.mjs';
import {kipurseLangChainTools} from '../sdk/examples/adapters/langchain.mjs';import {claudeTools,handleClaudeToolUse} from '../sdk/examples/adapters/claude.mjs';
const kp={calls:[],limits(){this.calls.push('limits');return {left:'1'};},preflight(r,o){this.calls.push(['pre',r.uri,o.intentId]);return {canPay:true};},pay(o){this.calls.push(['pay',o.intentId]);return {state:'paid'};}};
test('t968: adapters expose the same 3 tools and route to the SDK',async()=>{
  const oa=kipurseOpenAITools(kp,x=>x);assert.equal(oa.length,3);assert.deepEqual(await oa[1].execute({uri:'u',intentId:'i'}),{state:'paid'});
  const lc=kipurseLangChainTools(kp,(f,m)=>({f,...m}));assert.equal(lc[0].name,'kipurse_preflight');assert.match(await lc[2].f({}),/left/);
  assert.equal(claudeTools[0].input_schema.type,'object');const r=await handleClaudeToolUse(kp,{id:'t1',name:'kipurse_preflight',input:{uri:'u',intentId:'i'}});assert.equal(r.tool_use_id,'t1');
  assert.ok(TOOLS.every(t=>!/key|secret/i.test(JSON.stringify(t.parameters))));});
