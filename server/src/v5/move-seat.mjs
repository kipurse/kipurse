// SPDX-License-Identifier: AGPL-3.0-only
// t1238 (handbook §6#109, phase 3): move an EXISTING Kipurse wallet (e.g. the owner's 0x5150 on V5.2) to a NEW key-seat wallet on V5.4.
// Why a new wallet: Coinbase's Base Account popup refuses every owner change, so a Face ID key for V5.4 can no longer be added to the old
// wallet. The new wallet is created by the Coinbase factory with ALL its owners [Base Account, key seat, SPM]; the SAME phone key (read from
// the old approver on chain) is registered in the seat. ONE Base Account confirmation:
//   old wallet: close open float / reservations, pay the fee (USDC, Kipurse wallet pays), send everything to the new wallet,
//               revoke its V5.2 spend permission and pause it on its trust (no AI can spend there any more; the owner keeps full control)
//   new wallet: created (factory), seat deployed + phone key set, V5.4 spend permission (same limits, same window) approved + registered,
//               0.15 USDC fee reserve into its vault (his own money), trust records / float cap / denies / opt-out / pause re-applied on V5.4.
// No call, at any depth, adds or removes an owner (Coinbase rule, §6#108). Nothing here sends anything: it only builds the batch.
import {encodeFunctionData,getAddress,parseAbi,encodeAbiParameters} from 'viem';
import {seatInit,seatOwners,setKeyCall} from './key-seat.mjs';
import {coinbaseRefuses} from './coinbase-rule.mjs';
import {ADAPTER_V54,TRUST_V54,SPM,USDC,FEE_TO,DETERMINISTIC_DEPLOYER,VAULT_SEED,precheck} from './migrate-v54.mjs';
export const CB_FACTORY='0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';
export const MOVE_SEAT_FEE_CAP=150_000n;   // 0.15 USDC hard stop (fork-measured cost is far lower; see the rehearsal report)
const A=parseAbi(['function execute(address target,uint256 value,bytes data)','function transfer(address,uint256) returns (bool)',
  'function approve((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData))',
  'function revoke((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData))',
  'function registerPermission((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData))',
  'function reconcileFloat(address)','function cancelReservation(bytes32)','function withdraw(address,address,uint256)',
  'function setTrust((bytes32 merchant,string name,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry))',
  'function setFloatCap(uint160)','function setDeniedPayee(address,bool)','function setDeniedSigner(address,bool)','function setRegistryOptOut(bool)','function setPaused(bool)',
  'function createAccount(bytes[] owners,uint256 nonce)']);
const enc=(fn,args)=>encodeFunctionData({abi:A,functionName:fn,args});
const ex=(W,target,data,label)=>({to:getAddress(W),value:'0x0',data:enc('execute',[getAddress(target),0n,data]),label});
const perm=p=>({account:getAddress(p.account),spender:getAddress(p.spender),token:getAddress(p.token),allowance:BigInt(p.allowance),period:Number(p.period),start:Number(p.start),end:Number(p.end),salt:BigInt(p.salt),extraData:p.extraData});
/** The new wallet's address and seat for this owner (fixed before anything is sent). */
export function newSeatWallet({owner,trust=TRUST_V54,predict}){const seat=seatInit({factory:CB_FACTORY,owner,spm:SPM,trust});return {seat,owners:seatOwners(owner,seat.address,SPM),predict};}
/**
 * s: readMigrationState(...) of the OLD wallet (V5.2 facts: old permission, approver x/y, trusts, float, vault, pause ...)
 * o: {owner (Base Account), newWallet (factory address for [owner, seat, SPM]), vaultNew (V5.4 vault of the new wallet), fee, move (USDC the old
 *     wallet sends to the new one), oldTrust, seatDeployed (bool), salt (new permission salt)}
 */
export function moveToSeatCalls(s,o){const W=getAddress(s.wallet),NW=getAddress(o.newWallet),f=BigInt(o.fee),mv=BigInt(o.move),seed=BigInt(o.vaultSeed??VAULT_SEED);
  if(f<=0n||f>MOVE_SEAT_FEE_CAP)throw Object.assign(Error('fee cap'),{code:'fee_above_cap'});
  if(mv<=seed)throw Object.assign(Error('not enough USDC to move and keep the fee reserve'),{code:'needs_usdc'});
  const pc=precheck({...s,v54Deployed:true});if(!pc.ok)throw Object.assign(Error('precheck: '+pc.block.join(',')),{code:'precheck',block:pc.block});
  const {seat,owners}=newSeatWallet({owner:o.owner});
  const P=perm(s.oldPermission),Pn={...P,account:NW,spender:getAddress(ADAPTER_V54),salt:o.salt==null?P.salt+1n:BigInt(o.salt),extraData:o.newExtraData??P.extraData};   // new wallet: its OWN server executor in the policy
  const C=[];
  for(const c of pc.close){if(c.kind==='float')C.push(ex(W,s.oldAdapter,enc('reconcileFloat',[W]),'old: close float'));else C.push(ex(W,s.oldAdapter,enc('cancelReservation',[c.digest]),'old: close reservation'));}
  if(BigInt(s.oldVaultBalance??0)>0n&&s.oldVault)C.push(ex(W,s.oldVault,enc('withdraw',[getAddress(USDC),W,BigInt(s.oldVaultBalance)]),'old: V5.2 vault back to old wallet'));
  C.push(ex(W,USDC,enc('transfer',[getAddress(FEE_TO),f]),'old: network fee (Kipurse wallet pays, USDC)'));
  C.push({to:CB_FACTORY,value:'0x0',data:enc('createAccount',[owners,0n]),label:'new: create wallet [Base Account, key seat, SPM]'});
  if(!o.seatDeployed)C.push({to:DETERMINISTIC_DEPLOYER,value:'0x0',data:seat.deployData,label:'new: deploy key seat'});
  C.push({...setKeyCall(NW,seat.address,s.oldApprover.x,s.oldApprover.y),label:'new: same phone key in the seat'});
  C.push(ex(NW,SPM,enc('approve',[Pn]),'new: V5.4 spend permission (same limits / window)'));
  C.push({to:getAddress(ADAPTER_V54),value:'0x0',data:enc('registerPermission',[Pn]),label:'new: register permission (opens the V5.4 vault)'});
  C.push(ex(W,USDC,enc('transfer',[NW,mv]),'old -> new: move USDC'));
  if(seed>0n)C.push(ex(NW,USDC,enc('transfer',[getAddress(o.vaultNew),seed]),'new: 0.15 USDC fee reserve (his own money)'));
  for(const t of s.trusts??[])C.push(ex(NW,TRUST_V54,enc('setTrust',[{merchant:t.merchant,name:t.name,payees:t.payees.map(getAddress),signers:t.signers.map(getAddress),single:BigInt(t.single),daily:BigInt(t.daily),expiry:BigInt(t.expiry)}]),'new: trust '+(/^[\x20-\x7e]+$/.test(t.name)?t.name:t.merchant.slice(0,10))));
  if(BigInt(s.floatCap??0)>0n)C.push(ex(NW,TRUST_V54,enc('setFloatCap',[BigInt(s.floatCap)]),'new: float cap'));
  for(const a of s.deniedPayees??[])C.push(ex(NW,TRUST_V54,enc('setDeniedPayee',[getAddress(a),true]),'new: denied payee'));
  for(const a of s.deniedSigners??[])C.push(ex(NW,TRUST_V54,enc('setDeniedSigner',[getAddress(a),true]),'new: denied signer'));
  if(s.registryOptOut)C.push(ex(NW,TRUST_V54,enc('setRegistryOptOut',[true]),'new: registry opt-out'));
  if(s.paused)C.push(ex(NW,TRUST_V54,enc('setPaused',[true]),'new: keep paused'));
  C.push(ex(W,SPM,enc('revoke',[P]),'old: revoke V5.2 spend permission'));
  C.push(ex(W,o.oldTrust,enc('setPaused',[true]),'old: pause (no AI payment can start there)'));
  const why=coinbaseRefuses(C,o.owner,SPM);if(why)throw Object.assign(Error('Coinbase popup would refuse this batch: '+why),{code:'coinbase_rule'});
  return {calls:C,seat:seat.address,newWallet:NW,newPermission:Pn,oldPermission:P,move:mv.toString(),fee:f.toString()};}
