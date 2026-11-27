// t1097 / t1123: wallets pay a safety-cap change from their own USDC (t147: the Pimlico allowlist path is removed).
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createPublicLimits} from '../src/v5/limits-public.mjs';
import {wrap} from '../owner-sign/guard/apply.mjs';
import {limitsWalletFee,limitsChangeFee,limitsWalletFeeCap,limitsChangeCalls,LIMITS_REFUND_GAS,BASE_USDC} from '../src/v5/limits-fee.mjs';
const O='0x'+'1'.repeat(40),W='0x'+'2'.repeat(40);
const tiny={callGas:1n,gasPriceWei:1n,ethUsd8:1n};
async function call(L,path,body,method='POST',headers={}){let code,out='',hdr={};const res={writeHead:(c,h)=>{code=c;hdr=h??{};},end:s=>{out=s??'';}};
  await L.handle({method,headers},res,new URL('https://x'+path),{readBody:async()=>body,ip:'9'});return {code,j:(()=>{try{return out?JSON.parse(out):null;}catch{return null;}})(),out,hdr};}
function lim(extra){const calls=[];const L=createPublicLimits({base:()=>'https://x',current:async()=>null,confirm:async()=>({valid:true,permissionHash:'0x1'}),script:()=>'',
  plan:async()=>({owner:O,wallet:W,chainId:8453,human:[],labels:[],calls:[{to:W,value:'0x0',data:'0x34fcd5be'}],raw:{},...extra.plan}),
  sponsor:extra.sponsor??(async()=>null),fee:extra.fee,feeQuote:extra.feeQuote??(async()=>null),refund:extra.refund??(()=>{throw Error('refund');}),
  walletFee:extra.walletFee});return {L,calls};}
test('fee cap defaults to 0.01 USDC and is configurable',()=>{
  assert.equal(limitsWalletFeeCap({}),10_000n);
  assert.equal(limitsWalletFeeCap({KIPURSE_LIMITS_WALLET_FEE_CAP:'0.02'}),20_000n);
  assert.equal(limitsWalletFeeCap({KIPURSE_LIMITS_WALLET_FEE_CAP:'nope'}),10_000n);});
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
// t1123: the t1105 relay (wallet -> owner, approve Pimlico) is replaced by the t752 withdraw shape: wallet -> official fee address, cap change.
const WF={feeTo:'0x82ecf6e2f76ee100e4676dabe193bca6bcab64fd',available:()=>true,register:async id=>'https://x/onboard/new/paymaster?id=lw-'+id};
const change34={to:W,value:'0x0',data:'0x34fcd5be'+'0'.repeat(64)};
test('new path (t1123): wallet -> official fee address F, cap change, from the owner, existing sponsor; no Pimlico, nothing to the owner',async()=>{
  let sponsored=0,refunded=0;
  const {L}=lim({plan:{fromWallet:true,calls:[change34]},fee:async()=>limitsWalletFee({...tiny,walletUSDC:1_000_000n}),
    sponsor:async()=>{sponsored++;return 'https://x/onboard/new/paymaster?id=1';},refund:()=>{refunded++;throw Error('refund');},walletFee:WF});
  const r=await call(L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(r.code,200);assert.equal(r.j.feeFrom,'kipurse_wallet_fee');assert.equal(r.j.from,O);assert.equal(r.j.wallet,W);assert.equal(r.j.fee.canPayUSDC,false);
  assert.equal(r.j.calls.length,2);assert.equal(r.j.sponsored,false);assert.match(r.j.pm,/^https:\/\/x\/onboard\/new\/paymaster\?id=lw-/);
  assert.equal(sponsored,0);assert.equal(refunded,0);assert.deepEqual(r.j.calls[1],change34);
  assert.equal(r.j.calls[0].to,W);assert.match(r.j.calls[0].data.toLowerCase(),/a9059cbb0{24}82ecf6e2f76ee100e4676dabe193bca6bcab64fd/);
  assert.doesNotMatch(JSON.stringify(r.j.calls).toLowerCase(),/6666666666667849c56f2850848ce1c4da65c68b|095ea7b3/);
  const again=await call(L,'/owner/limits/prepare',{plan:r.j.id});
  assert.equal(again.j.from,O);assert.equal(again.j.feeFrom,'kipurse_wallet_fee');assert.deepEqual(again.j.calls,r.j.calls);
  const page=await call(createPublicLimits({base:()=>'https://x',current:async()=>null,plan:async()=>({}),confirm:async()=>({}),script:()=>'',
    feeQuote:async()=>({usdc:6934n,firstFree:false,fromWallet:true}),erc20URL:()=>'https://public.pimlico.io/v2/8453/rpc'}),'/owner/limits?single=1&daily=5&term=20',{},'GET');
  assert.match(page.out,/Changing the wallet safety limit needs a small network fee \(about 0\.006934 USDC\), taken from your Kipurse balance\./);
  assert.match(fs.readFileSync(new URL('../src/v5/limits-public.mjs',import.meta.url),'utf8'),/修改钱包安全上限需要一点手续费（约 \$\{fmtUsdc\(fq\.usdc\)\} USDC），从启付余额里扣/);
  const fee=await call(createPublicLimits({base:()=>'https://x',current:async()=>null,plan:async()=>({}),confirm:async()=>({}),script:()=>'',
    feeQuote:async()=>({usdc:6934n,firstFree:false,fromWallet:true}),erc20URL:()=>'https://public.pimlico.io/v2/8453/rpc'}),'/owner/limits/fee',{},'GET');
  assert.equal(fee.j.feeFrom,'kipurse_wallet');assert.equal(fee.j.paidFrom,'kipurse_wallet_usdc');assert.equal(fee.j.usdcText,'0.006934');});
test('new path refuses a fee at the cap and a wallet that cannot cover it, with no calls',async()=>{
  const high=lim({plan:{fromWallet:true,calls:[change34]},fee:async()=>limitsWalletFee({callGas:200000n,gasPriceWei:10n**12n,ethUsd8:4000_00000000n,walletUSDC:10n**18n}),walletFee:WF});
  const a=await call(high.L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(a.code,402);assert.equal(a.j.error,'fee_above_cap');assert.equal(a.j.calls,undefined);
  const low=lim({plan:{fromWallet:true,calls:[change34]},fee:async()=>limitsWalletFee({...tiny,walletUSDC:0n}),walletFee:WF});
  const b=await call(low.L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(b.code,402);assert.equal(b.j.error,'wallet_needs_topup');assert.match(b.j.detail.zh,/请先给启付钱包充值。没有扣钱。/);assert.equal(b.j.calls,undefined);
  const closed=lim({plan:{fromWallet:true,calls:[change34]},fee:async()=>limitsWalletFee({...tiny,walletUSDC:1_000_000n})});
  const c=await call(closed.L,'/owner/limits/prepare',{single:'1',daily:'5',term:'20'});
  assert.equal(c.code,503);assert.equal(c.j.error,'wallet_fee_unavailable');assert.equal(c.j.calls,undefined);});