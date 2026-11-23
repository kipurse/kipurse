// t1105 (option C): the owner's Base Account only relays. 3 calls from the owner: wallet -> owner F, approve F to the ERC-20 paymaster, cap change.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {createPublicLimits} from '../src/v5/limits-public.mjs';
import {limitsRelayCalls,checkRelayCalls,limitsWalletPaysFee,limitsTokenApprove,limitsPaymasterApprove,LIMITS_RELAY_CAP,LIMITS_RELAY_GAS,LIMITS_RELAY_FEE_FROM} from '../src/v5/limits-fee.mjs';
const LIVE=JSON.parse(fs.readFileSync(new URL('./fixtures/t1105-live-change.json',import.meta.url),'utf8'));
const O=LIVE.owner,W=LIVE.wallet,PM_URL='https://pay.kipurse.com/owner/limits/paymaster';
const bundled=fs.readFileSync(new URL('../owner-sign/static/limits.js',import.meta.url),'utf8');
const consent=fs.readFileSync(new URL('../owner-sign/consent/limits.js',import.meta.url),'utf8');
const relaySrc=s=>s.slice(s.indexOf('var kpRelayOK='),s.indexOf('/* /KP-RELAY */'));
const pageOK=(src=>{const c={BigInt,String,Number};vm.createContext(c);vm.runInContext(relaySrc(src)+';this.f=kpRelayOK;',c);return c.f;})(bundled);
const consentOK=(src=>{const c={BigInt,String,Number};vm.createContext(c);vm.runInContext(relaySrc(src)+';this.f=kpRelayOK;',c);return c.f;})(consent);
const good=(F=8271n)=>limitsRelayCalls({wallet:W,owner:O,amount:F,changeCall:LIVE.change});
const resp=calls=>({owner:O,wallet:W,from:O,chainId:8453,pm:PM_URL,calls});
const hexSwap=(d,a,b)=>d.toLowerCase().split(a.toLowerCase().replace(/^0x/,'')).join(b.toLowerCase().replace(/^0x/,''));
function variants(){const c=good();const E='0x'+'e'.repeat(40);return {
  'recipient not owner':[{...c[0],data:hexSwap(c[0].data,O,E)},c[1],c[2]],
  'approve spender swapped':[c[0],{...c[1],data:hexSwap(c[1].data,'6666666666667849c56f2850848ce1c4da65c68b',E)},c[2]],
  'approve amount bigger':[c[0],limitsPaymasterApprove(9000n),c[2]],
  'order swapped':[c[1],c[0],c[2]],
  'extra call':[...c,c[0]],
  'missing transfer':[c[1],c[2]],
  'change to other target':[c[0],c[1],{...c[2],to:E}],
  'eth value':[{...c[0],value:'0x1'},c[1],c[2]],
  'wrong token':[{...c[0],data:hexSwap(c[0].data,'833589fcd6edb6e08f4c7c32d4f71b54bda02913',E)},c[1],c[2]]};}
test('relay batch from the live cap change: server, page and consent source all accept it',()=>{
  const c=good();assert.equal(c.length,3);assert.equal(checkRelayCalls(c,{wallet:W,owner:O}),8271n);
  assert.equal(pageOK(resp(c)),true);assert.equal(consentOK(resp(c)),true);assert.deepEqual(c[2],LIVE.change);
  assert.equal(checkRelayCalls(good(10_000n),{wallet:W,owner:O}),10_000n);assert.equal(pageOK(resp(good(10_000n))),true);
  assert.throws(()=>good(10_001n),/relay cap/);assert.throws(()=>good(0n),/relay cap/);});
test('tampered and out-of-scope relay batches are refused everywhere',()=>{
  const v=variants();v['F above 0.01']=(()=>{const c=good(8271n);return [{...c[0],data:c[0].data.slice(0,-120)+(10001).toString(16).padStart(64,'0')+'0'.repeat(56)},limitsPaymasterApprove(10_000n),c[2]];})();
  for(const [k,calls] of Object.entries(v)){assert.equal(checkRelayCalls(calls,{wallet:W,owner:O}),null,k);assert.equal(pageOK(resp(calls)),false,k);assert.equal(consentOK(resp(calls)),false,k);}
  const c=good();assert.equal(pageOK({...resp(c),from:W}),false,'from wallet');assert.equal(pageOK({...resp(c),pm:'https://evil.example/owner/limits/paymaster'}),false,'pm');
  assert.equal(pageOK({...resp(c),chainId:1}),false,'chain');assert.equal(pageOK({...resp(c),owner:W}),false,'owner=wallet');});
// t1123u: prepare no longer returns the relay batch (see t1123-limits-wallet-fee.test.mjs); without the wallet-fee sponsor it stops with no calls.
test('prepare no longer returns the relay batch: without the wallet-fee path it stops (503) with no calls',async()=>{
  async function call(L,path,body){let code,out='';await L.handle({method:'POST',headers:{}},{writeHead:c=>{code=c;},end:s=>{out=s??'';}},new URL('https://x'+path),{readBody:async()=>body,ip:'9'});return {code,j:JSON.parse(out||'null')};}
  const L=createPublicLimits({base:()=>'https://x',current:async()=>null,confirm:async()=>({}),script:()=>'',
    plan:async()=>({owner:O,wallet:W,chainId:8453,human:[],labels:[],calls:[LIVE.change],raw:{},fromWallet:true}),
    fee:async()=>({...limitsWalletPaysFee({callGas:1n,gasPriceWei:1n,ethUsd8:1n,walletUSDC:1_000_000n}),approve:8271n}),feeQuote:async()=>null,
    walletPaymaster:()=>PM_URL,erc20URL:()=>'https://public.pimlico.io/v2/8453/rpc'});
  const r=await call(L,'/owner/limits/prepare',{single:'1000',daily:'3000',term:'50000',days:365});
  assert.equal(r.code,503);assert.equal(r.j.calls,undefined);assert.notEqual(r.j.feeFrom,LIMITS_RELAY_FEE_FROM);});
test('fee quote adds the relay leg and caps the allowance at 0.01',()=>{
  const f=limitsWalletPaysFee({callGas:1n,gasPriceWei:1n,ethUsd8:1n,walletUSDC:10n**6n,extraGas:LIMITS_RELAY_GAS});assert.equal(f.gas,1n+150_000n+45_000n);
  assert.equal(limitsTokenApprove({gasWei:10n**15n,gasPriceWei:1n,exchangeRate:8_000n*10n**3n,approveCap:LIMITS_RELAY_CAP}).ok,true);
  assert.equal(limitsTokenApprove({gasWei:10n**15n,gasPriceWei:1n,exchangeRate:8_400n*10n**3n,approveCap:LIMITS_RELAY_CAP}).ok,false);
  const launch=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(launch,/extraGas:LFEE\.LIMITS_RELAY_GAS/);assert.match(launch,/approveCap:LFEE\.LIMITS_RELAY_CAP/);});
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
