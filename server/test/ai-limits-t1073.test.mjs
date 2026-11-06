// t1073: unset AI total limits authorize nothing. The Muse approval page must not treat chain caps
// or a 10/50/200 placeholder as the owner's confirmation. Isolated mocks only — no network, no keys.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createOAuth} from '../kit/oauth.mjs';
import {createEverydayLimits,consentSpend} from '../src/v5/everyday-limits.mjs';
import {engineFor} from './helpers/v5-fixture.mjs';

const CHAIN_CAPS=()=>({perPayment:'10',perDay:'50',termTotal:'200'});
const FLOOR={single:10_000_000n,daily:50_000_000n,term:200_000_000n};

function oauth({spend,verify=async()=>true,lang='zh-CN',phone=false}={}){const S={},agents=[];
  const O=createOAuth({S,save:()=>{},base:()=>'https://pay.kipurse.com',network:'main',wallet:'0x1000000000000000000000000000000000000001',ownerAddress:'0x2222',
    verifyOwner:verify,createAgentKey:(n,k)=>{agents.push(k);return k;},isAgentLive:()=>true,caps:CHAIN_CAPS,ownerSession:()=>null,spendAuthorization:spend,
    ...(phone?{phoneApprover:{active:()=>null,onChain:async()=>false,verify:()=>false}}:{}),consentScript:()=>''});
  const call=async(path,body,method='POST',headers={})=>{let out,code,hdr;const res={writeHead(c,h){code=c;hdr=h;},end(b){out=b;}};
    await O.handle({method,headers:{'accept-language':lang,...headers}},res,new URL('https://pay.kipurse.com'+path),{readBody:async()=>body??{},ip:'203.0.113.5'});
    const json=hdr?.['content-type']?.includes('json');return {code,out:json?JSON.parse(out):out,hdr};};
  return {S,O,agents,call};}
async function open(t,name='Muse',redirect='https://agent.meta.ai/oauth/callback'){const r=await t.call('/oauth/register',{client_name:name,redirect_uris:[redirect]});
  const cid=r.out.client_id;const q=`/oauth/authorize?response_type=code&client_id=${cid}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${'C'.repeat(43)}&code_challenge_method=S256&state=muse1&single=10&daily=50&term=200`;
  const page=await t.call(q,null,'GET');const id=Object.keys(t.S.oauth.pending).find(k=>t.S.oauth.pending[k].client_id===cid);return {cid,id,page:page.out};}
const noDefaults=html=>{assert.doesNotMatch(html,/>10 USDC<|>\$10</);assert.doesNotMatch(html,/>50 USDC<|>\$50</);assert.doesNotMatch(html,/>200 USDC<|>\$200</);};

test('Muse approval with chain caps 10/50/200 shows blanks and grants nothing',async()=>{
  const t=oauth({spend:()=>({authorized:false})});const {id,page}=await open(t);
  assert.match(page,/Muse 想连接你的 Kipurse 钱包/);assert.match(page,/agent\.meta\.ai/);assert.match(page,/用我的 Base Account 批准（Face ID）/);
  assert.match(page,/>上限</);noDefaults(page);assert.match(page,/<span class=n><\/span>/);
  const d=await t.call('/oauth/owner-decide',{req:id,approve:true,signature:'0xabc',perPayment:'10',perDay:'50',termTotal:'200',confirmed:true});
  assert.equal(d.code,403);assert.equal(d.out.error,'ai_limits_unconfirmed');assert.equal(t.agents.length,0);assert.equal(t.S.oauth.pending[id].status,'pending');
  const deny=await t.call('/oauth/owner-decide',{req:id,approve:false});assert.equal(deny.code,200);assert.match(deny.out.redirect,/access_denied/);assert.equal(t.S.oauth.pending[id].status,'denied');assert.equal(t.agents.length,0);});

test('English approval is blank too, and a bad signature grants nothing',async()=>{
  const t=oauth({spend:()=>({authorized:false}),verify:async()=>false,lang:'en-US'});const {id,page}=await open(t);
  assert.match(page,/wants to connect to your Kipurse wallet/);assert.match(page,/Approve with my Base Account \(Face ID\)/);noDefaults(page);
  const d=await t.call('/oauth/owner-decide',{req:id,approve:true,signature:'0xno'});assert.equal(d.code,403);assert.equal(d.out.error,'not_owner');assert.equal(t.agents.length,0);assert.equal(t.S.oauth.pending[id].status,'pending');});

test('explicit limits are shown exactly and reused for a second AI; client amounts are ignored',async()=>{
  const m=new Map();const ev=createEverydayLimits({kv:{get:k=>m.get(k),set:(k,v)=>m.set(k,v),del:k=>m.delete(k)},wallet:'0xabc',floor:()=>FLOOR,now:()=>1700000000000});
  assert.equal(ev.set({single:'2000000',daily:'5000000',term:'30000000'}).authorized,true);
  const t=oauth({spend:()=>consentSpend(ev.get())});const first=await open(t);const second=await open(t,'Claude','https://claude.ai/api/mcp/auth_callback');
  for(const page of [first.page,second.page]){assert.match(page,/>2 USDC</);assert.match(page,/>5 USDC</);assert.match(page,/>30 USDC</);noDefaults(page);}
  const d=await t.call('/oauth/owner-decide',{req:first.id,approve:true,signature:'0xok',perPayment:'10',perDay:'50',termTotal:'200'});
  assert.equal(d.code,200);assert.equal(d.out.redirect.includes('code='),true);assert.deepEqual(t.agents,['muse']);
  assert.equal(t.S.oauth.pending[first.id].aiLimits.perPayment,'2');assert.equal(t.S.oauth.pending[first.id].aiLimits.termTotal,'30');
  const en=oauth({spend:()=>consentSpend(ev.get()),lang:'en-US'});const shown=await open(en);
  assert.match(shown.page,/>\$2</);assert.match(shown.page,/>\$5</);assert.match(shown.page,/>\$30</);noDefaults(shown.page);});

test('limits changed after the page was shown cannot authorize the stale amounts',async()=>{
  let view={authorized:true,perPayment:'2',perDay:'5',termTotal:'30',at:1};
  const t=oauth({spend:()=>view});const {id}=await open(t);view={authorized:true,perPayment:'10',perDay:'50',termTotal:'200',at:2};
  const d=await t.call('/oauth/owner-decide',{req:id,approve:true,signature:'0xok'});
  assert.equal(d.code,403);assert.equal(d.out.error,'ai_limits_stale');assert.equal(t.agents.length,0);assert.equal(t.S.oauth.pending[id].status,'pending');
  const again=await open(t);assert.match(again.page,/>10 USDC</);assert.match(again.page,/>50 USDC</);assert.match(again.page,/>200 USDC</);
  const ok=await t.call('/oauth/owner-decide',{req:again.id,approve:true,signature:'0xok'});assert.equal(ok.code,200);assert.deepEqual(t.agents,['muse']);});

test('a blank page does not become approved after limits are saved; a new page does',async()=>{
  let view={authorized:false};const t=oauth({spend:()=>view});const old=await open(t);noDefaults(old.page);
  view={authorized:true,perPayment:'2',perDay:'5',termTotal:'9',at:3};
  const stuck=await t.call('/oauth/owner-decide',{req:old.id,approve:true,signature:'0xok'});
  assert.equal(stuck.code,403);assert.equal(stuck.out.error,'ai_limits_stale');assert.equal(t.agents.length,0);
  const fresh=await open(t);assert.match(fresh.page,/>2 USDC</);assert.match(fresh.page,/>9 USDC</);
  assert.equal((await t.call('/oauth/owner-decide',{req:fresh.id,approve:true,signature:'0xok'})).code,200);assert.deepEqual(t.agents,['muse']);});

test('mainnet without a spend callback fails closed even if caps() is 10/50/200',async()=>{
  const t=oauth({spend:undefined});const {id,page}=await open(t);noDefaults(page);
  const d=await t.call('/oauth/owner-decide',{req:id,approve:true,signature:'0xok'});assert.equal(d.code,403);assert.equal(d.out.error,'ai_limits_unconfirmed');assert.equal(t.agents.length,0);});

test('tampered snapshot on the pending request does not restore 10/50/200',async()=>{
  const t=oauth({spend:()=>({authorized:true,perPayment:'2',perDay:'5',termTotal:'30',at:1})});const {id}=await open(t);
  t.S.oauth.pending[id].aiLimits={perPayment:'10',perDay:'50',termTotal:'200',at:1};
  const d=await t.call('/oauth/owner-decide',{req:id,approve:true,signature:'0xok'});assert.equal(d.code,403);assert.equal(d.out.error,'ai_limits_stale');assert.equal(t.agents.length,0);});

test('float funding is refused while AI limits are unconfirmed',async()=>{
  const m=new Map();const ev=createEverydayLimits({kv:{get:k=>m.get(k),set:(k,v)=>m.set(k,v),del:k=>m.delete(k)},wallet:'0xabc',floor:()=>FLOOR});
  const {engine}=engineFor({everydayCheck:a=>ev.check(a),everydayGet:()=>ev.get()});
  const r=await engine.floatFund({amount:'1000000'});assert.equal(r.state,'rejected');assert.equal(r.reason,'AI_LIMITS_UNCONFIRMED');assert.equal(r.nothingPaid,true);
  ev.set({single:'3000000',daily:'4000000',term:'100000000'});
  const over=await engine.floatFund({amount:'5000000'});assert.equal(over.reason,'EVERYDAY_DAILY_LIMIT');});

test('a saved AI policy that is not 10/50/200 is what the Muse page shows',async()=>{
  const floor={single:10_000_000n,daily:50_000_000n,term:200_000_000n};
  const m=new Map();const ev=createEverydayLimits({kv:{get:k=>m.get(k),set:(k,v)=>m.set(k,v),del:k=>m.delete(k)},wallet:'0xabc',floor:()=>floor,now:()=>1710000000000});
  const key='everyday:global:0xabc';m.set(key,{single:'2500000',daily:'7000000',term:'15000000',at:1710000000000});
  const view=ev.get();assert.equal(view.requestedSingle,'2500000');assert.equal(view.requestedTerm,'15000000');assert.notEqual(view.requestedSingle,floor.single.toString());
  const t=oauth({spend:()=>consentSpend(view)});const {id,page}=await open(t);
  assert.match(page,/>2\.5 USDC</);assert.match(page,/>7 USDC</);assert.match(page,/>15 USDC</);noDefaults(page);
  assert.equal((await t.call('/oauth/owner-decide',{req:id,approve:true,signature:'0xok',perPayment:'10',perDay:'50',termTotal:'200'})).code,200);
  assert.equal(t.S.oauth.pending[id].aiLimits.perPayment,'2.5');assert.equal(t.S.oauth.pending[id].aiLimits.termTotal,'15');
  const appShaped=createEverydayLimits({kv:{get:k=>m.get(k),set:(k,v)=>m.set(k,v),del:k=>m.delete(k)},wallet:'0xabc',floor:()=>floor});
  m.set(key,{single:'2500000',daily:'7000000',at:'1710000000000'});
  const partial=consentSpend(appShaped.get());assert.equal(partial.authorized,false);
  const t2=oauth({spend:()=>partial});const blankTerm=await open(t2);noDefaults(blankTerm.page);
  assert.equal((await t2.call('/oauth/owner-decide',{req:blankTerm.id,approve:true,signature:'0xok'})).code,403);assert.equal(t2.agents.length,0);});
test('production launch wires consent to explicit AI limits, not chain caps',()=>{
  const src=readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(src,/spendAuthorization:\(\)=>\{try\{return consentSpend\(EVD\.get\(\)\);\}catch\{return \{authorized:false\};\}/);
  assert.match(src,/cfg\.everydayCheck=a=>EVD\.check/);
  assert.doesNotMatch(src,/perPayment:f\(p\.single\),perDay:f\(p\.daily\),termTotal:f\(p\.term\)/);});
