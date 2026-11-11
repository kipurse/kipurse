import {WHY_FEE} from '../src/v5/limits-public.mjs';
// t604u (locked): gas and fees ALWAYS in USDC, never ETH. t603u: first limits authorization free; no ETH-funded path.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {PRINCIPLES,assertPrinciples} from '../src/v5/principles.mjs';import {gasRoute,createPublicLimits} from '../src/v5/limits-public.mjs';
import {limitsChangeFee,LIMITS_CALL_GAS} from '../src/v5/limits-fee.mjs';
test('principle: gas token is USDC, no ETH path',()=>{assert.equal(PRINCIPLES.gasToken,'USDC');assert.equal(PRINCIPLES.ethGasPath,false);assert.equal(PRINCIPLES.firstLimitsFree,false);});
test('boot refuses ETH gas config',async()=>{
  for(const [o,re] of [[{env:{KIPURSE_GAS_TOKEN:'ETH'}},/gasToken/],[{env:{KIPURSE_ALLOW_ETH_GAS:'1'}},/ethGasPath/],[{env:{},cfg:{gasPricing:{token:'ETH'}}},/gasToken/]])await assert.rejects(assertPrinciples(o),re);
  assert.equal(await assertPrinciples({env:{KIPURSE_GAS_TOKEN:'USDC'}}),true);});
test('gasRoute: only sponsorship or enough Base Account USDC',()=>{assert.equal(gasRoute({pm:'u'}).route,'sponsored');assert.equal(gasRoute({pm:null,fee:{canPayUSDC:true}}).route,'usdc');
  assert.equal(gasRoute({pm:null,fee:{canPayUSDC:false}}).route,null);assert.equal(gasRoute({pm:null,fee:null}).route,null);});
test('fee quote: actual cost, 0 markup, needs 1.5x USDC headroom',()=>{const f=limitsChangeFee({callGas:200000n,gasPriceWei:10_000_000n,ethUsd8:4000_00000000n,payerUSDC:0n});
  assert.equal(f.token,'USDC');assert.equal(f.gas,350000n);assert.equal(f.wei,350000n*10_000_000n+1_000_000_000_000n);assert.equal(f.usdc,(f.wei*4000_00000000n+10n**20n-1n)/10n**20n);assert.equal(f.canPayUSDC,false);
  assert.equal(limitsChangeFee({callGas:null,gasPriceWei:1n,ethUsd8:1n,payerUSDC:1n}).gas,LIMITS_CALL_GAS+150000n);
  assert.equal(limitsChangeFee({callGas:1n,gasPriceWei:1n,ethUsd8:1n,payerUSDC:2n}).canPayUSDC,true);});
const mkLim=({pm=null,fee=null}={})=>{const confirmed=[];const L=createPublicLimits({base:()=>'https://x',current:async()=>({single:'1',daily:'5',term:'20',end:'0'}),
  plan:async()=>({owner:'0x'+'1'.repeat(40),chainId:8453,human:[],labels:[],calls:[{to:'0x'+'2'.repeat(40),value:'0x0',data:'0x1234'}],raw:{}}),confirm:async()=>({valid:true,permissionHash:'0x1'}),script:()=>'',
  sponsor:async()=>pm,fee:async()=>fee,feeQuote:async()=>({usdc:2345n,firstFree:!!pm}),onConfirmed:x=>confirmed.push(x)});return {L,confirmed};};
async function call(L,path,body,method='POST'){let code,out='';const res={writeHead:c=>{code=c;},end:s=>{out=s;}};
  await L.handle({method},res,new URL('https://x'+path),{readBody:async()=>body,ip:'1'});return {code,out,j:(()=>{try{return JSON.parse(out);}catch{return null;}})()};}
test('limits prepare: no sponsorship and not enough USDC -> 402, no calls handed out',async()=>{const {L}=mkLim({fee:{usdc:3000n,payerUSDC:0n,canPayUSDC:false}});
  const r=await call(L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});assert.equal(r.code,402);assert.equal(r.j.error,'needs_usdc_for_gas');assert.equal(r.j.calls,undefined);assert.match(r.j.detail.zh,/USDC/);assert.doesNotMatch(r.j.detail.zh+r.j.detail.en,/需要 ETH/);});
test('limits prepare: first authorization is sponsored (paymaster url) and confirm marks it used',async()=>{const {L,confirmed}=mkLim({pm:'https://x/onboard/new/paymaster?id=lim-a',fee:{usdc:3000n,payerUSDC:0n,canPayUSDC:false}});
  const r=await call(L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});assert.equal(r.code,200);assert.equal(r.j.sponsored,true);assert.ok(r.j.pm);assert.equal(r.j.gasToken,'USDC');
  const c=await call(L,'/owner/limits/confirm',{id:r.j.id});assert.equal(c.j.ok,true);assert.deepEqual(confirmed.map(x=>x.sponsored),[true]);});
test('limits prepare: later change with USDC in the Base Account -> user pays USDC, fee shown',async()=>{const {L}=mkLim({fee:{usdc:3000n,payerUSDC:10000n,canPayUSDC:true}});
  const r=await call(L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});assert.equal(r.code,200);assert.equal(r.j.sponsored,false);assert.equal(r.j.fee.usdcText,'0.003');});
test('limits page states the per-change fee in USDC and never asks for ETH',async()=>{const {L}=mkLim({});const r=await call(L,'/owner/limits?single=1&daily=5&term=20',{},'GET');
  assert.equal(r.code,200);assert.match(r.out,/0\.002345 USDC/);assert.match(r.out,/ETH/);assert.doesNotMatch(r.out,/需要 ETH|need ETH|pay in ETH/i);});
test('guard: every wallet_sendCalls in signing pages is known; the limits page only sends via sponsorship or a USDC check',()=>{
  const dir=new URL('../owner-sign/consent/',import.meta.url);const known={'limits.js':3,'consent.js':-1,'approve-trust.js':-1,'phone-enroll.js':-1,'emergency.js':-1,'withdraw.js':-1};
  for(const f of fs.readdirSync(dir)){const s=fs.readFileSync(new URL(f,dir),'utf8');const n=(s.match(/wallet_sendCalls/g)??[]).length;if(!n)continue;
    assert.ok(f in known,`new signing page ${f} sends transactions: add a USDC/sponsorship gas guard and list it here`);if(known[f]>=0)assert.equal(n,known[f],f);}
  const L=fs.readFileSync(new URL('limits.js',dir),'utf8');assert.match(L,/paymasterService/);assert.match(L,/canPayUSDC/);
  const B=fs.readFileSync(new URL('../owner-sign/static/limits.js',import.meta.url),'utf8');assert.match(B,/capabilities:\{paymasterService:\{url:e\.pm\}\}/);assert.match(B,/e\.fee&&e\.fee\.canPayUSDC/);
  assert.doesNotMatch(B,/wallet_sendCalls",params:\[\{version:"2\.0\.0",chainId:"0x"\+Number\(e\.chainId\)\.toString\(16\),from:t,atomicRequired:!0,calls:e\.calls\}\]/,'unguarded send removed');});
test('GET /owner/limits/fee: real per-change estimate in USDC + first-free flag for the app',async()=>{const {L}=mkLim({pm:'u'});const r=await call(L,'/owner/limits/fee',{},'GET');
  assert.equal(r.code,200);assert.deepEqual(r.j,{usdc:'2345',usdcText:'0.002345',firstFree:true,gasToken:'USDC',markupBps:0,paidFrom:'kipurse_wallet',why:WHY_FEE});});
test('guard: onboarding page never silently falls back to a user-paid send when the free sponsorship fails',()=>{
  const B=fs.readFileSync(new URL('../owner-sign/static/onboard-new.js',import.meta.url),'utf8');assert.doesNotMatch(B,/your Base Account will pay the network fee…/);assert.match(B,/Free setup is unavailable right now/);});
