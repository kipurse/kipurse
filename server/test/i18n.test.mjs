// Owner rule: ONE language per page. English (any non-Chinese client) -> zero CJK characters; Chinese -> no "中文 / English" duplicates.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {langOf,localizeJSON,withLang,CJK} from '../src/v5/i18n.mjs';
import {createDeposit} from '../src/v5/deposit.mjs';import {createNewWalletOnboarding} from '../src/v5/onboard-new.mjs';
import {createPublicLimits,LIMITS_DONE_JS} from '../src/v5/limits-public.mjs';import {createOwnerWithdraw} from '../src/v5/owner-withdraw.mjs';
import {createSignin} from '../src/v5/signin.mjs';
const CJK_ALL=/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/g;
const visible=h=>String(h).replace(/<script[\s\S]*?<\/script>/g,'').replace(/<style[\s\S]*?<\/style>/g,'').replace(/<[^>]+>/g,' ');
const noCJK=(h,what)=>{const m=visible(h).match(CJK_ALL);assert.equal(m,null,`${what}: CJK in English render: ${m?.slice(0,20).join('')}`);
  const attrs=[...String(h).matchAll(/(?:placeholder|title|aria-label)="([^"]*)"/g)].map(x=>x[1]).join(' ');assert.doesNotMatch(attrs,CJK,`${what}: CJK in attributes`);};
// zh: no English sentence duplicated next to Chinese ("中文 / English ..."). Allowed: names like Base Account, Face ID, USDC, Coinbase.
const noBilingual=(h,what)=>{const v=visible(h).replace(/BASE MAINNET|Base Account|Face ID|Coinbase|Kipurse|USDC|Siri|App|iPhone|ETH|Base|MCP|AI/g,'');
  assert.doesNotMatch(v,/[A-Za-z]{2,}[ ,][a-z]{2,} [a-z]{2,}/,`${what}: English sentence in Chinese render`);assert.doesNotMatch(v,/[\u3400-\u9fff][^<]{0,80}\/ [A-Z][a-z]/,`${what}: "zh / en" pair`);
  assert.match(visible(h),/[\u3400-\u9fff]/,`${what}: zh render should be Chinese`);};
const both=async(render,what)=>{const en=await render('en'),zh=await render('zh');noCJK(en,what+' en');noBilingual(zh,what+' zh');assert.match(en,/<html lang=en>/);assert.match(zh,/<html lang=zh>/);};
const W='0x1000000000000000000000000000000000000004',O='0x2000000000000000000000000000000000000002',T='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',F='0xc0dedd749573f2e967a4ba53190c27ffbc2f8b31';
const get=async(M,path,lang,extra={})=>{let b='';await M.handle({method:'GET',headers:{'accept-language':lang==='zh'?'zh-CN':'en-US'}},{writeHead(){},setHeader(){},end(x){b=String(x);}},new URL('https://x'+path),{readBody:async()=>({}),ip:'1',...extra});return b;};

test('langOf: ?lang wins, then x-kp-lang, then Accept-Language; default English',()=>{
  assert.equal(langOf({url:'/a?lang=zh',headers:{'accept-language':'en'}}),'zh');assert.equal(langOf({url:'/a?lang=en',headers:{'accept-language':'zh-CN'}}),'en');
  assert.equal(langOf({url:'/a',headers:{'x-kp-lang':'zh'}}),'zh');assert.equal(langOf({url:'/a',headers:{'accept-language':'zh-Hans-CN,zh;q=0.9'}}),'zh');
  assert.equal(langOf({url:'/a',headers:{'accept-language':'fr-FR'}}),'en');assert.equal(langOf({url:'/a',headers:{}}),'en');});
test('JSON replies: English has no CJK (known text translated, unknown -> generic); Chinese drops the English half',()=>{
  const o={error:'x',detail:'钱包已暂停，先在 App 里恢复再付。',summary:'创建你的启付钱包 / Create your Kipurse wallet',n:[{m:'某个新的中文提示'}],zh:'AI 付款 1 给 你'};
  const en=localizeJSON('en',o);assert.doesNotMatch(JSON.stringify({...en,zh:''}),CJK);assert.equal(en.detail,'The wallet is paused. Resume it in the app first.');assert.equal(en.zh,o.zh);
  const zh=localizeJSON('zh',o);assert.equal(zh.summary,'创建你的启付钱包');});
test('withLang leaves the agent API (/mcp, /v1) untouched',async()=>{let out;const h=withLang((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{"text":"中文"}');});
  await h({url:'/mcp',headers:{}},{writeHead(){},end(b){out=b;},getHeader(){}});assert.equal(out,'{"text":"中文"}');});
test('deposit page: single language',()=>both(l=>get(createDeposit({reg:{get:()=>({wallet:W,owner:O})},token:T,script:()=>''}),'/deposit?w='+W,l),'deposit'));
test('onboard/new page (sponsored + user-paid): single language',async()=>{
  const rec={x:'0x'+'1'.repeat(64),y:'0x'+'2'.repeat(64),expect:O,choice:{single:'5000000',daily:'50000000',term:'500000000',days:90},state:'start'};
  for(const sponsor of [{enabled:true,available:()=>true},null]){const N=createNewWalletOnboarding({enabled:true,kv:{get:()=>rec,put(){}},reg:{byOwner:()=>[]},base:()=>'https://x',script:()=>'',sponsor,quote:async()=>({})});
    await both(l=>get(N,'/onboard/new?id=a',l),'onboard-new');await both(l=>get(createNewWalletOnboarding({enabled:true,kv:{get:()=>null,put(){}},reg:{byOwner:()=>[]},base:()=>'https://x',script:()=>'',quote:async()=>({})}),'/onboard/new?id=a',l),'onboard-new expired');}});
test('limits page (ok + bad input): single language',async()=>{const M=()=>createPublicLimits({fee:async()=>({usdc:1n,payerUSDC:9n,canPayUSDC:true}),plan:async()=>({}),confirm:async()=>({valid:false}),current:async()=>({single:'1000000',daily:'5000000',term:'20000000',end:'1800000000'}),script:()=>'',base:()=>'http://x'});
  await both(l=>get(M(),'/owner/limits?single=10&daily=50&term=500&days=90',l),'limits');await both(l=>get(M(),'/owner/limits?single=100&daily=50&term=500',l),'limits error');});
test('withdraw page: single language',async()=>{const pub={readContract:async({functionName,args})=>functionName==='isOwnerAddress'?true:functionName==='balanceOf'?(args[0]===W?7_500_000n:0n):[0n,300000000000n,0n,0n,0n],estimateGas:async()=>60000n,getGasPrice:async()=>10_000_000n};
  await both(l=>get(createOwnerWithdraw({pub,wallet:W,owner:O,token:T,feed:F,script:()=>''}),'/owner/withdraw',l),'withdraw');
  const bad={...pub,readContract:async a=>a.functionName==='isOwnerAddress'?false:pub.readContract(a)};await both(l=>get(createOwnerWithdraw({pub:bad,wallet:W,owner:O,token:T,feed:F,script:()=>''}),'/owner/withdraw',l),'withdraw error');});
test('sign-in page (plain + new-user setup): single language',async()=>{const kv=new Map();const KV={get:k=>kv.get(k),put:(k,v)=>kv.set(k,v),del:k=>kv.delete(k)};
  const S=createSignin({kv:KV,pub:{},reg:{byOwner:()=>[]},phoneOf:async()=>null,base:()=>'https://pay.kipurse.com',script:()=>'',onboard:{start:async()=>({id:'b'.repeat(32)}),bindOwner:()=>false,sponsorable:()=>false,status:()=>null}});
  const a=await S.start({});const id=a.id??new URL(a.url).searchParams.get('id');await both(l=>get(S,'/signin?id='+id,l),'signin');await both(l=>get(S,'/signin?id=zz',l),'signin expired');});
test('done/pending overlay script: every Chinese line has an English twin',()=>{const lits=[...LIMITS_DONE_JS.matchAll(/'([^'\n]*)'/g)].map(m=>m[1]).filter(s=>CJK.test(s));
  for(const s of lits)assert.ok(LIMITS_DONE_JS.includes(`L('${s}',`),`not localized: ${s}`);});
test('browser scripts: every Chinese literal is the zh branch of a language switch',()=>{
  const dir=new URL('../owner-sign/static/',import.meta.url);const U=s=>s.replace(/\\u([0-9A-Fa-f]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
  for(const f of ['signin.js','deposit.js','onboard-new.js','onboard.js','limits.js','phone-enroll.js','withdraw.js','approve-trust.js','consent.js']){const s=fs.readFileSync(new URL(f,dir),'utf8');
    const bad=[];for(const m of s.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)){const t=U(m[1]);if(!CJK.test(t))continue;const pre=s.slice(Math.max(0,m.index-3),m.index);if(!(pre.endsWith(':')||/[A-Za-z_$]\($/.test(pre)))bad.push(t);}
    assert.deepEqual(bad.filter(b=>!/^[\s（）。，、]*$/.test(b)||false),[],f);}});
