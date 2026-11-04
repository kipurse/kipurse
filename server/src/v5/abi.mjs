// SPDX-License-Identifier: Apache-2.0
// Kipurse V5 ABI + encoders (M2, 2026-10-17). Mirrors v5-contracts/src/KipurseAdapterV5.sol (12-field Policy, POLICY_LENGTH 384;
// pure-percentage protocol fee via KipurseFeeControllerV5 + per-payment network fee = actual gas, bounded by Policy.maxNetworkFee).
import {parseAbi,encodeAbiParameters,decodeAbiParameters,parseAbiParameters,getAddress,hashTypedData} from 'viem';
export const ZERO='0x0000000000000000000000000000000000000000',ZERO32='0x'+'0'.repeat(64);
export const PERMISSION_T='(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
export const POLICY_V5_T='address executor,address guardian,uint160 single,uint160 daily,uint160 term,uint160 openSingle,uint160 openDaily,uint160 verifiedSingle,uint160 verifiedDaily,address registry,uint256 maxFeePpm,uint256 maxNetworkFee';
export const POLICY_FIELDS=POLICY_V5_T.split(',').map(s=>s.trim().split(' ')[1]);
const ORDER='(address payee,uint256 amount,bytes32 orderId,uint256 deadline,uint256 chainId,address adapter,address payer)';
const DIRECT='(address payee,uint256 amount,bytes32 merchantRef,bytes32 repeatKey,uint256 deadline)';
const AUTH='(address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 merchantRef,bytes32 repeatKey)';
export const TRUST_T='(bytes32 merchant,string name,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry)';
// Kipurse V5 custom errors (v5-contracts/src/KipurseErrors.sol): lets viem name the reason in simulation / revert messages.
export const V5_ERRORS=["NotAccount", "Admin", "Allowance", "Amount", "Approval", "BadAdapter", "BadExecutor", "BadFloat", "BadMaintainer", "BadMerchant", "WalletPaused", "BadPolicy", "BadReservation", "BadSignerDenied", "BadStranger", "Bindings", "Caps", "Contracts", "Core", "DailyCap", "Delay", "Delivery", "Denied", "Digest", "Domain", "Duplicate", "DuplicatePurchase", "Exists", "Expired", "Fee", "FeeMax", "FloatCap", "FloatExpiry", "FloatOpen", "Inactive", "MerchantCap", "MerchantDailyCap", "NetworkFee", "NonceUsed", "NotExpired", "OnlyDown", "Operation", "OwnerSig", "Pauser", "Payee", "PayeeBinding", "Payer", "Pending", "Permission", "Pull", "Reentrant", "RegistryBlocked", "Reserved", "Scope", "Session", "SessionOpen", "Settled", "SigExpired", "SigNonce", "Signer", "StrangerDailyCap", "Term", "TermCap", "Timelock", "Trust", "TrustCaps", "TrustExpiry", "TrustName", "TrustPayee", "TrustSigner", "Unknown", "Vault", "VerifiedCap", "VerifiedDailyCap", "Window", "Zero"];
export const V5_ITEMS=[...V5_ERRORS.map(e=>`error ${e}()`),'error ECDSAInvalidSignature()','error ECDSAInvalidSignatureLength(uint256 length)','error ECDSAInvalidSignatureS(bytes32 s)','error SafeERC20FailedOperation(address token)',
  `function paySigned(${PERMISSION_T} p,${ORDER} o,bytes signature,uint256 networkFee,uint48 txDeadline)`,
  `function payDirect(${PERMISSION_T} p,${DIRECT} d,bytes ownerApproval,uint256 networkFee,uint48 txDeadline)`,
  `function prepareAuthorization(${PERMISSION_T} p,${AUTH} a,bytes ownerApproval,uint256 networkFee,uint48 txDeadline) returns (address vault,bytes32 digest,bytes32 nonce)`,
  `function fundFloat(${PERMISSION_T} p,address sessionKey,uint256 amount,uint64 expiry,uint256 networkFee,uint48 txDeadline)`,'function reconcileFloat(address account) returns (uint256 spent,uint256 fee)',
  'function floats(address) view returns (bytes32 permissionHash,uint160 funded,uint160 feeReserve,uint64 expiry,bool open)','function floatAddress(address account) view returns (address)',
  'function floatDaySpent(bytes32,uint256) view returns (uint256)','function floatBlocked(address account,address to) view returns (bool)','function setFloatCap(uint160 cap)','function floatCap(address) view returns (uint160)',
  'function sessionKey() view returns (address)','function expiry() view returns (uint64)','function maxSingle() view returns (uint160)',
  'function markSettled(bytes32[] digests) returns (uint256 closed)','function collectFees() returns (uint256)','function accruedFees() view returns (uint256)','function pendingFees() view returns (uint256)','function reclaim(bytes32 digest)','function cancelReservation(bytes32 digest)',
  `function pause(${PERMISSION_T} p)`,`function registerPermission(${PERMISSION_T} p) returns (address)`,'function vaultOf(address) view returns (address)','function setPaused(bool v)','function setDeniedPayee(address payee,bool v)','function setDeniedSigner(address signer,bool v)','function setRegistryOptOut(bool v)',
  `function setTrust(${TRUST_T} t)`,'function untrust(bytes32 merchant)',
  `function trustBySig(address account,${TRUST_T} t,bytes32 nonce,uint256 deadline,bytes sig)`,
  'function untrustBySig(address account,bytes32 merchant,bytes32 nonce,uint256 deadline,bytes sig)',
  'function denySignerBySig(address account,address signer,bytes32 nonce,uint256 deadline,bytes sig)',
  'function purchaseUsed(address,bytes32) view returns (bool)','function orderUsed(address,bytes32) view returns (bool)','function termSpent(bytes32) view returns (uint256)',
  'function daySpent(bytes32,uint256) view returns (uint256)','function openDaySpent(bytes32,uint256) view returns (uint256)','function verifiedDaySpent(bytes32,uint256) view returns (uint256)',
  'function merchantDaySpent(bytes32,bytes32,uint256) view returns (uint256)','function paused(address) view returns (bool)','function pausedUntil(address) view returns (uint256)','function isPaused(address) view returns (bool)','function deniedPayee(address,address) view returns (bool)',
  'function deniedSigner(address,address) view returns (bool)','function registryOptOut(address) view returns (bool)',
  'function trustOf(address,bytes32) view returns (uint64 epoch,uint64 expiry,bool active,uint160 single,uint160 daily)',
  'function trustedPayee(address,address) view returns (bytes32 merchant,uint64 epoch)','function trustedSigner(address,address) view returns (bytes32 merchant,uint64 epoch)',
  'function ownerNonceUsed(address,bytes32) view returns (bool)','function vaultOf(address) view returns (address)',
  'function reservations(bytes32) view returns (address account,uint64 day,uint64 validBefore,uint8 tier,bool open,bytes32 permissionHash,bytes32 purchaseKey,bytes32 merchant,uint256 value,uint256 fee,uint256 networkFee)',
  'function fees() view returns (address)','function trust() view returns (address)','function gate(address account,address payee) view returns (bool,bool,bool)','function payeeTrust(address account,address payee) view returns (bytes32 m,uint160 single,uint160 daily)','function signerTrust(address account,address signer,address payee) view returns (bytes32 m,uint160 single,uint160 daily,bool bound)','function vaultFactory() view returns (address)','function FEE_CLAIM_WINDOW() view returns (uint256)','function EXECUTOR_PAUSE() view returns (uint256)',
  // KipurseFeeControllerV5
  'function feePpm() view returns (uint256)','function feeRecipient() view returns (address)','function MAX_FEE_PPM() view returns (uint256)','function admin() view returns (address)',
  'function lowerFee(uint256 newPpm)','function proposeRecipient(address r)','function executeRecipient()','function pendingRecipient() view returns (address)','function pendingAt() view returns (uint256)',
  'function purchaseKey(address payee,bytes32 merchantRef,bytes32 repeatKey) pure returns (bytes32)','function signedPurchaseKey(bytes32 merchant,bytes32 orderId) pure returns (bytes32)',
  'function feeFor(uint256 amount) view returns (uint256)','function vaultAddress(address account) view returns (address)',
  'function authorizationDigest(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce) view returns (bytes32)',
  `function orderDigest(${ORDER} o) view returns (bytes32)`,'function ownerDigest(bytes32 structHash) view returns (bytes32)',
  'function approvalDigest(address account,bytes32 purchaseKey,address payee,uint256 amount,uint256 deadline) view returns (bytes32)',
  'function orderDomainSeparator() view returns (bytes32)','function ownerDomainSeparator() view returns (bytes32)',
  // token
  'function DOMAIN_SEPARATOR() view returns (bytes32)','function balanceOf(address) view returns (uint256)','function transfer(address to,uint256 amount) returns (bool)','function authorizationState(address,bytes32) view returns (bool)',
  // SpendPermissionManager
  `function getHash(${PERMISSION_T} p) view returns (bytes32)`,`function isValid(${PERMISSION_T} p) view returns (bool)`,`function isRevoked(${PERMISSION_T} p) view returns (bool)`,
  `function approve(${PERMISSION_T} p) returns (bool)`,`function revoke(${PERMISSION_T} p)`,
  // registry (IKipurseMerchantRegistry)
  'function lookupPayee(address) view returns (bytes32 merchant,uint160 single,uint160 daily)','function lookupSigner(address) view returns (bytes32 merchant,uint160 single,uint160 daily)',
  'function isPayeeOf(bytes32 merchant,address payee) view returns (bool)','function blocked(address) view returns (bool)',
  // PayerVaultV5
  'function sweep() returns (uint256)','function withdraw(address t,address to,uint256 amount)','function unreserved() view returns (uint256)','function reserved() view returns (uint256)',
  // Coinbase Smart Wallet
  'function execute(address target,uint256 value,bytes data)','function executeBatch((address target,uint256 value,bytes data)[] calls)','function replaySafeHash(bytes32 hash) view returns (bytes32)',
];
export const v5Abi=parseAbi(V5_ITEMS);

export const TIERS=['none','stranger','verified','trusted','approved'];
export const encodePolicyV5=p=>encodeAbiParameters(parseAbiParameters(POLICY_V5_T),[getAddress(p.executor),getAddress(p.guardian??ZERO),BigInt(p.single),BigInt(p.daily),BigInt(p.term),
  BigInt(p.openSingle),BigInt(p.openDaily),BigInt(p.verifiedSingle??0),BigInt(p.verifiedDaily??0),getAddress(p.registry??ZERO),BigInt(p.maxFeePpm),BigInt(p.maxNetworkFee??0)]);
export const decodePolicyV5=data=>{const d=decodeAbiParameters(parseAbiParameters(POLICY_V5_T),data);const o={};POLICY_FIELDS.forEach((k,i)=>{o[k]=typeof d[i]==='bigint'?d[i].toString():d[i];});return o;};
export const permissionFromJson=p=>({account:getAddress(p.account),spender:getAddress(p.spender),token:getAddress(p.token),allowance:BigInt(p.allowance),period:Number(p.period),start:Number(p.start),end:Number(p.end),salt:BigInt(p.salt),extraData:p.extraData});
export const permissionToJson=p=>({...p,allowance:p.allowance.toString(),salt:p.salt.toString()});
/** SpendPermissionManager.getHash computed off-chain (EIP-712 "Spend Permission Manager" v1). */
export const spendPermissionHash=(p,{chainId,manager})=>hashTypedData({domain:{name:'Spend Permission Manager',version:'1',chainId,verifyingContract:getAddress(manager)},primaryType:'SpendPermission',
  types:{SpendPermission:[{name:'account',type:'address'},{name:'spender',type:'address'},{name:'token',type:'address'},{name:'allowance',type:'uint160'},{name:'period',type:'uint48'},{name:'start',type:'uint48'},{name:'end',type:'uint48'},{name:'salt',type:'uint256'},{name:'extraData',type:'bytes'}]},
  message:{...p,allowance:BigInt(p.allowance),salt:BigInt(p.salt)}});
export const MAX_FEE_PPM=3000n; // 0.3% hard max in the contract
/** Fee exactly as the adapter computes it: floor(amount * ppm / 1e6). No cap, no minimum (tiny payments may round to 0). */
export const feeFor=(amount,{ppm})=>(BigInt(amount)*BigInt(ppm)+999999n)/1000000n; // rounded UP, same as KipurseAdapterV5.feeFor
/** Fee headroom for a cap stated in merchant amounts: cap + ceil(cap*ppm/1e6). Payments whose merchant amounts sum to the
 *  stated cap always fit, because per-payment fees floor (sum of floors <= floor of sum). */
export const withFeeHeadroom=(cap,ppm)=>{const c=BigInt(cap);return c===0n?0n:c+(c*BigInt(ppm)+999999n)/1000000n;};
/** Largest merchant amount a with a + fee(a) <= room. */
export function maxPayableWithin(room,fee){let r=BigInt(room);if(r<=0n)return 0n;let a=r-feeFor(r,fee);if(a<0n)a=0n;while(a+1n+feeFor(a+1n,fee)<=r)a++;while(a>0n&&a+feeFor(a,fee)>r)a--;return a;}
/** Network fee = the ACTUAL gas cost of the payment tx in USDC (users bear all gas; we never subsidize), at actual cost (no markup by
 *  default), never above the owner-signed Policy.maxNetworkFee. gasUnits: estimate of this tx (incl. paymaster overhead);
 *  closeGas: x402 only, the closing tx share (reclaim worst case; a batched markSettled costs less) because that gas is ours too.
 *  usdcPerEth: atomic USDC per 1 ETH (testnet: fixed config; mainnet: an oracle/quote, pre-audit item). l1FeeWei: Base L1 data fee. */
export function quoteNetworkFee({gasUnits,gasPriceWei,usdcPerEth,marginBps=0,closeGas=0n,l1FeeWei=0n}){
  const wei=(BigInt(gasUnits)+BigInt(closeGas))*BigInt(gasPriceWei)+BigInt(l1FeeWei);
  const usdc=(wei*BigInt(usdcPerEth)+10n**18n-1n)/10n**18n; // round UP: never under-recover
  return (usdc*(10000n+BigInt(marginBps))+9999n)/10000n;
}
/** Owner-control functions that live in KipurseTrustV5 (adapter.trust()), not in the payment core. */
export const TRUST_FNS=new Set(['setPaused','setDeniedPayee','setDeniedSigner','setRegistryOptOut','setTrust','untrust','trustBySig','untrustBySig','denySignerBySig',
  'setFloatCap','floatCap','paused','pausedUntil','isPaused','deniedPayee','deniedSigner','registryOptOut','trustOf','trustedPayee','trustedSigner','ownerNonceUsed','gate','payeeTrust','signerTrust']);

// ---------------- V5.1 (2026-10-18): stable KipurseOrderVerifier + KipurseTrustV51 (anyPayee for signed orders) ----------------
export const ORDER51='(address payee,uint256 amount,bytes32 orderId,uint256 deadline,address payer)';
export const TRUST51_T='(bytes32 merchant,string name,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry,bool anyPayee)';
export const VERIFIER_ITEMS=['function used(address account,address signer,bytes32 orderId) view returns (bool)','function domainSeparator() view returns (bytes32)',
  'function manager() view returns (address)','function ORDER_TYPEHASH() view returns (bytes32)','function NAME() view returns (string)','function VERSION() view returns (string)',
  `function recover(${ORDER51} o,bytes signature) view returns (address)`,'error Permission()','error Payer()'];
export const V51_ITEMS=[...V5_ITEMS.filter(x=>!/^function orderUsed\(|^function trustOf\(|^function orderDomainSeparator\(/.test(x)).map(x=>x.split(ORDER).join(ORDER51).split(TRUST_T).join(TRUST51_T)),
  'function trustOf(address,bytes32) view returns (uint64 epoch,uint64 expiry,bool active,uint160 single,uint160 daily,bool anyPayee)','function orders() view returns (address)',
  ...VERIFIER_ITEMS.filter(x=>!/function (domainSeparator|manager)\(/.test(x)),'function domainSeparator() view returns (bytes32)'];
export const v51Abi=parseAbi(V51_ITEMS);
export const verifierAbi=parseAbi(VERIFIER_ITEMS);
/** ABI for an adapter version ('5' default, '5.1'). */
export const abiFor=v=>String(v??'5')==='5.1'?v51Abi:v5Abi;
