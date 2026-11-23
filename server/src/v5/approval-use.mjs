// SPDX-License-Identifier: AGPL-3.0-only
// t1181u (handbook §6#84, audit §6#83 check 1 gap ②): ONE owner approval = ONE x402 reservation, enforced by the server.
// The live V5.2 adapter frees the purchase key when the owner cancels a reservation (cancelReservation) and does not remember
// the owner approval, so the SAME approval could be prepared again until its validBefore (<= 600 s). The executor is this
// server, so the server records every owner approval it used for prepareAuthorization and never sends it a second time:
// after a cancel the owner has to approve again (new Face ID). The contract fix (approvalUsed) is on the contract branch.
// This only adds a refusal; none of the five duplicate-protection layers (0A#7) is touched.
import {keccak256,encodeAbiParameters,parseAbiParameters,getAddress} from 'viem';
export const INLINE_TRUST_TAG='0x4b505452';
/** Owner approval bytes that select the Approved route (inline payee-trust "KPTR" is reusable by design and is not counted). */
export const isOwnerApproval=sig=>typeof sig==='string'&&/^0x[0-9a-fA-F]+$/.test(sig)&&sig.length>2&&!sig.toLowerCase().startsWith(INLINE_TRUST_TAG);
/** Same fields as adapter.approvalDigest + chain + adapter, so two different approvals never share a key. */
export function approvalKey({chainId,adapter,account,purchaseKey,payee,amount,deadline}){
  return keccak256(encodeAbiParameters(parseAbiParameters('string,uint256,address,address,bytes32,address,uint256,uint256'),
    ['kipurse.owner-approval-use.v1',BigInt(chainId),getAddress(adapter),getAddress(account),purchaseKey,getAddress(payee),BigInt(amount),BigInt(deadline)]));}
export function createApprovalUse(db,{now=()=>Date.now()}={}){
  db.exec(`CREATE TABLE IF NOT EXISTS owner_approval_use(approval_key TEXT PRIMARY KEY, purchase_key TEXT, tx_hash TEXT, state TEXT NOT NULL, at INTEGER NOT NULL)`);
  const get=k=>{try{return db.prepare(`SELECT * FROM owner_approval_use WHERE approval_key=?`).get(k)??null;}catch{return null;}};
  return {
    /** null if this approval was never used; else the refusal (nothing sent). */
    check(k){const r=get(k);if(!r)return null;
      return {state:'rejected',reason:'OWNER_APPROVAL_ALREADY_USED',nothingPaid:true,decision:'refuse',
        fix:'This owner approval was already used for one reservation (it may have been cancelled by the owner). It is never reused; the owner has to approve again in the Kipurse app (Face ID).',
        say_to_user:'没有付款：这次批准已经用过一次（可能被你取消了），不会再用。需要的话请在启付里重新批准。/ Not paid: that approval was already used once (you may have cancelled it); it is never reused. Approve again in Kipurse if you still want this.'};},
    /** called right before the prepare tx is sent (tx hash known): from now on the approval counts as used. */
    consume(k,{purchaseKey,txHash}){db.prepare(`INSERT INTO owner_approval_use VALUES(?,?,?,?,?) ON CONFLICT(approval_key) DO UPDATE SET tx_hash=excluded.tx_hash,state='used',at=excluded.at`).run(k,purchaseKey??null,txHash??null,'used',now());},
    /** the prepare tx provably did not open a reservation (reverted / never sent): the same approval may be retried. */
    release(k){try{db.prepare(`DELETE FROM owner_approval_use WHERE approval_key=?`).run(k);}catch{}},
    get};}
