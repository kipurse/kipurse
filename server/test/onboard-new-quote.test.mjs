import test from 'node:test';import assert from 'node:assert/strict';
import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';
test('onboard/new/quote passes the signed-in owner to the fee quote', async()=>{
  const seen=[];const N=createNewWalletOnboarding({enabled:true,kv:{get(){},put(){}},base:()=>'https://x',script:()=>'',quote:async o=>{seen.push(o);return {feeUSDC:'0.03',payer:o||''};}});
  let code,body;const res={writeHead(c){code=c;},end(b){body=JSON.parse(b);}};
  const own='0x10a0e1f1e3b2c4d5e6f708192a3b4c5d6e7f6e9f';
  await N.handle({method:'GET'},res,new URL('https://x/onboard/new/quote?owner='+own),{readBody:async()=>({})});
  assert.equal(code,200);assert.equal(seen[0],own);assert.equal(body.payer,own);
  await N.handle({method:'GET'},res,new URL('https://x/onboard/new/quote'),{readBody:async()=>({})});
  assert.equal(seen[1],'');assert.equal(typeof body.payer,'string');
});
