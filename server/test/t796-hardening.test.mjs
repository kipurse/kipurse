// t796: H2 poll secret + pairing code, M2 write limits, L1 413, L3 SSRF guard, M3 no balance in errors, L2 CSP.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {Readable} from 'node:stream';
import {verifyMessage} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {createSignin} from '../src/v5/signin.mjs';import {writeLimited,WRITE_LIMITS} from '../src/v5/router.mjs';import {createMemoryKV as createMemoryKv} from '../src/v5/store.mjs';
import {isPrivateIp,assertPublicUrl,guardFetch} from '../src/v5/ssrf.mjs';
const mkKv=()=>{const m=new Map();return {put:(k,v)=>m.set(k,v),get:k=>m.get(k),take:k=>{const v=m.get(k);m.delete(k);return v;}};};
const S=()=>createSignin({kv:mkKv(),pub:{verifyMessage:a=>verifyMessage(a),readContract:async()=>true},reg:{byOwner:()=>[]},base:()=>'https://pay.kipurse.com',phoneOf:async()=>null,script:()=>''});
test('H2: status needs the poll secret given only to the starter; the page URL does not carry it',async()=>{const s=S();const st=s.start({});
  assert.match(st.poll,/^[0-9a-f]{32}$/);assert.match(st.pair,/^\d{4}$/);assert.ok(!st.url.includes(st.poll));
  const a=privateKeyToAccount(generatePrivateKey());const {message}=s.message(st.id,a.address);await s.verify(st.id,{address:a.address,message,signature:await a.signMessage({message})});
  assert.equal(s.status(st.id).state,'expired');assert.equal(s.status(st.id,'00'.repeat(16)).state,'expired');assert.equal(s.status(st.id,st.poll).state,'done');});
test('H2: the sign-in page shows the same pairing code and the warning',async()=>{const s=S();const st=s.start({});const res={h:null,b:'',writeHead(c,h){this.c=c;this.h=h;},end(b){this.b=b;}};
  await s.handle({method:'GET',headers:{}},res,new URL(st.url),{readBody:async()=>({})});assert.equal(res.c,200);assert.ok(res.b.includes(st.pair));assert.match(res.b,/same code|同样的配对码/);
  assert.match(res.h['content-security-policy'],/connect-src 'self' https:\/\/\*\.coinbase\.com https:\/\/mainnet\.base\.org https:\/\/mainnet-preconf\.base\.org;/);});
test('M2: write limits per client and global, with TTL windows',()=>{const kv=createMemoryKv?createMemoryKv():null;if(!kv)return;let n=0;for(let i=0;i<10;i++)if(writeLimited(kv,'/signin/start','1.2.3.4'))n++;assert.equal(n,4);
  assert.equal(writeLimited(kv,'/signin/start','5.6.7.8'),null);let c=0;for(let i=0;i<25;i++)if(writeLimited(kv,'/t/0xabc/phone/session/challenge','9.9.9.9'))c++;assert.equal(c,5);
  let w=0;for(let i=0;i<12;i++)if(writeLimited(kv,'/t/0x'+'a'.repeat(40)+'/owner/withdraw/prepare','8.8.4.4'))w++;assert.equal(w,2);
  assert.ok(WRITE_LIMITS.some(l=>l.name==='any-write'));});
test('L3: private, loopback, link-local, CGNAT, metadata and v6 local are blocked; public passes; http refused',async()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','fd00::1','fe80::1','::ffff:127.0.0.1'])assert.ok(isPrivateIp(ip),ip);
  for(const ip of ['93.184.216.34','2606:4700::1111'])assert.ok(!isPrivateIp(ip),ip);
  await assert.rejects(assertPublicUrl('https://evil.example/x',{resolve:async()=>[{address:'169.254.169.254'}]}),e=>e.code==='ssrf_blocked');
  await assert.rejects(assertPublicUrl('https://x.example',{resolve:async()=>[{address:'93.184.216.34'},{address:'10.0.0.1'}]}),e=>e.code==='ssrf_blocked');
  await assert.rejects(assertPublicUrl('http://shop.example'),e=>e.code==='ssrf_blocked');await assert.rejects(assertPublicUrl('https://localhost/'),e=>e.code==='ssrf_blocked');
  let seen=null;const f=guardFetch(async(u,o)=>{seen=o;return {ok:true};},{resolve:async()=>[{address:'93.184.216.34'}]});await f('https://shop.example/a',{redirect:'follow'});assert.equal(seen.redirect,'error');});
test('M3: withdraw errors carry no balance; L1: router answers 413 for oversize bodies',()=>{const w=fs.readFileSync(new URL('../src/v5/owner-withdraw.mjs',import.meta.url),'utf8');
  assert.match(w,/e\.code==='empty'\?\{error:'empty'\}/);const r=fs.readFileSync(new URL('../src/v5/router.mjs',import.meta.url),'utf8');
  assert.match(r,/content-length'\]\?\?0\)>65536\)return J\(413/);assert.match(r,/if\(e\?\.status===413\)throw e/);});

import {ipBucket} from '../src/v5/router.mjs';
test('t796 M2: IPv6 rate-limit bucket is the /64, IPv4 the address',()=>{const assert=globalThis.__a;
  if(ipBucket('2a09:bac1:76c0:5060::50b:8d')!==ipBucket('2a09:bac1:76c0:5060::50d:35'))throw Error('same /64 must share a bucket');
  if(ipBucket('2a09:bac1:76c0:5061::1')===ipBucket('2a09:bac1:76c0:5060::1'))throw Error('other /64 differs');
  if(ipBucket('::ffff:1.2.3.4')!=='1.2.3.4'||ipBucket('1.2.3.4')!=='1.2.3.4')throw Error('v4');});
