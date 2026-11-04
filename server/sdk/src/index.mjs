// SPDX-License-Identifier: Apache-2.0
// @kipurse/sdk 0.1 — zero-dependency client for the Kipurse gateway HTTP API (M1).
// The SDK never holds wallet keys: it talks to a gateway that enforces the owner's on-chain caps, term and trust tiers.
import {randomUUID} from 'node:crypto';
export class KipurseError extends Error{constructor(status,body){super(`kipurse ${status}: ${body?.reason??body?.error??'error'}`);this.status=status;this.body=body;}}
export const newIdempotencyKey=(prefix='kp')=>`${prefix}-${randomUUID()}`;
export class KipurseClient{
  /** @param {{baseUrl:string, token?:string, agentId?:string, fetch?:typeof fetch}} o */
  constructor({baseUrl,token,agentId,fetch:f}={}){if(!baseUrl)throw Error('baseUrl required');this.baseUrl=baseUrl.replace(/\/$/,'');this.token=token;this.agentId=agentId;this.f=f??globalThis.fetch;}
  async #req(method,path,body,{idempotencyKey,allow=[200,422]}={}){
    const h={'content-type':'application/json'};if(this.token)h.authorization='Bearer '+this.token;else if(this.agentId)h['x-agent-id']=this.agentId;if(idempotencyKey)h['idempotency-key']=idempotencyKey;
    const r=await this.f(this.baseUrl+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});const j=await r.json().catch(()=>({error:'bad_json'}));
    if(!allow.includes(r.status))throw new KipurseError(r.status,j);return j;}
  async #raw(method,path,body){const h={'content-type':'application/json'};if(this.token)h.authorization='Bearer '+this.token;else if(this.agentId)h['x-agent-id']=this.agentId;
    const r=await this.f(this.baseUrl+path,{method,headers:h,body:JSON.stringify(body)});if(r.status!==200)throw new KipurseError(r.status,await r.json().catch(()=>({})));return {csv:await r.text(),rows:Number(r.headers.get('x-kipurse-rows')??0)};}
  status(){return this.#req('GET','/v1/status');}
  limits(){return this.#req('GET','/v1/limits');}
  /** Parse only (never pays). request: {status,headers,body,url} | {uri} | {direct} | {signedOrder} | {coinbaseCheckout} | {stripePaymentIntent} */
  parse(request,{intentId,repeatKey}={}){return this.#req('POST','/v1/parse',{request,intentId,repeatKey});}
  /** "Can I pay this and why not?" Accepts a request or {parsedId}. */
  preflight(input,{intentId,repeatKey}={}){return this.#req('POST','/v1/preflight',input?.parsedId?{parsedId:input.parsedId,intentId,repeatKey}:{request:input,intentId,repeatKey});}
  /** Pay exactly once for the whole team. */
  pay({request,parsedId,intentId,repeatKey,maxAmount,ownerApproval,idempotencyKey=newIdempotencyKey('pay')}){return this.#req('POST','/v1/pay',{request,parsedId,intentId,repeatKey,maxAmount,ownerApproval},{idempotencyKey});}
  /** ONE call for any merchant payment request (merchants need no Kipurse integration): plain {to, amount} / {to, amountAtomic},
   *  "ethereum:" EIP-681 URI, https URL or 402 response (x402/MPP), Stripe PaymentIntent, Coinbase checkout, deposit-address JSON, or an
   *  optional merchant-signed order. merchant + orderRef is the exactly-once key when the request has no order id of its own. */
  payAny({payment,merchant,orderRef,expiresAt,allowSameAmount,signedOrderUrl,intentId,repeatKey,maxAmount,ownerApproval,idempotencyKey=newIdempotencyKey('pay')}){return this.#req('POST','/v1/pay-any',{payment,merchant,orderRef,expiresAt,signedOrderUrl,allowSameAmount,intentId,repeatKey,maxAmount,ownerApproval},{idempotencyKey});}
  /** Same intake as payAny, never pays: shows the route (payDirect / x402 / paySigned), tier, fee and purchase key. */
  parseAny({payment,merchant,orderRef,expiresAt,intentId,repeatKey}){return this.#req('POST','/v1/parse-any',{payment,merchant,orderRef,expiresAt,intentId,repeatKey});}
  /** Owner onboarding: no answers -> questions + disclosure + risk notice; with the owner's answers -> the ONE-signature batch. */
  setup({answers}={}){return this.#req('POST','/v1/setup',{answers});}
  /** Tighten now / loosen after owner approval (never above the on-chain caps). */
  setLimits({changes}){return this.#req('POST','/v1/limits/set',{changes});}
  proposeTrust({payee,domain,reason,single,daily}){return this.#req('POST','/v1/trust/propose',{payee,domain,reason,single,daily});}
  requestTrustFromOwner({merchantName,payee,chain,single,total,expiresInDays,reason}){return this.#req('POST','/v1/trust/request-owner',{merchantName,payee,chain,single,total,expiresInDays,reason});}
  trustRequestStatus({id}){return this.#req('POST','/v1/trust/request-status',{id});}
  trustList(){return this.#req('POST','/v1/trust/list',{});}
  depositInfo(){return this.#req('POST','/v1/deposit/info',{});}
  deposits(){return this.#req('POST','/v1/deposits',{});}
  requestWithdrawal({amount}){return this.#req('POST','/v1/withdraw/request',{amount});}
  executeWithdrawal({withdrawalId}){return this.#req('POST','/v1/withdraw/execute',{withdrawalId});}
  /** Merchant USDC deposit order via the merchant's PUBLIC docs (discovered by the gateway); pays only what the order response says. */
  payMerchantOrder({origin,orderParams,merchantPurchaseId,signedOrder,intentId,repeatKey,maxAmount,idempotencyKey=newIdempotencyKey('mco')}){return this.#req('POST','/v1/merchant-order/pay',{origin,orderParams,merchantPurchaseId,signedOrder,intentId,repeatKey,maxAmount},{idempotencyKey});}
  /** Read-only discovery result for a merchant origin (never creates an order). */
  discoverMerchant(origin){return this.#req('POST','/v1/merchant-order/discover',{origin});}
  paidFetch({url,method='GET',headers,body,intentId,repeatKey,maxAmount,idempotencyKey=newIdempotencyKey('fetch')}){return this.#req('POST','/v1/fetch',{url,method,headers,body,intentId,repeatKey,maxAmount},{idempotencyKey});}
  claimPurchase({intentId,lineKey,ttlSec,note}){return this.#req('POST','/v1/claims',{intentId,lineKey,ttlSec,note});}
  merchantInfo(q={}){return this.#req('GET','/v1/merchants?'+new URLSearchParams(Object.entries(q).filter(([,v])=>v!==undefined)));}
  listPurchases(q={}){return this.#req('GET','/v1/purchases?'+new URLSearchParams(Object.entries(q).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])));}
  // ---- V5 (gateway in V5 mode) ----
  /** One-time owner approval request for a purchase above its tier caps; returns typed data for the owner to sign. */
  approvalRequest(input,{intentId,repeatKey}={}){return this.#req('POST','/v1/approval/request',input?.parsedId?{parsedId:input.parsedId,intentId,repeatKey}:{request:input,intentId,repeatKey});}
  /** Owner trust for a merchant: caps in merchant amounts (fee headroom added). Returns typed data; nothing changes until the owner signs. */
  trustRequest({merchantId,payees,signers,single,daily,expiresInDays}){return this.#req('POST','/v1/trust/request',{merchantId,payees,signers,single,daily,expiresInDays});}
  untrustRequest({merchantId}){return this.#req('POST','/v1/untrust/request',{merchantId});}
  untrustSubmit({merchant,nonce,deadline,signature}){return this.#req('POST','/v1/untrust/submit',{merchant,nonce,deadline,signature});}
  /** Owner request to block a merchant order signer (typed data); relay the owner's signature with denySignerSubmit. */
  denySignerRequest({signer}){return this.#req('POST','/v1/deny-signer/request',{signer});}
  denySignerSubmit({signer,nonce,deadline,signature}){return this.#req('POST','/v1/deny-signer/submit',{signer,nonce,deadline,signature});}
  /** Owner exit plan (one batch) + optional separately signed failed-gas settle step. Nothing is sent. */
  exitPlan(){return this.#req('POST','/v1/exit/plan',{});}
  /** After the owner sent the optional settle step: the gateway verifies the transfer on chain and marks the debt recovered. */
  recordGasSettlement(txHash){return this.#req('POST','/v1/exit/gas-settled',{txHash});}
  /** Emergency pause (only the owner can unpause). */
  pause(){return this.#req('POST','/v1/pause',{});}
  /** Routine maintenance: markSettled settled x402 reservations, reclaim expired ones. */
  settleRoutine(){return this.#req('POST','/v1/maintenance/settle',{});}
  /** Owner records (M6): accounting/tax CSV (owner time zone + UTC), receipts, annual summary. Not tax advice. */
  async exportCsv(o={}){return this.#raw('POST','/v1/reports/csv',o);}
  receipt(purchaseKey,o={}){return this.#req('POST','/v1/receipt',{purchaseKey,...o});}
  annualSummary(year,o={}){return this.#req('POST','/v1/reports/annual',{year,...o});}
  floatStatus(){return this.#req('POST','/v1/float/status',{});}
  floatFund(o={}){return this.#req('POST','/v1/float/fund',o);}
  floatReconcile(){return this.#req('POST','/v1/float/reconcile',{});}
  /** Anyone: move accrued fees (protocol + network) from the adapter to the fee recipient. */
  collectFees(){return this.#req('POST','/v1/maintenance/collect-fees',{});}
  getPurchase(key){return this.#req('GET','/v1/purchases/'+encodeURIComponent(key),undefined,{allow:[200,404]});}
}
/** fetch-compatible wrapper: 402 responses are paid through the gateway (exactly once per URL+repeatKey) and the content returned.
 *  Note: the gateway performs the request, so only method/headers/body strings are forwarded. */
export function wrapFetch(client,{maxAmount,intentId,repeatKey}={}){
  return async(url,init={})=>{const r=await client.paidFetch({url:String(url),method:init.method??'GET',headers:init.headers,body:typeof init.body==='string'?init.body:undefined,maxAmount,intentId,repeatKey});
    if(r.state==='rejected')throw new KipurseError(422,r);
    const body=r.body??JSON.stringify(r.result??r);return new Response(body,{status:r.state==='paid_by_other_agent'?200:(r.status??200),headers:{'x-kipurse-state':r.state,'x-kipurse-purchase':r.purchaseKey??''}});};
}
