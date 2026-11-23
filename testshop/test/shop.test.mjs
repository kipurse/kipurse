// Unit tests (no network): node --test test/*.test.mjs
// Kipurse's own discovery / merchant-signature / attestor code (../../server) is used as the CLIENT, to prove Kipurse accepts this shop as-is.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import http from 'node:http';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID,randomBytes} from 'node:crypto';
import {getAddress} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {encrypt,decrypt,loadOrCreateSeed,shopKeys,readDataKey} from '../src/keys.mjs';
import {createShop,deriveStatus,USDC} from '../src/shop.mjs';import {sizePermit,CIRCLE_PAYMASTER_V08} from '../src/sweep.mjs';
const GW=new URL('../../server/',import.meta.url).pathname;
const {discoverMerchant,orderToPayment,buildCreateOrder}=await import(GW+'src/v5/discovery.mjs');
const {verifyMerchantSignature}=await import(GW+'src/v5/merchant-sig.mjs');
const {createAttestor}=await import(GW+'src/v5/attestor.mjs');
const dir=()=>mkdtempSync(join(tmpdir(),'testshop-'));
/** in-memory chain: transfers[addr] = [{value, ts, from}] ; block = 1 per second */
function fakeChain(){const T=new Map();let block=1000;const now=()=>Math.floor(Date.now()/1000);
  return {T,pay(addr,value,{ts=now(),from='0x00000000000000000000000000000000000000AA'}={}){const a=getAddress(addr);const l=T.get(a)??[];block++;l.push({txHash:'0x'+randomBytes(32).toString('hex'),logIndex:0,block,from:getAddress(from),value:BigInt(value),ts});T.set(a,l);},
    blockNumber:async()=>BigInt(++block),balanceOf:async a=>(T.get(getAddress(a))??[]).reduce((s,x)=>s+x.value,0n),
    transfersTo:async(a,f,t)=>(T.get(getAddress(a))??[]).filter(x=>x.block>=Number(f)&&x.block<=Number(t))};}
async function shopAt(opts={}){const d=dir();const keys=opts.keys??shopKeys(randomBytes(32));const chain=fakeChain();const logs=[];
  const srv=http.createServer((q,s)=>H.shop.publicHandler(q,s));await new Promise(r=>srv.listen(0,opts.host??'127.0.0.1',r));const origin=`http://${opts.host??'127.0.0.1'}:${srv.address().port}`;
  const H={keys,chain,logs,srv,d,origin,close:()=>new Promise(r=>srv.close(r))};
  H.shop=createShop({stateFile:join(d,'state.json'),keys,origin,chain,refreshMinMs:0,nowS:opts.nowS,log:(e,x)=>logs.push([e,x]),limits:opts.limits??{create:1000,status:1000,createGlobal:1000}});
  if(opts.switches)H.shop.setSwitches(opts.switches);return H;}
const post=(H,body,{q='',headers={}}={})=>fetch(H.origin+'/api/v1/agent/usdc-orders'+q,{method:'POST',headers:{'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)}).then(async r=>({status:r.status,j:await r.json()}));
const get=(H,p)=>fetch(H.origin+p).then(async r=>({status:r.status,j:await r.json().catch(()=>null)}));

test('keys: seed is encrypted at rest (AES-256-GCM), file 0600, derivation deterministic, tamper detected',()=>{const d=dir();const k=randomBytes(32);
  fs.writeFileSync(join(d,'data.key'),k.toString('hex'),{mode:0o400});assert.deepEqual(readDataKey(join(d,'data.key')),k);
  const s1=loadOrCreateSeed(join(d,'seed.enc'),k);const s2=loadOrCreateSeed(join(d,'seed.enc'),k);assert.deepEqual(s1,s2);
  assert.equal(fs.statSync(join(d,'seed.enc')).mode&0o777,0o600);const raw=fs.readFileSync(join(d,'seed.enc'),'utf8');assert.ok(!raw.includes(s1.toString('hex')));
  assert.throws(()=>loadOrCreateSeed(join(d,'seed.enc'),randomBytes(32)));
  const box=encrypt(k,Buffer.from('x'));box.ct=box.ct.replace(/^./,c=>c==='0'?'1':'0');assert.throws(()=>decrypt(k,box));
  const a=shopKeys(s1),b=shopKeys(s1);assert.equal(a.deposit(7).address,b.deposit(7).address);assert.notEqual(a.deposit(7).address,a.deposit(8).address);
  assert.notEqual(a.signer().address,a.unpublished().address);assert.notEqual(a.swapAddress(3),a.deposit(3).address);
  assert.ok(!JSON.stringify(a).includes('0x'+s1.toString('hex')));});

test('discovery: Kipurse finds the order API, the published signer and the signed-order offer (signed mode)',async()=>{const H=await shopAt();
  try{const d=await discoverMerchant(H.origin,{allowHttp:true,usdc:USDC});
    assert.equal(d.create.path,'/api/v1/agent/usdc-orders');assert.deepEqual(d.create.required,['purchaseId','item']);assert.equal(d.create.idempotencyField,'purchaseId');
    assert.equal(d.create.bodyAuth,null);assert.equal(d.status.path,'/api/v1/agent/usdc-orders/{purchaseId}');assert.equal(d.status.bearer,false);
    assert.equal(d.expectedSigner,H.shop.signer);assert.equal(d.signedOrder.available,true);assert.equal(d.signedOrder.optIn,'signedOrder');
    assert.equal(d.signedOrder.type,'EIP-712 AgentWalletPaymentOrder v5');assert.deepEqual(d.payableStatuses,['open']);assert.equal(d.ttlMax,900);assert.equal(d.maxAmountAtomic,500000n);
    assert.ok(d.sources.llms&&d.sources.capabilities&&d.sources.openapi);
    const home=await fetch(H.origin+'/').then(r=>r.text());assert.match(home,/测试商店/);assert.match(home,/TEST shop/);assert.match(home,/0\.10–0\.50 USDC/);
  }finally{await H.close();}});

test('discovery: unsigned mode publishes no signer and no signed order',async()=>{const H=await shopAt({switches:{mode:'unsigned'}});
  try{const d=await discoverMerchant(H.origin,{allowHttp:true,usdc:USDC});assert.equal(d.expectedSigner,null);assert.equal(d.signedOrder.available,false);
    const r=await post(H,{purchaseId:randomUUID(),item:'sticker',signedOrder:true});assert.equal(r.status,200);assert.deepEqual(r.j.signedOrder,{available:false,reason:'SIGNED_ORDER_NOT_CONFIGURED'});
  }finally{await H.close();}});

test('orders: catalog prices, new deposit address per order, 15 min expiry, Kipurse orderToPayment accepts',async()=>{const H=await shopAt();
  try{const d=await discoverMerchant(H.origin,{allowHttp:true,usdc:USDC});const seen=new Set();
    for(const [item,amt] of [['sticker','100000'],['badge','200000'],['poster','500000']]){const pid=randomUUID();
      const req=buildCreateOrder(d,{item},{purchaseId:pid,signedOrder:true});const r=await fetch(req.url,req.init).then(x=>x.json());
      assert.equal(r.amountAtomic,amt);assert.equal(r.status,'open');assert.equal(r.chainId,8453);assert.equal(r.tokenContract,USDC);assert.ok(!seen.has(r.depositAddress));seen.add(r.depositAddress);
      const now=Math.floor(Date.now()/1000);assert.ok(Math.abs(r.expiresAt-(now+900))<=2);
      const v=orderToPayment(r,d,{usdc:USDC});assert.equal(v.ok,true,JSON.stringify(v));assert.equal(v.payment.to,getAddress(r.depositAddress));assert.equal(v.payment.amountAtomic,amt);
      assert.equal(v.payment.id,pid);assert.equal(v.statusUrl,H.origin+'/api/v1/agent/usdc-orders/'+pid);assert.equal(v.signedOrderOffered,true);
      assert.equal(r.depositAddress,H.keys.deposit(H.shop.state().orders[pid].index).address);}
    assert.equal(H.shop.state().nextIndex,3);
  }finally{await H.close();}});

test('idempotency: same purchaseId returns the same order (no new address, no new index); other item -> 409; concurrent creates -> one order',async()=>{const H=await shopAt();
  try{const pid=randomUUID();const a=await post(H,{purchaseId:pid,item:'badge'});const b=await post(H,{purchaseId:pid,item:'badge'});
    assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.j.depositAddress,b.j.depositAddress);assert.equal(H.shop.state().nextIndex,1);
    const c=await post(H,{purchaseId:pid,item:'poster'});assert.equal(c.status,409);assert.equal(c.j.code,'ORDER_TERMS_MISMATCH');
    const u=pid.toUpperCase();const d2=await post(H,{purchaseId:u,item:'badge'});assert.equal(d2.j.depositAddress,a.j.depositAddress);
    const p2=randomUUID();const rs=await Promise.all(Array.from({length:8},()=>post(H,{purchaseId:p2,item:'sticker'})));
    assert.equal(new Set(rs.map(r=>r.j.depositAddress)).size,1);assert.equal(H.shop.state().nextIndex,2);
    // the signed copy is fixed by the first request
    const p3=randomUUID();const u1=await post(H,{purchaseId:p3,item:'sticker'});const u2=await post(H,{purchaseId:p3,item:'sticker',signedOrder:true});
    assert.equal(u1.j.signedOrder,undefined);assert.deepEqual(u2.j.signedOrder,{available:false,reason:'PURCHASE_CREATED_UNSIGNED'});
  }finally{await H.close();}});

test('signature: Kipurse merchant-sig verifies the shop signature; bad-signature and no-signature switches are refused',async()=>{const H=await shopAt();
  try{const d=await discoverMerchant(H.origin,{allowHttp:true,usdc:USDC});const now=Math.floor(Date.now()/1000);
    const chk=async r=>verifyMerchantSignature({so:r.j.signedOrder,expectedSigner:d.expectedSigner,payee:r.j.depositAddress,amountAtomic:r.j.amountAtomic,chainId:8453,declared:d.signedOrder,nowS:now,wallet:privateKeyToAccount(generatePrivateKey()).address});
    const r=await post(H,{purchaseId:randomUUID(),item:'badge',signedOrder:true});const v=await chk(r);assert.equal(v.ok,true,JSON.stringify(v));assert.equal(v.signer,H.shop.signer);assert.equal(v.format,'agent_wallet_payment_order');
    assert.equal(r.j.signedOrder.payer,'0x0000000000000000000000000000000000000000');assert.equal(r.j.signedOrder.orderDeadline,r.j.expiresAt);
    const rq=await post(H,{purchaseId:randomUUID(),item:'sticker'},{q:'?signedOrder=1'});assert.equal((await chk(rq)).ok,true);
    // the signature is bound to payee and amount
    assert.equal((await verifyMerchantSignature({so:r.j.signedOrder,expectedSigner:d.expectedSigner,payee:privateKeyToAccount(generatePrivateKey()).address,amountAtomic:r.j.amountAtomic,chainId:8453,declared:d.signedOrder,nowS:now})).code,'merchant_signature_other_payee');
    assert.equal((await verifyMerchantSignature({so:r.j.signedOrder,expectedSigner:d.expectedSigner,payee:r.j.depositAddress,amountAtomic:'1',chainId:8453,declared:d.signedOrder,nowS:now})).code,'merchant_signature_other_amount');
    H.shop.setSwitches({badSignature:true});const b=await post(H,{purchaseId:randomUUID(),item:'badge',signedOrder:true});assert.equal((await chk(b)).code,'merchant_signer_not_published');
    H.shop.setSwitches({badSignature:false,noSignature:true});const n=await post(H,{purchaseId:randomUUID(),item:'badge',signedOrder:true});
    assert.equal(n.j.signedOrder.available,false);assert.equal((await chk(n)).code,'merchant_signature_missing');
    assert.throws(()=>H.shop.setSwitches({mode:'x'}));assert.throws(()=>H.shop.setSwitches({nope:true}));assert.throws(()=>H.shop.setSwitches({neverConfirm:'yes'}));
  }finally{await H.close();}});

test('status: open -> paid (exact, in time); wrong amount -> review; late -> review; nothing -> expired; paymaster refunds ignored',async()=>{let t=Math.floor(Date.now()/1000);const H=await shopAt({nowS:()=>t});
  try{const mk=async item=>(await post(H,{purchaseId:randomUUID(),item})).j;
    const a=await mk('badge');assert.equal((await get(H,'/api/v1/agent/usdc-orders/'+a.purchaseId)).j.status,'open');
    H.chain.pay(a.depositAddress,200000n,{ts:t+10});let s=(await get(H,'/api/v1/agent/usdc-orders/'+a.purchaseId)).j;assert.equal(s.status,'paid');assert.equal(s.receivedAtomic,'200000');assert.equal(s.depositAddress,a.depositAddress);assert.equal(s.txHashes.length,1);
    H.chain.pay(a.depositAddress,5000n,{ts:t+20,from:CIRCLE_PAYMASTER_V08});assert.equal((await get(H,'/api/v1/agent/usdc-orders/'+a.purchaseId)).j.status,'paid');
    const w=await mk('badge');H.chain.pay(w.depositAddress,100000n,{ts:t+10});assert.equal((await get(H,'/api/v1/agent/usdc-orders/'+w.purchaseId)).j.status,'review');
    const o=await mk('sticker');H.chain.pay(o.depositAddress,200000n,{ts:t+10});const os=(await get(H,'/api/v1/agent/usdc-orders/'+o.purchaseId)).j;assert.equal(os.status,'review');assert.equal(os.depositAddress,null);
    const l=await mk('sticker');const e=await mk('poster');t+=901;H.chain.pay(l.depositAddress,100000n,{ts:t});
    assert.equal((await get(H,'/api/v1/agent/usdc-orders/'+l.purchaseId)).j.status,'review');assert.equal((await get(H,'/api/v1/agent/usdc-orders/'+e.purchaseId)).j.status,'expired');
    // a later duplicate payment to a paid order -> review
    H.chain.pay(a.depositAddress,200000n,{ts:t});assert.equal((await get(H,'/api/v1/agent/usdc-orders/'+a.purchaseId)).j.status,'review');
    assert.equal((await get(H,'/api/v1/agent/usdc-orders/'+randomUUID())).status,404);
    assert.equal(deriveStatus({amountAtomic:'1',expiresAt:10,nowS:9}),'open');assert.equal(deriveStatus({amountAtomic:'1',expiresAt:10,nowS:10}),'expired');
    assert.equal(deriveStatus({amountAtomic:'1',expiresAt:10,inTime:1n,nowS:99}),'paid');assert.equal(deriveStatus({amountAtomic:'1',expiresAt:10,inTime:1n,late:1n,nowS:99}),'review');
  }finally{await H.close();}});

test('switches: never-confirm keeps a paid order "open" (then "expired"); swap-address shows another address; captured per order at creation',async()=>{let t=Math.floor(Date.now()/1000);const H=await shopAt({nowS:()=>t});
  try{H.shop.setSwitches({neverConfirm:true});const n=(await post(H,{purchaseId:randomUUID(),item:'sticker'})).j;H.shop.setSwitches({neverConfirm:false,swapAddress:true});
    const s=(await post(H,{purchaseId:randomUUID(),item:'sticker'})).j;H.shop.setSwitches({swapAddress:false});const plain=(await post(H,{purchaseId:randomUUID(),item:'sticker'})).j;
    H.chain.pay(n.depositAddress,100000n,{ts:t+5});assert.equal((await get(H,'/api/v1/agent/usdc-orders/'+n.purchaseId)).j.status,'open');
    const ss=(await get(H,'/api/v1/agent/usdc-orders/'+s.purchaseId)).j;assert.equal(ss.status,'open');assert.notEqual(ss.depositAddress,s.depositAddress);assert.equal(ss.depositAddress,H.keys.swapAddress(H.shop.state().orders[s.purchaseId].index));
    assert.equal((await get(H,'/api/v1/agent/usdc-orders/'+plain.purchaseId)).j.depositAddress,plain.depositAddress);
    t+=901;assert.equal((await get(H,'/api/v1/agent/usdc-orders/'+n.purchaseId)).j.status,'expired');assert.equal(H.shop.state().orders[n.purchaseId].status,'paid');
  }finally{await H.close();}});

test('attestor (Kipurse, separate service code) signs a normal shop order and refuses swapped address / bad signature',async()=>{const H=await shopAt();
  try{const adapter=privateKeyToAccount(generatePrivateKey()).address,wallet=privateKeyToAccount(generatePrivateKey()).address;
    const A=createAttestor({keyDir:join(H.d,'att'),dataKey:randomBytes(32),chainId:8453,adapters:[adapter],allowHttpLocal:true,usdc:USDC});
    const q=r=>({domain:'127.0.0.1',ref:r.purchaseId,purchaseId:r.purchaseId,statusUrl:H.origin+r.statusUrl,payee:r.depositAddress,amountAtomic:r.amountAtomic,expiresAt:r.expiresAt,payer:wallet,chainId:8453,adapter,merchantSignedOrder:r.signedOrder});
    const r=(await post(H,{purchaseId:randomUUID(),item:'badge',signedOrder:true})).j;const ok=await A.attest(q(r));assert.equal(ok.ok,true,JSON.stringify(ok));assert.equal(ok.merchantSigned,true);
    H.shop.setSwitches({swapAddress:true});const s=(await post(H,{purchaseId:randomUUID(),item:'badge',signedOrder:true})).j;assert.equal((await A.attest(q(s))).code,'deposit_address_mismatch');
    H.shop.setSwitches({swapAddress:false,badSignature:true});const b=(await post(H,{purchaseId:randomUUID(),item:'badge',signedOrder:true})).j;assert.equal((await A.attest(q(b))).code,'merchant_signer_not_published');
  }finally{await H.close();}});

test('http limits: 415, 413, bad JSON, unknown field, bad uuid / item / signedOrder, 405, admin not reachable publicly, rate limit 429',async()=>{const H=await shopAt({limits:{create:7,status:1000,createGlobal:1000}});
  try{assert.equal((await post(H,{purchaseId:randomUUID(),item:'badge'},{headers:{'content-type':'text/plain'}})).status,415);
    assert.equal((await post(H,JSON.stringify({purchaseId:randomUUID(),item:'badge',pad:'x'.repeat(5000)}))).status,413);
    assert.equal((await post(H,'{nope')).j.code,'INVALID_JSON');assert.equal((await post(H,{purchaseId:randomUUID(),item:'badge',payee:'0x1'})).j.code,'UNKNOWN_FIELD');
    assert.equal((await post(H,{purchaseId:'abc',item:'badge'})).j.code,'INVALID_PURCHASE_ID');assert.equal((await post(H,{purchaseId:randomUUID(),item:'car'})).j.code,'INVALID_ITEM');
    assert.equal((await post(H,{purchaseId:randomUUID(),item:'badge',signedOrder:'yes'})).j.code,'INVALID_SIGNED_ORDER');
    assert.equal((await fetch(H.origin+'/api/v1/agent/usdc-orders',{method:'DELETE'})).status,405);
    for(const p of ['/admin/status','/admin/sweep'])assert.equal((await fetch(H.origin+p)).status,404);
    assert.equal((await fetch(H.origin+'/admin/sweep',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
    const r=await post(H,{purchaseId:randomUUID(),item:'badge'});assert.equal(r.status,429);assert.equal(r.j.code,'RATE_LIMITED');
    assert.ok(!JSON.stringify(H.logs).match(/[0-9a-f]{64}/i),'no 32-byte hex secrets in logs');
  }finally{await H.close();}});

test('admin API on its own listener: status, switches, orders; sweep refuses when not configured',async()=>{const H=await shopAt();
  const sock=join(H.d,'admin.sock');const adm=http.createServer(H.shop.adminHandler);await new Promise(r=>adm.listen(sock,r));
  const call=(method,path,body)=>new Promise((ok,no)=>{const q=http.request({socketPath:sock,method,path,headers:{'content-type':'application/json'}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>ok({code:res.statusCode,j:JSON.parse(d)}));});q.on('error',no);if(body)q.write(JSON.stringify(body));q.end();});
  try{assert.equal((await call('POST','/admin/switches',{mode:'unsigned',neverConfirm:true})).j.switches.mode,'unsigned');
    const st=(await call('GET','/admin/status')).j;assert.equal(st.switches.neverConfirm,true);assert.equal(st.sweep.enabled,false);
    assert.equal((await call('POST','/admin/switches',{bogus:1})).code,400);
    await post(H,{purchaseId:randomUUID(),item:'poster'});const os=(await call('GET','/admin/orders')).j;assert.equal(os.length,1);assert.equal(os[0].flags.neverConfirm,true);
    assert.equal((await call('POST','/admin/sweep',{dryRun:true})).j.code,'SWEEP_NOT_CONFIGURED');
  }finally{adm.close();await H.close();}});

test('sweep sizing: permit covers Circle prefund x safety, floored and capped',()=>{
  const p=sizePermit({totalGas:500000n,maxFeePerGas:10_000_000n,usdcPerEthAtomic:3000_000000n,cap:50000n});// 5e12 wei * 3000 = 0.015 USDC *1.1*2 = 0.033
  assert.equal(p,33000n);assert.equal(sizePermit({totalGas:1n,maxFeePerGas:1n,usdcPerEthAtomic:1n,cap:50000n}),1000n);
  assert.equal(sizePermit({totalGas:10n**7n,maxFeePerGas:10n**9n,usdcPerEthAtomic:3000_000000n,cap:50000n}),50000n);});

test('auto sweep: off when not configured; once a day and only above the threshold',async()=>{const d=dir();const keys=shopKeys(randomBytes(32));const chain=fakeChain();let t=2_000_000_000;
  const shop=createShop({stateFile:join(d,'s.json'),keys,origin:'http://127.0.0.1:1',chain,nowS:()=>t,refreshMinMs:0,sweep:{to:'0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb',rpc:async()=>{throw Error('no bundler in unit test');},pub:null,autoMinAtomic:300000n}});
  const r1=await shop.createOrder({purchaseId:randomUUID(),item:'poster'});chain.pay(r1.body.depositAddress,500000n,{ts:t+1});await shop.refresh(shop.state().orders[r1.body.purchaseId],{force:true});
  assert.equal(shop.state().orders[r1.body.purchaseId].status,'paid');
  const dry=await shop.sweepAll({dryRun:true});assert.equal(dry.results[0].state,'would_sweep');
  const a=await shop.autoSweepCheck();assert.equal(a.ran,true);assert.equal(a.result.results[0].state,'error');   // tried (bundler fails in this unit test), nothing lost
  assert.equal((await shop.autoSweepCheck()).reason,'once_a_day');t+=86401;
  const d2=dir();const shop2=createShop({stateFile:join(d2,'s.json'),keys:shopKeys(randomBytes(32)),origin:'x',chain,nowS:()=>t,sweep:{to:'0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb',rpc:async()=>0,pub:null,autoMinAtomic:300000n}});
  const r2=await shop2.createOrder({purchaseId:randomUUID(),item:'badge'});chain.pay(r2.body.depositAddress,200000n,{ts:t+1});await shop2.refresh(shop2.state().orders[r2.body.purchaseId],{force:true});
  assert.equal((await shop2.autoSweepCheck()).reason,'below_threshold');});
