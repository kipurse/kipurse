// t1123 (decision 63): later wallet-safety-limit changes take the fee from the Kipurse wallet's USDC in the SAME batch (t752 withdraw shape).
// From the owner's Base Account (signs only, 0 USDC is fine). Exactly: wallet -> official fee address F, then the cap change. Existing sponsor only.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {encodeFunctionData,parseAbi} from 'viem';
import {createPublicLimits} from '../src/v5/limits-public.mjs';
import {createOnboardSponsor,callsHash,LIMITS_WALLET_PREFIX} from '../src/v5/onboard-sponsor.mjs';import {createMemoryKV} from '../src/v5/store.mjs';
import {limitsWalletFee,limitsWalletFeeCalls,checkLimitsWalletFeeCalls,feeRefundCall,BASE_USDC,LIMITS_WALLET_FEE_FROM,LIMITS_OFFICIAL_FEE_TO,LIMITS_SPONSOR_FLOOR_GAS,LIMITS_FEE_TRANSFER_GAS} from '../src/v5/limits-fee.mjs';
// t147 (decision 147): the relay / third-party paymaster helpers are gone from the server; these local copies only build the refused shapes.
const PM_OLD='0x6666666666667849c56f2850848ce1c4da65c68b';
const limitsPaymasterApprove=a=>({to:BASE_USDC,value:'0x0',data:encodeFunctionData({abi:parseAbi(['function approve(address,uint256) returns (bool)']),functionName:'approve',args:[PM_OLD,BigInt(a)]})});
const limitsRelayCalls=({wallet,owner,amount,changeCall})=>[feeRefundCall({wallet,token:BASE_USDC,owner,fee:amount}),limitsPaymasterApprove(amount),changeCall];
const LIVE=JSON.parse(fs.readFileSync(new URL('./fixtures/t1123-prod-change.json',import.meta.url),'utf8'));
const O=LIVE.owner,W=LIVE.wallet,FT=LIMITS_OFFICIAL_FEE_TO,E='0x'+'e'.repeat(40);
const live={gasPriceWei:6_000_000n,ethUsd8:201280086896n};   // Base, 2026-11-12 ~17:40 CT
async function call(L,path,body){let code,out='';await L.handle({method:'POST',headers:{}},{writeHead:c=>{code=c;},end:s=>{out=s??'';}},new URL('https://x'+path),{readBody:async()=>body,ip:'9'});return {code,j:JSON.parse(out||'null')};}
const choice={single:'1000',daily:'3000',term:'50000',days:365};
function mk({fee,walletFee,reg=[]}={}){return createPublicLimits({base:()=>'https://x',current:async()=>null,confirm:async()=>({}),script:()=>'',
  plan:async()=>({owner:O,wallet:W,chainId:8453,human:[],labels:[],calls:[LIVE.change],raw:{},fromWallet:true}),
  fee:fee??(async()=>limitsWalletFee({callGas:171_595n,...live,walletUSDC:11_340_000n})),feeQuote:async()=>null,
  walletFee:walletFee===undefined?{feeTo:FT,available:()=>true,register:async(id,a)=>{reg.push({id,...a});return 'https://x/onboard/new/paymaster?id='+LIMITS_WALLET_PREFIX+id;}}:walletFee});}
test('quote: actual cost, never below the sponsor floor, 0.01 cap, wallet balance decides',()=>{
  const f=limitsWalletFee({callGas:171_595n,...live,walletUSDC:11_340_000n});
  assert.equal(f.gas,171_595n+150_000n+LIMITS_FEE_TRANSFER_GAS);assert.equal(f.reason,null);assert.equal(f.canPayUSDC,false);assert.equal(f.walletPays,true);
  const floorUSDC=(LIMITS_SPONSOR_FLOOR_GAS*live.gasPriceWei*live.ethUsd8+10n**20n-1n)/10n**20n;assert.ok(f.usdc>=floorUSDC);assert.ok(f.usdc<10_000n);
  assert.equal(limitsWalletFee({callGas:171_595n,...live,walletUSDC:f.usdc-1n}).reason,'wallet_low');
  assert.equal(limitsWalletFee({callGas:171_595n,...live,walletUSDC:null}).reason,'wallet_low');
  assert.equal(limitsWalletFee({callGas:171_595n,gasPriceWei:10n**11n,ethUsd8:live.ethUsd8,walletUSDC:10n**12n}).reason,'fee_above_cap');});
test('prepare: two calls, wallet -> official fee address then the real cap change, from the owner, existing sponsor URL, no Pimlico',async()=>{
  const reg=[];const r=await call(mk({reg}),'/owner/limits/prepare',choice);
  assert.equal(r.code,200);assert.equal(r.j.feeFrom,LIMITS_WALLET_FEE_FROM);assert.equal(r.j.from,O);assert.equal(r.j.owner,O);assert.equal(r.j.wallet,W);
  assert.equal(r.j.fee.canPayUSDC,false);assert.equal(r.j.fee.walletPays,true);assert.equal(r.j.feeTo,FT);assert.equal(r.j.sponsored,false);
  assert.equal(r.j.calls.length,2);assert.deepEqual(r.j.calls[1],LIVE.change);
  const F=checkLimitsWalletFeeCalls(r.j.calls,{wallet:W,feeTo:FT});assert.equal(String(F),r.j.fee.usdc);
  assert.match(r.j.pm,/\/onboard\/new\/paymaster\?id=lw-/);assert.doesNotMatch(JSON.stringify(r.j),/6666666666667849c56f2850848ce1c4da65c68b|pimlico|owner\/limits\/paymaster/i);
  assert.doesNotMatch(r.j.calls.map(c=>c.data).join('').toLowerCase(),new RegExp(O.slice(2).toLowerCase()),'nothing goes to the owner');
  assert.equal(reg.length,1);assert.equal(reg[0].reimburse,F);assert.deepEqual(reg[0].calls,r.j.calls);
  const again=await call(mk({reg}),'/owner/limits/prepare',choice);assert.equal(again.code,200);
  const L=mk({});const a=await call(L,'/owner/limits/prepare',choice);const b=await call(L,'/owner/limits/prepare',{plan:a.j.id});
  assert.equal(b.j.feeFrom,LIMITS_WALLET_FEE_FROM);assert.equal(b.j.from,O);assert.equal(b.j.pm,a.j.pm);assert.deepEqual(b.j.calls,a.j.calls);assert.equal(b.j.feeTo,FT);});
test('stops in the App with nothing to sign: wallet too low, fee above cap, sponsor unavailable or registration refused',async()=>{
  const low=await call(mk({fee:async()=>limitsWalletFee({callGas:171_595n,...live,walletUSDC:100n})}),'/owner/limits/prepare',choice);
  assert.equal(low.code,402);assert.equal(low.j.error,'wallet_needs_topup');assert.equal(low.j.calls,undefined);assert.match(low.j.detail.zh,/请先给启付钱包充值。没有扣钱。/);
  const hi=await call(mk({fee:async()=>limitsWalletFee({callGas:171_595n,gasPriceWei:10n**11n,ethUsd8:live.ethUsd8,walletUSDC:10n**12n})}),'/owner/limits/prepare',choice);
  assert.equal(hi.code,402);assert.equal(hi.j.error,'fee_above_cap');assert.equal(hi.j.calls,undefined);
  for(const wf of [null,{feeTo:FT,available:()=>false,register:async()=>'https://x/onboard/new/paymaster?id=lw-1'},{feeTo:FT,available:()=>true,register:async()=>null},{feeTo:FT,available:()=>true,register:async()=>'https://evil.example/pm'}]){
    const r=await call(mk({walletFee:wf}),'/owner/limits/prepare',choice);assert.equal(r.code,503);assert.equal(r.j.calls,undefined);}
  const nf=await call(mk({fee:async()=>{throw Error('rpc');}}),'/owner/limits/prepare',choice);assert.equal(nf.code,503);assert.equal(nf.j.calls,undefined);});
test('checker refuses every other shape (old relay, Pimlico approve, transfer to owner, wrong address, order, extra call, ETH, over cap)',()=>{
  const good=limitsWalletFeeCalls({wallet:W,feeTo:FT,fee:6_000n,changeCall:LIVE.change});assert.equal(checkLimitsWalletFeeCalls(good,{wallet:W,feeTo:FT}),6_000n);
  const hex=(d,a,b)=>d.toLowerCase().split(a.toLowerCase().replace(/^0x/,'')).join(b.toLowerCase().replace(/^0x/,''));
  const bad={relay:limitsRelayCalls({wallet:W,owner:O,amount:6_000n,changeCall:LIVE.change}),approve:[limitsPaymasterApprove(6_000n),LIVE.change],
    toOwner:[{...good[0],data:hex(good[0].data,FT,O)},good[1]],toOther:[{...good[0],data:hex(good[0].data,FT,E)},good[1]],order:[good[1],good[0]],extra:[...good,good[0]],
    onlyChange:[good[1]],eth:[{...good[0],value:'0x1'},good[1]],otherWallet:[{...good[0],to:E},good[1]],
    over:[{...good[0],data:good[0].data.slice(0,-120)+(10_000).toString(16).padStart(64,'0')+'0'.repeat(56)},good[1]]};
  for(const [k,c] of Object.entries(bad))assert.equal(checkLimitsWalletFeeCalls(c,{wallet:W,feeTo:FT}),null,k);
  assert.throws(()=>limitsWalletFeeCalls({wallet:W,feeTo:FT,fee:10_000n,changeCall:LIVE.change}),/fee cap/);
  assert.throws(()=>limitsWalletFeeCalls({wallet:W,feeTo:FT,fee:1n,changeCall:{...LIVE.change,to:E}}),/change call/);});
const EXEC=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);const EP='0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const op=(cs,o={})=>({sender:O,callData:encodeFunctionData({abi:EXEC,functionName:'executeBatch',args:[cs.map(c=>({target:c.to,value:BigInt(c.value),data:c.data}))]}),callGasLimit:'0x1e8480',verificationGasLimit:'0x30d40',preVerificationGas:'0xc350',maxFeePerGas:'0x5b8d80',...o});
test('sponsor: lw- kind fronts gas only for the exact batch from the owner, same caps and underpaid check as withdraw',async()=>{
  const mkS=(cfg={},gp=live.gasPriceWei)=>createOnboardSponsor({onboardOn:true,cfg:{url:'https://pm.example/x',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25,...cfg},kv:createMemoryKV(),reg:{byOwner:()=>[{wallet:W}]},
    ethUsd8:async()=>live.ethUsd8,lookup:()=>null,gasPrice:async()=>gp,fetchImpl:async()=>({json:async()=>({result:{paymaster:'0x9',paymasterData:'0x'}})})});
  const f=limitsWalletFee({callGas:171_595n,...live,walletUSDC:11_340_000n});const c=limitsWalletFeeCalls({wallet:W,feeTo:FT,fee:f.usdc,changeCall:LIVE.change});
  const s=mkS();const id=s.registerLimitsWallet('p1',{owner:O,wallet:W,calls:c,reimburse:f.usdc});assert.match(id,/^lw-/);
  assert.equal(await s.gate(id,'pm_getPaymasterData',[op(c),EP,'0x2105']),null,'quoted fee passes the underpaid re-check at the quoted price');
  assert.equal(await s.gate(id,'pm_getPaymasterData',[op(c,{sender:E}),EP,'0x2105']),'sender');
  const relay=limitsRelayCalls({wallet:W,owner:O,amount:f.usdc,changeCall:LIVE.change});assert.equal(await s.gate(id,'pm_getPaymasterData',[op(relay),EP,'0x2105']),'target');
  const tampered=limitsWalletFeeCalls({wallet:W,feeTo:FT,fee:f.usdc-1n,changeCall:LIVE.change});assert.equal(await s.gate(id,'pm_getPaymasterData',[op(tampered),EP,'0x2105']),'calls_mismatch');
  const cheap=limitsWalletFeeCalls({wallet:W,feeTo:FT,fee:100n,changeCall:LIVE.change});const id2=s.registerLimitsWallet('p2',{owner:O,wallet:W,calls:cheap,reimburse:100n});
  assert.equal(await s.gate(id2,'pm_getPaymasterData',[op(cheap),EP,'0x2105']),'underpaid');
  assert.equal(mkS({maxPerDay:0}).registerLimitsWallet('p3',{owner:O,wallet:W,calls:c,reimburse:f.usdc}),null,'day cap -> no sponsor -> App stops');
  assert.equal(await s.gate('lw-unknown','pm_getPaymasterData',[op(c),EP,'0x2105']),'not_prepared');});
test('launch wiring: Pimlico proxy off, walletFee uses the existing sponsor and the official fee address',()=>{
  const launch=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(launch,/walletPaymaster|erc20PaymasterURL|pimlico_getTokenQuotes/);assert.match(launch,/registerLimitsWallet\?\.\(id,a\)/);assert.match(launch,/fee:async pl=>pl\?\.fromWallet\?limitsWalletFeeQuote/);
  assert.match(launch,/walletFee:\{feeTo:\(v=>v==='off'\?null:[^\n]*OP\.feeTo\)/);   // t1270: the official fee address comes from operatorConstants (src/v5/operator-constants.mjs)
  assert.match(launch,/available:\(\)=>\{const sp=SPONSOR_REF\(\);return !!sp&&!sp\.usdcGas&&!!sp\.withdrawAvailable\?\.\(\);\}/);});
