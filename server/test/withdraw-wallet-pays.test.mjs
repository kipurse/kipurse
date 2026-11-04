// t752 (owner): withdraw fee paid from the WALLET's own USDC, not the owner's Base Account.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {execSync} from 'node:child_process';
import {encodeFunctionData,parseAbi} from 'viem';
import {createOwnerWithdraw,withdrawCallsWalletPays,checkWalletPaysCalls,checkWithdrawCalls,WITHDRAW_MAX_WALLET_FEE} from '../src/v5/owner-withdraw.mjs';
import {createOnboardSponsor,callsHash} from '../src/v5/onboard-sponsor.mjs';import {createMemoryKV} from '../src/v5/store.mjs';
const W='0x1000000000000000000000000000000000000004',O='0x2000000000000000000000000000000000000002',T='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',F='0xc0dedd749573f2e967a4ba53190c27ffbc2f8b31',FEE='0x3000000000000000000000000000000000000003',V='0x4000000000000000000000000000000000000004',EVIL='0x6666666666666666666666666666666666666666';
const pub=ob=>{let o=ob;return {readContract:async({functionName,args})=>functionName==='isOwnerAddress'?true:functionName==='balanceOf'?(args[0]===W?20_000_000n:o):[0n,300000000000n,0n,0n,0n],estimateGas:async()=>60000n,getGasPrice:async()=>10_000_000n,set:x=>{o=x;}};};
const req=async(M,method,path,body={})=>{let code,b='';await M.handle({method,headers:{'accept-language':'zh-CN'}},{writeHead(c){code=c;},setHeader(){},end(x){b=String(x??'');}},new URL('https://x'+path),{readBody:async()=>body,ip:'1'});return {code,b,j:(()=>{try{return JSON.parse(b);}catch{return null;}})()};};
const wp=(reg=[])=>({available:()=>true,register:async(id,a)=>{reg.push(a);return 'https://x/onboard/new/paymaster?id=wd-'+id;}});
const mk=(o={})=>createOwnerWithdraw({pub:pub(0n),wallet:W,owner:O,token:T,feed:F,script:()=>'',...o});

test('wallet-pays batch: fee to the fixed address, rest to the owner; checker refuses anything else',()=>{
  const c=withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:20_000n,feeTo:FEE});assert.equal(c.length,2);
  assert.equal(checkWalletPaysCalls(c,{wallet:W,owner:O,token:T,feeTo:FEE}),null);assert.equal(checkWalletPaysCalls(c,{wallet:W,owner:O,token:T,feeTo:null}),'no_fee_address');
  assert.equal(checkWalletPaysCalls(withdrawCallsWalletPays({wallet:W,owner:EVIL,token:T,amount:20_000_000n,fee:20_000n,feeTo:FEE}),{wallet:W,owner:O,token:T,feeTo:FEE}),'destination_not_owner');
  assert.equal(checkWalletPaysCalls(withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:20_000n,feeTo:EVIL}),{wallet:W,owner:O,token:T,feeTo:FEE}),'fee_not_to_fee_address');
  assert.throws(()=>withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:WITHDRAW_MAX_WALLET_FEE+1n,feeTo:FEE}));
  const v=withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:20_000n,feeTo:FEE,vault:V});assert.equal(checkWalletPaysCalls(v,{wallet:W,owner:O,token:T,feeTo:FEE,vault:V}),null);
  assert.notEqual(checkWithdrawCalls(c,{wallet:W,owner:O,token:T}),null);});

test('quote + page: wallet pays when configured; owner-short fee card disappears; shows what you receive',async()=>{
  const M=mk({feeTo:FEE,walletPays:wp()});const q=(await req(M,'POST','/owner/withdraw/quote')).j;
  assert.equal(q.feePaidBy,'wallet');assert.ok(BigInt(q.walletPays.fee)>0n&&BigInt(q.walletPays.fee)<=WITHDRAW_MAX_WALLET_FEE);assert.equal(BigInt(q.walletPays.receive)+BigInt(q.walletPays.fee),20_000_000n);
  const h=(await req(M,'GET','/owner/withdraw')).b;assert.match(h,/你会收到/);assert.match(h,/从钱包里扣/);assert.doesNotMatch(h,/id=kpw-fee/);assert.doesNotMatch(h,/#c81e1e/i);
  // off by default (no fee address) -> old behaviour unchanged
  const off=mk();const q0=(await req(off,'POST','/owner/withdraw/quote')).j;assert.equal(q0.walletPays,null);assert.equal(q0.feePaidBy,'owner_base_account');assert.match((await req(off,'GET','/owner/withdraw')).b,/id=kpw-fee/);
  const busy=mk({feeTo:FEE,walletPays:{...wp(),available:()=>false}});assert.equal((await req(busy,'POST','/owner/withdraw/quote')).j.walletPays,null);});

test('prepare: wallet shape only when the page asks AND the sponsor registers it; old pages keep the old shape',async()=>{const reg=[];
  const M=mk({feeTo:FEE,walletPays:wp(reg)});const old=(await req(M,'POST','/owner/withdraw/prepare',{})).j;assert.equal(old.feeFrom,'owner');assert.equal(old.calls.length,1);assert.equal(reg.length,0);
  const n=(await req(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet',to:EVIL,feeTo:EVIL})).j;assert.equal(n.feeFrom,'wallet');assert.equal(n.feeTo,FEE);assert.equal(n.owner,O);
  assert.match(n.paymaster,/\/onboard\/new\/paymaster\?id=wd-/);assert.equal(checkWalletPaysCalls(n.calls,{wallet:W,owner:O,token:T,feeTo:FEE}),null);assert.equal(reg[0].reimburse,BigInt(n.fee));
  const no=mk({feeTo:FEE,walletPays:{available:()=>true,register:async()=>null}});assert.equal((await req(no,'POST','/owner/withdraw/prepare',{feeFrom:'wallet'})).j.feeFrom,'owner','sponsor refused -> safe old plan');});

test('confirm: wallet-pays succeeds when the owner got amount minus fee',async()=>{const p=pub(0n);const M=mk({pub:p,feeTo:FEE,walletPays:wp()});
  const n=(await req(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet'})).j;p.set(BigInt(n.receive));const r=(await req(M,'POST','/owner/withdraw/confirm',{id:n.id})).j;
  assert.equal(r.ok,true);assert.equal(r.feeFrom,'wallet');assert.equal(r.received,n.receive);assert.equal(r.fee,n.fee);});

const EXEC=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);const EP='0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const op=(cs,o={})=>({sender:O,callData:encodeFunctionData({abi:EXEC,functionName:'executeBatch',args:[cs.map(c=>({target:c.to,value:BigInt(c.value),data:c.data}))]}),callGasLimit:'0x1e8480',verificationGasLimit:'0x30d40',preVerificationGas:'0xc350',maxFeePerGas:'0x5b8d80',...o});
test('sponsor: withdraw kind fronts gas only for the exact batch that repays at least the gas cost',async()=>{
  const mkS=(cfg={})=>createOnboardSponsor({cfg:{url:'https://pm.example/x',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25,...cfg},kv:createMemoryKV(),reg:{byOwner:()=>[{wallet:W}]},ethUsd8:async()=>300000000000n,lookup:()=>null,
    fetchImpl:async()=>({json:async()=>({result:{paymaster:'0x9',paymasterData:'0x'}})})});
  const c=withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:50_000n,feeTo:FEE});let s=mkS();
  const id=s.registerWithdraw('p1',{owner:O,wallet:W,calls:c,reimburse:50_000n});assert.match(id,/^wd-/);
  assert.equal(await s.gate(id,'pm_getPaymasterData',[op(c),EP,'0x2105']),null,'existing wallet owners ARE allowed for withdraw (not once-per-owner)');
  assert.equal(await s.gate(id,'pm_getPaymasterData',[op(c),EP,'0x2105']),null,'retry ok');
  const c2=withdrawCallsWalletPays({wallet:W,owner:EVIL,token:T,amount:20_000_000n,fee:50_000n,feeTo:FEE});assert.equal(await s.gate(id,'pm_getPaymasterData',[op(c2),EP,'0x2105']),'calls_mismatch');
  const cheap=withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:1_000n,feeTo:FEE});const id2=s.registerWithdraw('p2',{owner:O,wallet:W,calls:cheap,reimburse:1_000n});
  assert.equal(await s.gate(id2,'pm_getPaymasterData',[op(cheap),EP,'0x2105']),null,'worst-case gas is not compared to the small real fee');
  assert.equal(await s.gate(id2,'pm_getPaymasterData',[op(cheap,{maxFeePerGas:'0x3b9aca00'}),EP,'0x2105']),'op_cap','per-op cap still applies');
  assert.equal(mkS({maxPerDay:0}).registerWithdraw('p3',{owner:O,wallet:W,calls:c,reimburse:50_000n}),null,'day cap -> no sponsor -> page falls back');
  assert.equal(await s.gate('wd-unknown','pm_getPaymasterData',[op(c),EP,'0x2105']),'not_prepared');
  const lim=s.registerFirstLimits?.('L',{owner:O,wallet:W,calls:c});void lim;});

// the guard header in the shipped page script: decide wallet-pays batches with NO server input
const hdr=fee=>{const s=fs.readFileSync('owner-sign/consent/withdraw.js','utf8');const g=s.slice(0,s.indexOf('var KPEN='));return new Function('location','document','crypto',g.replace("var KPFEETO='';",`var KPFEETO='${fee}';`)+';return {kpVH,kpVHWP};');};
const send=(calls,from=O)=>({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x2105',from,atomicRequired:true,calls,capabilities:{paymasterService:{url:'https://x/p'}}}]});
test('page guard: wallet-pays batch allowed only to signer + baked-in fee address, fee <= 0.25; off when not baked in',async()=>{
  const G=hdr(FEE)({hash:'',pathname:'/'},{documentElement:{lang:'zh'}},globalThis.crypto);const ok=withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:20_000n,feeTo:FEE});
  assert.ok(await G.kpVH(send(ok)));assert.ok(await G.kpVH(send(withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:20_000n,feeTo:FEE,vault:V}))));
  await assert.rejects(G.kpVH(send(ok,EVIL)),'signer must be the receiver');
  await assert.rejects(G.kpVH(send(withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:20_000n,feeTo:EVIL}))));
  await assert.rejects(G.kpVH(send([ok[1],ok[0]])),'order swapped -> owner would be the "fee" leg');await assert.rejects(G.kpVH(send([ok[1]])),'single call is not this shape');
  const big=withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:250_000n,feeTo:FEE});assert.ok(await G.kpVH(send(big)),'0.25 allowed');big[0]={...big[0],data:big[0].data.replace('000003d090','000003d091')};await assert.rejects(G.kpVH(send(big)),'fee over 0.25');
  await assert.rejects(G.kpVH({...send(ok),params:[{...send(ok).params[0],chainId:'0x1'}]}),'Base only');
  const OFF=hdr('')({hash:'',pathname:'/'},{documentElement:{lang:'zh'}},globalThis.crypto);await assert.rejects(OFF.kpVH(send(ok)),'off without a baked-in fee address');
  for(const f of ['owner-sign/static/withdraw.js'])assert.match(fs.readFileSync(f,'utf8'),/kpVHWP/);});

// t763u: Kipurse never keeps a cost
import {WITHDRAW_REAL_GAS} from '../src/v5/owner-withdraw.mjs';
test('t763u: withdraw fee >= realistic real cost (300k gas x 1.4) and carries any dues; dues marked paid on confirm',async()=>{
  let paid=0n;const p=pub(0n);const M=mk({pub:p,feeTo:FEE,walletPays:{...wp(),dues:()=>30_000n,paid:n=>{paid+=n;}}});const q=(await req(M,'POST','/owner/withdraw/quote')).j.walletPays;
  const per=600n/60000n;void per;const sane=(BigInt(q.gasFee));const realNow=WITHDRAW_REAL_GAS*10_000_000n*3000n/10n**12n; // 300k x 0.01 gwei x $3000 in USDC atomic
  assert.ok(sane>=realNow,`gasFee ${sane} >= real ${realNow}`);assert.equal(BigInt(q.fee),BigInt(q.gasFee)+30_000n);assert.equal(q.dues,'30000');
  const n=(await req(M,'POST','/owner/withdraw/prepare',{feeFrom:'wallet'})).j;assert.equal(n.dues,'30000');p.set(BigInt(n.receive));assert.equal((await req(M,'POST','/owner/withdraw/confirm',{id:n.id})).j.ok,true);assert.equal(paid,30_000n);});
test('t763u: sponsor refuses a withdraw whose fee is below the sane real cost now; onboarding gas becomes wallet dues',async()=>{
  const mkS=gp=>createOnboardSponsor({cfg:{url:'https://pm.example/x',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25},kv:createMemoryKV(),reg:{byOwner:()=>[]},ethUsd8:async()=>300000000000n,lookup:id=>id==='n1'?{state:'prepared',kind:'new',owner:O,expect:O,wallet:W,callsHash:callsHash(c),allowed:[W]}:null,gasPrice:async()=>gp,
    fetchImpl:async()=>({json:async()=>({result:{paymaster:'0x9',paymasterData:'0x'}})})});
  const c=withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:20_000_000n,fee:20_000n,feeTo:FEE});let s=mkS(10_000_000n); // real now = 300k*0.01gwei*1.1*$3000 = 0.0099
  assert.equal(await s.gate(s.registerWithdraw('a',{owner:O,wallet:W,calls:c,reimburse:20_000n}),'pm_getPaymasterData',[op(c),EP,'0x2105']),null);
  assert.equal(await s.gate(s.registerWithdraw('b',{owner:O,wallet:W,calls:c,reimburse:5_000n}),'pm_getPaymasterData',[op(c),EP,'0x2105']),'underpaid');
  s=mkS(10_000_000n);assert.equal(await s.gate('n1','pm_getPaymasterData',[op(c),EP,'0x2105']),null);s.markDone('n1',O,W);assert.ok(s.dues(W)>0n,'onboarding gas owed by the wallet');
  const d=s.dues(W);assert.equal(s.payDue(W,d+5n),d);assert.equal(s.dues(W),0n);});
