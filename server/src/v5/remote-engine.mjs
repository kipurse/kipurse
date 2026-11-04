// SPDX-License-Identifier: Apache-2.0
// Remote engine for the Kipurse MCP: the same tool surface, backed by a Kipurse gateway over HTTP (SDK). Holds no wallet keys;
// the gateway authenticates the agent (bearer token or X-Agent-Id) and enforces caps. Used by the one-line MCP install (M8).
import {KipurseClient} from '../../sdk/src/index.mjs';
export function createRemoteEngine({baseUrl,token,agentId,fetch:f}){
  const c=new KipurseClient({baseUrl,token,agentId,fetch:f});
  return {version:5,remote:true,
    status:()=>c.status(),limits:()=>c.limits(),parse:(request,o={})=>c.parse(request,o),
    preflight:(input,o={})=>c.preflight(input,{intentId:o.intentId,repeatKey:o.repeatKey}),
    pay:o=>c.pay(o),verifyPayee:o=>c.verifyPayee?c.verifyPayee(o):{ok:false,code:'unsupported'},paidFetch:o=>c.paidFetch(o),payMerchantOrder:o=>c.payMerchantOrder(o),setup:o=>c.setup(o),setLimits:o=>c.setLimits(o),proposeTrust:o=>c.proposeTrust(o),requestTrustFromOwner:o=>c.requestTrustFromOwner(o),trustRequestStatus:o=>c.trustRequestStatus(o),trustList:()=>c.trustList(),depositInfo:()=>c.depositInfo(),deposits:()=>c.deposits(),requestWithdrawal:o=>c.requestWithdrawal(o),executeWithdrawal:o=>c.executeWithdrawal(o),discoverMerchant:origin=>c.discoverMerchant(origin),claimPurchase:o=>c.claimPurchase(o),merchantInfo:q=>c.merchantInfo(q),
    listPurchases:({since,state,agentId:mine,limit}={})=>c.listPurchases({since,state,mine:mine?1:undefined,limit}),
    ledger:{get:async k=>{const r=await c.getPurchase(k);return r?.error==='not_found'?null:r;}},
    approvalRequest:(input,o={})=>c.approvalRequest(input,o),trustRequest:o=>c.trustRequest(o),
    untrustRequest:o=>c.untrustRequest(o),untrustSubmit:o=>c.untrustSubmit(o),denySignerRequest:o=>c.denySignerRequest(o),denySignerSubmit:o=>c.denySignerSubmit(o),
    exitPlan:()=>c.exitPlan(),recordGasSettlement:h=>c.recordGasSettlement(h),pause:()=>c.pause(),settleRoutine:()=>c.settleRoutine(),collectFees:()=>c.collectFees(),
    floatStatus:()=>c.floatStatus(),floatFund:o=>c.floatFund(o),floatReconcile:()=>c.floatReconcile(),
    exportCsv:async o=>{const r=await c.exportCsv(o);return {rows:r.rows,csv:r.csv,totals:null};},receipt:(k,o)=>c.receipt(k,o),annualSummary:(y,o)=>c.annualSummary(y,o)};
}
