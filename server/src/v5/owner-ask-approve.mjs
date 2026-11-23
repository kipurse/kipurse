// SPDX-License-Identifier: AGPL-3.0-only
// t1170u (handbook §6#82): the owner's answer to an owner ask ("do you know this payee?"), from the app card only (phone session).
//   prepare {id, mode}  -> what the phone signs, each part re-computed and checked ON THE PHONE before Face ID:
//       sign  : the card text + mode (sha256, the existing mandate format plus "\nmode:<trust|once>")
//       pay   : wallet.replaySafeHash(adapter.approvalDigest(purchaseKey, payee, amount, deadline)) - the owner's on-chain approval
//       trust : (mode trust) the OwnerTrust message for this payee, caps = the owner's AI everyday limits (single / daily), capped by
//               the wallet limits, 90 days
//   approve {id, mode, r, s, pay:{r,s}, trust:{r,s}} -> ONE Face ID on the phone made all signatures. The server verifies every one,
//       marks the card approved (a second approval -> already handled), pays THIS request once (derived idempotency key) with the
//       owner's approval and stores the result for the AI; then (mode trust, t1243 §6#113) adds the trust in the background, after the payment.
// The AI can never call any of this (phone session + phone key signatures only).
import {phonePayWrapper} from './owner-pay.mjs';import {phoneTrustWrapper} from './phone-signer.mjs';import {ownerKey} from './owner-ask.mjs';import {TRUST_DEFAULTS} from './engine.mjs';
import {parseAbi,getAddress} from 'viem';import {withFeeHeadroom} from './abi.mjs';
const CBSW=parseAbi(['function replaySafeHash(bytes32 hash) view returns (bytes32)']);
const J=x=>JSON.parse(JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v));
const min=(...a)=>a.filter(x=>x!=null).reduce((m,x)=>x<m?x:m);
const short=a=>{const s=String(a??'');return s.slice(0,6)+'…'+s.slice(-4);};
/** t1258 (handbook 0A #10, §6#128): THE daily cap a trust carries on chain. V5.4 / V5.5 count amount + protocol fee against every
 *  daily cap, so the owner's daily limit gets fee headroom: withFeeHeadroom(daily, ppm) (ppm = the live fee, <= the 0.1% the owner signed).
 *  Used by the inline (kind 6) path here and mirrored by engine.trustRequest for stored trusts; the iOS check uses the same formula. */
export const MAX_FEE_PPM=1000n;
export const trustDailyCap=(daily,ppm)=>withFeeHeadroom(BigInt(daily),ppm==null?MAX_FEE_PPM:BigInt(ppm));
export function trustCapsFor({everyday,wallet,phone}){/* decision 1: follow the owner's AI everyday limits, capped by the wallet limits (and the phone ceiling) */
  const ev=everyday??{};const ws=wallet?.single!=null?BigInt(wallet.single):null,wd=wallet?.daily!=null?BigInt(wallet.daily):null;
  let single=ev.authorized&&ev.single!=null?BigInt(ev.single):TRUST_DEFAULTS.single,daily=ev.authorized&&ev.daily!=null?BigInt(ev.daily):TRUST_DEFAULTS.daily;
  single=min(single,ws,phone?.maxSingle!=null?BigInt(phone.maxSingle):null);daily=min(daily,wd);if(single>daily)single=daily;
  return {single,daily,days:TRUST_DEFAULTS.days,source:ev.authorized?'everyday':'defaults'};}
export function createOwnerAskApproval({engine,phone,pub,wallet,everyday,walletCaps,trustOwner,verifyWrapped,p256Verify,signerGrant=null,inlineTrust=null,onGrantStored=()=>{},afterPaid=()=>{},log=()=>{},now=()=>Date.now(),prepTtlMs=540e3,reconcileOnStart=true,trustStaleMs=15*60e3}){
  const ASK=()=>engine.ownerAsks,M=()=>engine.mandates;const prepared=new Map();const trustJobs=new Map();
  const gc=()=>{for(const [k,v] of prepared)if(now()-v.at>prepTtlMs)prepared.delete(k);};
  const TO=()=>{const o=trustOwner?.();return o?{approve:id=>o.api.approve(o.cap,id),submit:(id,w)=>o.api.submitSignature(o.cap,id,w,{prewrapped:true}),reject:id=>o.api.reject(o.cap,id),list:()=>o.api.list(o.cap)}:null;};
  /* t1259 (§6#129): the request can no longer be paid (the merchant order expired / is gone): closed, nothing paid, the AI must order again */
  const GONE=code=>({error:'request_gone',code,state:'expired',nothingPaid:true,detail:'这笔付款请求已经过期或不能再付（比如商家订单超过了有效期），已经从列表移除，没有付款。请让 AI 重新下单。 / This payment request expired or can no longer be paid (for example the merchant order timed out). It was removed; nothing was paid. Ask the AI to order again.'});
  const dropTrust=c=>{if(c?.trust?.id){try{TO()?.reject(c.trust.id);}catch{}}};
  async function prepare(b){gc();const id=String(b?.id??''),mode=String(b?.mode??'');if(!['trust','once'].includes(mode))return [400,{error:'bad_mode'}];
    const a=ASK().get(id);if(!a)return [404,{error:'unknown_ask'}];if(a.state==='expired'){try{M().expire?.(id);}catch{}return [410,GONE('order_expired')];}if(a.state!=='pending')return [409,{error:'already_handled',state:a.state}];
    const pv=M().getProposal(id);const md=pv?.ask?.modes?.[mode];if(!pv||pv.state!=='pending'||!md)return [409,{error:'already_handled',state:pv?.state??null}];
    const cap=await phone.payCapable();if(!cap?.ok)return [409,{error:cap?.code??'no_phone_signer'}];
    const ar=await engine.ownerAskApproval(a.spec,{windowSec:600});if(!ar?.ok){try{ASK().expire?.(id);M().expire?.(id);}catch{}log('owner_ask_gone',{code:ar?.code??'not_payable'});return [410,GONE(ar?.code??'not_payable')];}   // t1259 §6#129: close it, nothing paid
    if(lcEq(ar.payee,a.payee)===false||String(ar.amount)!==String(a.amount))return [409,{error:'request_changed'}];
    if(cap.active.maxSingle!=null&&BigInt(ar.amount)>BigInt(cap.active.maxSingle))return [409,{error:'above_phone_ceiling',detail:'这笔超过了手机快速批准的上限，请先在 App 里调高钱包限额 / This is above the phone approval ceiling.'}];
    const digest=await pub.readContract({address:wallet,abi:CBSW,functionName:'replaySafeHash',args:[ar.digest]});
    const old=prepared.get(id);if(old)dropTrust(old);
    const c={mode,at:now(),fingerprint:cap.active.fingerprint,pay:{digest,approvalDigest:ar.digest,purchaseKey:ar.onchainPurchaseKey,payee:getAddress(ar.payee),amount:String(ar.amount),deadline:String(ar.deadline)},trust:null};
    if(mode==='trust'){const t=TO();if(!t&&!inlineTrust)return [409,{error:'trust_not_configured'}];
      const caps=trustCapsFor({everyday:everyday?.(),wallet:walletCaps?.(),phone:cap.active});if(caps.single<=0n||caps.daily<=0n)return [409,{error:'no_limits',detail:'先在 App 里设好 AI 日常额度 / Set the AI everyday limits first.'}];
      /* t1240 §6#110: the merchant's order signer, verified by the engine from its signed order + the signer it publishes on its own origin
         (never from the AI). With it, ONE "trust" names the merchant (its domain) + that signer, and the same Face ID signs the V5.4 grant
         (kind 5) so later orders with a fresh deposit address are paid within these caps. Without it: exactly as before (this payee only). */
      const sgn=signerGrant&&/^0x[0-9a-fA-F]{40}$/.test(String(a.spec?.signer??''))&&/^[a-z0-9.-]{3,80}$/.test(String(a.spec?.signerMerchant??''))?getAddress(String(a.spec.signer).toLowerCase()):null;
      const name=sgn?String(a.spec.signerMerchant):`${(a.name??'payee').replace(/[^\p{L}\p{N} ._-]/gu,'').slice(0,30)||'payee'} ${short(a.payee)}`;
      /* t1250 (V5.5 + flag only; inlineTrust is null otherwise): no order signer -> "approve & remember" is a seat-V2 kind-6 OwnerInlineTrust (KPTR):
         no transaction, the blob rides along with later payments and the adapter re-checks it every time. expiry = deadline (the phone's reusable rule). */
      if(inlineTrust&&!sgn){let it;try{const S2=await import('./seat-v2.mjs');const {randomBytes}=await import('node:crypto');
          let ppm=MAX_FEE_PPM;try{const v=await inlineTrust.feePpm?.();if(v!=null&&BigInt(v)>=0n&&BigInt(v)<=MAX_FEE_PPM)ppm=BigInt(v);}catch{}   // t1258: live fee, never above the owner's 0.1%
          const dailyCap=trustDailyCap(caps.daily,ppm);
          it=S2.inlineAskTrust({wallet,payee:a.payee,name,single:caps.single,daily:dailyCap,days:caps.days,epoch:await inlineTrust.epochOf(S2.merchantIdOf(name)),nonce:'0x'+randomBytes(32).toString('hex'),nowS:await inlineTrust.nowS()});}
        catch(e){return [409,{error:e?.code??'inline_trust_failed'}];}
        if(BigInt(it.trust.single)>BigInt(cap.active.maxSingle??it.trust.single)||BigInt(it.trust.daily)>BigInt(cap.active.maxDaily??it.trust.daily))return [409,{error:'above_phone_ceiling'}];
        c.trust={inline:true,kind:6,primaryType:'OwnerInlineTrust',inner:{message:it.message,domain:it.typedData.domain},trust:it.trust,deadline:String(it.deadline),digest:it.digest,single:caps.single.toString(),daily:it.trust.daily.toString(),days:caps.days,grant:null,merchant:null,signer:null,attested:false,merchantSigned:null,name};}
      else{if(!t)return [409,{error:'trust_not_configured'}];
      try{for(const r of (t.list()?.pending??[]))if(lcEq(r.payee,a.payee)&&(String(r.single)!==caps.single.toString()||String(r.total)!==caps.daily.toString()))t.reject(r.id);}catch{}
      let tr;try{tr=engine.requestTrustFromOwner?await engine.requestTrustFromOwner({agentId:'owner-ask:'+a.agentId,merchantName:name,payee:a.payee,...(sgn?{signers:[sgn]}:{}),single:caps.single.toString(),total:caps.daily.toString(),expiresInDays:caps.days,reason:'owner tapped "trust" on ask '+id}):null;}catch(e){return [409,{error:e?.code??'trust_request_failed'}];}
      if(!tr?.id)return [409,{error:'trust_request_failed'}];
      let ap;try{ap=await t.approve(tr.id);}catch(e){return [409,{error:e?.code??'trust_prepare_failed'}];}if(!ap?.innerTypedData)return [409,{error:'trust_not_supported'}];
      const msg=ap.innerTypedData.message;if(BigInt(msg.single)>BigInt(cap.active.maxSingle??msg.single)||BigInt(msg.daily)>BigInt(cap.active.maxDaily??msg.daily)){try{t.reject(tr.id);}catch{}return [409,{error:'above_phone_ceiling'}];}
      let grant=null;if(sgn){if(!(msg.signers??[]).map(x=>String(x).toLowerCase()).includes(sgn.toLowerCase())){try{t.reject(tr.id);}catch{}return [409,{error:'trust_signer_missing'}];}
        try{grant=await signerGrant.fromTrust(msg);}catch{grant=null;}if(!grant){try{t.reject(tr.id);}catch{}return [409,{error:'signer_grant_unavailable'}];}}
      /* t1241 §6#111: the signer is Kipurse's attestor for this domain (attested) - the card shows whether the merchant itself signs (unsigned: half caps) */
      const att=!!sgn&&a.spec?.attested===true;
      c.trust={id:tr.id,inner:ap.innerTypedData,digest:ap.digest,single:caps.single.toString(),daily:caps.daily.toString(),days:caps.days,grant,merchant:sgn?name:null,signer:sgn,attested:att,merchantSigned:att?a.spec?.merchantSigned===true:(sgn?true:null),...(inlineTrust?{kind:1,primaryType:'OwnerTrust'}:{})};}}
    prepared.set(id,c);log('owner_ask_prepare',{mode});
    return [200,J({id,mode,sign:{signText:md.signText,digest:md.digest},pay:{...c.pay,wallet,chainId:8453,fee:String(ar.fee??'0'),maxNetworkFee:String(ar.maxNetworkFee??'0')},
      ...(c.trust?{trust:{...(c.trust.kind?{kind:c.trust.kind,primaryType:c.trust.primaryType}:{}),id:c.trust.id??null,message:c.trust.inner.message,domain:c.trust.inner.domain,digest:c.trust.digest,single:c.trust.single,daily:c.trust.daily,days:c.trust.days,...(c.trust.grant?{signerGrant:{message:c.trust.grant.message,digest:c.trust.grant.digest},merchant:c.trust.merchant,signer:c.trust.signer,attested:c.trust.attested,merchantSigned:c.trust.merchantSigned,...(c.trust.attested&&!c.trust.merchantSigned?{autoPayShare:'half'}:{})}:{}),phone:{maxSingle:String(cap.active.maxSingle??''),maxDaily:String(cap.active.maxDaily??'')}}}:{}),
      ask:{payee:a.payee,amount:a.amount,name:a.name,note:a.note,expiresAt:a.expiresAt}})];}
  const lcEq=(x,y)=>String(x??'').toLowerCase()===String(y??'').toLowerCase();
  async function approve(b){gc();const id=String(b?.id??''),mode=String(b?.mode??'');const a=ASK().get(id);if(!a)return [404,{error:'unknown_ask'}];
    if(a.state!=='pending')return [409,{error:'already_handled',state:a.state}];
    const c=prepared.get(id);if(!c||c.mode!==mode)return [409,{error:'prepare_first'}];
    const act=phone.active();if(!act)return [409,{error:'no_phone_signer'}];const cap=await phone.payCapable();if(!cap?.ok)return [409,{error:cap?.code??'no_phone_signer'}];
    if(cap.active.fingerprint!==c.fingerprint)return [409,{error:'phone_changed'}];
    let ok=false;try{ok=p256Verify(cap.active,c.pay.digest,String(b?.pay?.r??''),String(b?.pay?.s??''));}catch{ok=false;}if(!ok)return [403,{error:'not_owner',part:'pay'}];
    let tw=null,gw=null;if(mode==='trust'){if(!c.trust)return [409,{error:'prepare_first'}];let idx=act.index;if(idx==null&&phone.findIndex){try{idx=await phone.findIndex(act.approver);}catch{idx=null;}}if(idx==null||Number(idx)<0)return [409,{error:'phone_not_owner'}];
      try{tw=c.trust.kind?(await import('./seat-v2.mjs')).trustWrapperV55(idx,c.trust.inner.message,String(b?.trust?.r??''),String(b?.trust?.s??'')).wrapper:phoneTrustWrapper(idx,c.trust.inner.message,String(b?.trust?.r??''),String(b?.trust?.s??''));}catch{return [400,{error:'bad_signature',part:'trust'}];}   // t1250: V5.5 seat V2 (kind 6 inline / kind 1 stored)
      let tok=false;try{tok=await verifyWrapped(c.trust.digest,tw);}catch{tok=false;}if(!tok)return [403,{error:'not_owner',part:'trust'}];
      if(c.trust.grant){/* t1240: the grant is for the epoch AFTER the trust lands, so the wallet cannot accept it yet: check the phone key's signature
          over the wallet's replay-safe hash now (exactly what the seat verifies), and the wallet's own check after the trust lands, before storing */
        let gok=false;try{const rs=await pub.readContract({address:wallet,abi:CBSW,functionName:'replaySafeHash',args:[c.trust.grant.digest]});gok=p256Verify(cap.active,rs,String(b?.trust?.signerGrant?.r??''),String(b?.trust?.signerGrant?.s??''));}catch{gok=false;}
        if(!gok)return [403,{error:'not_owner',part:'signer_grant'}];
        try{gw=signerGrant.wrapper(idx,c.trust.grant.message,String(b.trust.signerGrant.r),String(b.trust.signerGrant.s));}catch{return [400,{error:'bad_signature',part:'signer_grant'}];}}}
    // the card itself (text + mode) - a second approval of the same card answers not_pending / already_handled
    /* t1264: approving the card and claiming the ask (pending -> executing) commit together (one sqlite transaction): never one without the other */
    const r=M().approve(id,d=>{try{return p256Verify(act,d,String(b?.r??''),String(b?.s??''));}catch{return false;}},{mode,also:()=>ASK().claim(id,mode)});
    if(!r.ok)return [r.error==='not_owner'?403:409,r.error==='not_pending'?{error:'already_handled',state:r.state??null}:r];
    if(ASK().get(id)?.state!=='executing')return [409,{error:'already_handled'}];prepared.delete(id);
    /* t1243 §6#113: PAY FIRST (same derived idempotency key, same owner approval - every 0A#7 layer unchanged) and reply as soon as the
       payment result is known. The trust (and the V5.4 grant, verified on chain BEFORE it is stored) follows in the background, strictly
       AFTER the payment finished so the vault's userOps never overlap. Its final result is written to the ask record (approval status /
       /safety/mandates); a failure only means the next order asks again. */
    const trust0=mode==='trust'?{state:'submitting',single:c.trust.single,daily:c.trust.daily,days:c.trust.days,...(c.trust.merchant?{merchant:c.trust.merchant,merchantSigned:c.trust.merchantSigned}:{})}:null;
    /* t1264: persisted before paying, so a restart can finish this ask (engine.reconcileOwnerAsk) and its trust (reconcileTrusts) from the chain */
    const trustRec=trust0?{...trust0,payee:c.pay.payee,inline:!!c.trust.inline,requestId:c.trust.id??null,name:c.trust.name??a.name??null,startedAt:now()}:null;
    try{ASK().note?.(id,{state:'paying',purchaseKey:c.pay.purchaseKey??null,trust:trustRec});}catch{}
    if(trustJobs.size){try{await Promise.allSettled([...trustJobs.values()]);}catch{}}/* t1243: another card's background trust still holds the wallet: pay after it */
    let out;try{const signature=phonePayWrapper(cap.index,{purchaseKey:c.pay.purchaseKey,payee:c.pay.payee,amount:c.pay.amount,deadline:c.pay.deadline},String(b.pay.r),String(b.pay.s));
      out=await engine.payApprovedByOwner(a.spec,{agentId:a.agentId,idempotencyKey:ownerKey(id),ownerApproval:{signature,deadline:c.pay.deadline}});}
    catch(e){out={state:'failed',reason:String(e?.code??e?.message??'error').slice(0,80)};}
    const paid=['paid','already_paid','paid_by_other_agent','already_paid_on_chain'].includes(out?.state);
    /* t1264: sent but not confirmed (or a late-confirmed reservation): the outcome is UNKNOWN -> the ask stays executing with {state:'unknown'}
       (the AI is told not to start it again); engine.reconcileOwnerAsk settles it from the chain later. Never 'failed'. */
    const unknown=out?.state==='unknown'||out?.state==='prepared_unconfirmed'||(out?.state==='in_progress'&&!!out?.txHash);
    const res={state:unknown?'unknown':out?.state??null,reason:out?.reason??null,purchaseKey:out?.purchaseKey??null,txHash:out?.txHash??null,nothingPaid:paid||unknown?false:out?.nothingPaid!==false,trust:trustRec};
    const done=unknown?ASK().note(id,res):ASK().finish(id,paid?'paid':'failed',res);log('owner_ask_approve',{mode,paid,unknown,trust:trust0?.state??null});if(!unknown){try{afterPaid(id,done);}catch{}}
    /* t1264: the payee is remembered (owner_payee) only after the payment succeeded AND the trust took effect */
    const rememberIfDone=trust=>{if(paid&&trust?.state==='trusted'){try{M().remember?.(c.pay.payee,engine.nameOf?.(c.pay.payee)??a.name??c.trust?.name??null,null,null,id);}catch{}}};
    if(mode==='trust'){const job=(async()=>{let trust;
        if(c.trust.inline){try{const S2=await import('./seat-v2.mjs');const blob=S2.inlineTrustBlob({trust:c.trust.trust,nonce:c.trust.inner.message.nonce,deadline:c.trust.deadline,sig:tw,nowS:await inlineTrust.nowS()});
            await inlineTrust.store({payee:c.pay.payee,blob,merchant:c.trust.trust.merchant,name:c.trust.name,single:c.trust.single,daily:c.trust.daily,expiry:c.trust.deadline,epoch:String(c.trust.inner.message.epoch??'0')});/* t1264: epoch, so a later untrust makes it stale */
            trust={state:'trusted',inline:true,kind:6,single:c.trust.single,daily:c.trust.daily,days:c.trust.days,txHash:null};rememberIfDone(trust);}
          catch(e){trust={state:'failed',reason:String(e?.code??'inline_trust_failed').slice(0,60)};}
          try{ASK().setTrust?.(id,{...trustRec,...trust});}catch{}log('owner_ask_trust',{state:trust.state,inline:true});return trust;}
        try{const v=await (engine.withWalletTx?engine.withWalletTx(()=>TO().submit(c.trust.id,tw)):TO().submit(c.trust.id,tw));trust={state:v?.status==='trusted'?'trusted':String(v?.status??'unknown'),txHash:v?.txHash??null,single:c.trust.single,daily:c.trust.daily,days:c.trust.days};
          if(trust.state==='trusted'&&c.trust.grant&&gw){let wok=false;try{wok=await verifyWrapped(c.trust.grant.digest,gw);}catch{wok=false;}
            if(!wok)trust.signerGrant='not_accepted';else{try{signerGrant.store(c.trust.grant.message,gw);trust.merchant=c.trust.merchant;trust.signerGrant='stored';trust.merchantSigned=c.trust.merchantSigned;}catch{trust.signerGrant='store_failed';}
              if(trust.signerGrant==='stored'){try{await onGrantStored({merchant:c.trust.merchant,signer:c.trust.signer,attested:c.trust.attested});}catch{}}/* t1241: a fresh owner trust lifts an auto-pay pause of this domain */}}}
        catch(e){trust={state:'failed',reason:String(e?.code??'trust_failed').slice(0,60)};}
        rememberIfDone(trust);try{ASK().setTrust?.(id,{...trustRec,...trust});}catch{}
        log('owner_ask_trust',{state:trust.state,signerGrant:trust.signerGrant??null});
        if(trust.state!=='trusted'||(c.trust.grant&&trust.signerGrant!=='stored'))log('owner_ask_trust_failed',{state:trust.state,reason:trust.reason??null,signerGrant:trust.signerGrant??null});
        return trust;})().finally(()=>trustJobs.delete(id));
      trustJobs.set(id,job);}
    return [200,{ok:true,id,mode,state:paid?'paid':unknown?'unknown':'failed',...(unknown?{nothingPaid:false,detail:'sent; confirmation not seen yet — do not pay again; check status'}:{}),pay:{state:res.state,reason:res.reason,txHash:res.txHash,purchaseKey:res.purchaseKey},trust:trust0}];}
  /** t1243: the background trust of an approved ask (tests / shutdown); resolves to its final result, or null when none is running */
  const trustSettled=id=>trustJobs.get(String(id))??Promise.resolve(null);
  /** Face ID cancelled after prepare: drop the trust request it opened (the card stays pending) */
  function cancel(b){const id=String(b?.id??'');const c=prepared.get(id);if(c){dropTrust(c);prepared.delete(id);}return [200,{ok:true}];}
  function reject(id){const c=prepared.get(String(id));if(c){dropTrust(c);prepared.delete(String(id));}return ASK().reject(String(id));}
  /* t1264: a trust left 'submitting' when the server stopped (the background job and its signature lived in memory only) is settled from the
     chain: the payee routes as trusted now (stored trust: trustOf on chain; inline: the KV entry, epoch-checked) -> trusted (+ remembered if
     paid); otherwise, once trustStaleMs passed since the approval, failed (the next order asks again) and its open trust request is dropped. */
  async function reconcileTrusts(){const out=[];const asks=ASK()?.trustOpen?.()??[];
    for(const a of asks){if(trustJobs.has(a.approvalId))continue;const t=a.result?.trust??{};const payee=t.payee??a.payee;let live=null;
      try{live=await engine.payeeTrustState?.(payee);}catch{live=null;}
      if(live?.trusted&&(!t.inline||live.inline)){const tr={...t,state:'trusted',reconciled:true};ASK().setTrust?.(a.approvalId,tr);
        if(a.state==='paid'){try{M().remember?.(payee,engine.nameOf?.(payee)??a.name??t.name??null,null,null,a.approvalId);}catch{}}out.push({id:a.approvalId,trust:'trusted'});continue;}
      if(now()-Number(t.startedAt??a.decidedAt??0)>trustStaleMs){if(t.requestId){try{TO()?.reject(t.requestId);}catch{}}
        ASK().setTrust?.(a.approvalId,{...t,state:'failed',reason:'interrupted',reconciled:true});out.push({id:a.approvalId,trust:'failed'});continue;}
      out.push({id:a.approvalId,trust:'submitting'});}
    return out;}
  /** t1264: restart reconcile: asks left executing (engine) first, then their trusts */
  async function reconcile(){let asks=[];try{asks=(await engine.reconcileOwnerAsks?.())??[];}catch{}let trusts=[];try{trusts=await reconcileTrusts();}catch{}return {asks,trusts};}
  if(reconcileOnStart){const t=setTimeout(()=>{reconcile().catch(()=>{});},1500);t.unref?.();}
  return {prepare,approve,cancel,reject,trustSettled,reconcile,reconcileTrusts};}
