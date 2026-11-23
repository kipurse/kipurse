// t1268 (handbook §6#133, locked rule 0A #2): no Face ID at sign-in. An unproven "bind" stays provable for the read-grant lifetime (30 d),
// so the app can prove with the Face ID of the first action that needs it; everything else keeps the short TTL.
import test from 'node:test';import assert from 'node:assert/strict';import {verifyMessage} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {createSignin} from '../src/v5/signin.mjs';
const W='0x00000000000000000000000000000000000000A1';const PH={x:'0x01',y:'0x02',approver:'0x00000000000000000000000000000000000000B2'};
function setup(owner){const ttl=new Map(),m=new Map();const kv={put:(k,v,t)=>{m.set(k,v);ttl.set(k,t);},get:k=>m.get(k),take:k=>{const v=m.get(k);m.delete(k);return v;},del:k=>m.delete(k)};
  const reg={byOwner:o=>o.toLowerCase()===owner.toLowerCase()?[{wallet:W,publicPath:'/t/'+W.toLowerCase()}]:[]};
  const S=createSignin({kv,pub:{verifyMessage:a=>verifyMessage(a),readContract:async()=>true},reg,obs:{log:()=>{}},base:()=>'https://pay.kipurse.com',phoneOf:async()=>PH,script:()=>''});return {S,ttl};}
const go=async(S,a,body)=>{const st=S.start(body);const {message}=S.message(st.id,a.address);const r=await S.verify(st.id,{address:a.address,message,signature:await a.signMessage({message})});return {st,r};};
test('unproven bind is kept 30 days (provable later); reconnect keeps the short TTL',async()=>{
  const a=privateKeyToAccount(generatePrivateKey());const {S,ttl}=setup(a.address);
  const {st,r}=await go(S,a,{x:'0x09',y:'0x02'});assert.equal(r.result,'bind');
  const k=[...ttl.keys()].find(x=>x.includes(st.id));assert.equal(ttl.get(k),30*24*3600e3);
  const b=await go(S,a,{x:PH.x,y:PH.y});assert.equal(b.r.result,'reconnect');const k2=[...ttl.keys()].find(x=>x.includes(b.st.id));assert.equal(ttl.get(k2),10*60e3);});
