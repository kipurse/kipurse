// t1139 (decision 71, owner decision t1139 option a): resume after an emergency stop also lifts the ON-CHAIN pause with ONE owner-confirmed
// Base Account batch; network fee from the Kipurse wallet (actual cost, live quote, cap 0.01 USDC); "resumed" only after chain says so.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {encodeFunctionData,parseAbi,decodeFunctionData} from 'viem';
import {createOnboardSponsor,RESUME_PREFIX} from '../src/v5/onboard-sponsor.mjs';import {createMemoryKV} from '../src/v5/store.mjs';
import {resumeCalls,checkResumeCalls,resumeFee,unpauseCall,RESUME_FEE_TO,RESUME_FEE_CAP,RESUME_FEE_FROM,RESUME_CALL_GAS} from '../src/v5/resume-onchain.mjs';
import {LIMITS_SPONSOR_FLOOR_GAS} from '../src/v5/limits-fee.mjs';
const W='0x515010c2e41F98CdDd76B819EE69DC832c0939B6',T='0x65d2ce04da7ace81e7c4ab08712509282745ec84',O='0x1111111111111111111111111111111111111111',E='0x2222222222222222222222222222222222222222';
const live={gasPriceWei:5_000_000n,ethUsd8:300_000_000_000n};
const A=parseAbi(['function execute(address target,uint256 value,bytes data)','function setPaused(bool v)','function transfer(address,uint256) returns (bool)']);
test('resume calls: fee leg to the official fee address + wallet.execute(trust, setPaused(false)); checker refuses everything else',()=>{
  assert.equal(RESUME_FEE_TO,'0xf14ef5dc4723245866c22c749a0a84afceba0dd9');assert.equal(RESUME_FEE_CAP,10_000n);assert.equal(RESUME_FEE_FROM,'kipurse_wallet_fee');
  const c=resumeCalls({wallet:W,trust:T,fee:5_000n});assert.equal(c.length,2);assert.equal(checkResumeCalls(c,{wallet:W,trust:T}),5_000n);
  const d=decodeFunctionData({abi:A,data:c[1].data});assert.equal(d.functionName,'execute');assert.equal(d.args[0].toLowerCase(),T);assert.equal(d.args[1],0n);
  assert.deepEqual(decodeFunctionData({abi:A,data:d.args[2]}),{functionName:'setPaused',args:[false]});
  const pauseTrue={...c[1],data:encodeFunctionData({abi:A,functionName:'execute',args:[T,0n,encodeFunctionData({abi:A,functionName:'setPaused',args:[true]})]})};
  const other=resumeCalls({wallet:W,trust:T,feeTo:E,fee:5_000n});
  const bad={pauseTrue:[c[0],pauseTrue],otherTrust:[c[0],unpauseCall({wallet:W,trust:E})],otherFeeTo:other,onlyUnpause:[c[1]],three:[...c,c[1]],swapped:[c[1],c[0]],eth:[c[0],{...c[1],value:'0x1'}],
    otherWallet:[{...c[0],to:E},c[1]],over:[{...c[0],data:c[0].data.slice(0,-120)+(10_000).toString(16).padStart(64,'0')+'0'.repeat(56)},c[1]]};
  for(const [k,x] of Object.entries(bad))assert.equal(checkResumeCalls(x,{wallet:W,trust:T}),null,k);
  assert.throws(()=>resumeCalls({wallet:W,trust:T,fee:10_000n}),/fee cap/);assert.throws(()=>resumeCalls({wallet:W,trust:T,fee:0n}),/fee cap/);assert.throws(()=>resumeCalls({wallet:W,trust:W,fee:1n}),/fee parties/);});
test('resume fee: actual cost, floor = sponsor underpaid floor, wallet_low / fee_above_cap reasons, 0% markup',()=>{
  const f=resumeFee({callGas:35_000n,...live,walletUSDC:20_000_000n});assert.equal(f.reason,null);assert.ok(f.usdc>0n&&f.usdc<10_000n);
  assert.ok(f.wei>=LIMITS_SPONSOR_FLOOR_GAS*live.gasPriceWei,'never below the sponsor floor');
  assert.equal(resumeFee({callGas:null,...live,walletUSDC:20_000_000n}).gas,RESUME_CALL_GAS+150_000n+40_000n);
  assert.equal(resumeFee({callGas:35_000n,...live,walletUSDC:f.usdc-1n}).reason,'wallet_low');
  assert.equal(resumeFee({callGas:35_000n,gasPriceWei:5_000_000_000n,ethUsd8:live.ethUsd8,walletUSDC:20_000_000n}).reason,'fee_above_cap');});
const EXEC=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);const EP='0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const op=(cs,o={})=>({sender:O,callData:encodeFunctionData({abi:EXEC,functionName:'executeBatch',args:[cs.map(c=>({target:c.to,value:BigInt(c.value),data:c.data}))]}),callGasLimit:'0x30d40',verificationGasLimit:'0x30d40',preVerificationGas:'0xc350',maxFeePerGas:'0x4c4b40',...o});
test('sponsor: ur- kind fronts gas only for the exact resume batch from the owner, same caps and underpaid check',async()=>{
  const mkS=(cfg={})=>createOnboardSponsor({onboardOn:true,cfg:{url:'https://pm.example/x',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25,...cfg},kv:createMemoryKV(),reg:{byOwner:()=>[{wallet:W}]},
    ethUsd8:async()=>live.ethUsd8,lookup:()=>null,gasPrice:async()=>live.gasPriceWei,fetchImpl:async()=>({json:async()=>({result:{paymaster:'0x9',paymasterData:'0x'}})})});
  const f=resumeFee({callGas:35_000n,...live,walletUSDC:20_000_000n});const c=resumeCalls({wallet:W,trust:T,fee:f.usdc});
  const s=mkS();const id=s.registerResume('aa',{owner:O,wallet:W,calls:c,reimburse:f.usdc});assert.equal(id,RESUME_PREFIX+'aa');assert.match(id,/^ur-/);
  assert.equal(await s.gate(id,'pm_getPaymasterData',[op(c),EP,'0x2105']),null,'quoted fee passes the underpaid re-check');
  assert.equal(await s.gate(id,'pm_getPaymasterData',[op(c,{sender:E}),EP,'0x2105']),'sender');
  assert.equal(await s.gate(id,'pm_getPaymasterData',[op([c[0],unpauseCall({wallet:W,trust:E})]),EP,'0x2105']),'calls_mismatch');
  assert.equal(await s.gate(id,'pm_getPaymasterData',[op([c[0],{to:T,value:'0x0',data:'0x16c38b3c'+'0'.repeat(64)}]),EP,'0x2105']),'target','direct trust call (not via the wallet) refused');
  const cheap=resumeCalls({wallet:W,trust:T,fee:100n});const id2=s.registerResume('bb',{owner:O,wallet:W,calls:cheap,reimburse:100n});
  assert.equal(await s.gate(id2,'pm_getPaymasterData',[op(cheap),EP,'0x2105']),'underpaid');
  assert.equal(mkS({maxPerDay:0}).registerResume('cc',{owner:O,wallet:W,calls:c,reimburse:f.usdc}),null,'day cap -> no sponsor -> 503, nothing sent');
  assert.equal(await s.gate('ur-unknown','pm_getPaymasterData',[op(c),EP,'0x2105']),'not_prepared');});
test('launch wiring: ok only after isPaused(wallet)==false on chain; no plan -> no resume; stop voids plans; rearm never re-pauses a resume in flight',()=>{
  const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(L,/const cp=await chainPaused\(\);if\(cp===null\)return j\(503,\{error:'chain_unknown'/);
  assert.match(L,/if\(cp===false\)\{RP\.clear\(\);OBS\.log\('safety_resume',\{ok:true,chain:'not_paused'\}\);return j\(200,/);
  assert.match(L,/return j\(202,\{state:'confirm_on_chain'/);
  assert.match(L,/const settleResume=async\(\)=>\{const live=rpLive\(\);if\(!live\.length\)return null;const cp=await chainPaused\(\);if\(cp!==false\)return false;\s*SAFE\.resume\(R\.wallet\)/);
  assert.match(L,/const rearm=async\(\)=>\{try\{if\(rpLive\(\)\.length\)\{await settleResume\(\);return;\}/);
  assert.match(L,/RP\.clear\(\);const p=SAFE\.pause\(R\.wallet,'owner_stop',ms\)/);
  assert.match(L,/sp\.registerResume\?\.\(id,/);assert.doesNotMatch(L,/KIPURSE_GAS_PAYMASTER=erc20_usdc/);
  // exactly one SAFE.resume call outside settleResume, and it sits behind cp===false
  const n=(L.match(/SAFE\.resume\(R\.wallet\)/g)||[]).length;assert.equal(n,2);});
