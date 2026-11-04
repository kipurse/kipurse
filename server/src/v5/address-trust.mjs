// SPDX-License-Identifier: AGPL-3.0-only
// ADDRESS TRUST (owner decisions 2026-10-25): the SERVER verifies every plain payee address against the FULL 40-hex address
// (never prefix/suffix). Agents only relay a simple verified / not-verified answer to the human.
//  verified  : on the owner trust list (on chain), or an address this wallet already paid / the owner's withdrawal address.
//  lookalike : NOT an exact known address but same first 4 AND last 4 hex chars as one  -> refused (owner can release on phone, Face ID).
//  dust_only : only ever seen as the SENDER of tiny (< 0.01 USDC), zero-value or non-USDC transfers, never paid -> refused (same release).
//  new       : never seen. Not verified; the existing owner caps for unknown payees still apply.
const lc=s=>String(s??'').toLowerCase();const hex=a=>lc(a).replace(/^0x/,'');
export const DUST_ATOMIC=10000n;// 0.01 USDC (D3)
export const groups4=a=>{const h=String(a??'');return h.slice(0,2)+h.slice(2).replace(/(.{4})/g,'$1 ').trim();};
export const isLookalike=(x,y,n=4)=>{const a=hex(x),b=hex(y);return a.length===40&&b.length===40&&a!==b&&a.slice(0,n)===b.slice(0,n)&&a.slice(-n)===b.slice(-n);};
/** Differing 4-char groups (0-based, 10 groups) between two addresses: for the phone's side-by-side view. */
export const diffGroups=(x,y)=>{const a=hex(x),b=hex(y),o=[];for(let i=0;i<10;i++)if(a.slice(i*4,i*4+4)!==b.slice(i*4,i*4+4))o.push(i);return o;};
export const ADDRESS_SOURCES=['user_typed_in_chat','user_pasted','from_trusted_list','from_document','from_web','from_tx_history','other'];
/**
 * classify({address, tier, known:[{address,label,kind}], inbound:[{from,amount,usdc}], source})
 * -> {status, verified, address, groups, lookalikes, inbound, required_action, code?, explain_zh, explain_en}
 */
export function classifyPayee({address,tier,known=[],inbound=[],source}){
  const A=lc(address);const out={address:String(address),groups:groups4(address),source:source??null};
  const exact=known.find(k=>lc(k.address)===A&&k.kind!=='trial_paid');/* small trial payments never verify a payee (guardrails B) */
  const trusted=tier==='trusted'||tier==='verified';
  const ins=inbound.filter(t=>lc(t.from)===A);
  out.inbound={count:ins.length,maxUsdcAtomic:ins.filter(t=>t.usdc).reduce((m,t)=>BigInt(t.amount??0)>m?BigInt(t.amount??0):m,0n).toString()};
  if(tier==='denied')return {...out,status:'blocked',verified:false,required_action:'refuse',code:'payee_blocked',explain_zh:'这个地址已被拉黑，不能付款。',explain_en:'This address is blocked. Do not pay it.'};
  if(trusted||exact)return {...out,status:'verified',verified:true,match:exact?{label:exact.label??null,kind:exact.kind,...(exact.viaAi?{viaAi:true}:{})}:{label:null,kind:'trust_list'},lookalikes:[],required_action:'none',
    explain_zh:'收款地址已核实（与你信任或付过款的地址完全一致）。',explain_en:'Payee verified: the full address exactly matches one you trust or paid before.'};
  const looks=known.filter(k=>isLookalike(A,k.address)).map(k=>({address:k.address,groups:groups4(k.address),label:k.label??null,kind:k.kind,diffGroups:diffGroups(A,k.address)}));
  if(looks.length)return {...out,status:'lookalike',verified:false,lookalikes:looks,required_action:'phone_face_id',code:'LOOKALIKE_NEEDS_PHONE',
    explain_zh:'未核实：这个地址和你认识的一个地址开头结尾一样、中间不同，很可能是假地址。没有付款。如果确实要付，请在手机 Kipurse 里用 Face ID 批准。',
    explain_en:'Not verified: this address looks like one you know (same start and end, different middle) and may be fake. Nothing was paid. To pay it anyway, the owner must approve it in the Kipurse app with Face ID.'};
  const dust=ins.length>0&&ins.every(t=>!t.usdc||BigInt(t.amount??0)<DUST_ATOMIC);
  if(dust)return {...out,status:'dust_only',verified:false,lookalikes:[],required_action:'phone_face_id',code:'DUST_ORIGIN',
    explain_zh:'未核实：这个地址只给你转过几分钱以下的零碎小额，常见于骗子"投毒"。没有付款。如果确实要付，请在手机 Kipurse 里用 Face ID 批准。',
    explain_en:'Not verified: this address only ever sent you tiny amounts (a common scam trick). Nothing was paid. To pay it anyway, the owner must approve it in the Kipurse app with Face ID.'};
  return {...out,status:'new',verified:false,lookalikes:[],required_action:'none',
    explain_zh:'未核实：这是一个新地址，以前没付过。会按你给陌生收款方设的限额处理。',explain_en:'Not verified: a new address you have not paid before. Your limits for unknown payees apply.'};
}
