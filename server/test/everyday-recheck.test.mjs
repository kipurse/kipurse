// t629: proves the t621 #6 bypass is closed. Old behaviour: the only everyday check ran BEFORE the amount was final (pre-check); if that
// pre-check passed (e.g. amount unknown -> allowUnknown), nothing re-checked the real amount before signing. Now payNormalized re-checks.
import test from 'node:test';import assert from 'node:assert/strict';
import {engineFor,direct,PAYEE} from './helpers/v5-fixture.mjs';
const ORD={order:{item:'test item',merchant:'Test Shop',user_request:'please buy the test item'}};
test('#6: a pre-check that lets an unknown/early amount through cannot let the payment be signed: the final amount is re-checked',async()=>{
  const calls=[];let n=0;
  const everydayCheck=a=>{calls.push(String(a.amount));n++;return n===1?null:{state:'rejected',reason:'EVERYDAY_SINGLE_LIMIT',nothingPaid:true};};
  const {engine}=engineFor({everydayCheck});engine.mandates.remember(PAYEE,'Shop');
  const r=await engine.pay({...ORD,request:direct('20000','rc-1'),idempotencyKey:'idem-rc-0001'});
  assert.equal(r.state,'rejected',JSON.stringify(r));assert.equal(r.reason,'EVERYDAY_SINGLE_LIMIT');assert.equal(r.nothingPaid,true);
  assert.ok(calls.length>=2,'checked again right before signing: '+calls.join(','));assert.equal(calls.at(-1),'20000','final check uses the real amount');});
test('#6: when every check passes the payment goes through (no false refusals)',async()=>{
  const {engine}=engineFor({everydayCheck:()=>null});engine.mandates.remember(PAYEE,'Shop');
  assert.equal((await engine.pay({...ORD,request:direct('20000','rc-2'),idempotencyKey:'idem-rc-0002'})).state,'paid');});
