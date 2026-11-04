// SPDX-License-Identifier: AGPL-3.0-only
// t968 fee transparency: one receipt shape used before approval (quote) and after payment (receipt). All amounts in USDC base units
// (6 decimals). Fees are taken in USDC from the wallet balance; the text never uses words that suggest someone else pays.
import {feeFor} from './abi.mjs';
export const BANNED_WORDS=['免费','垫付','赞助','free','sponsor','gasless'];
const fmt=x=>{const v=BigInt(x),w=v/1000000n,f=(v%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
export function buildReceipt({amount,ppm,networkFee=0n,payee,merchant=null,txHash=null,status='quote'}){
  const a=BigInt(amount),p=feeFor(a,{ppm}),n=BigInt(networkFee),t=a+p+n;
  const lines={zh:[`付给商户：${fmt(a)} USDC`,`Kipurse 服务费（${Number(ppm)/10000}%）：${fmt(p)} USDC`,`链上手续费（按实际成本）：${fmt(n)} USDC`,`从钱包余额扣除合计：${fmt(t)} USDC`],
    en:[`To merchant: ${fmt(a)} USDC`,`Kipurse service fee (${Number(ppm)/10000}%): ${fmt(p)} USDC`,`Network fee (actual cost): ${fmt(n)} USDC`,`Total deducted from wallet balance: ${fmt(t)} USDC`]};
  return {status,payee,merchant,txHash,token:'USDC',amount:a.toString(),protocolFee:p.toString(),networkFee:n.toString(),total:t.toString(),paidFrom:'wallet_balance',lines};}
export function assertWording(text){const s=String(text).toLowerCase();const hit=BANNED_WORDS.find(w=>s.includes(w.toLowerCase()));if(hit)throw Error('banned fee wording: '+hit);return true;}
