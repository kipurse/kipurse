// SPDX-License-Identifier: AGPL-3.0-only
// t1278 S7: an unauthenticated outsider could fill a wallet's client and open-request caps (DCR / authorize / first-connect), and an open
// request made its client unevictable. Now: per-IP caps (salted IP hash, never the IP), the oldest entry makes room instead of a refusal,
// and only a code / token keeps a client.
import test from 'node:test';import assert from 'node:assert/strict';import {createOAuth} from '../kit/oauth.mjs';
const mk=(o={})=>{const S={};const OA=createOAuth({S,save(){},base:()=>'https://x',createAgentKey:()=>'a',isAgentLive:()=>true,ownerSession:()=>null,...o});return {S,OA};};
const call=async(OA,method,url,body={},ip='9.9.9.9')=>{let code,b;await OA.handle({method,headers:{}},{writeHead(c){code=c;},end(x){b=x;}},new URL('https://x'+url),{readBody:async()=>body,ip});try{b=JSON.parse(b);}catch{}return {code,b};};
const reg=(OA,ip,name='c')=>call(OA,'POST','/oauth/register',{client_name:name,redirect_uris:['https://cb.example/cb']},ip);
const auth=(OA,cid,ip)=>call(OA,'GET',`/oauth/authorize?client_id=${cid}&redirect_uri=${encodeURIComponent('https://cb.example/cb')}&response_type=code&code_challenge_method=S256&code_challenge=${'a'.repeat(43)}&state=s`,{},ip);

test('t1278 S7: one source cannot hold more than maxClientsPerIp clients; its own oldest makes room; other sources keep theirs; no raw IP stored',async()=>{
  const {S,OA}=mk({maxClientsPerIp:3,maxClients:50});const mine=(await reg(OA,'198.51.100.7','owner-app')).b.client_id;
  const flood=[];for(let i=0;i<6;i++){const r=await reg(OA,'203.0.113.9','x'+i);assert.equal(r.code,201);flood.push(r.b.client_id);}
  assert.equal(Object.values(S.oauth.clients).filter(c=>c.name.startsWith('x')).length,3,'capped per source');assert.ok(S.oauth.clients[mine],'another source untouched');
  assert.ok(!S.oauth.clients[flood[0]]&&S.oauth.clients[flood[5]],'oldest of that source evicted');assert.ok(!JSON.stringify(S).includes('203.0.113.9'),'no raw IP');});

test('t1278 S7: at the wallet cap the busiest source pays first; a client with a token is never evicted; all used -> 429',async()=>{
  const {S,OA}=mk({maxClientsPerIp:100,maxClients:4});const mine=(await reg(OA,'198.51.100.7','owner-app')).b.client_id;
  for(let i=0;i<10;i++)assert.equal((await reg(OA,'203.0.113.9','x'+i)).code,201);
  assert.ok(S.oauth.clients[mine],'the single client of a quiet source survives the flood');assert.equal(Object.keys(S.oauth.clients).length,4);
  const {S:S2,OA:O2}=mk({maxClients:2});const a=(await reg(O2,'1.1.1.1')).b.client_id,b=(await reg(O2,'2.2.2.2')).b.client_id;
  S2.oauth.tokens.t1={type:'access',client_id:a,exp:Date.now()/1000+600};S2.oauth.tokens.t2={type:'access',client_id:b,exp:Date.now()/1000+600};
  const r=await reg(O2,'3.3.3.3');assert.equal(r.code,429);assert.equal(r.b.error,'too_many_clients');assert.ok(S2.oauth.clients[a]&&S2.oauth.clients[b]);});

test('t1278 S7: open requests never pin a client; per-source and wallet request caps drop the oldest instead of refusing',async()=>{
  const {S,OA}=mk({maxClientsPerIp:100,maxClients:2,maxPendingPerIp:2,maxPending:3});
  const c1=(await reg(OA,'1.1.1.1')).b.client_id;assert.notEqual((await auth(OA,c1,'1.1.1.1')).code,429);
  assert.ok(Object.values(S.oauth.pending).some(p=>p.client_id===c1));const c2=(await reg(OA,'2.2.2.2')).b.client_id;
  const c3=await reg(OA,'3.3.3.3');assert.equal(c3.code,201,'a client with only an open request is evictable');assert.ok(!S.oauth.clients[c1]);
  assert.ok(!Object.values(S.oauth.pending).some(p=>p.client_id===c1),'its open request went with it');
  const open=()=>Object.values(S.oauth.pending).filter(p=>p.status==='pending');
  for(let i=0;i<5;i++)await auth(OA,c2,'2.2.2.2');assert.equal(open().filter(p=>p.client_id===c2).length,2,'per-source cap: oldest dropped');
  const cid3=c3.b.client_id;for(let i=0;i<2;i++)await auth(OA,cid3,'4.4.4.'+i);assert.equal(open().length,3,'wallet cap: oldest dropped, never too_many');
  const last=await auth(OA,cid3,'5.5.5.5');assert.notEqual(last.code,400);assert.equal(open().length,3);});
