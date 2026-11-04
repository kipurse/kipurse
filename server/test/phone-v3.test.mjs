import test from 'node:test';import assert from 'node:assert/strict';import {decodeAbiParameters,getAddress} from 'viem';
import {approverInit,NO_CEILING,PAY_VERSIONS} from '../src/v5/phone-signer.mjs';
const W='0x'+'11'.repeat(20),T='0x'+'22'.repeat(20),X='0x'+'ab'.repeat(32),Y='0x'+'cd'.repeat(32);
test('V3 initcode: (wallet, trust, x, y) only, no caps; distinct deterministic address per version',()=>{
  const a3=approverInit({wallet:W,trust:T,x:X,y:Y,maxSingle:5000000n,maxDaily:50000000n,version:'v3'});
  const a3b=approverInit({wallet:W,trust:T,x:X,y:Y,maxSingle:1n,maxDaily:1n,version:'v3'});
  const a2=approverInit({wallet:W,trust:T,x:X,y:Y,maxSingle:5000000n,maxDaily:50000000n,version:'v2'});
  assert.equal(a3.address,a3b.address,'caps never affect a V3 address');assert.notEqual(a3.address,a2.address);
  const args=('0x'+a3.initcode.slice(-256));const [w,t,x,y]=decodeAbiParameters([{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'}],args);
  assert.equal(getAddress(w),getAddress(W));assert.equal(getAddress(t),getAddress(T));assert.equal(x,BigInt(X));assert.equal(y,BigInt(Y));});
test('V3 = no phone ceiling (uint160 max), Siri-capable; V1 is not',()=>{assert.equal(BigInt(NO_CEILING),(1n<<160n)-1n);assert.ok(PAY_VERSIONS.has('v3')&&PAY_VERSIONS.has('v2')&&!PAY_VERSIONS.has('v1'));});
test('unknown version refused',()=>{assert.throws(()=>approverInit({wallet:W,trust:T,x:X,y:Y,maxSingle:1n,maxDaily:1n,version:'v9'}));});
