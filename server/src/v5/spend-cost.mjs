// SPDX-License-Identifier: AGPL-3.0-only
// t1281 (decision 141, owner decision): every off-chain limit counts what REALLY leaves the wallet, exactly like the on-chain
// daily / term caps: amount + 0.1% protocol fee + network fee. ONE formula for every historic sum (AI total, everyday 24h, per-AI,
// allowance, unattended, float, merchant day) and every reported "spent" number. The app has the same rules (KipurseCore SpendCost.swift);
// the cross-test vectors are test/t1281-fee-counting.test.mjs -> Tests/KipurseCoreTests/t1281-spend-cost.json.txt.
//   fee        = result.fee                       (what the payment actually charged)
//              ?? ceil(amount * ppm / 1e6)        (same rounding as the adapter's feeFor)
//   networkFee = result.networkFee ?? result.pending.networkFee   (the quote that was sent)
//              ?? maxNetworkFee  while the row is in flight ('claimed' / 'submitted') without a quote yet (conservative placeholder)
//              ?? 0              for every other row (finished, prepared without a field, holds, vouchers)
// Per-payment SINGLE caps are NOT counted with this: they compare the merchant amount only (same as the chain).
import {feeFor} from './abi.mjs';
export const IN_FLIGHT_STATES=new Set(['claimed','submitted']);
const big=v=>{if(v===undefined||v===null||v==='')return null;try{const b=BigInt(v);return b<0n?null:b;}catch{return null;}};
const parsed=r=>{if(r===undefined||r===null||r==='')return null;if(typeof r==='object')return r;try{const j=JSON.parse(r);return j&&typeof j==='object'?j:null;}catch{return null;}};
/** {amount, fee, networkFee, total} (BigInt atomic) of one payment record. row: {amount, result (object or JSON text), state}. */
export function costParts({amount,result,state}={},{ppm=0n,maxNetworkFee=0n}={}){
  const a=big(amount)??0n;const res=parsed(result);
  const fe=big(res?.fee)??feeFor(a,{ppm:BigInt(ppm??0n)});
  let nf=big(res?.networkFee)??big(res?.pending?.networkFee);
  if(nf===null)nf=IN_FLIGHT_STATES.has(String(state??''))?BigInt(maxNetworkFee??0n):0n;
  return {amount:a,fee:fe,networkFee:nf,total:a+fe+nf};}
/** amount + fee + networkFee of one payment record (BigInt atomic). */
export const costOf=(row,params)=>costParts(row,params).total;
/** what an INCOMING payment will take: amount + ceil(amount*ppm/1e6) + the network fee when it is known (claim time), else 0 (early gates). */
export const incomingCost=(amount,{ppm=0n,networkFee=0n}={})=>{const a=BigInt(amount);return a+feeFor(a,{ppm:BigInt(ppm??0n)})+BigInt(networkFee??0n);};
/** sum of costOf over rows */
export const sumCost=(rows,params)=>{let s=0n;for(const r of rows??[])s+=costOf(r,params);return s;};

/** t1281 (fail closed): a spending sum that fails must never read as "nothing spent" (that would let payments through). Only a table /
 *  column that does not exist in this deployment (older schemas, optional features) counts as zero; any other error is thrown, so the
 *  check refuses and nothing is paid. */
export const missingOk=(e,v=0n)=>{if(/no such (table|column)/i.test(String(e?.message??e)))return v;throw e;};
