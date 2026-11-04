import test from 'node:test';import assert from 'node:assert/strict';import {buildReceipt,assertWording} from '../src/v5/receipt.mjs';
test('t968: receipt totals = amount + fee (rounded up) + network fee, all USDC from wallet',()=>{
  const r=buildReceipt({amount:1000000n,ppm:5000,networkFee:1234n,payee:'0xabc'});
  assert.equal(r.protocolFee,'5000');assert.equal(r.total,String(1000000+5000+1234));assert.equal(r.paidFrom,'wallet_balance');
  assert.match(r.lines.zh[3],/1\.006234 USDC/);for(const l of [...r.lines.zh,...r.lines.en])assertWording(l);});
test('t968: fee rounds up on tiny payments',()=>{assert.equal(buildReceipt({amount:1n,ppm:5000}).protocolFee,'1');});
test('t968: banned wording rejected',()=>{for(const w of ['免费','垫付','赞助','Gasless'])assert.throws(()=>assertWording('x'+w));});
