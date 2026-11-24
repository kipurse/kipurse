// SPDX-License-Identifier: AGPL-3.0-only
// t1278 C2 (mitigation; the contract cannot cancel a reservation without the owner's signature): while AI payments are paused (owner stop /
// anomaly auto-pause) the server never hands an open x402 authorization to a merchant or an AI, and the stop / status answers list the open
// reservation digests so the app can offer to cancel them.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {engineFor,USDC} from './helpers/v5-fixture.mjs';
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64');const P='0x0000000000000000000000000000000000c20001';
const req=url=>({x402Version:2,resource:{url},accepts:[{scheme:'exact',network:'eip155:84532',amount:'50000',asset:USDC,payTo:P,maxTimeoutSeconds:60,extra:{name:'USDC',version:'2',nonce:'n'}}]});
/** pause (owner stop / anomaly) lands while the reservation is being prepared on chain */
function mk(){const st={paused:false,calls:[]};const fetch=async(url,init)=>{const h=init?.headers??{};st.calls.push(Object.keys(h).some(k=>/payment-signature|x-payment/i.test(k)));
    if(st.calls.at(-1))return new Response('paid',{status:200});return new Response('',{status:402,headers:{'PAYMENT-REQUIRED':b64(req(url))}});};
  const e=engineFor({fetch,isPaused:()=>st.paused});e.engine.mandates.remember(P,'API');const w=e.client.write;
  e.client.write=async(fn,args,o)=>{const r=await w(fn,args,o);if(fn==='prepareAuthorization')st.paused=true;return r;};return {...e,st};}

test('t1278 C2: paidFetch: paused during prepare -> the payment header is never sent to the merchant; the reservation is listed for the owner',async()=>{
  const {engine,st}=mk();const r=await engine.paidFetch({agentId:'a1',url:'https://api.example/r/1',idempotencyKey:'idem-t1278-c2-1'});
  assert.equal(r.state,'paused_reservation_open',JSON.stringify(r));assert.equal(r.paymentHeader,undefined);assert.equal(r.auth,undefined);assert.equal(r.digest,undefined);
  assert.deepEqual(st.calls,[false],'the merchant only saw the unpaid request');
  const open=engine.openReservations();assert.equal(open.length,1);assert.match(open[0].digest,/^0x[0-9a-f]{64}$/);assert.equal(open[0].purchaseKey,r.purchaseKey);
  const again=await engine.paidFetch({agentId:'a1',url:'https://api.example/r/1',idempotencyKey:'idem-t1278-c2-1'});assert.equal(again.paymentHeader,undefined,'a replay hands nothing out either');});

test('t1278 C2: pay() with an x402 request: paused during prepare -> no payment header / auth / digest in the answer',async()=>{
  const {engine}=mk();const url='https://api.example/r/2';
  const r=await engine.pay({agentId:'a1',request:{status:402,url,headers:{'PAYMENT-REQUIRED':b64(req(url))}},idempotencyKey:'idem-t1278-c2-2'});
  assert.equal(r.state,'paused_reservation_open',JSON.stringify(r));assert.equal(r.paymentHeader,undefined);assert.equal(r.auth,undefined);assert.equal(engine.openReservations().length,1);});

test('t1278 C2: the launcher lists open reservations in /safety/stop, /safety/status and the emergency pause',()=>{
  const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(L,/return j\(200,\{ok:true,server:p,chain,openReservations,note:/);assert.match(L,/choices:\['24h','48h','7d','until_resume'\],openReservations\}\)/);assert.match(L,/return \{server:p,chain,openReservations\};/);});
