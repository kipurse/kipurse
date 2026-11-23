// SPDX-License-Identifier: AGPL-3.0-only
// t1181u (handbook §6#84, audit §6#83 check 3): every OFF-CHAIN limit record (everyday limits, mandates / AI allowances,
// per-AI caps) is pinned to ONE network (chainId) and ONE token contract, like the on-chain SpendPermission already is.
//  - Records written before t1181u carry no scope; they are read (and migrated) as the engine's own scope (mainnet: Base 8453 +
//    its USDC), so their behaviour for Base USDC payments is unchanged.
//  - A payment whose network or token differs from a record's scope is REFUSED (nothing paid): a limit set for one chain or
//    one token can never be spent on another. This only adds refusals; it never makes a payment pass that failed before.
export const USDC_BY_CHAIN=Object.freeze({8453:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',84532:'0x036cbd53842c5426634e7929541ec2318f3dcf7e'});
const lc=s=>String(s??'').toLowerCase();
/** {chainId:number, token:lowercase address}; token defaults to that chain's USDC. Throws on anything malformed. */
export function makeScope(chainId,token){const c=Number(chainId);const t=lc(token??USDC_BY_CHAIN[c]);
  if(!Number.isSafeInteger(c)||c<=0||!/^0x[0-9a-f]{40}$/.test(t))throw Object.assign(Error('BAD_LIMIT_SCOPE'),{code:'bad_limit_scope'});
  return {chainId:c,token:t};}
/** Scope stored on a record, or `def` for a legacy record without one. */
export function scopeOf(rec,def){const c=rec?.chainId??rec?.chain_id;if(c==null||c==='')return def?makeScope(def.chainId,def.token):null;return makeScope(c,rec?.token);}
export const sameScope=(a,b)=>!!a&&!!b&&Number(a.chainId)===Number(b.chainId)&&lc(a.token)===lc(b.token);
const NET={8453:'Base',84532:'Base Sepolia'};const net=c=>NET[c]??('chain '+c);
/** The refusal every caller returns (never pays, never asks the owner: another chain / token is simply not covered). */
export function scopeRefusal(what,rec,pay){
  return {state:'rejected',reason:'LIMIT_SCOPE_MISMATCH',nothingPaid:true,decision:'refuse',limitScope:{chainId:rec?.chainId??null,token:rec?.token??null},paymentScope:{chainId:pay?.chainId??null,token:pay?.token??null},
    detail:`the ${what} applies only to USDC (${rec?.token??'?'}) on ${net(rec?.chainId)}; this payment is ${pay?.token??'?'} on ${net(pay?.chainId)}`,
    fix:'Kipurse limits cover only USDC on the wallet\'s own network. Do not retry on another network or with another token.',
    say_to_user:'没有付款：你设的额度只适用于钱包所在网络上的 USDC，这笔不是。/ Not paid: your limits only cover USDC on your wallet\'s network; this payment is not.'};}
/** null if `pay` is inside the record's scope (legacy record = `def`), else the refusal. A malformed payment scope is refused. */
export function scopeCheck(what,rec,pay,def){let s,p;try{s=scopeOf(rec,def);}catch{return scopeRefusal(what,null,pay);}if(!s)return null;
  try{p=makeScope(pay?.chainId,pay?.token);}catch{return scopeRefusal(what,s,pay);}
  return sameScope(s,p)?null:scopeRefusal(what,s,p);}
