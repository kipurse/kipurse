// SPDX-License-Identifier: AGPL-3.0-only
// t1275: the SIWE statement the owner signs names the phone key that started the sign-in; the 30-day read grant is written ONLY for that key.
// /signin/status (and the poll-guarded verify re-read) return the owner's own SIWE message + signature so the app can check the owner itself.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {P256} from 'ox';import {toHex,verifyMessage} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {createSignin,signinKeyDigest,signinKeyFp,signinStatement,signinStatementFor,siweMessage,parseSiwe,SIWE_STATEMENT} from '../src/v5/signin.mjs';
import {fingerprint} from '../src/v5/phone-signer.mjs';import {createMemoryKV,kvKey} from '../src/v5/store.mjs';
const hx=n=>toHex(n,{size:32});const key=()=>{const priv=P256.randomPrivateKey();const p=P256.getPublicKey({privateKey:priv});return {priv,x:hx(p.x),y:hx(p.y)};};
const sig=(k,d)=>{const s=P256.sign({payload:d,privateKey:k.priv});return {r:hx(s.r),s:hx(s.s)};};
const W='0x1000000000000000000000000000000000000001',PH={x:'0x01',y:'0x02',approver:'0x00000000000000000000000000000000000000B2'};
const mk=(kv,{owner=null,phone=null,onboard=null}={})=>createSignin({kv,pub:{verifyMessage:a=>verifyMessage(a),readContract:async()=>true},
  reg:{byOwner:o=>owner&&o.toLowerCase()===owner.toLowerCase()?[{wallet:W,publicPath:'/t/'+W.toLowerCase()}]:[]},phoneOf:async()=>phone,base:()=>'https://pay.kipurse.com',script:()=>'',onboard});
const msgFor=(st,a,statement)=>siweMessage({domain:'pay.kipurse.com',uri:'https://pay.kipurse.com',address:a.address,chainId:8453,nonce:st.nonce,issuedAt:new Date().toISOString(),statement});
const proven=(S,k)=>{const id=randomId();return S.start({x:k.x,y:k.y,id,...sig(k,signinKeyDigest(id))});};let n=0;const randomId=()=>(++n).toString(16).padStart(32,'0');
test('statement: same fingerprint format as the phone fingerprint, names the key, padded keys give the same text',()=>{const k=key();
  assert.equal(signinKeyFp(k.x,k.y),fingerprint(k.x,k.y));assert.equal(signinStatementFor(k.x,k.y),signinStatement(fingerprint(k.x,k.y)));
  assert.match(signinStatementFor(k.x,k.y),/^Sign in to Kipurse and allow the iPhone with key [0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4} to read this wallet\. Free: no transaction\.$/);
  assert.equal(signinStatementFor('0x01','0x02'),signinStatementFor(hx(1n),hx(2n)));assert.equal(signinStatementFor(null,null),SIWE_STATEMENT);
  assert.equal(parseSiwe(msgFor({nonce:'abcdef0123456789abcdef01'},{address:W},signinStatementFor(k.x,k.y))).statement,signinStatementFor(k.x,k.y));});
test('start / message / page carry the statement for the starting key',async()=>{const k=key();const S=mk(createMemoryKV());const st=S.start({x:k.x,y:k.y});
  assert.equal(st.statement,signinStatementFor(k.x,k.y));assert.equal(parseSiwe(S.message(st.id,W).message).statement,st.statement);
  let html='';await S.handle({method:'GET',headers:{}},{writeHead(){},end(x){html=x;}},new URL('https://pay.kipurse.com/signin?id='+st.id),{readBody:async()=>({})});
  const d=JSON.parse(/id=kp-data>([^<]*)</.exec(html)[1]);assert.equal(d.statement,st.statement);
  assert.equal(S.start({}).statement,SIWE_STATEMENT,'no key: the plain text');});
test('attacker starter: a victim signature that names another key (or no key) earns no grant; only the named key ever gets one',async()=>{
  const victim=privateKeyToAccount(generatePrivateKey()),atk=key(),vkey=key();
  const kv=createMemoryKV();const S=mk(kv,{owner:victim.address});const st=proven(S,atk);assert.equal(st.proven,true);
  for(const statement of [signinStatementFor(vkey.x,vkey.y),SIWE_STATEMENT,'Sign in.']){const m=msgFor(st,victim,statement);
    await assert.rejects(S.verify(st.id,{address:victim.address,message:m,signature:await victim.signMessage({message:m})}),e=>e.code==='bad_message'&&/statement/.test(e.message));}
  assert.equal(kv.get(kvKey('readgrant',W,'phone')),undefined,'no grant for the attacker key');
  await S.prove(st.id,{poll:st.poll,...sig(atk,signinKeyDigest(st.id))});assert.equal(kv.get(kvKey('readgrant',W,'phone')),undefined,'prove() does not grant either');
  // the victim's own sign-in (her key named and signed) -> the grant is exactly her key
  const kv2=createMemoryKV();const S2=mk(kv2,{owner:victim.address});const st2=proven(S2,vkey);const m2=msgFor(st2,victim,signinStatementFor(vkey.x,vkey.y));
  assert.equal((await S2.verify(st2.id,{address:victim.address,message:m2,signature:await victim.signMessage({message:m2})})).result,'bind');
  const g=kv2.get(kvKey('readgrant',W,'phone'));assert.equal(g.x,vkey.x);assert.equal(g.y,vkey.y);
  // replaying her signed message under the attacker's sign-in: other nonce AND other key -> refused
  const st3=proven(S2,atk);await assert.rejects(S2.verify(st3.id,{address:victim.address,message:m2,signature:await victim.signMessage({message:m2})}),e=>e.code==='bad_message');});
test('a finished sign-in record without the signed key (written before t1275) never yields a grant through prove()',async()=>{const a=privateKeyToAccount(generatePrivateKey()),k=key();const kv=createMemoryKV();const S=mk(kv,{owner:a.address});
  const id='ab'.repeat(16),poll='p'.repeat(32);const {createHash}=await import('node:crypto');
  kv.put(kvKey('signin',null,id),{pollH:createHash('sha256').update(poll).digest('hex'),x:k.x,y:k.y,nonce:'n',state:'done',result:'bind',wallet:W,owner:a.address,proven:false});
  assert.deepEqual(await S.prove(id,{poll,...sig(k,signinKeyDigest(id))}),{ok:true,setup:false});assert.equal(kv.get(kvKey('readgrant',W,'phone')),undefined);});
test('status + poll-guarded verify re-read include the exact SIWE message and signature (bind / reconnect / new); never without the poll secret',async()=>{
  for(const [owner,phone,want] of [[true,PH,'bind'],[true,null,'bind'],[false,null,'new']]){const a=privateKeyToAccount(generatePrivateKey());const k=want==='new'?key():{x:'0x09',y:'0x02'};
    const S=mk(createMemoryKV(),{owner:owner?a.address:null,phone});const st=S.start(k);const {message}=S.message(st.id,a.address);const signature=await a.signMessage({message});
    assert.equal(S.status(st.id,st.poll).siweMessage,undefined,'nothing before done');
    await S.verify(st.id,{address:a.address,message,signature});const s=S.status(st.id,st.poll);
    assert.equal(s.result,want);assert.equal(s.siweMessage,message);assert.equal(s.siweSignature,signature);assert.equal(s.owner,a.address);
    assert.equal(parseSiwe(s.siweMessage).statement,signinStatementFor(k.x,k.y));
    assert.equal(S.status(st.id,'wrong').siweMessage,undefined);assert.equal(S.status(st.id,'wrong').state,'expired');
    assert.equal((await S.verify(st.id,{poll:st.poll})).siweSignature,signature);}
  const a=privateKeyToAccount(generatePrivateKey());const S=mk(createMemoryKV(),{owner:a.address,phone:PH});const st=S.start({x:PH.x,y:PH.y});const {message}=S.message(st.id,a.address);
  await S.verify(st.id,{address:a.address,message,signature:await a.signMessage({message})});const s=S.status(st.id,st.poll);assert.equal(s.result,'reconnect');assert.equal(s.siweMessage,message);});
test('the iOS fixture is exactly what this code generates (regenerate with scripts/t1275-signin-siwe-fixture.mjs)',async()=>{
  const {execFileSync}=await import('node:child_process');const p=new URL('../../../../../../kipurse-ios/Kipurse/Tests/KipurseCoreTests/t1275-signin-siwe.json.txt',import.meta.url);
  if(!fs.existsSync(p))return;   // the iOS repo is not next to this checkout (CI / public export)
  const gen=execFileSync(process.execPath,[new URL('../scripts/t1275-signin-siwe-fixture.mjs',import.meta.url).pathname],{encoding:'utf8'});
  assert.equal(fs.readFileSync(p,'utf8'),gen);const j=JSON.parse(gen);
  for(const c of j.siwe.slice(0,6)){assert.ok(await verifyMessage({address:c.owner,message:c.message,signature:c.signature}));assert.equal(parseSiwe(c.message).statement,signinStatementFor(c.x,c.y));}});
