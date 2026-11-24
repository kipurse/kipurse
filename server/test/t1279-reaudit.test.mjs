// SPDX-License-Identifier: AGPL-3.0-only
// t1279 (handbook §6#139): regressions for the re-audit findings R1, R3, R4, R5, R7 (each test failed on the code before the fix).
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {zeroAddress,HttpRequestError} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {engineFor,ADAPTER,MERCH} from './helpers/v5-fixture.mjs';import {detect} from '../src/v4/detector.mjs';
import {createObs} from '../src/v5/obs.mjs';import {createOAuth} from '../kit/oauth.mjs';
import {createSignin,siweMessage} from '../src/v5/signin.mjs';import {createMemoryKV,kvKey} from '../src/v5/store.mjs';import {kvUserParts} from '../src/v5/user-data.mjs';
import {createV5Mcp} from '../src/v5/mcp.mjs';import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

const PAYEE='0x0000000000000000000000000000000000127801';
const T={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},{name:'adapter',type:'address'},{name:'payer',type:'address'}]};
async function order(acct,payer,i){const msg={payee:PAYEE,amount:500000n,orderId:'0x'+String(i).padStart(64,'0'),deadline:BigInt(Math.floor(Date.now()/1000)+3600),chainId:84532n,adapter:ADAPTER,payer};
  const signature=await acct.signTypedData({domain:{name:'AgentWalletPaymentOrder',version:'5',chainId:84532,verifyingContract:ADAPTER},types:T,primaryType:'PaymentOrder',message:msg});
  return {signedOrder:{version:'kipurse.signed-order.v1',payee:PAYEE,amount:'500000',orderId:msg.orderId,deadline:String(msg.deadline),chainId:'84532',adapter:ADAPTER,signer:acct.address,signature,payer}};}

test('R1: an AI-supplied "__normalized" request is refused, nothing is written on chain',async()=>{
  const acct=privateKeyToAccount(generatePrivateKey());const e=engineFor({},{trusted:{[PAYEE.toLowerCase()]:true}});const rd=e.client.read;
  e.client.read=async(fn,args)=>fn==='trustedSigner'&&String(args[1]).toLowerCase()===acct.address.toLowerCase()?[MERCH,1n]:rd(fn,args);
  const o=await order(acct,zeroAddress,7);const n=detect(o,{chains:[84532]});n.signedOrder.signer=acct.address;n.amount=1n;
  const j=JSON.parse(JSON.stringify({__normalized:n},(k,v)=>typeof v==='bigint'?v.toString():v));
  const w0=e.s.writes.length;
  const r=await e.engine.pay({agentId:'a1',request:j,idempotencyKey:'idem-t1279-r1-0001'});
  assert.equal(r.state,'rejected');assert.equal(r.reason,'bad_request');
  const r2=await e.engine.pay({agentId:'a1',request:{__normalized:{ok:true,mode:'direct',standard:'erc20',payee:PAYEE,amount:'1',chainId:84532,merchantOrderId:'x1'}},idempotencyKey:'idem-t1279-r1-0002'});
  assert.equal(r2.state,'rejected');assert.equal(r2.reason,'bad_request');
  const pf=await e.engine.preflight(j,{agentId:'a1'});assert.equal(pf.canPay,false);
  assert.equal(e.s.writes.length,w0,'no chain write');});

test('R3: an MCP tool error never carries the raw upstream message (RPC URL with key)',async()=>{
  const err=()=>{throw new HttpRequestError({url:'https://base-mainnet.example/v2/SECRETKEY',body:{method:'eth_call'},status:500});};
  const engine=new Proxy({},{get:(t,k)=>k==='then'?undefined:async()=>err()});
  const s=createV5Mcp(engine,{agentId:'a1'});const srv=s.server??s;const [a,b]=InMemoryTransport.createLinkedPair();await srv.connect(b);
  const c=new Client({name:'t',version:'1'});await c.connect(a);
  const r=await c.callTool({name:'kipurse_set_limits',arguments:{changes:{single:'1'}}});const t=JSON.stringify(r);
  assert.ok(!/SECRETKEY|https?:\/\//.test(t),t.slice(0,300));assert.match(t,/internal_error/);await c.close();});

test('R4: an outside flood cannot evict a client whose consent request is open',async()=>{
  const S={};const OA=createOAuth({S,save:()=>{},base:()=>'https://k.example',createAgentKey:()=>({}),isAgentLive:()=>true,caps:{},ownerSession:()=>false,maxClients:30,maxClientsPerIp:20});
  async function call(method,path,body,ip){const out={};const req={method,url:path,headers:{}};const res={writeHead(c,h){out.c=c;out.h=h;},end(b){out.b=b;},setHeader(){}};
    await OA.handle(req,res,new URL(path,'https://k.example'),{readBody:async()=>body,ip});try{out.j=JSON.parse(out.b);}catch{}return out;}
  const realNow=Date.now;let off=0;Date.now=()=>realNow()+off;
  try{const r=await call('POST','/oauth/register',{redirect_uris:['https://claude.ai/cb'],client_name:'Claude'},'1.1.1.1');const cid=r.j.client_id;off+=11*60e3;
    const a=await call('GET',`/oauth/authorize?client_id=${cid}&redirect_uri=${encodeURIComponent('https://claude.ai/cb')}&response_type=code&code_challenge_method=S256&code_challenge=${'a'.repeat(43)}`,null,'1.1.1.1');assert.equal(a.c,200);
    for(let i=0;i<40;i++)await call('POST','/oauth/register',{redirect_uris:['https://evil.example/cb']},'9.9.9.'+(i%5));
    assert.ok(S.oauth.clients[cid],'legit client kept');assert.equal(Object.values(S.oauth.pending).filter(p=>p.client_id===cid).length,1);
    assert.ok(Object.keys(S.oauth.clients).length<=30,'cap still holds');}
  finally{Date.now=realNow;}});

test('R5: erase still finds a 30-day sign-in record after a later short sign-in',async()=>{
  let Tm=1e12;const now=()=>Tm;const kv=createMemoryKV({now});const W='0x1111111111111111111111111111111111111111',A='0x2222222222222222222222222222222222222222';
  let phone=null;const reg={byOwner:()=>[{wallet:W}],get:()=>({wallet:W})};
  const S=createSignin({kv,now,reg,pub:{verifyMessage:async()=>true,readContract:async()=>true},phoneOf:async()=>phone,base:()=>'https://k.example',script:()=>'x',onboard:null});
  async function run(x,y){const s=await S.start({x,y});const m=siweMessage({domain:'k.example',uri:'https://k.example',address:A,chainId:8453,nonce:s.nonce,issuedAt:new Date(Tm).toISOString(),statement:s.statement});
    await S.verify(s.id,{address:A,message:m,signature:'0xabcd'});return s;}
  const a=await run('0x'+'01'.repeat(32),'0x'+'02'.repeat(32));phone={x:'0x'+'03'.repeat(32),y:'0x'+'04'.repeat(32),approver:A};
  Tm+=60e3;await run(phone.x,phone.y);Tm+=11*60e3;
  assert.ok(kv.get(kvKey('signin',null,a.id)),'30-day record exists before erase');
  for(const p of kvUserParts(kv))await p.forget(W);
  assert.equal(kv.get(kvKey('signin',null,a.id)),undefined,'erased');});

test('R7: an aborted request keeps its backpressure slot until its handler finishes',async()=>{
  const O=createObs({out:()=>{}});const srv=http.createServer(O.wrap(async(req,res)=>{await new Promise(r=>setTimeout(r,200));res.end('x');}));
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const port=srv.address().port;
  for(let i=0;i<5;i++){const q=http.get({port,host:'127.0.0.1',path:'/'});q.on('error',()=>{});setTimeout(()=>q.destroy(),50);}
  await new Promise(r=>setTimeout(r,120));assert.equal(O.inflight(),5,'still counted while running');
  await new Promise(r=>setTimeout(r,400));assert.equal(O.inflight(),0,'freed after the handlers settled');
  await new Promise(r=>http.get({port,host:'127.0.0.1',path:'/'},res=>{res.resume();res.on('end',r);}));await new Promise(r=>setTimeout(r,50));assert.equal(O.inflight(),0);
  await new Promise(r=>srv.close(r));});
