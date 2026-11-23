// SPDX-License-Identifier: AGPL-3.0-only
// Generic payment-request intake (V5). The wallet adapts to the merchant: anything that resolves to "send N USDC to address A on this
// chain" is payable with ZERO merchant-side changes. Merchant-signed EIP-712 orders are an optional upgrade, never required.
// Accepted:
//   - plain address + amount   {to|payTo|address|payee, amount (decimal USDC) | amountAtomic}           -> direct pay
//   - EIP-681 URI              "ethereum:<USDC>@<chainId>/transfer?address=<to>&uint256=<atomic>"        -> direct pay
//   - x402 / MPP 402 response  {status:402, headers, body, url}  or an https URL to fetch               -> x402 (paid fetch)
//   - Stripe crypto PaymentIntent (deposit mode) / Coinbase Business checkout objects                  -> direct pay / x402
//   - generic deposit-address JSON {address|deposit_address|deposit_addresses.base.address, amount, currency, network, id, expires_at}
//   - Kipurse / ExampleShop signed order objects (optional)                                                  -> paySigned
//   - Solana Pay "solana:" links: TODO (rejected with solana_not_supported_yet; this wallet pays USDC on Base only)
// Exactly-once: the protocol's own order id wins (Stripe pi id, Coinbase checkout id, x402 server nonce, signed orderId). When the
// request has none, the agent MUST supply merchant + orderRef; the canonical reference is then "order:<merchant>:<orderRef>", so every
// agent paying the same merchant order derives the same on-chain purchaseKey (adapter.purchaseUsed) and it can be paid only once.
import {isAddress,getAddress} from 'viem';
import {USDC,toUnixSeconds} from '../v4/detector.mjs';
const lc=s=>String(s??'').toLowerCase();const NET={base:8453,'base-mainnet':8453,'base-sepolia':84532,'eip155:8453':8453,'eip155:84532':84532};
const rej=(code,detail)=>({ok:false,code,detail});
export const decimalUsdcToAtomic=v=>{const s=String(v??'').trim();const m=/^([0-9]{1,15})(?:\.([0-9]{1,6}))?$/.exec(s);if(!m)return undefined;
  const n=BigInt(m[1])*1000000n+BigInt((m[2]??'').padEnd(6,'0')||'0');return n>0n?n:undefined;};
const atomicOf=x=>{if(x.amountAtomic!==undefined){const s=String(x.amountAtomic);return /^[0-9]{1,30}$/.test(s)&&BigInt(s)>0n?BigInt(s):undefined;}
  if(typeof x.amount==='number'){if(!Number.isFinite(x.amount)||x.amount<=0)return undefined;const t=String(x.amount);if(/e/i.test(t))return undefined;return decimalUsdcToAtomic(t);} // numbers are USDC (0.01 = one cent); >6 decimals refused
  return decimalUsdcToAtomic(x.amount);};
const expOf=toUnixSeconds; // unix s / ms / ISO-8601 -> unix seconds (ExampleShop: unix in unsigned orders, ISO in signed ones)
export const orderRefOf=({merchant,orderRef})=>orderRef!=null&&String(orderRef).trim()?`${String(merchant??'').trim().toLowerCase()||'unknown'}:${String(orderRef).trim()}`:null;
/** -> {ok:true, kind:'request', request} (engine detector input) | {ok:true, kind:'fetch', url} | {ok:false, code, detail} */
export function normalizePaymentRequest(payment,{chainId,merchant,orderRef,expiresAt}={}){
  const ref=orderRefOf({merchant,orderRef});
  if(typeof payment==='string'){const s=payment.trim();
    if(/^solana:/i.test(s))return rej('solana_not_supported_yet','Solana Pay links are a TODO; this wallet pays USDC on Base');
    if(/^ethereum:/i.test(s))return {ok:true,kind:'request',request:{uri:s.replace(/^ethereum:pay-/i,'ethereum:')},merchantOrderId:ref};
    if(/^https:\/\//i.test(s))return {ok:true,kind:'fetch',url:s};
    if(isAddress(s,{strict:false}))return rej('amount_required','a bare address needs an amount: pass {to, amount}');
    return rej('unknown_payment_request','strings must be an ethereum: URI, an https URL (x402) or solana: (TODO)');}
  if(!payment||typeof payment!=='object')return rej('unknown_payment_request');
  // already a detector input
  for(const k of ['uri','direct','signedOrder','coinbaseCheckout','stripePaymentIntent'])if(payment[k]!==undefined)return {ok:true,kind:'request',request:{[k]:payment[k]},merchantOrderId:ref};
  if(payment.status===402)return {ok:true,kind:'request',request:{status:402,headers:payment.headers??{},body:payment.body,url:payment.url}};
  if(payment.url&&/^https:\/\//i.test(String(payment.url))&&!payment.amount&&!payment.amountAtomic)return {ok:true,kind:'fetch',url:payment.url};
  // recognise vendor objects by shape
  if(payment.object==='payment_intent'||/^pi_/.test(String(payment.id??''))&&payment.next_action)return {ok:true,kind:'request',request:{stripePaymentIntent:payment}};
  if(payment.x402_url||(payment.id&&payment.network&&payment.address&&payment.status&&payment.currency&&/checkout/i.test(String(payment.object??payment.type??'checkout'))))return {ok:true,kind:'request',request:{coinbaseCheckout:payment}};
  if(/^kipurse\.signed-order\.v[12]$/.test(String(payment.version))||/^exampleshop\.usdc-deposit-order\.v[12]$/.test(String(payment.dtoVersion)))return {ok:true,kind:'request',request:{signedOrder:payment}};
  // plain address + amount, or generic deposit-address JSON
  const to=payment.to??payment.payTo??payment.payee??payment.address??payment.deposit_address??payment.depositAddress??payment.deposit_addresses?.base?.address;
  if(to!==undefined){
    if(!isAddress(String(to),{strict:false}))return rej('bad_payee');
    const net=payment.chainId??payment.network??payment.chain;const cid=net===undefined?chainId:(NET[lc(net)]??Number(net));
    if(!Number.isSafeInteger(cid)||cid!==chainId)return rej('unsupported_network',String(net));
    const cur=payment.currency??payment.asset??payment.token;
    if(cur!==undefined&&lc(cur)!=='usdc'&&lc(cur)!==lc(USDC[cid]))return rej('unsupported_asset',String(cur));
    if(payment.tokenContract!==undefined&&lc(payment.tokenContract)!==lc(USDC[cid]))return rej('unsupported_asset',String(payment.tokenContract)); // checked on its own, never against `token`
    const amount=atomicOf(payment);if(amount===undefined)return rej('bad_amount','decimal USDC string with at most 6 places, or amountAtomic');
    const protoId=payment.id??payment.order_id??payment.orderId;const exp=expOf(payment.expires_at??payment.expiresAt??expiresAt);
    if(exp===undefined)return rej('bad_expiry');
    const moid=protoId!=null&&String(protoId).trim()?`${String(merchant??payment.merchant??'').trim().toLowerCase()||'deposit'}:${String(protoId).trim()}`:ref;
    if(!moid)return rej('order_ref_required','plain address payments need merchant + orderRef (or an order id in the request) for exactly-once');
    return {ok:true,kind:'request',request:{direct:{chainId:cid,token:USDC[cid],payee:getAddress(lc(to)),amount:amount.toString(),merchantOrderId:moid,...(exp?{expiresAt:exp}:{})}}};}
  return rej('unknown_payment_request','no supported shape; refusing to guess');
}
