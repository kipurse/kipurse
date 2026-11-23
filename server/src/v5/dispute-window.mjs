// SPDX-License-Identifier: AGPL-3.0-only
// t968 chargeback-like protection on top of disputes.mjs: a merchant response window, escalation, and an evidence bundle the owner
// can hand to the merchant / Coinbase Commerce / a regulator. No pooled custody: refunds are always on-chain USDC from the merchant.
export const RESPONSE_WINDOW_SEC=7*86400;
export function caseState(c,now=Math.floor(Date.now()/1000)){if(c.status!=='open')return c.status;
  const due=c.openedAt+RESPONSE_WINDOW_SEC;if(BigInt(c.refunded)>0n)return 'partially_refunded';return now>due?'merchant_overdue':'awaiting_merchant';}
export function overdue(cases,now){return cases.filter(c=>caseState(c,now)==='merchant_overdue');}
export function refundRequest(c,{wallet}){return {to:c.payee,reference:c.reference,wallet,amount:c.amount,chain:'Base',token:'USDC',
  respondBy:c.openedAt+RESPONSE_WINDOW_SEC,
  text:{en:`Refund request ${c.reference}: please send up to ${c.amount} USDC base units on Base to ${wallet}. Original tx: ${c.txHash??'n/a'}. Reason: ${c.reason}.`,
    zh:`退款申请 ${c.reference}：请在 Base 链把最多 ${c.amount}（USDC 最小单位）退回到 ${wallet}。原交易：${c.txHash??'无'}。原因：${c.reason}。`}};}
export function evidence(c){return {case:c.id,reference:c.reference,payment:{txHash:c.txHash,amount:c.amount,payee:c.payee,merchant:c.merchant,agent:c.agent},
  reason:c.reason,note:c.note,openedAt:c.openedAt,refunds:c.refunds,state:caseState(c)};}
