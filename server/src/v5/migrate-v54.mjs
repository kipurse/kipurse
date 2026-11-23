// SPDX-License-Identifier: AGPL-3.0-only
// t1214 (§6#102, owner t1230u; §6#101 owner t1227u): the owner's wallet switch from the V5.2 suite to V5.4 ("换合约"), PREPARED ONLY.
// The owner's own Base Account confirms ONE batch in Coinbase. The wallet address and its money stay where they are; the owner keeps
// view / stop / revoke / withdraw-all the whole time (his Base Account stays owner[0]; withdraw never involves any adapter).
//   0. close anything still open on V5.2 (float session -> wallet.reconcileFloat path, x402 reservations -> wallet.cancelReservation)
//   1. wallet.execute(USDC, transfer(fee address, F))      F = actual network cost in USDC, 0% markup, 0 < F <= 0.10 (Kipurse wallet pays)
//   2. deployer <- KipursePhoneApproverV4(wallet, trustV54, x, y)  (the SAME Face ID key as today's V3 approver, read from chain)
//   3. wallet.addOwnerAddress(approverV4)
//   4. wallet.execute(SPM, approve(P'))                      P' = today's permission with spender = V5.4 adapter, new salt; policy bytes identical
//   5. wallet.execute(SPM, revoke(P))                        the V5.2 permission stops working in the same batch
//   6. wallet.removeOwnerAtIndex(i, approverV3)             the V5.2-bound phone approver leaves
//   7. adapterV54.registerPermission(P')                     creates the V5.4 payer vault, session = Policy.executor (same as today)
//   8. wallet.execute(USDC, transfer(vaultV54, 0.15))         fee reserve in his own vault (his money; §6#86; back on withdraw)
//   9. re-apply the owner's own V5.2 choices on the V5.4 trust: stored trusts (same name/payees/signers/caps/expiry), float cap,
//      denied payees / signers, registry opt-out, pause (pause last).
// Rollback (owner signs, any time before V5.4 is used): fee leg, approve a NEW V5.2 permission (a revoked hash can never come back),
// revoke P', re-add approverV3, remove approverV4, pull the vault reserve back, register the V5.2 permission again.
// FEATURE FLAG: KIPURSE_MIGRATE_V54=1 enables the /migrate-v54 endpoints for the operator wallet only. Default OFF.
import {encodeFunctionData,encodeAbiParameters,parseAbi,getAddress,getContractAddress,keccak256,concat,toHex,pad,toFunctionSelector} from 'viem';
import fs from 'node:fs';
export const MIGRATE_V54_PREFIX='mg54-';
export const migrateV54On=(env=process.env)=>String(env.KIPURSE_MIGRATE_V54??'').trim()==='1';
export const DETERMINISTIC_DEPLOYER='0x4e59b44847b379578588920cA78FbF26c0B4956C';
export const SPM='0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
export const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const FEE_TO='0xf14ef5dc4723245866c22c749a0a84afceba0dd9';
export const ADAPTER_V54='0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa';
export const TRUST_V54=getContractAddress({from:ADAPTER_V54,nonce:1n});            // created by the adapter's constructor (first CREATE)
export const VAULT_FACTORY='0x34d9Bdc9E10815fB6913AF5BC0DAad7E53dbD57D';
export const MIGRATE_V54_FEE_CAP=100_000n;     // 0.10 USDC hard stop (measured ~2.8M gas ≈ 0.03 USD at 0.006 gwei)
export const MIGRATE_V54_MAX_USD_PER_OP=0.5;   // worst case Kipurse may front for this op (all limits x maxFeePerGas); the batch repays the real cost
export const MIGRATE_V54_REAL_GAS=2_500_000n;   // fork-measured 2,497,555 for the whole batch (t1214)
export const MIGRATE_V54_GAS=2_750_000n;        // fee-quote gas = real x 1.1 (the sponsor's 'underpaid' check uses real x 1.1), 0% markup otherwise
export const ROLLBACK_V54_REAL_GAS=330_000n;    // fork-measured 323,330
export const ROLLBACK_V54_GAS=363_000n;
export const MIGRATE_V54_L1_WEI=2_000_000_000_000n; // L1 data allowance (~2.7 KB of calldata + approver init code ~8 KB)
export const VAULT_SEED=150_000n;               // §6#86 fee reserve, his own money
const ART=JSON.parse(fs.readFileSync(new URL('./phone-approver-v4-artifact.json',import.meta.url)));
const P_T={type:'tuple',components:[{name:'account',type:'address'},{name:'spender',type:'address'},{name:'token',type:'address'},{name:'allowance',type:'uint160'},{name:'period',type:'uint48'},{name:'start',type:'uint48'},{name:'end',type:'uint48'},{name:'salt',type:'uint256'},{name:'extraData',type:'bytes'}]};
export const ABI=parseAbi([
 'function execute(address target,uint256 value,bytes data)','function addOwnerAddress(address owner)','function removeOwnerAtIndex(uint256 index,bytes owner)',
 'function transfer(address to,uint256 amount) returns (bool)','function withdraw(address t,address to,uint256 amount)',
 'struct SP { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }',
 'function approve(SP p) returns (bool)','function revoke(SP p)','function registerPermission(SP p) returns (address)',
 'struct TP { bytes32 merchant; string name; address[] payees; address[] signers; uint160 single; uint160 daily; uint64 expiry; }',
 'function setTrust(TP t)','function setFloatCap(uint160 cap)','function setDeniedPayee(address payee,bool v)','function setDeniedSigner(address signer,bool v)',
 'function setRegistryOptOut(bool v)','function setPaused(bool v)','function cancelReservation(bytes32 digest)','function reconcileFloat(address account)']);
const lc=a=>String(a??'').toLowerCase();
const perm=p=>({account:getAddress(p.account),spender:getAddress(p.spender),token:getAddress(p.token),allowance:BigInt(p.allowance),period:Number(p.period),start:Number(p.start),end:Number(p.end),salt:BigInt(p.salt),extraData:p.extraData});
const ex=(W,target,data,label)=>({to:getAddress(W),value:'0x0',data:encodeFunctionData({abi:ABI,functionName:'execute',args:[getAddress(target),0n,data]}),label});
const enc=(fn,args)=>encodeFunctionData({abi:ABI,functionName:fn,args});
/** CREATE2 data of the V4 approver for this wallet + phone key (same salt scheme as V1–V3, version tag v4). */
export function approverV4({wallet,trust=TRUST_V54,x,y}){const args=encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'}],[getAddress(wallet),getAddress(trust),BigInt(x),BigInt(y)]);
  const initcode=concat([ART.bytecode,args]);const salt=keccak256(concat([toHex('kipurse-phone-approver-v4'),pad(toHex(BigInt(x))),pad(toHex(BigInt(y)))]));
  return {initcode,salt,address:getContractAddress({from:DETERMINISTIC_DEPLOYER,opcode:'CREATE2',salt,bytecode:initcode}),deployData:concat([salt,initcode])};}
/** P' = the live permission moved to the V5.4 adapter: identical account/token/allowance/period/start/end/policy bytes; new salt. */
export function newPermission(old,{salt=null,adapter=ADAPTER_V54}={}){const o=perm(old);return {...o,spender:getAddress(adapter),salt:salt==null?o.salt+1n:BigInt(salt)};}
/** Pre-check: what is still open on V5.2 and what must be closed in (or before) the batch. Pure over a chain snapshot. */
export function precheck(s){const block=[],close=[];
  if(!s.v54Deployed)block.push('v54_not_deployed');
  if(!s.oldPermissionValid)block.push('old_permission_not_valid');
  if(s.alreadyMigrated)block.push('already_migrated');
  if(s.float?.open)close.push({kind:'float',call:'reconcileFloat'});
  for(const d of s.openReservations??[])close.push({kind:'reservation',digest:d});
  if(BigInt(s.oldVaultReserved??0)>0n&&!(s.openReservations??[]).length)block.push('vault_reserved_unknown');   // reserved USDC but the server does not know the digests: stop
  if(s.serverInFlight)block.push('server_in_flight');   // a payment is being sent right now (claims lease / pending userOp)
  if(!s.oldApprover)block.push('no_phone_approver');
  return {ok:!block.length,block,close};}
/** t1214 (owner 08:39 CT: keys.coinbase.com refused the batch: "Account owner or upgrade calls are not allowed."): the Base Account popup
 *  refuses any TOP-LEVEL call with a Coinbase Smart Wallet owner/upgrade selector. No top-level call of ours may carry one; the wallet's
 *  owner changes are wallet.execute(wallet, ...) self-calls (CBSW onlyOwner accepts msg.sender == the wallet). OWNER_SELECTOR_NAMES = source of truth. */
export {ownerUpgradeTopLevel,OWNER_SELECTOR_NAMES} from './owner-selfcall.mjs';import {ownerUpgradeTopLevel} from './owner-selfcall.mjs';
/** The migration batch (owner's Base Account sends; every call is to the wallet itself, the deployer or the V5.4 adapter). */
export function migrationCalls(s,{fee,vaultSeed=VAULT_SEED,salt=null}){const W=getAddress(s.wallet);const f=BigInt(fee);
  if(f<=0n||f>MIGRATE_V54_FEE_CAP)throw Object.assign(Error('fee cap'),{code:'fee_above_cap'});
  const pc=precheck(s);if(!pc.ok)throw Object.assign(Error('precheck: '+pc.block.join(',')),{code:'precheck',block:pc.block});
  const A=approverV4({wallet:W,x:s.oldApprover.x,y:s.oldApprover.y});const P=perm(s.oldPermission),Pn=newPermission(s.oldPermission,{salt});
  const C=[];
  for(const c of pc.close){if(c.kind==='float')C.push(ex(W,s.oldAdapter,enc('reconcileFloat',[W]),'close_float_v52'));else C.push(ex(W,s.oldAdapter,enc('cancelReservation',[c.digest]),'close_reservation_v52'));}
  C.push(ex(W,USDC,enc('transfer',[getAddress(FEE_TO),f]),'fee_from_kipurse_wallet'));
  C.push({to:DETERMINISTIC_DEPLOYER,value:'0x0',data:A.deployData,label:'deploy_phone_approver_v4'});
  C.push(ex(W,W,enc('addOwnerAddress',[A.address]),'add_phone_approver_v4'));   // t1214: wallet self-call (see OWNER_UPGRADE_SELECTORS)
  C.push(ex(W,SPM,enc('approve',[Pn]),'approve_v54_permission'));
  C.push(ex(W,SPM,enc('revoke',[P]),'revoke_v52_permission'));
  C.push(ex(W,W,enc('removeOwnerAtIndex',[BigInt(s.oldApprover.index),pad(getAddress(s.oldApprover.address))]),'remove_phone_approver_v3'));
  C.push({to:getAddress(ADAPTER_V54),value:'0x0',data:enc('registerPermission',[Pn]),label:'register_v54_permission'});
  if(BigInt(s.oldVaultBalance??0)>0n&&s.oldVault)C.push(ex(W,s.oldVault,enc('withdraw',[getAddress(USDC),W,BigInt(s.oldVaultBalance)]),'old_v52_vault_back_to_wallet'));   // nothing left behind in the V5.2 vault
  if(BigInt(vaultSeed)>0n)C.push(ex(W,USDC,enc('transfer',[getAddress(s.vaultV54),BigInt(vaultSeed)]),'vault_fee_reserve'));
  for(const t of s.trusts??[])C.push(ex(W,TRUST_V54,enc('setTrust',[{merchant:t.merchant,name:t.name,payees:t.payees.map(getAddress),signers:t.signers.map(getAddress),single:BigInt(t.single),daily:BigInt(t.daily),expiry:BigInt(t.expiry)}]),'reapply_trust:'+(/^[\x20-\x7e]+$/.test(t.name)?t.name:t.merchant.slice(0,10))));
  if(BigInt(s.floatCap??0)>0n)C.push(ex(W,TRUST_V54,enc('setFloatCap',[BigInt(s.floatCap)]),'reapply_float_cap'));
  for(const a of s.deniedPayees??[])C.push(ex(W,TRUST_V54,enc('setDeniedPayee',[getAddress(a),true]),'reapply_denied_payee'));
  for(const a of s.deniedSigners??[])C.push(ex(W,TRUST_V54,enc('setDeniedSigner',[getAddress(a),true]),'reapply_denied_signer'));
  if(s.registryOptOut)C.push(ex(W,TRUST_V54,enc('setRegistryOptOut',[true]),'reapply_registry_opt_out'));
  if(s.paused)C.push(ex(W,TRUST_V54,enc('setPaused',[true]),'reapply_pause'));
  if(ownerUpgradeTopLevel(C).length)throw Object.assign(Error('owner/upgrade selector at top level'),{code:'owner_call_top_level'});
  return {calls:C,approver:A,newPermission:Pn,oldPermission:P,newApproverIndex:BigInt(s.nextOwnerIndex)};}
/** Rollback batch (owner signs). V5.2 permission comes back as a NEW permission (same policy bytes, next salt). */
export function rollbackCalls(s,{fee,migrated,v52Salt=null}){const W=getAddress(s.wallet);const f=BigInt(fee);
  if(f<=0n||f>MIGRATE_V54_FEE_CAP)throw Object.assign(Error('fee cap'),{code:'fee_above_cap'});
  const Pn=perm(migrated.newPermission),Pb={...perm(s.oldPermission),salt:v52Salt==null?Pn.salt+1n:BigInt(v52Salt)};
  const C=[ex(W,USDC,enc('transfer',[getAddress(FEE_TO),f]),'fee_from_kipurse_wallet'),
    ex(W,SPM,enc('approve',[Pb]),'approve_v52_permission_again'),
    ex(W,SPM,enc('revoke',[Pn]),'revoke_v54_permission'),
    ex(W,W,enc('addOwnerAddress',[getAddress(s.oldApprover.address)]),'re_add_phone_approver_v3'),
    ex(W,W,enc('removeOwnerAtIndex',[BigInt(migrated.newApproverIndex),pad(getAddress(migrated.approver.address))]),'remove_phone_approver_v4'),
    ex(W,s.vaultV54,enc('withdraw',[getAddress(USDC),W,BigInt(migrated.vaultBalance??VAULT_SEED)]),'vault_reserve_back_to_wallet'),
    {to:getAddress(s.oldAdapter),value:'0x0',data:enc('registerPermission',[Pb]),label:'register_v52_permission_again'}];
  if(ownerUpgradeTopLevel(C).length)throw Object.assign(Error('owner/upgrade selector at top level'),{code:'owner_call_top_level'});
  return {calls:C,v52Permission:Pb};}
/** Live fee quote: actual cost in USDC (gas x price + L1 allowance) x ETH/USD, 0% markup, ceil, hard cap. */
export function migrateFee({gas=MIGRATE_V54_GAS,gasPriceWei,ethUsd8,l1Wei=MIGRATE_V54_L1_WEI,cap=MIGRATE_V54_FEE_CAP}){const wei=BigInt(gas)*BigInt(gasPriceWei)+BigInt(l1Wei);
  const usdc=(wei*BigInt(ethUsd8)+10n**20n-1n)/10n**20n;return {usdc,wei,overCap:usdc>BigInt(cap)};}
/** Read the chain snapshot the batch is built from (all read-only). known = server facts: {oldPermission, oldAdapter, oldTrust, trusts, openReservations, serverInFlight, deniedPayees, deniedSigners}. */
export async function readMigrationState(pub,{wallet,known}){const W=getAddress(wallet);
  const R=(address,abi,functionName,args=[])=>pub.readContract({address:getAddress(address),abi:parseAbi(abi),functionName,args});
  const [code,nextIdx]=await Promise.all([pub.getCode({address:ADAPTER_V54}),R(W,['function nextOwnerIndex() view returns (uint256)'],'nextOwnerIndex')]);
  let oldApprover=null;for(let i=0n;i<BigInt(nextIdx);i++){const b=await R(W,['function ownerAtIndex(uint256) view returns (bytes)'],'ownerAtIndex',[i]);if(!b||b==='0x'||b.length!==66)continue;
    const a=getAddress('0x'+b.slice(26));if(lc(a)===lc(known.ownerBase)||lc(a)===lc(SPM))continue;const c=await pub.getCode({address:a});if(!c||c==='0x')continue;
    try{const t=await R(a,['function trust() view returns (address)'],'trust');if(lc(t)!==lc(known.oldTrust))continue;
      const [x,y]=await Promise.all([R(a,['function x() view returns (uint256)'],'x'),R(a,['function y() view returns (uint256)'],'y')]);oldApprover={address:a,index:i,x,y};}catch{}}
  const P=perm(known.oldPermission);const SPMA=['function isValid((address,address,address,uint160,uint48,uint48,uint48,uint256,bytes)) view returns (bool)'];
  const asT=[P.account,P.spender,P.token,P.allowance,P.period,P.start,P.end,P.salt,P.extraData];
  const [valid,fl,vOld,vNew,paused,optOut,floatCap]=await Promise.all([R(SPM,SPMA,'isValid',[asT]),
    R(known.oldAdapter,['function floats(address) view returns (bytes32 permissionHash,uint160 funded,uint160 feeReserve,uint64 expiry,bool open)'],'floats',[W]).catch(()=>null),
    R(known.oldAdapter,['function vaultOf(address) view returns (address)'],'vaultOf',[W]),
    R(VAULT_FACTORY,['function vaultAddress(address adapter,address account,address token) view returns (address)'],'vaultAddress',[ADAPTER_V54,W,USDC]),
    R(known.oldTrust,['function paused(address) view returns (bool)'],'paused',[W]),R(known.oldTrust,['function registryOptOut(address) view returns (bool)'],'registryOptOut',[W]),
    R(known.oldTrust,['function floatCap(address) view returns (uint160)'],'floatCap',[W])]);
  const hasOld=vOld&&lc(vOld)!==lc('0x0000000000000000000000000000000000000000');const reserved=hasOld?await R(vOld,['function reserved() view returns (uint256)'],'reserved'):0n;
  const oldBal=hasOld?await R(USDC,['function balanceOf(address) view returns (uint256)'],'balanceOf',[vOld]):0n;
  const v54Perm=newPermission(known.oldPermission,{salt:known.newSalt??null});
  return {wallet:W,v54Deployed:!!code&&code!=='0x',nextOwnerIndex:BigInt(nextIdx),oldApprover,oldPermission:known.oldPermission,oldPermissionValid:valid,oldAdapter:known.oldAdapter,
    float:fl?{open:!!fl[4],funded:fl[1],expiry:fl[3]}:null,oldVault:hasOld?vOld:null,oldVaultReserved:reserved,oldVaultBalance:oldBal,vaultV54:vNew,paused,registryOptOut:optOut,floatCap,
    trusts:(known.trusts??[]).filter(t=>BigInt(t.expiry)>BigInt(Math.floor(Date.now()/1000))+3600n),deniedPayees:known.deniedPayees??[],deniedSigners:known.deniedSigners??[],
    openReservations:known.openReservations??[],serverInFlight:!!known.serverInFlight,alreadyMigrated:false,newPermissionPreview:v54Perm};}

/* ---------------- t1214: /migrate-v54 endpoints (flag KIPURSE_MIGRATE_V54=1, the operator wallet only; default OFF) ----------------
 * The developer/test App (§6#101: never the public App) reads /migrate-v54/plan, decodes + checks every call itself, computes the KPVH
 * commitment and opens  <base>/migrate-v54?mode=migrate#vh=<commitment>  in Safari. That page asks /migrate-v54/prepare for the SAME
 * batch (fresh chain read, live fee quote), the guard refuses anything else, and the owner's Base Account confirms once in Coinbase.
 * Kipurse's paymaster fronts the gas for that exact batch only (callsHash gate); the wallet repays the actual cost in USDC inside it.
 * deps: owner (Base Account), wallet, pub, sponsor, known: async()=>({oldPermission,oldAdapter,oldTrust,trusts,deniedPayees,deniedSigners,
 *       openReservations,serverInFlight}), store {get(),put(v)} for the migration record, ethUsd8 async()=>bigint, gasPrice async()=>bigint,
 *       onMigrated async(record) (switches the server's suite for this wallet; called once, after the chain shows the batch landed). */
import {randomBytes} from 'node:crypto';
import {commitment} from './batch-commit.mjs';import {decodePolicyV5,encodePolicyV5} from './abi.mjs';
/* t1238 §6#109 (owner chose ①: move, then reconnect the AIs): mode 'seat' = move this wallet to a NEW key-seat wallet on V5.4 (src/v5/move-seat.mjs). */
export const MOVE_SEAT_REAL_GAS=3_000_000n;   // fork-measured 2,965,162 for the whole move batch (t1238)
export const MOVE_SEAT_GAS=3_300_000n;        // fee-quote gas = real x 1.1
export const MOVE_SEAT_L1_WEI=4_000_000_000_000n; // L1 data allowance (~9 KB key-seat creation code + ~3 KB calls)
const MODE=m=>m==='rollback'?'rollback':m==='seat'?'seat':'migrate';
export function createMigrateV54({owner,wallet,pub,sponsor,known,store,ethUsd8,gasPrice=null,onMigrated=null,executorFor=null,onMoved=null,base=()=>'https://pay.kipurse.com',readRaw,script=()=>'',maxBody=196608,now=()=>Date.now()}){
  const OWNER=getAddress(owner),W=getAddress(wallet);
  const rec=()=>store.get()??null;
  const SPMA=parseAbi(['function isValid((address,address,address,uint160,uint48,uint48,uint48,uint256,bytes)) view returns (bool)']);
  const asT=p=>{const P=perm(p);return [P.account,P.spender,P.token,P.allowance,P.period,P.start,P.end,P.salt,P.extraData];};
  const isValid=p=>pub.readContract({address:SPM,abi:SPMA,functionName:'isValid',args:[asT(p)]});
  async function snapshot(){const k=await known();const r=rec();const again=r?.rollback?.v52Permission&&r?.rolledBackAt;
    // the V5.2 permission the batch starts from: the one recorded at prepare (rollback), the re-approved one after a rollback, else the live one
    const oldPermission=again?r.rollback.v52Permission:(r?.oldPermission??k.oldPermission);const newSalt=again?BigInt(r.rollback.v52Permission.salt)+1n:(r?.salt??null);
    return readMigrationState(pub,{wallet:W,known:{...k,oldPermission,ownerBase:OWNER,newSalt}});}
  /** where the wallet is: 'v52' (not migrated), 'v54' (migration landed), 'v52_again' (rolled back) */
  async function where(){const r=rec();if(r?.seatMove?.newPermission&&await isValid(r.seatMove.newPermission).catch(()=>false))return 'seat';if(!r?.newPermission)return 'v52';const v4=await isValid(r.newPermission).catch(()=>false);
    if(v4)return 'v54';if(r.rollback?.v52Permission&&await isValid(r.rollback.v52Permission).catch(()=>false))return 'v52_again';return 'v52';}
  async function quote(mode){const [gp,px]=await Promise.all([gasPrice?gasPrice():pub.getGasPrice(),ethUsd8()]);
    if(mode==='seat'){const MS=await import('./move-seat.mjs');return migrateFee({gas:MOVE_SEAT_GAS,gasPriceWei:gp,ethUsd8:px,l1Wei:MOVE_SEAT_L1_WEI,cap:MS.MOVE_SEAT_FEE_CAP});}
    return migrateFee({gas:mode==='rollback'?ROLLBACK_V54_GAS:MIGRATE_V54_GAS,gasPriceWei:gp,ethUsd8:px,l1Wei:mode==='rollback'?MIGRATE_V54_L1_WEI/4n:MIGRATE_V54_L1_WEI});}
  async function build(mode,feeFixed=null){if(mode==='seat'&&(await where())==='seat')throw Object.assign(Error('already moved'),{code:'already_moved'});const s=await snapshot();
    if(mode!=='rollback'){const pc0=precheck(s);if(!pc0.ok)throw Object.assign(Error('precheck'),{code:'precheck',block:pc0.block});}   // say why before quoting
    const q=feeFixed!=null?{usdc:BigInt(feeFixed),overCap:BigInt(feeFixed)>(mode==='seat'?150_000n:MIGRATE_V54_FEE_CAP)}:await quote(mode);if(q.overCap)throw Object.assign(Error('fee above cap'),{code:'fee_above_cap'});
    if(mode==='seat'){const w=await where();if(w==='seat')throw Object.assign(Error('already moved'),{code:'already_moved'});if(w!=='v52')throw Object.assign(Error('wallet is not on V5.2'),{code:'not_v52'});
      const MS=await import('./move-seat.mjs');const {seat,owners}=MS.newSeatWallet({owner:OWNER});
      const NW=getAddress(await pub.readContract({address:MS.CB_FACTORY,abi:parseAbi(['function getAddress(bytes[] owners,uint256 nonce) view returns (address)']),functionName:'getAddress',args:[owners,0n]}));
      const vaultNew=getAddress(await pub.readContract({address:VAULT_FACTORY,abi:parseAbi(['function vaultAddress(address adapter,address account,address token) view returns (address)']),functionName:'vaultAddress',args:[ADAPTER_V54,NW,USDC]}));
      const sc=await pub.getCode({address:seat.address});const bal=await pub.readContract({address:USDC,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[W]});
      const move=BigInt(bal)+BigInt(s.oldVaultBalance??0)-q.usdc;
      if(!executorFor)throw Object.assign(Error('no executor for the new wallet'),{code:'unavailable'});const pol=decodePolicyV5(perm(s.oldPermission).extraData);const newExtraData=encodePolicyV5({...pol,executor:getAddress(executorFor(NW))});
      const r0=rec();const m=MS.moveToSeatCalls(s,{owner:OWNER,newWallet:NW,vaultNew,fee:q.usdc,move,oldTrust:(await known()).oldTrust,seatDeployed:!!sc&&sc!=='0x',salt:r0?.seatMove?.salt??null,newExtraData});
      return {mode,state:s,fee:q.usdc,calls:m.calls,extra:{seatMove:{newWallet:NW,seat:m.seat,vaultNew,newPermission:m.newPermission,oldPermission:m.oldPermission,salt:m.newPermission.salt,x:s.oldApprover.x,y:s.oldApprover.y,move:m.move}},extraAllowed:[NW,MS.CB_FACTORY],realGas:MOVE_SEAT_REAL_GAS};}
    if(mode==='rollback'){const r=rec();if(!r?.newPermission||(await where())!=='v54')throw Object.assign(Error('not migrated'),{code:'not_migrated'});
      const bal=await pub.readContract({address:USDC,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[getAddress(s.vaultV54)]});
      const migrated={newPermission:r.newPermission,approver:{address:r.approver},newApproverIndex:BigInt(r.newApproverIndex),vaultBalance:BigInt(bal)};
      const rb=rollbackCalls({...s,oldApprover:{address:r.oldApprover}},{fee:q.usdc,migrated});
      return {mode,state:s,fee:q.usdc,calls:rb.calls,extra:{v52Permission:rb.v52Permission},realGas:ROLLBACK_V54_REAL_GAS};}
    if((await where())==='v54')throw Object.assign(Error('already migrated'),{code:'already_migrated'});
    const pc=precheck(s);if(!pc.ok)throw Object.assign(Error('precheck'),{code:'precheck',block:pc.block});
    const r0=rec();const m=migrationCalls(s,{fee:q.usdc,salt:r0?.rolledBackAt?BigInt(r0.rollback.v52Permission.salt)+1n:(r0?.salt??null)});
    return {mode,state:s,fee:q.usdc,calls:m.calls,extra:{oldPermission:s.oldPermission,newPermission:m.newPermission,approver:m.approver.address,newApproverIndex:m.newApproverIndex,oldApprover:s.oldApprover.address,salt:m.newPermission.salt},realGas:MIGRATE_V54_REAL_GAS};}
  const ser=x=>JSON.parse(JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v));
  const pub_=c=>({to:c.to,value:c.value??'0x0',data:c.data});
  /** The plan the test App checks (read-only; no sponsor id). */
  // the fee the test App saw in /plan is the fee the page's batch carries (else the #vh commitment would not match); 15 min, then re-plan
  const PLAN_TTL=15*60e3;const planFee=mode=>{const r=rec();const f=r?.planFee?.[mode];return f&&now()-f.at<PLAN_TTL?f.fee:null;};
  async function plan(mode){const b=await build(mode);const calls=b.calls.map(pub_);store.put({...(rec()??{}),planFee:{...(rec()?.planFee??{}),[mode]:{fee:String(b.fee),at:now()}}});
    return {mode,wallet:W,owner:OWNER,adapterV54:ADAPTER_V54,trustV54:TRUST_V54,fee:String(b.fee),vaultSeed:mode==='rollback'?'0':String(VAULT_SEED),...(mode==='seat'?{newWallet:b.extra.seatMove.newWallet,seat:b.extra.seatMove.seat}:{}),labels:b.calls.map(c=>c.label),calls,
      precheck:precheck(b.state),commitment:commitment({chainId:8453,from:OWNER,calls}),link:`${base()}/migrate-v54?mode=${mode}`,extra:ser(b.extra)};}
  async function prepare(body){let from;try{from=getAddress(String(body?.from??''));}catch{return [400,{error:'not_owner'}];}if(from!==OWNER)return [400,{error:'not_owner'}];
    const mode=MODE(body?.mode);const pf=planFee(mode);if(pf==null)return [409,{error:'plan_expired'}];let b;try{b=await build(mode,pf);}catch(e){return [409,{error:e.code??'unavailable',block:e.block}];}
    const calls=b.calls.map(pub_);
    const id=sponsor?.registerMigrateV54?.(randomBytes(12).toString('hex'),{owner:OWNER,wallet:W,adapter:ADAPTER_V54,calls,reimburse:b.fee,realGas:b.realGas,mode,extraAllowed:b.extraAllowed??[]});if(!id)return [503,{error:'unavailable'}];
    if(mode==='seat')store.put({...(rec()??{}),seatMove:ser(b.extra.seatMove),seatPreparedAt:now()});
    else if(mode==='migrate')store.put({...(rec()??{}),...ser(b.extra),preparedAt:now(),rolledBackAt:null,rollback:null});else store.put({...(rec()??{}),rollback:ser(b.extra)});
    return [200,{id,chainId:8453,from:OWNER,mode,calls,fee:String(b.fee),paymaster:`${base()}/migrate-v54/paymaster?id=${id}`}];}
  /** Sponsor gate (o = the sponsor record): only the prepared wallet, only while the chain is where that mode starts. */
  async function open(o){if(!o||getAddress(o.wallet)!==W)return false;const w=await where();return o.mode==='rollback'?w==='v54':o.mode==='seat'?w==='v52':w!=='v54'&&w!=='seat';}
  let switched=false;
  async function status(){const w=await where();const r=rec();
    if(w==='v54'&&!r?.migratedAt){store.put({...r,migratedAt:now(),rolledBackAt:null});}
    if(w==='v52_again'&&!r?.rolledBackAt){store.put({...r,rolledBackAt:now(),migratedAt:null});switched=false;}
    if(w==='v54'&&onMigrated&&!switched){switched=true;try{await onMigrated(rec());}catch{switched=false;}}
    if(w==='seat'){const r2=rec();if(!r2.movedAt)store.put({...r2,movedAt:now()});if(onMoved&&!rec().moveRegistered){try{await onMoved(rec());store.put({...rec(),moveRegistered:now()});}catch{}}}
    return {where:w,migrated:w==='v54'||w==='seat'/* the page script shows done on migrated */,rolledBack:w==='v52_again',moved:w==='seat',...(w==='seat'?{newWallet:rec().seatMove.newWallet}:{})};}
  const J=(res,c,o,h={})=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store',...h});res.end(JSON.stringify(o));};
  async function handle(req,res,u){const p=u.pathname;
    if(p==='/migrate-v54/plan'&&req.method==='GET'){try{return J(res,200,await plan(MODE(u.searchParams.get('mode')))),true;}catch(e){return J(res,409,{error:e.code??'unavailable',block:e.block}),true;}}
    if(p==='/migrate-v54/status'&&req.method==='GET'){try{return J(res,200,await status()),true;}catch{return J(res,503,{error:'rpc'}),true;}}
    if(p==='/migrate-v54/prepare'&&req.method==='POST'){let b={};try{b=JSON.parse(await readRaw(req)||'{}');}catch{}try{const [c,o]=await prepare(b);return J(res,c,o),true;}catch{return J(res,503,{error:'rpc'}),true;}}
    if(p==='/migrate-v54'&&(req.method==='GET'||req.method==='HEAD')){const nonce=randomBytes(16).toString('base64');const mode=MODE(u.searchParams.get('mode'));
      const zh=!/^en/i.test(String(u.searchParams.get('lang')??req.headers?.['accept-language']??'zh'));const t=(a,b)=>zh?a:b;
      const data=JSON.stringify({owner:OWNER,mode,prepare:'/migrate-v54/prepare',status:'/migrate-v54/status'}).replace(/</g,'\\u003c');
      const html=`<!doctype html><html lang=${zh?'zh':'en'}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=referrer content=no-referrer><title>${t('换到 V5.4（开发者）','Switch to V5.4 (developer)')}</title><style>body{margin:0;background:#F2F2F7;color:#111;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}.w{max-width:480px;margin:0 auto;padding:24px 18px 40px}.c{background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0}.m{color:#666;font-size:14px}button{display:block;box-sizing:border-box;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px;background:#0052FF;color:#fff}</style><div class=w>
<h2>${mode==='rollback'?t('换回 V5.2（开发者）','Switch back to V5.2 (developer)'):mode==='seat'?t('把钱搬到你的新启付钱包（开发者）','Move to your new Kipurse wallet (developer)'):t('把你的启付钱包换到 V5.4（开发者）','Switch your Kipurse wallet to V5.4 (developer)')}</h2>
<div class=c><div class=m>${mode==='seat'?t('一次确认：开一个新的启付钱包（你的 Base 账户、你的 Face ID 钥匙座、付款授权管理器是它仅有的三个主人，你这台手机的 Face ID 钥匙原样登记），把旧钱包里的钱、上限、信任记录全部搬过去，旧钱包停止 AI 付款。只有你的 Base 账户能确认；手续费按实际成本从启付钱包里的 USDC 付，不用 ETH。搬完后在 App 里退出再登录，再把各个 AI 重新连一次。内容和 App 检查过的不一致时，页面会停下，什么都不提交。','One confirmation: opens a new Kipurse wallet (its only owners are your Base Account, your Face ID key seat and the spend permission manager; this phone\'s Face ID key is registered as is), moves the money, limits and trust records from the old wallet, and stops AI payments on the old wallet. Only your Base Account can confirm; the fee is the actual cost, paid in USDC from your Kipurse wallet, never ETH. Afterwards sign out and back in in the app, then reconnect each AI. If anything differs from what the app checked, this page stops and submits nothing.'):t('钱包地址和里面的钱都不变。只有你的 Base 账户能确认；手续费按实际成本从启付钱包里的 USDC 付，不用 ETH。内容和测试版 App 检查过的不一致时，页面会停下，什么都不提交。','The wallet address and its money stay the same. Only your Base Account can confirm; the fee is the actual cost, paid in USDC from your Kipurse wallet, never ETH. If anything differs from what the test App checked, this page stops and submits nothing.')}</div></div>
<button id=go>${t('在 Coinbase 里确认','Confirm in Coinbase')}</button><p class=m id=st></p>
<script type="application/json" id=kp-data>${data}</script><script nonce="${nonce}" src="/migrate-v54.js"></script></div></html>`;
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; form-action 'none'; frame-ancestors 'none'`});res.end(req.method==='HEAD'?undefined:html);return true;}
    if(p==='/migrate-v54.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(script());return true;}
    if(p==='/migrate-v54/paymaster'){const cors={'access-control-allow-origin':'*','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','cache-control':'no-store'};
      if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return true;}
      if(req.method!=='POST'||!sponsor?.enabled)return J(res,404,{error:'not_found'},cors),true;
      const id=String(u.searchParams.get('id')??'');if(!id.startsWith(MIGRATE_V54_PREFIX))return J(res,404,{error:'not_found'},cors),true;
      let b;try{b=JSON.parse(await readRaw(req,maxBody)||'{}');}catch(e){return J(res,e?.status===413?413:400,{error:e?.status===413?'too_large':'bad_json'},cors),true;}
      const r=await sponsor.rpc(id,b,{lang:'en'});return J(res,200,r,cors),true;}
    return false;}
  return {handle,plan,prepare,open,status,where,build};}
