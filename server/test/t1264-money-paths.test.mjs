// t1264: money-path fixes in the V5 engine (chain read errors, unknown send outcome + reconcile, AI total counting, inline trust epoch,
// paid-fetch SSRF guard, one owner approval = one use on payDirect too, persistent bundler free-tier count).
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {engineFor,direct,PAYEE,WALLET,ADAPTER} from './helpers/v5-fixture.mjs';
import {createEngineV5} from '../src/v5/engine.mjs';import {V4Ledger} from '../src/v4/ledger.mjs';
import {approvalKey,createApprovalUse,INLINE_TRUST_TAG} from '../src/v5/approval-use.mjs';import {bundlerFrom,sqliteQuotaStore} from '../src/v5/userop.mjs';
let n=0;const idem=t=>'idem-t1264-'+t+'-'+(n++).toString().padStart(4,'0');
const pays=s=>s.writes.filter(w=>w.fn==='payDirect').length;
const row=(e,k)=>e.engine.ledger.get(k);
/** the send's answer is lost after the tx / userOp hash is known (bundler timeout, RPC drop): beforeSend ran, then an error that is NOT an on-chain revert */
const loseAnswer=(e,{fns=['payDirect']}={})=>{const orig=e.client.write;let i=0;e.client.write=async(fn,args,o={})=>{if(!fns.includes(fn))return orig(fn,args,o);
  const h='0x'+'e'.repeat(56)+(++i).toString(16).padStart(8,'0');await o.beforeSend?.(h);throw Error('userOp receipt timeout '+h);};return ()=>{e.client.write=orig;};};

test('t1264 #1: purchaseUsed unreadable -> retry_later (nothing paid, nothing sent), the claim is released and the SAME key retries for real',async()=>{
  /* t1278 S11: a preflight that cannot read fails closed by itself (t1278-preflight test); here the read fails only at the send (after the preflight) */
  const e=engineFor();const orig=e.client.read;let down=true,seen=0;e.client.read=async(fn,args)=>{if(down&&fn==='purchaseUsed'&&++seen>1)throw Error('rpc 503');return orig(fn,args);};
  const k=idem('rd');const r=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-rd-1'),idempotencyKey:k});
  assert.equal(r.state,'retry_later',JSON.stringify(r));assert.equal(r.reason,'chain_read_failed');assert.equal(r.nothingPaid,true);assert.equal(pays(e.s),0,'nothing sent');
  const rw=row(e,r.purchaseKey);assert.equal(rw.state,'failed');assert.equal(rw.tx_hash,null,'released: no tx, claimable again');
  down=false;const r2=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-rd-1'),idempotencyKey:k});assert.equal(r2.state,'paid',JSON.stringify(r2));assert.equal(pays(e.s),1);});

test('t1264 #1: priorPurchaseUsed (V5.5 previous wallet) unreadable is NOT "paid"; a real used:true still is',async()=>{
  let mode='throw';const e=engineFor({priorPurchaseUsed:async()=>{if(mode==='throw')throw Error('rpc down');return {used:mode==='used'};}});
  const pf=await e.engine.preflight(direct('20000','t1264-pr-1'));assert.ok(pf.reasons.includes('chain_read_failed_retry_later'),JSON.stringify(pf.reasons));assert.ok(!pf.reasons.includes('already_paid_on_chain'));
  const k=idem('pr');const r=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-pr-1'),idempotencyKey:k});
  assert.equal(r.state,'retry_later');assert.equal(r.reason,'chain_read_failed');assert.equal(row(e,r.purchaseKey).state,'failed','never marked paid on a read error');assert.equal(pays(e.s),0);
  mode='used';const r2=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-pr-1'),idempotencyKey:k});assert.equal(r2.state,'already_paid_on_chain');assert.equal(row(e,r2.purchaseKey).state,'paid');assert.equal(pays(e.s),0);
  mode='free';const r3=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-pr-2'),idempotencyKey:idem('pr')});assert.equal(r3.state,'paid');});

test('t1264 #1: an exception inside the paid call never leaves the idempotency key stuck "in progress"',async()=>{
  const e=engineFor();const g=e.client.pub.getBlock;let boom=true;e.client.pub.getBlock=async()=>{if(boom)throw Error('rpc down');return g();};
  const k=idem('th');await assert.rejects(e.engine.pay({agentId:'owner',request:direct('20000','t1264-th-1'),idempotencyKey:k}));
  boom=false;const r=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-th-1'),idempotencyKey:k});assert.equal(r.state,'paid',JSON.stringify(r));assert.equal(pays(e.s),1);});

test('t1264 #2: sent but the answer was lost -> state unknown (never failed, nothingPaid false), row stays submitted; reconcile settles it paid; same key answers paid; nothing sent twice',async()=>{
  const e=engineFor();const undo=loseAnswer(e);const k=idem('un');
  const r=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-un-1'),idempotencyKey:k});undo();
  assert.equal(r.state,'unknown',JSON.stringify(r));assert.equal(r.nothingPaid,false);assert.match(r.detail,/do not pay again/);assert.ok(r.txHash);
  const rw=row(e,r.purchaseKey);assert.equal(rw.state,'submitted');assert.equal(rw.tx_hash,r.txHash);
  const again=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-un-1'),idempotencyKey:idem('un')});assert.equal(again.state,'in_progress','a new key cannot pay it again');assert.equal(pays(e.s),0);
  assert.deepEqual((await e.engine.reconcileSubmitted()).find(x=>x.purchaseKey===r.purchaseKey)?.state,'submitted','not confirmed yet: unchanged');
  e.s.used.add(JSON.parse(rw.result).pending.onchainPurchaseKey);/* the op landed after all */
  const rec=await e.engine.reconcileSubmitted();assert.equal(rec.find(x=>x.purchaseKey===r.purchaseKey).state,'paid');assert.equal(row(e,r.purchaseKey).state,'paid');
  const same=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-un-1'),idempotencyKey:k});assert.equal(same.state,'paid',JSON.stringify(same));assert.equal(same.nothingPaid,false);assert.equal(pays(e.s),0);});

test('t1264 #2: unknown that never lands -> failed only after every deadline passed (tx cleared, claimable); a definitive revert stays failed as before',async()=>{
  // t1268: inside the userOp's UTC-day validity window it is NEVER called failed, even after failAfterMs (it may still land)
  {const w=engineFor({reconcile:{failAfterMs:-1}});const u=loseAnswer(w);const q=await w.engine.pay({agentId:'owner',request:direct('20000','t1264-un-w'),idempotencyKey:idem('unw')});u();assert.equal(q.state,'unknown');
    await w.engine.reconcileSubmitted();assert.equal(row(w,q.purchaseKey).state,'submitted','still inside the day window -> stays unknown');}
  const e=engineFor({reconcile:{failAfterMs:-1,dayWindow:false}});const undo=loseAnswer(e);
  const r=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-un-2'),idempotencyKey:idem('un')});undo();assert.equal(r.state,'unknown');
  const rec=await e.engine.reconcileSubmitted();assert.equal(rec.find(x=>x.purchaseKey===r.purchaseKey).state,'failed');const rw=row(e,r.purchaseKey);assert.equal(rw.state,'failed');assert.equal(rw.tx_hash,null);
  const r2=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-un-2'),idempotencyKey:idem('un')});assert.equal(r2.state,'paid','claimable again; the on-chain key still guards');
  const e2=engineFor({},{revertOnChain:1});const f=await e2.engine.pay({agentId:'owner',request:direct('20000','t1264-rv-1'),idempotencyKey:idem('rv')});assert.equal(f.state,'failed');assert.equal(row(e2,f.purchaseKey).state,'failed');});

test('t1264 #2: a restarted engine on the same ledger settles a lost send on start (reconcileSubmitted)',async()=>{
  const e=engineFor();const undo=loseAnswer(e);const r=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-rs-1'),idempotencyKey:idem('rs')});undo();assert.equal(r.state,'unknown');
  e.s.used.add(JSON.parse(row(e,r.purchaseKey).result).pending.onchainPurchaseKey);
  const e2=createEngineV5({...e.cfg,reconcileOnStartMs:1},{ledgerFile:e.engine.ledgerPath,client:e.client,agentDefault:'a1'});
  for(let i=0;i<50&&e2.ledger.get(r.purchaseKey).state!=='paid';i++)await new Promise(z=>setTimeout(z,20));assert.equal(e2.ledger.get(r.purchaseKey).state,'paid');});

test('t1264 #6: the AI total counts AI rows only: not owner / withdrawal / owner-approved asks, not a claim whose lease ran out unsent',()=>{
  const L=new V4Ledger(join(mkdtempSync(join(tmpdir(),'t1264-')),'l.sqlite'),{leaseMs:60000});
  const req=(amt,ref)=>({standard:'direct',chainId:84532,payee:PAYEE,amount:BigInt(amt),merchantOrderId:ref});
  L.claim('k-ai',req(100,'a'),null,'a1');L.claim('k-own',req(1000,'b'),null,'owner');L.setOrigin('k-own','owner');
  L.claim('k-wd',req(10000,'c'),null,'a1');L.setOrigin('k-wd','withdrawal');L.claim('k-ask',req(100000,'d'),null,'grok');L.setOrigin('k-ask','owner_ask');
  L.claim('k-meta',req(5,'e'),null,'owner');L.setMeta('k-meta','owner',{});
  assert.equal(L.committedSpend(),100n,'only the AI row');
  L.claim('k-old',req(7,'f'),null,'a1');L.db.prepare(`UPDATE purchases SET lease_until=? WHERE purchase_key='k-old'`).run(Date.now()-1);assert.equal(L.committedSpend(),100n,'expired unsent claim does not count');
  L.update('k-old','a1',{state:'submitted',tx_hash:'0xabc'});assert.equal(L.committedSpend(),107n,'once sent it counts');
  const ad=L.claimWithin('k-ai2',req(50,'g'),null,'a1',160);assert.equal(ad.admitted,true,'107 + 50 <= 160: the 111005 of owner rows never eat the AI total');});

test('t1264 #6: an owner-approved ask is not blocked by the AI total (everyday term) and does not count toward it',async()=>{
  const e=engineFor({everydayGet:()=>({authorized:true,single:'1',daily:'1',term:'1'})});
  const spec={kind:'payAny',args:{payment:{to:PAYEE,amountAtomic:'20000'},merchant:'shop',orderRef:'t1264-term-1'}};
  const oa={signature:'0x'+'11'.repeat(65),deadline:String(Math.floor(Date.now()/1000)+300)};
  const r=await e.engine.payApprovedByOwner(spec,{agentId:'grok',idempotencyKey:'owner-ask:apr_t1264term',ownerApproval:oa});
  assert.equal(r.state,'paid',JSON.stringify(r));assert.equal(e.engine.ledger.committedSpend(),0n,'owner-approved: not in the AI total');});

test('t1264 #7: a cached inline (KPTR) trust is used only while its epoch is the on-chain epoch; stale -> normal tier + hook for the launcher',async()=>{
  const stale=[];const M2='0x'+'cc'.repeat(32);
  const e=engineFor({inlineTrustFor:async p=>p.toLowerCase()===PAYEE.toLowerCase()?{blob:INLINE_TRUST_TAG+'00'.repeat(40),merchant:M2,single:'1000000',daily:'2000000',expiry:String(Math.floor(Date.now()/1000)+86400),epoch:'0'}:null,onStaleInlineTrust:x=>stale.push(x)});
  let t=await e.engine.payeeTrustState(PAYEE);assert.equal(t.trusted,true);assert.equal(t.inline,true);
  e.s.epoch=1n;/* owner untrusted: epoch bumped on chain */t=await e.engine.payeeTrustState(PAYEE);assert.equal(t.trusted,false);assert.equal(t.tier,'stranger');
  assert.equal(stale.length,1);assert.equal(stale[0].merchant,M2);assert.equal(stale[0].chainEpoch,'1');
  const orig=e.client.read;e.client.read=async(fn,a)=>{if(fn==='trustOf')throw Error('rpc');return orig(fn,a);};e.s.epoch=0n;assert.equal((await e.engine.payeeTrustState(PAYEE)).trusted,false,'unreadable -> not trusted');});

test('t1264 #10: paid fetch goes through the SSRF guard (public https only, no redirects) and drops hop-by-hop / Host / cf-* headers',async()=>{
  const calls=[];const f=async(url,init)=>{calls.push({url,init});return new Response('free',{status:200});};
  const priv=engineFor({fetch:f,resolveHost:async()=>[{address:'10.1.2.3'}]});
  const r=await priv.engine.paidFetch({agentId:'owner',url:'https://intranet.example/x',idempotencyKey:idem('pf')});assert.equal(r.state,'rejected');assert.equal(r.reason,'url_not_allowed');assert.equal(calls.length,0);
  const r2=await priv.engine.paidFetch({agentId:'owner',url:'http://api.example/x',idempotencyKey:idem('pf')});assert.equal(r2.reason,'url_not_allowed');assert.equal(calls.length,0);
  const pub=engineFor({fetch:f});const r3=await pub.engine.paidFetch({agentId:'owner',url:'https://api.example/x',idempotencyKey:idem('pf'),
    headers:{Host:'169.254.169.254',Connection:'close','cf-connecting-ip':'1.2.3.4','Transfer-Encoding':'chunked','X-Forwarded-For':'10.0.0.1','PAYMENT-SIGNATURE':'forged','X-Api-Key':'k1','Accept':'application/json'}});
  assert.equal(r3.state,'no_payment_needed');assert.equal(calls.length,1);assert.equal(calls[0].init.redirect,'error');
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(),['Accept','X-Api-Key']);});

test('t1264 #11 (C-1): an owner approval already used (e.g. by an x402 prepare later cancelled) is never reused by payDirect; payDirect records its own use',async()=>{
  const e=engineFor();const AU=createApprovalUse(e.engine.ledger.db);
  const oa={signature:'0x'+'11'.repeat(65),deadline:String(Math.floor(Date.now()/1000)+300)};
  const pf=await e.engine.preflight(direct('20000','t1264-c1-1'));const k=approvalKey({chainId:84532,adapter:ADAPTER,account:WALLET,purchaseKey:pf.onchainPurchaseKey,payee:PAYEE,amount:20000n,deadline:BigInt(oa.deadline)});
  AU.consume(k,{purchaseKey:pf.onchainPurchaseKey,txHash:'0xprep'});
  const r=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-c1-1'),idempotencyKey:idem('c1'),ownerApproval:oa});assert.equal(r.reason,'OWNER_APPROVAL_ALREADY_USED',JSON.stringify(r));assert.equal(pays(e.s),0);
  const oa2={...oa,deadline:String(Number(oa.deadline)+1)};const r2=await e.engine.pay({agentId:'owner',request:direct('20000','t1264-c1-1'),idempotencyKey:idem('c1'),ownerApproval:oa2});assert.equal(r2.state,'paid',JSON.stringify(r2));
  const k2=approvalKey({chainId:84532,adapter:ADAPTER,account:WALLET,purchaseKey:pf.onchainPurchaseKey,payee:PAYEE,amount:20000n,deadline:BigInt(oa2.deadline)});assert.equal(AU.get(k2)?.state,'used','payDirect records the use');
  const e3=engineFor({},{revertOnChain:1});const pf3=await e3.engine.preflight(direct('20000','t1264-c1-3'));
  const f=await e3.engine.pay({agentId:'owner',request:direct('20000','t1264-c1-3'),idempotencyKey:idem('c1'),ownerApproval:oa});assert.equal(f.state,'failed');
  const k3=approvalKey({chainId:84532,adapter:ADAPTER,account:WALLET,purchaseKey:pf3.onchainPurchaseKey,payee:PAYEE,amount:20000n,deadline:BigInt(oa.deadline)});assert.equal(createApprovalUse(e3.engine.ledger.db).get(k3),null,'reverted on chain: approval not used up');});

test('t1264 #12: the bundler free-tier daily count survives a restart (sqlite, per UTC day)',()=>{
  const file=join(mkdtempSync(join(tmpdir(),'t1264q-')),'q.sqlite');const cfg={chainId:84532,bundler:{url:'https://bundler.example',maxOpsPerDay:2}};
  const b1=bundlerFrom(cfg,{quotaStore:sqliteQuotaStore(new DatabaseSync(file))});assert.equal(b1.quota(),true);assert.equal(b1.quota(),true);assert.equal(b1.quota(),false);
  const b2=bundlerFrom(cfg,{quotaStore:sqliteQuotaStore(new DatabaseSync(file))});assert.equal(b2.quota(),false,'restart: still used up today');
  const q=sqliteQuotaStore(new DatabaseSync(file));assert.equal(q.take('2099-01-01',2),true,'a new UTC day starts at 0');
  const mem=bundlerFrom({chainId:84532,bundler:{url:'https://b.example',maxOpsPerDay:1}});assert.equal(mem.quota(),true);assert.equal(mem.quota(),false,'no store: in-memory as before');});
