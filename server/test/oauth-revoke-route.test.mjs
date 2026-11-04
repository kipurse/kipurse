// Root /oauth/revoke (RFC 7009, no bearer) must reach the wallet that issued the token, not the cookie/legacy wallet.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';
import {createAgentRouter,createTenantCache} from '../src/v5/router.mjs';import {createMemoryKV,createRateLimiter} from '../src/v5/store.mjs';import {createRegistry,createIndex,sha256} from '../src/v5/tenancy.mjs';
const A='0x1000000000000000000000000000000000000001',B='0x1000000000000000000000000000000000000002',O='0x1000000000000000000000000000000000000003';
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kp-rv-'));const reg=createRegistry({file:path.join(dir,'r.json')});const kv=createMemoryKV();const index=createIndex(kv);
  reg.add({wallet:A,owner:O,publicPath:''});reg.add({wallet:B,owner:O,publicPath:'/t/'+B.toLowerCase()});
  const tokB='kat_'+randomBytes(16).toString('hex');index.set('oauth',sha256(tokB),B);const hits=[];
  const tenants=createTenantCache({reg,max:4,load:async rec=>({wallet:rec.wallet,rec,PH:{active:()=>null},reindex(){},close(){},
    handle:async(req,res,u,J)=>{hits.push([rec.wallet,u.pathname]);J(200,{});}})});
  const rl={ip:createRateLimiter(kv,{perKey:1e9,global:1e9}),tenant:createRateLimiter(kv,{perKey:1e9,global:1e9})};
  const route=createAgentRouter({reg,index,kv,obs:{log(){},metrics:()=>''},tenants,legacy:()=>A,env:{},verifyP256:async()=>false,onboardNew:null,rl});return {route,tokB,hits};}
function call(route,{url,method='POST',headers={},body=''}){return new Promise(r=>{const req=(async function*(){if(body)yield body;})();Object.assign(req,{url,method,headers,socket:{remoteAddress:'127.0.0.1'}});
  const res={h:{},writeHead(c,h){this.code=c;Object.assign(this.h,h);},setHeader(k,v){this.h[k]=v;},on(){},end(b){r({code:this.code,body:b});},get headersSent(){return this.code!==undefined;}};route(req,res);});}
test('root /oauth/revoke goes to the issuing wallet (form and JSON), even with another wallet cookie',async()=>{const {route,tokB,hits}=setup();
  assert.equal((await call(route,{url:'/oauth/revoke',headers:{'content-type':'application/x-www-form-urlencoded'},body:'token='+tokB})).code,200);assert.deepEqual(hits.at(-1),[B,'/oauth/revoke']);
  assert.equal((await call(route,{url:'/oauth/revoke',headers:{cookie:'kpt='+A.toLowerCase()},body:JSON.stringify({token:tokB})})).code,200);assert.deepEqual(hits.at(-1),[B,'/oauth/revoke']);
  assert.equal((await call(route,{url:'/oauth/revoke',body:'token=unknown'})).code,200);assert.equal(hits.at(-1)[0],A,'unknown token: unchanged legacy behaviour');
  assert.equal((await call(route,{url:'/t/'+A.toLowerCase()+'/oauth/revoke',body:'token='+tokB})).code,200);assert.equal(hits.at(-1)[0],A,'explicit prefix wins');});
