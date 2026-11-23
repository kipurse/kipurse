import test from 'node:test';import assert from 'node:assert/strict';import {createPublicTrustApproval} from '../src/v5/trust-approve-public.mjs';
const ID='11111111-2222-3333-4444-555555555555',A='0x1111111111111111111111111111111111111111';
const mk=feePpm=>createPublicTrustApproval({owner:A,wallet:A,base:()=>'http://x',script:()=>'',feePpm,phone:{active:()=>({index:1,maxSingle:'1000000',maxDaily:'2000000'})},
  ownerApi:{list:()=>({pending:[{id:ID,status:'awaiting_signature',payee:'0x2222222222222222222222222222222222222222',single:'250000',total:'2000000'}],recent:[]}),approve:async()=>({typedData:{},innerTypedData:{message:{single:'250000'},domain:{chainId:8453}},digest:'0x00'})}});
async function call(h){let code,body;const res={writeHead:c=>{code=c;},end:s=>{body=JSON.parse(s);}};
  await h.handle({method:'POST'},res,new URL('http://x/approve/trust/phone-prepare'),{readBody:async()=>({id:ID}),ip:'1'});return {code,body};}
test('t968: Face ID trust sheet gets an exact USDC fee preview for the per-payment cap',async()=>{const {code,body}=await call(mk(async()=>1000n));
  assert.equal(code,200);assert.equal(body.feePreview.protocolFee,'250');assert.equal(body.feePreview.paidFrom,'wallet_balance');assert.equal(body.feePreview.networkFeeAtPayment,true);});
test('t968: no fee source -> no preview (never a guessed fee)',async()=>{const {body}=await call(mk(null));assert.equal(body.feePreview,null);});
