import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {P256} from 'ox';import {createPhoneSession,sessionDigest} from '../src/v5/phone-session.mjs';import {fingerprint} from '../src/v5/phone-signer.mjs';
import {createPublicLimits,checkLimits,parseUsdc} from '../src/v5/limits-public.mjs';
const hx=n=>'0x'+n.toString(16).padStart(64,'0');
const key=()=>{const priv=P256.randomPrivateKey();const pub=P256.getPublicKey({privateKey:priv});const x=hx(pub.x),y=hx(pub.y);return {priv,x,y,fingerprint:fingerprint(x,y)};};
const W='0x1000000000000000000000000000000000000001';
async function serve(handler){const s=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://x');const readBody=async r=>{let b='';for await(const c of r)b+=c;return b?JSON.parse(b):{};};
  if(!(await handler(req,res,u,{readBody,ip:'1.2.3.4'}))){res.writeHead(404);res.end();}});await new Promise(r=>s.listen(0,'127.0.0.1',r));return {url:`http://127.0.0.1:${s.address().port}`,close:()=>s.close()};}
const sign=(k,d)=>{const sg=P256.sign({payload:d,privateKey:k.priv});return {r:hx(sg.r),s:hx(sg.s)};};
test('read-only phone session: challenge -> phone signature -> state; wrong key, replay, revoke, no writes',async()=>{
  const good=key(),evil=key();let active={...good,index:1};let reads=0;
  const PS=createPhoneSession({phone:{active:()=>active},wallet:W,readState:async()=>{reads++;return {balance:'14100000',agents:[{id:'muse',connected:true}]};}});
  const srv=await serve(PS.handle);const post=(p,b,h={})=>fetch(srv.url+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b??{})});
  try{
    assert.equal((await fetch(srv.url+'/phone/session/state')).status,401);
    let c=await (await post('/phone/session/challenge')).json();assert.equal(c.digest,sessionDigest(W,c.nonce));
    assert.equal((await post('/phone/session',{nonce:c.nonce,...sign(evil,c.digest)})).status,403,'other key rejected');
    assert.equal((await post('/phone/session',{nonce:c.nonce,...sign(good,c.digest)})).status,400,'challenge is single use');
    c=await (await post('/phone/session/challenge')).json();
    const wrongDigest=sessionDigest('0x0000000000000000000000000000000000000001',c.nonce);
    assert.equal((await post('/phone/session',{nonce:c.nonce,...sign(good,wrongDigest)})).status,403,'digest bound to wallet');
    c=await (await post('/phone/session/challenge')).json();
    const r=await post('/phone/session',{nonce:c.nonce,...sign(good,c.digest)});assert.equal(r.status,200);const t=(await r.json()).token;assert.match(t,/^kps_/);
    const st=await fetch(srv.url+'/phone/session/state',{headers:{authorization:'Bearer '+t}});assert.equal(st.status,200);const j=await st.json();
    assert.equal(j.balance,'14100000');assert.equal(j.scope,'read');assert.equal(j.agents[0].id,'muse');
    assert.equal((await fetch(srv.url+'/phone/session/state',{method:'POST',headers:{authorization:'Bearer '+t}})).status,404,'no write verbs');
    assert.equal((await fetch(srv.url+'/phone/session/approve',{method:'POST',headers:{authorization:'Bearer '+t}})).status,404);
    assert.equal((await fetch(srv.url+'/phone/session/state',{headers:{authorization:'Bearer kps_'+'A'.repeat(43)}})).status,401,'forged token');
    active={...evil,index:2};// signer replaced on chain -> old session ends
    assert.equal((await fetch(srv.url+'/phone/session/state',{headers:{authorization:'Bearer '+t}})).status,401);
    active=null;c=await (await post('/phone/session/challenge')).json();assert.equal((await post('/phone/session',{nonce:c.nonce,...sign(good,c.digest)})).status,409);
    assert.equal(reads,1);
  }finally{srv.close();}});
test('limits: owner-chosen caps validated; page shows them; confirm only after on-chain validity',async()=>{
  assert.equal(parseUsdc('10.05'),10050000n);assert.equal(parseUsdc('0'),null);assert.equal(parseUsdc('1.1234567'),null);assert.equal(parseUsdc('-1'),null);
  assert.equal(checkLimits({single:'5',daily:'2',term:'30'}).error,'single_above_daily');assert.equal(checkLimits({single:'1',daily:'40',term:'30'}).error,'daily_above_term');
  assert.equal(checkLimits({single:'1',daily:'2',term:'1000001'}).error,'term_too_high');assert.ok(!checkLimits({single:'100000',daily:'500000',term:'1000000'}).error);assert.equal(checkLimits({single:'1',daily:'2',term:'3',days:'400'}).error,'bad_days');
  assert.deepEqual(checkLimits({single:'1',daily:'2',term:'3',days:'30'}),{single:1000000n,daily:2000000n,term:3000000n,days:30});
  let planned=null,valid=false;
  const L=createPublicLimits({fee:async()=>({usdc:1n,payerUSDC:9n,canPayUSDC:true}),base:()=>'https://pay.example',current:async()=>({single:10050000n,daily:12012000n,term:30030000n,end:1800000000}),
    plan:async c=>{planned=c;return {owner:'0x1000000000000000000000000000000000000003',chainId:8453,human:{perPayment:'2'},labels:['revoke','approve'],calls:[{to:W,value:'0x0',data:'0x'}],raw:{p:1}};},
    confirm:async()=>({valid,permissionHash:'0xabc'}),script:()=>'//js'});
  const srv=await serve(L.handle);const post=(p,b)=>fetch(srv.url+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
  try{
    const pg=await fetch(srv.url+'/owner/limits?single=2&daily=5&term=50&days=90&lang=zh');assert.equal(pg.status,200);const h=await pg.text();
    assert.match(h,/每笔最多/);assert.match(h,/2 USDC/);assert.match(h,/50 USDC/);assert.match(h,/10\.05 USDC/);assert.match(h,/id=go/);
    assert.equal((await fetch(srv.url+'/owner/limits?single=9&daily=5&term=50')).status,400);
    assert.equal((await post('/owner/limits/prepare',{single:'9000000',daily:'5000000',term:'50000000'})).status,400);
    const p=await (await post('/owner/limits/prepare',{single:'2000000',daily:'5000000',term:'50000000',days:90})).json();
    assert.equal(planned.single,2000000n);assert.equal(planned.term,50000000n);assert.equal(planned.days,90);assert.equal(p.calls.length,1);assert.ok(!('raw' in p),'plan internals stay on the server');
    assert.deepEqual(await (await post('/owner/limits/confirm',{id:p.id})).json(),{ok:false});
    valid=true;assert.equal((await (await post('/owner/limits/confirm',{id:p.id})).json()).ok,true);
    const again=await post('/owner/limits/confirm',{id:p.id});assert.equal(again.status,200);assert.equal((await again.json()).ok,true,'repeat confirm returns the cached result (page + server poll may both ask)');assert.equal((await post('/owner/limits/confirm',{id:'nope'})).status,404);
  }finally{srv.close();}});
test('read sessions survive a restart (hashed tokens in state, 12h expiry); revoked signer still ends them',async()=>{
  const good=key();let active={...good,index:1};const S={};let saves=0;let t0=Date.now();
  const mk=()=>createPhoneSession({phone:{active:()=>active},wallet:W,readState:async()=>({balance:'1'}),store:S,save:()=>{saves++;},now:()=>t0});
  let srv=await serve(mk().handle);const post=(p,b)=>fetch(srv.url+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b??{})});
  const c=await (await post('/phone/session/challenge')).json();const t=(await (await post('/phone/session',{nonce:c.nonce,...sign(good,c.digest)})).json()).token;srv.close();
  assert.ok(saves>0);assert.ok(!JSON.stringify(S).includes(t),'raw token never stored');
  srv=await serve(mk().handle);// "deploy"
  try{const g=()=>fetch(srv.url+'/phone/session/state',{headers:{authorization:'Bearer '+t}});
    assert.equal((await g()).status,200,'still valid after restart');
    t0+=12*3600e3+1;assert.equal((await g()).status,401,'expires after 12h');assert.equal(Object.keys(S.sessions).length,0);
  }finally{srv.close();}});
