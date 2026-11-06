import test from 'node:test';import assert from 'node:assert/strict';import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {createOAuth,connectDigest,connectText} from '../kit/oauth.mjs';import {p256VerifyDigest,fingerprint} from '../src/v5/phone-signer.mjs';
const W='0x1000000000000000000000000000000000000001';
const key=()=>{const k=generateKeyPairSync('ec',{namedCurve:'P-256'});const j=k.publicKey.export({format:'jwk'});const h=b=>'0x'+Buffer.from(b,'base64url').toString('hex');
  const x=h(j.x),y=h(j.y);return {x,y,fingerprint:fingerprint(x,y),approver:'0x'+'ab'.repeat(20),
    sig:digestText=>{const s=sign('sha256',Buffer.from(digestText),{key:k.privateKey,dsaEncoding:'ieee-p1363'});const N=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;let sv=BigInt('0x'+s.subarray(32).toString('hex'));if(sv>N/2n)sv=N-sv;// low-s, like the app
    return {r:'0x'+s.subarray(0,32).toString('hex'),s:'0x'+sv.toString(16).padStart(64,'0')};}};};
function setup({onChain=true,now}={}){const S={},phone=key(),agents=[];let active=phone,chain=onChain;
  // t1073: mainnet approval requires an explicit spend snapshot. This fixture is a confirmed save, not a product default.
  const O=createOAuth({S,save:()=>{},base:()=>'https://pay.example',network:'main',wallet:W,ownerAddress:'0x2222',verifyOwner:async()=>false,
    createAgentKey:(n,k)=>{agents.push(k);return k;},isAgentLive:()=>true,caps:()=>null,ownerSession:()=>null,
    spendAuthorization:()=>({authorized:true,perPayment:'2',perDay:'5',termTotal:'30',at:1}),
    phoneApprover:{active:()=>active,onChain:async()=>chain,verify:(a,d,r,s)=>p256VerifyDigest(a,d,r,s)}});
  const call=async(path,body,method='POST')=>{let out,code,hdr;const res={writeHead(c,h){code=c;hdr=h;},end(b){out=b;}};
    await O.handle({method,headers:{'accept-language':'zh-CN'}},res,new URL('https://pay.example'+path),{readBody:async()=>body,ip:'1.1.1.'+Math.floor(Math.random()*250)});
    return {code,out:hdr?.['content-type']?.includes('json')?JSON.parse(out):out};};
  return {S,O,phone,agents,call,setActive:a=>{active=a;},setChain:c=>{chain=c;}};}
async function start(t){const r=await t.call('/oauth/register',{client_name:'Grok Bot',redirect_uris:['https://www.cursor.com/agents/mcp/oauth/callback']});const cid=r.out.client_id;
  const a=await t.call(`/oauth/authorize?response_type=code&client_id=${cid}&redirect_uri=${encodeURIComponent('https://www.cursor.com/agents/mcp/oauth/callback')}&code_challenge=${'A'.repeat(43)}&code_challenge_method=S256&state=st1`,null,'GET');
  const id=Object.keys(t.S.oauth.pending)[0];return {cid,id,page:a.out};}
const textFor=(t,id,action)=>{const p=t.S.oauth.pending[id];return connectText({wallet:W,req:id,clientId:p.client_id,name:'Grok Bot',redirect:p.redirect_uri,exp:p.exp,action});};

test('consent page offers Face ID in Kipurse (deep link) and keeps Base Account as an option',async()=>{const t=setup();const {id,page}=await start(t);
  assert.match(page,new RegExp(`kipurse://approve-connect\\?id=${id}`));assert.match(page,/在 Kipurse 里用 Face ID 批准/);assert.match(page,/或用 Base Account 批准/);assert.match(page,/授权中/);assert.match(page,/授权完成/);});
test('prepare binds digest to request, client, redirect, expiry; status shows signing phase',async()=>{const t=setup();const {cid,id}=await start(t);
  const p=await t.call('/oauth/phone-prepare',{req:id});assert.equal(p.code,200);assert.equal(p.out.name,'Grok Bot');assert.equal(p.out.clientId,cid);assert.equal(p.out.returnsTo,'www.cursor.com');
  assert.equal(p.out.digest,'0x'+createHash('sha256').update(textFor(t,id,'approve')).digest('hex'));assert.notEqual(p.out.digest,p.out.rejectDigest);assert.equal(p.out.access,'request-only');
  const s=await t.call('/oauth/status?req='+id,null,'GET');assert.equal(s.out.phase,'signing');});
test('valid phone signature approves and redirects back with code + state; replay rejected',async()=>{const t=setup();const {id}=await start(t);
  const sg=t.phone.sig(textFor(t,id,'approve'));const d=await t.call('/oauth/phone-decide',{req:id,approve:true,...sg});
  assert.equal(d.code,200);assert.equal(d.out.status,'approved');assert.match(d.out.redirect,/^https:\/\/www\.cursor\.com\/agents\/mcp\/oauth\/callback\?state=st1&iss=.*&code=/);assert.deepEqual(t.agents,['grok-bot']);
  const st=await t.call('/oauth/status?req='+id,null,'GET');assert.equal(st.out.redirect,d.out.redirect);
  const again=await t.call('/oauth/phone-decide',{req:id,approve:true,...sg});assert.equal(again.code,400);assert.equal(t.agents.length,1);});
test('signature for another request / reject action / wrong key is refused',async()=>{const t=setup();const {id}=await start(t);const {id:id2}=await (async()=>{const x=await start(t);return x;})().catch(()=>({id:null}));
  const other=key();assert.equal((await t.call('/oauth/phone-decide',{req:id,approve:true,...other.sig(textFor(t,id,'approve'))})).out.error,'bad_signature');
  assert.equal((await t.call('/oauth/phone-decide',{req:id,approve:true,...t.phone.sig(textFor(t,id,'reject'))})).out.error,'bad_signature');
  const p=t.S.oauth.pending[id];const wrongReq=connectText({wallet:W,req:'zzz',clientId:p.client_id,name:'Grok Bot',redirect:p.redirect_uri,exp:p.exp,action:'approve'});
  assert.equal((await t.call('/oauth/phone-decide',{req:id,approve:true,...t.phone.sig(wrongReq)})).out.error,'bad_signature');
  assert.equal(t.S.oauth.pending[id].status,'pending');assert.equal(t.agents.length,0);});
test('expired request refused even with a valid signature',async()=>{const t=setup();const {id}=await start(t);const sg=t.phone.sig(textFor(t,id,'approve'));
  t.S.oauth.pending[id].exp=Date.now()/1000-1;assert.equal((await t.call('/oauth/phone-decide',{req:id,approve:true,...sg})).code,400);
  assert.equal((await t.call('/oauth/phone-prepare',{req:id})).code,400);assert.equal(t.agents.length,0);});
test('revoked phone (no longer a wallet owner on chain) is rejected; no enrolled phone -> 409',async()=>{const t=setup({onChain:false});const {id}=await start(t);
  const r=await t.call('/oauth/phone-decide',{req:id,approve:true,...t.phone.sig(textFor(t,id,'approve'))});assert.equal(r.code,403);assert.equal(r.out.error,'phone_revoked');
  t.setActive(null);assert.equal((await t.call('/oauth/phone-decide',{req:id,approve:true})).code,409);assert.equal(t.agents.length,0);});
test('phone can decline with a signed reject',async()=>{const t=setup();const {id}=await start(t);
  const r=await t.call('/oauth/phone-decide',{req:id,approve:false,...t.phone.sig(textFor(t,id,'reject'))});assert.equal(r.out.status,'denied');assert.match(r.out.redirect,/error=access_denied/);});
test('connectDigest is the SHA-256 of the documented text (app recomputes it)',()=>{
  assert.equal(connectText({wallet:'0xAB',req:'r',clientId:'kpc_1',name:'Grok Bot',redirect:'https://x/cb',exp:1700000000.9,action:'approve'}),'Kipurse approve connection v1\nwallet:0xab\nreq:r\nclient:kpc_1\nname:Grok Bot\nredirect:https://x/cb\nexp:1700000000\naction:approve');
  assert.equal(connectDigest({wallet:'0xab',req:'r',clientId:'c',name:'n',redirect:'https://x',exp:1,action:'approve'}),'0x'+createHash('sha256').update('Kipurse approve connection v1\nwallet:0xab\nreq:r\nclient:c\nname:n\nredirect:https://x\nexp:1\naction:approve').digest('hex'));});
test('shared vector (app KipurseCoreTests uses the same): cursor:// redirect, non-ASCII name, fractional expiry',()=>{
  assert.equal(connectDigest({wallet:'0x1000000000000000000000000000000000000001',req:'_cT8DHJ2gmbqFldkPBeVSx3I',clientId:'kpc_TESTCLIENT000000000000',name:'Grok Bot 助手 ✨',
    redirect:'cursor://anysphere.cursor-mcp/oauth/callback?x=a%20b',exp:1792680260.255,action:'approve'}),'0x47753f67686a00f5ac2470ccdbe593ff42767c0988ba621a77c022cd0165eb4e');});

test('consent opened on a phone is marked origin=phone (app returns to the AI); computer otherwise; code lives 10 min',async()=>{const t=setup();
  const r=await t.call('/oauth/register',{client_name:'Claude',redirect_uris:['https://claude.ai/api/mcp/auth_callback']});const cid=r.out.client_id;
  const q=`/oauth/authorize?response_type=code&client_id=${cid}&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}&code_challenge=${'B'.repeat(43)}&code_challenge_method=S256&state=s2`;
  let code,out;const res={writeHead(c){code=c;},end(b){out=b;}};
  await t.O.handle({method:'GET',headers:{'accept-language':'zh-CN','user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'}},res,new URL('https://pay.example'+q),{readBody:async()=>null,ip:'1.1.1.9'});
  assert.equal(code,200);assert.match(out,/addEventListener\('pageshow',tick\)/);const id=Object.keys(t.S.oauth.pending)[0];
  const p=await t.call('/oauth/phone-prepare',{req:id});assert.equal(p.out.origin,'phone');assert.equal(p.out.returnsTo,'claude.ai');
  const sg=t.phone.sig(connectText({wallet:W,req:id,clientId:cid,name:'Claude',redirect:'https://claude.ai/api/mcp/auth_callback',exp:t.S.oauth.pending[id].exp,action:'approve'}));
  const d=await t.call('/oauth/phone-decide',{req:id,approve:true,...sg});assert.equal(d.out.status,'approved');
  assert.ok(t.S.oauth.pending[id].codeExp-Date.now()/1000>590);
  await start(t);const gid=Object.keys(t.S.oauth.pending).find(k=>k!==id);assert.equal((await t.call('/oauth/phone-prepare',{req:gid})).out.origin,'computer');});
