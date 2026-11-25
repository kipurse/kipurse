// t1241 (decision 111): layered merchant trust in the engine (V5.4 + owner grant hook + attestor). A merchant that changes NOTHING for
// Kipurse: deposit address / amount / expiry only from Kipurse's own create-order call; merchant signature required when it publishes a
// signer; unsigned merchants auto-pay only up to HALF the trust caps; the attestor re-checks independently; unconfirmed -> domain paused.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {getAddress,keccak256,toBytes} from 'viem';
import {engineFor} from './helpers/v5-fixture.mjs';import {createAttestor} from '../src/v5/attestor.mjs';import {mockMerchant,MUSDC} from './helpers/t1241-merchant.mjs';
const A54='0x00000000000000000000000000000000000A5005';/* the fixture adapter = "the V5.4 adapter" */
function setup({signed=true,grant=true,single='4000000',daily='8000000',confirm={windowMs:60000,pollMs:30000},merchant}={}){
  const M=merchant??mockMerchant({signed});const notes=[];const grants=new Map();const logs=[];
  const att=createAttestor({keyDir:join(mkdtempSync(join(tmpdir(),'t1241e-')),'k'),dataKey:randomBytes(32),chainId:8453,adapters:[A54],fetch:M.fetch,resolveHost:async()=>[{address:'93.184.216.34'}],usdc:MUSDC});
  const used=new Set();
  const e=engineFor({chainId:8453,token:MUSDC,sanctionsOracle:false,allowLegacyOnMainnet:true,fetch:M.fetch,attestor:att,merchantConfirm:confirm,ownerNotify:ev=>notes.push(ev),obs:{log:(k,v)=>logs.push([k,v])},
    freshAddress:async a=>!used.has(String(a).toLowerCase()),
    signerGrant:async({account,signer})=>grants.get(String(signer).toLowerCase())??null},{bal:5000000000n,delayMs:1},{single:'6000000',daily:'12000000',term:'30000000',openSingle:'0',openDaily:'0'});
  const trust=async()=>{const a=(await att.address(M.host)).toLowerCase();grants.set(a,{bytes:'0x1234',merchant:keccak256(toBytes(M.host)),single,daily});};
  return {...e,M,att,notes,logs,used,trust,grants};}
let n=0;const buy=(S,bid=1,pid)=>{pid??='pid-'+(n++)+'-'+Math.random().toString(36).slice(2,8);
  return S.engine.payMerchantOrder({agentId:'a1',origin:S.M.origin,orderParams:{listingId:'l',ownerToken:S.M.token,targetBid:bid,board:'all'},merchantPurchaseId:pid,idempotencyKey:'mco-'+pid,order:{item:'bid',merchant:'Shop',user_request:'promote'},purpose:'promo'}).then(r=>({r,pid}));};
const writes=S=>S.s.writes.filter(w=>w.fn==='paySignedTrusted');

test('no owner grant -> no auto-pay; the owner ask carries trust <domain> with the ATTESTOR as its one signer (+ merchant signed flag)',async()=>{
  const S=setup();const {r}=await buy(S);assert.equal(r.state,'rejected');assert.equal(writes(S).length,0);
  const sp=r._askSpec;assert.ok(sp,'ask spec');assert.equal(sp.signer,await S.att.address(S.M.host));assert.equal(sp.signerMerchant,S.M.host);assert.equal(sp.merchantSigned,true);assert.equal(sp.attested,true);
  assert.equal(S.M.seen.at(-1).signedOrder,true,'asks the merchant for its usual signed order');assert.equal(S.M.seen.at(-1).payer,undefined,'no payer field: the merchant changes nothing');
  assert.equal(sp.args.payment.to,S.M.last().depositAddress,'payee from the merchant response only');});
test('signed merchant + owner grant: NEW deposit address each order auto-pays on the signed route (paySignedTrusted, attestor-signed); owner push per payment',async()=>{
  const S=setup();await S.trust();const a=await buy(S);assert.equal(a.r.state,'paid',JSON.stringify(a.r));const b=await buy(S);assert.equal(b.r.state,'paid');
  const w=writes(S);assert.equal(w.length,2);assert.notEqual(w[0].args[1].payee,w[1].args[1].payee);assert.equal(getAddress(w[0].args[1].adapter),getAddress(A54));
  assert.equal(w[0].args[1].orderId,keccak256(toBytes(S.M.host+':'+S.M.orders.get(a.pid).paymentIntentId)));assert.equal(w[0].args[3],'0x1234','the owner grant rides along');
  assert.deepEqual(S.notes.filter(x=>x.kind==='auto_paid').map(x=>x.amount),['1','1']);assert.equal(S.notes[0].domain,S.M.host);});
test('merchant publishes a signer but the signature is missing / from another key -> NOT auto-paid, logged, no domain trust offered on that order',async()=>{
  const S=setup();await S.trust();S.M.noSig=true;const a=await buy(S);S.M.noSig=false;assert.equal(a.r.state,'rejected');assert.equal(writes(S).length,0);assert.equal(a.r._askSpec?.signer,undefined);
  S.M.badSig=true;const b=await buy(S);S.M.badSig=false;assert.equal(b.r.state,'rejected');assert.equal(writes(S).length,0);
  assert.deepEqual(S.logs.filter(x=>x[0]==='merchant_signature_rejected').map(x=>x[1].code),['merchant_signature_missing','merchant_signer_not_published']);});
test('unsigned merchant: auto-pays only up to HALF the trust caps (per payment and per day); above -> owner ask',async()=>{
  const S=setup({signed:false});await S.trust();/* caps 4 / 8 -> unsigned 2 / 4 per payment / day (amount + fee) */
  const big=await buy(S,3);assert.equal(big.r.state,'rejected');assert.equal(big.r._askSpec?.merchantSigned,false);assert.equal(writes(S).length,0);
  const a=await buy(S,2);assert.equal(a.r.state,'paid',JSON.stringify(a.r));const b=await buy(S,1);assert.equal(b.r.state,'paid');
  const c=await buy(S,1);assert.equal(c.r.state,'rejected','2 + 1 + fees already today: a third would pass half the daily cap');assert.equal(writes(S).length,2);
  const sg=setup({signed:true});await sg.trust();const d=await buy(sg,3);assert.equal(d.r.state,'paid','a SIGNED merchant gets the full trust caps');});
test('the attestor\'s independent re-check sees a different deposit address -> refused, nothing paid (falls to the owner ask)',async()=>{
  const S=setup();await S.trust();S.M.statusAddress='0x1111111111111111111111111111111111111111';const a=await buy(S);S.M.statusAddress=null;
  assert.equal(a.r.state,'rejected');assert.equal(writes(S).length,0);assert.ok(S.logs.some(x=>x[0]==='layered_attestor_refused'&&x[1].code==='deposit_address_mismatch'));});
test('a used (not fresh) deposit address is never auto-paid',async()=>{const S=setup();await S.trust();S.M.fetch2=null;
  const pid='pid-fresh';const first=await S.M.fetch(S.M.origin+'/api/v1/agent/usdc-orders',{method:'POST',body:JSON.stringify({purchaseId:pid,listingId:'l',ownerToken:S.M.token,targetBid:1,board:'all',signedOrder:true})});await first.json();
  S.used.add(S.M.orders.get(pid).depositAddress.toLowerCase());const a=await buy(S,1,pid);assert.equal(a.r.state,'rejected');assert.equal(writes(S).length,0);});
test('merchant never confirms -> domain paused (attestor refuses too) + owner push; the next order is not auto-paid; a fresh owner trust resumes',async()=>{
  const S=setup({confirm:{windowMs:300,pollMs:50}});await S.trust();S.M.confirm='open';const a=await buy(S);S.M.paid.add(a.pid);assert.equal(a.r.state,'paid');
  for(let i=0;i<40&&!S.notes.some(x=>x.kind==='merchant_paused');i++)await new Promise(z=>setTimeout(z,50));
  assert.ok(S.notes.some(x=>x.kind==='merchant_paused'&&x.domain===S.M.host),JSON.stringify(S.notes));assert.equal((await S.att.paused(S.M.host)).reason,'merchant_did_not_confirm');
  assert.equal(S.engine.layeredTrust.pausedDomains()[0].domain,S.M.host);
  S.M.confirm=undefined;const b=await buy(S);assert.equal(b.r.state,'rejected');assert.equal(writes(S).length,1);assert.equal(b.r._askSpec?.signerMerchant,S.M.host,'the owner can trust it again');
  await S.engine.layeredTrust.resumeDomain(S.M.host);assert.equal(await S.att.paused(S.M.host),null);const c=await buy(S);assert.equal(c.r.state,'paid');});
test('merchant confirms -> stays trusted (no pause)',async()=>{const S=setup();await S.trust();const a=await buy(S);assert.equal(a.r.state,'paid');S.M.paid.add(a.pid);
  assert.equal(await S.engine.layeredTrust.checkConfirm(a.r.purchaseKey),'confirmed');assert.equal(S.notes.some(x=>x.kind==='merchant_paused'),false);});
test('same order repeated (same or new idempotency key) -> never paid twice',async()=>{
  const S=setup();await S.trust();const a=await buy(S);assert.equal(a.r.state,'paid');
  const again=await buy(S,1,a.pid);assert.equal(again.r.state,'already_paid',JSON.stringify(again.r));
  const other=await S.engine.payMerchantOrder({agentId:'a1',origin:S.M.origin,orderParams:{listingId:'l',ownerToken:S.M.token,targetBid:1,board:'all'},merchantPurchaseId:a.pid,idempotencyKey:'mco-other-key-1',order:{item:'bid',merchant:'Shop',user_request:'promote'},purpose:'promo'});
  assert.equal(other.state,'already_paid');assert.equal(writes(S).length,1);});
test('only V5.4 + grant hook + attestor turn this on (otherwise the old path is untouched)',()=>{const src=readFileSync(new URL('../src/v5/engine.mjs',import.meta.url),'utf8');
  assert.match(src,/const LAY=!V51&&typeof cfg\.signerGrant==='function'&&!!cfg\.attestor;/);assert.match(src,/at=await cfg\.attestor\.attest\(/,'the gateway cannot sign without the attestor');
  assert.doesNotMatch(src.slice(src.indexOf('async function layered('),src.indexOf('const payMerchantOrder=')),/privateKey|signTypedData/,'no signing key in the gateway path');});
test('owner ask "trust" on an attested ask: the card data says merchant signed / unsigned, and a stored grant lifts the domain pause',async()=>{
  const {createOwnerAskApproval}=await import('../src/v5/owner-ask-approve.mjs');const {NO_CEILING}=await import('../src/v5/phone-signer.mjs');const {BEGINNER_DEFAULTS}=await import('../src/v5/mandates.mjs');const {createBuy}=await import('../src/v5/buy.mjs');
  for(const signed of [true,false]){const S=setup({signed});S.engine.mandates.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});for(const p of S.engine.mandates.proposals())S.engine.mandates.approve(p.id,()=>true);
    await S.engine.layeredTrust.pauseDomain(S.M.host,'merchant_did_not_confirm');
    const B=createBuy(S.engine,{sleep:async()=>{},waitMs:0});const pid='pid-ask-'+signed;
    const r=await B.buy({purpose:'promo',merchant:'Shop',item:'bid',origin:S.M.origin,orderParams:{listingId:'l',ownerToken:S.M.token,targetBid:1,board:'all'},merchantPurchaseId:pid,idempotencyKey:'idem-ask-'+signed+'-1234'},'a1');
    assert.equal(r.decision,'ask_owner',JSON.stringify(r));const a=S.engine.ownerAsks.get(r.approvalId);assert.equal(a.spec.attested,true);assert.equal(a.spec.merchantSigned,signed);
    const reqs={};const stored=[];const resumed=[];
    const o={cap:'C',api:{approve:async(c,id)=>({innerTypedData:{message:{account:'0x'+'77'.repeat(20),merchant:'0x'+'aa'.repeat(32),name:reqs[id].merchantName,epoch:'0',payees:[reqs[id].payee],signers:reqs[id].signers??[],single:reqs[id].single,daily:reqs[id].total,expiry:'9999999999',nonce:'0x'+'bb'.repeat(32),deadline:'9999999999'},domain:{}},digest:'0x'+'cd'.repeat(32)}),
      submitSignature:async()=>({status:'trusted',txHash:'0xt'}),reject:()=>{},list:()=>({pending:[],recent:[]})}};
    const engine=new Proxy(S.engine,{get:(t,k)=>k==='requestTrustFromOwner'?async x=>{const id='tr-'+(Object.keys(reqs).length+1);reqs[id]={id,...x};return {id};}:k==='payApprovedByOwner'?async()=>({state:'paid',purchaseKey:'pk',txHash:'0xp'}):t[k]});
    const sg={fromTrust:async m=>({digest:'0x'+'ee'.repeat(32),message:{...m,epoch:'1',nonce:'0x'+'12'.repeat(32),deadline:m.expiry}}),wrapper:(i,m,r,s)=>'0xg:'+r+':'+s,store:(m,w)=>stored.push(m)};
    const phone={active:()=>({index:1,fingerprint:'fp',approver:'0x'+'99'.repeat(20),maxSingle:NO_CEILING,maxDaily:NO_CEILING}),payCapable:async()=>({ok:true,index:1,active:{fingerprint:'fp',maxSingle:NO_CEILING,maxDaily:NO_CEILING}})};
    const A=createOwnerAskApproval({engine,phone,pub:{readContract:async()=>'0x'+'ab'.repeat(32)},wallet:'0x'+'77'.repeat(20),everyday:()=>({authorized:true,single:'2000000',daily:'20000000'}),walletCaps:()=>({single:6000000n,daily:12000000n}),
      trustOwner:()=>o,verifyWrapped:async()=>true,p256Verify:(x,d,r,s)=>r==='0x01'&&s==='0x02',signerGrant:sg,onGrantStored:async x=>{resumed.push(x);if(x.attested)await S.engine.layeredTrust.resumeDomain(x.merchant);}});
    const G={r:'0x01',s:'0x02'};const [c,p]=await A.prepare({id:r.approvalId,mode:'trust'});assert.equal(c,200,JSON.stringify(p));
    assert.equal(p.trust.signer,await S.att.address(S.M.host));assert.equal(p.trust.merchant,S.M.host);assert.equal(p.trust.attested,true);assert.equal(p.trust.merchantSigned,signed);assert.equal(p.trust.autoPayShare,signed?undefined:'half');
    const [c2,o2]=await A.approve({id:r.approvalId,mode:'trust',...G,pay:G,trust:{...G,signerGrant:G}});assert.equal(c2,200,JSON.stringify(o2));assert.equal(o2.trust.state,'submitting');const {waitTrust}=await import('./helpers/t1243-wait-trust.mjs');assert.equal((await waitTrust(S.engine.ownerAsks,r.approvalId)).signerGrant,'stored');
    assert.equal(stored.length,1);assert.equal(resumed[0].merchant,S.M.host);assert.deepEqual(S.engine.layeredTrust.pausedDomains(),[]);assert.equal(await S.att.paused(S.M.host),null);}});
