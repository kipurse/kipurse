// SPDX-License-Identifier: Apache-2.0
// Canonical V5 purchase identity (M2). Every agent that sees the same merchant requirement derives the SAME bytes32
// merchantRef and therefore the SAME on-chain purchaseKey (adapter.purchaseKey(payee, merchantRef, repeatKey); the amount is NOT
// part of it, so a changed price for the same reference is refused, never paid twice), deduped in purchaseUsed[account][key].
// x402: the reference is the SERVER-provided resource + nonce, never the client-generated payment-identifier. Without a server
// nonce, repeated calls to the same API are distinct purchases by design (unless agents share one intentId).
import {randomBytes} from 'node:crypto';
import {keccak256,toBytes,encodeAbiParameters,parseAbiParameters,getAddress} from 'viem';
import {ZERO32} from './abi.mjs';
export const PURCHASE_TAG=keccak256(toBytes('kipurse.v5.purchase'));
export const REF_DOMAIN='kipurse-ref-v5';
/** URL canonical form: lower-case scheme+host (WHATWG URL does that), default port dropped, fragment dropped,
 *  query parameters sorted (key, then value), empty query removed. Path stays case-sensitive. */
export function canonicalUrl(u){const x=new URL(String(u).trim());x.hash='';
  const sp=[...x.searchParams].sort(([a,b],[c,d])=>a<c?-1:a>c?1:b<d?-1:b>d?1:0);x.search=sp.length?new URLSearchParams(sp).toString():'';
  return x.toString();}
/** Server-provided per-challenge nonce of an x402 requirement (if the merchant sends one). */
export const serverNonce=n=>{const v=n.serverNonce??n.raw?.extra?.nonce??n.raw?.extra?.challengeNonce??n.raw?.nonce;return v!=null&&String(v).trim()?String(v).trim():null;};
/** Merchant reference string, by precedence: explicit merchant order id (direct / Stripe PI / Coinbase checkout) >
 *  MPP challenge id > x402 resource URL + server nonce. Returns null when only a resource URL without nonce exists
 *  (x402 without nonce: each call is its own purchase, see identityV5). */
export function canonicalRefString(n){
  if(n.merchantOrderId!=null&&String(n.merchantOrderId).trim())return 'order:'+String(n.merchantOrderId).trim();
  if(n.challengeId!=null&&String(n.challengeId).trim())return 'mpp:'+String(n.challengeId).trim();
  const nonce=serverNonce(n);
  if(n.resource?.url&&nonce)return 'x402:'+canonicalUrl(n.resource.url)+'|nonce:'+nonce;
  return null;
}
export const refBytes=s=>keccak256(toBytes(REF_DOMAIN+'\u0000'+s));
export const repeatBytes=r=>r===undefined||r===null||r===''?ZERO32:keccak256(toBytes('kipurse-repeat-v5\u0000'+String(r)));
export const merchantIdBytes=id=>/^0x[0-9a-fA-F]{64}$/.test(String(id))?String(id).toLowerCase():keccak256(toBytes(String(id).trim().toLowerCase()));
export const purchaseKeyV5=(payee,merchantRef,repeatKey)=>keccak256(encodeAbiParameters(parseAbiParameters('bytes32,address,bytes32,bytes32'),[PURCHASE_TAG,getAddress(payee),merchantRef,repeatKey]));
export const SIGNED_TAG=keccak256(toBytes('kipurse.v5.signed-order'));
/** = adapter.signedPurchaseKey(merchant, orderId): signed orders are keyed on merchant + orderId only (not amount). */
export const signedPurchaseKeyV5=(merchant,orderId)=>keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,bytes32'),[SIGNED_TAG,merchant,orderId]));
/** {refString, merchantRef, repeatKey, purchaseKey} for direct / x402 requests. Signed orders use (signer, orderId) instead. */
export function identityV5(n,{intentId,repeatKey}={}){
  let s=canonicalRefString(n);
  if(s===null&&n.resource?.url){ // x402 without server nonce: distinct purchase per call unless the team shares an intentId
    const base='x402:'+canonicalUrl(n.resource.url);s=intentId!=null&&intentId!==''?base+'|intent:'+String(intentId):base+'|call:'+(n.callId??=randomBytes(12).toString('hex'));}
  if(s===null){const fb=intentId??repeatKey;if(fb===undefined||fb===null||fb==='')throw Object.assign(Error('PURCHASE_REF_REQUIRED'),{code:'purchase_ref_required'});s='caller:'+String(fb);}
  const merchantRef=refBytes(s),rk=repeatBytes(repeatKey);
  return {refString:s,merchantRef,repeatKey:rk,purchaseKey:purchaseKeyV5(n.payee,merchantRef,rk)};
}
/** Off-chain ledger key for a signed order (on chain: orderUsed[signer][orderId] + signedPurchaseKey(merchant, orderId)). */
export const signedLedgerKey=(signer,orderId)=>keccak256(encodeAbiParameters(parseAbiParameters('string,address,bytes32'),['kipurse.v5.signed-ledger',getAddress(signer),orderId]));
