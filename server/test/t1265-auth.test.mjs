// t1265: phone-key phishing (onboard start / existing-wallet prepare / sign-in grant need proof of the key), sign-in poll secret on re-reads,
// error codes only, phone-session challenge single-use + hashed rate-limit keys.
import test from 'node:test';import assert from 'node:assert/strict';import {P256} from 'ox';import {toHex} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {createOnboarding,publicError} from '../src/v5/onboard.mjs';import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';import {createSignin,signinKeyDigest} from '../src/v5/signin.mjs';
import {createPhoneSession,sessionDigest} from '../src/v5/phone-session.mjs';import {fingerprint} from '../src/v5/phone-signer.mjs';import {createMemoryKV,kvKey} from '../src/v5/store.mjs';
const hx=n=>toHex(n,{size:32});const key=()=>{const priv=P256.randomPrivateKey();const p=P256.getPublicKey({privateKey:priv});return {priv,x:hx(p.x),y:hx(p.y)};};
const sig=(k,d)=>{const s=P256.sign({payload:d,privateKey:k.priv});return {r:hx(s.r),s:hx(s.s)};};
const W='0x1000000000000000000000000000000000000001',A='0x2000000000000000000000000000000000000002';
const call=async(H,method,url,body={},headers={})=>{let code,b;await H({method,headers},{writeHead(c){code=c;},end(x){b=x?JSON.parse(x):null;}},new URL('https://x'+url),{readBody:async()=>body});return {code,b};};
test('tenant /onboard/start: no proof of the owner -> 401, nothing pending; proof -> passes the gate',async()=>{const k=key();const S={};let asked=null;
  const mk=keyProof=>createOnboarding({S,save(){},pub:{},wallet:W,owner:A,trust:W,base:()=>'https://x',phone:{},plan:async()=>{throw Error('x');},enabled:true,verified:async()=>({verified:false,reason:'none'}),keyProof});
  let r=await call(mk(null).handle,'POST','/onboard/start',{x:k.x,y:k.y,single:'1',daily:'1',term:'1'});assert.equal(r.code,401);assert.equal(r.b.error,'sign_in_first');
  r=await call(mk(async()=>false).handle,'POST','/onboard/start',{x:k.x,y:k.y});assert.equal(r.code,401);assert.deepEqual(S.onboard,{});
  r=await call(mk(async(req,o)=>{asked=o;return true;}).handle,'POST','/onboard/start',{x:k.x,y:k.y});assert.equal(r.b.error,'not_verified','gate passed, then the normal checks');assert.deepEqual(asked,{x:k.x,y:k.y});});
test('tenant onboarding: pending cap counts per proven key (oldest replaced), anonymous entries cannot exist to block the owner',async()=>{
  const k=key(),fp=fingerprint(k.x,k.y);const S={onboard:{}};const N=Date.now()+60e3;S.onboard.m1={fingerprint:fp,exp:N};S.onboard.m2={fingerprint:fp,exp:N+1};
  for(let i=0;i<17;i++)S.onboard['o'+i]={fingerprint:'OTHER-'+i,exp:N};
  const O=createOnboarding({S,save(){},pub:{},wallet:W,owner:A,trust:W,base:()=>'https://x',phone:{},plan:async()=>{},enabled:true,verified:async()=>({verified:true})});
  await assert.rejects(O.start({x:k.x,y:k.y}),e=>e.code==='bad_amount');assert.equal(S.onboard.m1,undefined,'oldest of this key replaced');assert.ok(S.onboard.m2);
  for(let i=17;i<19;i++)S.onboard['o'+i]={fingerprint:'OTHER-'+i,exp:N};const k2=key();await assert.rejects(O.start({x:k2.x,y:k2.y}),e=>e.code==='busy');});
test('/onboard/new/prepare for an EXISTING wallet needs the owner\'s sign-in grant for exactly this key (or keyProof)',async()=>{const k=key(),other=key();
  const mk=(kv,keyProof)=>createNewWalletOnboarding({enabled:true,kv,base:()=>'https://x',script:()=>'',quote:async()=>({}),verified:async()=>({verified:true}),reg:{byOwner:()=>[{wallet:W}]},keyProof,
    tenantStart:async()=>({id:'t',calls:[{to:W,data:'0x',value:'0x0'}]}),pub:{}});
  const seed=kv=>{kv.put(kvKey('onbnew',null,'i1'),{x:k.x,y:k.y,expect:null,choice:{single:'1',daily:'1',term:'1',days:90},state:'start'});return kv;};
  let kv=seed(createMemoryKV());let r=await call(mk(kv).handle,'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.equal(r.code,400);assert.equal(r.b.error,'sign_in_first');
  kv=seed(createMemoryKV());kv.put(kvKey('readgrant',W,'phone'),{x:other.x,y:other.y,exp:Date.now()+1e6});r=await call(mk(kv).handle,'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.equal(r.b.error,'sign_in_first','grant of another key');
  kv=seed(createMemoryKV());kv.put(kvKey('readgrant',W,'phone'),{x:k.x,y:k.y,exp:Date.now()+1e6});r=await call(mk(kv).handle,'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.equal(r.code,200);assert.equal(r.b.existing,true);
  kv=seed(createMemoryKV());let seen=null;r=await call(mk(kv,async(w,o,req)=>{seen=[w,o.x,!!req];return true;}).handle,'POST','/onboard/new/prepare',{id:'i1',owner:A});assert.equal(r.b.existing,true);assert.deepEqual(seen,[W,k.x,true]);});
test('publicError: own codes keep their text (URLs scrubbed); anything else is just "failed"',()=>{
  assert.deepEqual(publicError(Object.assign(Error('fetch https://base.g.alchemy.com/v2/SECRETKEY failed'),{code:'verify_unavailable'})),{error:'verify_unavailable',detail:'fetch <url> failed'});
  assert.deepEqual(publicError(Error('HTTP request failed. URL: https://rpc.example/key123')),{error:'failed'});assert.deepEqual(publicError(Object.assign(Error('x'),{code:'ECONNREFUSED'})),{error:'failed'});});
function signin(kv,{owner=null,onboard=null,phone=null}={}){return createSignin({kv,pub:{verifyMessage:async a=>(await import('viem')).verifyMessage(a),readContract:async()=>true},
  reg:{byOwner:o=>owner&&o.toLowerCase()===owner.toLowerCase()?[{wallet:W,publicPath:'/t/'+W.toLowerCase()}]:[]},phoneOf:async()=>phone,base:()=>'https://pay.kipurse.com',script:()=>'',onboard});}
const siwe=async(S,st,a)=>{const {message}=S.message(st.id,a.address);return S.verify(st.id,{address:a.address,message,signature:await a.signMessage({message})});};
test('sign-in bind: no read grant without proof of the phone key; prove() later writes it; a wrong signature is refused',async()=>{const a=privateKeyToAccount(generatePrivateKey());const k=key(),evil=key();
  const kv=createMemoryKV();const S=signin(kv,{owner:a.address});const st=S.start({x:k.x,y:k.y});assert.equal(st.proven,false);assert.equal(st.prove.digest,signinKeyDigest(st.id));
  assert.equal((await siwe(S,st,a)).result,'bind');assert.equal(kv.get(kvKey('readgrant',W,'phone')),undefined,'no grant before proof');
  await assert.rejects(S.prove(st.id,{poll:st.poll,...sig(evil,signinKeyDigest(st.id))}),e=>e.code==='bad_key_signature');
  await assert.rejects(S.prove(st.id,{poll:'nope',...sig(k,signinKeyDigest(st.id))}),e=>e.code==='unknown','poll secret = the starter');
  assert.deepEqual(await S.prove(st.id,{poll:st.poll,...sig(k,signinKeyDigest(st.id))}),{ok:true,setup:false});
  const g=kv.get(kvKey('readgrant',W,'phone'));assert.equal(g.x,k.x);assert.equal(g.owner,a.address);});
test('sign-in: key proven in start (app-chosen id) -> grant at verify; a phisher key without its private half gets nothing',async()=>{const a=privateKeyToAccount(generatePrivateKey());const k=key();
  const kv=createMemoryKV();const S=signin(kv,{owner:a.address});const id='cd'.repeat(16);const st=S.start({x:k.x,y:k.y,id,...sig(k,signinKeyDigest(id))});assert.equal(st.id,id);assert.equal(st.proven,true);
  await siwe(S,st,a);assert.equal(kv.get(kvKey('readgrant',W,'phone')).y,k.y);
  const kv2=createMemoryKV();const S2=signin(kv2,{owner:a.address});const id2='ef'.repeat(16);const st2=S2.start({x:k.x,y:k.y,id:id2,r:'0x01',s:'0x02'});assert.equal(st2.proven,false);
  await siwe(S2,st2,a);assert.equal(kv2.get(kvKey('readgrant',W,'phone')),undefined);});
test('sign-in setup opens only after proof (prove opens it); verify of a finished id needs the poll secret',async()=>{const a=privateKeyToAccount(generatePrivateKey());const k=key();let starts=0;
  const onboard={start:async()=>{starts++;return {id:'onb9'};},bindOwner:()=>true,sponsorable:()=>false,status:()=>({state:'start',wallet:null})};
  const kv=createMemoryKV();const S=signin(kv,{onboard});const st=await S.start({x:k.x,y:k.y,setup:{single:'1',daily:'5',term:'20'}});assert.equal(st.setup,false);assert.equal(starts,0);
  assert.deepEqual(await S.prove(st.id,{poll:st.poll,...sig(k,signinKeyDigest(st.id))}),{ok:true,setup:true});assert.equal(starts,1);
  const {message}=S.message(st.id,a.address);const signature=await a.signMessage({message});const r=await S.verify(st.id,{address:a.address,message,signature});assert.equal(r.result,'new');assert.deepEqual(r.setup,{id:'onb9',free:false});
  await assert.rejects(S.verify(st.id,{address:a.address,message,signature}),e=>e.code==='unknown','finished id without poll');
  assert.equal((await S.verify(st.id,{address:a.address,message,signature,poll:st.poll})).owner,a.address);});
test('sign-in HTTP errors: code only for internal failures',async()=>{const S=createSignin({kv:createMemoryKV(),pub:{verifyMessage:async()=>{throw Error('rpc https://x.y/KEY down');}},reg:{byOwner:()=>[]},phoneOf:async()=>null,base:()=>'https://pay.kipurse.com',script:()=>''});
  const r=await call(S.handle,'POST','/signin/verify',{id:'00'.repeat(16)});assert.equal(r.b.error,'unknown');assert.ok(!JSON.stringify(r.b).includes('://'));});
test('phone session: a challenge redeems once even when two requests race; state errors carry no detail; rate-limit keys never hold the raw IP',async()=>{const k=key();const kv=createMemoryKV();const keys=[];
  const kv2={...kv,incr:(kk,w)=>{keys.push(kk);return kv.incr(kk,w);}};
  const PS=createPhoneSession({phone:{active:()=>({...k,fingerprint:fingerprint(k.x,k.y)})},wallet:W,kv:kv2,readState:async()=>{throw Error('rpc https://base.g.alchemy.com/v2/KEY');}});
  const H=(m,u,b,h)=>call((req,res,uu,o)=>PS.handle(req,res,uu,{...o,ip:'203.0.113.9'}),m,u,b,h);
  const c=(await H('POST','/phone/session/challenge')).b;const b={nonce:c.nonce,...sig(k,sessionDigest(W,c.nonce))};
  const rs=await Promise.all([H('POST','/phone/session',b),H('POST','/phone/session',b)]);assert.deepEqual(rs.map(r=>r.code).sort(),[200,400]);
  const t=rs.find(r=>r.code===200).b.token;const st=await H('GET','/phone/session/state',{},{authorization:'Bearer '+t});assert.equal(st.code,502);assert.deepEqual(st.b,{error:'state_unavailable'});
  assert.ok(keys.length&&keys.every(x=>!x.includes('203.0.113.9')));});
test('launch wires the owner proof into both onboarding paths',async()=>{const s=(await import('node:fs')).readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(s,/createOnboarding\(\{verified:[\s\S]{0,400}keyProof:\(req,\{x,y\}\)=>ownerKeyProof\(req,x,y\)/);assert.match(s,/createNewWalletOnboarding\(\{appAttest:APP_ATTEST,[\s\S]{0,900}keyProof:async\(w,\{x,y\},req\)/);});
