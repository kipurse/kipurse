// t1214 (decision 102, owner t1230; decision 101 owner t1227): V5.4 deploy page (owner's Base Account pays 0.15 USDC, never ETH) and the owner wallet
// switch to V5.4 (one owner-signed batch, fee = actual cost in USDC from the Kipurse wallet). PREPARED ONLY: every switch defaults OFF.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import {webcrypto,createHash} from 'node:crypto';
import {getAddress,decodeAbiParameters,decodeFunctionData,parseAbi} from 'viem';
import {loadV54Plan,deployV54Calls,deployV54Commitment,deployV54Fragment,deployV54On,createDeployV54,DEPLOY_V54_FEE_USDC,DEPLOYER,V54_PIN} from '../src/v5/deploy-v54.mjs';
import * as MG from '../src/v5/migrate-v54.mjs';import * as ST from '../src/v5/signer-trust-v54.mjs';
import {createOnboardSponsor} from '../src/v5/onboard-sponsor.mjs';import {KIPURSE_FEE_TO,USDC_BASE} from '../src/v5/usdc-gas.mjs';import {readRaw,createAgentRouter} from '../src/v5/router.mjs';
const PLAN_FILE=new URL('../mainnet/v54-deploy-plan.json',import.meta.url).pathname;const RAW=JSON.parse(fs.readFileSync(PLAN_FILE,'utf8'));
const O='0x4242b022A8296cB18B0E0b1Cb9879C518170A718',W='0x515010c2e41F98CdDd76B819EE69DC832c0939B6',OTHER='0x1da2d5293bd418ab06d16890f17711302c7e74f6';
const src=f=>fs.readFileSync(new URL('../'+f,import.meta.url),'utf8');
const plan=loadV54Plan(PLAN_FILE);
test('flags: deploy page, migration endpoints, V5.4 signer grants and the V5.4 suite are all OFF by default',()=>{
  assert.equal(deployV54On({}),false);assert.equal(MG.migrateV54On({}),false);assert.equal(ST.enabled({}),false);assert.equal(deployV54On({KIPURSE_DEPLOY_V54:'1'}),true);
  const L=src('mainnet/mainnet-owner-launch.mjs');assert.match(L,/if\(!deployV54On\(ENV\)\)return null;/);assert.match(L,/if\(!M\.migrateV54On\(ENV\)\)return null;/);
  assert.match(L,/const V54W=String\(process\.env\.KIPURSE_V54_SUITE_WALLET\?\?''\)/);assert.match(L,/if\(!ST\.enabled\(ENV\)\)return \{\};/);});
test('deploy plan: one pinned step via the public deployer, CREATE2 address 0x99D8…7Aaa, init-code keccak pinned; tampering refused',()=>{
  assert.equal(plan.adapter,V54_PIN.adapter);assert.equal(getAddress(plan.adapter),'0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa');assert.equal(plan.step.to,DEPLOYER);
  assert.equal(createHash('sha256').update(Buffer.from(plan.step.data.slice(2),'hex')).digest('hex'),'896ff350a8d71c6a0dd88e348f421b94954ccfad21e3e805c924105a7e2b6a23');
  const bad=JSON.parse(JSON.stringify(RAW));bad.steps[0].data=bad.steps[0].data.slice(0,-2)+'00';assert.throws(()=>loadV54Plan(bad));
  const to=JSON.parse(JSON.stringify(RAW));to.steps[0].to=OTHER;assert.throws(()=>loadV54Plan(to));});
const feeData=a=>'0xa9059cbb'+KIPURSE_FEE_TO.slice(2).toLowerCase().padStart(64,'0')+a.toString(16).padStart(64,'0');
const G=src('owner-sign/guard/kpvh.js');
const guard=hash=>{const ctx={location:{hash},document:{documentElement:{lang:'en'}},crypto:webcrypto,TextEncoder,URLSearchParams,BigInt,Number,String,Array,Uint8Array,Error};vm.createContext(ctx);vm.runInContext(G,ctx);return ctx.kpVH;};
test('deploy batch: deployer + 0.15 USDC fee from the owner; no ETH value; the link commitment admits exactly this batch from the owner',async()=>{
  const C=deployV54Calls(plan);assert.equal(C.length,2);assert.equal(getAddress(C[0].to),getAddress(DEPLOYER));assert.equal(getAddress(C[1].to),getAddress(USDC_BASE));
  assert.equal(C[1].data.toLowerCase(),feeData(150000n));assert.equal(DEPLOY_V54_FEE_USDC,150000n);assert.ok(C.every(c=>BigInt(c.value)===0n));
  const vh=deployV54Commitment(plan,O);assert.equal(vh,'92d0277a1e36c0c4e268424e5e48cb62f317a6561cf709da5bbc4d45e218c302');assert.equal(deployV54Fragment(plan,O),'vh='+vh);
  const req=(calls,from=O)=>({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x2105',from:from.toLowerCase(),atomicRequired:true,calls,capabilities:{}}]});
  const g=guard('#vh='+vh);assert.ok(await g(req(C)));await assert.rejects(g(req([C[0],{...C[1],data:feeData(1000000n)}])),/not exactly/);
  await assert.rejects(g(req([C[0]])),/not exactly/);await assert.rejects(g(req(C,OTHER)),/not exactly/);});
test('deploy page bundle: KPVH guard on, pins the init-code sha256, the adapter and its own paymaster proxy only',()=>{
  const b=src('owner-sign/static/deploy-v54.js');assert.match(b,/^\/\* KPVH-GUARD v1/);assert.match(b,/896ff350a8d71c6a0dd88e348f421b94954ccfad21e3e805c924105a7e2b6a23/);
  assert.match(b,/0x99d8dfec40023f53f6e451f9afff7efc223b7aaa/);assert.match(b,/\/deploy-v54\/paymaster\?id=dv54-/);assert.match(b,/kpVH\(/);
  const m=src('owner-sign/static/migrate-v54.js');assert.match(m,/^\/\* KPVH-GUARD v1/);assert.match(m,/kpVH\(/);assert.match(m,/\/migrate-v54\/paymaster\?id=mg54-/);});
const kvMap=()=>{const m=new Map();return {get:k=>m.get(k),put:(k,v)=>m.set(k,v)};};
const upstream=async()=>({json:async()=>({jsonrpc:'2.0',id:1,result:{paymaster:'0x9d3927128b74460e164a1b1dee445d490e7eca72',paymasterData:'0x01',isFinal:false}})});
test('sponsor: V5.4 deploy / migration ids are refused the moment their gate closes (deploy done / wallet not where the batch starts)',async()=>{
  const st={d:true,m:true};const sp=createOnboardSponsor({cfg:{url:'https://pm.example',maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25},kv:kvMap(),reg:{byOwner:()=>[]},ethUsd8:async()=>176100000000n,lookup:()=>null,gasPrice:async()=>6000000n,fetchImpl:upstream,
    deployV54Open:async()=>st.d,migrateV54Open:async()=>st.m});
  const C=deployV54Calls(plan);const id=sp.registerDeployV54('t',{owner:O,calls:C,reimburse:150000n,realGas:10300000n});assert.match(String(id),/^dv54-/);
  const mid=sp.registerMigrateV54('t',{owner:O,wallet:W,adapter:MG.ADAPTER_V54,calls:C,reimburse:30000n,realGas:2500000n,mode:'migrate'});assert.match(String(mid),/^mg54-/);
  const S=src('src/v5/onboard-sponsor.mjs');assert.match(S,/if\(!op0\)return 'deploy_closed';\}   \/\/ t1214/);assert.match(S,/if\(!op0\)return 'migrate_closed';\}/);});
const P0={account:W,spender:'0x05320BeD08309F66316F7d73e2D0be110400FbB2',token:USDC_BASE,allowance:'1000000',period:86400,start:1,end:2000000000,salt:'4',extraData:'0x1234'};
const S0=(o={})=>({wallet:W,v54Deployed:true,oldPermissionValid:true,alreadyMigrated:false,oldPermission:P0,oldAdapter:'0x05320BeD08309F66316F7d73e2D0be110400FbB2',nextOwnerIndex:7n,
  oldApprover:{address:'0x1111111111111111111111111111111111111111',index:5n,x:1n,y:2n},float:{open:false},oldVaultReserved:0n,vaultV54:'0x2222222222222222222222222222222222222222',
  trusts:[{merchant:'0x'+'ab'.repeat(32),name:'shop.example',payees:[OTHER],signers:[],single:'1000000',daily:'2000000',expiry:'2000000000'}],floatCap:200000n,deniedPayees:[],deniedSigners:[],paused:false,registryOptOut:false,...o});
test('migration pre-check: open float closes in the batch; reserved USDC without known digests, an in-flight payment, no V5.4 code or no phone approver stop it',()=>{
  assert.deepEqual(MG.precheck(S0()),{ok:true,block:[],close:[]});
  const f=MG.precheck(S0({float:{open:true}}));assert.ok(f.ok);assert.deepEqual(f.close,[{kind:'float',call:'reconcileFloat'}]);
  assert.deepEqual(MG.precheck(S0({oldVaultReserved:5n})).block,['vault_reserved_unknown']);assert.ok(MG.precheck(S0({oldVaultReserved:5n,openReservations:['0x'+'cd'.repeat(32)]})).ok);
  assert.deepEqual(MG.precheck(S0({serverInFlight:true})).block,['server_in_flight']);assert.deepEqual(MG.precheck(S0({v54Deployed:false})).block,['v54_not_deployed']);
  assert.deepEqual(MG.precheck(S0({oldApprover:null})).block,['no_phone_approver']);});
test('migration batch: only the wallet, the deployer and the V5.4 adapter are called; same policy bytes, new salt; fee capped at 0.10 USDC',()=>{
  const m=MG.migrationCalls(S0({float:{open:true}}),{fee:34655n});const allowed=new Set([W,DEPLOYER,MG.ADAPTER_V54].map(a=>getAddress(a)));
  for(const c of m.calls)assert.ok(allowed.has(getAddress(c.to)),c.label);
  assert.deepEqual(m.calls.map(c=>c.label),['close_float_v52','fee_from_kipurse_wallet','deploy_phone_approver_v4','add_phone_approver_v4','approve_v54_permission','revoke_v52_permission','remove_phone_approver_v3','register_v54_permission','vault_fee_reserve','reapply_trust:shop.example','reapply_float_cap']);
  assert.equal(m.newPermission.extraData,P0.extraData);assert.equal(m.newPermission.salt,5n);assert.equal(getAddress(m.newPermission.spender),getAddress(MG.ADAPTER_V54));assert.equal(m.newPermission.allowance,1000000n);
  assert.throws(()=>MG.migrationCalls(S0(),{fee:100001n}),/fee cap/);assert.throws(()=>MG.migrationCalls(S0(),{fee:0n}),/fee cap/);
  assert.throws(()=>MG.migrationCalls(S0({serverInFlight:true}),{fee:1n}),/precheck/);
  const q=MG.migrateFee({gasPriceWei:6000000n,ethUsd8:173273000000n});assert.ok(q.usdc>20000n&&q.usdc<50000n,String(q.usdc));assert.equal(q.overCap,false);
  assert.equal(MG.migrateFee({gasPriceWei:100000000n,ethUsd8:173273000000n}).overCap,true);});
test('rollback batch: fee leg, a NEW V5.2 permission (revoked hashes never return), V5.4 revoked, approver V3 back, V4 out, reserve back, V5.2 vault re-registered',()=>{
  const m=MG.migrationCalls(S0(),{fee:34655n});const r=MG.rollbackCalls(S0(),{fee:19061n,migrated:{newPermission:m.newPermission,approver:m.approver,newApproverIndex:7n,vaultBalance:150000n}});
  assert.deepEqual(r.calls.map(c=>c.label),['fee_from_kipurse_wallet','approve_v52_permission_again','revoke_v54_permission','re_add_phone_approver_v3','remove_phone_approver_v4','vault_reserve_back_to_wallet','register_v52_permission_again']);
  assert.equal(r.v52Permission.salt,6n);assert.equal(r.v52Permission.extraData,P0.extraData);assert.equal(getAddress(r.v52Permission.spender),getAddress(P0.spender));});
test('migration endpoints: the sponsor gate opens only for this wallet and only where the batch starts',async()=>{
  const pub={readContract:async()=>false};const M=MG.createMigrateV54({owner:O,wallet:W,pub,sponsor:null,known:async()=>({}),store:{get:()=>null,put:()=>{}},ethUsd8:async()=>1n,readRaw});
  assert.equal(await M.open({wallet:OTHER,mode:'migrate'}),false);assert.equal(await M.open({wallet:W,mode:'migrate'}),true);assert.equal(await M.open({wallet:W,mode:'rollback'}),false);
  const [c]=await M.prepare({from:OTHER});assert.equal(c,400);});
test('router: V5.4 paths are not served unless their (flag-gated) handlers exist',()=>{
  const R=src('src/v5/router.mjs');assert.match(R,/if\(deployV54&&\(u\.pathname==='\/deploy-v54'/);assert.match(R,/if\(migrateV54&&\(u\.pathname==='\/migrate-v54'/);});
test('engine: paySignedTrusted only with a V5.4 grant AND the wired signerGrant hook; deny / registry block still win; V5.2 path unchanged otherwise',()=>{
  const E=src('src/v5/engine.mjs');assert.match(E,/if\(o\.grant&&typeof cfg\.signerGrant==='function'\)return \{functionName:'paySignedTrusted'/);
  assert.match(E,/const viaGrant=async\(why\)=>\{if\(typeof cfg\.signerGrant!=='function'\)return null;/);
  const i=E.indexOf("const viaGrant"),d=E.lastIndexOf("if(await rd('deniedSigner',[p.account,s]))return {tier:'denied',reason:'signer_denied'};",i);assert.ok(d>0&&d<i);});
test('phone kind-5 wrapper: SignatureWrapper(ownerIndex, abi.encode(5, SignerTrust body, r, s))',()=>{
  const m={merchant:ST.merchantId('shop.example'),name:'shop.example',signers:[OTHER],single:'1000000',daily:'2000000',expiry:'2000000000',nonce:'0x'+'11'.repeat(32),deadline:'2000000000'};
  const w=ST.phoneSignerTrustWrapper(6,m,'0x01','0x02');const [o]=decodeAbiParameters([{type:'tuple',components:[{name:'ownerIndex',type:'uint256'},{name:'signatureData',type:'bytes'}]}],w);
  assert.equal(o.ownerIndex,6n);const [k,,r,s]=decodeAbiParameters([{type:'uint8'},{type:'bytes'},{type:'uint256'},{type:'uint256'}],o.signatureData);assert.equal(k,5);assert.equal(r,1n);assert.equal(s,2n);
  const kv=new Map();const gs=ST.createGrantStore({get:k=>kv.get(k),set:(k,v)=>kv.set(k,v)});gs.put({wallet:W,...m,grant:'0xaa'});
  assert.equal(gs.bySigner(W,OTHER).name,'shop.example');assert.equal(gs.bySigner(W,O),null);});
test('trust card (phone): kind-5 grant only when the V5.4 hook is wired and the request names order signers; verified on chain before storing',()=>{
  const T=src('src/v5/trust-approve-public.mjs');assert.match(T,/if\(signerGrant&&!c\.grant&&\(c\.inner\.message\?\.signers\?\?\[\]\)\.length\)/);
  assert.match(T,/gok=v\?\.status==='trusted'&&await phone\.verifyWrapped\(c\.grant\.digest,gw\)/);/* t1240: verified on chain after the trust lands (grant is for the next epoch) */assert.match(T,/\.\.\.\(c\.grant\?\{signerGrant:/);
  const L=src('mainnet/mainnet-owner-launch.mjs');assert.match(L,/const SGH=SU\.name==='v5\.4'&&cfg\.signerGrant\?/);assert.match(L,/createPublicTrustApproval\(\{signerGrant:SGH,/);
  /* t1240 decision 110 (owner decision 2026-11-21): owner asks MAY add the kind-5 grant, but only for a signer the engine verified (spec.signer, never AI
     input), only with the hook wired, and the grant signature is verified on chain (isValidSignature) before it is stored */
  const OA=src('src/v5/owner-ask-approve.mjs');assert.match(OA,/const sgn=signerGrant&&\/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(String\(a\.spec\?\.signer/);
  assert.match(OA,/gok=p256Verify\(cap\.active,rs,/);assert.match(OA,/wok=await verifyWrapped\(c\.trust\.grant\.digest,gw\)/);assert.match(OA,/if\(!gok\)return \[403,\{error:'not_owner',part:'signer_grant'\}\]/);
  assert.match(OA,/if\(trust\.state==='trusted'&&c\.trust\.grant&&gw\)/);assert.match(L,/signerGrant:SGH\/\* t1240/);});
test('migration batch: a balance left in the old V5.2 vault comes back to the wallet in the same batch (nothing stranded)',()=>{
  const m=MG.migrationCalls(S0({oldVault:'0x08FdA35764ea7999E69f644688552ff91b277d42',oldVaultBalance:7n}),{fee:34655n});
  const i=m.calls.findIndex(c=>c.label==='old_v52_vault_back_to_wallet');assert.ok(i>0);assert.equal(getAddress(m.calls[i].to),getAddress(W));
  assert.equal(MG.migrationCalls(S0({oldVault:'0x08FdA35764ea7999E69f644688552ff91b277d42',oldVaultBalance:0n}),{fee:34655n}).calls.some(c=>c.label==='old_v52_vault_back_to_wallet'),false);});
test('t1214 Coinbase rule: no top-level call in the migration or rollback batch carries a CBSW owner/upgrade selector; owner changes are wallet self-calls',async()=>{
  const {decodeFunctionData,parseAbi:pa,toFunctionSelector:sel}=await import('viem');
  const BAD=new Set(MG.OWNER_SELECTOR_NAMES.map(n=>sel(n)));
  for(const n of ['0x0f0f3f24','0x29565e3b','0x89625b57','0xb8197367','0x4f1ef286'])assert.ok(BAD.has(n),n);   // addOwnerAddress addOwnerPublicKey removeOwnerAtIndex removeLastOwner upgradeToAndCall
  const m=MG.migrationCalls(S0({float:{open:true}}),{fee:34655n});
  const r=MG.rollbackCalls(S0(),{fee:19061n,migrated:{newPermission:m.newPermission,approver:m.approver,newApproverIndex:7n,vaultBalance:150000n}});
  // wallet_sendCalls shape the page hands to the Coinbase SDK: calls[] = {to,value,data}
  for(const b of [m.calls,r.calls]){const sendCalls={version:'1.0',chainId:'0x2105',calls:b.map(c=>({to:c.to,value:c.value??'0x0',data:c.data}))};
    for(const c of sendCalls.calls)assert.ok(!BAD.has(c.data.slice(0,10).toLowerCase()),'top-level owner/upgrade selector '+c.data.slice(0,10));
    assert.deepEqual(MG.ownerUpgradeTopLevel(sendCalls.calls),[]);}
  const X=pa(['function execute(address target,uint256 value,bytes data)']);
  for(const [b,lbls] of [[m.calls,['add_phone_approver_v4','remove_phone_approver_v3']],[r.calls,['re_add_phone_approver_v3','remove_phone_approver_v4']]])for(const l of lbls){
    const c=b.find(x=>x.label===l);assert.equal(getAddress(c.to),getAddress(W));const d=decodeFunctionData({abi:X,data:c.data});
    assert.equal(getAddress(d.args[0]),getAddress(W),l+' inner target is the wallet itself');assert.equal(d.args[1],0n);assert.ok(BAD.has(d.args[2].slice(0,10)),l+' inner is the owner op');}
  assert.deepEqual(MG.ownerUpgradeTopLevel([{to:W,data:'0x0f0f3f24'+'00'.repeat(32)}]),[0]);});
