// t789: sign-in page pins its bundle with SRI (the app checks the same value); emergency "withdraw all" opens the pinned sign host.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createHash} from 'node:crypto';
import {createSignin,signinSri} from '../src/v5/signin.mjs';import {createOwnerEmergency} from '../src/v5/owner-emergency.mjs';
const mkKv=()=>{const m=new Map();return {put:(k,v)=>m.set(k,v),get:k=>m.get(k),take:k=>{const v=m.get(k);m.delete(k);return v;}};};
const JS=fs.readFileSync(new URL('../owner-sign/static/signin.js',import.meta.url));
const fakeRes=()=>{const r={h:null,b:'',c:0,writeHead(c,h){r.c=c;r.h=h;},end(b){r.b=String(b??'');}};return r;};
test('sign-in page carries integrity = sha384(signin.js), same value pinned in the iOS app',async()=>{
  const S=createSignin({kv:mkKv(),pub:{},reg:{byOwner:()=>[]},obs:{log(){}},base:()=>'https://pay.kipurse.com',phoneOf:async()=>null,script:()=>JS});
  const st=S.start({});const res=fakeRes();await S.handle({method:'GET',headers:{}},res,new URL(st.url),{readBody:async()=>({})});
  const want='sha384-'+createHash('sha384').update(JS).digest('base64');assert.equal(signinSri(JS),want);
  assert.equal(res.c,200);assert.ok(res.b.includes(`integrity="${want}"`),'SRI on the script tag');
  assert.equal((res.b.match(/<script/g)??[]).length,2,'only kp-data + the pinned bundle');
  assert.equal(want,'sha384-QNbm/X1nJaabK6dmly8sf65qfUHAkLgaCJHUfplx99ISQq9mkeXjtHosMwPAoJQ9','= SigninCheck.scriptSRI in the iOS app; change both together');});
test('emergency page: "withdraw all" goes to the pinned /v3 sign host, never the server page',async()=>{
  const W='0x00000000000000000000000000000000000000A1',O='0x00000000000000000000000000000000000000B2';
  const EM=createOwnerEmergency({wallet:W,owner:O,verifyOwner:async()=>false,pause:async()=>({}),cancelHolds:async()=>({})});
  const res=fakeRes();await EM.handle({method:'GET',headers:{}},res,new URL('https://pay.kipurse.com/owner/emergency?lang=zh'),{readBody:async()=>({}),ip:'1'});
  const href=res.b.match(/id=withdraw href="([^"]+)"/)[1].replace(/&amp;/g,'&');const u=new URL(href);
  assert.equal(u.host,'sign.kipurse.com');assert.equal(u.pathname,'/v5/t/'+W.toLowerCase()+'/owner/withdraw');
  assert.equal(decodeURIComponent(u.hash.replace('#u=','')),'/t/'+W.toLowerCase()+'/owner/withdraw?lang=zh');});
