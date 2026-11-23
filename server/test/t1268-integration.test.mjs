// t1268: phone-signed everyday (AI) limits, sign-in key proof fixture, approver / seat hints for the app's on-chain check,
// stale inline-trust cleanup hook, sanctions dates on the local-only /healthz for the monitor.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {P256} from 'ox';import {p256VerifyDigest,approverHint} from '../src/v5/phone-signer.mjs';
import {everydayText,everydayDigest} from '../src/v5/everyday-limits.mjs';import {createSignin,signinKeyDigest} from '../src/v5/signin.mjs';
import {createAgentRouter,createTenantCache} from '../src/v5/router.mjs';import {createMemoryKV,createRateLimiter} from '../src/v5/store.mjs';import {createRegistry,createIndex} from '../src/v5/tenancy.mjs';
import {createSanctions} from '../src/v5/sanctions.mjs';
const hx=n=>'0x'+n.toString(16).padStart(64,'0');
const key=()=>{const priv=P256.randomPrivateKey();const pub=P256.getPublicKey({privateKey:priv});return {priv,x:hx(pub.x),y:hx(pub.y)};};
const sign=(k,d)=>{const sg=P256.sign({payload:d,privateKey:k.priv});return {r:hx(sg.r),s:hx(sg.s)};};
const SRC=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
const W='0x4494cEd7F076c523B3Da8e013E6706AC4d9D3aE6',N='0123456789abcdef0123456789abcdef0123456789abcdef';

test('everyday limits text: one exact format (lowercase wallet, canonical atomic integers, server nonce), SHA-256',()=>{
  assert.equal(everydayText({wallet:W,single:'1000000',daily:'5000000',term:'100000000',nonce:N}),
    `Kipurse everyday limits v1\nwallet:${W.toLowerCase()}\nsingle:1000000\ndaily:5000000\nterm:100000000\nnonce:${N}`);
  for(const bad of ['01','1.5','-1','',' 1','1e6',null,undefined,'0x10'])assert.throws(()=>everydayText({wallet:W,single:bad,daily:'1',term:'1',nonce:N}),/bad_amount/,String(bad));
  assert.match(everydayDigest({wallet:W,single:'1',daily:'1',term:'1',nonce:N}),/^0x[0-9a-f]{64}$/);});

test('everyday limits: the active phone key signs exactly the amounts; any other amount / key / nonce fails',()=>{
  const k=key(),evil=key();const o={wallet:W,single:'2500000',daily:'7000000',term:'40000000',nonce:N};const sg=sign(k,everydayDigest(o));
  assert.equal(p256VerifyDigest(k,everydayDigest(o),sg.r,sg.s),true);
  assert.equal(p256VerifyDigest(k,everydayDigest({...o,daily:'7000001'}),sg.r,sg.s),false);
  assert.equal(p256VerifyDigest(k,everydayDigest({...o,nonce:'f'.repeat(48)}),sg.r,sg.s),false);
  assert.equal(p256VerifyDigest(evil,everydayDigest(o),sg.r,sg.s),false);});

test('launch: POST /everyday needs a live phone session AND a phone signature over a single-use challenge before EVD.set',()=>{
  const m=SRC.match(/if\(u\.pathname==='\/everyday'&&req\.method==='POST'\)\{[\s\S]*?return j\(r\.ok\?200:400,r\);\}/);assert.ok(m,'handler found');const h=m[0];
  const i=k=>{const n=h.indexOf(k);assert.ok(n>=0,k);return n;};
  assert.ok(i('PS.check(req)')<i("KV.take(kvKey('evd-chal',R.wallet,n))"));assert.ok(i("KV.take(kvKey('evd-chal',R.wallet,n))")<i('p256VerifyDigest(a,everydayDigest({wallet:R.wallet,single:b?.single,daily:b?.daily,term:b?.term,nonce:n})'));
  assert.ok(i('const a=PH.active()')<i('EVD.set('));assert.ok(i('if(!sig)')<i('EVD.set('));
  assert.match(SRC,/if\(u\.pathname==='\/everyday\/challenge'&&req\.method==='POST'\)\{if\(!PS\.check\(req\)\)return j\(401,\{error:'phone_session_required'\}\);const n=\(await import\('node:crypto'\)\)\.randomBytes\(24\)\.toString\('hex'\);KV\.put\(kvKey\('evd-chal',R\.wallet,n\),1,120e3\)/);
  // first connect (OAuth) keeps its own phone signature (firstDigest) -> commitSpend is unchanged
  assert.match(SRC,/commitSpend:\(amounts\)=>\{const prior=everyKV\.get\(everyKey\);const r=EVD\.set\(/);
  assert.equal((SRC.match(/EVD\.set\(/g)??[]).length,2,'no other unsigned writer of the everyday limits');});

test('launch: stale inline trust -> its KV entry is deleted (only the entry the engine judged)',()=>{
  const m=SRC.match(/out\.onStaleInlineTrust=\(\{payee,merchant,epoch\}=\{\}\)=>\{[\s\S]*?\}catch\{\}\};/);assert.ok(m);
  const kv=new Map();const KV={get:k=>kv.get(k),put:(k,v)=>kv.set(k,v),del:k=>kv.delete(k)};const R={wallet:W};
  const f=new Function('KV','R','OBS','const out={};'+m[0]+';return out.onStaleInlineTrust;')(KV,R,{log(){}});
  const P='0x1768000000000000000000000000000000E9fB00',k='v55inline:'+W.toLowerCase()+':'+P.toLowerCase(),M='0x'+'11'.repeat(32);
  kv.set(k,{payee:P,merchant:M,epoch:'2'});f({payee:P,merchant:M,epoch:'1'});assert.ok(kv.has(k),'newer entry kept');
  f({payee:P,merchant:M,epoch:'2'});assert.ok(!kv.has(k),'stale entry dropped');
  kv.set(k,{payee:P,merchant:M});f({payee:P,merchant:M,epoch:'0'});assert.ok(!kv.has(k),'pre-t1264 entry (no epoch = 0) dropped');
  assert.doesNotThrow(()=>f({}));
  // the store method exists on every KV backend
  assert.equal(typeof createMemoryKV().del,'function');});

test('approverHint: seat for key-seat wallets, approver for PhoneApprover wallets, nothing otherwise',()=>{
  const A='0x00000000000000000000000000000000000000b2';
  assert.deepEqual(approverHint({approver:A,version:'seat1'}),{seat:'0x00000000000000000000000000000000000000b2'});
  assert.deepEqual(approverHint({approver:A,version:'seat2'}),{seat:'0x00000000000000000000000000000000000000b2'});
  assert.deepEqual(approverHint({approver:A,version:'v3'}),{approver:'0x00000000000000000000000000000000000000b2'});
  assert.deepEqual(approverHint(null),{});assert.deepEqual(approverHint({approver:'zz'}),{});});

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'t1268-'));
function router(recs,extra={}){const reg=createRegistry({file:path.join(tmp(),'r.json')});for(const r of recs)reg.add(r);const kv=createMemoryKV();const index=createIndex(kv);
  for(const r of recs)if(r.phone)index.set('phone',r.phone.x,r.wallet);
  const tenants=createTenantCache({reg,max:8,load:async rec=>({wallet:rec.wallet,rec,S:{},PH:{active:()=>rec.phone??null},reindex(){},saveState(){},close(){},handle:async(req,res,u,J)=>J(200,{})})});
  const rl={ip:createRateLimiter(kv,{perKey:1e9,global:1e9}),tenant:createRateLimiter(kv,{perKey:1e9,global:1e9})};
  return createAgentRouter({reg,index,kv,obs:{log(){},metrics:()=>''},tenants,legacy:()=>null,env:{},verifyP256:async()=>true,onboardNew:null,rl,...extra});}
function call(route,{url,method='GET',headers={},body=''}){return new Promise(r=>{const req=(async function*(){if(body)yield body;})();Object.assign(req,{url,method,headers,socket:{remoteAddress:'127.0.0.1'}});
  const res={h:{},writeHead(c,h){this.code=c;Object.assign(this.h,h??{});},setHeader(k,v){this.h[k]=v;},on(){},end(b){r({code:this.code,body:b?JSON.parse(b):null});},get headersSent(){return this.code!==undefined;}};route(req,res);});}

test('/phone/find returns the seat (key-seat wallet) or approver (PhoneApprover wallet) next to the wallet',async()=>{
  const X='0x'+'1'.repeat(64),Y='0x'+'2'.repeat(64),X2='0x'+'3'.repeat(64);const A='0x1000000000000000000000000000000000000001',B='0x1000000000000000000000000000000000000002',O='0x1000000000000000000000000000000000000009';
  const SEAT='0x00000000000000000000000000000000000000c5',APP='0x00000000000000000000000000000000000000a5';
  const route=router([{wallet:A,owner:O,phone:{x:X,y:Y,approver:SEAT,version:'seat2'}},{wallet:B,owner:O,phone:{x:X2,y:Y,approver:APP,version:'v3'}}]);
  const find=async x=>{const n=(await call(route,{url:'/phone/find/challenge',method:'POST'})).body.nonce;return (await call(route,{url:'/phone/find',method:'POST',body:JSON.stringify({nonce:n,x,y:Y,r:'0x1',s:'0x1'})})).body;};
  const a=await find(X);assert.equal(a.wallet.toLowerCase(),A.toLowerCase());assert.equal(a.seat.toLowerCase(),SEAT);assert.equal(a.approver,undefined);
  const b=await find(X2);assert.equal(b.approver.toLowerCase(),APP);assert.equal(b.seat,undefined);});

test('/healthz (local only) reports the bundled + live sanctions list dates; public (tunnel) requests get nothing',async()=>{
  const route=router([],{sanctions:()=>({snapshotDate:'2026-10-01',liveDate:'2026-11-18',liveFetchedAt:'2026-11-20T03:00:00.000Z',count:120,liveCount:130})});
  const h=await call(route,{url:'/healthz'});assert.equal(h.code,200);assert.equal(h.body.ok,true);assert.equal(h.body.sanctions.liveDate,'2026-11-18');assert.equal(h.body.sanctions.liveFetchedAt,'2026-11-20T03:00:00.000Z');
  const pub=await call(route,{url:'/healthz',headers:{'cf-connecting-ip':'9.9.9.9'}});assert.notEqual(pub.body?.sanctions?.liveDate,'2026-11-18');
  // default wiring: the real sanctions module (bundled snapshot date always present)
  const d=await call(router([]),{url:'/healthz'});assert.match(String(d.body.sanctions.snapshotDate),/^\d{4}-\d{2}-\d{2}$/);
  // info() carries the live file's fetch time
  const dir=tmp(),f=path.join(dir,'live.json');fs.writeFileSync(f,JSON.stringify({snapshotDate:'2026-11-18',fetchedAt:'2026-11-20T03:00:00.000Z',addresses:Array.from({length:60},(_,i)=>'0x'+i.toString(16).padStart(40,'0'))}));
  const {liveReader}=await import('../src/v5/sanctions.mjs');const i=createSanctions({pub:null,oracle:null,live:liveReader(f)}).info();assert.equal(i.liveDate,'2026-11-18');assert.equal(i.liveFetchedAt,'2026-11-20T03:00:00.000Z');assert.equal(i.liveCount,60);});

test('monitor: reads the live list from 127.0.0.1:8651/healthz; alerts only when live is stale/missing AND the bundled snapshot is old',()=>{
  const s=fs.readFileSync(new URL('../scripts/monitor.mjs',import.meta.url),'utf8');
  assert.match(s,/process\.env\.KIPURSE_HEALTHZ\?\?'http:\/\/127\.0\.0\.1:8651\/healthz'/);
  assert.match(s,/const liveOk=liveAge!==null&&liveAge<=9,snapOk=snapAge!==null&&snapAge<=45;/);assert.match(s,/\(!liveOk&&!snapOk\?alerts:ok\)\.push\(line\)/);
  assert.doesNotMatch(s,/\(age>45\?alerts:ok\)/);assert.doesNotMatch(s,/readFileSync\(process\.env\.KIPURSE_SANCTIONS_LIVE/);});

test('sign-in: status / verify name the seat or approver of the wallet (the app checks it on chain)',async()=>{
  const {privateKeyToAccount,generatePrivateKey}=await import('viem/accounts');const {verifyMessage}=await import('viem');
  const a=privateKeyToAccount(generatePrivateKey());const WW='0x00000000000000000000000000000000000000A1';const m=new Map();
  const S=createSignin({kv:{put:(k,v)=>m.set(k,v),get:k=>m.get(k),take:k=>{const v=m.get(k);m.delete(k);return v;}},pub:{verifyMessage:x=>verifyMessage(x),readContract:async()=>true},
    reg:{byOwner:o=>o.toLowerCase()===a.address.toLowerCase()?[{wallet:WW,publicPath:'/t/'+WW.toLowerCase()}]:[]},phoneOf:async()=>({x:'0x01',y:'0x02',approver:'0x00000000000000000000000000000000000000c5',version:'seat2'}),base:()=>'https://pay.kipurse.com',script:()=>''});
  const st=S.start({x:'0x09',y:'0x02'});const {message}=S.message(st.id,a.address);const r=await S.verify(st.id,{address:a.address,message,signature:await a.signMessage({message})});
  assert.equal(r.result,'bind');assert.equal(r.seat,'0x00000000000000000000000000000000000000c5');
  assert.equal(S.status(st.id,st.poll).seat,'0x00000000000000000000000000000000000000c5');
  assert.equal((await S.verify(st.id,{poll:st.poll})).seat,'0x00000000000000000000000000000000000000c5');});

test('the iOS fixture is exactly what this code generates (regenerate with scripts/t1268-phone-texts-fixture.mjs)',async()=>{
  const {execFileSync}=await import('node:child_process');const p=new URL('../../ios/Tests/KipurseCoreTests/t1268-phone-texts.json.txt',import.meta.url);
  if(!fs.existsSync(p))return;   // the iOS repo is not next to this checkout (CI / public export)
  const gen=execFileSync(process.execPath,[new URL('../scripts/t1268-phone-texts-fixture.mjs',import.meta.url).pathname],{encoding:'utf8'});
  assert.equal(fs.readFileSync(p,'utf8'),gen);
  const j=JSON.parse(gen);assert.ok(j.signin.length>=5&&j.everyday.length>=15);for(const c of j.signin)assert.equal(c.digest,signinKeyDigest(c.id));});
