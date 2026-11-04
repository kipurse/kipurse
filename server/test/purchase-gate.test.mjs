import test from 'node:test';import assert from 'node:assert';import {createPurchaseGate} from '../src/v5/purchase-gate.mjs';import {createDeposit} from '../src/v5/deposit.mjs';
const O='0x'+'1'.repeat(40),W='0x'+'2'.repeat(40);
test('purchase gate: verified passes (cached), missing attestation refused, RPC down fails closed, bad owner refused',async()=>{
  let n=0,mode='ok';const g=createPurchaseGate({check:async()=>{n++;if(mode==='down')throw Object.assign(Error('x'),{code:'verify_unavailable'});return {verified:mode==='ok',reason:mode==='ok'?'ok':'none'};}});
  assert.equal(await g(O),null);assert.equal(await g(O),null);assert.equal(n,1,'positive answer cached');
  mode='none';const r=await g('0x'+'3'.repeat(40),'zh');assert.equal(r[0],403);assert.equal(r[1].error,'not_verified');assert.match(r[1].detail,/Coinbase/);
  mode='down';const d=await g('0x'+'4'.repeat(40));assert.equal(d[0],503);assert.equal(d[1].retry,true);
  const d2=await g('0x'+'4'.repeat(40));assert.equal(d2[0],503,'outage is never cached as ok');
  assert.equal((await g('nope'))[0],409);assert.equal((await g(null))[0],409);});
test('deposit page Apple Pay buy: no Onramp session unless the owner is Coinbase-verified; plain deposit page never gated',async()=>{
  let sessions=0;const onramp={session:async()=>{sessions++;return {url:'https://pay.coinbase.com/x'};}};
  const mk=verified=>createDeposit({reg:{get:()=>({wallet:W,owner:O})},token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',onramp,usdcOf:async()=>0n,
    purchaseGate:createPurchaseGate({check:async()=>({verified})})});
  const call=async(D,q)=>{let code=null,body='';const res={writeHead:c=>{code=c;},setHeader(){},end:b=>{body=String(b??'');}};await D.handle({method:'GET',headers:{}},res,new URL('https://x/deposit?w='+W+q));return {code,body};};
  let r=await call(mk(false),'&buy=1&amt=20');assert.equal(r.code,403);assert.equal(sessions,0,'no Onramp session created');assert.match(r.body,/onchain-verify/);
  r=await call(mk(true),'&buy=1&amt=20');assert.notEqual(r.code,403);assert.equal(sessions,1);
  r=await call(mk(false),'');assert.notEqual(r.code,403,'deposit page itself (send USDC in) is not gated');
  const D=createDeposit({reg:{get:()=>({wallet:W,owner:O})},token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',onramp,usdcOf:async()=>0n});
  r=await call(D,'&buy=1');assert.ok(r.code>=500,'no gate configured -> fail closed');});
test('only purchase routes call the gate; withdraw / pause / safety are never gated',async()=>{
  const fs=await import('node:fs');const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  const at=[...s.matchAll(/PGATE\(/g)].map(m=>m.index);assert.equal(at.length,2,'exactly the Apple Pay and Onramp-session routes');
  for(const k of at){const before=s.slice(Math.max(0,k-1500),k);const route=[...before.matchAll(/u\.pathname(?:\.startsWith\(|===)'([^']+)'/g)].pop()?.[1];assert.match(route,/^\/phone\/onramp\//,'gate inside '+route);}});
