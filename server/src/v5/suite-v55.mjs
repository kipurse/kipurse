// SPDX-License-Identifier: AGPL-3.0-only
// t1250 (handbook §6#119): Kipurse V5.5 suite for the gateway. Everything V5.5 is OFF unless KIPURSE_V55=1; with the flag off nothing in
// this file is imported by a running path and the V5.2 / V5.3 / V5.4 wallets behave exactly as before.
// What V5.5 changes for the gateway (contracts/V55_CHANGES.md §3):
//   - new adapter / trust / vault factory / registry V2 addresses (mainnet/v55-deploy-plan.json, pinned below)
//   - registerPermission only from the wallet itself or the permission's executor (opening batch: wallet.execute(adapter, registerPermission))
//   - vault event Session(address indexed signer, uint256 maxGasPerOp, bytes32 indexed permissionHash)  (topic0 changed)
//   - adapter events RefundKept / RefundShortfall next to AuthorizationClosed(digest, false, ...)
//   - R2-02: after each x402 settlement the vault's gas permits are refused until markSettled / vault.sync() runs -> the gateway sends
//     markSettled([digest]) right away from an ORDINARY account (an EOA that pays its own ETH gas), never through the vault itself
//   - purchase keys are not adapter-bound: a purchase already paid on V5.4 (old wallet) must not be paid again on V5.5 (new wallet)
import {getAddress,parseAbi,parseAbiItem,toEventSelector,decodeEventLog,getContractAddress} from 'viem';
export const FLAG='KIPURSE_V55';
export const v55On=(env=process.env)=>String(env?.[FLAG]??'').trim()==='1';
export const SUITE_V55='v5.5';
/** Pinned from mainnet/v55-deploy-plan.json (CREATE2 through the deterministic deployer; empty on Base at block 60906xxx, 2026-11-22, after the §12 vault fix). */
export const V55=Object.freeze({chainId:8453,
  factory:'0xC01C40bBE92D0e959C2730c5f62F2737baEEc248',adapter:'0x53F99af228A165A312Ed4A7E47447a9137dbf03e',trust:'0xDBb66b5E7a2773e0419093Ea5cf6E70E68A747B4',
  vaultImpl:'0xB0F92441A31CbCB7Baa5659a08228De8De7d2BDf',floatImpl:'0x54830Fc7042DBe7A4Eb03928ACf22Cf7B251780b',registryV2:'0xB8ce1FfCbF88DBd73C5C6f557b3D68cF0b92Eb68',
  spm:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',feeController:'0x8F52D223DF89E388DcB5d39C53f154b9F8F9a67A',
  cbswFactory:'0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',entryPoint:'0x0000000071727De22E5E9d8BAf0edAc6f37da032',paymaster:'0x6C973eBe80dCD8660841D4356bf15c32460271C9',
  deployer:'0x4e59b44847b379578588920cA78FbF26c0B4956C',feeTo:'0xf14ef5dc4723245866c22c749a0a84afceba0dd9'});
export const V55_PIN=Object.freeze({factory:{initCodeKeccak:'0x68bf63cab57b55ad8d9d0cff5839dcdd187043a7ca2b2e4ba2c79b8877d4dcc4',sha256:'71642aa6dfc6be0ce33d478a78534983157ffa97106edbb8a2b69da1ab9d3e2e'},
  adapter:{initCodeKeccak:'0xf3303b50d1c3c9b2b184b34b6d9bdbf1bad4d8d9d0ffdbbe5e19d8daf9e537da',sha256:'29c163680b7441b63cf015fe36eb2981bd18929061358239bb4a1e2b2774fd48'},
  registry:{initCodeKeccak:'0x998a5f6241c55b5488b0a4ab2b65810ae8ea14442e04b30722f4c5f4cd55e955',sha256:'d4a611db214e20651a45f5d27e3aa209749763f4923bec3b4cd89048b66f9fa7'}});
/** The live V5.4 suite (the owner's current wallet 0xeF6B…0dEb runs on it). */
export const V54=Object.freeze({adapter:'0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa',trust:'0x22eF1633252653932076cB911b155F9D7f73A9E9'});
export const suiteV55=()=>({name:SUITE_V55,adapter:getAddress(V55.adapter),trust:getAddress(V55.trust)});
// sanity: the trust is the adapter's first CREATE (fails loudly if someone edits one address and not the other)
if(getContractAddress({from:V55.adapter,nonce:1n})!==getAddress(V55.trust))throw Error('suite-v55: trust address is not CREATE(adapter, 1)');

const SP='(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
export const ADAPTER_V55_ABI=parseAbi([
  `function registerPermission(${SP} p) returns (address vault)`,`function pause(${SP} p)`,
  'function markSettled(bytes32[] digests) returns (uint256 closed)','function reclaim(bytes32 digest)','function cancelReservation(bytes32 digest)','function reconcileFloat(address account) returns (uint256,uint256)',
  'function reservations(bytes32) view returns (address account,uint64 day,uint64 validBefore,uint8 tier,bool open,bytes32 permissionHash,bytes32 purchaseKey,bytes32 merchant,uint256 value,uint256 fee,uint256 networkFee)',
  'function purchaseUsed(address account,bytes32 key) view returns (bool)','function orderUsed(address signer,bytes32 orderId) view returns (bool)',
  'function vaultAddress(address account) view returns (address)','function floatAddress(address account) view returns (address)','function vaultOf(address) view returns (address)',
  'function trust() view returns (address)','function fees() view returns (address)','function vaultFactory() view returns (address)',
  'function purchaseKey(address payee,bytes32 merchantRef,bytes32 repeatKey) pure returns (bytes32)','function signedPurchaseKey(bytes32 merchant,bytes32 orderId) pure returns (bytes32)',
  'function floats(address) view returns (bytes32 permissionHash,uint160 funded,uint160 feeReserve,uint64 expiry,bool open)']);
export const VAULT_V55_ABI=parseAbi(['function sync() returns (uint256 live)','function reserved() view returns (uint256)','function reservedTotal() view returns (uint256)',
  'function unreserved() view returns (uint256)','function permissionHash() view returns (bytes32)','function permissionEnd() view returns (uint48)','function sessionSigner() view returns (address)',
  'function maxGasPerOp() view returns (uint256)','function openCount() view returns (uint256)','function account() view returns (address)',
  'function withdraw(address t,address to,uint256 amount)','function sweep() returns (uint256)','function setOpsPerDay(uint32 n)','function setBundlerFee(address to,uint96 maxPerOp)']);
export const TRUST_V55_ABI=parseAbi(['struct TP { bytes32 merchant; string name; address[] payees; address[] signers; uint160 single; uint160 daily; uint64 expiry; }',
  'function setTrust(TP t)','function setFloatCap(uint160 cap)','function setDeniedPayee(address payee,bool v)','function setDeniedSigner(address signer,bool v)','function setRegistryOptOut(bool v)',
  'function setPaused(bool v)','function setRecovery(address to)','function recoveryOf(address) view returns (address)','function isPaused(address) view returns (bool)',
  'function trustOf(address account,bytes32 merchant) view returns (uint64 epoch,uint64 expiry,bool active,uint160 single,uint160 daily)',
  'function INLINE_TRUST_TYPEHASH() view returns (bytes32)','function NO_EXPIRY() view returns (uint64)']);

// ---------------- events ----------------
export const EV={
  sessionV55:parseAbiItem('event Session(address indexed signer, uint256 maxGasPerOp, bytes32 indexed permissionHash)'),
  sessionV5:parseAbiItem('event Session(address indexed signer, uint256 maxGasPerOp)'),
  refundKept:parseAbiItem('event RefundKept(bytes32 indexed digest, address indexed account, uint256 value)'),
  refundShortfall:parseAbiItem('event RefundShortfall(bytes32 indexed digest, address indexed account, uint256 missing)'),
  closed:parseAbiItem('event AuthorizationClosed(bytes32 indexed digest, bool settled, uint256 value, uint256 fee, uint256 networkFee)'),
  registered:parseAbiItem('event PermissionRegistered(address indexed account, bytes32 indexed permissionHash, address indexed vault, address sessionSigner, uint256 maxGasPerOp)')};
export const TOPIC=Object.freeze(Object.fromEntries(Object.entries(EV).map(([k,v])=>[k,toEventSelector(v)])));
const lc=a=>String(a??'').toLowerCase();
/** The vault's current session from receipt logs: understands BOTH the V5.5 topic (with permissionHash) and the old V5.x one. */
export function sessionFromLogs(logs,{vault}){let out=null;
  for(const l of logs??[]){if(vault&&lc(l.address)!==lc(vault))continue;const t0=l.topics?.[0];
    if(t0===TOPIC.sessionV55){const e=decodeEventLog({abi:[EV.sessionV55],data:l.data,topics:l.topics});out={version:'v5.5',signer:getAddress(e.args.signer),maxGasPerOp:e.args.maxGasPerOp,permissionHash:e.args.permissionHash};}
    else if(t0===TOPIC.sessionV5){const e=decodeEventLog({abi:[EV.sessionV5],data:l.data,topics:l.topics});out={version:'v5',signer:getAddress(e.args.signer),maxGasPerOp:e.args.maxGasPerOp,permissionHash:null};}}
  return out;}
/** What happened to ONE reservation in a cancel / reclaim / markSettled receipt (V55_CHANGES §3.4: read AuthorizationClosed with
 *  RefundKept / RefundShortfall of the same digest). refunded = USDC that actually reached the wallet; keptInVault = refused by the wallet
 *  (blocklist) and left, unreserved, in the owner's vault; shortfall = what the vault could not cover (0 while I-8 holds). */
export function closeOutcome(logs,{adapter=V55.adapter,digest}){let closed=null,kept=0n,keptEv=false,short=0n;
  for(const l of logs??[]){if(lc(l.address)!==lc(adapter)||lc(l.topics?.[1])!==lc(digest))continue;const t0=l.topics?.[0];
    if(t0===TOPIC.closed){const e=decodeEventLog({abi:[EV.closed],data:l.data,topics:l.topics});closed=e.args;}
    else if(t0===TOPIC.refundKept){const e=decodeEventLog({abi:[EV.refundKept],data:l.data,topics:l.topics});kept+=e.args.value;keptEv=true;}
    else if(t0===TOPIC.refundShortfall){const e=decodeEventLog({abi:[EV.refundShortfall],data:l.data,topics:l.topics});short+=e.args.missing;}}
  if(!closed)return null;
  if(closed.settled)return {digest,state:'settled',value:closed.value,fee:closed.fee,networkFee:closed.networkFee};
  const paid=closed.value-short;
  return {digest,state:'refunded',value:closed.value,fee:closed.fee,networkFee:closed.networkFee,refunded:keptEv?0n:paid,keptInVault:keptEv?kept:0n,shortfall:short};}

// ---------------- R2-02: markSettled / sync right after each x402 settlement, from an ordinary account ----------------
const EIP3009=parseAbi(['function authorizationState(address authorizer,bytes32 nonce) view returns (bool)']);
/** deps: pub (viem public client), send({to,data,label}) -> {hash} sends from an ORDINARY account (an EOA paying its own ETH gas; never the
 *  vault, whose gas permit is exactly what is blocked until this runs), adapter (V5.5). Never throws into the payment path. */
export function createSettleSyncV55({pub,send,adapter=V55.adapter,token=V55.usdc,waitTries=15,waitMs=2000,sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=()=>{}}){
  const A=getAddress(adapter);
  const rd=(address,abi,functionName,args=[])=>pub.readContract({address:getAddress(address),abi,functionName,args});
  /** One settled digest -> adapter.markSettled([digest]) (closes it and frees the vault's cached reserve). Falls back to vault.sync(). */
  async function afterSettlement({digest,auth,vault}){
    try{for(let i=0;i<waitTries;i++){if(await rd(token,EIP3009,'authorizationState',[auth.from,auth.nonce]))break;if(i===waitTries-1){log('v55_sync_wait',{digest});return {digest,state:'not_settled_yet'};}await sleep(waitMs);}
      const rs=await rd(A,ADAPTER_V55_ABI,'reservations',[digest]);
      if(rs[4]){const {encodeFunctionData}=await import('viem');const tx=await send({to:A,data:encodeFunctionData({abi:ADAPTER_V55_ABI,functionName:'markSettled',args:[[digest]]}),label:'v55:markSettled:'+digest});
        const rc=await pub.waitForTransactionReceipt({hash:tx.hash});return {digest,state:rc.status==='success'?'marked':'mark_failed',txHash:tx.hash,logs:rc.logs};}
      const v=vault??auth.from;const [rt,r]=await Promise.all([rd(v,VAULT_V55_ABI,'reservedTotal'),rd(v,VAULT_V55_ABI,'reserved')]);
      if(BigInt(rt)>BigInt(r)){const {encodeFunctionData}=await import('viem');const tx=await send({to:getAddress(v),data:encodeFunctionData({abi:VAULT_V55_ABI,functionName:'sync'}),label:'v55:sync'});
        const rc=await pub.waitForTransactionReceipt({hash:tx.hash});return {digest,state:rc.status==='success'?'synced':'sync_failed',txHash:tx.hash};}
      return {digest,state:'already_closed'};}
    catch(e){log('v55_sync_error',{digest,error:String(e?.shortMessage??e?.message??e).slice(0,120)});return {digest,state:'error'};}}
  /** Monitoring (R2-02): settled-but-unpruned value still counted in the vault's cached reserve (> 0 = gas permits refused now). */
  async function lag(vault){const [rt,r]=await Promise.all([rd(vault,VAULT_V55_ABI,'reservedTotal'),rd(vault,VAULT_V55_ABI,'reserved')]);return BigInt(rt)-BigInt(r);}
  return {afterSettlement,lag};}

// ---------------- purchase dedupe across V5.4 -> V5.5 ----------------
/** A purchase already paid (or reserved) by the owner's OLD wallet on V5.4 is never paid again by the new V5.5 wallet. Purchase keys
 *  (direct / x402: keccak(PURCHASE_TAG, payee, merchantRef, repeatKey)) are not adapter-bound and the new wallet is a new account, so the
 *  chain alone would allow it. prior = [{adapter, account}] (V5.4 adapter + old wallet; more entries for older moves).
 *  Signed orders: a V5.4 order can never be paid on V5.5 (domain), but a re-issued order with the same (signer, orderId) is refused too.
 *  localKeys: optional (key)=>bool over the old wallet's ledger (keys the server claimed but the chain has not seen yet). */
export function createPriorPurchaseCheck({pub,prior,localKeys=null}){const P=(prior??[]).map(x=>({adapter:getAddress(x.adapter),account:getAddress(x.account)}));
  return async function priorPurchaseUsed({kind,purchaseKey,signedOrder}){
    if(localKeys&&purchaseKey&&localKeys(purchaseKey))return {used:true,where:'old_ledger'};
    for(const x of P){
      if(kind==='ref'&&purchaseKey){if(await pub.readContract({address:x.adapter,abi:ADAPTER_V55_ABI,functionName:'purchaseUsed',args:[x.account,purchaseKey]}))return {used:true,where:x.adapter};}
      else if(signedOrder?.signer&&signedOrder?.orderId){if(await pub.readContract({address:x.adapter,abi:ADAPTER_V55_ABI,functionName:'orderUsed',args:[getAddress(signedOrder.signer),signedOrder.orderId]}))return {used:true,where:x.adapter};}}
    return {used:false};};}
