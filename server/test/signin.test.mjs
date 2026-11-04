// Sign in with Coinbase: free SIWE signature -> reconnect / bind / new. Offline (EOA signatures verified with viem).
import test from 'node:test';import assert from 'node:assert/strict';import {verifyMessage} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {createSignin,parseSiwe} from '../src/v5/signin.mjs';
const mkKv=()=>{const m=new Map();return {put:(k,v)=>m.set(k,v),get:k=>m.get(k),take:k=>{const v=m.get(k);m.delete(k);return v;}};};
const W='0x00000000000000000000000000000000000000A1';
function setup({owner,phone,onChain=true}){const logs=[];const reg={byOwner:o=>owner&&o.toLowerCase()===owner.toLowerCase()?[{wallet:W,publicPath:'/t/'+W.toLowerCase()}]:[]};
  const pub={verifyMessage:a=>verifyMessage(a),readContract:async()=>onChain};
  const S=createSignin({kv:mkKv(),pub,reg,obs:{log:(e,o)=>logs.push([e,o])},base:()=>'https://pay.kipurse.com',phoneOf:async()=>phone,script:()=>''});return {S,logs};}
const sign=async(S,acct,body)=>{const st=S.start(body);const {message}=S.message(st.id,acct.address);return {st,message,signature:await acct.signMessage({message})};};
const PH={x:'0x01',y:'0x02',approver:'0x00000000000000000000000000000000000000B2'};
test('existing account + same phone key on chain -> reconnect, no tx',async()=>{const a=privateKeyToAccount(generatePrivateKey());const {S,logs}=setup({owner:a.address,phone:PH});
  const {st,message,signature}=await sign(S,a,{x:PH.x,y:PH.y});const r=await S.verify(st.id,{address:a.address,message,signature});
  assert.equal(r.result,'reconnect');assert.equal(r.wallet,W);assert.deepEqual(S.status(st.id,st.poll).result,'reconnect');
  assert.ok(!JSON.stringify(logs).toLowerCase().includes(a.address.toLowerCase().slice(2)),'no address in logs');});
test('existing account + other phone key -> bind',async()=>{const a=privateKeyToAccount(generatePrivateKey());const {S}=setup({owner:a.address,phone:PH});
  const {st,message,signature}=await sign(S,a,{x:'0x09',y:'0x02'});assert.equal((await S.verify(st.id,{address:a.address,message,signature})).result,'bind');});
test('existing account + key not owner on chain any more -> bind',async()=>{const a=privateKeyToAccount(generatePrivateKey());const {S}=setup({owner:a.address,phone:PH,onChain:false});
  const {st,message,signature}=await sign(S,a,{x:PH.x,y:PH.y});assert.equal((await S.verify(st.id,{address:a.address,message,signature})).result,'bind');});
test('account without wallet -> new (stale key ignored)',async()=>{const a=privateKeyToAccount(generatePrivateKey());const {S}=setup({owner:'0x00000000000000000000000000000000000000C3',phone:PH});
  const {st,message,signature}=await sign(S,a,{x:PH.x,y:PH.y});const r=await S.verify(st.id,{address:a.address,message,signature});assert.equal(r.result,'new');assert.equal(r.wallet,null);});
test('signature by someone else is refused',async()=>{const a=privateKeyToAccount(generatePrivateKey()),b=privateKeyToAccount(generatePrivateKey());const {S}=setup({owner:a.address,phone:PH});
  const st=S.start({});const {message}=S.message(st.id,a.address);const signature=await b.signMessage({message});
  await assert.rejects(S.verify(st.id,{address:a.address,message,signature}),e=>e.code==='bad_signature');});
test('wrong nonce / domain / chain refused',async()=>{const a=privateKeyToAccount(generatePrivateKey());const {S}=setup({owner:a.address,phone:PH});
  const st=S.start({});const {message}=S.message(st.id,a.address);
  for(const m of [message.replace(/Nonce: .*/,'Nonce: deadbeefdeadbeefdeadbeef'),message.replace('pay.kipurse.com wants','evil.example wants'),message.replace('Chain ID: 8453','Chain ID: 1')])
    await assert.rejects(S.verify(st.id,{address:a.address,message:m,signature:await a.signMessage({message:m})}),e=>e.code==='bad_message');
  assert.equal(parseSiwe(message).chainId,8453);});
test('unknown id refused; status of unknown = expired',async()=>{const {S}=setup({});assert.throws(()=>S.message('00'.repeat(16),'0x00000000000000000000000000000000000000C3'));assert.equal(S.status('x').state,'expired');});
test('Base Account SIWE variants (CRLF, scheme in domain line, no statement, Expiration/Request ID/Resources) verify over the exact signed text',async()=>{
  const a=privateKeyToAccount(generatePrivateKey());const {S}=setup({owner:a.address,phone:PH});
  const mk=(st,v)=>{const now=new Date().toISOString(),exp=new Date(Date.now()+600e3).toISOString();return [
    `https://pay.kipurse.com wants you to sign in with your Ethereum account:\n${a.address}\n\nURI: https://pay.kipurse.com\nVersion: ${v}\nChain ID: 8453\nNonce: ${st.nonce}\nIssued At: ${now}\nExpiration Time: ${exp}\nRequest ID: x1\nResources:\n- https://pay.kipurse.com/signin`,
    `pay.kipurse.com wants you to sign in with your Ethereum account:\r\n${a.address}\r\n\r\nSign in.\r\n\r\nURI: https://pay.kipurse.com\r\nVersion: ${v}\r\nChain ID: 8453\r\nNonce: ${st.nonce}\r\nIssued At: ${now}`];};
  {const st=S.start({});const m=mk(st,'1')[0].replace(/Version: 1\n/,'');const r=await S.verify(st.id,{address:a.address,message:m,signature:await a.signMessage({message:m})});assert.equal(r.result,'bind','no Version line');}
  for(const i of [0,1]){const st=S.start({x:PH.x,y:PH.y});const m=mk(st,'1')[i];const r=await S.verify(st.id,{address:a.address,message:m,signature:await a.signMessage({message:m})});assert.equal(r.result,'reconnect','variant '+i);}
  const st=S.start({});const m=mk(st,'2')[0];await assert.rejects(S.verify(st.id,{address:a.address,message:m,signature:await a.signMessage({message:m})}),e=>e.code==='bad_message'&&/version/.test(e.message));});
test('Coinbase shape: no Version, no Issued At (fields: URI, Chain ID, Nonce) -> accepted; nonce single-use + TTL bound to id',async()=>{
  const a=privateKeyToAccount(generatePrivateKey());const {S}=setup({owner:a.address,phone:PH});const st=S.start({x:PH.x,y:PH.y});
  const m=`pay.kipurse.com wants you to sign in with your Ethereum account:\n${a.address}\n\nURI: https://pay.kipurse.com\nChain ID: 8453\nNonce: ${st.nonce}`;
  const r=await S.verify(st.id,{address:a.address,message:m,signature:await a.signMessage({message:m})});assert.equal(r.result,'reconnect');
  const st2=S.start({});const m2=m.replace(st.nonce,st2.nonce)+'\nIssued At: 2020-01-01T00:00:00Z';
  await assert.rejects(S.verify(st2.id,{address:a.address,message:m2,signature:await a.signMessage({message:m2})}),e=>/time/.test(e.message));
  const m3=m.replace('pay.kipurse.com wants','evil.example wants').replace(st.nonce,S.start({}).nonce);
  const st3=S.start({});await assert.rejects(S.verify(st3.id,{address:a.address,message:m3,signature:await a.signMessage({message:m3})}),e=>e.code==='bad_message');});
// one-page new-user setup: sign-in carries the phone key + default limits; a NEW owner gets his pending setup bound (sponsorable), others don't
test('signin + setup: new owner -> setup bound to him; status reports setup; returning owner -> no setup',async()=>{
  const {createSignin}=await import('../src/v5/signin.mjs');
  const store=new Map();const kv={get:k=>store.get(k),put:(k,v)=>store.set(k,v)};const bound=[];
  const onboard={start:async()=>({id:'onb1'}),bindOwner:(id,o)=>{bound.push([id,o]);return true;},sponsorable:()=>true,status:()=>({state:'start',wallet:null})};
  const a=privateKeyToAccount(generatePrivateKey());
  const S=createSignin({kv,pub:{verifyMessage:async({address,message,signature})=>(await import('viem')).verifyMessage({address,message,signature})},reg:{byOwner:()=>[]},phoneOf:async()=>null,base:()=>'https://pay.kipurse.com',script:()=>'',onboard});
  const st=await S.start({x:'0x'+'1'.repeat(64),y:'0x'+'2'.repeat(64),setup:{single:'1',daily:'5',term:'20',days:'90'}});assert.equal(st.setup,true);
  const {message}=S.message(st.id,a.address);const r=await S.verify(st.id,{address:a.address,message,signature:await a.signMessage({message})});
  assert.equal(r.result,'new');assert.deepEqual(r.setup,{id:'onb1',free:true});assert.deepEqual(bound,[['onb1',a.address]]);
  assert.deepEqual(S.status(st.id,st.poll).setup,{state:'start',wallet:null});
  const st0=S.start({});assert.equal(st0.setup,false);
  const S2=createSignin({kv,pub:{verifyMessage:async()=>true},reg:{byOwner:()=>[{wallet:'0x'+'3'.repeat(40)}]},phoneOf:async()=>null,base:()=>'https://pay.kipurse.com',script:()=>'',onboard});
  const st2=await S2.start({x:'0x'+'1'.repeat(64),y:'0x'+'2'.repeat(64),setup:{single:'1',daily:'5',term:'20',days:'90'}});const m2=S2.message(st2.id,a.address).message;
  const r2=await S2.verify(st2.id,{address:a.address,message:m2,signature:'0x01'});assert.equal(r2.result,'bind');assert.equal(r2.setup,null);assert.equal(bound.length,1);});
