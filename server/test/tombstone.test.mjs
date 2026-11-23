// t784: erase leaves a tombstone outside data/; a restore of older data re-applies the erase on boot; logs carry no raw addresses.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';
import {createTombstones,applyTombstone,tombHash} from '../src/v5/user-data.mjs';import {createObs} from '../src/v5/obs.mjs';
const W='0x1111111111111111111111111111111111111111';
test('tombstone file stores only a salted hash and survives a data/ restore',async()=>{
  const dir=fs.mkdtempSync(join(os.tmpdir(),'tomb-'));const file=join(dir,'tombstones','erased.jsonl');let t=1000;
  const T=createTombstones({fs,file,now:()=>t});assert.equal(T.latest(W),null);
  T.add(W);const raw=fs.readFileSync(file,'utf8');assert.ok(!raw.toLowerCase().includes(W.slice(2)),'no address in the file');assert.ok(raw.includes(tombHash(W)));
  assert.equal(T.latest(W),1000);assert.equal((fs.statSync(file).mode&0o777),0o600);
  // data restored from a backup taken BEFORE the erase: state has no erasedAt -> the erase runs again
  let erased=0,S={};const run=()=>applyTombstone({tomb:T,wallet:W,erasedAt:S.erasedAt,erase:async()=>{erased++;},mark:x=>{S.erasedAt=x;}});
  assert.equal(await run(),'reapplied');assert.equal(erased,1);assert.equal(S.erasedAt,1000);
  // data after the erase (or the re-applied state): nothing to do; a NEW account created later on the same address is kept
  assert.equal(await run(),'clean');assert.equal(erased,1);
  // a second erase later -> a newer tombstone -> an older backup gets erased again
  t=2000;T.add(W);assert.equal(T.latest(W.toUpperCase().replace('0X','0x')),2000);assert.equal(await run(),'reapplied');assert.equal(erased,2);
  assert.equal(await applyTombstone({tomb:T,wallet:'0x2222222222222222222222222222222222222222',erasedAt:0,erase:async()=>{throw Error('no');},mark:()=>{}}),'clean');
});
test('obs log never prints a raw address even in an allowed field',()=>{const lines=[];const O=createObs({out:s=>lines.push(s)});
  O.log('x',{reason:'bad '+W,route:'/t/'+W+'/owner',wallet:W});const j=JSON.parse(lines[0]);
  assert.ok(!lines[0].toLowerCase().includes(W.slice(2)));assert.match(j.reason,/^bad h:[0-9a-f]{12}$/);assert.equal(j.wallet,undefined);});
test('a successful erase writes the tombstone and marks erasedAt; a refused one does not',async()=>{
  const {toHex}=await import('viem');const P256=await import('ox/P256');const {createUserDataEraser}=await import('../src/v5/user-data.mjs');
  const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});const active={x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};
  const dir=fs.mkdtempSync(join(os.tmpdir(),'tomb2-'));const T=createTombstones({fs,file:join(dir,'t','e.jsonl'),now:()=>5});const S={};
  const E=createUserDataEraser({enabled:true,tomb:T,onErased:(w,t)=>{S.erasedAt=t;},parts:[{name:'p',forget:()=>{}}],resolveTenant:async()=>({wallet:W,phone:{active:()=>active}})});
  const call=async(path,body)=>{let code,out;await E.handle({method:'POST'},{writeHead:c=>{code=c;},end:s=>{out=JSON.parse(s);}},new URL('http://x'+path),{readBody:async()=>body});return [code,out];};
  const [,c]=await call('/user/erase/challenge');assert.equal((await call('/user/erase',{nonce:c.nonce,phrase:'DELETE',r:'0x1',s:'0x1'}))[0],403);assert.equal(T.count(),0);
  const [,c2]=await call('/user/erase/challenge');const sg=P256.sign({payload:c2.digest,privateKey});
  const [code,o]=await call('/user/erase',{nonce:c2.nonce,phrase:'DELETE',r:toHex(sg.r),s:toHex(sg.s)});assert.equal(code,200);assert.equal(o.tombstone,true);
  assert.equal(T.latest(W),5);assert.equal(S.erasedAt,5);});
