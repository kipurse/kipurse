// SPDX-License-Identifier: AGPL-3.0-only
// t1346 (decision 169, owner t1302): every fee leg pays the company Safe; the old placeholder 0xf14E…0Dd9 and the old ops account
// 0xfc0E…345B are refused by config, env, builders and checkers.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {COMPANY_FEE_TO,RETIRED_FEE_TO,isRetiredFeeTo,assertFeeToUsable,operatorConstants} from '../src/v5/operator-constants.mjs';
import {KIPURSE_FEE_TO,usdcCallProblem,USDC_BASE} from '../src/v5/usdc-gas.mjs';
import {LIMITS_OFFICIAL_FEE_TO,limitsWalletFeeCalls,checkLimitsWalletFeeCalls} from '../src/v5/limits-fee.mjs';
import {DUES_SLOT} from '../src/v5/onboard-new.mjs';
import {FEE_TO as MIGRATE_FEE_TO} from '../src/v5/migrate-v54.mjs';
import {V55} from '../src/v5/suite-v55.mjs';
import {RESUME_FEE_TO,resumeCalls,checkResumeCalls} from '../src/v5/resume-onchain.mjs';
import {withdrawCallsWalletPays,checkWalletPaysCalls} from '../src/v5/owner-withdraw.mjs';
import {encodeFunctionData,parseAbi,getAddress} from 'viem';
const SAFE='0x82ecF6e2F76eE100E4676dabe193bca6bcab64fD',OLD='0xf14EF5Dc4723245866c22C749A0A84AFCebA0Dd9',OPS='0xfc0E68572cDba016c1c90A45E1792f3fE0EE345B';
const W='0x1000000000000000000000000000000000000001',O='0x2000000000000000000000000000000000000002',T='0x3000000000000000000000000000000000000003';
const lc=a=>String(a).toLowerCase();
test('the company Safe is the one fee address in every server constant',()=>{
  assert.equal(COMPANY_FEE_TO,SAFE);assert.equal(getAddress(COMPANY_FEE_TO),SAFE);
  for(const [n,a] of Object.entries({KIPURSE_FEE_TO,LIMITS_OFFICIAL_FEE_TO,DUES_SLOT:DUES_SLOT.to,MIGRATE_FEE_TO,V55:V55.feeTo,RESUME_FEE_TO}))assert.equal(lc(a),lc(SAFE),n);
  const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  // the operator's launcher has a built-in default = the Safe; the open-source launcher has none (operator config only)
  const D=L.match(/OPERATOR_DEFAULTS=Object\.freeze\(\{feeTo:'(0x[0-9a-fA-F]{40})'/);
  if(D)assert.equal(D[1].toLowerCase(),lc(SAFE));else assert.match(L,/const OPERATOR_DEFAULTS=Object\.freeze\(\{\}\);/);
  assert.match(L,/assertFeeToUsable\(process\.env\.KIPURSE_WITHDRAW_FEE_TO,'KIPURSE_WITHDRAW_FEE_TO'\)/);
  const P=fs.readFileSync(new URL('../owner-sign/static/withdraw.js',import.meta.url),'utf8');assert.match(P,new RegExp(`KPFEETO='${lc(SAFE)}'`));});
test('retired addresses: listed, refused by config and env check',()=>{
  assert.deepEqual([...RETIRED_FEE_TO],[lc(OLD),lc(OPS)]);assert.ok(isRetiredFeeTo(OLD)&&isRetiredFeeTo(OPS)&&isRetiredFeeTo(' '+lc(OLD)+' '));assert.ok(!isRetiredFeeTo(SAFE)&&!isRetiredFeeTo(undefined)&&!isRetiredFeeTo('off'));
  for(const a of [OLD,OPS,lc(OLD)]){assert.throws(()=>operatorConstants({feeTo:a}),/retired fee address/);assert.throws(()=>operatorConstants(undefined,{feeTo:a}),/retired fee address/);assert.throws(()=>assertFeeToUsable(a,'KIPURSE_WITHDRAW_FEE_TO'),/retired/);}
  assert.equal(operatorConstants({feeTo:SAFE}).feeTo,SAFE);assert.equal(assertFeeToUsable(undefined),undefined);assert.equal(assertFeeToUsable('off'),'off');});
test('no retired address is written anywhere else in the running server code',()=>{
  const bad=[];const walk=d=>{for(const e of fs.readdirSync(new URL(d,import.meta.url),{withFileTypes:true})){const p=d+e.name;if(e.isDirectory()){if(e.name!=='node_modules')walk(p+'/');continue;}
    if(!/\.(mjs|js|json)$/.test(e.name)||e.name.includes('.pre-'))continue;const s=fs.readFileSync(new URL(p,import.meta.url),'utf8').toLowerCase();
    if(p.endsWith('src/v5/operator-constants.mjs'))continue;for(const r of RETIRED_FEE_TO)if(s.includes(r.slice(2)))bad.push(p);}};
  for(const d of ['../src/','../mainnet/','../kit/','../owner-sign/'])walk(d);assert.deepEqual(bad,[]);});
test('builders refuse a retired fee address; checkers reject batches paying it',()=>{
  const USDC=getAddress(USDC_BASE),A=parseAbi(['function transfer(address,uint256)']);
  // withdraw (wallet pays)
  for(const r of [OLD,OPS])assert.throws(()=>withdrawCallsWalletPays({wallet:W,owner:O,token:USDC,amount:1_000_000n,fee:5_000n,feeTo:r}),e=>e.code==='fee_retired_address');
  const good=withdrawCallsWalletPays({wallet:W,owner:O,token:USDC,amount:1_000_000n,fee:5_000n,feeTo:SAFE});
  assert.equal(checkWalletPaysCalls(good,{wallet:W,owner:O,token:USDC,feeTo:SAFE}),null);
  assert.equal(checkWalletPaysCalls(good,{wallet:W,owner:O,token:USDC,feeTo:OLD}),'fee_retired_address');
  // limits (wallet pays)
  const change={to:W,value:'0x0',data:'0x34fcd5be'+'0'.repeat(64)};
  assert.throws(()=>limitsWalletFeeCalls({wallet:W,feeTo:OLD,fee:3000n,changeCall:change}),e=>e.code==='fee_parties');
  const lim=limitsWalletFeeCalls({wallet:W,feeTo:SAFE,fee:3000n,changeCall:change});
  assert.equal(checkLimitsWalletFeeCalls(lim,{wallet:W,feeTo:SAFE}),3000n);assert.equal(checkLimitsWalletFeeCalls(lim,{wallet:W,feeTo:OPS}),null);
  // resume
  assert.throws(()=>resumeCalls({wallet:W,trust:T,feeTo:OLD,fee:3000n}),e=>e.code==='fee_parties');
  const rs=resumeCalls({wallet:W,trust:T,fee:3000n});assert.equal(checkResumeCalls(rs,{wallet:W,trust:T}),3000n);assert.equal(checkResumeCalls(rs,{wallet:W,trust:T,feeTo:OLD}),null);
  assert.ok(lc(rs[0].data).includes(lc(SAFE).slice(2)),'resume fee leg pays the Safe');
  // same-tx repay leg: transfer to the Safe ok, to the old placeholder refused
  const tr=to=>({to:USDC,value:'0x0',data:encodeFunctionData({abi:A,functionName:'transfer',args:[to,1000n]})});
  assert.equal(usdcCallProblem(tr(SAFE),{wallet:W}),null);assert.equal(usdcCallProblem(tr(OLD),{wallet:W}),'transfer');assert.equal(usdcCallProblem(tr(SAFE),{wallet:W,feeTo:OLD}),'retired_fee_address');});
test('records: fees paid to a retired address before the switch still read as fees (server ledger = App ChainLedger rule)',async()=>{
  const {classify}=await import('../src/v5/ledger.mjs');
  const rows=classify([{tx:'0xa',block:1,logIndex:0,from:W,to:lc(OLD),value:1000n,t:1},{tx:'0xb',block:2,logIndex:0,from:W,to:lc(SAFE),value:2000n,t:2},
    {tx:'0xc',block:3,logIndex:0,from:W,to:lc(O),value:500000n,t:3},{tx:'0xc',block:3,logIndex:1,from:W,to:lc(OPS),value:3000n,t:3}],{wallet:W,vault:T,owner:O,feeTo:SAFE});
  assert.deepEqual(rows.map(r=>r.kind),['walletfee','walletfee','withdraw']);assert.equal(String(rows[2].detail?.fee),'3000');});
