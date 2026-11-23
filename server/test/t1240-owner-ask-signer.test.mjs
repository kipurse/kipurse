// t1240 (handbook §6#110, owner 2026-11-21): when the merchant's order is signed by the signer it publishes, the owner's ONE "trust" on an owner ask
// also signs the V5.4 signer grant (kind 5) in the same Face ID, so later orders of that merchant (fresh deposit address each time) auto-pay within
// the trust caps. Without a verified signer, the ask behaves exactly as before (this payee only, no grant). The AI can never add a signer.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {getAddress} from 'viem';
import {engineFor} from './helpers/v5-fixture.mjs';import {BEGINNER_DEFAULTS} from '../src/v5/mandates.mjs';import {createBuy} from '../src/v5/buy.mjs';
import {createOwnerAskApproval} from '../src/v5/owner-ask-approve.mjs';import {waitTrust} from './helpers/t1243-wait-trust.mjs';import {NO_CEILING} from '../src/v5/phone-signer.mjs';
import {createTrustRequests} from '../src/v5/trust-requests.mjs';import {buildCreateOrder} from '../src/v5/discovery.mjs';
const SIGNER=getAddress('0xadb2f2c49f31d59bc46959818e5c445e1c01acb8');
let seq=0x9100;const fresh=()=>{seq++;return getAddress('0x'+seq.toString(16).padStart(6,'0')+'c'.repeat(28)+seq.toString(16).padStart(6,'0'));};
let k=0;const idem=()=>'idem-t1240-'+(k++).toString().padStart(5,'0');
const mk=()=>{const e=engineFor({ownerRulesDir:mkdtempSync(join(tmpdir(),'t1240-'))},{bal:5000000000n,delayMs:1},{openSingle:'10050000',openDaily:'900000000',single:'100050000',daily:'900000000',term:'900000000'});
  e.engine.mandates.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});for(const p of e.engine.mandates.proposals())e.engine.mandates.approve(p.id,()=>true);return {...e,buy:createBuy(e.engine,{sleep:async()=>{},waitMs:0})};};
const phone={active:()=>({index:1,fingerprint:'fp1',approver:'0x'+'99'.repeat(20),maxSingle:NO_CEILING,maxDaily:NO_CEILING}),payCapable:async()=>({ok:true,index:1,active:{fingerprint:'fp1',maxSingle:NO_CEILING,maxDaily:NO_CEILING}})};
const p256Verify=(a,d,r,s)=>r==='0x01'&&s==='0x02';const GOOD={r:'0x01',s:'0x02'};
const setup=e=>{const reqs={},stored=[],fromTrustCalls=[];
  const o={cap:'C',api:{approve:async(c,id)=>({innerTypedData:{message:{account:'0x'+'77'.repeat(20),merchant:'0x'+'aa'.repeat(32),name:reqs[id].merchantName.toLowerCase(),epoch:'0',payees:[reqs[id].payee],signers:reqs[id].signers??[],single:reqs[id].single,daily:reqs[id].total,expiry:'9999999999',nonce:'0x'+'bb'.repeat(32),deadline:'9999999999'},domain:{}},digest:'0x'+'cd'.repeat(32)}),
    submitSignature:async(c,id)=>{reqs[id].status='trusted';return {status:'trusted',txHash:'0xtrust'};},reject:(c,id)=>{if(reqs[id])reqs[id].status='rejected';},list:()=>({pending:Object.values(reqs).filter(r=>r.status==='awaiting'),recent:[]})}};
  const engine=new Proxy(e.engine,{get:(t,key)=>key==='requestTrustFromOwner'?async x=>{const id='tr-'+(Object.keys(reqs).length+1);reqs[id]={id,...x,status:'awaiting'};return {id};}:t[key]});
  const signerGrant={fromTrust:async m=>{fromTrustCalls.push(m);return {digest:'0x'+'ee'.repeat(32),message:{account:m.account,merchant:m.merchant,name:m.name,epoch:'0',signers:m.signers,single:m.single,daily:m.daily,expiry:m.expiry,nonce:'0x'+'12'.repeat(32),deadline:m.expiry}};},
    wrapper:(idx,m,r,s)=>'0xgrant:'+r+':'+s,store:(m,w)=>{stored.push({m,w});}};
  // the wallet accepts exactly the phone's signatures: trust wrapper (kind 1) and grant wrapper (kind 5) only when signed with the good key
  const verifyWrapped=async(d,w)=>d==='0x'+'ee'.repeat(32)?w==='0xgrant:0x01:0x02':true;
  const A=createOwnerAskApproval({engine,phone,pub:{readContract:async()=>'0x'+'ab'.repeat(32)},wallet:'0x'+'77'.repeat(20),everyday:()=>({authorized:true,single:'5000000',daily:'20000000'}),
    walletCaps:()=>({single:100050000n,daily:900000000n}),trustOwner:()=>o,verifyWrapped,p256Verify,signerGrant});
  return {A,reqs,stored,fromTrustCalls};};
const ask=async e=>{const to=fresh(),key=idem();const r=await e.buy.buy({purpose:'daily',item:'listing boost',merchant:'ExampleShop',to,amount:'50',idempotencyKey:key},'muse');return {to,r};};
/** what the engine does for a merchant-signed order (payMerchantOrder): the verified signer rides on the stored spec, outside args */
const markSigned=(e,id,{signer=SIGNER,merchant='shop.example'}={})=>{const db=e.engine.ownerAsks;const a=db.get(id);const spec={...a.spec,signer,signerMerchant:merchant};
  /* test-only: rewrite the stored spec (prod: the engine sets it at creation) */e.engine.ownerAsks._db?.prepare?.(`UPDATE owner_ask SET spec_json=? WHERE approval_id=?`).run(JSON.stringify(spec),id);return spec;};

test('no verified signer -> trust names this payee only, no grant (exactly as before)',async()=>{
  const e=mk();const {to,r}=await ask(e);assert.equal(r.decision,'ask_owner');const {A,reqs,stored,fromTrustCalls}=setup(e);
  const [c,o]=await A.prepare({id:r.approvalId,mode:'trust'});assert.equal(c,200);assert.equal(o.trust.signerGrant,undefined);assert.equal(fromTrustCalls.length,0);
  const tr=Object.values(reqs)[0];assert.equal(tr.signers,undefined);assert.equal(getAddress(tr.payee),to);
  const [c2,o2]=await A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD});assert.equal(c2,200);assert.equal(o2.trust.state,'submitting');assert.equal((await waitTrust(e.engine.ownerAsks,r.approvalId)).state,'trusted');assert.equal(stored.length,0);});

test('the AI cannot add a signer: signer fields inside the AI arguments are ignored',async()=>{
  const e=mk();const key=idem();const r=await e.buy.buy({purpose:'daily',item:'x',merchant:'ExampleShop',to:fresh(),amount:'50',idempotencyKey:key,signer:SIGNER,signerMerchant:'shop.example'},'muse');
  const a=e.engine.ownerAsks.get(r.approvalId);assert.equal(a.spec.signer,undefined,'only the engine (verified signed order) sets spec.signer');});

test('owner-ask spec shape: the engine puts the verified signer next to args (payMerchantOrder), never inside them',()=>{
  const src=readFileSync(new URL('../src/v5/engine.mjs',import.meta.url),'utf8');
  assert.match(src,/\.\.\.\(sv\?\{signer:sv\.signer,signerMerchant:sv\.name\}:\{\}\)/);
  assert.match(src,/if\(lc\(o\.signer\)!==lc\(d0\.expectedSigner\)\)return null;/,'only the signer the merchant publishes on its own origin');
  assert.match(src,/lc\(o\.payer\?\?ZERO\)!==lc\(p\.account\)\)return null;/,'order bound to this wallet');
  assert.match(src,/if\(lc\(o\.payee\)!==lc\(v\.payment\.to\)\|\|o\.amount!==BigInt\(v\.payment\.amountAtomic\)\)return null;/,'same payee / amount as the order response');});

test('signed merchant: ONE trust = merchant domain + its signer; the same Face ID signs the grant; a bad grant signature is refused and nothing is stored',async()=>{
  const e=mk();const {r}=await ask(e);const S=setup(e);
  if(!e.engine.ownerAsks._db){/* the store hides its db: emulate the engine by passing the signer through a fresh ask record */}
  const spec=markSigned(e,r.approvalId);const a=e.engine.ownerAsks.get(r.approvalId);
  if(a.spec.signer!==SIGNER){/* store without a writable db handle: patch get() for this test only */const g=e.engine.ownerAsks.get;e.engine.ownerAsks.get=id=>{const x=g(id);return x&&id===r.approvalId?{...x,spec}:x;};}
  const [c,o]=await S.A.prepare({id:r.approvalId,mode:'trust'});assert.equal(c,200,JSON.stringify(o));
  assert.equal(o.trust.merchant,'shop.example');assert.equal(o.trust.signer,SIGNER);assert.ok(o.trust.signerGrant?.digest);assert.deepEqual(o.trust.signerGrant.message.signers,[SIGNER]);
  const tr=Object.values(S.reqs)[0];assert.equal(tr.merchantName,'shop.example');assert.deepEqual(tr.signers,[SIGNER]);
  const [cb,ob]=await S.A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:{...GOOD,signerGrant:{r:'0x09',s:'0x09'}}});assert.equal(cb,403);assert.equal(ob.part,'signer_grant');assert.equal(S.stored.length,0);
  const [cm,om]=await S.A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:GOOD});assert.equal(cm,403,'grant signature missing');assert.equal(om.part,'signer_grant');
  const [c2,o2]=await S.A.approve({id:r.approvalId,mode:'trust',...GOOD,pay:GOOD,trust:{...GOOD,signerGrant:GOOD}});assert.equal(c2,200);assert.equal(o2.trust.state,'submitting');assert.equal(S.stored.length,0,'t1243: nothing stored before the trust is on chain + verified');
  const t2=await waitTrust(e.engine.ownerAsks,r.approvalId);assert.equal(t2.state,'trusted');assert.equal(t2.signerGrant,'stored');assert.equal(t2.merchant,'shop.example');assert.equal(S.stored.length,1);assert.deepEqual(S.stored[0].m.signers,[SIGNER]);});

test('trust requests: signers validated (address, max 3); agents\' MCP / HTTP request paths never pass signers',async()=>{
  const seen=[];const T=createTrustRequests({file:join(mkdtempSync(join(tmpdir(),'t1240tr-')),'t.json'),chainId:8453,prepare:async x=>{seen.push(x);return {ok:true,trust:x,nonce:'0x1',deadline:1,digest:'0x2',typedData:{}};},submit:async()=>({txHash:'0x3'})});
  assert.throws(()=>T.agentApi.request({agentId:'a',merchantName:'m',payee:fresh(),single:'1',total:'1',reason:'why',signers:['nope']}),e=>e.code==='bad_signers');
  const r=T.agentApi.request({agentId:'a',merchantName:'shop.example',payee:fresh(),single:'1',total:'1',reason:'why',signers:[SIGNER]});
  await T.ownerApi.approve(T.ownerCapability,r.id);assert.deepEqual(seen[0].signers,[SIGNER],'signers reach the on-chain trust');
  const r2=T.agentApi.request({agentId:'a',merchantName:'shop',payee:fresh(),single:'1',total:'1',reason:'why'});await T.ownerApi.approve(T.ownerCapability,r2.id);assert.deepEqual(seen[1].signers,[],'no signers by default');
  for(const f of ['src/v5/mcp.mjs','src/v5/http.mjs'])assert.doesNotMatch(readFileSync(new URL('../'+f,import.meta.url),'utf8').split('\n').filter(l=>/requestTrustFromOwner\(/.test(l)).join('\n'),/signers/,f);});

test('order create: the payer field is sent only with the signed-order opt-in and only when the merchant names it',()=>{
  const d={origin:'https://shop.example',create:{path:'/o',contentType:'application/json',required:[],optional:['signedOrder'],bodyAuth:null,idempotencyField:null},signedOrder:{optIn:'signedOrder',payerParam:'payer'}};
  const W='0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb';
  assert.deepEqual(JSON.parse(buildCreateOrder(d,{a:1},{signedOrder:true,payer:W}).init.body),{a:1,signedOrder:true,payer:getAddress(W)});
  assert.deepEqual(JSON.parse(buildCreateOrder(d,{a:1},{signedOrder:false,payer:W}).init.body),{a:1});
  assert.deepEqual(JSON.parse(buildCreateOrder({...d,signedOrder:{optIn:'signedOrder',payerParam:null}},{a:1},{signedOrder:true,payer:W}).init.body),{a:1,signedOrder:true});});
