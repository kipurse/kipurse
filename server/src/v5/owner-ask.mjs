// SPDX-License-Identifier: AGPL-3.0-only
// t1170u (handbook §6#82, locked): a NEW payee (not established by the owner) whose amount is above any AI auto limit is not simply
// refused: the AI gets decision ask_owner + a ready-to-relay zh/en question, the owner gets a push + an in-app card with
// 「认识并信任」「只付这一次」「拒绝」. Only the owner's in-app tap + Face ID releases the payment (the AI can never release it); the server
// then pays this exact request once, with the owner's on-chain approval, under a derived idempotency key. Valid 24 h.
// Same request again (same agent + idempotency key) -> the stored state / result, never a second payment.
import {fmtUsdc} from './mandates.mjs';
import {getAddress} from 'viem';import {createHash} from 'node:crypto';
export const ASK_TTL_MS=86400e3;
const short=a=>{let s=String(a??'');try{s=getAddress(s);}catch{}return s.length>12?s.slice(0,6)+'…'+s.slice(-4):s;};
const cleanName=s=>String(s??'').replace(/[\u0000-\u001f<>]/g,' ').trim().slice(0,40)||null;
/** the derived key the server pays with after the owner's approval (the AI's own key may hold a stored refusal) */
export const ownerKey=(approvalId)=>'owner-ask:'+String(approvalId);

export function createOwnerAsks({db,now=()=>Date.now(),ttlMs=ASK_TTL_MS}={}){
  db.exec(`CREATE TABLE IF NOT EXISTS owner_ask(approval_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, idem TEXT, spec_json TEXT NOT NULL, payee TEXT NOT NULL, amount TEXT NOT NULL, name TEXT, note TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, mode TEXT, result_json TEXT, reminded_at INTEGER, decided_at INTEGER);
    CREATE TABLE IF NOT EXISTS owner_ask_key(agent_id TEXT NOT NULL, idem TEXT NOT NULL, approval_id TEXT NOT NULL, PRIMARY KEY(agent_id,idem));
    CREATE TABLE IF NOT EXISTS owner_ask_req(agent_id TEXT NOT NULL, idem TEXT NOT NULL, req_hash TEXT NOT NULL, PRIMARY KEY(agent_id,idem));`);
  /* t1259 (§6#129): a merchant order with its own expiry (expiresAt, unix s or ms) can't be paid after it -> the ask expires then too */
  /* t1260 (§6#130): also a merchant-SIGNED order's own deadline (signedOrder.deadline / orderDeadline, directly or inside payment / request).
     The earliest one counts. ownerApproval (the AI's own approval window) is never read. */
  const ms=v=>{const x=Number(v);return x>0?(x>1e12?x:x*1000):null;};
  const orderEnd=a=>{const so=[a?.signedOrder,a?.payment?.signedOrder,a?.request?.signedOrder,typeof a?.payment==='object'?a.payment:null];
    const c=[ms(a?.expiresAt),ms(a?.payment?.expiresAt),...so.flatMap(x=>x&&typeof x==='object'?[ms(x.deadline),ms(x.orderDeadline)]:[])].filter(v=>v!=null);return c.length?Math.min(...c):null;};
  const orderGone=r=>{try{const end=orderEnd(JSON.parse(r.spec_json)?.args);return end!=null&&now()>end;}catch{return false;}};
  const row=r=>{if(!r)return null;let st=r.state;if(st==='pending'&&(now()>r.expires_at||orderGone(r))){db.prepare(`UPDATE owner_ask SET state='expired' WHERE approval_id=? AND state='pending'`).run(r.approval_id);st='expired';}
    return {approvalId:r.approval_id,agentId:r.agent_id,idem:r.idem,spec:JSON.parse(r.spec_json),payee:r.payee,amount:r.amount,name:r.name,note:r.note,createdAt:r.created_at,expiresAt:r.expires_at,state:st,mode:r.mode,result:r.result_json?JSON.parse(r.result_json):null,remindedAt:r.reminded_at,decidedAt:r.decided_at};};
  const get=id=>row(db.prepare(`SELECT * FROM owner_ask WHERE approval_id=?`).get(String(id??'')));
  /** one record per approvalId (the mandates dedupe returns the same id for the same payee+amount+purpose); every agent key maps to it */
  /* t1264: an existing record for this id that is no longer pending (expired / rejected / paid / failed) is never reused for a new
     request: put answers {stale:true} and the caller makes a fresh proposal (new approval id). reqHash = the AI request this key belongs to. */
  function put({approvalId,agentId,idem,spec,payee,amount,name,note,reqHash}){const t=now();
    {const ex=get(approvalId);if(ex&&ex.state!=='pending')return {...ex,stale:true};}
    db.prepare(`INSERT OR IGNORE INTO owner_ask(approval_id,agent_id,idem,spec_json,payee,amount,name,note,created_at,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,'pending')`)
      .run(String(approvalId),String(agentId),idem??null,JSON.stringify(spec),String(payee).toLowerCase(),String(amount),cleanName(name),note?String(note).slice(0,80):null,t,t+ttlMs);
    if(idem){db.prepare(`INSERT OR IGNORE INTO owner_ask_key VALUES(?,?,?)`).run(String(agentId),String(idem),String(approvalId));
      if(reqHash)db.prepare(`INSERT OR IGNORE INTO owner_ask_req VALUES(?,?,?)`).run(String(agentId),String(idem),String(reqHash));}
    return get(approvalId);}
  const byKey=(agentId,idem)=>{if(!idem)return null;const k=db.prepare(`SELECT approval_id FROM owner_ask_key WHERE agent_id=? AND idem=?`).get(String(agentId),String(idem));return k?get(k.approval_id):null;};
  /** t1264: the request fingerprint stored with this agent key (null when none was recorded) */
  const reqOf=(agentId,idem)=>{try{return db.prepare(`SELECT req_hash FROM owner_ask_req WHERE agent_id=? AND idem=?`).get(String(agentId),String(idem))?.req_hash??null;}catch{return null;}};
  /** t1264: the payment of an executing ask has a known intermediate result (e.g. sent, confirmation not seen yet): stored, the ask stays executing */
  const note=(id,result)=>{db.prepare(`UPDATE owner_ask SET result_json=? WHERE approval_id=? AND state='executing'`).run(JSON.stringify(result??null),String(id));return get(id);};
  /** t1264: asks the server was paying when it stopped (restart reconcile) */
  const executing=()=>db.prepare(`SELECT approval_id FROM owner_ask WHERE state='executing'`).all().map(x=>get(x.approval_id)).filter(Boolean);
  /** t1264: finished trust asks whose background trust never reported back (restart reconcile) */
  const trustOpen=()=>db.prepare(`SELECT approval_id FROM owner_ask WHERE mode='trust' AND state IN ('paid','failed') AND result_json LIKE '%"trust":{"state":"submitting"%'`).all().map(x=>get(x.approval_id)).filter(Boolean);
  /** exactly one executor: pending -> executing (atomic); a second approval gets false */
  const claim=(id,mode)=>{const x=db.prepare(`UPDATE owner_ask SET state='executing',mode=?,decided_at=? WHERE approval_id=? AND state='pending' AND expires_at>=?`).run(String(mode),now(),String(id),now());return x.changes===1;};
  const finish=(id,state,result)=>{db.prepare(`UPDATE owner_ask SET state=?,result_json=? WHERE approval_id=? AND state='executing'`).run(String(state),JSON.stringify(result??null),String(id));return get(id);};
  /** t1259: the request can no longer be paid (order expired / gone) -> close it; nothing was paid */
  const expire=id=>{const x=db.prepare(`UPDATE owner_ask SET state='expired',decided_at=? WHERE approval_id=? AND state='pending'`).run(now(),String(id));return x.changes===1;};
  const reject=id=>{const x=db.prepare(`UPDATE owner_ask SET state='rejected',decided_at=? WHERE approval_id=? AND state='pending'`).run(now(),String(id));return x.changes===1;};
  /** the AI may ask the server to push the card again: at most once per 5 minutes, only while pending */
  const remind=(id,agentId,gapMs=300e3)=>{const a=get(id);if(!a||a.agentId!==String(agentId))return {ok:false,error:'not_found'};if(a.state!=='pending')return {ok:false,error:'not_pending',state:a.state};
    if(a.remindedAt&&now()-a.remindedAt<gapMs)return {ok:false,error:'too_soon',retryAfterSec:Math.ceil((gapMs-(now()-a.remindedAt))/1000)};
    db.prepare(`UPDATE owner_ask SET reminded_at=? WHERE approval_id=?`).run(now(),a.approvalId);return {ok:true,ask:a};};
  /* t1243 §6#113: the background trust's final result, written into the finished ask's result (never changes its state / payment) */
  const setTrust=(id,trust)=>{const a=get(id);if(!a||!['paid','failed'].includes(a.state))return null;const r={...(a.result??{}),trust:trust??null};
    db.prepare(`UPDATE owner_ask SET result_json=? WHERE approval_id=? AND state IN ('paid','failed')`).run(JSON.stringify(r),String(id));return get(id);};
  /* t1243: trust answers of the last hour (the app shows "trust taking effect" -> trusted / failed) */
  const recentTrust=(ms=3600e3)=>db.prepare(`SELECT approval_id FROM owner_ask WHERE mode='trust' AND state IN ('paid','failed','executing') AND decided_at>=? ORDER BY decided_at DESC LIMIT 20`).all(now()-ms)
    .map(x=>get(x.approval_id)).filter(Boolean).map(a=>({id:a.approvalId,state:a.state,trust:a.result?.trust?{state:a.result.trust.state??null,merchant:a.result.trust.merchant??null,signerGrant:a.result.trust.signerGrant??null,txHash:a.result.trust.txHash??null}:{state:'submitting'}}));
  return {get,put,byKey,reqOf,claim,finish,note,executing,trustOpen,setTrust,recentTrust,reject,expire,remind,ttlMs};}

/** the ready-to-relay owner question (zh + en): payee name, short address, human USDC amount (§6#80), purpose */
export function askQuestion({name,payee,amountAtomic,note}){const amt=fmtUsdc(BigInt(amountAtomic));const nm=cleanName(name);const sh=short(payee);
  const zh=`认识这个收款方吗？AI 想付 ${amt} USDC 给新收款方 ${sh}（用途：${note||'未说明'}）${nm?`，AI 说它是“${nm}”（未核实）`:''}。这笔超过了 AI 自动付款上限，还没有付；AI 可能被骗。如果认识，请在 Kipurse App 里核对完整地址，点「认识并信任」或「只付这一次」并用 Face ID 确认；不认识就点「拒绝」。`;
  const en=`Do you know this payee? The AI wants to pay ${amt} USDC to a new payee ${sh} (for: ${note||'not stated'})${nm?`; the AI calls it "${nm}" (not verified)`:''}. It is above the AI auto-pay limit and nothing has been paid; the AI could be tricked. If you know them, check the full address in the Kipurse app and tap "Trust this payee" or "Pay just this once" with Face ID; otherwise tap "Decline".`;
  return {zh,en};}

/** AI-facing view of an ask (same shape for kipurse_buy, kipurse_pay, /v1/pay, Siri, kipurse_approval_status). Amounts: decimal USDC + *Atomic. */
export function askView(a,{lang}={}){const q=askQuestion({name:a.name,payee:a.payee,amountAtomic:a.amount,note:a.note});const pick=(z,e)=>lang==='en'?e:lang==='zh'?z:z+' / '+e;
  const base={approvalId:a.approvalId,payee:a.payee,payeeShort:short(a.payee),payee_name:a.name??null,amount:fmtUsdc(BigInt(a.amount)),amountAtomic:String(a.amount),purpose_note:a.note??null,expiresAt:new Date(a.expiresAt).toISOString()};
  if(a.state==='pending')return {...base,decision:'ask_owner',state:'awaiting_owner_approval',nothingPaid:true,ask_owner_question:q,say_to_user:pick(q.zh,q.en),
    next_step:'relay_ask_owner_question_then_poll_kipurse_approval_status_with_approvalId (or retry the same idempotencyKey); the owner must tap in the Kipurse app with Face ID. Your relaying "yes / I know them" can NOT release the payment',
    fix:'Only the owner\'s tap + Face ID in the Kipurse app releases this payment. You may relay the question and call kipurse_remind_owner to push the card again.'};
  if(a.state==='executing'&&a.result?.state==='unknown')return {...base,decision:'wait',state:'unknown',nothingPaid:false,purchaseKey:a.result.purchaseKey??null,txHash:a.result.txHash??null,
    say_to_user:pick('你已批准，付款已经发出，但还没看到链上确认。不要再付一次；稍后再查状态。','You approved it and the payment was sent, but its confirmation has not been seen yet. Do not pay again; check the status later.'),
    next_step:'do_not_pay_again_poll_kipurse_approval_status_with_approvalId'};/* t1264: outcome unknown -> never "failed", never re-initiated */
  if(a.state==='executing')return {...base,decision:'ask_owner',state:'paying',nothingPaid:false,say_to_user:pick('你已批准，正在付款。','You approved it; paying now.'),next_step:'poll_kipurse_approval_status_with_approvalId'};
  if(a.state==='paid'){const r=a.result??{};const ts=a.mode==='trust'?String(r.trust?.state??'unknown'):null;/* t1243: the trust lands in the background after the payment */
    const tz=ts==='trusted'?'，并已加入信任名单':ts==='submitting'?'，信任正在生效':ts?'，但信任没有生效（下次还会问你）':'，只付这一次',te=ts==='trusted'?' and trusted this payee':ts==='submitting'?'; the trust is taking effect':ts?'; the trust did not take effect (you will be asked again next time)':', just this once';
    return {...base,decision:'can_pay',state:'paid',mode:a.mode,trusted:a.mode==='trust'&&r.trust?.state==='trusted',...(ts?{trust_state:ts}:{}),purchaseKey:r.purchaseKey??null,txHash:r.txHash??null,
    say_to_user:pick(`已付 ${base.amount} USDC 给${a.name?`“${a.name}”`:'收款方'}（你已用 Face ID 批准${tz}）。`,`Paid ${base.amount} USDC to ${a.name?`"${a.name}"`:'the payee'} (you approved it with Face ID${te}).`),next_step:'done'};}
  if(a.state==='failed'){const r=a.result??{};return {...base,decision:'refuse',state:'failed',nothingPaid:r.nothingPaid!==false,reason:r.reason??'payment_failed',say_to_user:pick('你批准了，但这笔没付成：'+(r.reason??'出了点问题')+'。没有扣钱的话可以重新发起。','You approved it, but the payment failed: '+(r.reason??'error')+'.'),next_step:'tell_user'};}
  if(a.state==='rejected')return {...base,decision:'refuse',state:'rejected',nothingPaid:true,reason:'OWNER_DECLINED',say_to_user:pick('你拒绝了这笔付款，没有付。','You declined this payment; nothing was paid.'),next_step:'stop_do_not_retry'};
  return {...base,decision:'refuse',state:'expired',nothingPaid:true,reason:'ASK_EXPIRED',say_to_user:pick('这个付款请求 24 小时内没有批准，已过期，没有付。','The request was not approved within 24 hours; it expired and nothing was paid.'),next_step:'ask_user_then_new_request_new_idempotencyKey'};}

/** over the wallet total limit: no approvable card (the owner raises the wallet limit in the app first) */
export function overWalletView({payee,amountAtomic,name,reason}){const amt=fmtUsdc(BigInt(amountAtomic));
  const zh=`没有付款：${amt} USDC 超过了钱包总限额，不能批准。请先在 Kipurse App 里调高钱包总限额，再让 AI 重新发起。`;
  const en=`Not paid: ${amt} USDC is above the wallet's total limit, so it cannot be approved. Raise the wallet limit in the Kipurse app first, then ask the AI again.`;
  return {decision:'refuse',state:'rejected',reason:'OVER_WALLET_LIMIT',walletReason:reason??null,nothingPaid:true,payee,payee_name:cleanName(name),amount:amt,amountAtomic:String(amountAtomic),say_to_user:zh+' / '+en,say_to_owner:{zh,en},next_step:'tell_owner_raise_wallet_limit_in_app'};}

/**
 * Shared AI flow (kipurse_buy, kipurse_pay, /v1/pay, Siri). Call `lookup` before paying (same agent + key -> stored answer, no payment);
 * call `convert` with the engine's refusal: a new payee above an AI auto limit becomes an owner ask (or OVER_WALLET_LIMIT); anything else is returned unchanged.
 * spec = {kind:'payAny'|'pay', args} - exactly what the server re-executes after the owner's Face ID (with the owner's on-chain approval).
 */
/** t1264: fingerprint of what the AI asked to pay under one idempotency key (payee / amount / order reference fields only; never secrets;
 *  not merchantPurchaseId: a merchant-order retry may carry a fresh one, the merchant's order response decides that order) */
export function askReqHash(a){if(!a||typeof a!=='object')return null;const pick={};for(const k of ['to','amount','payment','orderRef','origin','url','payee_name','escrowFor'])if(a[k]!==undefined&&a[k]!==null)pick[k]=a[k];
  if(!Object.keys(pick).length)return null;return createHash('sha256').update(JSON.stringify(pick,(k,v)=>typeof v==='bigint'?v.toString():typeof v==='string'&&/^0x[0-9a-fA-F]{40}$/.test(v)?v.toLowerCase():v)).digest('hex');}
export function createAskFlow(E){const ASK=E.ownerAsks;
  /* t1264: a key whose ask belongs to ANOTHER request (same agent + key, different payee / amount / order) never answers with that ask (never 'paid') */
  const lookup=(agentId,idem,{lang,req}={})=>{if(!ASK||!idem)return null;const a=ASK.byKey(agentId,idem);if(!a)return null;
    const h=req?askReqHash(req):null,was=h?ASK.reqOf?.(agentId,idem):null;
    if(h&&was&&h!==was)return {decision:'refuse',state:'rejected',reason:'idempotency_key_reused_with_different_request',nothingPaid:true,next_step:'use_a_new_idempotencyKey_for_a_new_request',
      say_to_user:lang==='en'?'Not paid: this idempotency key belongs to another payment request.':'没有付款：这个幂等键属于另一笔付款请求。/ Not paid: this idempotency key belongs to another payment request.'};
    return askView(a,{lang});};
  async function convert(r,{agentId,idem,spec,name,note,purpose,lang,req}){
    if(!ASK||!r||r.state!=='rejected'||!spec)return null;
    /* a stopped AI / a paused wallet / a payee that failed checks is a hard refusal: never turned into an owner ask */
    if(/^(AGENT_STOPPED|wallet_paused|agent_stopped|SANCTION|payee_)/i.test(String(r.reason??''))||r.paused)return null;
    const c=await E.ownerAskClass(spec,{agentId,refusal:r}).catch(()=>null);if(!c?.ok||!(c.newPayee||c.onchainTierCap))return null;/* t1212 §6#97: or a known payee above an on-chain payee cap */
    if(c.overWallet)return overWalletView({payee:c.payee,amountAtomic:c.amount,name,reason:c.walletReason});
    if(!c.overAuto)return null;/* within every auto limit: the existing one-time approval flow stays as it is */
    const nm=cleanName(name)??null;const nt=note?String(note).replace(/[\u0000-\u001f]/g,' ').trim().slice(0,80):null;
    /* t1264: the dedupe key names the ORDER too (the request's purchase identity: payee + amount + merchant reference), so two different orders
       of the same payee / amount / purpose never merge into one card; without a reference the agent's own key keeps them apart */
    const ref=c.purchaseKey?'pk:'+c.purchaseKey:'key:'+String(agentId)+':'+String(idem??'');
    const dd=['ask',String(c.payee).toLowerCase(),String(c.amount),purpose??'daily',ref].join('|');
    const mkProp=()=>E.mandates.propose({items:[{purpose:purpose??'daily',single:fmtUsdc(BigInt(c.amount)),oneOff:{payee:c.payee,host:null,remember:false,ask:true,aiName:nm,note:nt}}],by:'agent:'+agentId,
      reason:'ask_owner: '+String(r.reason??'').slice(0,60)+(nt?' · '+nt:''),user_request:nt??'',dedupe:dd});
    let pr;try{pr=mkProp();}catch(e){return {...r,decision:'refuse',reason:e?.code??'ask_failed',nothingPaid:true};}
    const reqHash=req?askReqHash(req):null;
    let a=ASK.put({approvalId:pr.id,agentId,idem,spec,payee:c.payee,amount:c.amount,name:nm,note:nt,reqHash});
    if(a?.stale){/* t1264: that card is no longer pending (expired / declined / handled): close its proposal and open a fresh one */
      try{E.mandates.expire?.(pr.id);}catch{}
      try{pr=mkProp();}catch(e){return {...r,decision:'refuse',reason:e?.code??'ask_failed',nothingPaid:true};}
      a=ASK.put({approvalId:pr.id,agentId,idem,spec,payee:c.payee,amount:c.amount,name:nm,note:nt,reqHash});
      if(!a||a.stale)return {...r,decision:'refuse',reason:'ask_failed',nothingPaid:true};}
    try{E.logObs?.('owner_ask',{created:!pr.idempotent,reason:String(r.reason??'').slice(0,40)});}catch{}
    return askView(a,{lang});}
  return {lookup,convert};}
