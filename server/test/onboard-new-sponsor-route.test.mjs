import test from 'node:test';import assert from 'node:assert/strict';
import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';
const own='0x1111111111111111111111111111111111111111';
const call=async(N,method,url,body={})=>{let code,h,b;const res={writeHead(c,hh){code=c;h=hh;},end(x){b=x?JSON.parse(x):null;}};await N.handle({method},res,new URL('https://x'+url),{readBody:async()=>body});return {code,h,b};};
const mk=sponsor=>createNewWalletOnboarding({enabled:true,kv:{get(){},put(){}},base:()=>'https://x',script:()=>'',sponsor,quote:async o=>({feeUSDC:'0.03',payer:o,sponsoredByKipurse:false,signatures:1})});
test('onboard/new: sponsorship off -> quote user-paid, paymaster route 404',async()=>{const N=mk(null);
  const q=await call(N,'GET','/onboard/new/quote?owner='+own);assert.equal(q.b.sponsoredByKipurse,false);assert.equal(q.b.sponsored,false);
  assert.equal((await call(N,'POST','/onboard/new/paymaster?id=a')).code,404);});
test('onboard/new: sponsorship on -> quote marked sponsored for an eligible owner; CORS preflight; rpc goes through the gate',async()=>{
  const seen=[];const N=mk({enabled:true,available:o=>o===own,rpc:async(id,b)=>{seen.push([id,b.method]);return {jsonrpc:'2.0',id:1,result:{}};}});
  const q=await call(N,'GET','/onboard/new/quote?owner='+own);assert.equal(q.b.sponsoredByKipurse,true);assert.equal(q.b.sponsored,true);
  const q2=await call(N,'GET','/onboard/new/quote?owner=0x'+'2'.repeat(40));assert.equal(q2.b.sponsored,false);
  const o=await call(N,'OPTIONS','/onboard/new/paymaster?id=a');assert.equal(o.code,204);assert.equal(o.h['access-control-allow-origin'],'*');
  const r=await call(N,'POST','/onboard/new/paymaster?id=a',{method:'pm_getPaymasterStubData',params:[]});assert.equal(r.code,200);assert.deepEqual(seen,[['a','pm_getPaymasterStubData']]);});
