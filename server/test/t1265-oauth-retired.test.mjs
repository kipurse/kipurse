// t1265: OAuth hygiene (client names, client cap + idle GC, authorize rate limit, index entries follow their objects, adoption rules),
// retired wallets never served (cache, /phone/find, /deposit), push tokens MOVE, personal KV values sealed, at-rest backups removed, data-dir guard.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createOAuth,cleanClientName} from '../kit/oauth.mjs';import {createAgentRouter,createTenantCache} from '../src/v5/router.mjs';
import {createMemoryKV,createSqliteKV,createRateLimiter,sealKV,kvKey,scrubUrls} from '../src/v5/store.mjs';import {createRegistry,createIndex,sha256} from '../src/v5/tenancy.mjs';
import {createDeposit} from '../src/v5/deposit.mjs';import {encryptedStore} from '../src/v5/at-rest.mjs';
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'t1265o-'));
const A='0x1000000000000000000000000000000000000001',B='0x1000000000000000000000000000000000000002',C='0x1000000000000000000000000000000000000003',O='0x1000000000000000000000000000000000000009',O2='0x100000000000000000000000000000000000000a';
const http=async(OA,method,url,body={},ip='9.9.9.9')=>{let code,b;await OA.handle({method,headers:{}},{writeHead(c){code=c;},end(x){b=x;}},new URL('https://x'+url),{readBody:async()=>body,ip});try{b=JSON.parse(b);}catch{}return {code,b};};
const mkOA=(o={})=>{const S={};const forgot=[];const OA=createOAuth({S,save(){},base:()=>'https://x',createAgentKey:()=>'a',isAgentLive:()=>true,ownerSession:()=>null,onForget:k=>forgot.push(k),...o});return {S,OA,forgot};};
test('DCR client_name: control / bidi characters, quotes and brackets removed; length capped; empty -> AI agent',()=>{
  assert.equal(cleanClientName('Claude\u0000\n"><script>‮evil'),'Claude scriptevil');assert.equal(cleanClientName(' ​ '),'AI agent');assert.equal(cleanClientName('x'.repeat(99)).length,60);
  assert.equal(cleanClientName("Grok's\tBot"),'Groks Bot');});
test('clients: capped per wallet; a client idle 30 days with no token is forgotten (and its index entry with it)',async()=>{const {S,OA,forgot}=mkOA({maxClients:3});
  const reg=n=>http(OA,'POST','/oauth/register',{client_name:'c'+n,redirect_uris:['https://cb.example/cb']});
  for(let i=0;i<3;i++)assert.equal((await reg(i)).code,201);const r=await reg(9);assert.equal(r.code,201,'t1278 S7: at the cap the oldest unused client of the busiest source makes room (an outsider cannot lock DCR)');assert.equal(Object.keys(S.oauth.clients).length,3);
  const ids=Object.keys(S.oauth.clients);S.oauth.clients[ids[2]].created=Date.now()-3600e3;assert.equal((await reg(8)).code,201,'an unused client older than 10 min makes room');assert.ok(!S.oauth.clients[ids[2]]);assert.ok(forgot.includes(ids[2]));S.oauth.clients[ids[0]].created=Date.now()-31*86400e3;S.oauth.tokens.t1={type:'access',client_id:ids[1],exp:Date.now()/1000+60};S.oauth.clients[ids[1]].created=Date.now()-31*86400e3;
  assert.equal((await reg(10)).code,201);assert.ok(!S.oauth.clients[ids[0]],'idle client gone');assert.ok(S.oauth.clients[ids[1]],'client with a live token kept');assert.ok(forgot.includes(ids[0]));});
test('revoke / code use / expiry report their keys (index entries go with them)',async()=>{const {S,OA,forgot}=mkOA();S.oauth.tokens.old={type:'access',client_id:'c',exp:1};S.oauth.pending.p={exp:1,status:'pending'};
  OA.gc();assert.ok(forgot.includes('old')&&forgot.includes('p'));const {createHash}=await import('node:crypto');S.oauth.tokens[createHash('sha256').update('tok').digest('hex')]={type:'access',exp:9e12};
  await http(OA,'POST','/oauth/revoke',{token:'tok'});assert.ok(forgot.includes(createHash('sha256').update('tok').digest('hex')));});
test('authorize GET: rate limited per client (each GET can open a request)',async()=>{const {OA}=mkOA();let last;for(let i=0;i<11;i++)last=await http(OA,'GET','/oauth/authorize?client_id=x',{},'5.5.5.5');
  assert.equal(last.code,429);assert.notEqual((await http(OA,'GET','/oauth/authorize?client_id=x',{},'6.6.6.6')).code,429);});
test('index: entries can carry a TTL; claim never takes over another wallet\'s key',()=>{let t=0;const kv=createMemoryKV({now:()=>t});const I=createIndex(kv);
  I.set('oauth','tok',A,1000);t=1001;assert.equal(I.get('oauth','tok'),null);I.set('oauth','cid',A);assert.equal(I.claim('oauth','cid',B),false);assert.equal(I.get('oauth','cid'),A.toLowerCase());assert.equal(I.claim('oauth','cid',A),true);
  const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');assert.match(s,/for\(const k of Object\.keys\(o\.clients\?\?\{\}\)\)ix\('oauth',k,0,true\)/);assert.match(s,/onForget:k=>forgetIdx\('oauth',k\)/);});
function router({recs,index:idxInit=[]}){const dir=tmp();const reg=createRegistry({file:path.join(dir,'r.json')});for(const r of recs)reg.add(r);const kv=createMemoryKV();const index=createIndex(kv);for(const [k,key,w] of idxInit)index.set(k,key,w);
  const built=[];const states={};const tenants=createTenantCache({reg,max:8,load:async rec=>{built.push(rec.wallet.toLowerCase());const S=states[rec.wallet.toLowerCase()]??={oauth:{clients:{}}};
    return {wallet:rec.wallet,rec,S,PH:{active:()=>rec.phone??null},reindex(){for(const k of Object.keys(S.oauth.clients))index.claim('oauth',k,rec.wallet);},saveState(){},close(){},handle:async(req,res,u,J)=>J(200,{at:rec.wallet})};}});
  const rl={ip:createRateLimiter(kv,{perKey:1e9,global:1e9}),tenant:createRateLimiter(kv,{perKey:1e9,global:1e9})};
  const route=createAgentRouter({reg,index,kv,obs:{log(){},metrics:()=>''},tenants,legacy:()=>null,env:{KIPURSE_SINGLE_DEFAULT:'0'},verifyP256:async()=>true,onboardNew:null,rl});return {route,reg,index,built,states,tenants,kv};}
function call(route,{url,method='GET',headers={},body=''}){return new Promise(r=>{const req=(async function*(){if(body)yield body;})();Object.assign(req,{url,method,headers,socket:{remoteAddress:'127.0.0.1'}});
  const res={h:{},writeHead(c,h){this.code=c;Object.assign(this.h,h??{});},setHeader(k,v){this.h[k]=v;},on(){},end(b){r({code:this.code,body:b?JSON.parse(b):null});},get headersSent(){return this.code!==undefined;}};route(req,res);});}
test('OAuth adoption: same owner only, and the client id index entry stays with the wallet that registered it',async()=>{
  const R=router({recs:[{wallet:A,owner:O,publicPath:'/t/'+A.toLowerCase()},{wallet:B,owner:O,publicPath:'/t/'+B.toLowerCase()},{wallet:C,owner:O2,publicPath:'/t/'+C.toLowerCase()}],index:[['oauth','kpc_1',A]]});
  await R.tenants.get(A);R.states[A.toLowerCase()].oauth.clients.kpc_1={name:'Claude',redirect_uris:['https://cb']};
  await call(R.route,{url:'/t/'+C.toLowerCase()+'/oauth/authorize?client_id=kpc_1'});assert.equal(R.states[C.toLowerCase()].oauth.clients.kpc_1,undefined,'stranger cannot adopt');
  await call(R.route,{url:'/t/'+B.toLowerCase()+'/oauth/authorize?client_id=kpc_1'});assert.ok(R.states[B.toLowerCase()].oauth.clients.kpc_1,'same owner adopts');
  assert.equal(R.index.get('oauth','kpc_1'),A.toLowerCase(),'index not overwritten');});
test('retired wallets: never built by the cache; /phone/find and /deposit follow the move',async()=>{const X='0x'+'1'.repeat(64),Y='0x'+'2'.repeat(64);
  const R=router({recs:[{wallet:A,owner:O,retired:true,movedTo:B,phone:{x:X,y:Y}},{wallet:B,owner:O,phone:{x:X,y:Y},publicPath:'/t/'+B.toLowerCase()}],index:[['phone',X,A]]});
  assert.equal(await R.tenants.get(A),null);assert.deepEqual(R.built,[]);
  const n=(await call(R.route,{url:'/phone/find/challenge',method:'POST'})).body.nonce;const f=await call(R.route,{url:'/phone/find',method:'POST',body:JSON.stringify({nonce:n,x:X,y:Y,r:'0x1',s:'0x1'})});
  assert.equal(f.code,200);assert.equal(f.body.wallet.toLowerCase(),B.toLowerCase());assert.ok(!R.built.includes(A.toLowerCase()));
  const D=createDeposit({reg:R.reg,token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',script:()=>'',usdcOf:async()=>0n,qr:async()=>'<svg/>',purchaseGate:async()=>null});
  let code,b='';await D.handle({method:'GET',headers:{}},{writeHead(c){code=c;},end(x){b=String(x);}},new URL('https://x/deposit?w='+A+'&check=1'));assert.equal(code,200);
  await D.handle({method:'GET',headers:{}},{writeHead(c){code=c;},end(x){b=String(x);}},new URL('https://x/deposit?w='+A));assert.ok(b.toLowerCase().includes(B.slice(2).toLowerCase()));assert.ok(!b.toLowerCase().includes(A.slice(2).toLowerCase()));});
test('launch: retired wallets are not built / re-armed at startup; copyPush MOVES the tokens',()=>{const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/if\(REG\.get\(legacy\(\)\)\?\.retired\)OBS\.log\('legacy_retired_not_loaded',\{\}\);else await getTenant\(legacy\(\)\);/);assert.match(s,/for\(const rec of \(REG\.all\?\.\(\)\?\?\[\]\)\)\{if\(rec\.retired\)continue;/);
  const m=s.match(/const copyPush=\(from,to\)=>\{[\s\S]*?\}catch\{\}\};/);const kv=new Map();const KV={get:k=>kv.get(k),put:(k,v)=>kv.set(k,v),del:k=>kv.delete(k)};
  const cp=new Function('KV','kvKey','OBS',m[0]+';return copyPush;')(KV,(...p)=>p.join(':'),{log(){}});kv.set('push:0xaaa:tokens',['t1']);cp('0xAAA','0xBBB');
  assert.deepEqual(kv.get('push:0xbbb:tokens'),['t1']);assert.equal(kv.get('push:0xaaa:tokens'),undefined,'source deleted');
  kv.set('push:0xaaa:tokens',['late']);cp('0xAAA','0xBBB');assert.equal(kv.get('push:0xaaa:tokens'),undefined,'a stale source list is removed on the next start');assert.deepEqual(kv.get('push:0xbbb:tokens'),['t1']);});
test('sealed KV: personal values (onramp email / phone, push tokens, read grants) are ciphertext on disk, readable through the wrapper; legacy plaintext still reads',()=>{
  const d=tmp();const file=path.join(d,'kv.sqlite');const raw=createSqliteKV({file});const KV=sealKV(raw,Buffer.alloc(32,3));const w=A.toLowerCase();
  raw.put(`onrampv:${w}`,{email:{dest:'old@plain.example'}});assert.equal(KV.get(`onrampv:${w}`).email.dest,'old@plain.example','legacy value readable');
  KV.put(`onrampv:${w}`,{sms:{dest:'+15551234567'},email:{dest:'alice@example.com'}},60e3);KV.put(kvKey('push',w,'tokens'),[{token:'deadbeef'.repeat(8)}]);KV.put(kvKey('readgrant',w,'phone'),{x:'0xfeedface',owner:O});
  KV.put('rl:global:x',{n:1});assert.deepEqual(raw.get('rl:global:x'),{n:1},'non-personal values untouched');
  const all=JSON.stringify(raw.list(''));for(const s of ['alice@example.com','+15551234567','deadbeef','0xfeedface'])assert.ok(!all.includes(s),s);
  assert.equal(KV.get(`onrampv:${w}`).email.dest,'alice@example.com');assert.equal(KV.list(`onrampv:`)[0].v.sms.dest,'+15551234567');assert.equal(KV.take(kvKey('readgrant',w,'phone')).x,'0xfeedface');
  raw.put(kvKey('push',B.toLowerCase(),'tokens'),raw.get(kvKey('push',w,'tokens')));assert.equal(KV.get(kvKey('push',B.toLowerCase(),'tokens')),undefined,'a sealed value moved to another key does not open');
  assert.equal(sealKV(raw,null),raw);raw.close();
  const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');assert.match(s,/const KV=sealKV\(/);});
test('at-rest: the .pre-encrypt.bak migration backup is removed once the encrypted file is verified (and on later opens)',()=>{const d=tmp();const st=encryptedStore(Buffer.alloc(32,5));
  const f=path.join(d,'state.json');fs.writeFileSync(f,JSON.stringify({phone:'x'}));assert.deepEqual(st.readJson(f,{}),{phone:'x'});assert.ok(!fs.existsSync(f+'.pre-encrypt.bak'));
  fs.writeFileSync(f+'.pre-encrypt.bak','stale');st.readJson(f,{});assert.ok(!fs.existsSync(f+'.pre-encrypt.bak'),'stale backup removed on open');
  const l=path.join(d,'audit.log');fs.writeFileSync(l,'{"a":1}\n');assert.deepEqual(st.readLines(l),['{"a":1}']);assert.ok(!fs.existsSync(l+'.pre-encrypt.bak'));});
test('scrubUrls: RPC / bundler URLs and key=value secrets never reach logs',()=>{assert.equal(scrubUrls('POST https://api.pimlico.io/v2/8453/rpc?apikey=pim_123 failed'),'POST <url> failed');assert.equal(scrubUrls('token=abc ok'),'token=<redacted> ok');});
test('launch: refuses to start without explicit data / config dirs outside the code tree (fork harness exempt)',()=>{const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/if\(!fork&&overrides\.allowDataInCodeTree!==true\)await assertDataDirs\(\);/);assert.match(s,/if\(!C\|\|!D\)throw Error\('BOUNDARY/);assert.match(s,/inside\(d,root\)/);});
