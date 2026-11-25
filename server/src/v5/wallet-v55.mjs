// SPDX-License-Identifier: AGPL-3.0-only
// t1250 (decision 119, owner decision "option A"): the owner opens a NEW V5.5 wallet and moves his USDC out of his V5.4 wallet.
// PREPARED ONLY: these functions build the call lists his Base Account confirms in ONE Coinbase popup; nothing here signs or sends.
//   new wallet  : Coinbase factory createAccount([Base Account, KipurseKeySeatV2, SpendPermissionManager], 0) - all owners fixed at creation
//                 (Coinbase refuses owner changes, decision 108), seat V2 deployed (CREATE2) + the SAME phone key, V5.5 spend permission approved
//                 by the new wallet and registered BY THE WALLET (V5.5: only the account or the executor may register), vault fee reserve,
//                 the owner's stored trusts / denies / float cap / opt-out / recovery re-applied on KipurseTrustV55.
//   old wallet  : close anything still open on V5.4 (x402 reservations, float), V5.4 vault -> old wallet, network fee (USDC, wallet pays),
//                 revoke the V5.4 spend permission, pause on the V5.4 trust, every remaining USDC -> the new wallet.
// No call, at any depth, adds or removes an owner; no top-level call goes to the Base Account or the SpendPermissionManager (coinbase-rule).
// Not imported by any running path unless KIPURSE_V55=1.
import {encodeFunctionData,getAddress,parseAbi} from 'viem';
import {V55,V54} from './suite-v55.mjs';
import {seatV2Init,seatV2Owners,setKeyCallV2,cbswAddress} from './seat-v2.mjs';
import {coinbaseRefuses} from './coinbase-rule.mjs';
import {decodePolicyV5,encodePolicyV5} from './abi.mjs';
export const MOVE_V55_FEE_CAP=150_000n;     // 0.15 USDC hard stop (fork-measured cost is far lower)
export const VAULT_SEED_V55=150_000n;      // decision 86 fee reserve in the new vault (his own money; back on withdraw)
/** Fork-measured gas of the whole move batch (see test/fork/t1250-v55-suite-fork.e2e.mjs); fee quote uses real x 1.1. */
export const MOVE_V55_REAL_GAS=2_900_000n;   // fork-measured 2,882,558 for the whole move batch (block 60897935)
export const MOVE_V55_GAS=3_190_000n;
export const MOVE_V55_L1_WEI=4_000_000_000_000n;
const A=parseAbi(['function execute(address target,uint256 value,bytes data)','function transfer(address,uint256) returns (bool)',
  'function approve((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData))',
  'function revoke((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData))',
  'function registerPermission((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData))',
  'function reconcileFloat(address)','function cancelReservation(bytes32)','function withdraw(address,address,uint256)',
  'function setTrust((bytes32 merchant,string name,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry))',
  'function setFloatCap(uint160)','function setDeniedPayee(address,bool)','function setDeniedSigner(address,bool)','function setRegistryOptOut(bool)','function setPaused(bool)','function setRecovery(address)',
  'function setOpsPerDay(uint32)','function setBundlerFee(address,uint96)','function createAccount(bytes[] owners,uint256 nonce)']);
const enc=(fn,args)=>encodeFunctionData({abi:A,functionName:fn,args});
const ex=(W,target,data,label)=>({to:getAddress(W),value:'0x0',data:enc('execute',[getAddress(target),0n,data]),label});
export const perm=p=>({account:getAddress(p.account),spender:getAddress(p.spender),token:getAddress(p.token),allowance:BigInt(p.allowance),period:Number(p.period),start:Number(p.start),end:Number(p.end),salt:BigInt(p.salt),extraData:p.extraData});
/** The new wallet's V5.5 permission: same token / allowance (= term cap) / period / window as the old one; spender = V5.5 adapter;
 *  policy identical except its OWN server executor and, if the registry tier is used, KipurseMerchantRegistryV2. */
export function permissionV55(old,{newWallet,executor,salt=null,registry=V55.registryV2,adapter=V55.adapter}){const o=perm(old);const pol=decodePolicyV5(o.extraData);
  const np={...pol,executor:getAddress(executor),registry:BigInt(pol.verifiedSingle??0)>0n&&!/^0x0{40}$/i.test(String(pol.registry))?getAddress(registry):pol.registry};
  return {...o,account:getAddress(newWallet),spender:getAddress(adapter),salt:salt==null?0n:BigInt(salt),extraData:encodePolicyV5(np)};}
/** Pre-check of the OLD wallet snapshot (pure). block = refuse to build; close = calls the batch must include first. */
export function precheckExit(s){const block=[],close=[];
  if(!s.v55Deployed)block.push('v55_not_deployed');
  if(!s.oldPermissionValid)block.push('old_permission_not_valid');
  if(s.serverInFlight)block.push('server_in_flight');
  if(s.float?.open)close.push({kind:'float'});
  for(const d of s.openReservations??[])close.push({kind:'reservation',digest:d});
  if(BigInt(s.oldVaultReserved??0)>0n&&!(s.openReservations??[]).length)block.push('vault_reserved_unknown');
  if(s.newWalletDeployed)block.push('new_wallet_exists');
  return {ok:!block.length,block,close};}
/** OLD wallet exit (V5.4): close open items, vault -> wallet, fee, revoke, pause, all USDC -> new wallet. */
export function exitV54Calls(s,{newWallet,fee,move,pauseOld=true}){const W=getAddress(s.wallet),NW=getAddress(newWallet),f=BigInt(fee),mv=BigInt(move);
  const pc=precheckExit({...s,newWalletDeployed:false});if(!pc.ok)throw Object.assign(Error('precheck: '+pc.block.join(',')),{code:'precheck',block:pc.block});
  if(f<0n||f>MOVE_V55_FEE_CAP)throw Object.assign(Error('fee cap'),{code:'fee_above_cap'});
  const oldA=getAddress(s.oldAdapter??V54.adapter),oldT=getAddress(s.oldTrust??V54.trust);const C=[];
  for(const c of pc.close)C.push(c.kind==='float'?ex(W,oldA,enc('reconcileFloat',[W]),'old: close float (V5.4)'):ex(W,oldA,enc('cancelReservation',[c.digest]),'old: cancel open x402 reservation (V5.4)'));
  // cancelled reservations are refunded from the vault to the old wallet inside this batch, so only the unreserved part is withdrawn here
  const vOut=BigInt(s.oldVaultBalance??0)-BigInt(s.oldVaultReserved??0);
  if(vOut>0n&&s.oldVault)C.push(ex(W,s.oldVault,enc('withdraw',[getAddress(V55.usdc),W,vOut]),'old: V5.4 vault -> old wallet'));
  if(f>0n)C.push(ex(W,V55.usdc,enc('transfer',[getAddress(V55.feeTo),f]),'old: network fee (Kipurse wallet pays, USDC)'));
  C.push(ex(W,V55.spm,enc('revoke',[perm(s.oldPermission)]),'old: revoke V5.4 spend permission'));
  if(pauseOld)C.push(ex(W,oldT,enc('setPaused',[true]),'old: pause on the V5.4 trust (no AI payment can start there)'));
  if(mv>0n)C.push(ex(W,V55.usdc,enc('transfer',[NW,mv]),'old -> new: move USDC'));
  return C;}
/** NEW V5.5 wallet opening (calls only; the Base Account sends them). x/y = the phone key (null = open with Face ID off). */
export function openV55Calls({owner,newWallet,permission,x=null,y=null,seatDeployed=false,vault,vaultSeed=VAULT_SEED_V55,trusts=[],floatCap=0n,deniedPayees=[],deniedSigners=[],registryOptOut=false,recovery=null,opsPerDay=null,paused=false}){
  const seat=seatV2Init({owner});const owners=seatV2Owners(owner,seat.address);const NW=getAddress(newWallet);const P=perm(permission);
  if(getAddress(P.account)!==NW||getAddress(P.spender)!==getAddress(V55.adapter))throw Object.assign(Error('permission is not for the new wallet on V5.5'),{code:'bad_permission'});
  const C=[{to:getAddress(V55.cbswFactory),value:'0x0',data:enc('createAccount',[owners,0n]),label:'new: create wallet [Base Account, key seat V2, SPM]'}];
  if(!seatDeployed)C.push({to:getAddress(V55.deployer),value:'0x0',data:seat.deployData,label:'new: deploy key seat V2'});
  if(x!=null&&y!=null)C.push({...setKeyCallV2(NW,seat.address,x,y),label:'new: same phone key in the seat V2'});
  C.push(ex(NW,V55.spm,enc('approve',[P]),'new: V5.5 spend permission (same limits / window)'));
  C.push(ex(NW,V55.adapter,enc('registerPermission',[P]),'new: register permission (opens the V5.5 vault; called by the wallet)'));
  if(BigInt(vaultSeed)>0n)C.push(ex(NW,V55.usdc,enc('transfer',[getAddress(vault),BigInt(vaultSeed)]),'new: 0.15 USDC fee reserve into the V5.5 vault (his own money)'));
  if(opsPerDay!=null)C.push(ex(NW,vault,enc('setOpsPerDay',[Number(opsPerDay)]),'new: ops per day'));
  for(const t of trusts)C.push(ex(NW,V55.trust,enc('setTrust',[{merchant:t.merchant,name:t.name,payees:t.payees.map(getAddress),signers:t.signers.map(getAddress),single:BigInt(t.single),daily:BigInt(t.daily),expiry:BigInt(t.expiry)}]),'new: trust '+(/^[\x20-\x7e]+$/.test(t.name)?t.name:t.merchant.slice(0,10))));
  if(BigInt(floatCap)>0n)C.push(ex(NW,V55.trust,enc('setFloatCap',[BigInt(floatCap)]),'new: float cap'));
  for(const a of deniedPayees)C.push(ex(NW,V55.trust,enc('setDeniedPayee',[getAddress(a),true]),'new: denied payee'));
  for(const a of deniedSigners)C.push(ex(NW,V55.trust,enc('setDeniedSigner',[getAddress(a),true]),'new: denied signer'));
  if(registryOptOut)C.push(ex(NW,V55.trust,enc('setRegistryOptOut',[true]),'new: registry opt-out'));
  if(recovery)C.push(ex(NW,V55.trust,enc('setRecovery',[getAddress(recovery)]),'new: recovery address (KR-07)'));
  if(paused)C.push(ex(NW,V55.trust,enc('setPaused',[true]),'new: keep paused'));
  return {calls:C,seat:seat.address,owners};}
/** ONE owner batch: open the V5.5 wallet, exit the V5.4 wallet into it, then seed the new vault (needs the moved USDC, so it goes last). */
export function moveToV55Calls(s,o){const {owner,newWallet,vault,fee,executor}=o;const seed=BigInt(o.vaultSeed??VAULT_SEED_V55);
  const total=BigInt(s.walletBalance??0)+BigInt(s.oldVaultBalance??0);   // vault: unreserved (withdraw) + reserved (cancel refunds) both land in the old wallet
  const mv=o.move!=null?BigInt(o.move):total-BigInt(fee);
  if(mv<=seed)throw Object.assign(Error('not enough USDC to move and keep the fee reserve'),{code:'needs_usdc'});
  const pc=precheckExit(s);if(!pc.ok)throw Object.assign(Error('precheck: '+pc.block.join(',')),{code:'precheck',block:pc.block});
  const Pn=o.permission??permissionV55(s.oldPermission,{newWallet,executor,salt:o.salt});
  const open=openV55Calls({owner,newWallet,permission:Pn,x:s.phone?.x??null,y:s.phone?.y??null,seatDeployed:!!o.seatDeployed,vault,vaultSeed:0n,trusts:s.trusts??[],floatCap:s.floatCap??0n,
    deniedPayees:s.deniedPayees??[],deniedSigners:s.deniedSigners??[],registryOptOut:!!s.registryOptOut,recovery:o.recovery??null,opsPerDay:o.opsPerDay??null,paused:!!s.paused});
  const C=[...open.calls,...exitV54Calls(s,{newWallet,fee,move:mv,pauseOld:o.pauseOld!==false})];
  if(seed>0n)C.push(ex(newWallet,V55.usdc,enc('transfer',[getAddress(vault),seed]),'new: 0.15 USDC fee reserve into the V5.5 vault (his own money)'));
  const why=coinbaseRefuses(C,owner,V55.spm);if(why)throw Object.assign(Error('Coinbase popup would refuse this batch: '+why),{code:'coinbase_rule'});
  return {calls:C,seat:open.seat,owners:open.owners,newWallet:getAddress(newWallet),newPermission:Pn,oldPermission:perm(s.oldPermission),move:mv.toString(),fee:String(fee)};}
/** Live fee quote (actual cost in USDC, 0% markup, ceil, hard cap) - same formula as the V5.4 migration. */
export function moveFeeV55({gas=MOVE_V55_GAS,gasPriceWei,ethUsd8,l1Wei=MOVE_V55_L1_WEI,cap=MOVE_V55_FEE_CAP}){const wei=BigInt(gas)*BigInt(gasPriceWei)+BigInt(l1Wei);
  const usdc=(wei*BigInt(ethUsd8)+10n**20n-1n)/10n**20n;return {usdc,wei,overCap:usdc>BigInt(cap)};}
/** Read-only snapshot of the OLD (V5.4, key seat V1) wallet + where the new one will be. known = server facts {oldPermission, trusts,
 *  deniedPayees, deniedSigners, openReservations, serverInFlight}. */
export async function readExitStateV54(pub,{wallet,owner,known}){const W=getAddress(wallet);
  const R=(address,abi,functionName,args=[])=>pub.readContract({address:getAddress(address),abi:parseAbi(abi),functionName,args});
  const P=perm(known.oldPermission);const asT=[P.account,P.spender,P.token,P.allowance,P.period,P.start,P.end,P.salt,P.extraData];
  const [code55,valid,fl,vOld,paused,optOut,floatCap,bal,ich]=await Promise.all([pub.getCode({address:getAddress(V55.adapter)}),
    R(V55.spm,['function isValid((address,address,address,uint160,uint48,uint48,uint48,uint256,bytes)) view returns (bool)'],'isValid',[asT]),
    R(V54.adapter,['function floats(address) view returns (bytes32,uint160,uint160,uint64,bool)'],'floats',[W]).catch(()=>null),
    R(V54.adapter,['function vaultOf(address) view returns (address)'],'vaultOf',[W]),
    R(V54.trust,['function paused(address) view returns (bool)'],'paused',[W]),R(V54.trust,['function registryOptOut(address) view returns (bool)'],'registryOptOut',[W]),
    R(V54.trust,['function floatCap(address) view returns (uint160)'],'floatCap',[W]),R(V55.usdc,['function balanceOf(address) view returns (uint256)'],'balanceOf',[W]),
    R(V55.cbswFactory,['function initCodeHash() view returns (bytes32)'],'initCodeHash')]);
  const hasOld=vOld&&!/^0x0{40}$/i.test(vOld);
  const [reserved,vbal]=hasOld?await Promise.all([R(vOld,['function reserved() view returns (uint256)'],'reserved'),R(V55.usdc,['function balanceOf(address) view returns (uint256)'],'balanceOf',[vOld])]):[0n,0n];
  // the phone key: the old wallet's key seat V1 is owner index 1 ([Base Account, seat, SPM]); same key goes into the V2 seat
  let phone=null;try{const b=await R(W,['function ownerAtIndex(uint256) view returns (bytes)'],'ownerAtIndex',[1n]);const seat=getAddress('0x'+String(b).slice(26));
    const [x,y]=await Promise.all([R(seat,['function x() view returns (uint256)'],'x'),R(seat,['function y() view returns (uint256)'],'y')]);if(BigInt(x)!==0n)phone={seat,x,y};}catch{}
  const seat=seatV2Init({owner});const NW=cbswAddress({owners:seatV2Owners(owner,seat.address),initCodeHash:ich});
  const [nwCode,seatCode,vaultNew]=await Promise.all([pub.getCode({address:NW}),pub.getCode({address:seat.address}),code55&&code55!=='0x'?R(V55.adapter,['function vaultAddress(address) view returns (address)'],'vaultAddress',[NW]):null]);
  return {wallet:W,v55Deployed:!!code55&&code55!=='0x',oldPermission:known.oldPermission,oldPermissionValid:valid,oldAdapter:V54.adapter,oldTrust:V54.trust,
    float:fl?{open:!!fl[4],funded:fl[1],expiry:fl[3]}:null,oldVault:hasOld?getAddress(vOld):null,oldVaultReserved:reserved,oldVaultBalance:vbal,walletBalance:bal,paused,registryOptOut:optOut,floatCap,phone,
    trusts:(known.trusts??[]).filter(t=>BigInt(t.expiry)>BigInt(Math.floor(Date.now()/1000))+3600n),deniedPayees:known.deniedPayees??[],deniedSigners:known.deniedSigners??[],
    openReservations:known.openReservations??[],serverInFlight:!!known.serverInFlight,newWallet:NW,newWalletDeployed:!!nwCode&&nwCode!=='0x',seatV2:seat.address,seatV2Deployed:!!seatCode&&seatCode!=='0x',vaultV55:vaultNew?getAddress(vaultNew):null,cbswInitCodeHash:ich};}
/** Registry record of the new wallet once the move landed (suite 'v5.5'; read by mainnet-owner-launch only when KIPURSE_V55=1). movedFrom lets the
 *  engine refuse purchases the old wallet already paid on V5.4 (createPriorPurchaseCheck). */
export const newWalletRecordV55=({move,owner,oldWallet,vault,fromBlock})=>({wallet:getAddress(move.newWallet),owner:getAddress(owner),vault:getAddress(vault),ownerIndex:0,fromBlock:Number(fromBlock??0),
  publicPath:'/t/'+String(move.newWallet).toLowerCase(),permission:JSON.parse(JSON.stringify(move.newPermission,(k,v)=>typeof v==='bigint'?v.toString():v)),createdAt:new Date().toISOString(),
  suite:'v5.5',adapter:getAddress(V55.adapter),trust:getAddress(V55.trust),seat:getAddress(move.seat),seatVersion:'seat2',movedFrom:getAddress(oldWallet)});
