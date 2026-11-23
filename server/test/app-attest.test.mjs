import test from 'node:test';import assert from 'node:assert';import fs from 'node:fs';
import {verifyAttestation,cbor,APPLE_ROOT} from '../src/v5/app-attest.mjs';import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';
// synthetic vector: same structure as Apple's, signed by a throw-away test root (private keys discarded)
const V=JSON.parse(fs.readFileSync(new URL('./fixtures-app-attest.json',import.meta.url)));
test('App Attest: valid attestation passes; every tampering is refused',{skip:'OSS copy: frozen vector/fixture tied to operator addresses or the operator App Attest fixture; regenerate with your own values'},()=>{
  const r=verifyAttestation(V);assert.equal(r.ok,true);assert.equal(r.env,'development');
  assert.equal(verifyAttestation({...V,root:APPLE_ROOT}).reason,'chain','not signed by Apple -> refused');
  assert.equal(verifyAttestation({...V,x:'0x'+'33'.repeat(32)}).reason,'nonce','bound to the enrolled phone key');
  assert.equal(verifyAttestation({...V,appId:'YOUR_TEAM_ID.evil.app'}).reason,'appid');
  assert.equal(verifyAttestation({...V,keyId:Buffer.alloc(32).toString('base64')}).reason,'keyid');
  assert.equal(verifyAttestation({...V,now:new Date('2100-01-01')}).reason,'expired');
  assert.equal(verifyAttestation({...V,attestation:'AAAA'}).ok,false);assert.equal(verifyAttestation({...V,attestation:''}).ok,false);
  const b=Buffer.from(V.attestation,'base64');b[b.length-40]^=1;assert.equal(verifyAttestation({...V,attestation:b.toString('base64')}).ok,false,'authData bit flip');
  assert.ok(APPLE_ROOT.includes('BEGIN CERTIFICATE'));assert.throws(()=>cbor(Buffer.from([0x5f])));});
const mapKV=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v),del:k=>m.delete(k)};};
const call=async(N,body)=>{let code,b;const res={writeHead(c){code=c;},end(x){b=x?JSON.parse(x):null;}};await N.handle({method:'POST',headers:{}},res,new URL('https://x/onboard/new/start'),{readBody:async()=>body});return {code,b};};
test('onboard start: App Attest require mode refuses missing/invalid, log mode never blocks',{skip:'OSS copy: frozen vector/fixture tied to operator addresses or the operator App Attest fixture; regenerate with your own values'},async()=>{
  const logs=[];const mk=mode=>createNewWalletOnboarding({enabled:true,kv:mapKV(),base:()=>'https://x',script:()=>'',quote:async()=>({}),reg:{byOwner:()=>[]},pub:{},
    appAttest:{mode,verify:a=>verifyAttestation({...a,appId:V.appId,root:V.root}),log:(k,v)=>logs.push(v)}});
  const body={x:V.x,y:V.y,single:'2',daily:'5',term:'20',days:30};
  let r=await call(mk('require'),body);assert.equal(r.code,403);assert.equal(r.b.error,'app_attest_required');
  r=await call(mk('require'),{...body,attest:{keyId:V.keyId,attestation:V.attestation},x:'0x'+'99'.repeat(32)});assert.equal(r.code,403,'attestation for another key');
  r=await call(mk('require'),{...body,attest:{keyId:V.keyId,attestation:V.attestation}});assert.notEqual(r.code,403);
  r=await call(mk('log'),body);assert.notEqual(r.code,403);assert.ok(logs.some(l=>l.ok===false&&l.reason==='missing'&&l.mode==='log'));
  assert.ok(logs.every(l=>Object.keys(l).every(k=>['ok','reason','env','mode'].includes(k))),'logs carry no identifiers');});
