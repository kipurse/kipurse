// SPDX-License-Identifier: AGPL-3.0-only
// t1275: SSRF IPv6 forms + DNS-rebinding pin, Siri data in "delete my data", /oauth/first caps, owner-decide deny needs owner proof,
// /mcp streamed body cap, salted rate-limit IP keys.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import http from 'node:http';import zlib from 'node:zlib';import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {isPrivateIp,assertPublicUrl,guardFetch,pinnedFetch,expand6} from '../src/v5/ssrf.mjs';
import {mainnetEraseParts} from '../src/v5/user-data.mjs';import {createSiriCred} from '../src/v5/siri-cred.mjs';
import {createOAuth} from '../kit/oauth.mjs';import {readCapped,ipKey} from '../src/v5/router.mjs';import {ipHash} from '../src/v5/store.mjs';
const PUB=async()=>[{address:'93.184.216.34'}];

test('t1275 SSRF: every IPv6 form that embeds a private IPv4 is private (as the URL parser normalises it)',async()=>{
  const hosts=['[::ffff:127.0.0.1]','[::127.0.0.1]','[2002:7f00:1::]','[2002:a9fe:a9fe::1]','[64:ff9b::127.0.0.1]','[64:ff9b::a9fe:a9fe]','[64:ff9b:1::1]','[::ffff:0:127.0.0.1]',
    '[2001:0:4136:e378:8000:63bf:80ff:fffe]'/* Teredo, client 127.0.0.1 */,'[::ffff:10.0.0.1]','[::ffff:169.254.169.254]','[::]','[::1]','[fe80::1]','[fc00::1]','[fec0::1]','[ff02::1]','[100::1]','[2001:db8::1]'];
  for(const h of hosts){const u=new URL('https://'+h+'/');assert.ok(isPrivateIp(u.hostname),h+' -> '+u.hostname);
    await assert.rejects(assertPublicUrl(u.toString(),{resolve:PUB}),e=>e.code==='ssrf_blocked',h);}
  assert.equal(new URL('https://[::ffff:127.0.0.1]/').hostname,'[::ffff:7f00:1]');   // the form that used to pass as public
  for(const ip of ['garbage','1::2::3','1:2:3:4:5:6:7:8:9','::ffff:999.1.1.1','',null])assert.ok(isPrivateIp(ip),String(ip));   // unparsable = private
  for(const ip of ['2606:4700::1111','2a00:1450:4001:80b::200e','::ffff:93.184.216.34','2002:5db8:d822::1','64:ff9b::5db8:d822'])assert.ok(!isPrivateIp(ip),ip);
  assert.deepEqual(expand6('::ffff:1.2.3.4'),[0,0,0,0,0,0xffff,0x102,0x304]);
  await assert.rejects(assertPublicUrl('https://x.example/',{resolve:async()=>[{address:'93.184.216.34'},{address:'::ffff:7f00:1'}]}),e=>e.code==='ssrf_blocked');});

test('t1275 SSRF: DNS rebinding - the host is resolved once and the request is pinned to the vetted address',async()=>{
  let n=0;const resolve=async()=>(n++===0?[{address:'93.184.216.34'}]:[{address:'127.0.0.1'}]);let pinned=null,sent=null;
  const f=guardFetch(async()=>{throw Error('unpinned fetch must not run');},{resolve,pin:a=>{pinned=a;return async(url,o)=>{sent={url,o};return new Response('ok');};}});
  const r=await f('https://rebind.example/a?b=1',{method:'POST',body:'x'});assert.equal(await r.text(),'ok');
  assert.equal(n,1,'resolved exactly once');assert.deepEqual(pinned,{address:'93.184.216.34',family:4});assert.equal(sent.url,'https://rebind.example/a?b=1');assert.equal(sent.o.redirect,'error');
  // a second request resolves again: now private -> refused before any connection
  await assert.rejects(f('https://rebind.example/a'),e=>e.code==='ssrf_blocked');
  // the default (platform fetch) path pins too
  const src=fs.readFileSync(new URL('../src/v5/ssrf.mjs',import.meta.url),'utf8');assert.match(src,/pin\?\?\(f===NATIVE_FETCH\?pinnedFetch:null\)/);});

test('t1275 SSRF: pinnedFetch connects only to the pinned address (name never resolved), decodes gzip, refuses redirects',async()=>{
  const seen=[];const srv=http.createServer((q,s)=>{seen.push({url:q.url,host:q.headers.host,method:q.method});let b='';q.on('data',c=>b+=c);q.on('end',()=>{
    if(q.url==='/redir'){s.writeHead(302,{location:'http://127.0.0.1/'});return s.end();}
    if(q.url==='/gz'){s.writeHead(200,{'content-encoding':'gzip','content-type':'application/json'});return s.end(zlib.gzipSync(JSON.stringify({ok:true,body:b})));}
    s.writeHead(402,{'x-t':'1'});s.end('pay '+b);});});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const port=srv.address().port;
  try{const F=pinnedFetch({address:'127.0.0.1',family:4});
    const r=await F(`http://never-resolves.invalid:${port}/p?q=1`,{method:'POST',headers:{'content-type':'text/plain'},body:'hi'});
    assert.equal(r.status,402);assert.equal(r.headers.get('x-t'),'1');assert.equal(await r.text(),'pay hi');
    assert.equal(seen[0].host,`never-resolves.invalid:${port}`);assert.equal(seen[0].url,'/p?q=1');
    const g=await F(`http://never-resolves.invalid:${port}/gz`,{method:'POST',body:'z'});assert.deepEqual(await g.json(),{ok:true,body:'z'});
    await assert.rejects(F(`http://never-resolves.invalid:${port}/redir`,{redirect:'error'}),/redirect/);}
  finally{srv.close();}});

test('t1275 erase: Siri credential, stored Siri requests and the connect record go; the old ksc_ token stays dead after the same key re-enrols',()=>{
  const S={siriAgent:{since:'x'}};let saves=0;const save=()=>{saves++;};let fp='fp-phone';const SC=createSiriCred({store:S,save,phoneFp:()=>fp});
  const tok=SC.issue();SC.remember('ap1',{to:'0xabc',amount:'1'});const req={headers:{authorization:'Bearer '+tok}};assert.equal(SC.check(req),true);
  const parts=mainnetEraseParts({S,save,agents:[],siri:SC});const p=parts.find(x=>x.name==='siri');assert.ok(p,'siri part');
  assert.ok(parts.findIndex(x=>x.name==='siri')<=1,'runs right after agent-credentials');
  fp=null;/* erase forgets the phone */p.forget();
  for(const k of ['siriCred','siriPending','siriAgent'])assert.ok(!(k in S),k);fp='fp-phone';/* same key enrolled again */assert.equal(SC.check(req),false);assert.equal(SC.take('ap1'),null);
  // without an SC object the fields still go
  const S2={siriCred:{h:'00',fp:'f'},siriPending:{a:{}},siriAgent:{}};mainnetEraseParts({S:S2,save,agents:[]}).find(x=>x.name==='siri').forget();assert.deepEqual(S2,{});
  const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');assert.ok(L.includes('agents,kv:KV,siri:SC/* t1275 */})'),'launch passes SC to the erase parts');});

const W='0x1000000000000000000000000000000000000001';const AM={single:'2500000',daily:'7000000',total:'15000000'};
function oa(o={}){const S={};const O=createOAuth({S,save:()=>{},base:()=>'https://pay.example',network:'main',wallet:W,ownerAddress:'0x2222',verifyOwner:o.verify??(async()=>false),
  createAgentKey:(n,k)=>k,isAgentLive:()=>true,caps:()=>null,ownerSession:()=>null,spendAuthorization:()=>({authorized:false}),consentScript:()=>'',
  phoneApprover:{active:()=>({fingerprint:'fp',x:'0x1',y:'0x2',approver:'0x'+'ab'.repeat(20)}),onChain:async()=>true,verify:()=>false},...o.opts});
  const call=async(path,body,{ip='203.0.113.7',headers={},method='POST'}={})=>{let out,code,hdr;const res={writeHead(c,h){code=c;hdr=h;},end(b){out=b;}};
    await O.handle({method,headers},res,new URL('https://pay.example'+path),{readBody:async()=>body??{},ip});return {code,out:hdr?.['content-type']?.includes('json')?JSON.parse(out):out};};
  return {S,O,call};}
const openFirst=S=>Object.values(S.oauth.pending).filter(x=>x.status==='pending'&&x.challenge==='first');

test('t1275 /oauth/first: per-IP rate limit, at most maxFirstPending open first requests (oldest makes room), client and pending caps',async()=>{
  const t=oa();const codes=[];for(let i=0;i<14;i++)codes.push((await t.call('/oauth/first',{agent:'siri',...AM})).code);
  assert.deepEqual(codes.slice(0,10),Array(10).fill(200));assert.ok(codes.slice(10).every(c=>c===429),'11th call in a minute from one IP is refused');
  assert.equal(openFirst(t.S).length,5);assert.equal(Object.keys(t.S.oauth.clients).length,5,'clients of pruned requests went with them');
  // the newest request is the one kept: a flood cannot push the owner's own request out before it is made
  const last=await t.call('/oauth/first',{agent:'siri',...AM},{ip:'198.51.100.1'});assert.equal(last.code,200);assert.ok(t.S.oauth.pending[last.out.req]);assert.equal(openFirst(t.S).length,5);
  // maxClients: every slot held by a live client -> 429 too_many_clients, nothing written
  const t2=oa({opts:{maxClients:2,maxFirstPending:5}});let ip=0;const go=()=>t2.call('/oauth/first',{agent:'muse',...AM},{ip:'10.0.0.'+(ip++)});
  assert.equal((await go()).code,200);assert.equal((await go()).code,200);const c=await go();assert.equal(c.code,429);assert.equal(c.out.error,'too_many_clients');assert.equal(Object.keys(t2.S.oauth.pending).length,2);
  // maxPending (open requests of every kind) -> 429 too_many
  const t3=oa({opts:{maxPending:3}});for(let i=0;i<3;i++)t3.S.oauth.pending['x'+i]={client_id:'c',redirect_uri:'https://a.example/cb',exp:Date.now()/1000+600,status:'pending'};
  const p=await t3.call('/oauth/first',{agent:'siri',...AM});assert.equal(p.code,429);assert.equal(p.out.error,'too_many');assert.equal(Object.keys(t3.S.oauth.clients).length,0);});

test('t1275 /oauth/owner-decide: deny needs the phone session or a Base Account decline signature; without, the request stays open',async()=>{
  let sess=false;const msgs=[];const t=oa({verify:async(m,sig)=>{msgs.push(m);return sig==='0xgood'&&m.startsWith('Kipurse: DECLINE');},opts:{ownerAuth:()=>sess}});
  const mk=()=>{const id='r'+Math.random().toString(36).slice(2);t.S.oauth.clients.c1={name:'Muse',redirect_uris:['https://agent.example/cb'],created:Date.now()};
    t.S.oauth.pending[id]={client_id:'c1',redirect_uri:'https://agent.example/cb',challenge:'C'.repeat(43),state:'st1',exp:Date.now()/1000+600,status:'pending'};return id;};
  const a=mk();const soft=await t.call('/oauth/owner-decide',{req:a,approve:false});assert.equal(soft.code,200);assert.match(soft.out.redirect,/error=access_denied/);assert.match(soft.out.redirect,/state=st1/);
  assert.equal(soft.out.soft,true);assert.equal(t.S.oauth.pending[a].status,'pending','anyone with the id can no longer cancel it');
  const bad=await t.call('/oauth/owner-decide',{req:a,approve:false,signature:'0xbad'});assert.equal(bad.code,403);assert.equal(t.S.oauth.pending[a].status,'pending');
  const sig=await t.call('/oauth/owner-decide',{req:a,approve:false,signature:'0xgood'});assert.equal(sig.code,200);assert.equal(t.S.oauth.pending[a].status,'denied');assert.match(msgs.at(-1),/^Kipurse: DECLINE this connection request\.\nKipurse: allow "Muse"/);
  const b=mk();sess=true;const ph=await t.call('/oauth/owner-decide',{req:b,approve:false});assert.equal(ph.code,200);assert.equal(t.S.oauth.pending[b].status,'denied');assert.ok(!ph.out.soft);
  const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');assert.ok(L.includes('ownerAuth:req=>PS.check(req)'),'launch wires the phone session');});

test('t1275 /mcp: a streamed body with no content-length gets the same 64 KB cap as the router',async()=>{
  assert.equal(await readCapped(Readable.from([Buffer.alloc(40000,97),Buffer.alloc(30000,97)]),65536),null);
  const s='{"a":"'+'é'.repeat(1000)+'"}';const parts=[Buffer.from(s).subarray(0,7),Buffer.from(s).subarray(7)];/* splits a 2-byte char */assert.equal(await readCapped(Readable.from(parts),65536),s);
  assert.equal((await readCapped(Readable.from([Buffer.alloc(65536,97)]),65536))?.length,65536);
  const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');assert.ok(L.includes('MCP_MAX_BODY=65536'));
  assert.ok(L.includes('const b=await readCapped(req,MCP_MAX_BODY);if(b===null)return j(413'));assert.ok(!L.includes('b.length>1e6'));});

test('t1275 rate-limit IP keys: salted HMAC, stable within a process, different per process, not a bare SHA-256',()=>{
  const ip='203.0.113.9';assert.equal(ipKey(ip),ipKey(ip));assert.equal(ipHash(ip),ipHash(ip));assert.notEqual(ipKey(ip),ipKey('203.0.113.10'));
  assert.notEqual(ipKey(ip),createHash('sha256').update('kp-rl:'+ip).digest('hex').slice(0,24));assert.notEqual(ipHash(ip),createHash('sha256').update('kp-rl-ip:'+ip).digest('hex').slice(0,24));
  assert.equal(ipKey('2a09:bac1:76c0:5060::1'),ipKey('2a09:bac1:76c0:5060::2'),'v6 /64 bucket kept');
  const other=execFileSync(process.execPath,['--input-type=module','-e',`import {ipKey} from ${JSON.stringify(new URL('../src/v5/router.mjs',import.meta.url).href)};process.stdout.write(ipKey('${ip}'))`],{env:{...process.env,KIPURSE_RL_SALT:''}}).toString();
  assert.match(other,/^[0-9a-f]{24}$/);assert.notEqual(other,ipKey(ip),'per-process salt');});
