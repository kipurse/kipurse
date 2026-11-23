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
/** Allowance the paymaster may pull for one cap change. Hard stop 0.05 USDC. */
export const LIMITS_APPROVE_CAP=50_000n;
/** Extra room on the Pimlico token quote so a small price move still fits inside the allowance. */
export const LIMITS_APPROVE_MARGIN_BPS=2_000n;
/** Browser origins that call the paymaster while the Coinbase wallet popup is open. */
export const PAYMASTER_CORS_ORIGINS=new Set(['https://keys.coinbase.com','https://sign.kipurse.com','https://wallet.coinbase.com']);
/** Old path may prepend the CDP approve. The wallet-pays path builds its own two-call batch. */
export function limitsChangeCalls({direct,approveCall=null,changeCall}){return direct?[changeCall]:[...(approveCall?[approveCall]:[]),changeCall];}
const APPROVE_ABI=parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
/** USDC.approve(Pimlico ERC-20 paymaster, amount). Amount is already capped. */
export function limitsPaymasterApprove(amount){const a=BigInt(amount);
  if(a<=0n||a>LIMITS_APPROVE_CAP)throw Object.assign(Error('approve cap'),{code:'kipurse_balance_insufficient_for_fee'});
  return {to:getAddress(BASE_USDC),value:'0x0',data:encodeFunctionData({abi:APPROVE_ABI,functionName:'approve',args:[getAddress(ERC20_PAYMASTER),a]}),label:'usdc_paymaster_approve'};}
/** Pimlico token cost, then a margin. Over the 0.01 fee cap or the 0.05 allowance cap -> refuse. */
export function limitsTokenApprove({gasWei,gasPriceWei,postOpGas=0n,exchangeRate,marginBps=LIMITS_APPROVE_MARGIN_BPS,feeCap=LIMITS_WALLET_FEE_CAP,approveCap=LIMITS_APPROVE_CAP}){
  const quote=((BigInt(gasWei)+BigInt(postOpGas)*BigInt(gasPriceWei))*BigInt(exchangeRate))/10n**18n;
  const usdc=quote>0n?quote:1n;
  const amount=(usdc*(10_000n+BigInt(marginBps))+9_999n)/10_000n;
  if(usdc>=BigInt(feeCap)||amount>BigInt(approveCap))return {ok:false,reason:'kipurse_balance_insufficient_for_fee',quote:usdc,amount};
  return {ok:true,reason:null,quote:usdc,amount};}
export function parseTokenQuote(json){const quotes=json?.result?.quotes??json?.quotes;if(!Array.isArray(quotes))return null;
  const q=quotes.find(x=>String(x?.token??'').toLowerCase()===BASE_USDC.toLowerCase()&&String(x?.paymaster??'').toLowerCase()===ERC20_PAYMASTER.toLowerCase());
  if(!q||q.exchangeRate==null)return null;
  try{return {postOpGas:BigInt(q.postOpGas??0),exchangeRate:BigInt(q.exchangeRate),paymaster:ERC20_PAYMASTER};}catch{return null;}}
export function paymasterCorsHeaders(origin){const o=String(origin??'');if(!PAYMASTER_CORS_ORIGINS.has(o))return null;
  return {'access-control-allow-origin':o,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','access-control-max-age':'600','vary':'Origin'};}
export function limitsWalletFeeCap(env=process.env){const s=String(env.KIPURSE_LIMITS_WALLET_FEE_CAP??'0.01').trim();
  if(!/^\d{1,7}(\.\d{1,6})?$/.test(s))return LIMITS_WALLET_FEE_CAP;const [w,f='']=s.split('.');return BigInt(w)*1_000_000n+BigInt((f+'000000').slice(0,6));}
/** Comma-separated Kipurse wallet addresses. Empty = nobody (the old Base Account path stays). */
export function limitsWalletPaysAllowlist(env=process.env){return String(env.KIPURSE_LIMITS_WALLET_PAYS_ALLOWLIST??'').split(',').map(s=>s.trim().toLowerCase()).filter(s=>/^0x[0-9a-f]{40}$/.test(s));}
export function walletPaysLimits(wallet,env=process.env){return !!wallet&&limitsWalletPaysAllowlist(env).includes(String(wallet).toLowerCase());}
/** t1125u (§6#64 rule 10): EVERY wallet pays its limit changes from its own USDC in the §6#63 two-call batch (fee to the fixed fee address +
 *  cap change, sent from the owner's Base Account). The allowlist above no longer gates the path; the old relay/refund batch is not built for anyone. */
export function limitsWalletFeeForAll(wallet){return /^0x[0-9a-fA-F]{40}$/.test(String(wallet??''));}
/** Pimlico ERC-20 paymaster. Never the onboarding paymaster URL. */
export function erc20PaymasterURL(env=process.env){const url=String(env.KIPURSE_ERC20_PAYMASTER_URL??'https://public.pimlico.io/v2/8453/rpc').trim();
  const onboard=String(env.KIPURSE_ONBOARD_PAYMASTER_URL??'').trim();
  if(!/^https:\/\/\S+$/.test(url))throw Object.assign(Error('bad erc20 paymaster url'),{code:'paymaster_url'});
  if(onboard&&url===onboard)throw Object.assign(Error('erc20 paymaster url must not be the onboard paymaster'),{code:'paymaster_url'});
  return url;}
/** Quote for a cap change paid by the Kipurse wallet. No Base float and no refund gas. */
export function limitsWalletPaysFee({callGas,gasPriceWei,ethUsd8,walletUSDC,cap=LIMITS_WALLET_FEE_CAP,extraGas=0n}){
  if(PRINCIPLES.gasMarginBps!==0)throw Error('gas margin must be 0');
  const gas=BigInt(callGas??LIMITS_CALL_GAS)+LIMITS_AA_OVERHEAD+BigInt(extraGas);const wei=gas*BigInt(gasPriceWei)+L1_ALLOWANCE_WEI;
  const usdc0=(wei*BigInt(ethUsd8)+10n**20n-1n)/10n**20n;const usdc=usdc0>0n?usdc0:1n;
  const w=walletUSDC==null?null:BigInt(walletUSDC);const limit=BigInt(cap);
  const reason=usdc>=limit||w===null||w<usdc?'kipurse_balance_insufficient_for_fee':null;
  return {gas,gasPriceWei:BigInt(gasPriceWei),wei,usdc,walletUSDC:w,fromWallet:true,walletPays:false,canPayUSDC:reason==null,reason,cap:limit,token:'USDC'};}
/** Keep only the three read methods, and force EntryPoint v0.6 + Base USDC. */
export function rewritePaymasterBody(body){if(!body||typeof body!=='object')return {error:'bad_request'};
  const method=String(body.method??'');if(!LIMITS_PAYMASTER_METHODS.has(method))return {error:'method_not_allowed'};
  const params=Array.isArray(body.params)?body.params.slice():[];
  if(method==='pimlico_getTokenQuotes'){const ctx=params[0]&&typeof params[0]==='object'?{...params[0]}:{};ctx.tokens=[BASE_USDC];params[0]=ctx;params[1]=ENTRYPOINT_V06;params[2]='0x2105';}
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
/** t1105 (option C): the owner's Base Account only relays. Three calls, in this order, sent FROM the owner's Base Account:
 *  1. Kipurse wallet.execute(USDC, 0, transfer(owner, F))   2. USDC.approve(Pimlico ERC-20 paymaster, F)   3. the cap change (wallet.executeBatch).
 *  F = Pimlico quote x 1.2, hard stop 0.01 USDC. The ERC-20 paymaster charges only in postOp, after the batch ran, so the Base Account
 *  fronts nothing and is left with at most F minus the real fee. No sub-account, no ETH, no send without the paymaster. */
export const LIMITS_RELAY_CAP=10_000n;
/** Extra gas of the wallet -> owner USDC leg (wallet.execute + transfer). */
export const LIMITS_RELAY_GAS=45_000n;
export const LIMITS_RELAY_FEE_FROM='kipurse_wallet_relay';
const lc=a=>String(a??'').toLowerCase();
export function limitsRelayCalls({wallet,owner,amount,changeCall}){const a=BigInt(amount);
  if(a<=0n||a>LIMITS_RELAY_CAP)throw Object.assign(Error('relay cap'),{code:'kipurse_balance_insufficient_for_fee'});
  if(!/^0x[0-9a-fA-F]{40}$/.test(String(wallet))||!/^0x[0-9a-fA-F]{40}$/.test(String(owner))||lc(wallet)===lc(owner))throw Object.assign(Error('relay parties'),{code:'relay_parties'});
  if(!changeCall||lc(changeCall.to)!==lc(wallet)||BigInt(changeCall.value??0)!==0n||!lc(changeCall.data).startsWith('0x34fcd5be'))throw Object.assign(Error('relay change call'),{code:'relay_change'});
  return [{...feeRefundCall({wallet,token:BASE_USDC,owner,fee:a}),label:'fee_to_owner'},limitsPaymasterApprove(a),changeCall];}
/** Same rule the app (RequestVerify.limitsPrepared) and the page enforce. Returns F or null. */
export function checkRelayCalls(calls,{wallet,owner,cap=LIMITS_RELAY_CAP}){try{
  if(!Array.isArray(calls)||calls.length!==3)return null;const [t,ap,ch]=calls;const W=lc(wallet).replace(/^0x/,''),O=lc(owner).replace(/^0x/,'');
  if(!/^[0-9a-f]{40}$/.test(W)||!/^[0-9a-f]{40}$/.test(O)||W===O)return null;
  const pad=x=>x.padStart(64,'0');const d0=lc(t.data).replace(/^0x/,'');
  if(lc(t.to)!=='0x'+W||BigInt(t.value??0)!==0n||!d0.startsWith('b61d27f6'+pad(BASE_USDC.slice(2).toLowerCase())+pad('0')+pad('60')+pad('44')+'a9059cbb'+pad(O)))return null;
  if(d0.length!==8+64*4+192)return null; // 68-byte inner call padded to 96 bytes
  const F=BigInt('0x'+d0.slice(8+64*4+8+64,8+64*4+8+128));if(d0.slice(8+64*4+136)!=='0'.repeat(56))return null;
  const ok=limitsPaymasterApprove(F);if(lc(ap.to)!==lc(ok.to)||BigInt(ap.value??0)!==0n||lc(ap.data)!==lc(ok.data))return null;
  if(lc(ch.to)!=='0x'+W||BigInt(ch.value??0)!==0n||!lc(ch.data).startsWith('0x34fcd5be'))return null;
  if(F<=0n||F>BigInt(cap))return null;return F;}catch{return null;}}
/** t1123u (§6#63): later wallet-safety-limit changes take the network fee from the KIPURSE WALLET's USDC, same shape as the everyday
 *  withdraw (t752 / §6#62): sent FROM the owner's Base Account (signs only, never pre-funds), the existing sponsor fronts the gas only
 *  for this exact batch, and the SAME batch repays it from the wallet to the official fee address. Exactly two calls, in this order:
 *  1. wallet.execute(USDC, 0, transfer(feeTo, F))   2. wallet.executeBatch(cap change).   F <= 0.01 USDC. No Pimlico, no approve,
 *  no transfer to the owner, no sub-account, no ETH. */
export const LIMITS_WALLET_FEE_FROM='kipurse_wallet_fee';
/** Official Kipurse fee address (= withdraw / phone-enroll feeTo, App OwnerExit.withdrawFeeTo / RequestVerify.duesTo). */
export const LIMITS_OFFICIAL_FEE_TO='0xf14ef5dc4723245866c22c749a0a84afceba0dd9';
/** Extra gas of the wallet -> fee address USDC leg (wallet.execute + transfer). Same constant as the withdraw fee leg. */
export const LIMITS_FEE_TRANSFER_GAS=40_000n;
/** The sponsor re-checks before final paymaster data: fee >= 300k gas x price x 1.1 (onboard-sponsor WITHDRAW_REAL_GAS, 'underpaid').
 *  The quote is never below that, so a quoted batch is never refused as underpaid at today's price. */
export const LIMITS_SPONSOR_FLOOR_GAS=330_000n;
const FT_ABI=parseAbi(['function execute(address target,uint256 value,bytes data)','function transfer(address to,uint256 amount) returns (bool)']);
/** Quote: actual cost (estimated batch gas + AA overhead + fee leg) x price + L1 allowance, never below the sponsor floor. 0% markup. */
export function limitsWalletFee({callGas,gasPriceWei,ethUsd8,walletUSDC,cap=LIMITS_WALLET_FEE_CAP}){
  if(PRINCIPLES.gasMarginBps!==0)throw Error('gas margin must be 0');
  const gp=BigInt(gasPriceWei),gas=BigInt(callGas??LIMITS_CALL_GAS)+LIMITS_AA_OVERHEAD+LIMITS_FEE_TRANSFER_GAS;
  let wei=gas*gp+L1_ALLOWANCE_WEI;const floor=LIMITS_SPONSOR_FLOOR_GAS*gp;if(floor>wei)wei=floor;
  const usdc0=(wei*BigInt(ethUsd8)+10n**20n-1n)/10n**20n;const usdc=usdc0>0n?usdc0:1n;
  const w=walletUSDC==null?null:BigInt(walletUSDC);const limit=BigInt(cap);
  const reason=usdc>=limit?'fee_above_cap':w===null||w<usdc?'wallet_low':null;
  return {gas,gasPriceWei:gp,wei,usdc,walletUSDC:w,fromWallet:true,walletPays:true,canPayUSDC:false,reason,cap:limit,token:'USDC'};}
/** wallet.execute(USDC, 0, transfer(feeTo, F)) + the cap change. Refuses anything else. */
export function limitsWalletFeeCalls({wallet,feeTo,fee,changeCall}){const f=BigInt(fee);
  if(f<=0n||f>=LIMITS_WALLET_FEE_CAP)throw Object.assign(Error('fee cap'),{code:'fee_above_cap'});
  if(!/^0x[0-9a-fA-F]{40}$/.test(String(wallet))||!/^0x[0-9a-fA-F]{40}$/.test(String(feeTo))||lc(wallet)===lc(feeTo))throw Object.assign(Error('fee parties'),{code:'fee_parties'});
  if(!changeCall||lc(changeCall.to)!==lc(wallet)||BigInt(changeCall.value??0)!==0n||!lc(changeCall.data).startsWith('0x34fcd5be'))throw Object.assign(Error('change call'),{code:'limits_change'});
  const fc={to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:FT_ABI,functionName:'execute',args:[getAddress(BASE_USDC),0n,encodeFunctionData({abi:FT_ABI,functionName:'transfer',args:[getAddress(feeTo),f]})]})};
  return [fc,{to:getAddress(wallet),value:'0x0',data:changeCall.data}];}
/** Same rule the App (RequestVerify.limitsPrepared, wallet-fee branch) enforces. Returns F or null. */
export function checkLimitsWalletFeeCalls(calls,{wallet,feeTo,cap=LIMITS_WALLET_FEE_CAP}){try{
  if(!Array.isArray(calls)||calls.length!==2)return null;const [t,ch]=calls;const W=lc(wallet).replace(/^0x/,''),FT=lc(feeTo).replace(/^0x/,'');
  if(!/^[0-9a-f]{40}$/.test(W)||!/^[0-9a-f]{40}$/.test(FT)||W===FT)return null;
  const pad=x=>x.padStart(64,'0');const d0=lc(t.data).replace(/^0x/,'');
  if(lc(t.to)!=='0x'+W||BigInt(t.value??0)!==0n||!d0.startsWith('b61d27f6'+pad(BASE_USDC.slice(2).toLowerCase())+pad('0')+pad('60')+pad('44')+'a9059cbb'+pad(FT)))return null;
  if(d0.length!==8+64*4+192)return null;
  const F=BigInt('0x'+d0.slice(8+64*4+8+64,8+64*4+8+128));if(d0.slice(8+64*4+136)!=='0'.repeat(56))return null;
  if(lc(ch.to)!=='0x'+W||BigInt(ch.value??0)!==0n||!lc(ch.data).startsWith('0x34fcd5be'))return null;
  if(F<=0n||F>=BigInt(cap))return null;return F;}catch{return null;}}
