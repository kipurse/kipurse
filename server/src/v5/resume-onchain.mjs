// SPDX-License-Identifier: AGPL-3.0-only
// t1139u (§6#71, owner decision t1139 option a, 2026-11-13): resuming AI payments after an emergency stop must also lift the ON-CHAIN pause,
// otherwise every AI payment keeps failing while the app says "resumed". The owner confirms ONE Base Account batch (signs only, pays no ETH):
//   1. wallet.execute(USDC, 0, transfer(feeTo, F))        F = actual network cost in USDC, 0% markup, 0 < F < cap (0.01 USDC)
//   2. wallet.execute(trust, 0, setPaused(false))          clears paused[wallet] and pausedUntil[wallet] (KipurseTrustV51.setPaused)
// sent through the existing wallet-pays sponsor (id prefix ur-), the same shape as withdraw / limits change (t752, t1119u, t1123u).
// Kipurse advances nothing net: the batch repays the quoted cost to the fixed fee address. The app shows "resumed" only after the
// server has read isPaused(wallet) == false on chain.
import {parseAbi,encodeFunctionData,getAddress} from 'viem';
import {BASE_USDC,LIMITS_WALLET_FEE_CAP,LIMITS_OFFICIAL_FEE_TO,limitsWalletFee} from './limits-fee.mjs';
export const RESUME_FEE_FROM='kipurse_wallet_fee';
export const RESUME_FEE_TO=LIMITS_OFFICIAL_FEE_TO;
export const RESUME_FEE_CAP=LIMITS_WALLET_FEE_CAP;
/** Gas of wallet.execute(trust, setPaused(false)) when estimateGas is unavailable (fork: ~35k; generous). */
export const RESUME_CALL_GAS=80_000n;
/** A prepared resume plan stays valid this long (the owner opens Coinbase, confirms, Base includes it). */
export const RESUME_PLAN_TTL_MS=30*60e3;
const ABI=parseAbi(['function execute(address target,uint256 value,bytes data)','function transfer(address to,uint256 amount) returns (bool)','function setPaused(bool v)','function isPaused(address) view returns (bool)']);
const lc=a=>String(a??'').toLowerCase();
export const IS_PAUSED_ABI=ABI;
export const unpauseData=()=>encodeFunctionData({abi:ABI,functionName:'setPaused',args:[false]});
/** wallet.execute(trust, 0, setPaused(false)), sent by the wallet's owner (the Base Account). */
export function unpauseCall({wallet,trust}){return {to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:ABI,functionName:'execute',args:[getAddress(trust),0n,unpauseData()]})};}
/** Live quote: same formula, floor and cap as the wallet-pays limits fee (§6#63). callGas = estimate of the unpause call. */
export function resumeFee({callGas,gasPriceWei,ethUsd8,walletUSDC,cap=RESUME_FEE_CAP}){return limitsWalletFee({callGas:callGas??RESUME_CALL_GAS,gasPriceWei,ethUsd8,walletUSDC,cap});}
/** The two calls. Refuses anything else (fee outside (0, cap), bad parties). */
export function resumeCalls({wallet,trust,feeTo=RESUME_FEE_TO,fee,cap=RESUME_FEE_CAP}){const f=BigInt(fee);
  if(f<=0n||f>=BigInt(cap))throw Object.assign(Error('fee cap'),{code:'fee_above_cap'});
  for(const a of [wallet,trust,feeTo])if(!/^0x[0-9a-fA-F]{40}$/.test(String(a)))throw Object.assign(Error('address'),{code:'fee_parties'});
  if(new Set([lc(wallet),lc(trust),lc(feeTo)]).size!==3)throw Object.assign(Error('fee parties'),{code:'fee_parties'});
  const fc={to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:ABI,functionName:'execute',args:[getAddress(BASE_USDC),0n,encodeFunctionData({abi:ABI,functionName:'transfer',args:[getAddress(feeTo),f]})]})};
  return [fc,unpauseCall({wallet,trust})];}
/** Same rule the App (RequestVerify.resumeReply) and the page (kpResumeOK) enforce. Returns F or null. */
export function checkResumeCalls(calls,{wallet,trust,feeTo=RESUME_FEE_TO,cap=RESUME_FEE_CAP}){try{
  if(!Array.isArray(calls)||calls.length!==2)return null;const W=lc(wallet).replace(/^0x/,''),T=lc(trust).replace(/^0x/,''),FT=lc(feeTo).replace(/^0x/,'');
  if(![W,T,FT].every(x=>/^[0-9a-f]{40}$/.test(x))||new Set([W,T,FT]).size!==3)return null;
  const pad=x=>x.padStart(64,'0');const d0=lc(calls[0].data).replace(/^0x/,'');
  if(lc(calls[0].to)!=='0x'+W||BigInt(calls[0].value??0)!==0n||!d0.startsWith('b61d27f6'+pad(BASE_USDC.slice(2).toLowerCase())+pad('0')+pad('60')+pad('44')+'a9059cbb'+pad(FT)))return null;
  if(d0.length!==8+64*4+192||d0.slice(8+64*4+136)!=='0'.repeat(56))return null;
  const F=BigInt('0x'+d0.slice(8+64*4+8+64,8+64*4+8+128));if(F<=0n||F>=BigInt(cap))return null;
  const u=unpauseCall({wallet:'0x'+W,trust:'0x'+T});if(lc(calls[1].to)!==lc(u.to)||BigInt(calls[1].value??0)!==0n||lc(calls[1].data)!==lc(u.data))return null;
  return F;}catch{return null;}}
/** Plain-language refusal texts (nothing was sent, nothing was charged). */
export const RESUME_TEXT={
  wallet_needs_topup:f=>({zh:`还没有恢复：启付钱包里的 USDC 不够付这次手续费（${f} USDC）。先充值再恢复。没有扣钱。`,en:`Not resumed: your Kipurse wallet doesn’t have enough USDC for the network fee (${f} USDC). Add money, then resume. Nothing was charged.`}),
  fee_above_cap:f=>({zh:`还没有恢复：现在 Base 手续费偏高（${f} USDC，超过 0.01 USDC 上限）。请过几分钟再试。没有扣钱。`,en:`Not resumed: the Base network fee is high right now (${f} USDC, above the 0.01 USDC cap). Please try again in a few minutes. Nothing was charged.`}),
  wallet_fee_unavailable:()=>({zh:'还没有恢复：现在不能从启付钱包扣手续费。请稍后再试。没有扣钱。',en:'Not resumed: the network fee can’t be taken from your Kipurse wallet right now. Please try again later. Nothing was charged.'}),
  chain_unknown:()=>({zh:'还没有恢复：现在读不到链上暂停状态。请稍后再试。没有扣钱。',en:'Not resumed: the on-chain pause status can’t be read right now. Please try again later. Nothing was charged.'})};
