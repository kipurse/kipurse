// SPDX-License-Identifier: AGPL-3.0-only
// Real network-fee estimate for one AI-limits change (owner's Base Account -> wallet.executeBatch), in USDC at actual cost (0% markup).
import {PRINCIPLES} from './principles.mjs';import {L1_ALLOWANCE_WEI} from './phone-signer.mjs';import {parseAbi,encodeFunctionData,getAddress} from 'viem';
/** Gas of the wallet batch when the node can't estimate it (measured on a Base fork, test/fork/limits-gas-fork.e2e.mjs). */
export const LIMITS_CALL_GAS=200_000n; // fork: 172,308 (first) and 198,638 (later, incl. the USDC gas charge)
/** ERC-4337 overhead for a Base Account (7702) user op: verification + pre-verification + paymaster. */
export const LIMITS_AA_OVERHEAD=150_000n;
/** t606u: the Kipurse wallet pays the fee. Base Account signs and fronts it in USDC; the SAME batch refunds it from the wallet. */
export const LIMITS_REFUND_GAS=45_000n;
const RF_ABI=parseAbi(['function execute(address target,uint256 value,bytes data)','function transfer(address to,uint256 amount) returns (bool)']);
export function feeRefundCall({wallet,token,owner,fee}){return {to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:RF_ABI,functionName:'execute',args:[getAddress(token),0n,encodeFunctionData({abi:RF_ABI,functionName:'transfer',args:[getAddress(owner),BigInt(fee)]})]}),label:'fee_refund'};}
export function limitsChangeFee({callGas,gasPriceWei,ethUsd8,payerUSDC=null,walletUSDC}){
  if(PRINCIPLES.gasMarginBps!==0)throw Error('gas margin must be 0');
  const gas=BigInt(callGas??LIMITS_CALL_GAS)+LIMITS_AA_OVERHEAD+(walletUSDC!==undefined?LIMITS_REFUND_GAS:0n);const wei=gas*BigInt(gasPriceWei)+L1_ALLOWANCE_WEI;
  const usdc0=(wei*BigInt(ethUsd8)+10n**20n-1n)/10n**20n;const usdc=usdc0>0n?usdc0:1n;
  const bal=payerUSDC==null?null:BigInt(payerUSDC);
  const float=bal!==null&&bal>=usdc*3n/2n;
  if(walletUSDC===undefined)return {gas,gasPriceWei:BigInt(gasPriceWei),wei,usdc,payerUSDC:bal,canPayUSDC:float,token:'USDC'};
  const w=walletUSDC==null?null:BigInt(walletUSDC);const wok=w!==null&&w>=usdc;
  return {gas,gasPriceWei:BigInt(gasPriceWei),wei,usdc,payerUSDC:bal,walletUSDC:w,walletPays:true,canPayUSDC:float&&wok,reason:!wok?'wallet_low':!float?'float_low':null,floatNeed:usdc*3n/2n,token:'USDC'};}
