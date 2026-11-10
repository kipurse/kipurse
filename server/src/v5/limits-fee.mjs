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
/** t1097: hard stop for the wallet-pays path. Default 0.01 USDC. Override with KIPURSE_LIMITS_WALLET_FEE_CAP (decimal USDC). */
export const LIMITS_WALLET_FEE_CAP=10_000n;
export const ERC20_PAYMASTER='0x6666666666667849c56f2850848ce1c4da65c68b';
export const ENTRYPOINT_V06='0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
export const LIMITS_PAYMASTER_METHODS=new Set(['pm_getPaymasterStubData','pm_getPaymasterData','pimlico_getTokenQuotes']);
export const BASE_USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** Cap-change calls only. The direct path never adds the USDC approve or the refund leg. */
export function limitsChangeCalls({direct,approveCall=null,changeCall}){return direct?[changeCall]:[...(approveCall?[approveCall]:[]),changeCall];}
export function limitsWalletFeeCap(env=process.env){const s=String(env.KIPURSE_LIMITS_WALLET_FEE_CAP??'0.01').trim();
  if(!/^\d{1,7}(\.\d{1,6})?$/.test(s))return LIMITS_WALLET_FEE_CAP;const [w,f='']=s.split('.');return BigInt(w)*1_000_000n+BigInt((f+'000000').slice(0,6));}
/** Comma-separated Kipurse wallet addresses. Empty = nobody (the old Base Account path stays). */
export function limitsWalletPaysAllowlist(env=process.env){return String(env.KIPURSE_LIMITS_WALLET_PAYS_ALLOWLIST??'').split(',').map(s=>s.trim().toLowerCase()).filter(s=>/^0x[0-9a-f]{40}$/.test(s));}
export function walletPaysLimits(wallet,env=process.env){return !!wallet&&limitsWalletPaysAllowlist(env).includes(String(wallet).toLowerCase());}
/** Pimlico ERC-20 paymaster. Never the onboarding paymaster URL. */
export function erc20PaymasterURL(env=process.env){const url=String(env.KIPURSE_ERC20_PAYMASTER_URL??'https://public.pimlico.io/v2/8453/rpc').trim();
  const onboard=String(env.KIPURSE_ONBOARD_PAYMASTER_URL??'').trim();
  if(!/^https:\/\/\S+$/.test(url))throw Object.assign(Error('bad erc20 paymaster url'),{code:'paymaster_url'});
  if(onboard&&url===onboard)throw Object.assign(Error('erc20 paymaster url must not be the onboard paymaster'),{code:'paymaster_url'});
  return url;}
/** Quote for a cap change paid by the Kipurse wallet. No Base float and no refund gas. */
export function limitsWalletPaysFee({callGas,gasPriceWei,ethUsd8,walletUSDC,cap=LIMITS_WALLET_FEE_CAP}){
  if(PRINCIPLES.gasMarginBps!==0)throw Error('gas margin must be 0');
  const gas=BigInt(callGas??LIMITS_CALL_GAS)+LIMITS_AA_OVERHEAD;const wei=gas*BigInt(gasPriceWei)+L1_ALLOWANCE_WEI;
  const usdc0=(wei*BigInt(ethUsd8)+10n**20n-1n)/10n**20n;const usdc=usdc0>0n?usdc0:1n;
  const w=walletUSDC==null?null:BigInt(walletUSDC);const limit=BigInt(cap);
  const reason=usdc>=limit?'fee_above_cap':(w===null||w<usdc)?'kipurse_balance_insufficient_for_fee':null;
  return {gas,gasPriceWei:BigInt(gasPriceWei),wei,usdc,walletUSDC:w,fromWallet:true,walletPays:false,canPayUSDC:reason==null,reason,cap:limit,token:'USDC'};}
/** Keep only the three read methods, and force EntryPoint v0.6 + Base USDC. */
export function rewritePaymasterBody(body){if(!body||typeof body!=='object')return {error:'bad_request'};
  const method=String(body.method??'');if(!LIMITS_PAYMASTER_METHODS.has(method))return {error:'method_not_allowed'};
  const params=Array.isArray(body.params)?body.params.slice():[];
  if(method==='pimlico_getTokenQuotes'){const ctx=params[0]&&typeof params[0]==='object'?{...params[0]}:{};ctx.tokens=[BASE_USDC];params[0]=ctx;}
  else{params[1]=ENTRYPOINT_V06;const ctx=params[3]&&typeof params[3]==='object'?{...params[3]}:{};ctx.token=BASE_USDC;params[3]=ctx;}
  return {ok:true,body:{jsonrpc:'2.0',id:body.id??1,method,params}};}
export function paymasterAddressOf(result){if(!result||typeof result!=='object')return null;
  if(typeof result.paymaster==='string'&&/^0x[0-9a-fA-F]{40}$/.test(result.paymaster))return result.paymaster.toLowerCase();
  const pad=typeof result.paymasterAndData==='string'?result.paymasterAndData:'';
  if(/^0x[0-9a-fA-F]{40,}$/.test(pad))return ('0x'+pad.slice(2,42)).toLowerCase();
  return null;}
/** Drop every quote that is not Base USDC, and refuse a paymaster that is not the Pimlico ERC-20 paymaster. */
export function sanitizePaymasterResponse(method,json){if(!json||typeof json!=='object'||Array.isArray(json))return {jsonrpc:'2.0',id:1,error:{code:-32000,message:'bad_upstream'}};
  if(json.error)return {jsonrpc:'2.0',id:json.id??1,error:{code:json.error.code??-32000,message:'upstream'}};
  const result=json.result;
  if(method==='pimlico_getTokenQuotes'){const keep=q=>String(q?.token??q?.address??'').toLowerCase()===BASE_USDC.toLowerCase();
    if(Array.isArray(result))return {jsonrpc:'2.0',id:json.id??1,result:result.filter(keep)};
    if(result&&Array.isArray(result.quotes))return {jsonrpc:'2.0',id:json.id??1,result:{...result,quotes:result.quotes.filter(keep)}};
    return {jsonrpc:'2.0',id:json.id??1,error:{code:-32000,message:'quotes'}};}
  if(paymasterAddressOf(result)!==ERC20_PAYMASTER.toLowerCase())return {jsonrpc:'2.0',id:json.id??1,error:{code:-32000,message:'paymaster'}};
  return {jsonrpc:'2.0',id:json.id??1,result};}
export function limitsChangeFee({callGas,gasPriceWei,ethUsd8,payerUSDC=null,walletUSDC}){
  if(PRINCIPLES.gasMarginBps!==0)throw Error('gas margin must be 0');
  const gas=BigInt(callGas??LIMITS_CALL_GAS)+LIMITS_AA_OVERHEAD+(walletUSDC!==undefined?LIMITS_REFUND_GAS:0n);const wei=gas*BigInt(gasPriceWei)+L1_ALLOWANCE_WEI;
  const usdc0=(wei*BigInt(ethUsd8)+10n**20n-1n)/10n**20n;const usdc=usdc0>0n?usdc0:1n;
  const bal=payerUSDC==null?null:BigInt(payerUSDC);
  const float=bal!==null&&bal>=usdc*3n/2n;
  if(walletUSDC===undefined)return {gas,gasPriceWei:BigInt(gasPriceWei),wei,usdc,payerUSDC:bal,canPayUSDC:float,token:'USDC'};
  const w=walletUSDC==null?null:BigInt(walletUSDC);const wok=w!==null&&w>=usdc;
  return {gas,gasPriceWei:BigInt(gasPriceWei),wei,usdc,payerUSDC:bal,walletUSDC:w,walletPays:true,canPayUSDC:float&&wok,reason:!wok?'wallet_low':!float?'float_low':null,floatNeed:usdc*3n/2n,token:'USDC'};}
