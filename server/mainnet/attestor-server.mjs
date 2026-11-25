#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// t1241 (decision 111 (5)): the Kipurse ATTESTOR service ("[zh]"). A SEPARATE process under its own system user (kipurse-attestor):
// it alone can read its key dir (0700) and its at-rest data key (0400). The gateway talks to it over a unix socket (group-writable for the
// gateway's group only). It holds ONE secp256k1 key per merchant domain and signs a V5.4 PaymentOrder only after its own checks
// (src/v5/attestor.mjs createAttestor: independent re-read of the order on the merchant's https origin, published-signer evidence,
// pause list, chain / adapter / ceiling / rate limit). It never sends transactions and never sees the wallet's keys.
// Env:
//   KIPURSE_ATTESTOR_KEY_DIR        default /var/lib/kipurse-attestor/keys
//   KIPURSE_ATTESTOR_DATA_KEY_FILE  required (64 hex chars, mode 0400/0600, owned by kipurse-attestor)
//   KIPURSE_ATTESTOR_SOCKET         default /run/kipurse-attestor/attestor.sock (mode 0660)
//   KIPURSE_ATTESTOR_ADAPTERS       comma list of V5.4 adapter addresses it may sign for (required)
//   KIPURSE_ATTESTOR_CHAIN_ID       default 8453
//   KIPURSE_ATTESTOR_MAX_ATOMIC     hard per-order ceiling (default 1000000000 = 1000 USDC)
//   KIPURSE_ATTESTOR_MAX_PER_HOUR   attests per domain per hour (default 60)
import http from 'node:http';import fs from 'node:fs';import {dirname} from 'node:path';
const G=new URL('../',import.meta.url).pathname;
const {createAttestor}=await import(G+'src/v5/attestor.mjs');const {loadDataKey}=await import(G+'src/v5/at-rest.mjs');
const USDC_OF={8453:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',84532:'0x036CbD53842c5426634e7929541eC2318f3dCF7e'};
export function attestorHandler(A){const MAX=64*1024;
  return async(req,res)=>{const j=(c,o)=>{res.writeHead(c,{'content-type':'application/json'});res.end(JSON.stringify(o));};
    if(req.method!=='POST')return j(405,{ok:false,code:'method'});let raw='';for await(const c of req){raw+=c;if(raw.length>MAX)return j(413,{ok:false,code:'too_large'});}
    let b;try{b=JSON.parse(raw||'{}');}catch{return j(400,{ok:false,code:'bad_json'});}
    try{switch(req.url){
      case '/address':return j(200,{ok:true,address:await A.address(String(b.domain??''))});
      case '/attest':return j(200,await A.attest(b));
      case '/pause':return j(200,await A.pause(String(b.domain??''),String(b.reason??'paused')));
      case '/resume':return j(200,await A.resume(String(b.domain??'')));
      case '/paused':return j(200,{ok:true,paused:await A.paused(String(b.domain??''))});
      case '/list':return j(200,{ok:true,...(await A.list())});
      default:return j(404,{ok:false,code:'not_found'});}}
    catch(e){return j(400,{ok:false,code:e?.code??'error'});}};}
export async function startAttestorServer({env=process.env,attestor,socket}={}){
  const A=attestor??createAttestor({keyDir:env.KIPURSE_ATTESTOR_KEY_DIR??'/var/lib/kipurse-attestor/keys',dataKey:loadDataKey(env.KIPURSE_ATTESTOR_DATA_KEY_FILE),
    chainId:Number(env.KIPURSE_ATTESTOR_CHAIN_ID??8453),adapters:String(env.KIPURSE_ATTESTOR_ADAPTERS??'').split(',').map(s=>s.trim()).filter(Boolean),
    usdc:USDC_OF[Number(env.KIPURSE_ATTESTOR_CHAIN_ID??8453)]??null,maxAmountAtomic:BigInt(env.KIPURSE_ATTESTOR_MAX_ATOMIC??'1000000000'),maxPerHour:Number(env.KIPURSE_ATTESTOR_MAX_PER_HOUR??60),
    log:(k,v)=>{try{console.log(JSON.stringify({t:new Date().toISOString(),event:k,...v}));}catch{}}});
  const sock=socket??env.KIPURSE_ATTESTOR_SOCKET??'/run/kipurse-attestor/attestor.sock';
  try{fs.mkdirSync(dirname(sock),{recursive:true,mode:0o750});}catch{}try{fs.unlinkSync(sock);}catch{}
  const srv=http.createServer(attestorHandler(A));srv.requestTimeout=30000;
  await new Promise((r,x)=>{srv.once('error',x);srv.listen(sock,r);});fs.chmodSync(sock,0o660);
  console.log(JSON.stringify({event:'attestor_listening',socket:sock}));return {srv,attestor:A,close:()=>new Promise(r=>srv.close(r))};}
if(import.meta.url===`file://${process.argv[1]}`){
  if(!process.env.KIPURSE_ATTESTOR_DATA_KEY_FILE){console.error('KIPURSE_ATTESTOR_DATA_KEY_FILE is required');process.exit(2);}
  if(!process.env.KIPURSE_ATTESTOR_ADAPTERS){console.error('KIPURSE_ATTESTOR_ADAPTERS is required');process.exit(2);}
  const s=await startAttestorServer();const stop=()=>{s.close().then(()=>process.exit(0));};process.on('SIGTERM',stop);process.on('SIGINT',stop);}
