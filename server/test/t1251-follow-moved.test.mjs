// t1251 (handbook §6#120): the legacy entry must follow every owner-signed move (V5.2 -> V5.4 -> V5.5), not just the first hop.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {followMoved} from '../src/v5/tenancy.mjs';
const A='0x5150000000000000000000000000000000000001',B='0x6464000000000000000000000000000000000002',C='0x4494000000000000000000000000000000000003';
const reg=m=>a=>m[String(a).toLowerCase()];
test('two moves: legacy reaches the newest wallet',()=>{
  const g=reg({[A.toLowerCase()]:{retired:true,movedTo:B},[B.toLowerCase()]:{retired:true,movedTo:C},[C.toLowerCase()]:{}});
  assert.equal(followMoved(A,g),C);assert.equal(followMoved(B,g),C);assert.equal(followMoved(C,g),C);});
test('no move / unknown / not retired stays put',()=>{
  assert.equal(followMoved(A,reg({})),A);assert.equal(followMoved(A,reg({[A.toLowerCase()]:{movedTo:B}})),A);assert.equal(followMoved(null,reg({})),null);});
test('a loop never spins and never leaves the chain',()=>{
  const g=reg({[A.toLowerCase()]:{retired:true,movedTo:B},[B.toLowerCase()]:{retired:true,movedTo:A}});assert.equal(followMoved(A,g),B);});
test('hop cap',()=>{const m={};const ws=[...Array(12)].map((_,i)=>'0x'+String(i+1).padStart(40,'0'));ws.forEach((w,i)=>{if(i<11)m[w.toLowerCase()]={retired:true,movedTo:ws[i+1]};});
  assert.equal(followMoved(ws[0],reg(m),8),ws[8]);});
test('launch uses followMoved for the legacy route (no single-hop lookup left)',()=>{
  const s=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/const legacyRoute=\(\)=>followMoved\(legacy\(\),a=>REG\.get\(a\)\)/);
  assert.doesNotMatch(s,/const legacyRoute=\(\)=>\{const w=legacy\(\);const r=w&&REG\.get\(w\);return r\?\.retired&&r\.movedTo\?getAddress\(r\.movedTo\):w;\}/);});
import {resolveTenant,sha256} from '../src/v5/tenancy.mjs';
test('a token of a retired (moved-away) wallet is ignored: unprefixed request reaches the current wallet, not the retired one',()=>{
  const recs={[B.toLowerCase()]:{wallet:B,retired:true,movedTo:C},[C.toLowerCase()]:{wallet:C}};
  const reg={get:a=>recs[String(a).toLowerCase()],only:()=>null};const idx={get:(k,h)=>k==='oauth'&&h===sha256('tok-old')?B.toLowerCase():null};
  const r=resolveTenant({url:new URL('http://x/mcp'),headers:{authorization:'Bearer tok-old'},reg,index:idx,allowSingleDefault:false,defaultWallet:C});
  assert.equal(r.wallet,C);assert.equal(r.via,'legacy');
  const r2=resolveTenant({url:new URL('http://x/t/'+C+'/mcp'),headers:{authorization:'Bearer tok-old'},reg,index:idx,allowSingleDefault:false,defaultWallet:C});
  assert.equal(r2.wallet,C);   // explicit new-wallet prefix + old token: no wrong_wallet 403, the new wallet decides (401)
  const live={get:a=>({[B.toLowerCase()]:{wallet:B}})[String(a).toLowerCase()],only:()=>null};
  assert.equal(resolveTenant({url:new URL('http://x/mcp'),headers:{authorization:'Bearer tok-old'},reg:live,index:idx,allowSingleDefault:false,defaultWallet:C}).wallet,B);});   // not retired: unchanged
test('a URL naming a retired wallet reaches the wallet it moved to (never the retired one)',()=>{
  const recs={[A.toLowerCase()]:{wallet:A,retired:true,movedTo:B},[B.toLowerCase()]:{wallet:B,retired:true,movedTo:C},[C.toLowerCase()]:{wallet:C}};
  const reg={get:a=>recs[String(a).toLowerCase()],only:()=>null};const idx={get:()=>null};
  const r=resolveTenant({url:new URL('http://x/t/'+B+'/mcp'),headers:{},reg,index:idx,allowSingleDefault:false,defaultWallet:null});
  assert.equal(r.wallet,C);assert.equal(r.path,'/mcp');
  assert.equal(resolveTenant({url:new URL('http://x/mcp'),headers:{'x-kipurse-wallet':A},reg,index:idx,allowSingleDefault:false}).wallet,C);
  assert.equal(resolveTenant({url:new URL('http://x/t/'+C+'/mcp'),headers:{},reg,index:idx,allowSingleDefault:false}).wallet,C);});
test('router rewrites an OAuth resource naming a retired wallet',()=>{
  const s=fs.readFileSync(new URL('../src/v5/router.mjs',import.meta.url),'utf8');assert.match(s,/reg\.get\(rm\[1\]\)\?\.retired\?followMoved\(rm\[1\]/);});
