import test from 'node:test';import assert from 'node:assert/strict';import {validRedirect,mapClient,isGrokBotRegistration,createOAuth} from '../kit/oauth.mjs';
test('listed agents: their real DCR callbacks are accepted and map to the right card',()=>{
  const grok=['cursor://anysphere.cursor-mcp/oauth/callback','https://www.cursor.com/agents/mcp/oauth/callback','http://localhost:8787/callback'];
  assert.ok(grok.every(validRedirect),'Grok Bot');assert.ok(isGrokBotRegistration(grok));
  assert.ok(validRedirect('http://localhost:53118/callback'),'Claude Code loopback');assert.ok(validRedirect('http://127.0.0.1:1455/callback'),'Codex loopback');assert.ok(validRedirect('http://localhost:7777/oauth/callback'),'Gemini CLI');
  assert.ok(!validRedirect('cursor://anysphere.cursor-mcp/other'));assert.ok(!validRedirect('evil://x'));
  assert.equal(mapClient('Grok Bot'),'grok-bot');assert.equal(mapClient('Claude Code'),'claude-code');assert.equal(mapClient('Codex'),'codex');assert.equal(mapClient('Gemini CLI MCP Client'),'gemini-cli');assert.equal(mapClient('Grok'),'grok');});
test('Grok Bot registration with a generic name is labelled Grok Bot (consent page + status card)',async()=>{
  const S={};const O=createOAuth({S,save:()=>{},base:()=>'https://pay.example',createAgentKey:()=>'x',isAgentLive:()=>false,caps:()=>null,ownerSession:()=>false});
  const req={method:'POST',headers:{}};let out,code;const res={writeHead(c){code=c;},end(b){out=JSON.parse(b);}};
  await O.handle(req,res,new URL('https://pay.example/oauth/register'),{readBody:async()=>({client_name:'Cursor',redirect_uris:['cursor://anysphere.cursor-mcp/oauth/callback','https://www.cursor.com/agents/mcp/oauth/callback','http://localhost:8787/callback']}),ip:'1.1.1.1'});
  assert.equal(code,201);assert.equal(out.client_name,'Grok Bot');assert.equal(mapClient(out.client_name),'grok-bot');});
import {redirectMatches} from '../kit/oauth.mjs';
test('loopback callbacks match on any port; everything else exact',()=>{assert.ok(redirectMatches('http://localhost/callback','http://localhost:53118/callback'));assert.ok(redirectMatches('http://127.0.0.1:1/callback','http://127.0.0.1:1455/callback'));
  assert.ok(!redirectMatches('http://localhost/callback','http://localhost:1/other'));assert.ok(!redirectMatches('http://localhost/callback','http://127.0.0.1:5/callback'));assert.ok(!redirectMatches('https://a.com/cb','https://a.com:444/cb'));});
import {isGeminiSparkRegistration} from '../kit/oauth.mjs';
test('Gemini Spark: Google redirector callback accepted, labelled Gemini Spark, own card id',async()=>{
  const cb='https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-107303354335300565420-pay_kipurse_com';
  assert.ok(validRedirect(cb));assert.ok(isGeminiSparkRegistration([cb]));assert.ok(!isGeminiSparkRegistration(['https://evil.googleusercontent.com.x/r']));
  assert.equal(mapClient('Gemini Spark'),'gemini-spark');assert.equal(mapClient('Gemini CLI MCP Client'),'gemini-cli');
  const S={};const O=createOAuth({S,save:()=>{},base:()=>'https://pay.example',createAgentKey:()=>'x',isAgentLive:()=>false,caps:()=>null,ownerSession:()=>false});
  let out,code;const res={writeHead(c){code=c;},end(b){out=JSON.parse(b);}};
  await O.handle({method:'POST',headers:{}},res,new URL('https://pay.example/oauth/register'),{readBody:async()=>({client_name:'Google',redirect_uris:[cb],token_endpoint_auth_method:'client_secret_basic'}),ip:'1.1.1.2'});
  assert.equal(code,201);assert.equal(out.client_name,'Gemini Spark');
  // token endpoint accepts client_id from a Basic header (bad code -> invalid_grant, not a client mismatch crash)
  await O.handle({method:'POST',headers:{authorization:'Basic '+Buffer.from(out.client_id+':x').toString('base64')}},res,new URL('https://pay.example/oauth/token'),{readBody:async()=>({grant_type:'authorization_code',code:'nope'}),ip:'1.1.1.3'});
  assert.equal(code,400);assert.equal(out.error,'invalid_grant');});
