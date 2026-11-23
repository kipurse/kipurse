// SPDX-License-Identifier: AGPL-3.0-only
// Disputes + refunds. The owner (app "Report a problem") or an agent (MCP kipurse_request_refund) opens a case for one payment.
// Refund protocol: the merchant sends USDC on Base back to the wallet (any amount up to the payment). A deposit FROM the payee
// address after the case was opened is matched automatically (partial or full); the case can also be closed by the owner.
// Stored encrypted at rest through the same store as the owner rules.
import {randomBytes} from 'node:crypto';import {plainStore} from './at-rest.mjs';
const lc=s=>String(s??'').toLowerCase();
export const REASONS=['not_received','wrong_amount','duplicate','not_as_described','unauthorized','other'];
export function createDisputes({store=plainStore,file,now=()=>Math.floor(Date.now()/1000)}){
  let S=store.readJson(file,null)??{cases:{}};const save=()=>store.writeJson(file,S);
  const api={
    open({purchase,reason='other',note='',by='owner'}){if(!purchase?.purchaseKey)throw Error('unknown payment');if(!REASONS.includes(reason))throw Error('reason must be one of '+REASONS.join(', '));
      const dup=Object.values(S.cases).find(c=>c.purchaseKey===purchase.purchaseKey&&c.status==='open');if(dup)return dup;
      const id='case-'+randomBytes(4).toString('hex');
      const c={id,purchaseKey:purchase.purchaseKey,payee:lc(purchase.payee),merchant:purchase.merchant??null,amount:String(purchase.amount),agent:purchase.agent??null,txHash:purchase.txHash??null,
        reason,note:String(note).slice(0,500),by,status:'open',openedAt:now(),refunded:'0',refunds:[],reference:'KIPURSE-REFUND-'+id.slice(5).toUpperCase()};
      S.cases[id]=c;save();return c;},
    list(){return Object.values(S.cases).sort((a,b)=>b.openedAt-a.openedAt);},
    get(id){return S.cases[id]??null;},
    close(id,status='resolved'){const c=S.cases[id];if(!c)throw Error('no such case');if(!['resolved','withdrawn','refunded'].includes(status))throw Error('bad status');c.status=status;c.closedAt=now();save();return c;},
    /** deposits: [{from, amount, txHash, at}] — refunds are deposits from the payee after the case opened. */
    matchRefunds(deposits=[]){let changed=0;for(const c of Object.values(S.cases)){if(c.status!=='open')continue;
      for(const d of deposits){if(lc(d.from)!==c.payee||c.refunds.some(r=>r.txHash===d.txHash))continue;if(d.at&&Number(d.at)<c.openedAt)continue;
        c.refunds.push({txHash:d.txHash??null,amount:String(d.amount),at:d.at??now()});c.refunded=String(BigInt(c.refunded)+BigInt(d.amount));changed++;
        if(BigInt(c.refunded)>=BigInt(c.amount)){c.status='refunded';c.closedAt=now();}}}
      if(changed)save();return changed;},
  };return api;}
