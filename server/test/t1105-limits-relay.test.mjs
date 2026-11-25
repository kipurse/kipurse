// t1105 (option C): the owner's Base Account only relays. 3 calls from the owner: wallet -> owner F, approve F to the ERC-20 paymaster, cap change.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {createPublicLimits} from '../src/v5/limits-public.mjs';
import {limitsWalletFee} from '../src/v5/limits-fee.mjs';
const LIVE=JSON.parse(fs.readFileSync(new URL('./fixtures/t1105-live-change.json',import.meta.url),'utf8'));
const O=LIVE.owner,W=LIVE.wallet,PM_URL='https://pay.kipurse.com/owner/limits/paymaster';
const bundled=fs.readFileSync(new URL('../owner-sign/static/limits.js',import.meta.url),'utf8');
const consent=fs.readFileSync(new URL('../owner-sign/consent/limits.js',import.meta.url),'utf8');
const relaySrc=s=>s.slice(s.indexOf('var kpRelayOK='),s.indexOf('/* /KP-RELAY */'));
const pageOK=(src=>{const c={BigInt,String,Number};vm.createContext(c);vm.runInContext(relaySrc(src)+';this.f=kpRelayOK;',c);return c.f;})(bundled);
const consentOK=(src=>{const c={BigInt,String,Number};vm.createContext(c);vm.runInContext(relaySrc(src)+';this.f=kpRelayOK;',c);return c.f;})(consent);
// t147 (decision 147): the relay (wallet -> owner F, USDC.approve(third-party ERC-20 paymaster, F), cap change) is never sent by either page.
const pad=x=>x.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const relayLike=F=>[{to:W,value:'0x0',data:'0xb61d27f6'+pad('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')+pad('0')+pad('60')+pad('44')+'a9059cbb'+pad(O)+F.toString(16).padStart(64,'0')+'0'.repeat(56)},
  {to:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',value:'0x0',data:'0x095ea7b3'+pad('0x6666666666667849c56f2850848ce1c4da65c68b')+F.toString(16).padStart(64,'0')},LIVE.change];
test('t147: both limits pages refuse the old relay / paymaster-approve batch',()=>{
  const r={owner:O,wallet:W,from:O,chainId:8453,pm:PM_URL,calls:relayLike(8271n)};
  assert.equal(pageOK(r),false);assert.equal(consentOK(r),false);
  for(const s of [bundled,consent])assert.doesNotMatch(s.toLowerCase(),/6666666666667849c56f2850848ce1c4da65c68b/);});
// t1123: prepare no longer returns the relay batch (see t1123-limits-wallet-fee.test.mjs); without the wallet-fee sponsor it stops with no calls.
test('prepare no longer returns the relay batch: without the wallet-fee path it stops (503) with no calls',async()=>{
  async function call(L,path,body){let code,out='';await L.handle({method:'POST',headers:{}},{writeHead:c=>{code=c;},end:s=>{out=s??'';}},new URL('https://x'+path),{readBody:async()=>body,ip:'9'});return {code,j:JSON.parse(out||'null')};}
  const L=createPublicLimits({base:()=>'https://x',current:async()=>null,confirm:async()=>({}),script:()=>'',
    plan:async()=>({owner:O,wallet:W,chainId:8453,human:[],labels:[],calls:[LIVE.change],raw:{},fromWallet:true}),
    fee:async()=>limitsWalletFee({callGas:1n,gasPriceWei:1n,ethUsd8:1n,walletUSDC:1_000_000n}),feeQuote:async()=>null});
  const r=await call(L,'/owner/limits/prepare',{single:'1000',daily:'3000',term:'50000',days:365});
  assert.equal(r.code,503);assert.equal(r.j.calls,undefined);assert.notEqual(r.j.feeFrom,'kipurse_wallet_relay');});
test('page: no sub-account, no send without the paymaster, checks before any wallet call',()=>{
  const app=bundled.slice(bundled.indexOf('var q7='));
  assert.doesNotMatch(app,/addSubAccount/);assert.doesNotMatch(consent,/addSubAccount/);
  const firstWallet=app.indexOf('q4().request(');assert.ok(firstWallet>0);
  assert.ok(app.indexOf('kpRelayOK(e)')<firstWallet&&app.indexOf('await kpVH(')<firstWallet);
  assert.equal((app.match(/wallet_sendCalls/g)??[]).length,2);assert.equal((app.match(/paymasterService:\{url:e\.pm\}/g)??[]).length,2);
  assert.doesNotMatch(app,/canPayUSDC/);assert.doesNotMatch(consent.slice(consent.indexOf('go.onclick')),/canPayUSDC/);});
test('English consent title is "Change wallet safety limits"',()=>{
  const pub=fs.readFileSync(new URL('../src/v5/limits-public.mjs',import.meta.url),'utf8');
  assert.match(pub,/t\('修改钱包安全上限','Change wallet safety limits'\)/);assert.doesNotMatch(pub,/Change AI payment limits/);});
