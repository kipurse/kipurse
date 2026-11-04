import test from 'node:test';import assert from 'node:assert/strict';
import {writeFileSync,mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createApplePay,orderState,maskPhone,maskEmail} from '../src/v5/onramp.mjs';import {createMemoryKV} from '../src/v5/store.mjs';
const W='0x1111111111111111111111111111111111111111',O='0x2222222222222222222222222222222222222222';
const keyFile=()=>{const d=mkdtempSync(join(tmpdir(),'ap-'));const f=join(d,'k.json');writeFileSync(f,JSON.stringify({id:'kid',privateKey:'FAKE'}));return f;};
const env=m=>({KIPURSE_ONRAMP_ENABLED:'1',KIPURSE_ONRAMP_KEY_FILE:keyFile(),KIPURSE_ONRAMP_HEADLESS:m});
function fake(routes){const calls=[];return {calls,fetchFn:async(u,i)=>{const p=new URL(u).pathname;calls.push({p,m:i.method,body:i.body?JSON.parse(i.body):null});const r=routes(p,i);return {status:r[0],json:async()=>r[1]};}};}
const now=()=>Date.parse('2026-10-27T15:00:00Z');
test('off by default: nothing reaches Coinbase',async()=>{const f=fake(()=>[200,{}]);const a=createApplePay({env:{KIPURSE_ONRAMP_ENABLED:'1',KIPURSE_ONRAMP_KEY_FILE:keyFile()},fetchFn:f.fetchFn,jwt:async()=>'J',kv:createMemoryKV()});
  assert.equal(a.mode(),'off');assert.equal((await a.order(W,{amount:5,agreedAt:new Date().toISOString()}))[1].error,'applepay_not_enabled');assert.equal((await a.verifyStart(W,{channel:'sms',destination:'+14155552671'}))[1].error,'applepay_not_enabled');assert.equal(f.calls.length,0);});
test('live: OTP via Coinbase Verification API, then order to THIS wallet with verification ids; masked info',async()=>{const kv=createMemoryKV();const logs=[];
  const f=fake((p)=>p==='/platform/v2/onramp/verifications'?[200,{verificationId:'onramp_verification_x',otpExpiresAt:'t'}]:p.endsWith('/submit')?[200,{verificationId:'onramp_verification_x',verificationExpiresAt:'2026-12-26T00:00:00Z'}]
    :p==='/platform/v2/onramp/orders'?[201,{order:{orderId:'o1',status:'ONRAMP_ORDER_STATUS_PENDING_PAYMENT',destinationAddress:W,purchaseAmount:'4.88'},paymentLink:{url:'https://pay.coinbase.com/v2/api-onramp/apple-pay?x=1',paymentLinkType:'PAYMENT_LINK_TYPE_APPLE_PAY_BUTTON'}}]:[404,{}]);
  const a=createApplePay({env:env('live'),fetchFn:f.fetchFn,jwt:async()=>'J',kv,now,log:(e,d)=>logs.push([e,d])});
  assert.equal((await a.order(W,{amount:5,agreedAt:new Date(now()).toISOString()}))[1].error,'verify_first');
  assert.equal((await a.verifyStart(W,{channel:'sms',destination:'4155552671'}))[1].error,'bad_phone');assert.equal((await a.verifyStart(W,{channel:'email',destination:'nope'}))[1].error,'bad_email');
  assert.equal((await a.verifySubmit(W,{channel:'sms',code:'123456'}))[1].error,'start_first');
  for(const [ch,d] of [['sms','+14155552671'],['email','owner@example.com']]){assert.equal((await a.verifyStart(W,{channel:ch,destination:d}))[1].ok,true);assert.equal((await a.verifySubmit(W,{channel:ch,code:'12a'}))[1].error,'bad_code');assert.equal((await a.verifySubmit(W,{channel:ch,code:'123456'}))[1].ok,true);}
  const info=a.info(W);assert.equal(info.phone,'+1******2671');assert.equal(info.email,'o***@example.com');assert.equal(info.phoneVerified&&info.emailVerified,true);
  assert.equal((await a.order(W,{amount:4,agreedAt:new Date(now()).toISOString()}))[1].error,'bad_amount');assert.equal((await a.order(W,{amount:5}))[1].error,'terms_not_accepted');
  const [st,o]=await a.order(W,{amount:5,agreedAt:new Date(now()-60e3).toISOString(),clientIp:'1.2.3.4'});assert.equal(st,200);assert.equal(o.ok,true);assert.match(o.ref,/^kp-[0-9a-f]{24}$/);assert.equal(o.sandbox,false);assert.ok(!o.url.includes('useApplePaySandbox'));
  const body=f.calls.find(c=>c.p==='/platform/v2/onramp/orders').body;assert.equal(body.destinationAddress,W);assert.equal(body.destinationNetwork,'base');assert.equal(body.purchaseCurrency,'USDC');assert.equal(body.paymentMethod,'GUEST_CHECKOUT_APPLE_PAY');
  assert.equal(body.paymentAmount,'5.00');assert.equal(body.smsVerificationId,'onramp_verification_x');assert.equal(body.emailVerificationId,'onramp_verification_x');assert.equal(body.partnerUserRef,o.ref);assert.equal(body.clientIp,'1.2.3.4');
  assert.ok(!JSON.stringify(logs).includes('4155552671')&&!JSON.stringify(logs).includes('owner@')&&!JSON.stringify(logs).includes(W),'logs masked');assert.ok(!JSON.stringify(o).includes('FAKE'));});
test('sandbox: sandbox- ref, fake Apple Pay sheet param, no OTP sent',async()=>{const kv=createMemoryKV();
  const f=fake((p)=>p==='/platform/v2/onramp/orders'?[201,{order:{orderId:'o2',status:'ONRAMP_ORDER_STATUS_PENDING_PAYMENT',destinationAddress:W},paymentLink:{url:'https://pay.coinbase.com/v2/api-onramp/apple-pay?x=1'}}]:[500,{}]);
  const a=createApplePay({env:env('sandbox'),fetchFn:f.fetchFn,jwt:async()=>'J',kv,now});
  await a.verifyStart(W,{channel:'sms',destination:'+14155552671'});await a.verifySubmit(W,{channel:'sms',code:'000000'});await a.verifyStart(W,{channel:'email',destination:'t@sandbox.test'});await a.verifySubmit(W,{channel:'email',code:'000000'});
  const [,o]=await a.order(W,{amount:5,agreedAt:new Date(now()).toISOString()});assert.match(o.ref,/^sandbox-kp-/);assert.equal(new URL(o.url).searchParams.get('useApplePaySandbox'),'true');assert.equal(o.sandbox,true);
  assert.deepEqual(f.calls.map(c=>c.p),['/platform/v2/onramp/orders'],'no verification calls in sandbox');});
test('refuses a pay link for another address or a non-Coinbase link; Coinbase errors surface',async()=>{const kv=createMemoryKV();let resp;
  const a=createApplePay({env:env('sandbox'),fetchFn:fake(()=>resp).fetchFn,jwt:async()=>'J',kv,now});for(const ch of ['sms','email']){await a.verifyStart(W,{channel:ch,destination:ch==='sms'?'+14155552671':'a@b.co'});await a.verifySubmit(W,{channel:ch,code:'111111'});}
  const ag=new Date(now()).toISOString();
  resp=[201,{order:{orderId:'o',destinationAddress:O},paymentLink:{url:'https://pay.coinbase.com/x'}}];assert.equal((await a.order(W,{amount:5,agreedAt:ag}))[1].error,'wrong_destination');
  resp=[201,{order:{orderId:'o',destinationAddress:W},paymentLink:{url:'https://evil.example/x'}}];assert.equal((await a.order(W,{amount:5,agreedAt:ag}))[1].error,'bad_payment_link');
  resp=[400,{errorType:'invalid_request',errorMessage:'phone number is not a valid number'}];const [st,e]=await a.order(W,{amount:5,agreedAt:ag});assert.equal(st,400);assert.equal(e.error,'coinbase_invalid_request');});
test('order status: every branch + only own refs',async()=>{const kv=createMemoryKV();let ord;const a=createApplePay({env:env('sandbox'),jwt:async()=>'J',kv,now,
    fetchFn:fake((p)=>p==='/platform/v2/onramp/orders'?[201,{order:{orderId:'o9',destinationAddress:W},paymentLink:{url:'https://pay.coinbase.com/x'}}]:[200,{order:ord}]).fetchFn});
  for(const ch of ['sms','email']){await a.verifyStart(W,{channel:ch,destination:ch==='sms'?'+14155552671':'a@b.co'});await a.verifySubmit(W,{channel:ch,code:'111111'});}
  const [,o]=await a.order(W,{amount:5,agreedAt:new Date(now()).toISOString()});assert.equal((await a.status(O,o.ref))[0],404);assert.equal((await a.status(W,'x'))[0],400);
  for(const [s,tx,exp] of [['ONRAMP_ORDER_STATUS_PENDING_PAYMENT',null,'awaiting_payment'],['ONRAMP_ORDER_STATUS_PROCESSING',null,'arriving'],['ONRAMP_ORDER_STATUS_COMPLETED',null,'arriving'],['ONRAMP_ORDER_STATUS_COMPLETED','0xfeed','arrived'],['ONRAMP_ORDER_STATUS_FAILED',null,'failed']]){
    ord={status:s,destinationAddress:W,purchaseAmount:'4.88',...(tx?{txHash:tx}:{})};const j=(await a.status(W,o.ref))[1];assert.equal(j.state,exp,s);if(tx)assert.equal(j.txHash,tx);}
  assert.equal(orderState({status:'ONRAMP_ORDER_STATUS_COMPLETED',txHash:'0x1',destinationAddress:O,__wallet:W}).state,'wrong_destination');
  assert.equal(maskPhone('+14155552671'),'+1******2671');assert.equal(maskEmail('bob@x.com'),'b***@x.com');});
