// t1185 (decision 85): V5.3 vault = at most opsPerDay() session userOps per UTC day; nonce key = UTC day; calm refusal when used up.
import test from 'node:test';import assert from 'node:assert/strict';
import {parseAbi,decodeFunctionData,getAddress} from 'viem';import {privateKeyToAccount} from 'viem/accounts';
import {createUserOpWriter,opsToday,opsUsedUp,opsResetAt,SEQ_MASK,DAY,setOpsPerDayCall} from '../src/v5/userop.mjs';
import {buildMigrationPlanV5} from '../src/v5/plan.mjs';import {checkLimits} from '../src/v5/limits-public.mjs';import {amountProblems} from '../src/v5/usdc-out.mjs';
const USDC='0x036CbD53842c5426634e7929541eC2318f3dCF7e',VAULT='0x00000000000000000000000000000000000fa017',AD='0xB7605ee94db64a097A436ab31A5075155121A45F';
const session=privateKeyToAccount('0x'+'5e'.repeat(32));
const NOW=1_800_000_000+3600;const DAYK=BigInt(Math.floor(NOW/DAY));
function fakes({cap=500n,used=0n,v53=true,now=NOW}={}){const sent=[],reads=[];
  const pub={getBlock:async()=>({timestamp:BigInt(now)}),estimateFeesPerGas:async()=>({maxFeePerGas:2000000n,maxPriorityFeePerGas:1000000n}),
    readContract:async({functionName,args})=>{reads.push({functionName,args});if(functionName==='opsPerDay'){if(!v53)throw Error('execution reverted');return cap;}
      if(functionName==='getNonce'){const k=BigInt(args[1]);return (k<<64n)|(k===0n?7n:used);}if(functionName==='DOMAIN_SEPARATOR')return '0x'+'ab'.repeat(32);return 0n;}};
  const bundlerFetch=async(url,{body})=>{const {method,params,id}=JSON.parse(body);sent.push({method,params});let result;
    if(method==='pimlico_getUserOperationGasPrice')result={standard:{maxFeePerGas:'0x1e8480',maxPriorityFeePerGas:'0xf4240'}};
    if(method==='eth_estimateUserOperationGas')result={callGasLimit:'0x30d40',verificationGasLimit:'0x186a0',preVerificationGas:'0xc350',paymasterVerificationGasLimit:'0x249f0',paymasterPostOpGasLimit:'0x9c40'};
    if(method==='eth_sendUserOperation')result='0x'+'77'.repeat(32);
    if(method==='eth_getUserOperationReceipt')result={success:true,actualGasUsed:'0x1',actualGasCost:'0x1',receipt:{transactionHash:'0x'+'88'.repeat(32),blockNumber:'0x10',logs:[]}};
    return {json:async()=>({jsonrpc:'2.0',id,result})};};
  const w=createUserOpWriter({cfg:{chainId:84532,token:USDC,bundlerFetch,userOp:{pollMs:1,midnightGuardS:0}},pub,session,vault:VAULT,adapter:AD,maxGasPerOp:50000n});
  return {sent,reads,pub,w};}
test('opsToday: V5.3 vault -> cap / used / left / reset at 00:00 UTC; older vault -> unsupported',async()=>{
  const a=fakes({cap:500n,used:12n});const t=await opsToday({pub:a.pub,vault:VAULT});
  assert.equal(t.supported,true);assert.equal(t.cap,500n);assert.equal(t.used,12n);assert.equal(t.left,488n);assert.equal(t.day,DAYK);assert.equal(t.resetsAtUnix,(Number(DAYK)+1)*DAY);
  assert.equal((await opsToday({pub:fakes({v53:false}).pub,vault:VAULT})).supported,false);
  assert.equal((await opsToday({pub:fakes({cap:0n}).pub,vault:VAULT})).supported,false,'0 is never a real V5.3 answer');});
test('V5.3 vault: the userOp nonce key is the UTC day, the sequence is today\'s count',async()=>{
  const {sent,w}=fakes({cap:500n,used:41n});await w.write('collectFees',[]);
  const op=sent.find(x=>x.method==='eth_sendUserOperation').params[0];const n=BigInt(op.nonce);
  assert.equal(n>>64n,DAYK);assert.equal(n&SEQ_MASK,41n);});
test('older vault: unchanged nonce key 0 (no time window, no cap)',async()=>{
  const {sent,w}=fakes({v53:false});await w.write('collectFees',[]);const n=BigInt(sent.find(x=>x.method==='eth_sendUserOperation').params[0].nonce);assert.equal(n>>64n,0n);assert.equal(n&SEQ_MASK,7n);});
test('used up: nothing is estimated or sent; a calm, retryable error with the reset time',async()=>{
  const {sent,w}=fakes({cap:3n,used:3n});await assert.rejects(w.write('collectFees',[]),e=>e.code==='daily_ops_used_up'&&e.cap==='3'&&e.used==='3'&&e.resetsAtUnix===(Number(DAYK)+1)*DAY);
  assert.equal(sent.length,0,'no bundler call at all');
  const {sent:s2,w:w2}=fakes({cap:4n,used:3n});await w2.write('collectFees',[]);assert.ok(s2.some(x=>x.method==='eth_sendUserOperation'),'owner raised the cap -> resumes the same day');});
test('midnight guard: an op is never signed in the last seconds of a UTC day (it waits for the new day)',async()=>{
  const end=(Number(DAYK)+1)*DAY;const T0=Date.now();const reads=[];
  const pub={getBlock:async()=>({timestamp:BigInt(Date.now()-T0>1500?end+5:end-2)}),estimateFeesPerGas:async()=>({maxFeePerGas:1n,maxPriorityFeePerGas:1n}),readContract:async({functionName,args})=>{reads.push(functionName);if(functionName==='opsPerDay')return 500n;if(functionName==='getNonce')return BigInt(args[1])<<64n;return functionName==='DOMAIN_SEPARATOR'?'0x'+'ab'.repeat(32):0n;}};
  const sent=[];const bundlerFetch=async(u,{body})=>{const {method,params,id}=JSON.parse(body);sent.push({method,params});const r={pimlico_getUserOperationGasPrice:{standard:{maxFeePerGas:'0x1',maxPriorityFeePerGas:'0x1'}},eth_estimateUserOperationGas:{callGasLimit:'0x1',verificationGasLimit:'0x1',preVerificationGas:'0x1'},eth_sendUserOperation:'0x'+'77'.repeat(32),eth_getUserOperationReceipt:{success:true,actualGasUsed:'0x1',actualGasCost:'0x1',receipt:{transactionHash:'0x'+'88'.repeat(32),blockNumber:'0x1',logs:[]}}}[method];return {json:async()=>({jsonrpc:'2.0',id,result:r})};};
  const w=createUserOpWriter({cfg:{chainId:84532,token:USDC,bundlerFetch,userOp:{pollMs:1,midnightGuardS:5}},pub,session,vault:VAULT,adapter:AD,maxGasPerOp:50000n});
  const t0=Date.now();await w.write('collectFees',[]);assert.ok(Date.now()-t0>=4000,'waited for the new UTC day');
  const n=BigInt(sent.find(x=>x.method==='eth_sendUserOperation').params[0].nonce);assert.equal(n>>64n,DAYK+1n,'new day key');});
test('calm refusal text: nothing paid, resets 00:00 UTC, owner can raise; amounts rule (decision 80) clean',async()=>{
  const e=opsUsedUp({cap:500n,used:500n,nowS:NOW});assert.equal(e.resetsAtUnix,opsResetAt(NOW));
  const {engineFor,direct}=await import('./helpers/v5-fixture.mjs');const {mkdtempSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const x=engineFor({ownerRulesDir:mkdtempSync(join(tmpdir(),'ops-'))},{bal:1000000000n});
  const orig=x.client.write;let calls=0;x.client.write=async(...a)=>{calls++;throw opsUsedUp({cap:500n,used:500n,nowS:NOW});};
  const r=await x.engine.pay({request:direct('20000','ops-1'),idempotencyKey:'idem-ops-0001',agentId:'owner'});
  x.client.write=orig;
  assert.equal(r.reason,'DAILY_OPERATIONS_USED_UP',JSON.stringify(r).slice(0,300));assert.equal(r.nothingPaid,true);assert.equal(r.retryable,true);assert.ok(!r.capHit,'not counted as a cap hit (no anomaly pause)');
  assert.match(r.say_to_user,/自动恢复/);assert.match(r.say_to_user,/reset automatically/);assert.doesNotMatch(r.say_to_user,/错误|失败|危险|被盗|攻击|盗刷|error|fail|danger|attack|abuse|stolen/i,'calm, not scary');
  assert.deepEqual(amountProblems(r),[]);
  // after the reset the SAME order is paid once with a new Idempotency-Key (ledger row has no tx hash -> claim retaken)
  const r2=await x.engine.pay({request:direct('20000','ops-1'),idempotencyKey:'idem-ops-0002',agentId:'owner'});assert.equal(r2.state,'paid',JSON.stringify(r2).slice(0,300));
  const r3=await x.engine.pay({request:direct('20000','ops-1'),idempotencyKey:'idem-ops-0003',agentId:'owner'});assert.notEqual(r3.state,'paid','still only once (layer 2)');});
test('owner plan: setOpsPerDay rides in the owner-signed wallet batch, targeted at HIS vault; bounds checked',()=>{
  const base={chainId:8453,wallet:'0x1111111111111111111111111111111111111111',adapter:AD,token:USDC,executor:'0x2222222222222222222222222222222222222222',headroom:false,maxNetworkFee:'50000',fee:{ppm:'1000'},
    stated:{single:'5000000',daily:'20000000',term:'100000000',openSingle:'0',openDaily:'0',verifiedSingle:'0',verifiedDaily:'0'},start:1_800_000_000,end:1_800_000_000+90*DAY};
  const pl=buildMigrationPlanV5({...base,opsPerDay:800,opsVault:VAULT});const c=pl.calls[pl.calls.length-1];
  assert.equal(getAddress(c.to),getAddress(VAULT));assert.equal(decodeFunctionData({abi:parseAbi(['function setOpsPerDay(uint32 n)']),data:c.data}).args[0],800);
  assert.match(c.label,/at most 800 per day/);assert.match(pl.human.dailyOperations,/800/);assert.deepEqual(setOpsPerDayCall(VAULT,800).data,c.data);
  assert.throws(()=>buildMigrationPlanV5({...base,opsPerDay:100001,opsVault:VAULT}),/0\.\.100000/);assert.throws(()=>buildMigrationPlanV5({...base,opsPerDay:5}),/opsVault/);
  assert.equal(buildMigrationPlanV5(base).calls.some(x=>getAddress(x.to)===getAddress(VAULT)),false,'not set unless chosen');
  assert.equal(checkLimits({single:'1',daily:'2',term:'3',opsPerDay:'500'}).opsPerDay,500);assert.equal(checkLimits({single:'1',daily:'2',term:'3'}).opsPerDay,undefined);
  for(const bad of ['0','100001','1.5','abc','-3'])assert.equal(checkLimits({single:'1',daily:'2',term:'3',opsPerDay:bad}).error,'bad_ops_per_day',bad);});
