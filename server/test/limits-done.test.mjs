import test from 'node:test';import assert from 'node:assert/strict';
import {LIMITS_DONE_JS,limitsDoneUrl,createPublicLimits} from '../src/v5/limits-public.mjs';
function page(){const timers=[],fetched=[];let href='';
  const mk=tag=>{const e={tag,style:{},children:[],attrs:{},textContent:'',setAttribute(k,v){this.attrs[k]=v;},appendChild(c){this.children.push(c);return c;},
    querySelector(q){return (this.q??={})[q]??=mk(q);},set innerHTML(v){this._h=v;this.q={};},get innerHTML(){return this._h;}};return e;};
  const hidden=[];const form=['#go','.b.g'].map(n=>({n,style:{}}));
  const g={document:{documentElement:{lang:'zh'},querySelectorAll:()=>form,createElement:t=>mk(t),body:mk('body')},navigator:{},setTimeout:(f,ms)=>timers.push([ms,f]),
    fetch:(u,o)=>{fetched.push([u,JSON.parse(o.body)]);return Promise.resolve({});},location:{set href(v){href=v;},get href(){return href;},reload(){}}};
  g.window=g;new Function('window','document','navigator','setTimeout','fetch','location',LIMITS_DONE_JS)(g,g.document,g.navigator,g.setTimeout,g.fetch,g.location);
  const ov=()=>g.document.body.children[0];const title=()=>ov().querySelector('#kp-title').textContent;const lines=()=>ov().querySelector('#kp-v').children.map(r=>r.textContent);
  return {g,timers,fetched,form,ov,title,lines,href:()=>href};}
const j={single:'10000000',daily:'50000000',term:'200000000',start:'1792642081',end:'1824178081'};
test('page states: 授权中 (form hidden, server told) -> 授权完成 (caps + start/end) -> kipurse://limits-updated',()=>{const P=page();
  P.g.kpPending({id:'abc',submitted:'/owner/limits/submitted'});assert.equal(P.title(),'授权中…');assert.ok(P.form.every(f=>f.style.display==='none'),'old form + 取消 hidden');
  assert.deepEqual(P.fetched,[['/owner/limits/submitted',{id:'abc'}]]);assert.match(P.ov().innerHTML,/kpSpin/);
  P.g.kpDone(j);assert.equal(P.title(),'授权完成');assert.equal(P.g.document.body.children.length,1,'same overlay, no flash of the form');
  assert.deepEqual(P.lines().slice(0,3),['每笔最多 10 USDC','每天最多 50 USDC','总额最多 200 USDC']);assert.match(P.lines()[3],/^生效时间 \d{4}-\d\d-\d\d \d\d:\d\d$/);assert.match(P.lines()[4],/^结束时间 /);
  P.timers.sort((a,b)=>a[0]-b[0])[0][1]();assert.equal(P.href(),limitsDoneUrl(j));});
test('page failure after submit: clear message + 刷新重试 + 回到 Kipurse; failure before submit leaves the form alone',()=>{
  const A=page();A.g.kpFail('user rejected');assert.equal(A.g.document.body.children.length,0,'no overlay if nothing was submitted');
  const P=page();P.g.kpPending({});P.g.kpFail();assert.equal(P.title(),'授权没有完成');const btns=P.ov().children.filter(c=>c.tag==='a').map(b=>b.textContent);assert.deepEqual(btns,['刷新重试','回到 Kipurse']);});
test('phone enroll/revoke: 授权中 -> 授权完成 -> kipurse://done?phone=…',()=>{const P=page();P.g.kpPending({});P.g.kpDoneMsg('revoke');assert.equal(P.title(),'授权完成');P.timers.sort((a,b)=>a[0]-b[0])[0][1]();assert.equal(P.href(),'kipurse://done?phone=revoked');});
test('server: submitted -> pending() for the app -> server confirms on its own (page may be closed) -> cleared; page confirm gets the cached result',async()=>{
  const raw={policy:{single:'10000000',daily:'50000000',term:'200000000'},permission:{start:100,end:100+365*86400}};let valid=false,calls=0;
  const L=createPublicLimits({fee:async()=>({usdc:1n,payerUSDC:9n,canPayUSDC:true}),base:()=>'x',current:async()=>null,pollMs:5,pollTries:40,plan:async()=>({owner:'0x1',chainId:8453,human:{},labels:[],calls:[],raw}),confirm:async()=>{calls++;return valid?{valid:true,permissionHash:'0xab'}:{valid:false};},script:()=>''});
  const call=async(path,body)=>{let out;const res={writeHead(){},end(b){out=JSON.parse(b);}};await L.handle({method:'POST'},res,new URL('http://x'+path),{readBody:async()=>body,ip:'9.9.9.'+Math.random()});return out;};
  const p=await call('/owner/limits/prepare',{single:'10000000',daily:'50000000',term:'200000000',days:365});assert.equal(L.pending(),null);
  await call('/owner/limits/submitted',{id:p.id});const pe=L.pending();assert.equal(pe.single,'10000000');assert.equal(pe.term,'200000000');assert.equal(pe.days,365);assert.equal(pe.failed,false);
  await new Promise(r=>setTimeout(r,30));assert.ok(calls>0,'server polls by itself');valid=true;await new Promise(r=>setTimeout(r,40));
  assert.equal(L.pending(),null,'cleared once on chain');const c=await call('/owner/limits/confirm',{id:p.id});assert.equal(c.ok,true);assert.equal(c.end,String(100+365*86400));});
test('server: never lands -> pending().failed so the app can show the failure',async()=>{
  const L=createPublicLimits({fee:async()=>({usdc:1n,payerUSDC:9n,canPayUSDC:true}),base:()=>'x',current:async()=>null,pollMs:2,pollTries:3,plan:async()=>({owner:'0x1',chainId:8453,human:{},labels:[],calls:[],raw:{}}),confirm:async()=>({valid:false}),script:()=>''});
  const call=async(path,body)=>{let out;const res={writeHead(){},end(b){out=JSON.parse(b);}};await L.handle({method:'POST'},res,new URL('http://x'+path),{readBody:async()=>body,ip:'8.8.8.'+Math.random()});return out;};
  const p=await call('/owner/limits/prepare',{single:'1000000',daily:'2000000',term:'3000000',days:30});await call('/owner/limits/submitted',{id:p.id});await new Promise(r=>setTimeout(r,40));assert.equal(L.pending().failed,true);});
