// t624u/t626u: Coinbase Verified Account gate. Server-side, exact schema + attester + recipient, revoked/expired refused, RPC down fails closed.
import test from 'node:test';import assert from 'node:assert/strict';
import {CBV,checkVerified,checkVerifiedMulti} from '../src/v5/cb-verified.mjs';import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';import {kvKey} from '../src/v5/store.mjs';
const A='0x1B1b13a923b6367A523BDcD88B9b96623Ea4C606',UID='0x'+'ab'.repeat(32),T='0x'+'0'.repeat(63)+'1';
const att=o=>({uid:UID,schema:CBV.schema,time:1n,expirationTime:0n,revocationTime:0n,refUID:'0x'+'0'.repeat(64),recipient:A,attester:CBV.attester,revocable:true,data:T,...o});
const pubOf=(a,uid=UID)=>({readContract:async({functionName})=>functionName==='getAttestationUid'?uid:a});
const down={readContract:async()=>{throw Error('rpc down');}};
test('valid attestation -> verified',async()=>{assert.deepEqual(await checkVerified(pubOf(att({})),A),{verified:true,reason:'ok',uid:UID});});
test('negatives: none, wrong attester, wrong schema, revoked, expired, wrong address, bad data',async()=>{
  assert.equal((await checkVerified(pubOf(att({}),'0x'+'0'.repeat(64)),A)).reason,'none');
  assert.equal((await checkVerified(pubOf(att({attester:'0x'+'9'.repeat(40)})),A)).reason,'wrong_attester');
  assert.equal((await checkVerified(pubOf(att({schema:'0x'+'1'.repeat(64)})),A)).reason,'wrong_schema');
  assert.equal((await checkVerified(pubOf(att({revocationTime:5n})),A)).reason,'revoked');
  assert.equal((await checkVerified(pubOf(att({expirationTime:10n})),A,{now:()=>100})).reason,'expired');
  assert.equal((await checkVerified(pubOf(att({expirationTime:1000n})),A,{now:()=>100})).verified,true,'not yet expired');
  assert.equal((await checkVerified(pubOf(att({recipient:'0x'+'7'.repeat(40)})),A)).reason,'wrong_recipient');
  assert.equal((await checkVerified(pubOf(att({data:'0x'+'0'.repeat(64)})),A)).reason,'bad_data');
  assert.equal((await checkVerified(pubOf(att({})),'nope')).reason,'bad_address');});
test('RPC: retries + second RPC; all down -> throws (fail closed); logs carry no address',async()=>{const logs=[];
  assert.equal((await checkVerifiedMulti([down,pubOf(att({}))],A,{log:x=>logs.push(x)})).verified,true);
  await assert.rejects(checkVerifiedMulti([down,down],A,{log:x=>logs.push(x)}),e=>e.code==='verify_unavailable');
  assert.ok(!JSON.stringify(logs).toLowerCase().includes(A.toLowerCase().slice(2)),'no address in logs');});
const mapKV=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v),del:k=>m.delete(k)};};
const call=async(N,method,url,body={})=>{let code,b;const res={writeHead(c){code=c;},end(x){b=x?JSON.parse(x):null;}};await N.handle({method,headers:{}},res,new URL('https://x'+url),{readBody:async()=>body});return {code,b};};
const mk=(verified,reg={byOwner:()=>[]},tenantStart)=>{const kv=mapKV();const N=createNewWalletOnboarding({enabled:true,kv,base:()=>'https://x',script:()=>'',quote:async()=>({}),verified,reg,tenantStart,
  pub:{readContract:async()=>{throw Error('reached wallet build');},getCode:async()=>'0x'}});kv.put(kvKey('onbnew',null,'i1'),{x:'1',y:'2',expect:A,choice:{single:'1',daily:'1',term:'1',days:90},state:'start'});return N;};
test('onboarding gate (server side): new wallet without attestation refused; RPC down refused with retry message; verified passes the gate',async()=>{
  const r=await call(mk(async()=>({verified:false,reason:'none'})),'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.equal(r.code,400);assert.equal(r.b.error,'not_verified');
  const d=await call(mk(async()=>{throw Error('down');}),'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.equal(d.code,400);assert.equal(d.b.error,'verify_unavailable');assert.match(d.b.detail,/Try again/);
  for(const reason of ['wrong_attester','wrong_schema','revoked','expired','wrong_recipient']){const x=await call(mk(async()=>({verified:false,reason})),'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.equal(x.b.error,'not_verified',reason);}
  const ok=await call(mk(async()=>({verified:true,reason:'ok'})),'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.match(ok.b.detail??'',/reached wallet build/,'gate passed');});
test('t763u: existing-wallet re-opening is gated too (no skip for current/future versions)',async()=>{
  const N=mk(async()=>({verified:false,reason:'none'}),{byOwner:()=>[{wallet:'0x5e4c116dd45edc2dbed826be8b97a72499d03fc8'}]},async()=>({id:'t',calls:[{to:'0x1',data:'0x',value:'0x0'}]}));
  const r=await call(N,'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.notEqual(r.code,200);assert.notEqual(r.b?.existing,true);
  const ok=mk(async()=>({verified:true,reason:'ok'}),{byOwner:()=>[{wallet:'0x5e4c116dd45edc2dbed826be8b97a72499d03fc8'}]},async()=>({id:'t',calls:[{to:'0x1',data:'0x',value:'0x0'}]}));
  const r2=await call(ok,'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.equal(r2.code,200);assert.equal(r2.b.existing,true);});
test('GET /onboard/new/verified: answer + official guide, bad owner refused, never trusts the app',async()=>{
  const r=await call(mk(async()=>({verified:false,reason:'none'})),'GET','/onboard/new/verified?owner='+A);assert.equal(r.b.verified,false);assert.equal(r.b.verifyUrl,'https://www.coinbase.com/onchain-verify');assert.match(r.b.guide.zh,/Coinbase/);
  assert.equal((await call(mk(null),'GET','/onboard/new/verified?owner=x')).code,400);
  const d=await call(mk(async()=>{throw Error('down');}),'GET','/onboard/new/verified?owner='+A);assert.equal(d.b.verified,false);assert.equal(d.b.reason,'unavailable');});
test('verified endpoint: answers cached 60 s, 20/min per network then 429; down answers are not cached',async()=>{let n=0;
  const N=mk(async()=>{n++;return {verified:false,reason:'none'};});const call2=async ip=>{let code,b;const res={writeHead(c){code=c;},end(x){b=JSON.parse(x);}};await N.handle({method:'GET',headers:{'cf-connecting-ip':ip}},res,new URL('https://x/onboard/new/verified?owner='+A),{readBody:async()=>({})});return {code,b};};
  for(let i=0;i<20;i++)assert.equal((await call2('9.9.9.9')).code,200);assert.equal(n,1,'cached');
  const r=await call2('9.9.9.9');assert.equal(r.code,429);assert.equal(r.b.verified,false);assert.equal((await call2('8.8.8.8')).code,200);
  let d=0;const D=mk(async()=>{d++;throw Error('down');});for(let i=0;i<3;i++)await call(D,'GET','/onboard/new/verified?owner='+A);assert.equal(d,3,'down not cached');});
test('anti-renting: one Coinbase attestation opens at most one new Kipurse wallet',async()=>{
  const kv=mapKV();const B='0x'+'5'.repeat(40);const mkN=()=>createNewWalletOnboarding({enabled:true,kv,base:()=>'https://x',script:()=>'',quote:async()=>({}),verified:async()=>({verified:true,reason:'ok',uid:UID}),reg:{byOwner:()=>[]},
    pub:{readContract:async()=>{throw Error('reached wallet build');},getCode:async()=>'0x'}});const N=mkN();
  kv.put(kvKey('onbnew',null,'a'),{x:'1',y:'2',choice:{},state:'start'});kv.put(kvKey('onbnew',null,'b'),{x:'1',y:'2',choice:{},state:'start'});
  const r1=await call(N,'POST','/onboard/new/prepare',{id:'a',owner:A});assert.match(r1.b.detail,/reached wallet build/);
  const r1b=await call(N,'POST','/onboard/new/prepare',{id:'a',owner:A});assert.match(r1b.b.detail,/reached wallet build/,'same owner retry ok');
  const r2=await call(N,'POST','/onboard/new/prepare',{id:'b',owner:B});assert.equal(r2.b.error,'verification_in_use');
  assert.ok(![...kv.m?.keys?.()??[]].some(k=>String(k).includes(UID.slice(2,20))),'uid stored only hashed');});
