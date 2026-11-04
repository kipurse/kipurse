// SPDX-License-Identifier: AGPL-3.0-only
// Emergency page for an UNBOUND phone: only the owner's Base Account signature can pause / cancel holds. Attackers get 401.
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';import {verifyMessage} from 'viem';
import {createOwnerEmergency,emergencyMessage} from '../src/v5/owner-emergency.mjs';
const W='0x1000000000000000000000000000000000000004';
function setup(){const owner=privateKeyToAccount(generatePrivateKey()),thief=privateKeyToAccount(generatePrivateKey());
  const st={paused:false,holds:[{id:'h1'},{id:'h2'}]};
  const EM=createOwnerEmergency({wallet:W,owner:owner.address,verifyOwner:(message,signature)=>verifyMessage({address:owner.address,message,signature}),
    pendingHolds:()=>st.holds.length,pause:async()=>{st.paused=true;return {server:{until:null}};},cancelHolds:async()=>{const n=st.holds.length;st.holds=[];return {cancelled:n,left:0};},script:()=>'//js'});
  const srv=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://x');const readBody=async r=>{let s='';for await(const c of r)s+=c;return JSON.parse(s||'{}');};
    const P=u.pathname.replace(/^\/t\/0x[0-9a-f]{40}/,'');if(!await EM.handle(req,res,new URL(P+u.search,'http://x'),{readBody,ip:'1.1.1.1'})){res.writeHead(404);res.end();}});
  return new Promise(r=>srv.listen(0,'127.0.0.1',()=>r({st,owner,thief,srv,base:'http://127.0.0.1:'+srv.address().port+'/t/'+W.toLowerCase()})));}
const post=async(base,p,b)=>{const r=await fetch(base+'/owner/emergency/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return {code:r.status,j:await r.json()};};
test('emergency: owner Base Account signature pauses and cancels holds, no phone needed',async()=>{const {st,owner,srv,base}=await setup();try{
  const pg=await fetch(base+'/owner/emergency?lang=zh');assert.equal(pg.status,200);const h=await pg.text();for(const s of ['暂停 AI 付款','取消所有等待中的付款','href="https://sign.kipurse.com/v5/t/','src="emergency.js"'])assert.ok(h.includes(s),s);
  assert.ok((await (await fetch(base+'/owner/emergency?lang=en')).text()).includes('Pause AI payments'));
  const c=await post(base,'challenge',{action:'pause'});assert.equal(c.code,200);assert.equal(c.j.message,emergencyMessage({action:'pause',wallet:W,nonce:c.j.nonce}));assert.ok(c.j.message.includes(W.toLowerCase()));
  const a=await post(base,'act',{nonce:c.j.nonce,signature:await owner.signMessage({message:c.j.message})});assert.equal(a.code,200);assert.equal(st.paused,true);
  const c2=await post(base,'challenge',{action:'cancel_holds'});const b=await post(base,'act',{nonce:c2.j.nonce,signature:await owner.signMessage({message:c2.j.message})});
  assert.equal(b.code,200);assert.equal(b.j.cancelled,2);assert.equal(st.holds.length,0);}finally{srv.close();}});
test('emergency: attacker without / with wrong signature -> 401, nothing changes; replay and action swap rejected',async()=>{const {st,owner,thief,srv,base}=await setup();try{
  const c=await post(base,'challenge',{action:'cancel_holds'});
  assert.equal((await post(base,'act',{nonce:c.j.nonce})).code,401,'no signature');
  assert.equal((await post(base,'act',{nonce:c.j.nonce,signature:''})).code,401);
  const c1=await post(base,'challenge',{action:'cancel_holds'});
  const t=await post(base,'act',{nonce:c1.j.nonce,signature:await thief.signMessage({message:c1.j.message})});assert.equal(t.code,401);assert.equal(t.j.error,'not_owner');
  assert.equal((await post(base,'act',{nonce:c1.j.nonce,signature:await owner.signMessage({message:c1.j.message})})).code,401,'nonce burnt by the failed try');
  const c3=await post(base,'challenge',{action:'pause'});const other=emergencyMessage({action:'pause',wallet:'0x1000000000000000000000000000000000000009',nonce:c3.j.nonce});
  assert.equal((await post(base,'act',{nonce:c3.j.nonce,signature:await owner.signMessage({message:other})})).code,401,'signature for another wallet');
  const c4=await post(base,'challenge',{action:'pause'});const sig=await owner.signMessage({message:c4.j.message});assert.equal((await post(base,'act',{nonce:c4.j.nonce,signature:sig})).code,200);
  assert.equal((await post(base,'act',{nonce:c4.j.nonce,signature:sig})).code,401,'replay');
  assert.equal(st.holds.length,2,'holds untouched by attacker');
  for(const a of ['resume','withdraw','','__proto__'])assert.equal((await post(base,'challenge',{action:a})).code,400,'only safe actions: '+a);
  assert.equal((await fetch(base+'/owner/emergency/act')).status,405);}finally{srv.close();}});
