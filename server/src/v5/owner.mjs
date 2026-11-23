// SPDX-License-Identifier: AGPL-3.0-only
// Owner-side typed data for V5 (domain "Kipurse Owner" v5). The owner signs with the smart wallet (passkey popup or
// EOA owner); the signature is checked by the wallet's ERC-1271, so the gateway never holds any owner key.
// OwnerTrust carries the human-readable merchant name/domain (merchant = keccak256(name) on chain), so the wallet shows it.
// trust/untrust by signature: the executor only RELAYS (trustBySig / untrustBySig); it cannot forge or alter them.
import {getAddress,hashTypedData,encodeAbiParameters,parseAbiParameters,toHex} from 'viem';
import {randomBytes} from 'node:crypto';
// V5.1: same name, version "5.1", verifyingContract = the V5.1 ADAPTER (KipurseTrustV51.ownerDigest uses core = adapter)
export const ownerDomain=({adapter,chainId,version='5'})=>({name:'Kipurse Owner',version:String(version),chainId,verifyingContract:getAddress(adapter)});
export const OWNER_TYPES={
  OwnerTrust:[{name:'account',type:'address'},{name:'merchant',type:'bytes32'},{name:'name',type:'string'},{name:'epoch',type:'uint64'},{name:'payees',type:'address[]'},{name:'signers',type:'address[]'},
    {name:'single',type:'uint160'},{name:'daily',type:'uint160'},{name:'expiry',type:'uint64'},{name:'nonce',type:'bytes32'},{name:'deadline',type:'uint256'}],
  OwnerTrust51:[{name:'account',type:'address'},{name:'merchant',type:'bytes32'},{name:'name',type:'string'},{name:'epoch',type:'uint64'},{name:'payees',type:'address[]'},{name:'signers',type:'address[]'},
    {name:'single',type:'uint160'},{name:'daily',type:'uint160'},{name:'expiry',type:'uint64'},{name:'anyPayee',type:'bool'},{name:'nonce',type:'bytes32'},{name:'deadline',type:'uint256'}],
  OwnerUntrust:[{name:'account',type:'address'},{name:'merchant',type:'bytes32'},{name:'nonce',type:'bytes32'},{name:'deadline',type:'uint256'}],
  OwnerDenySigner:[{name:'account',type:'address'},{name:'signer',type:'address'},{name:'nonce',type:'bytes32'},{name:'deadline',type:'uint256'}],
  OwnerApproval:[{name:'account',type:'address'},{name:'purchaseKey',type:'bytes32'},{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'deadline',type:'uint256'}],
};
export const newNonce=()=>toHex(randomBytes(32));
// on-chain primary type name stays "OwnerTrust" in V5.1 (OwnerTrust51 is only our lookup key for its field list)
const td=(ctx,key,message)=>{const primaryType=key==='OwnerTrust51'?'OwnerTrust':key;const t={domain:ownerDomain(ctx),types:{[primaryType]:OWNER_TYPES[key]},primaryType,message};return {typedData:t,digest:hashTypedData(t)};};
export const trustTypedData=(ctx,{account,trust,epoch,nonce,deadline})=>{const v51=String(ctx.version??'5')==='5.1';
  const m={account:getAddress(account),merchant:trust.merchant,name:trust.name,epoch:BigInt(epoch),
  payees:trust.payees.map(a=>getAddress(a)),signers:trust.signers.map(a=>getAddress(a)),single:BigInt(trust.single),daily:BigInt(trust.daily),expiry:BigInt(trust.expiry??0),nonce,deadline:BigInt(deadline)};
  if(!v51&&trust.anyPayee)throw Error('anyPayee needs a V5.1 trust contract');
  return v51?td(ctx,'OwnerTrust51',{...m,anyPayee:!!trust.anyPayee}):td(ctx,'OwnerTrust',m);};
export const untrustTypedData=(ctx,{account,merchant,nonce,deadline})=>td(ctx,'OwnerUntrust',{account:getAddress(account),merchant,nonce,deadline:BigInt(deadline)});
export const denySignerTypedData=(ctx,{account,signer,nonce,deadline})=>td(ctx,'OwnerDenySigner',{account:getAddress(account),signer:getAddress(signer),nonce,deadline:BigInt(deadline)});
export const approvalTypedData=(ctx,{account,purchaseKey,payee,amount,deadline})=>td(ctx,'OwnerApproval',{account:getAddress(account),purchaseKey,payee:getAddress(payee),amount:BigInt(amount),deadline:BigInt(deadline)});
/** Coinbase Smart Wallet: an EOA owner signs wallet.replaySafeHash(digest); wrap as SignatureWrapper(ownerIndex, r||s||v).
 *  (A passkey owner's wallet UI returns an already-wrapped signature for eth_signTypedData_v4.) */
export const wrapCbswSignature=(ownerIndex,sig)=>encodeAbiParameters(parseAbiParameters('(uint256 ownerIndex,bytes signatureData)'),[{ownerIndex:BigInt(ownerIndex),signatureData:sig}]);
/** Nested owner (mainnet layout): the paying wallet is a Coinbase Smart Wallet whose owner is the HUMAN's Base Account (an owner
 *  ADDRESS at ownerIndex). The wallet's ERC-1271 checks owner.isValidSignature(wallet.replaySafeHash(digest)), so the Base Account
 *  signs this wallet-level message (eth_signTypedData_v4 shows the wallet and the digest) and the result is wrapped for the wallet. */
export const nestedOwnerTypedData=({wallet,chainId,digest})=>({domain:{name:'Coinbase Smart Wallet',version:'1',chainId:Number(chainId),verifyingContract:getAddress(wallet)},
  types:{CoinbaseSmartWalletMessage:[{name:'hash',type:'bytes32'}]},primaryType:'CoinbaseSmartWalletMessage',message:{hash:digest}});
