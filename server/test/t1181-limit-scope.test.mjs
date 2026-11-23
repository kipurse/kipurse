// t1181u (handbook §6#84): off-chain limits are pinned to ONE network + ONE token, and one owner approval prepares at most one x402 reservation.
import test from 'node:test';import assert from 'node:assert/strict';import {getAddress} from 'viem';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';
import {engineFor,direct,USDC,PAYEE,WALLET} from './helpers/v5-fixture.mjs';
import {createEverydayLimits} from '../src/v5/everyday-limits.mjs';import {createMandates,BEGINNER_DEFAULTS} from '../src/v5/mandates.mjs';
import {makeScope,scopeCheck,USDC_BY_CHAIN} from '../src/v5/limit-scope.mjs';import {approvalKey,isOwnerApproval,createApprovalUse,INLINE_TRUST_TAG} from '../src/v5/approval-use.mjs';
const BASE=8453,BUSDC='0x833589fCd6eDb6E08f4c7C32D4f71b54bdA02913',OTHER='0x1111111111111111111111111111111111111111';
const kvMap=()=>{const m=new Map();return {m,kv:{get:k=>m.get(k),set:(k,v)=>m.set(k,v),del:k=>m.delete(k)}};};
const FLOOR=()=>({single:500_000_000n,daily:900_000_000n,term:900_000_000n});
const EV={amount:1_000_000n,spent24h:0n,spentTerm:0n};
// ---------- limit-scope helpers ----------
test('scope: defaults to the chain USDC, rejects malformed, legacy records read as the default',()=>{
  assert.deepEqual(makeScope(BASE),{chainId:8453,token:USDC_BY_CHAIN[8453]});assert.throws(()=>makeScope(0));assert.throws(()=>makeScope(1));assert.throws(()=>makeScope(BASE,'0x12'));
  const def=makeScope(BASE,BUSDC);assert.equal(scopeCheck('x',{},{chainId:BASE,token:BUSDC},def),null);
  for(const pay of [{chainId:1,token:BUSDC},{chainId:84532},{chainId:BASE,token:OTHER},{chainId:'junk'}]){const r=scopeCheck('x',{},pay,def);assert.equal(r.reason,'LIMIT_SCOPE_MISMATCH');assert.equal(r.nothingPaid,true);}});
// ---------- everyday limits ----------
test('everyday: a legacy saved row (no chainId/token) is migrated to Base USDC once; Base USDC behaves exactly as before',()=>{
  const {m,kv}=kvMap();const legacy=createEverydayLimits({kv,wallet:'0xAbc',floor:FLOOR});assert.equal(legacy.set({single:'3000000',daily:'4000000',term:'500000000'}).ok,true);
  const k=[...m.keys()][0];const before=JSON.parse(JSON.stringify(m.get(k)));assert.equal(typeof before==='string'?JSON.parse(before).chainId:before.chainId,undefined);
  assert.equal(legacy.check({...EV,chainId:1}),null,'without a configured scope nothing changes');
  const E=createEverydayLimits({kv,wallet:'0xAbc',floor:FLOOR,scope:{chainId:BASE,token:BUSDC}});assert.deepEqual(E.scope(),{chainId:BASE,token:BUSDC.toLowerCase()});
  const after=m.get(k);const a=typeof after==='string'?JSON.parse(after):after;assert.equal(a.chainId,BASE);assert.equal(a.token,BUSDC.toLowerCase());assert.equal(a.single,'3000000');
  assert.equal(E.check({...EV,chainId:BASE,token:BUSDC}),null);assert.equal(E.check(EV),null,'unscoped caller = Base USDC');
  assert.equal(E.check({...EV,amount:3_500_000n,chainId:BASE,token:BUSDC}).reason,'EVERYDAY_SINGLE_LIMIT','limits unchanged');
  assert.equal(legacy.check({...EV,chainId:1}).reason,'LIMIT_SCOPE_MISMATCH','once migrated the row itself carries its scope');});
test('everyday: another chain (Ethereum, Base Sepolia) or another token is refused, nothing paid',()=>{
  const {kv}=kvMap();const E=createEverydayLimits({kv,wallet:'0xAbc',floor:FLOOR,scope:{chainId:BASE,token:BUSDC}});assert.equal(E.set({single:'3000000',daily:'4000000',term:'500000000'}).ok,true);
  for(const p of [{chainId:1,token:BUSDC},{chainId:84532,token:USDC},{chainId:84532},{chainId:BASE,token:OTHER},{chainId:10,token:BUSDC}]){
    const r=E.check({...EV,...p});assert.equal(r?.reason,'LIMIT_SCOPE_MISMATCH',JSON.stringify(p));assert.equal(r.nothingPaid,true);assert.equal(r.decision,'refuse');}});
// ---------- mandates + per-AI caps ----------
const verify=()=>true;
function mdb(){return new DatabaseSync(':memory:');}
test('mandates: legacy mandates / per-AI caps are migrated to the engine scope; match + agentCheck refuse other chains/tokens',()=>{
  const db=mdb();const M0=createMandates({db,wallet:WALLET});
  const p=M0.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});assert.equal(M0.approve(p.id,verify).ok,true);
  const q=M0.propose({items:[{kind:'agent_limits',agentId:'ai-1',single:'2',daily:'5',monthly:'30'}],by:'owner'});assert.equal(M0.approve(q.id,verify).ok,true);
  const M=createMandates({db,wallet:WALLET,scope:{chainId:BASE,token:BUSDC}});
  for(const r of db.prepare(`SELECT json FROM mandate`).all()){const j=JSON.parse(r.json);assert.equal(j.chainId,BASE);assert.equal(j.token,BUSDC.toLowerCase());}
  assert.deepEqual({...db.prepare(`SELECT chain_id,token FROM limit_scope WHERE kind='agent' AND id='ai-1'`).get()},{chain_id:BASE,token:BUSDC.toLowerCase()});
  assert.equal(M.agentCheck('ai-1',1_000_000n,{chainId:BASE,token:BUSDC}),null,'Base USDC unchanged');assert.equal(M.agentCheck('ai-1',3_000_000n,{chainId:BASE,token:BUSDC}).reason,'AGENT_SINGLE_CAP');
  for(const s of [{chainId:1,token:BUSDC},{chainId:84532,token:USDC},{chainId:BASE,token:OTHER}]){const r=M.agentCheck('ai-1',1_000_000n,s);assert.equal(r.reason,'LIMIT_SCOPE_MISMATCH');assert.equal(r.nothingPaid,true);}
  const ok=M.match({purpose:'dev',payee:PAYEE,amount:1_000_000n,chainId:BASE,token:BUSDC});const bad=M.match({purpose:'dev',payee:PAYEE,amount:1_000_000n,chainId:1,token:BUSDC});
  assert.equal(ok.ok,true,JSON.stringify(ok));assert.equal(bad.ok,false);assert.equal(bad.why,'scope_mismatch');
  const bad2=M.match({purpose:'dev',payee:PAYEE,amount:1_000_000n,chainId:BASE,token:OTHER});assert.equal(bad2.ok,false);});
test('mandates: new mandates and per-AI caps carry chainId + token',()=>{
  const db=mdb();const M=createMandates({db,wallet:WALLET,scope:{chainId:BASE,token:BUSDC}});
  const p=M.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});assert.equal(M.approve(p.id,verify).ok,true);
  const q=M.propose({items:[{kind:'agent_limits',agentId:'ai-2',single:'2',daily:'5',monthly:'30'}],by:'owner'});assert.equal(M.approve(q.id,verify).ok,true);
  for(const r of db.prepare(`SELECT json FROM mandate`).all()){const j=JSON.parse(r.json);assert.equal(j.chainId,BASE);}
  assert.equal(db.prepare(`SELECT chain_id FROM limit_scope WHERE id='ai-2'`).get().chain_id,BASE);
  assert.equal(M.agentCheck('ai-2',1_000_000n,{chainId:1,token:BUSDC}).reason,'LIMIT_SCOPE_MISMATCH');});
// ---------- engine level ----------
test('engine: everyday limits saved for Base USDC never pay a payment on another network (refused, no chain write)',async()=>{
  const {kv}=kvMap();const EVD=createEverydayLimits({kv,wallet:WALLET,floor:FLOOR,scope:{chainId:BASE,token:BUSDC}});EVD.set({single:'3000000',daily:'4000000',term:'500000000'});
  const e=engineFor({ownerRulesDir:mkdtempSync(join(tmpdir(),'sc-')),everydayCheck:a=>EVD.check(a),everydayGet:()=>EVD.get(),everydayScope:()=>EVD.scope()},{bal:1000000000n});
  const r=await e.engine.pay({request:direct('20000','ord-sc-1'),idempotencyKey:'idem-sc-0001'});
  assert.notEqual(r.state,'paid');assert.equal(r.reason,'LIMIT_SCOPE_MISMATCH');assert.equal(r.nothingPaid,true);assert.equal(e.s.writes.length,0);});
test('engine: a per-AI cap recorded for another network refuses that AI (no chain write)',async()=>{
  const e=engineFor({ownerRulesDir:mkdtempSync(join(tmpdir(),'sc-'))},{bal:1000000000n});const M=e.engine.mandates;
  const q=M.propose({items:[{kind:'agent_limits',agentId:'a1',single:'2',daily:'5',monthly:'30'}],by:'owner'});assert.equal(M.approve(q.id,verify).ok,true);
  const db=e.engine.ledger.db;db.prepare(`UPDATE limit_scope SET chain_id=?,token=? WHERE kind='agent' AND id='a1'`).run(BASE,BUSDC.toLowerCase());
  const r=await e.engine.pay({request:direct('20000','ord-sc-2'),idempotencyKey:'idem-sc-0002',agentId:'a1'});
  assert.equal(r.reason,'LIMIT_SCOPE_MISMATCH');assert.equal(r.nothingPaid,true);assert.equal(e.s.writes.length,0);});
// ---------- one owner approval = one reservation ----------
const PAY=getAddress('0x00110000000000000000000000000000000000aa');
const x402f=(amt='1000000')=>async(url,init)=>{if(!Object.keys(init?.headers??{}).some(h=>/payment/i.test(h)))return new Response('',{status:402,headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify({x402Version:2,resource:{url},accepts:[{scheme:'exact',network:'eip155:84532',amount:amt,asset:USDC,payTo:PAY,maxTimeoutSeconds:60,extra:{name:'USDC',version:'2',nonce:'fixed'}}]})).toString('base64')}});return new Response('ok',{status:200});};
const OA=()=>({signature:'0x'+'11'.repeat(65),deadline:String(Math.floor(Date.now()/1000)+300)});
const preps=s=>s.writes.filter(w=>w.fn==='prepareAuthorization').length;
const reopen=e=>{e.s.used.clear();for(const d of Object.keys(e.s.reservations??{}))e.s.reservations[d].open=false;e.engine.ledger.db.prepare(`DELETE FROM purchases`).run();};// ledger row gone (e.g. restored / repaired ledger): only the approval record still knows
test('approval-use: key helpers (inline KPTR trust bytes are not an owner approval)',()=>{
  assert.equal(isOwnerApproval('0x'+'11'.repeat(65)),true);assert.equal(isOwnerApproval(INLINE_TRUST_TAG+'00'.repeat(40)),false);assert.equal(isOwnerApproval('0x'),false);assert.equal(isOwnerApproval(undefined),false);
  const b={chainId:BASE,adapter:PAY,account:WALLET,purchaseKey:'0x'+'aa'.repeat(32),payee:PAYEE,amount:1n,deadline:2n};
  assert.notEqual(approvalKey(b),approvalKey({...b,chainId:84532}));assert.notEqual(approvalKey(b),approvalKey({...b,deadline:3n}));
  const AU=createApprovalUse(mdb());const k=approvalKey(b);assert.equal(AU.check(k),null);AU.consume(k,{purchaseKey:b.purchaseKey,txHash:'0x1'});assert.equal(AU.check(k).reason,'OWNER_APPROVAL_ALREADY_USED');AU.release(k);assert.equal(AU.check(k),null);});
test('approval-use: after a cancel, the SAME owner approval is never prepared again; a NEW approval works',async()=>{
  const e=engineFor({fetch:x402f(),ownerRulesDir:mkdtempSync(join(tmpdir(),'oa-')),retryDelayMs:1},{bal:1000000000n});const oa=OA();
  const r1=await e.engine.paidFetch({agentId:'owner',url:'https://api.example/r/1',idempotencyKey:'idem-oa-0001',ownerApproval:oa});
  assert.equal(preps(e.s),1,JSON.stringify(r1).slice(0,300));
  reopen(e);// owner cancelled: chain freed the purchase key; ledger row no longer blocks a retry
  const r2=await e.engine.paidFetch({agentId:'owner',url:'https://api.example/r/1',idempotencyKey:'idem-oa-0002',ownerApproval:oa});
  assert.equal(preps(e.s),1,'no second prepare with the same approval');assert.match(JSON.stringify(r2),/OWNER_APPROVAL_ALREADY_USED/);
  const r3=await e.engine.paidFetch({agentId:'owner',url:'https://api.example/r/1',idempotencyKey:'idem-oa-0003',ownerApproval:{...oa,deadline:String(Number(oa.deadline)+1)}});
  assert.equal(preps(e.s),2,'a new owner approval prepares: '+JSON.stringify(r3).slice(0,200));});
test('approval-use: a prepare that reverted on chain does not use up the approval',async()=>{
  const e=engineFor({fetch:x402f(),ownerRulesDir:mkdtempSync(join(tmpdir(),'oa-')),retryDelayMs:1},{bal:1000000000n,revertOnChain:1});const oa=OA();
  const r1=await e.engine.paidFetch({agentId:'owner',url:'https://api.example/r/2',idempotencyKey:'idem-oa-0101',ownerApproval:oa});assert.notEqual(r1.state,'paid');assert.equal(preps(e.s),1);
  reopen(e);const r2=await e.engine.paidFetch({agentId:'owner',url:'https://api.example/r/2',idempotencyKey:'idem-oa-0102',ownerApproval:oa});
  assert.equal(preps(e.s),2,JSON.stringify(r2).slice(0,300));assert.doesNotMatch(JSON.stringify(r2),/OWNER_APPROVAL_ALREADY_USED/);});
test('approval-use: x402 without an owner approval is not affected (retries after a cancel still work)',async()=>{
  const e=engineFor({fetch:x402f('50000'),ownerRulesDir:mkdtempSync(join(tmpdir(),'oa-')),retryDelayMs:1},{bal:1000000000n});
  await e.engine.paidFetch({agentId:'owner',url:'https://api.example/r/3',idempotencyKey:'idem-oa-0201'});const n=preps(e.s);assert.equal(n,1);
  reopen(e);await e.engine.paidFetch({agentId:'owner',url:'https://api.example/r/3',idempotencyKey:'idem-oa-0202'});assert.equal(preps(e.s),2);
  assert.equal(e.engine.ledger.db.prepare(`SELECT count(*) c FROM owner_approval_use`).get().c,0);});
test('approval-use: with the ledger intact, a cancelled reservation is not re-prepared at all (layer 2 unchanged)',async()=>{
  const e=engineFor({fetch:x402f(),ownerRulesDir:mkdtempSync(join(tmpdir(),'oa-')),retryDelayMs:1},{bal:1000000000n});const oa=OA();
  await e.engine.paidFetch({agentId:'owner',url:'https://api.example/r/4',idempotencyKey:'idem-oa-0301',ownerApproval:oa});assert.equal(preps(e.s),1);
  e.s.used.clear();for(const d of Object.keys(e.s.reservations??{}))e.s.reservations[d].open=false;
  await e.engine.paidFetch({agentId:'owner',url:'https://api.example/r/4',idempotencyKey:'idem-oa-0302',ownerApproval:oa});assert.equal(preps(e.s),1);});
test('engine x402: an AI x402 payment outside the everyday-limit scope is refused before signing (no prepare, no header)',async()=>{
  const {kv}=kvMap();const EVD=createEverydayLimits({kv,wallet:WALLET,floor:FLOOR,scope:{chainId:BASE,token:BUSDC}});EVD.set({single:'3000000',daily:'4000000',term:'500000000'});
  let headers=0;const f0=x402f('50000');const f=async(u,i)=>{if(Object.keys(i?.headers??{}).some(h=>/payment/i.test(h)))headers++;return f0(u,i);};
  const e=engineFor({fetch:f,ownerRulesDir:mkdtempSync(join(tmpdir(),'sc-')),everydayCheck:a=>EVD.check(a),everydayGet:()=>EVD.get(),everydayScope:()=>EVD.scope()},{bal:1000000000n});
  const r=await e.engine.paidFetch({agentId:'a1',url:'https://api.example/r/9',idempotencyKey:'idem-sc-0009'});
  assert.equal(r.reason,'LIMIT_SCOPE_MISMATCH',JSON.stringify(r).slice(0,300));assert.equal(r.nothingPaid,true);assert.equal(preps(e.s),0);assert.equal(headers,0);});
test('signed approval text names the network + token; still passes the build-71 phone check (prefix + "\\nmode:")',()=>{
  const db=mdb();const M=createMandates({db,wallet:WALLET,scope:{chainId:BASE,token:BUSDC}});
  const p=M.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});const v=M.getProposal?M.getProposal(p.id):p;const text=(v.signText??p.signText);
  assert.ok(text.endsWith(`\nchain:${BASE}\ntoken:${BUSDC.toLowerCase()}`),text);
  const prefix='Kipurse allowance approval v1\nwallet:'+WALLET.toLowerCase()+'\nid:'+p.id+'\n';assert.ok(text.startsWith(prefix));// = OwnerAsk.textOK prefix (iOS build 71)
  let seen=null;assert.equal(M.approve(p.id,d=>{seen=d;return false;}).error,'not_owner');
  assert.equal(seen,'0x'+createHash('sha256').update(text).digest('hex'),'the owner signs exactly this text');
  const M0=createMandates({db:mdb(),wallet:WALLET});const p0=M0.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});assert.ok(!(p0.signText??'').includes('\nchain:'),'unscoped callers unchanged');});
