// t1097: allowlisted wallets pay a safety-cap change from their own USDC. Everyone else keeps the Base Account float + refund.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createPublicLimits} from '../src/v5/limits-public.mjs';
import {wrap} from '../owner-sign/guard/apply.mjs';
import {limitsWalletPaysFee,limitsChangeFee,limitsWalletFeeCap,limitsWalletPaysAllowlist,walletPaysLimits,erc20PaymasterURL,rewritePaymasterBody,sanitizePaymasterResponse,limitsChangeCalls,LIMITS_REFUND_GAS,ERC20_PAYMASTER,ENTRYPOINT_V06,BASE_USDC,LIMITS_PAYMASTER_METHODS} from '../src/v5/limits-fee.mjs';
const O='0x'+'1'.repeat(40),W='0x'+'2'.repeat(40);
const tiny={callGas:1n,gasPriceWei:1n,ethUsd8:1n};
async function call(L,path,body,method='POST'){let code,out='';const res={writeHead:c=>{code=c;},end:s=>{out=s;}};
  await L.handle({method},res,new URL('https://x'+path),{readBody:async()=>body,ip:'9'});return {code,j:(()=>{try{return JSON.parse(out);}catch{return null;}})(),out};}
function lim(extra){const calls=[];const L=createPublicLimits({base:()=>'https://x',current:async()=>null,confirm:async()=>({valid:true,permissionHash:'0x1'}),script:()=>'',
  plan:async()=>({owner:O,wallet:W,chainId:8453,human:[],labels:[],calls:[{to:W,value:'0x0',data:'0x34fcd5be'}],raw:{},...extra.plan}),
  sponsor:extra.sponsor??(async()=>null),fee:extra.fee,feeQuote:extra.feeQuote??(async()=>null),refund:extra.refund??(()=>{throw Error('refund');}),
  walletPaymaster:extra.walletPaymaster??(()=>null),paymasterFetch:extra.paymasterFetch??(async()=>{throw Error('fetch');}),
  erc20URL:extra.erc20URL??(()=>'https://public.pimlico.io/v2/8453/rpc')});return {L,calls};}
test('allowlist empty keeps every wallet off the new path',()=>{
  assert.deepEqual(limitsWalletPaysAllowlist({KIPURSE_LIMITS_WALLET_PAYS_ALLOWLIST:''}),[]);
  assert.equal(walletPaysLimits(W,{}),false);
  assert.equal(walletPaysLimits(W,{KIPURSE_LIMITS_WALLET_PAYS_ALLOWLIST:'not-an-address,,  '}),false);
  assert.equal(walletPaysLimits(W,{KIPURSE_LIMITS_WALLET_PAYS_ALLOWLIST:' '+W.toUpperCase()+' , 0xzz'}),true);
  assert.equal(walletPaysLimits(O,{KIPURSE_LIMITS_WALLET_PAYS_ALLOWLIST:W}),false);});
test('fee cap defaults to 0.01 USDC and is configurable',()=>{
  assert.equal(limitsWalletFeeCap({}),10_000n);
  assert.equal(limitsWalletFeeCap({KIPURSE_LIMITS_WALLET_FEE_CAP:'0.02'}),20_000n);
  assert.equal(limitsWalletFeeCap({KIPURSE_LIMITS_WALLET_FEE_CAP:'nope'}),10_000n);});
test('erc20 paymaster URL is not the onboarding paymaster',()=>{
  assert.equal(erc20PaymasterURL({}),'https://public.pimlico.io/v2/8453/rpc');
  assert.equal(erc20PaymasterURL({KIPURSE_ERC20_PAYMASTER_URL:'https://rpc.example/v2/8453/rpc',KIPURSE_ONBOARD_PAYMASTER_URL:'https://other.example/pm'}),'https://rpc.example/v2/8453/rpc');
  assert.throws(()=>erc20PaymasterURL({KIPURSE_ERC20_PAYMASTER_URL:'https://same.example/pm',KIPURSE_ONBOARD_PAYMASTER_URL:'https://same.example/pm'}),/onboard paymaster/);});
test('direct quote has no refund gas and no Base float',()=>{
  const f=limitsWalletPaysFee({...tiny,walletUSDC:1_000_000n});
  assert.equal(f.reason,null);assert.equal(f.fromWallet,true);assert.equal(f.walletPays,false);assert.equal(f.floatNeed,undefined);
  assert.equal(f.gas,1n+150_000n);
  const old=limitsChangeFee({...tiny,payerUSDC:10n**6n,walletUSDC:10n**6n});
  assert.equal(old.gas,f.gas+LIMITS_REFUND_GAS);assert.equal(old.reason,null);
  const cap=limitsWalletPaysFee({...tiny,walletUSDC:100n,cap:1n});assert.equal(cap.usdc,1n);assert.equal(cap.reason,'fee_above_cap');
  const under=limitsWalletPaysFee({...tiny,walletUSDC:100n,cap:2n});assert.equal(under.reason,null);
  const low=limitsWalletPaysFee({...tiny,walletUSDC:0n});assert.equal(low.reason,'kipurse_balance_insufficient_for_fee');
  const big=limitsWalletPaysFee({callGas:200000n,gasPriceWei:10n**12n,ethUsd8:4000_00000000n,walletUSDC:10n**18n});
  assert.equal(big.reason,'fee_above_cap');assert.ok(big.usdc>=10_000n);});
test('cap-change calls drop the approve and the refund when the wallet pays',()=>{
  const change={to:W,data:'0xabc'},approve={to:O,data:'0xapp'};
  assert.deepEqual(limitsChangeCalls({direct:true,approveCall:approve,changeCall:change}),[change]);
  assert.deepEqual(limitsChangeCalls({direct:false,approveCall:approve,changeCall:change}),[approve,change]);});
test('old path still 402s for a missing Base float and still appends the refund',async()=>{
  const off=lim({plan:{},fee:async()=>({usdc:3000n,payerUSDC:0n,walletUSDC:10n**6n,canPayUSDC:false,walletPays:true,reason:'float_low',floatNeed:4500n})});
  const a=await call(off.L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(a.code,402);assert.equal(a.j.error,'base_account_needs_float');assert.equal(a.j.calls,undefined);assert.equal(a.j.feeFrom,undefined);
  let n=0;const on=lim({plan:{},fee:async()=>({usdc:1000n,canPayUSDC:true,walletPays:true,reason:null,payerUSDC:10_000n,walletUSDC:10_000n,floatNeed:1500n}),
    refund:fee=>{n++;assert.equal(fee,1000n);return {to:W,value:'0x0',data:'0xrefund'};}});
  const b=await call(on.L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(b.code,200);assert.equal(b.j.calls.length,2);assert.equal(b.j.calls[1].data,'0xrefund');assert.equal(n,1);assert.equal(b.j.feeFrom,undefined);});
test('new path: one call, from the wallet, same-origin paymaster, no refund',async()=>{
  let sponsored=0,refunded=0;
  const {L}=lim({plan:{fromWallet:true},fee:async()=>limitsWalletPaysFee({...tiny,walletUSDC:1_000_000n}),
    sponsor:async()=>{sponsored++;return 'https://x/onboard/new/paymaster?id=1';},refund:()=>{refunded++;throw Error('refund');},
    walletPaymaster:()=>'https://x/owner/limits/paymaster'});
  const r=await call(L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(r.code,200);assert.equal(r.j.feeFrom,'kipurse_wallet');assert.equal(r.j.from,W);assert.equal(r.j.wallet,W);
  assert.equal(r.j.calls.length,1);assert.equal(r.j.sponsored,false);assert.equal(r.j.pm,'https://x/owner/limits/paymaster');
  assert.equal(sponsored,0);assert.equal(refunded,0);assert.equal(r.j.calls[0].data,'0x34fcd5be');
  const again=await call(L,'/owner/limits/prepare',{plan:r.j.id});
  assert.equal(again.j.from,W);assert.equal(again.j.feeFrom,'kipurse_wallet');assert.deepEqual(again.j.calls,r.j.calls);
  const page=await call(createPublicLimits({base:()=>'https://x',current:async()=>null,plan:async()=>({}),confirm:async()=>({}),script:()=>'',
    feeQuote:async()=>({usdc:6934n,firstFree:false,fromWallet:true}),erc20URL:()=>'https://public.pimlico.io/v2/8453/rpc'}),'/owner/limits?single=1&daily=5&term=20',{},'GET');
  assert.match(page.out,/Changing the wallet safety limit needs a small network fee \(about 0\.006934 USDC\), taken from your Kipurse balance\./);
  assert.match(fs.readFileSync(new URL('../src/v5/limits-public.mjs',import.meta.url),'utf8'),/修改钱包安全上限需要一点手续费（约 \$\{fmtUsdc\(fq\.usdc\)\} USDC），从启付余额里扣/);
  const fee=await call(createPublicLimits({base:()=>'https://x',current:async()=>null,plan:async()=>({}),confirm:async()=>({}),script:()=>'',
    feeQuote:async()=>({usdc:6934n,firstFree:false,fromWallet:true}),erc20URL:()=>'https://public.pimlico.io/v2/8453/rpc'}),'/owner/limits/fee',{},'GET');
  assert.equal(fee.j.feeFrom,'kipurse_wallet');assert.equal(fee.j.paidFrom,'kipurse_wallet_usdc');assert.equal(fee.j.usdcText,'0.006934');});
test('new path refuses a fee at the cap and a wallet that cannot cover it, with no calls',async()=>{
  const high=lim({plan:{fromWallet:true},fee:async()=>limitsWalletPaysFee({callGas:200000n,gasPriceWei:10n**12n,ethUsd8:4000_00000000n,walletUSDC:10n**18n}),walletPaymaster:()=>'https://x/owner/limits/paymaster'});
  const a=await call(high.L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(a.code,402);assert.equal(a.j.error,'fee_above_cap');assert.equal(a.j.calls,undefined);
  const low=lim({plan:{fromWallet:true},fee:async()=>limitsWalletPaysFee({...tiny,walletUSDC:0n}),walletPaymaster:()=>'https://x/owner/limits/paymaster'});
  const b=await call(low.L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(b.code,402);assert.equal(b.j.error,'kipurse_balance_insufficient_for_fee');assert.equal(b.j.detail.zh,'启付余额不足以支付手续费');assert.equal(b.j.calls,undefined);
  const closed=lim({plan:{fromWallet:true},fee:async()=>limitsWalletPaysFee({...tiny,walletUSDC:1_000_000n}),walletPaymaster:()=>null});
  const c=await call(closed.L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(c.code,503);assert.equal(c.j.calls,undefined);
  const reused=lim({plan:{fromWallet:true},fee:async()=>limitsWalletPaysFee({...tiny,walletUSDC:1_000_000n}),walletPaymaster:()=>'https://x/owner/limits/paymaster',
    erc20URL:()=>{throw Object.assign(Error('erc20 paymaster url must not be the onboard paymaster'),{code:'paymaster_url'});}});
  const d=await call(reused.L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(d.code,503);assert.equal(d.j.error,'paymaster_unavailable');assert.equal(d.j.calls,undefined);});
test('paymaster proxy forwards only the three read methods and forces Base USDC',async()=>{
  const seen=[];const pm='0x6666666666667849c56f2850848ce1c4da65c68b';
  const {L}=lim({walletPaymaster:()=>'https://x/owner/limits/paymaster',paymasterFetch:async body=>{seen.push(body);return {jsonrpc:'2.0',id:body.id,result:{paymasterAndData:pm+'ab'.repeat(32)}};}});
  const bad=await call(L,'/owner/limits/paymaster',{jsonrpc:'2.0',id:1,method:'eth_sendTransaction',params:[{to:O}]});
  assert.equal(bad.code,400);assert.equal(bad.j.error,'method_not_allowed');assert.equal(seen.length,0);
  const sponsor=await call(L,'/owner/limits/paymaster',{method:'pm_sponsorUserOperation',params:[]});
  assert.equal(sponsor.code,400);assert.equal(sponsor.j.error,'method_not_allowed');
  for(const method of LIMITS_PAYMASTER_METHODS){
    if(method==='pimlico_getTokenQuotes')continue;
    const r=await call(L,'/owner/limits/paymaster',{jsonrpc:'2.0',id:7,method,params:[{sender:W},'0xdead',8453,{token:'0x'+'11'.repeat(20)}]});
    assert.equal(r.code,200,method);assert.equal(r.j.error,undefined,method);
  }
  const last=seen.at(-1);assert.equal(last.params[1],ENTRYPOINT_V06);assert.equal(last.params[3].token,BASE_USDC);assert.notEqual(last.params[3].token.toLowerCase(),'0x'+'11'.repeat(20));
  const quotes=lim({walletPaymaster:()=>'https://x/owner/limits/paymaster',paymasterFetch:async body=>({jsonrpc:'2.0',id:body.id,result:{quotes:[{token:BASE_USDC,exchangeRate:'1'},{token:'0x'+'22'.repeat(20),exchangeRate:'2'}]}})});
  const q=await call(quotes.L,'/owner/limits/paymaster',{method:'pimlico_getTokenQuotes',params:[{tokens:['0x'+'22'.repeat(20)]}]});
  assert.equal(q.code,200);assert.equal(q.j.result.quotes.length,1);assert.equal(q.j.result.quotes[0].token,BASE_USDC);
  const wrong=lim({walletPaymaster:()=>'https://x/owner/limits/paymaster',paymasterFetch:async()=>({jsonrpc:'2.0',id:1,result:{paymaster:'0x'+'11'.repeat(20)}})});
  const w=await call(wrong.L,'/owner/limits/paymaster',{method:'pm_getPaymasterData',params:[{},ENTRYPOINT_V06,'0x2105',{}]});
  assert.equal(w.j.error.message,'paymaster');
  const closed=lim({walletPaymaster:()=>null});
  assert.equal((await call(closed.L,'/owner/limits/paymaster',{method:'pm_getPaymasterStubData',params:[]})).code,404);
  const onboard=lim({walletPaymaster:()=>'https://x/onboard/new/paymaster?id=1'});
  assert.equal((await call(onboard.L,'/owner/limits/paymaster',{method:'pm_getPaymasterStubData',params:[]})).code,404);
  const rw=rewritePaymasterBody({method:'eth_call',params:[]});assert.equal(rw.error,'method_not_allowed');
  assert.equal(sanitizePaymasterResponse('pm_getPaymasterStubData',{result:{paymaster:ERC20_PAYMASTER}}).result.paymaster,ERC20_PAYMASTER);});
test('shipped limits page sends the wallet-pays batch only through the guard',()=>{
  const consent=fs.readFileSync(new URL('../owner-sign/consent/limits.js',import.meta.url),'utf8');
  const bundled=fs.readFileSync(new URL('../owner-sign/static/limits.js',import.meta.url),'utf8');
  assert.equal((consent.match(/wallet_sendCalls/g)??[]).length,3);
  assert.match(consent,/feeFrom==='kipurse_wallet'/);assert.match(consent,/from:pl\.wallet/);
  assert.match(bundled,/e\.feeFrom==="kipurse_wallet"/);assert.match(bundled,/from:e\.wallet/);
  assert.equal(wrap(bundled).n,0);assert.equal(wrap(consent).n,0);
  const launch=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(launch,/\/owner\/limits\/paymaster/);assert.match(launch,/limitsWalletPaysFee/);
  assert.match(launch,/KIPURSE_ONBOARD_PAYMASTER_URL:ONBOARD_PM_URL/);
  assert.doesNotMatch(launch,/KIPURSE_ERC20_PAYMASTER_URL\s*=\s*process\.env\.KIPURSE_ONBOARD_PAYMASTER_URL/);});
