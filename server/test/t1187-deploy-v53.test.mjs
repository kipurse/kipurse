// t1187 (decision 87): one-time V5.3 deploy page. Fixed batch only (factory, adapter via 0x4e59, USDC fee leg), paid in USDC by the owner's
// Base Account (sponsor fronts gas for the exact batch only), inert once both contracts have code. No ETH, no new paymaster env.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';import {Readable} from 'node:stream';
import {encodeFunctionData,parseAbi,getAddress} from 'viem';
import {loadV53Plan,deployV53Calls,deployV53Commitment,deployV53Fragment,createDeployV53,DEPLOY_V53_FEE_USDC,DEPLOY_V53_STEP_FEES,DEPLOY_V53_PREFIX,DEPLOYER,V53_PIN} from '../src/v5/deploy-v53.mjs';
import {createOnboardSponsor,callsHash} from '../src/v5/onboard-sponsor.mjs';import {readRaw,createAgentRouter} from '../src/v5/router.mjs';
import {canon} from '../src/v5/batch-commit.mjs';import {KIPURSE_FEE_TO,USDC_BASE} from '../src/v5/usdc-gas.mjs';
const PLAN_FILE=new URL('../mainnet/v53-deploy-plan.json',import.meta.url).pathname;const RAW=JSON.parse(fs.readFileSync(PLAN_FILE,'utf8'));
const O='0x4242b022A8296cB18B0E0b1Cb9879C518170A718',OTHER='0x1da2d5293bd418ab06d16890f17711302c7e74f6';
const EXEC=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);
const op=(cs,o={})=>({sender:O,callData:encodeFunctionData({abi:EXEC,functionName:'executeBatch',args:[cs.map(c=>({target:c.to,value:BigInt(c.value),data:c.data}))]}),callGasLimit:'0xbebc20',verificationGasLimit:'0x60000',preVerificationGas:'0x100000',maxFeePerGas:'0xb71b00',...o});
const EP='0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const kvMap=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v)};};
const upstream=async()=>({json:async()=>({jsonrpc:'2.0',id:1,result:{sponsor:{name:'Kipurse',icon:'data:x'},paymaster:'0x9d3927128b74460e164a1b1dee445d490e7eca72',paymasterData:'0x01',isFinal:false}})});
function mkSponsor({open=true,gp=6000000n,cfg={}}={}){const kv=kvMap();const st={open};
  const sp=createOnboardSponsor({cfg:{url:'https://pm.example',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25,...cfg},kv,reg:{byOwner:()=>[]},ethUsd8:async()=>176100000000n,lookup:()=>null,gasPrice:async()=>gp,fetchImpl:upstream,deployV53Open:async()=>st.open});
  return {sp,st,kv};}
const mkPub=({code={},usdc=988700n}={})=>({getCode:async({address})=>code[getAddress(address)]??'0x',getGasPrice:async()=>6000000n,readContract:async()=>usdc});
const plan=loadV53Plan(PLAN_FILE);

test('plan: exactly the fixed two steps, sha256-pinned, CREATE2 addresses = pinned factory/adapter',()=>{
  assert.equal(plan.factory,V53_PIN.factory);assert.equal(plan.adapter,V53_PIN.adapter);assert.equal(plan.steps.length,2);for(const s of plan.steps)assert.equal(s.to,DEPLOYER);
  const bad=JSON.parse(JSON.stringify(RAW));bad.steps[1].data=bad.steps[1].data.slice(0,-2)+'00';assert.throws(()=>loadV53Plan(bad),/data hash/);
  const sw=JSON.parse(JSON.stringify(RAW));sw.steps.reverse();assert.throws(()=>loadV53Plan(sw));
  const to=JSON.parse(JSON.stringify(RAW));to.steps[0].to=OTHER;assert.throws(()=>loadV53Plan(to),/deployer/);
  const ex=JSON.parse(JSON.stringify(RAW));ex.steps.push(ex.steps[0]);assert.throws(()=>loadV53Plan(ex),/exactly 2/);});
// t1189 (decision 89): two confirmations (Coinbase's bundler cannot estimate the single ~12M-gas batch): step 1 = factory + 0.05, step 2 = adapter + 0.15.
const C1=deployV53Calls(plan,1),C2=deployV53Calls(plan,2);const feeData=a=>'0xa9059cbb'+KIPURSE_FEE_TO.slice(2).padStart(64,'0')+a.toString(16).padStart(64,'0');
test('batches: step 1 = factory + 0.05 USDC, step 2 = adapter + 0.15 USDC (0.20 in total) to the fixed fee address; no ETH value anywhere',()=>{
  assert.equal(C1.length,2);assert.equal(C2.length,2);assert.equal(C1[0].data,plan.steps[0].data);assert.equal(C2[0].data,plan.steps[1].data);
  for(const C of [C1,C2]){assert.equal(getAddress(C[0].to),getAddress(DEPLOYER));assert.equal(getAddress(C[1].to),getAddress(USDC_BASE));assert.ok(C.every(c=>BigInt(c.value)===0n));}
  assert.equal(C1[1].data,feeData(50000n));assert.equal(C2[1].data,feeData(150000n));assert.deepEqual(DEPLOY_V53_STEP_FEES,[50000n,150000n]);
  assert.equal(DEPLOY_V53_FEE_USDC,200000n);assert.equal(DEPLOY_V53_STEP_FEES[0]+DEPLOY_V53_STEP_FEES[1],DEPLOY_V53_FEE_USDC);
  assert.throws(()=>deployV53Calls(plan),/step/);assert.throws(()=>deployV53Calls(plan,3),/step/);});
// browser guard (unchanged KPVH v1): the page points #vh= at the step's commitment from the link (#vh1=…&vh2=…)
const G=fs.readFileSync(new URL('../owner-sign/guard/kpvh.js',import.meta.url),'utf8');
const guard=hash=>{const ctx={location:{hash},document:{documentElement:{lang:'en'}},crypto:webcrypto,TextEncoder,URLSearchParams,BigInt,Number,String,Array,Uint8Array,Error};vm.createContext(ctx);vm.runInContext(G,ctx);return ctx.kpVH;};
test('link commitments: each step sends only its exact batch from the owner; the other step, the old 3-call batch or any change is refused',async()=>{
  const v1=deployV53Commitment(plan,O,1),v2=deployV53Commitment(plan,O,2);assert.match(v1,/^[0-9a-f]{64}$/);assert.notEqual(v1,v2);assert.equal(deployV53Fragment(plan,O),'vh1='+v1+'&vh2='+v2);
  const req=(calls,from=O)=>({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x2105',from:from.toLowerCase(),atomicRequired:true,calls,capabilities:{paymasterService:{url:'https://pay.kipurse.com/deploy-v53/paymaster?id=dv53-x'}}}]});
  const g1=guard('#vh='+v1+'&vh1='+v1+'&vh2='+v2),g2=guard('#vh='+v2+'&vh1='+v1+'&vh2='+v2);assert.ok(await g1(req(C1)));assert.ok(await g2(req(C2)));
  await assert.rejects(g1(req(C2)),/not exactly/);await assert.rejects(g2(req(C1)),/not exactly/);
  await assert.rejects(g1(req([C1[0],{...C1[1],data:feeData(1000000n)}])),/not exactly/);await assert.rejects(g1(req([C1[0]])),/not exactly/);
  await assert.rejects(g1(req([C1[0],C2[0],{...C1[1],data:feeData(200000n)}])),/not exactly/);await assert.rejects(g1(req([{...C1[0],value:'0x1'},C1[1]])),/not exactly/);
  await assert.rejects(g1(req(C1,OTHER)),/not exactly/);await assert.rejects(guard('#vh1='+v1+'&vh2='+v2)(req(C1)),/start this from the Kipurse app/);});
const call=async(D,method,path,body,lang='zh-CN')=>{let code,h,b='';const raw=body===undefined?'':JSON.stringify(body);const req=Object.assign(Readable.from(raw?[raw]:[]),{method,headers:{'accept-language':lang}});
  const res={writeHead(c,hh){code=c;h=hh;},end(x){b=x??'';}};const u=new URL('https://pay.kipurse.com'+path);const handled=await D.handle(req,res,u);return {handled,code,h,b,j:()=>JSON.parse(b)};};
test('page: calm zh/en wording, says two confirmations and the cost split, no 签名 / 网络费, one language per response',async()=>{const {sp}=mkSponsor();
  const D=createDeployV53({plan,owner:O,pub:mkPub(),sponsor:sp,ethUsd8:async()=>176100000000n,readRaw});
  const zh=await call(D,'GET','/deploy-v53');assert.equal(zh.code,200);assert.match(zh.b,/部署启付 V5\.3 合约（一次性）/);assert.match(zh.b,/0\.20 USDC/);assert.match(zh.b,/不用 ETH/);assert.match(zh.b,/实际成本现在约 0\.14 美元/);
  assert.match(zh.b,/确认<b>两次<\/b>/);assert.match(zh.b,/第 1 步 0\.05，第 2 步 0\.15/);assert.match(zh.b,/第 1 步：在 Coinbase 里确认/);assert.match(zh.b,/"step":1/);assert.match(zh.b,/"fees":\["50000","150000"\]/);
  assert.match(zh.b,/0x34d9Bdc9E10815fB6913AF5BC0DAad7E53dbD57D/);assert.match(zh.b,/0xb150030be35903AdEE466d7733Bf0841B667033C/);assert.match(zh.b,/src="\/deploy-v53\.js"/);
  assert.doesNotMatch(zh.b,/签名|网络费|三步/);assert.doesNotMatch(zh.b,/What this does/);assert.match(zh.h['content-security-policy'],/script-src 'nonce-/);
  const en=await call(D,'GET','/deploy-v53','', 'en-US');assert.match(en.b,/Deploy Kipurse V5\.3 contracts \(one time\)/);assert.match(en.b,/No ETH needed/);assert.match(en.b,/<b>twice<\/b>/);assert.doesNotMatch(en.b,/[\u4e00-\u9fff]/);
  const S2=createDeployV53({plan,owner:O,pub:mkPub({code:{[plan.factory]:'0x60'}}),sponsor:sp,readRaw});const z2=(await call(S2,'GET','/deploy-v53')).b;
  assert.match(z2,/✅ 第 1 步：部署工厂/);assert.match(z2,/第 2 步：在 Coinbase 里确认/);assert.match(z2,/"step":2/);assert.doesNotMatch(z2,/链上状态和预期不一致/);
  for(const f of ['owner-sign/static/deploy-v53.js','owner-sign/consent/deploy-v53.js','src/v5/deploy-v53.mjs'])assert.doesNotMatch(fs.readFileSync(new URL('../'+f,import.meta.url),'utf8'),/签名|网络费/,f);});
test('prepare: only the owner, only the batch of the CURRENT step, paymaster = this page\'s own proxy; USDC shortfall refused calmly',async()=>{const {sp,kv}=mkSponsor();
  const D=createDeployV53({plan,owner:O,pub:mkPub(),sponsor:sp,readRaw});
  assert.equal((await call(D,'POST','/deploy-v53/prepare',{from:OTHER})).code,400);assert.equal((await call(D,'POST','/deploy-v53/prepare',{})).code,400);
  const r=await call(D,'POST','/deploy-v53/prepare',{from:O.toLowerCase()});assert.equal(r.code,200);const j=r.j();assert.equal(j.step,1);assert.deepEqual(j.calls,C1);
  assert.ok(j.id.startsWith(DEPLOY_V53_PREFIX));assert.equal(j.paymaster,'https://pay.kipurse.com/deploy-v53/paymaster?id='+j.id);assert.equal(j.from,O);
  const rec=kv.get('sponsor:wdrec:'+j.id);assert.equal(rec.kind,'deploy_v53');assert.equal(rec.callsHash,callsHash(C1));assert.equal(rec.reimburse,'50000');assert.equal(rec.step,1);assert.equal(rec.realGas,'3300000');
  const D2s=createDeployV53({plan,owner:O,pub:mkPub({code:{[plan.factory]:'0x60'}}),sponsor:sp,readRaw});const j2=(await call(D2s,'POST','/deploy-v53/prepare',{from:O})).j();
  assert.equal(j2.step,2);assert.deepEqual(j2.calls,C2);const rec2=kv.get('sponsor:wdrec:'+j2.id);assert.equal(rec2.reimburse,'150000');assert.equal(rec2.step,2);assert.equal(rec2.realGas,'10000000');
  const D2=createDeployV53({plan,owner:O,pub:mkPub({usdc:49999n}),sponsor:sp,readRaw});const p2=await call(D2,'POST','/deploy-v53/prepare',{from:O});assert.equal(p2.code,409);assert.equal(p2.j().error,'needs_usdc');
  assert.equal((await call(createDeployV53({plan,owner:O,pub:mkPub({usdc:50000n}),sponsor:sp,readRaw}),'POST','/deploy-v53/prepare',{from:O})).code,200);
  assert.equal((await call(createDeployV53({plan,owner:O,pub:mkPub({usdc:149999n,code:{[plan.factory]:'0x60'}}),sponsor:sp,readRaw}),'POST','/deploy-v53/prepare',{from:O})).j().error,'needs_usdc');
  const D3=createDeployV53({plan,owner:O,pub:mkPub(),sponsor:{registerDeployV53:()=>null},readRaw});assert.equal((await call(D3,'POST','/deploy-v53/prepare',{from:O})).j().error,'unavailable');});
test('steps: open(step) only while the chain is exactly at that step; done = inert; adapter without factory = stop',async()=>{const {sp,st}=mkSponsor();
  const none=createDeployV53({plan,owner:O,pub:mkPub(),sponsor:sp,readRaw}),fac=createDeployV53({plan,owner:O,pub:mkPub({code:{[plan.factory]:'0x60'}}),sponsor:sp,readRaw});
  assert.equal(await none.open(1),true);assert.equal(await none.open(2),false);assert.equal(await none.open(),false);assert.equal(await fac.open(1),false);assert.equal(await fac.open(2),true);
  assert.deepEqual((await call(fac,'GET','/deploy-v53/status')).j(),{factory:true,adapter:false,done:false,step:2});
  const both={[plan.factory]:'0x60',[plan.adapter]:'0x60'};const D=createDeployV53({plan,owner:O,pub:mkPub({code:both}),sponsor:sp,readRaw});
  const g=await call(D,'GET','/deploy-v53');assert.match(g.b,/两份 V5\.3 合约都已经在 Base 上了/);assert.doesNotMatch(g.b,/<button|deploy-v53\.js|kp-data/);
  assert.deepEqual((await call(D,'POST','/deploy-v53/prepare',{from:O})).j(),{done:true});assert.deepEqual((await call(D,'GET','/deploy-v53/status')).j(),{factory:true,adapter:true,done:true,step:0});
  assert.equal(await D.open(1),false);assert.equal(await D.open(2),false);
  const P=createDeployV53({plan,owner:O,pub:mkPub({code:{[plan.adapter]:'0x60'}}),sponsor:sp,readRaw});assert.equal((await call(P,'POST','/deploy-v53/prepare',{from:O})).code,409);
  assert.match((await call(P,'GET','/deploy-v53')).b,/链上状态和预期不一致/);
  const id=sp.registerDeployV53('z',{owner:O,calls:C1,reimburse:50000n,step:1,realGas:3300000n});st.open=false;assert.equal(await sp.gate(id,'pm_getPaymasterStubData',[op(C1),EP,'0x2105']),'deploy_closed');
  // the real launch wiring passes the record's step to open(): a step-1 record is refused once the factory exists
  const kv=kvMap();const real=createOnboardSponsor({cfg:{url:'https://pm.example',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25},kv,reg:{byOwner:()=>[]},ethUsd8:async()=>176100000000n,lookup:()=>null,gasPrice:async()=>6000000n,fetchImpl:upstream,deployV53Open:s=>fac.open(s)});
  const a=real.registerDeployV53('s1',{owner:O,calls:C1,reimburse:50000n,step:1,realGas:3300000n}),b=real.registerDeployV53('s2',{owner:O,calls:C2,reimburse:150000n,step:2,realGas:10000000n}),c=real.registerDeployV53('old',{owner:O,calls:C1,reimburse:50000n});
  assert.equal(await real.gate(a,'pm_getPaymasterStubData',[op(C1),EP,'0x2105']),'deploy_closed');assert.equal(await real.gate(b,'pm_getPaymasterStubData',[op(C2),EP,'0x2105']),null);
  assert.equal(await real.gate(c,'pm_getPaymasterStubData',[op(C1),EP,'0x2105']),'deploy_closed');});
test('sponsor gate: exact step batch from the owner only; tampered / other sender / ETH refused; own op cap; underpaid per step; honest label',async()=>{
  const {sp}=mkSponsor();const P=o=>[o,EP,'0x2105'];const reg=(n,C,step)=>sp.registerDeployV53(n,{owner:O,calls:C,reimburse:DEPLOY_V53_STEP_FEES[step-1],step,realGas:step===1?3300000n:10000000n});
  const id=reg('a',C2,2);assert.equal(await sp.gate(id,'pm_getPaymasterStubData',P(op(C2))),null);
  assert.equal(await sp.gate(id,'pm_getPaymasterStubData',P(op(C2,{sender:OTHER}))),'sender');
  assert.equal(await sp.gate(id,'pm_getPaymasterStubData',P(op([C2[0],{...C2[1],data:feeData(100000n)}]))),'calls_mismatch');
  assert.equal(await sp.gate(id,'pm_getPaymasterStubData',P(op(C1))),'calls_mismatch');assert.equal(await sp.gate(id,'pm_getPaymasterStubData',P(op([C2[0]]))),'calls_mismatch');
  assert.equal(await sp.gate(id,'pm_getPaymasterStubData',P(op([C2[0],{to:USDC_BASE,value:'0x0',data:'0xa9059cbb'+OTHER.slice(2).padStart(64,'0')+'249f0'.padStart(64,'0')}]))),'usdc_call');
  assert.equal(await sp.gate(id,'pm_getPaymasterStubData',P(op([...C2,{to:OTHER,value:'0x0',data:'0x'}]))),'target');
  assert.equal(await sp.gate(id,'pm_getPaymasterStubData',P(op([{...C2[0],value:'0x1'},C2[1]]))),'target');
  assert.equal(await sp.gate('wd-'+id.slice(5),'pm_getPaymasterStubData',P(op(C2))),'not_prepared');
  // worst case: 12.5M+0.4M+1M+0.1M gas x 0.012 gwei x 1761 = ~0.30 USD > the general 0.25 cap but within this op's 1.00 cap
  assert.equal(await sp.gate(id,'pm_getPaymasterData',P(op(C2))),null);
  const id1=reg('a1',C1,1);assert.equal(await sp.gate(id1,'pm_getPaymasterData',P(op(C1,{callGasLimit:'0x2ab3b8'}))),null);
  const id2=reg('b',C2,2);assert.equal(await sp.gate(id2,'pm_getPaymasterData',P(op(C2,{maxFeePerGas:'0x2faf080'}))),'op_cap');   // 0.05 gwei worst case ~1.2 USD
  const hi=mkSponsor({gp:10000000n});const r2=(n,C,step)=>hi.sp.registerDeployV53(n,{owner:O,calls:C,reimburse:DEPLOY_V53_STEP_FEES[step-1],step,realGas:step===1?3300000n:10000000n});
  assert.equal(await hi.sp.gate(r2('c',C2,2),'pm_getPaymasterData',P(op(C2))),'underpaid');   // 0.01 gwei: step 2 real ~0.19 > 0.15
  assert.equal(await hi.sp.gate(r2('c1',C1,1),'pm_getPaymasterData',P(op(C1,{callGasLimit:'0x2ab3b8'}))),'underpaid');   // 0.01 gwei: step 1 real 3.3M x 1.1 x 0.01 gwei x 1761 = ~0.064 > 0.05 (both steps flip at ~0.0077 gwei)
  const r=await sp.rpc(id,{jsonrpc:'2.0',id:1,method:'pm_getPaymasterStubData',params:P(op(C2))});assert.equal(r.result.sponsor.name,'Your USDC');
  const off=createOnboardSponsor({cfg:{url:null},kv:kvMap(),reg:{byOwner:()=>[]},ethUsd8:async()=>1n,lookup:()=>null});assert.equal(off.registerDeployV53('x',{owner:O,calls:C1,reimburse:50000n,step:1}),null);});
test('router: the deploy paymaster route alone accepts the ~95 KB op body; everything else keeps the 64 KB limit',async()=>{const {sp}=mkSponsor();
  const D=createDeployV53({plan,owner:O,pub:mkPub(),sponsor:sp,readRaw});const kv={...kvMap(),incr:()=>1,take:()=>null};
  const R=createAgentRouter({reg:{count:()=>0},index:{},kv,obs:{log(){},wrap:f=>f},tenants:{size:()=>0,get:async()=>null},deployV53:D,rl:{ip:{hit:()=>false},tenant:{hit:()=>false}}});
  const id=sp.registerDeployV53('r',{owner:O,calls:C2,reimburse:150000n,step:2,realGas:10000000n});const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'pm_getPaymasterStubData',params:[op(C2),EP,'0x2105']});assert.ok(body.length>65536&&body.length<196608);
  const send=async(path,b)=>{let code,out='';const req=Object.assign(Readable.from([b]),{method:'POST',url:path,headers:{'content-length':String(b.length)},socket:{remoteAddress:'127.0.0.1'}});await R(req,{writeHead(c){code=c;},end(x){out=x??'';}});return {code,j:out?JSON.parse(out):null};};
  const ok=await send('/deploy-v53/paymaster?id='+id,body);assert.equal(ok.code,200);assert.equal(ok.j.result.sponsor.name,'Your USDC');
  assert.equal((await send('/onboard/new/paymaster?id='+id,body)).code,413);
  assert.equal((await send('/deploy-v53/paymaster?id='+id,body+' '.repeat(196608))).code,413);
  assert.equal((await send('/deploy-v53/paymaster?id=wd-'+id.slice(5),body)).code,404);});
