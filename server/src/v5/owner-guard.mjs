// SPDX-License-Identifier: AGPL-3.0-only
// Gateway-enforced owner rules (honest: NOT on chain): owner-set limits (tighten now / loosen only with owner approval, never above the
// on-chain caps), registered-address withdrawals (owner-approved, paid through the adapter: 0.1% + gas, count against the caps),
// deposits (Base native USDC; daily limit -> excess QUARANTINED, never bounced; source/amount/time/tx in the ledger; wrong tokens flagged).
// The owner credential (HMAC secret, 0600, its own file) is used only by the owner surface; agents never see it.
import fs from 'node:fs';import {plainStore} from './at-rest.mjs';import {createHash,randomUUID} from 'node:crypto';import {getAddress,isAddress} from 'viem';import {ownerMac} from './joint-trust.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');const B=v=>BigInt(v);const lc=s=>String(s??'').toLowerCase();
const USDC={8453:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',84532:'0x036CbD53842c5426634e7929541eC2318f3dCF7e'};
const macOk=(secret,msg,mac)=>typeof mac==='string'&&mac.length===64&&ownerMac(secret,msg)===mac;
export const LIMIT_KEYS=['unrecognizedPerPayment','unrecognizedPerDay','depositDailyLimit'];
export const changeMessage=c=>`kipurse-limits-loosen|${c.id}|${LIMIT_KEYS.map(k=>c.to[k]??'').join('|')}|${c.withdrawalAddress??''}`;
export const withdrawalMessage=w=>`kipurse-withdraw|${w.id}|${w.to}|${w.amount}`;
export const releaseMessage=id=>`kipurse-quarantine-release|${id}`;
export function createOwnerGuard({store=plainStore,dir,ownerSecret,chainId=8453,wallet,onchain,now=()=>Math.floor(Date.now()/1000)}){
  // onchain(): {single,daily,term,end,permissionHash} of the CURRENT on-chain permission
  if(!ownerSecret)throw Error('GUARD: owner secret required');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=dir+'/owner-guard.json',auditFile=dir+'/owner-guard-audit.jsonl';
  let S=store.readJson(file,null)??{limits:null,pendingActivation:null,changes:{},withdrawals:{},deposits:{},seen:{}};
  const save=()=>store.writeJson(file,S);
  let prev=(()=>{const l=store.readLines(auditFile).pop();return l?JSON.parse(l).hash:'genesis';})();
  const audit=(event,data)=>{const r={ts:now(),event,...data,prev};r.hash=sha(JSON.stringify(r));store.appendLine(auditFile,JSON.stringify(r));prev=r.hash;};
  const day=t=>Math.floor(t/86400);
  const capCheck=(l)=>{const oc=onchain();if(!oc)throw Error('GUARD: on-chain permission unknown');
    if(B(l.unrecognizedPerPayment)>B(oc.single)||B(l.unrecognizedPerDay)>B(oc.daily))throw Error('GUARD: limits can never exceed the on-chain caps (a higher cap needs a new owner signature)');
    if(B(l.unrecognizedPerPayment)>B(l.unrecognizedPerDay))throw Error('GUARD: per-payment must be <= per-day');for(const k of LIMIT_KEYS)if(!(B(l[k])>0n))throw Error('GUARD: '+k+' must be > 0');};
  const G={
    /** From the setup plan: stored as pending; becomes active only when that exact permission is valid on chain (the owner's signature). */
    stageFromPlan(plan){S.pendingActivation={permissionHash:plan.permissionHash,limits:{...plan.offchain}};save();audit('setup_staged',{permissionHash:plan.permissionHash,...plan.offchain});},
    activateIfSigned(){const p=S.pendingActivation,oc=onchain();if(!p||!oc||lc(oc.permissionHash)!==lc(p.permissionHash))return false;capCheck(p.limits);
      S.limits=p.limits;S.pendingActivation=null;save();audit('limits_activated_by_owner_signature',{permissionHash:p.permissionHash,...p.limits});return true;},
    limits(){return S.limits?{...S.limits}:null;},
    capsForTrust(){const l=S.limits,oc=onchain();if(!l||!oc)return null;return {mainSingle:oc.single,mainDaily:oc.daily,unrecognizedSingle:l.unrecognizedPerPayment,unrecognizedDaily:l.unrecognizedPerDay};},
    /** AGENT (kipurse_set_limits): tightening applies immediately; loosening (or a new withdrawal address) waits for the owner's tap. */
    setLimits(changes={},{agentId='agent'}={}){if(!S.limits)throw Error('GUARD: run kipurse_setup first');const cur=S.limits,tight={},loose={};
      for(const [k,v] of Object.entries(changes)){if(k==='withdrawalAddress'){if(!isAddress(String(v),{strict:false}))throw Error('GUARD: bad address');if(wallet&&lc(v)===lc(wallet))throw Error('GUARD: not the agent wallet');loose.withdrawalAddress=getAddress(lc(v));continue;}
        if(!LIMIT_KEYS.includes(k))throw Error('GUARD: unknown limit '+k);const x=B(v);if(!(x>0n))throw Error('GUARD: '+k+' must be > 0');(x<=B(cur[k])?tight:loose)[k]=x.toString();}
      const next={...cur,...tight};capCheck(next);let pending=null;
      if(Object.keys(tight).length){S.limits=next;audit('limits_tightened',{agentId,...tight});}
      if(Object.keys(loose).length){const to={...next,...Object.fromEntries(Object.entries(loose).filter(([k])=>k!=='withdrawalAddress'))};capCheck(to);
        pending={id:randomUUID(),to:Object.fromEntries(LIMIT_KEYS.map(k=>[k,to[k]])),withdrawalAddress:loose.withdrawalAddress??null,agentId,createdAt:now(),state:'pending'};S.changes[pending.id]=pending;audit('limits_loosen_requested',{id:pending.id,agentId,...loose});}
      save();return {applied:tight,pendingOwnerApproval:pending,limits:S.limits};},
    approveChange(id,mac){const c=S.changes[id];if(!c||c.state!=='pending')throw Error('GUARD: no pending change');if(!macOk(ownerSecret,changeMessage(c),mac))throw Error('GUARD: owner approval invalid');
      const to={...S.limits,...c.to};capCheck(to);S.limits={...to,...(c.withdrawalAddress?{withdrawalAddress:c.withdrawalAddress}:{})};c.state='approved';save();audit('limits_loosened_by_owner',{id,...c.to,withdrawalAddress:c.withdrawalAddress});return S.limits;},
    /** Withdrawals: only to the registered address; owner-approved; executed through the adapter (fee + gas, counts against the caps). */
    requestWithdrawal({amount,agentId='agent'}){if(!S.limits?.withdrawalAddress)throw Error('GUARD: no registered withdrawal address');const a=B(amount);if(!(a>0n))throw Error('GUARD: amount > 0');
      const w={id:randomUUID(),to:S.limits.withdrawalAddress,amount:a.toString(),agentId,createdAt:now(),state:'pending'};S.withdrawals[w.id]=w;save();audit('withdrawal_requested',{id:w.id,to:w.to,amount:w.amount,agentId});
      return {...w,note:'pending: the owner approves on the owner surface; costs 0.1% + gas and counts against the on-chain caps. The emergency direct exit (gas only, no caps) is always available in the owner wallet.'};},
    approveWithdrawal(id,mac){const w=S.withdrawals[id];if(!w||w.state!=='pending')throw Error('GUARD: no pending withdrawal');if(!macOk(ownerSecret,withdrawalMessage(w),mac))throw Error('GUARD: owner approval invalid');
      if(lc(w.to)!==lc(S.limits?.withdrawalAddress))throw Error('GUARD: registered address changed; request again');w.state='approved';save();audit('withdrawal_approved',{id});return w;},
    markWithdrawal(id,result){const w=S.withdrawals[id];if(!w)return;w.state=result.state==='paid'?'paid':'failed';w.txHash=result.txHash??null;save();audit('withdrawal_'+w.state,{id,txHash:w.txHash,reason:result.reason});},
    isApprovedWithdrawal(id,to,amount){const w=S.withdrawals[id];return !!w&&w.state==='approved'&&lc(w.to)===lc(to)&&B(w.amount)===B(amount);},
    /** Deposits: feed incoming Transfer logs (any token) to the wallet; idempotent by txHash:logIndex. */
    ingestDeposits(transfers){const out=[];for(const t of transfers){const k=`${lc(t.txHash)}:${t.logIndex}`;if(S.seen[k])continue;S.seen[k]=1;
      const usdc=lc(t.token)===lc(USDC[chainId]);const rec={id:k,txHash:t.txHash,logIndex:t.logIndex,from:getAddress(lc(t.from)),token:getAddress(lc(t.token)),amount:B(t.value).toString(),time:Number(t.time),block:String(t.block??'')};
      if(!usdc){rec.status='wrong_token';rec.flag='not Base native USDC: not usable by the wallet; the owner can move it out directly';}
      else{const lim=S.limits?B(S.limits.depositDailyLimit):0n;const d=day(rec.time);const used=Object.values(S.deposits).filter(x=>x.status!=='wrong_token'&&day(x.time)===d).reduce((s,x)=>s+B(x.accepted??0),0n);
        const room=lim>used?lim-used:0n;const acc=B(rec.amount)<room?B(rec.amount):room;rec.accepted=acc.toString();rec.quarantined=(B(rec.amount)-acc).toString();rec.status=B(rec.quarantined)>0n?(acc>0n?'partly_quarantined':'quarantined'):'accepted';
        if(!S.limits)rec.note='owner limits not set: everything quarantined until setup';}
      S.deposits[k]=rec;out.push(rec);audit('deposit',{id:k,from:rec.from,token:rec.token,amount:rec.amount,status:rec.status,quarantined:rec.quarantined??'0'});}
      save();return out;},
    quarantined(){return Object.values(S.deposits).reduce((s,x)=>s+B(x.quarantined??0),0n);},
    releaseQuarantine(id,mac){const r=S.deposits[id];if(!r||!(B(r.quarantined??0)>0n))throw Error('GUARD: nothing quarantined');if(!macOk(ownerSecret,releaseMessage(id),mac))throw Error('GUARD: owner approval invalid');
      audit('quarantine_released',{id,amount:r.quarantined});r.accepted=(B(r.accepted)+B(r.quarantined)).toString();r.quarantined='0';r.status='accepted_by_owner';save();return r;},
    /** Gateway check before any agent payment: quarantined funds are never spendable by agents. */
    spendable(balance){const q=G.quarantined();const b=B(balance);return b>q?b-q:0n;},
    deposits(){return Object.values(S.deposits).sort((a,b)=>a.time-b.time);},
    pending(){return {changes:Object.values(S.changes).filter(c=>c.state==='pending'),withdrawals:Object.values(S.withdrawals).filter(w=>w.state==='pending'||w.state==='approved')};},
    auditFile,
  };return G;}
/** Deposit instructions for agents/the owner: Base native USDC only, with QR (EIP-681) and warnings. */
export async function depositInfo({wallet,chainId=8453}){const {default:QR}=await import('qrcode');const uri=`ethereum:${USDC[chainId]}@${chainId}/transfer?address=${getAddress(wallet)}`;
  return {address:getAddress(wallet),network:chainId===8453?'Base mainnet (chainId 8453)':'Base Sepolia (84532)',token:'USDC (Circle native) '+USDC[chainId],eip681:uri,qrSvg:await QR.toString(uri,{type:'svg',margin:1}),
    warnings:['Send ONLY native USDC on Base. Not Ethereum, not Arbitrum/Optimism/Solana, not bridged USDC.e or USDbC: those are not usable by the wallet (flagged, not lost: the owner can move them out directly).',
      'Deposits above the owner-set daily limit are quarantined (not bounced); the owner can withdraw them anytime.','Keep only a small amount here: the wallet is fully AI-controlled.'],
    onRamps:'docs/DEPOSITS.md (regulated on-ramps that deliver native USDC on Base, e.g. Coinbase; verify availability in your region)'};}
