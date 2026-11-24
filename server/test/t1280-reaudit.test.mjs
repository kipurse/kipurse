// SPDX-License-Identifier: AGPL-3.0-only
// t1280 (handbook §6#140): regressions for the second re-audit server findings.
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import net from 'node:net';
import {createObs} from '../src/v5/obs.mjs';import {withLang} from '../src/v5/i18n.mjs';import {withSignCors} from '../src/v5/cors.mjs';
const raw=(port,line)=>new Promise(r=>{const s=net.connect(port,'127.0.0.1',()=>s.write(line+'\r\nHost: x\r\nConnection: close\r\n\r\n'));let b='';s.on('data',d=>b+=d);s.on('close',()=>r(b));s.on('error',()=>r(b));});
test('Q1: a malformed URL or a throwing handler never becomes an unhandled rejection; the server keeps answering',async()=>{
  const seen=[];const onRej=e=>seen.push(e);process.on('unhandledRejection',onRej);
  const logs=[];const O=createObs({out:s=>logs.push(s)});
  const srv=http.createServer(withSignCors(withLang(O.wrap(async(req,res)=>{if(req.url==='/boom')throw Object.assign(Error('x https://rpc.example/KEY'),{code:'E'});res.end('ok');}))));
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const port=srv.address().port;
  try{const a=await raw(port,'GET // HTTP/1.1');assert.match(a,/^HTTP\/1\.1 /,'answered');
    const b=await raw(port,'GET /boom HTTP/1.1');assert.match(b,/^HTTP\/1\.1 500/);assert.ok(!/rpc\.example|KEY/.test(b));
    await new Promise(r=>setTimeout(r,50));assert.equal(seen.length,0,'no unhandled rejection');
    const c=await raw(port,'GET /ok HTTP/1.1');assert.match(c,/ok$/);assert.equal(O.inflight(),0);}
  finally{process.off('unhandledRejection',onRej);await new Promise(r=>srv.close(r));}});

import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {engineFor,TRUSTED,USDC} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';
const mkE=()=>{const e=engineFor({ownerRulesDir:mkdtempSync(join(tmpdir(),'t1280-'))},{bal:5000000000n,delayMs:1,trusted:{[TRUSTED.toLowerCase()]:true}},{openSingle:'10050000',openDaily:'900000000',single:'100050000',daily:'900000000',term:'900000000'});
  e.engine.mandates.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);return e;};
const payT=(e,ref,{amount='1',agentId='grok',...x}={})=>e.engine.payAny({agentId,payment:{to:TRUSTED,amount},merchant:'Shop',orderRef:ref,idempotencyKey:'idem-'+ref,...x});
const paidWrites=e=>e.s.writes.filter(w=>w.fn==='payDirect').length;

test('dup guard: same payee + same amount within 10 min under another order -> not paid; allowSameAmount cannot skip it; other amounts / the owner unaffected',async()=>{
  const e=mkE();assert.equal((await payT(e,'o-0001')).state,'paid');
  const r=await payT(e,'o-0002');assert.equal(r.state,'rejected');assert.equal(r.reason,'POSSIBLE_DUPLICATE_PURCHASE');assert.equal(r.nothingPaid,true);assert.equal(paidWrites(e),1);
  assert.equal((await payT(e,'o-0003',{allowSameAmount:true})).reason,'POSSIBLE_DUPLICATE_PURCHASE','the AI cannot override');
  assert.equal((await payT(e,'o-0004',{amount:'0.5'})).state,'paid','different amount pays');
  {const w=paidWrites(e);const r1=await payT(e,'o-0001');assert.ok(['paid','already_paid'].includes(r1.state),'same order = the earlier answer, not a duplicate refusal');assert.equal(paidWrites(e),w,'nothing sent again');}
  assert.equal((await payT(e,'o-0005',{agentId:'owner'})).state,'paid','the owner\'s own payment is not guarded');});

test('dup guard: two simultaneous copies under different orders -> exactly one is paid',async()=>{
  const e=mkE();const rs=await Promise.all([payT(e,'c-0001'),payT(e,'c-0002'),payT(e,'c-0003')]);
  assert.equal(rs.filter(r=>r.state==='paid').length,1,JSON.stringify(rs.map(r=>[r.state,r.reason])));assert.equal(paidWrites(e),1);
  assert.ok(rs.filter(r=>r.state!=='paid').every(r=>r.nothingPaid===true||r.state==='in_progress'||/retry|busy/i.test(String(r.reason))),JSON.stringify(rs));});

test('dup guard: through kipurse_buy the duplicate becomes an owner push card (Face ID), not a silent refusal',async()=>{
  const e=mkE();const b=createBuy(e.engine,{sleep:async()=>{},waitMs:0});
  const a=await b.buy({purpose:'daily',item:'desk lamp',merchant:'Shop',to:TRUSTED,amount:'1',idempotencyKey:'k-t1280-0001'},'grok');assert.equal(a.state,'paid');
  const d=await b.buy({purpose:'daily',item:'desk lamp',merchant:'Shop',to:TRUSTED,amount:'1',idempotencyKey:'k-t1280-0002'},'grok');
  assert.equal(d.state,'awaiting_owner_approval',JSON.stringify(d));assert.equal(d.decision,'ask_owner');assert.match(d.approvalId,/^apr_/);assert.equal(d.nothingPaid,true);assert.equal(paidWrites(e),1);
  assert.match(d.say_to_user,/重复购买/);assert.doesNotMatch(d.say_to_user,/新收款方/);assert.match(d.ask_owner_question.en,/duplicate/);
  const d2=await b.buy({purpose:'daily',item:'desk lamp',merchant:'Shop',to:TRUSTED,amount:'1',idempotencyKey:'k-t1280-0003'},'grok');assert.equal(d2.approvalId,d.approvalId,'a retry under another order shows the SAME card');
  assert.equal(e.engine.mandates.proposals().filter(p=>p.state==='pending'&&/POSSIBLE_DUPLICATE/.test(p.reason??'')).length,1,'one card');});

test('M1: an AI-made 402 object naming an allowance\'s site cannot redirect that allowance to its own address',async()=>{
  const e=mkE();const M=e.engine.mandates;const P0='0x'+'0b'.repeat(20),EVIL='0x'+'0e'.repeat(20);
  M.propose({items:[{purpose:'daily',single:'1',recurring:{payee:P0,amount:'1',every:'day'},hosts:['api.example']}],by:'owner'});for(const p of M.proposals())M.approve(p.id,()=>true);
  const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64');const url='https://api.example/r/1';
  const req={status:402,url,headers:{'PAYMENT-REQUIRED':b64({x402Version:2,resource:{url},accepts:[{scheme:'exact',network:'eip155:84532',amount:'500000',asset:USDC,payTo:EVIL,maxTimeoutSeconds:60,extra:{name:'USDC',version:'2',nonce:'n1'}}]})}};
  const w0=e.s.writes.length;const r=await e.engine.pay({agentId:'grok',request:req,idempotencyKey:'idem-t1280-m1-0001'});
  assert.notEqual(r.state,'prepared',JSON.stringify(r));assert.equal(r.nothingPaid,true);assert.ok(!e.s.writes.slice(w0).some(w=>w.fn==='prepareAuthorization'));});

import {createOAuth as createOAuth2} from '../kit/oauth.mjs';import {createHash} from 'node:crypto';
test('OAuth: rotating a refresh token also ends the access token issued with it',async()=>{
  const S={};const OA=createOAuth2({S,save:()=>{},base:()=>'https://k.example',createAgentKey:()=>({}),isAgentLive:()=>true,caps:{},ownerSession:()=>false});
  async function call(method,path,body){const out={};const req={method,url:path,headers:{}};const res={writeHead(c,h){out.c=c;},end(b){out.b=b;},setHeader(){}};
    await OA.handle(req,res,new URL(path,'https://k.example'),{readBody:async()=>body,ip:'1.1.1.1'});try{out.j=JSON.parse(out.b);}catch{}return out;}
  const sha=s=>createHash('sha256').update(s).digest('hex');
  const at='a'.repeat(64),rt='b'.repeat(64);S.oauth.clients.c1={client_id:'c1',redirect_uris:['https://claude.ai/cb']};
  const n=Date.now()/1000;S.oauth.tokens[sha(at)]={type:'access',client_id:'c1',agentId:'x',exp:n+3600};S.oauth.tokens[sha(rt)]={type:'refresh',client_id:'c1',agentId:'x',exp:n+86400,at:sha(at)};
  const r=await call('POST','/oauth/token',{grant_type:'refresh_token',refresh_token:rt,client_id:'c1'});assert.equal(r.c,200,r.b);
  assert.equal(S.oauth.tokens[sha(at)],undefined,'old access token gone');assert.equal(S.oauth.tokens[sha(rt)],undefined,'old refresh token gone');assert.ok(S.oauth.tokens[sha(r.j.access_token)]);});

import {writeFileSync} from 'node:fs';
test('dup card: the signed item carries dup:true, only "once" is offered, human/push text say duplicate; "trust" is refused',async()=>{
  const e=mkE();const b=createBuy(e.engine,{sleep:async()=>{},waitMs:0});
  await b.buy({purpose:'daily',item:'desk lamp',merchant:'Shop',to:TRUSTED,amount:'1',idempotencyKey:'k-t1280-0101'},'grok');
  const d=await b.buy({purpose:'daily',item:'desk lamp',merchant:'Shop',to:TRUSTED,amount:'1',idempotencyKey:'k-t1280-0102'},'grok');
  const pv=e.engine.mandates.getProposal(d.approvalId);assert.equal(pv.items[0].oneOff.dup,true);assert.deepEqual(Object.keys(pv.ask.modes),['once']);
  assert.match(pv.signText,/"dup":true/);assert.match(pv.ask.modes.once.signText,/"dup":true/);
  assert.match(pv.items[0].human.zh,/疑似重复购买/);assert.equal(pv.items[0].human.dup,true);assert.doesNotMatch(pv.items[0].human.zh,/认识并信任/);
  const r=e.engine.mandates.approve(d.approvalId,()=>true,{mode:'trust'});assert.equal(r.ok,false);assert.equal(r.error,'mode_required');
  /* cross-test vector for the phone (T1280Tests reads it): the exact text the phone parses */
  if(process.env.T1280_VECTOR)writeFileSync(process.env.T1280_VECTOR,pv.ask.modes.once.signText);});
