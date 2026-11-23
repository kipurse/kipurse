// Open-core router, MCP pool, anomaly auto-pause, per-user encryption at rest, input fuzz.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {createAgentRouter,createTenantCache,createMcpPool} from '../src/v5/router.mjs';import {createAnomalyGuard,guardEngine} from '../src/v5/anomaly.mjs';
import {tenantStore,loadDataKey,plainStore} from '../src/v5/at-rest.mjs';import {createMemoryKV,createRateLimiter} from '../src/v5/store.mjs';import {createRegistry,createIndex,sha256} from '../src/v5/tenancy.mjs';
const A='0x1000000000000000000000000000000000000001',B='0x1000000000000000000000000000000000000002',O='0x1000000000000000000000000000000000000003';
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kp-r-'));const reg=createRegistry({file:path.join(dir,'r.json')});const kv=createMemoryKV();const index=createIndex(kv);
  reg.add({wallet:A,owner:O,publicPath:''});reg.add({wallet:B,owner:O,publicPath:'/t/'+B.toLowerCase()});
  const tok={[A]:'kpa_'+randomBytes(16).toString('hex'),[B]:'kpa_'+randomBytes(16).toString('hex')};index.set('agent',sha256(tok[A]),A);index.set('agent',sha256(tok[B]),B);
  const hits=[];let built=0;const tenants=createTenantCache({reg,max:1,load:async rec=>{built++;return {wallet:rec.wallet,rec,PH:{active:()=>null},reindex(){},close(){},
    handle:async(req,res,u,J)=>{const t=String(req.headers.authorization??'').replace(/^Bearer /,'');const ok=!t||t===tok[rec.wallet];hits.push([rec.wallet,u.pathname,ok]);J(ok?200:401,{w:rec.wallet});}};}});
  const rl={ip:createRateLimiter(kv,{perKey:1e9,global:1e9}),tenant:createRateLimiter(kv,{perKey:1e9,global:1e9})};
  const route=createAgentRouter({reg,index,kv,obs:{log(){},metrics:()=>''},tenants,legacy:()=>A,env:{},verifyP256:async()=>false,onboardNew:null,rl});
  return {route,tok,hits,tenants,built:()=>built};}
function call(route,{url,method='POST',headers={},body=''}){return new Promise(r=>{const req=(async function*(){if(body)yield body;})();Object.assign(req,{url,method,headers,socket:{remoteAddress:'127.0.0.1'}});
  const res={h:{},writeHead(c,h){this.code=c;Object.assign(this.h,h);},setHeader(k,v){this.h[k]=v;},on(){},end(b){r({code:this.code,body:b});},get headersSent(){return this.code!==undefined;}};route(req,res);});}
test('router: credentials never reach another wallet; fuzzed inputs never 500 and never cross',async()=>{const {route,tok,hits}=setup();
  assert.equal((await call(route,{url:'/mcp',headers:{authorization:'Bearer '+tok[A]}})).code,200);
  assert.equal((await call(route,{url:'/t/'+B.toLowerCase()+'/mcp',headers:{authorization:'Bearer '+tok[A]}})).code,403);
  assert.equal((await call(route,{url:'/mcp',headers:{authorization:'Bearer '+tok[A],'x-kipurse-wallet':B}})).code,403);
  assert.equal((await call(route,{url:'/mcp',headers:{authorization:'Bearer '+tok[B]}})).code,200);assert.equal(hits.at(-1)[0],B);
  const paths=['/mcp','/t/'+A.toLowerCase()+'/mcp','/t/'+B.toLowerCase()+'/mcp','/t/0xZZ/mcp','/../mcp','/t/'+B+'/../'+A+'/mcp','/%2e%2e/mcp','/phone/find','/oauth/token','/mcp?wallet='+B,'/'+'a'.repeat(600)];
  const bodies=['','{','{"nonce":"x"}','{"__proto__":{"x":1}}','a'.repeat(70000),'{"code":"'+tok[B]+'"}'];const toks=[tok[A],tok[B],'kpa_bad','',"' OR 1=1 --",'kps_x'];
  for(let i=0;i<3000;i++){const p=paths[i%paths.length],t=toks[(i*7)%toks.length],b=bodies[(i*3)%bodies.length];const h={authorization:'Bearer '+t};if(i%5===0)h['x-kipurse-wallet']=i%2?A:B;if(i%11===0)h.cookie='kpt='+B.toLowerCase();
    const n=hits.length;const r=await call(route,{url:p,headers:h,body:b});assert.notEqual(r.code,500,p+' '+r.body);
    if(hits.length>n){const [w,,ok]=hits.at(-1);if(t===tok[A]||t===tok[B])assert.equal(ok,true,'token reached the wrong wallet: '+p);}}});
test('router: /phone/find validates input and nonces are single use',async()=>{const {route}=setup();
  assert.equal((await call(route,{url:'/phone/find',body:'{"nonce":"zz","x":"1","y":"1","r":"1","s":"1"}'})).code,400);
  const c=JSON.parse((await call(route,{url:'/phone/find/challenge'})).body);const b=JSON.stringify({nonce:c.nonce,x:'0x1',y:'0x1',r:'0x1',s:'0x1'});
  assert.equal((await call(route,{url:'/phone/find',body:b})).code,401);assert.equal((await call(route,{url:'/phone/find',body:b})).code,400,'replay refused');});
test('tenant cache: bounded, rebuilds evicted wallets',async()=>{const {route,tok,tenants,built}=setup();
  for(const w of [A,B,A,B])await call(route,{url:'/mcp',headers:{authorization:'Bearer '+tok[w]}});assert.equal(tenants.size(),1);assert.equal(built(),4);});
test('mcp pool: reuses per agent, never shares across agents',async()=>{let n=0;const P=createMcpPool({create:id=>({id,n:++n,close:async()=>{}})});
  const a=P.acquire('a');await P.release('a',a);assert.equal(P.acquire('a'),a);assert.notEqual(P.acquire('b').id,'a');assert.deepEqual(P.stats().made,2);});
test('anomaly guard: bursts pause one wallet only; owner resume; payments blocked, reads pass',async()=>{let t=0;const G=createAnomalyGuard({kv:createMemoryKV(),now:()=>t,maxPays:3,maxNewPayees:2});
  const E={pay:async()=>'paid',status:async()=>'ok'};const EA=guardEngine(E,{guard:G,wallet:A}),EB=guardEngine(E,{guard:G,wallet:B});
  for(let i=0;i<3;i++)assert.equal(await EA.pay({payee:'0x1'}),'paid');await assert.rejects(EA.pay({payee:'0x1'}),/wallet_paused_for_safety/);
  assert.equal(await EB.pay({payee:'0x1'}),'paid');assert.equal(await EA.status(),'ok');G.resume(A);assert.equal(await EA.pay({payee:'0x1'}),'paid');
  await EB.pay({payee:'0x2'});await assert.rejects(EB.pay({payee:'0x3'}),/too_many_payees/);t+=25*3600e3;assert.equal(G.paused(B),null,'pause expires');});
test('per-user encryption at rest: different keys per wallet, no plaintext on disk, key file perms enforced',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'kp-e-'));const K=randomBytes(32);
  const f=path.join(d,'state.json');tenantStore(K,A).writeJson(f,{secret:'agent-name-xyz'});assert.ok(!fs.readFileSync(f).includes('agent-name-xyz'));
  assert.equal(tenantStore(K,A).readJson(f).secret,'agent-name-xyz');assert.throws(()=>tenantStore(K,B).readJson(f));
  fs.writeFileSync(f+'2',JSON.stringify({a:1}));assert.equal(tenantStore(K,A).readJson(f+'2').a,1);assert.ok(!fs.readFileSync(f+'2').toString().includes('"a"'),'plaintext migrated');
  const kf=path.join(d,'k');fs.writeFileSync(kf,K.toString('hex'),{mode:0o644});fs.chmodSync(kf,0o644);assert.throws(()=>loadDataKey(kf),/mode/);fs.chmodSync(kf,0o400);assert.equal(loadDataKey(kf).length,32);
  assert.equal(loadDataKey(undefined),null);assert.equal(plainStore.encrypted,false);});
