// SPDX-License-Identifier: AGPL-3.0-only
// t1278 S9: an unproven 'bind' sign-in record is kept 30 days (provable later); it must not keep the owner's SIWE message + signature, the
// user-data erase must find and delete it (sign-in ids indexed by wallet), and /signin/prove after an erase must not write a read grant.
import test from 'node:test';import assert from 'node:assert/strict';import {P256} from 'ox';import {toHex,verifyMessage} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {createSignin,signinKeyDigest} from '../src/v5/signin.mjs';import {createMemoryKV,kvKey} from '../src/v5/store.mjs';import {kvUserParts} from '../src/v5/user-data.mjs';
const hx=n=>toHex(n,{size:32});const key=()=>{const priv=P256.randomPrivateKey();const p=P256.getPublicKey({privateKey:priv});return {priv,x:hx(p.x),y:hx(p.y)};};
const sig=(k,d)=>{const s=P256.sign({payload:d,privateKey:k.priv});return {r:hx(s.r),s:hx(s.s)};};
const W='0x1000000000000000000000000000000000000001',PH={x:'0x01',y:'0x02',approver:'0x00000000000000000000000000000000000000B2'};
function mk(owner,{erasedAt=null}={}){const kv=createMemoryKV();const rec={wallet:W,publicPath:'/t/'+W.toLowerCase(),erasedAt};
  const S=createSignin({kv,pub:{verifyMessage:a=>verifyMessage(a),readContract:async()=>true},reg:{byOwner:o=>o.toLowerCase()===owner.toLowerCase()?[rec]:[],get:w=>String(w).toLowerCase()===W.toLowerCase()?rec:null},
    phoneOf:async()=>PH,base:()=>'https://pay.kipurse.com',script:()=>''});return {S,kv,rec};}
async function bind(S,a,k){const st=S.start({x:k.x,y:k.y});const {message}=S.message(st.id,a.address);const signature=await a.signMessage({message});
  const r=await S.verify(st.id,{address:a.address,message,signature});return {st,r,message,signature};}

test('t1278 S9: the 30-day unproven bind record holds no SIWE message / signature; the proof lives in its own short-lived key, only for the starter',async()=>{
  const a=privateKeyToAccount(generatePrivateKey()),k=key();const {S,kv}=mk(a.address);const {st,r,message,signature}=await bind(S,a,k);assert.equal(r.result,'bind');
  const rec=kv.get(kvKey('signin',null,st.id));assert.equal(rec.state,'done');assert.equal(rec.siweMessage,undefined);assert.equal(rec.siweSignature,undefined);
  assert.ok(!JSON.stringify(rec).includes(signature.slice(2,40)),'no signature in the long-lived record');
  const s1=S.status(st.id,st.poll);assert.equal(s1.siweMessage,message);assert.equal(s1.siweSignature,signature);
  const s2=S.status(st.id,st.poll);assert.equal(s2.siweSignature,signature,'re-readable within the short window (a lost reply never breaks sign-in)');
  const s3=S.status(st.id,'wrong-poll');assert.equal(s3.siweSignature,undefined,'never without the poll secret');});

test('t1278 S9: the user-data erase deletes the wallet\'s sign-in records (indexed by wallet); prove() afterwards cannot rewrite the read grant',async()=>{
  const a=privateKeyToAccount(generatePrivateKey()),k=key();const {S,kv,rec}=mk(a.address);const {st}=await bind(S,a,k);
  assert.deepEqual(kv.get(kvKey('signin-w',W,'ids')),[st.id]);
  const part=kvUserParts(kv).find(p=>p.name==='signin-records');assert.ok(part,'wired into the erase parts');part.forget(W);
  assert.equal(kv.get(kvKey('signin',null,st.id)),undefined);assert.equal(kv.get(kvKey('signin-w',W,'ids')),undefined);
  await assert.rejects(S.prove(st.id,{poll:st.poll,...sig(k,signinKeyDigest(st.id))}),e=>e.code==='unknown');assert.equal(kv.get(kvKey('readgrant',W,'phone')),undefined);
  // even a record the erase missed (e.g. restored) never earns a grant once the registry says the wallet was erased after it started
  const {S:S2,kv:kv2,rec:rec2}=mk(a.address);const b=await bind(S2,a,k);rec2.erasedAt=Date.now()+1;
  await S2.prove(b.st.id,{poll:b.st.poll,...sig(k,signinKeyDigest(b.st.id))});assert.equal(kv2.get(kvKey('readgrant',W,'phone')),undefined,'no grant after erase');
  // control: without the erase the same proof writes the grant
  const {S:S3,kv:kv3}=mk(a.address);const c=await bind(S3,a,k);await S3.prove(c.st.id,{poll:c.st.poll,...sig(k,signinKeyDigest(c.st.id))});assert.equal(kv3.get(kvKey('readgrant',W,'phone')).x,k.x);});
