// t767u: new wallets set the vault fee slot to Kipurse's ops account (repay fronted onboarding gas from AI payments), only for apps that can check it.
import test from 'node:test';import assert from 'node:assert/strict';import {decodeFunctionData,parseAbi,getAddress} from 'viem';
import {buildMigrationPlanV5} from '../src/v5/plan.mjs';import {DUES_SLOT,DUES_SLOT_NOTE} from '../src/v5/onboard-new.mjs';
const W='0x1000000000000000000000000000000000000001',O='0x2000000000000000000000000000000000000002',AD='0xc7d7c8b03e94576bc3c99a7e37827e07f7d9a4e8',V='0x4000000000000000000000000000000000000004',EX='0x5000000000000000000000000000000000000005';
const plan=zr=>buildMigrationPlanV5({chainId:8453,wallet:W,owner:O,adapter:AD,trust:AD,token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',executor:EX,headroom:false,maxFeePpm:'1000',maxNetworkFee:'50000',fee:{ppm:'1000'},
  stated:{single:'5000000',daily:'20000000',term:'100000000',openSingle:'1000000',openDaily:'2000000',verifiedSingle:'5000000',verifiedDaily:'20000000'},start:1800000000,end:1800000000+90*86400,salt:1n,revoke:[],zeroReserve:zr});
const inner=pl=>decodeFunctionData({abi:parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']),data:pl.walletExecuteBatch.data}).args[0];
test('dues slot: cap is 0.05 USDC per op to the fixed ops account; plain zh/en note',{skip:'OSS copy: frozen vector/fixture tied to operator addresses or the operator App Attest fixture; regenerate with your own values'},()=>{assert.equal(DUES_SLOT.maxPerOp,50_000n);assert.equal(getAddress(DUES_SLOT.to),'0xf14ef5dc4723245866c22c749a0a84afceba0dd9');
  assert.match(DUES_SLOT_NOTE.zh,/0\.05 USDC.*自动扣一次/);assert.match(DUES_SLOT_NOTE.en,/0\.05 USDC.*once/);assert.doesNotMatch(DUES_SLOT_NOTE.zh,/网络费|签名/);});
test('dues slot: setBundlerFee(ops, 0.05) is the LAST inner call, after registerPermission deploys the vault; absent without the flag',{skip:'OSS copy: frozen vector/fixture tied to operator addresses or the operator App Attest fixture; regenerate with your own values'},()=>{
  const off=inner(plan({vault:V,buffer:0}));const on=inner(plan({vault:V,buffer:0,bundlerFee:DUES_SLOT}));assert.equal(on.length,off.length+1);
  const last=on[on.length-1];assert.equal(getAddress(last.target),V);const d=decodeFunctionData({abi:parseAbi(['function setBundlerFee(address to,uint96 maxPerOp)']),data:last.data});
  assert.equal(getAddress(d.args[0]),getAddress(DUES_SLOT.to));assert.equal(d.args[1],50_000n);
  const reg=on.findIndex(c=>getAddress(c.target)===getAddress(AD));assert.ok(reg>=0&&reg<on.length-1,'vault is deployed (registerPermission) before the slot is set');
  assert.match(plan({vault:V,buffer:0,bundlerFee:DUES_SLOT}).calls.map(c=>c.label).join('\n'),/account-opening fee fronted by Kipurse: 0\.05 USDC taken once/);});
