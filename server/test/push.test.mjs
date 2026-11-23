import test from 'node:test';import assert from 'node:assert/strict';
import {createPush,apnsConfigFromEnv} from '../src/v5/push.mjs';
test('push: off without config; payloads carry name + amount + id, no address, category per kind',async()=>{
  assert.equal(apnsConfigFromEnv({}),null);const p=createPush({config:null});assert.equal(p.enabled,false);assert.deepEqual(await p.notify({list:()=>[{token:'ab'}]},{kind:'hold'}),{sent:0,disabled:true});
  const c=p.payloadFor({kind:'payee_confirm',id:'r1',name:'Landlord Li',amount:'15'},'zh');assert.equal(c.aps.category,'KP_PAYEE_CONFIRM');assert.equal(c.kp.trustRequestId,'r1');assert.match(c.aps.alert.body,/Landlord Li/);assert.doesNotMatch(JSON.stringify(c),/0x[0-9a-f]{8}/i);
  const h=p.payloadFor({kind:'hold',id:'h1',name:'Shop',amount:'25'},'en');assert.equal(h.aps.category,'KP_HOLD');assert.doesNotMatch(JSON.stringify(h),/[\u3400-\u9fff]/);
  assert.equal(p.payloadFor({kind:'anomaly',reason:'x'}).aps.category,'KP_ANOMALY');});
