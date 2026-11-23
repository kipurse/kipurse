// SPDX-License-Identifier: AGPL-3.0-only
// Base Sepolia REAL-PASSKEY owner test (testnet only). Pure helpers shared by the test server, the automated check and unit tests.
// Model (same as mainnet): the owner's passkey Coinbase Smart Wallet ("Base Account", keys.coinbase.com popup) owns a fresh
// agent wallet [owner, SpendPermissionManager]; ONE wallet_sendCalls batch creates it and runs the V5 setup batch inside it;
// the one-tap trust is an OwnerTrust EIP-712 signature checked through agentWallet -> owner ERC-1271 (nested replay-safe hash).
import {encodeFunctionData,encodeAbiParameters,parseAbiParameters,parseAbi,getAddress,hashTypedData,keccak256,toHex,decodeFunctionData,decodeAbiParameters} from 'viem';
import {buildMigrationPlanV5,buildRenewalPlanV5,SPM_BASE} from './plan.mjs';import {v5Abi} from './abi.mjs';import {trustTypedData} from './owner.mjs';
export const CHAIN_ID=84532;export const USDC_SEPOLIA='0x036CbD53842c5426634e7929541eC2318f3dCF7e';export const CBSW_FACTORY='0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a';
export const ERC6492_MAGIC='6492649264926492649264926492649264926492649264926492649264926492';
export const cbswAbi=parseAbi(['function createAccount(bytes[] owners,uint256 nonce) payable returns (address)','function getAddress(bytes[] owners,uint256 nonce) view returns (address)',
  'function executeBatch((address target,uint256 value,bytes data)[] calls) payable','function isOwnerAddress(address) view returns (bool)','function ownerAtIndex(uint256) view returns (bytes)',
  'function nextOwnerIndex() view returns (uint256)','function removedOwnersCount() view returns (uint256)','function replaySafeHash(bytes32) view returns (bytes32)',
  'function isValidSignature(bytes32,bytes) view returns (bytes4)']);
export const agentOwners=owner=>[encodeAbiParameters(parseAbiParameters('address'),[getAddress(owner)]),encodeAbiParameters(parseAbiParameters('address'),[SPM_BASE])];
/** Setup: [factory.createAccount([owner, SPM], nonce), agentWallet.executeBatch(V5 plan calls)] as ONE wallet_sendCalls from the owner. */
export function buildSetupBatch({owner,agentWallet,walletNonce,adapter,trust,session,vault,start,days=30,salt,deposit}){
  const plan=buildMigrationPlanV5({chainId:CHAIN_ID,wallet:agentWallet,owner,adapter,trust,token:USDC_SEPOLIA,executor:session,maxNetworkFee:'50000',
    stated:{single:'300000',daily:'600000',term:'2000000',openSingle:'50000',openDaily:'100000',verifiedSingle:'0',verifiedDaily:'0'},fee:{ppm:'1000'},
    start,end:start+days*86400,salt:String(salt),floatCap:'200000',zeroReserve:{vault,buffer:'200000'},trusts:[]});
  const create={to:CBSW_FACTORY,value:'0x0',data:encodeFunctionData({abi:cbswAbi,functionName:'createAccount',args:[agentOwners(owner),BigInt(walletNonce)]})};
  const inner={to:getAddress(agentWallet),value:'0x0',data:plan.walletExecuteBatch.data};
  return {plan,calls:[create,inner],deposit:String(deposit)};
}
/** Renewal (one owner signature): agentWallet.executeBatch(revoke current + approve fresh term + float cap) + registerPermission (vault keeps paying gas). */
export function buildRenewBatch({agentWallet,current,trust,adapter,days=30,nowS}){
  const plan=buildRenewalPlanV5({chainId:CHAIN_ID,current,trust,days,floatCap:'200000',trusts:[],nowS,start:nowS});
  const calls=[...plan.calls.map(c=>({target:c.to,value:0n,data:c.data})),{target:getAddress(adapter),value:0n,data:encodeFunctionData({abi:v5Abi,functionName:'registerPermission',args:[{...plan.permission,allowance:BigInt(plan.permission.allowance),salt:BigInt(plan.permission.salt)}]})}];
  return {plan,calls:[{to:getAddress(agentWallet),value:'0x0',data:encodeFunctionData({abi:cbswAbi,functionName:'executeBatch',args:[calls]})}]};
}
/** One-tap trust: OwnerTrust digest (adapter domain "Kipurse Owner" v5) and the typed data the OWNER's wallet signs:
 *  agentWallet.replaySafeHash(digest) = EIP-712 CoinbaseSmartWalletMessage{hash} under the agent wallet's domain. */
export function trustRequest({adapter,agentWallet,merchant,epoch,nonce,deadline}){
  const {typedData,digest}=trustTypedData({adapter,chainId:CHAIN_ID},{account:agentWallet,trust:merchant,epoch,nonce,deadline});
  const wrapper={domain:{name:'Coinbase Smart Wallet',version:'1',chainId:CHAIN_ID,verifyingContract:getAddress(agentWallet)},
    types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}],CoinbaseSmartWalletMessage:[{name:'hash',type:'bytes32'}]},
    primaryType:'CoinbaseSmartWalletMessage',message:{hash:digest}};
  return {ownerTrust:typedData,digest,wrapper,wrapperHash:hashTypedData(wrapper)};
}
/** The owner wallet may return an ERC-6492-wrapped signature (counterfactual account). Once deployed, the inner signature is what ERC-1271 checks. */
export function unwrap6492(sig){const s=String(sig).toLowerCase();if(!s.endsWith(ERC6492_MAGIC))return sig;
  return decodeAbiParameters(parseAbiParameters('address,bytes,bytes'),'0x'+s.slice(2,-64))[2];}
export const wrapForAgent=sig=>encodeAbiParameters(parseAbiParameters('(uint256 ownerIndex,bytes signatureData)'),[{ownerIndex:0n,signatureData:sig}]);
export const passkeyMerchant=(payee,signer,nowS)=>{const name='passkey-test-merchant.kipurse.test';return {merchant:keccak256(toHex(name)),name,payees:[getAddress(payee)],signers:[getAddress(signer)],single:'300000',daily:'600600',expiry:String(nowS+30*86400)};};
export const decodeInner=data=>{const d=decodeFunctionData({abi:cbswAbi,data});return d.args[0].map(c=>{try{return decodeFunctionData({abi:v5Abi,data:c.data}).functionName;}catch{return 'transfer';}});};
const SP='(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
export const spmAbi=parseAbi([`function isApproved(${SP} p) view returns (bool)`,`function isValid(${SP} p) view returns (bool)`,`function isRevoked(${SP} p) view returns (bool)`,`function getHash(${SP} p) view returns (bytes32)`]);
export const vaultAbi=parseAbi(['function sessionSigner() view returns (address)','function maxGasPerOp() view returns (uint256)']);
