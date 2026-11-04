// ZERO-RESERVE gas path: vault = ERC-4337 v0.7 sender, Circle paymaster (permit <= maxGasPerOp), pluggable bundler, actual-charge top-up.
const ORD={order:{item:'test item',merchant:'Test Shop',user_request:'please buy the test item'}};
import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {encodeAbiParameters,parseAbiParameters,decodeAbiParameters,decodeFunctionData,parseAbi,encodeEventTopics,recoverMessageAddress,toHex,getAddress,slice} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';import {getUserOperationHash} from 'viem/account-abstraction';
import {createUserOpWriter,bundlerFrom,usdcCharged,CIRCLE_PAYMASTER,ENTRYPOINT_V07,PIMLICO_PUBLIC} from '../src/v5/userop.mjs';import {GasBook} from '../src/v5/gas.mjs';
const USDC='0x036CbD53842c5426634e7929541eC2318f3dCF7e',VAULT='0x00000000000000000000000000000000000fa017',AD='0xB7605ee94db64a097A436ab31A5075155121A45F';
const PM=getAddress(CIRCLE_PAYMASTER[84532].v07);const session=privateKeyToAccount('0x'+'5e'.repeat(32));
const T=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const tlog=(from,to,v)=>({address:USDC,topics:encodeEventTopics({abi:T,eventName:'Transfer',args:{from,to}}),data:encodeAbiParameters(parseAbiParameters('uint256'),[v])});
test('usdcCharged = prefund to the paymaster minus its postOp refund (the actual charge)',()=>{
  assert.equal(usdcCharged([tlog(VAULT,PM,9000n),tlog(PM,VAULT,7483n),tlog(VAULT,AD,5n)],{token:USDC,vault:VAULT,paymaster:PM}),1517n);});
test('bundler: Pimlico public on Sepolia by default; mainnet requires a configured (BYO-key) URL; a paying bundler is refused; free-tier quota',()=>{
  assert.equal(bundlerFrom({chainId:84532}).label,'pimlico-public');assert.equal(PIMLICO_PUBLIC(84532),'https://public.pimlico.io/v2/84532/rpc');
  assert.throws(()=>bundlerFrom({chainId:8453}),/BUNDLER_NOT_CONFIGURED/);
  assert.throws(()=>bundlerFrom({chainId:8453,bundler:{url:'https://example.invalid/rpc',costPerOpUsdc:'100'}}),/BUNDLER_COST_NOT_ZERO/);
  process.env.KP_TEST_BUNDLER='https://example.invalid/rpc?apikey=user-own';const b=bundlerFrom({chainId:8453,bundler:{urlEnv:'KP_TEST_BUNDLER',maxOpsPerDay:2}});
  assert.equal(b.label,'custom');assert.ok(!JSON.stringify(b).includes('user-own'));assert.equal(b.quota(),true);assert.equal(b.quota(),true);assert.equal(b.quota(),false);});
test('GasBook: actual charges are topped up exactly once, FIFO, partially when capped',()=>{
  const g=new GasBook(new DatabaseSync(':memory:'));g.recordCharge({account:VAULT,userOpHash:'0x1',charged:1517n});g.recordCharge({account:VAULT,userOpHash:'0x2',charged:865n,success:false});
  assert.equal(g.pendingTopUp(VAULT),2382n);assert.equal(g.markToppedUp(VAULT,2000n,'0xt'),2000n);assert.equal(g.pendingTopUp(VAULT),382n);
  g.markToppedUp(VAULT,382n,'0xu');assert.equal(g.pendingTopUp(VAULT),0n);g.recordCharge({account:VAULT,charged:0n});assert.equal(g.charges(VAULT).length,2);});
function fakes({success=true,pmPost='0x9c40',ownGas}={}){
  const sent=[];const pub={...(ownGas?{estimateGas:async()=>ownGas}:{}),readContract:async({functionName})=>functionName==='DOMAIN_SEPARATOR'?'0x'+'ab'.repeat(32):0n,estimateFeesPerGas:async()=>({maxFeePerGas:2000000n,maxPriorityFeePerGas:1000000n})};
  const bundlerFetch=async(url,{body})=>{const {method,params,id}=JSON.parse(body);sent.push({method,params});let result;
    if(method==='pimlico_getUserOperationGasPrice')result={standard:{maxFeePerGas:'0x1e8480',maxPriorityFeePerGas:'0xf4240'}};
    if(method==='eth_estimateUserOperationGas')result={callGasLimit:'0x30d40',verificationGasLimit:'0x186a0',preVerificationGas:'0xc350',paymasterVerificationGasLimit:'0x249f0',paymasterPostOpGasLimit:pmPost};
    if(method==='eth_sendUserOperation')result='0x'+'77'.repeat(32);
    if(method==='eth_getUserOperationReceipt')result={success,actualGasUsed:'0x55730',actualGasCost:'0x1',reason:success?undefined:'0x92db0d6b',receipt:{transactionHash:'0x'+'88'.repeat(32),blockNumber:'0x10',logs:[tlog(VAULT,PM,9000n),tlog(PM,VAULT,7483n)]}};
    return {json:async()=>({jsonrpc:'2.0',id,result})};};
  return {sent,pub,bundlerFetch};}
test('userOp writer: vault is the sender, Circle permit capped at maxGasPerOp and signed by the session key, simulated before send, actual charge reported',async()=>{
  const {sent,pub,bundlerFetch}=fakes();const charges=[];
  const w=createUserOpWriter({cfg:{chainId:84532,token:USDC,bundlerFetch,userOp:{pollMs:1}},pub,session,vault:VAULT,adapter:AD,maxGasPerOp:50000n,onCharge:x=>charges.push(x)});
  const out=await w.write('collectFees',[]);
  assert.deepEqual(sent.map(x=>x.method),['pimlico_getUserOperationGasPrice','eth_estimateUserOperationGas','eth_sendUserOperation','eth_getUserOperationReceipt']);
  const op=sent[2].params[0];assert.equal(sent[2].params[1],ENTRYPOINT_V07);assert.equal(getAddress(op.sender),getAddress(VAULT));assert.equal(getAddress(op.paymaster),PM);
  assert.equal(slice(op.paymasterData,0,1),'0x00');assert.equal(getAddress(slice(op.paymasterData,1,21)),getAddress(USDC));
  assert.equal(BigInt(slice(op.paymasterData,21,53)),50000n);
  const [sp,amt]=decodeAbiParameters(parseAbiParameters('address,uint256,uint256,uint256,bytes'),slice(op.paymasterData,53));assert.equal(getAddress(sp),PM);assert.equal(amt,50000n);
  assert.equal(BigInt(op.callGasLimit),220000n);   // estimate + 10% (tight: v0.7 penalises unused call gas)
  const inner=decodeFunctionData({abi:parseAbi(['function execute(address,uint256,bytes)']),data:op.callData});assert.equal(getAddress(inner.args[0]),getAddress(AD));
  const uo={...Object.fromEntries(Object.entries(op).map(([k,v])=>[k,/^0x[0-9a-f]+$/i.test(v)&&!['sender','callData','signature','paymaster','paymasterData'].includes(k)?BigInt(v):v]))};
  const h=getUserOperationHash({chainId:84532,entryPointAddress:ENTRYPOINT_V07,entryPointVersion:'0.7',userOperation:uo});
  assert.equal(await recoverMessageAddress({message:{raw:h},signature:op.signature}),session.address);
  assert.equal(out.usdcGas,1517n);assert.equal(out.status,'success');assert.equal(charges[0].charged,1517n);});
test('userOp writer: paymaster gas limits never go below the Circle floors (bundler measured 13,580 postOp; Circle requires >= 35k: PostOpGasLimitTooLow, seen live on Sepolia)',async()=>{
  const {sent,pub,bundlerFetch}=fakes({pmPost:'0x350c'});
  const w=createUserOpWriter({cfg:{chainId:84532,token:USDC,bundlerFetch,userOp:{pollMs:1}},pub,session,vault:VAULT,adapter:AD,maxGasPerOp:50000n});
  await w.write('collectFees',[]);const op=sent[2].params[0];assert.equal(BigInt(op.paymasterPostOpGasLimit),40000n);assert.equal(BigInt(op.paymasterVerificationGasLimit),200000n);});
test('userOp writer: callGasLimit = min(bundler estimate +10%, direct eth_estimateGas +15% +10k) so the Circle prefund fits the owner cap (Sepolia: 2.49M -> ~1.3M on fundFloat)',async()=>{
  const {sent,pub,bundlerFetch}=fakes({ownGas:100000n});
  const w=createUserOpWriter({cfg:{chainId:84532,token:USDC,bundlerFetch,userOp:{pollMs:1}},pub,session,vault:VAULT,adapter:AD,maxGasPerOp:50000n});
  await w.write('collectFees',[]);assert.equal(BigInt(sent[2].params[0].callGasLimit),125000n);});
test('userOp writer: an included-but-reverted op throws onChain (its gas was paid by the owner vault, recorded for top-up)',async()=>{
  const {pub,bundlerFetch}=fakes({success:false});const charges=[];
  const w=createUserOpWriter({cfg:{chainId:84532,token:USDC,bundlerFetch,userOp:{pollMs:1}},pub,session,vault:VAULT,adapter:AD,maxGasPerOp:50000n,onCharge:x=>charges.push(x)});
  await assert.rejects(w.write('collectFees',[],{kind:'owner'}),e=>e.onChain===true&&e.userOp.usdcGas===1517n);assert.equal(charges[0].success,false);assert.equal(charges[0].kind,'owner');});
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {cfgFor,mockChain,direct,WALLET,PAYEE} from './helpers/v5-fixture.mjs';import {createEngineV5} from '../src/v5/engine.mjs';
function zrEngine(over={}){const m=mockChain({});const cfg=cfgFor({gasMode:'userop',...over});const writes=[];
  // stand-in for the userOp writer: executes on the mock chain and reports a Circle charge of 1517 per op
  let engine;const writer={async write(fn,args,o){writes.push({fn,args});const tx=await m.client.write(fn,args,o);engine.gasBook.recordCharge({account:WALLET,userOpHash:'0x'+String(writes.length).padStart(64,'0'),txHash:tx.hash,charged:1517n});return tx;}};
  engine=createEngineV5(cfg,{ledgerFile:join(mkdtempSync(join(tmpdir(),'zr-')),'l.sqlite'),client:m.client,writer,agentDefault:'a1'});engine.mandates.remember(PAYEE,'Shop');/* owner-established payee (NO-AI-TRUST) */return {engine,writes,m};}
test('engine userop mode: networkFee = exactly the previous actual Circle charges (no margin, no recovery debt), capped at maxGasPerOp',async()=>{
  const {engine,writes}=zrEngine();
  const r1=await engine.pay({...ORD,request:direct('20000','zr-1'),idempotencyKey:'idem-zr-0001'});assert.equal(r1.state,'paid');assert.equal(r1.networkFee,'0');
  assert.equal(engine.gasBook.pendingTopUp(WALLET),1517n);
  const r2=await engine.pay({...ORD,request:direct('20000','zr-2'),idempotencyKey:'idem-zr-0002'});assert.equal(r2.state,'paid');assert.equal(r2.networkFee,'1517');
  assert.equal(writes[1].args.at(-2),1517n);assert.equal(engine.gasBook.pendingTopUp(WALLET),1517n); // op2's own charge waits for op3
  assert.equal(engine.gasBook.outstanding(WALLET),0n);});
test('engine gas modes: executor-pays legacy refused on Base mainnet; F2 degraded mode sends nothing on chain',async()=>{
  assert.throws(()=>createEngineV5(cfgFor({chainId:8453}),{ledgerFile:join(mkdtempSync(join(tmpdir(),'zr-')),'l.sqlite'),client:mockChain({}).client}),/not allowed on Base mainnet/);
  const m=mockChain({});const e=createEngineV5(cfgFor({gasMode:'f2'}),{ledgerFile:join(mkdtempSync(join(tmpdir(),'zr-')),'l.sqlite'),client:m.client,agentDefault:'a1'});e.mandates.remember(PAYEE,'Shop');
  const r=await e.pay({...ORD,request:direct('20000','f2-1'),idempotencyKey:'idem-f2-0001'});assert.equal(r.state,'failed');assert.match(r.error,/F2_X402_ONLY/);});

// 2026-10-21 mainnet incident replay: the first Muse 0.01 payment (tx 0x737e62ab…) was billed 16,720 = the top-up of two EARLIER owner
// ops (op 0x9e63d72d… 9,615 and the trustBySig relay 0x8f3346bb… 7,105). Owner-action gas is no longer billed to agent payments.
test('op kinds: payments pay back only payment ops; owner-action gas stays on the owner vault buffer; legacy rows default to pay',()=>{
  const g=new GasBook(new DatabaseSync(':memory:'));
  g.recordCharge({account:VAULT,txHash:'0x9e63',charged:9615n,kind:'owner'});g.recordCharge({account:VAULT,txHash:'0x8f33',charged:7105n,kind:'owner'});
  assert.equal(g.pendingTopUp(VAULT),16720n);            // BEFORE: what the old rule billed the 0.01 payment
  assert.equal(g.pendingTopUp(VAULT,'pay'),0n);           // AFTER: the first payment carries no top-up
  g.recordCharge({account:VAULT,txHash:'0x737e',charged:8563n});   // the payment's own Circle charge (default kind pay)
  assert.equal(g.pendingTopUp(VAULT,'pay'),8563n);assert.equal(g.pendingTopUp(VAULT,'owner'),16720n);
  assert.equal(g.markToppedUp(VAULT,8563n,'0xnext'),8563n); // settles the pay row first, never the owner rows
  assert.equal(g.pendingTopUp(VAULT,'pay'),0n);assert.equal(g.pendingTopUp(VAULT,'owner'),16720n);
  const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE op_charges(id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, user_op_hash TEXT, tx_hash TEXT, success INTEGER, charged INTEGER NOT NULL, topped INTEGER NOT NULL DEFAULT 0, topped_tx TEXT, at INTEGER NOT NULL)`);
  db.prepare(`INSERT INTO op_charges(account,charged,at) VALUES(?,?,?)`).run(VAULT.toLowerCase(),8563,1);const g2=new GasBook(db);assert.equal(g2.pendingTopUp(VAULT,'pay'),8563n);});
test('engine userop: owner-action gas is not billed to a payment while the vault buffer is healthy; billed (own line) when low',async()=>{
  const {engine,m}=zrEngine();engine.gasBook.recordCharge({account:WALLET,txHash:'0xtrust',charged:7105n,kind:'owner'});
  const r1=await engine.pay({...ORD,request:direct('10000','own-1'),idempotencyKey:'idem-own-0001'});assert.equal(r1.state,'paid');assert.equal(r1.networkFee,'0'); // first payment: no owner-action gas billed
  const pf=await engine.preflight(direct('10000','own-2'));assert.equal(pf.quote.networkFee,'1517');assert.equal(pf.quote.receipt.networkFee,'1517');assert.equal(pf.quote.receipt.total,String(pf.quote.total));assert.equal(pf.quote.receipt.paidFrom,'wallet_balance'); // only the previous payment's own charge
  m.s.bal=1n;const low=await engine.preflight(direct('10000','own-3'));assert.equal(low.quote.networkFee,String(1517n+7105n)); // buffer low -> refill
  assert.equal(engine.gasBook.pendingTopUp(WALLET,'owner'),7105n);});

// t766u: Kipurse dues ride in the vault's owner-set fee slot, capped; marked paid only on success
import {duesAmount} from '../src/v5/userop.mjs';
const OPS='0xf14ef5dc4723245866c22c749a0a84afceba0dd9';
test('dues amount: only to the ops account via the fee slot; capped by dues, maxBundlerFee, net cap, free balance after one op of gas',()=>{
  const b={due:30000n,feeTo:OPS,opsTo:OPS,maxFee:100000n,netCap:50000n,balance:200000n,reserved:0n,gasKeep:50000n};
  assert.equal(duesAmount(b),30000n);assert.equal(duesAmount({...b,feeTo:'0x'+'1'.repeat(40)}),0n,'slot not set to ops');assert.equal(duesAmount({...b,feeTo:'0x'+'0'.repeat(40)}),0n);
  assert.equal(duesAmount({...b,maxFee:10000n}),10000n);assert.equal(duesAmount({...b,netCap:5000n}),5000n);assert.equal(duesAmount({...b,balance:70000n,reserved:10000n}),10000n);
  assert.equal(duesAmount({...b,balance:40000n}),0n,'never eats the gas buffer');assert.equal(duesAmount({...b,due:0n}),0n);});
test('userOp writer: dues transfer appended to the batch, marked paid on success, not on revert',{skip:'OSS copy: frozen vector/fixture tied to operator addresses or the operator App Attest fixture; regenerate with your own values'},async()=>{
  for(const success of [true,false]){const {sent,bundlerFetch}=fakes({success});let paid=0n;
    const pub={readContract:async({functionName})=>functionName==='DOMAIN_SEPARATOR'?'0x'+'ab'.repeat(32):functionName==='bundlerFeeTo'?OPS:functionName==='maxBundlerFee'?100000n:functionName==='balanceOf'?500000n:0n,estimateFeesPerGas:async()=>({maxFeePerGas:2000000n,maxPriorityFeePerGas:1000000n})};
    const w=createUserOpWriter({cfg:{chainId:84532,token:USDC,bundlerFetch,userOp:{pollMs:1}},pub,session,vault:VAULT,adapter:AD,maxGasPerOp:50000n,dues:{to:OPS,get:()=>30000n,paid:n=>{paid+=n;}}});
    const r=await w.write('collectFees',[]).catch(e=>e);const op=sent.find(x=>x.method==='eth_sendUserOperation').params[0];
    const d=decodeFunctionData({abi:parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']),data:op.callData});const last=d.args[0][d.args[0].length-1];
    assert.equal(getAddress(last.target),getAddress(USDC));const t=decodeFunctionData({abi:parseAbi(['function transfer(address,uint256)']),data:last.data});assert.equal(getAddress(t.args[0]),OPS);assert.equal(t.args[1],30000n);
    assert.equal(paid,success?30000n:0n);if(success)assert.equal(r.duesPaid,30000n);}});
test('userOp writer: fee slot not set to the ops account -> no dues transfer, reported, payment unchanged',async()=>{const {sent,bundlerFetch}=fakes();let why=null;
  const pub={readContract:async({functionName})=>functionName==='DOMAIN_SEPARATOR'?'0x'+'ab'.repeat(32):functionName==='bundlerFeeTo'?'0x'+'0'.repeat(40):functionName==='balanceOf'?500000n:0n,estimateFeesPerGas:async()=>({maxFeePerGas:2000000n,maxPriorityFeePerGas:1000000n})};
  const w=createUserOpWriter({cfg:{chainId:84532,token:USDC,bundlerFetch,userOp:{pollMs:1}},pub,session,vault:VAULT,adapter:AD,maxGasPerOp:50000n,dues:{to:OPS,get:()=>30000n,paid:()=>{},blocked:x=>{why=x;}}});
  await w.write('collectFees',[]);const op=sent.find(x=>x.method==='eth_sendUserOperation').params[0];
  assert.equal(decodeFunctionData({abi:parseAbi(['function execute(address,uint256,bytes)']),data:op.callData}).functionName,'execute');assert.equal(why,'fee_slot_not_set');});
