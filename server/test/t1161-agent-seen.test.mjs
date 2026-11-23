// t1161u (§6#78): every AI's home bead must be honest. Online = really used in the last 5 min; a refused /mcp call says why (reason + agent id only).
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
import {stateAgents,mcpRefusal} from '../src/v5/agent-list.mjs';import {createOAuth} from '../kit/oauth.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');const now=1_800_000_000;
test('OAuth AI stays "authorized" while only its 30-day refresh token is live; truly expired = not connected',()=>{
  const oauthAgents={'grok-bot':{name:'Grok Bot',kind:'grok-bot',created:1},'oauth-claude-desktop':{name:'Claude',kind:'claude-desktop',created:1},'oauth-muse':{name:'Muse',kind:'muse',created:1}};
  const tokens={a:{type:'access',agentId:'grok-bot',exp:now-10},r:{type:'refresh',agentId:'grok-bot',exp:now+86400},c:{type:'access',agentId:'oauth-claude-desktop',exp:now-10},m:{type:'access',agentId:'oauth-muse',exp:now+100}};
  const L=stateAgents({oauthAgents,tokens,nowS:now,lastSeen:{'grok-bot':'2026-11-17T16:40:00Z','oauth-muse':'2026-11-17T16:41:00Z'}});const by=id=>L.find(a=>a.id===id);
  assert.equal(by('grok-bot').connected,true,'refresh token live -> still authorized (idle, not 未连接)');
  assert.equal(by('oauth-claude-desktop').connected,false,'nothing live -> honest 未连接 (owner must reconnect)');
  assert.equal(by('oauth-muse').connected,true);
  assert.equal(by('grok-bot').lastUsed,'2026-11-17T16:40:00Z');assert.equal(by('oauth-muse').lastUsed,'2026-11-17T16:41:00Z');assert.equal(by('oauth-claude-desktop').lastUsed,null);});
test('token-key AIs and Siri report lastUsed by their own id',()=>{
  const L=stateAgents({tokenAgents:[{id:'grok',name:'Grok'},{id:'old',disabled:true}],phoneActive:true,spendOk:()=>true,lastSeen:{grok:'T1',siri:'T2'}});
  assert.deepEqual(L.map(a=>[a.id,a.connected,a.lastUsed]),[['grok',true,'T1'],['siri',true,'T2']]);});
test('mcpRefusal: reason + agent id only, never the token',()=>{
  assert.deepEqual(mcpRefusal({tok:''}),{reason:'no_token',agentId:null});
  assert.equal(mcpRefusal({tok:'kps_x'}).reason,'phone_session_not_agent');
  assert.deepEqual(mcpRefusal({tok:'kpa_x',tokenAgentHit:()=>({id:'grok',disabled:true})}),{reason:'agent_key_disabled',agentId:'grok'});
  assert.deepEqual(mcpRefusal({tok:'kat_x',accessStatus:()=>({reason:'access_expired',agentId:'grok-bot'})}),{reason:'access_expired',agentId:'grok-bot'});
  assert.deepEqual(mcpRefusal({tok:'kat_x',accessStatus:()=>{throw new Error('x');}}),{reason:'unknown_or_expired',agentId:null});
  const r=JSON.stringify(mcpRefusal({tok:'kat_SECRET',accessStatus:()=>({reason:'unknown_or_expired'})}));assert.ok(!r.includes('SECRET'));});
test('oauth.accessStatus tells expired / revoked / refresh-misuse apart',()=>{
  const live=new Set(['grok-bot','oauth-muse']);const S={oauth:{clients:{},pending:{},codes:{},tokens:{}}};const n=Date.now()/1000;
  S.oauth.tokens[sha('A1')]={type:'access',agentId:'grok-bot',exp:n-5};S.oauth.tokens[sha('A2')]={type:'access',agentId:'oauth-gone',exp:n+500};
  S.oauth.tokens[sha('R1')]={type:'refresh',agentId:'oauth-muse',exp:n+500};S.oauth.tokens[sha('A3')]={type:'access',agentId:'oauth-muse',exp:n+500};
  const OA=createOAuth({S,save(){},base:()=>'https://x',createAgentKey(){},isAgentLive:id=>live.has(id),caps:()=>({}),ownerSession:()=>false});
  assert.deepEqual(OA.accessStatus('A1'),{reason:'access_expired',agentId:'grok-bot'});
  assert.deepEqual(OA.accessStatus('A2'),{reason:'agent_revoked',agentId:'oauth-gone'});
  assert.deepEqual(OA.accessStatus('R1'),{reason:'refresh_token_used_as_access',agentId:'oauth-muse'});
  assert.deepEqual(OA.accessStatus('A3'),{reason:'ok',agentId:'oauth-muse'});assert.equal(OA.agentForAccess('A3'),'oauth-muse');
  assert.deepEqual(OA.accessStatus('nope'),{reason:'unknown_or_expired'});assert.equal(OA.agentForAccess('A1'),null,'never treat an expired token as online');});
test('launcher wiring: /mcp logs the refusal reason, /mcp success logs the agent, /v1 REST marks the agent used',()=>{
  const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/OBS\.log\('mcp_refused',\{reason:rf\.reason,kind:rf\.agentId\?\?'none',status:401\}\)/);
  assert.match(s,/OBS\.log\('mcp',\{kind:a\.id\}\)/);
  assert.match(s,/startsWith\('\/v1\/'\)\)\{[^}]*resolveAgent\(agents,[^;]*;if\(va\)seen\(va\.id\);return v1\.emit/);
  assert.match(s,/if\(!a&&tok\)\{const id=OA\.agentForAccess\(tok\);if\(id\)a=\{id\};\}if\(a\)seen\(a\.id\);/);});
