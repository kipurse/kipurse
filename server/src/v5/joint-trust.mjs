// SPDX-License-Identifier: AGPL-3.0-only
// JOINT TRUST (off-chain, enforced by the gateway). A payee address or a merchant domain becomes trusted ONLY when an agent PROPOSES it
// and the HUMAN owner APPROVES it on the owner-only surface (owner credential, never an agent token). The wallet never trusts anything
// on its own. Untrusted payees: the OWNER-SET unrecognized caps (no wallet defaults). Trusted: up to the approved caps (<= main caps).
// Every event goes to an append-only, hash-chained audit log. Revocation is immediate.
// Honest trade-off: this is enforced by the gateway host. If that host is compromised, the on-chain limits are the owner's main caps
// (single/daily/term of the signed permission), and the owner can still revoke on chain at any time.
import fs from 'node:fs';import {plainStore} from './at-rest.mjs';import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';import {getAddress,isAddress} from 'viem';
const lc=s=>String(s??'').trim().toLowerCase();const sha=s=>createHash('sha256').update(s).digest('hex');
const DOMAIN_RE=/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function normalizeSubject({payee,domain}){
  if(payee!==undefined&&domain!==undefined)throw Error('TRUST: give a payee OR a domain');
  if(payee!==undefined){if(!isAddress(String(payee),{strict:false})||/^0x0{40}$/i.test(String(payee)))throw Error('TRUST: bad payee');return {kind:'payee',id:getAddress(lc(payee))};}
  const d=lc(domain).replace(/^https:\/\//,'').replace(/\/.*$/,'');if(!DOMAIN_RE.test(d))throw Error('TRUST: bad domain');return {kind:'domain',id:d};}
/** Owner credential: a 32-byte secret in its own 0600 file (NOT an agent token). Only the owner surface reads it. */
export function loadOrCreateOwnerSecret(file){if(!fs.existsSync(file))fs.writeFileSync(file,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
  if((fs.statSync(file).mode&0o077)!==0)throw Error('owner secret must be 0600');return Buffer.from(fs.readFileSync(file,'utf8').trim(),'hex');}
export const ownerMac=(secret,msg)=>createHmac('sha256',secret).update(msg).digest('hex');
const macOk=(secret,msg,mac)=>{const a=Buffer.from(ownerMac(secret,msg),'hex'),b=Buffer.from(String(mac??''),'hex');return a.length===b.length&&timingSafeEqual(a,b);};
export const approvalMessage=p=>`kipurse-trust-approve|${p.id}|${p.subject.kind}:${p.subject.id}|${p.single}|${p.daily}|${p.expiresAt}`;
export const revokeMessage=(subjectKey,nonce)=>`kipurse-trust-revoke|${subjectKey}|${nonce}`;
export function createJointTrust({store=plainStore,file,auditFile,caps,feePpm=1000n,now=()=>Math.floor(Date.now()/1000),ownerSecret}){
  // caps(): {mainSingle,mainDaily,unrecognizedSingle,unrecognizedDaily} from the owner settings (null until the owner set them)
  const C=()=>{const c=caps?.();if(!c)throw Error('TRUST: owner limits not set yet (kipurse_setup)');return Object.fromEntries(Object.entries(c).map(([k,v])=>[k,BigInt(v)]));};
  if(!ownerSecret)throw Error('TRUST: owner secret required (owner surface only)');
  let S=store.readJson(file,null)??{proposals:{},trusted:{},untrustedSpend:{},usedNonces:{}};
  const save=()=>store.writeJson(file,S);
  let last=store.readLines(auditFile).pop()??null;let prev=last?JSON.parse(last).hash:'genesis';
  const audit=(event,data)=>{const rec={ts:now(),event,...data,prev};rec.hash=sha(JSON.stringify(rec));store.appendLine(auditFile,JSON.stringify(rec));prev=rec.hash;return rec;};
  const key=s=>`${s.kind}:${s.id}`;const day=t=>Math.floor(t/86400);const fee=a=>(a*feePpm+999999n)/1000000n;
  const capOf=v=>{const x=BigInt(v);if(x<=0n)throw Error('TRUST: caps must be > 0');return x;};
  return {
    /** AGENT: propose a payee or domain. Never trusts anything by itself. */
    propose({payee,domain,reason,single,daily,agentId='agent',ttlDays=90}){
      const subject=normalizeSubject({payee,domain});const r=String(reason??'').trim();if(r.length<3||r.length>500)throw Error('TRUST: reason (3-500 chars) required');
      const s1=capOf(single),d1=capOf(daily??single);const cc=C();if(s1>cc.mainSingle||d1>cc.mainDaily||s1>d1)throw Error('TRUST: requested caps must be single <= daily <= the main caps');
      const p={id:randomUUID(),subject,reason:r,single:s1.toString(),daily:d1.toString(),agentId:String(agentId),createdAt:now(),expiresAt:now()+Math.min(Number(ttlDays),365)*86400,state:'pending'};
      S.proposals[p.id]=p;save();audit('proposed',{id:p.id,subject:key(subject),single:p.single,daily:p.daily,agentId:p.agentId,reason:r});return {...p,note:'pending: only the human owner can approve this on the owner surface'};},
    /** OWNER: approve with the owner credential (HMAC over the exact proposal). */
    approve(id,mac){const p=S.proposals[id];if(!p||p.state!=='pending')throw Error('TRUST: no pending proposal '+id);
      if(!macOk(ownerSecret,approvalMessage(p),mac))throw Error('TRUST: owner approval invalid');
      p.state='approved';p.approvedAt=now();S.trusted[key(p.subject)]={subject:p.subject,single:p.single,daily:p.daily,expiresAt:p.expiresAt,proposalId:id,approvedAt:p.approvedAt,spent:{}};save();
      audit('approved',{id,subject:key(p.subject),single:p.single,daily:p.daily,expiresAt:p.expiresAt});return S.trusted[key(p.subject)];},
    reject(id,mac){const p=S.proposals[id];if(!p||p.state!=='pending')throw Error('TRUST: no pending proposal');if(!macOk(ownerSecret,'kipurse-trust-reject|'+id,mac))throw Error('TRUST: owner credential invalid');
      p.state='rejected';save();audit('rejected',{id,subject:key(p.subject)});return p;},
    /** OWNER: revoke immediately. */
    revoke(subjectKey,nonce,mac){if(!S.trusted[subjectKey])throw Error('TRUST: not trusted');if(S.usedNonces[nonce])throw Error('TRUST: nonce used');
      if(!macOk(ownerSecret,revokeMessage(subjectKey,nonce),mac))throw Error('TRUST: owner credential invalid');S.usedNonces[nonce]=1;delete S.trusted[subjectKey];save();audit('revoked',{subject:subjectKey});return {revoked:subjectKey};},
    list(){const t=now();return {trusted:Object.entries(S.trusted).map(([k,v])=>({key:k,...v,active:v.expiresAt>t})),pending:Object.values(S.proposals).filter(p=>p.state==='pending'),
      untrustedCaps:(()=>{try{const c=C();return {single:c.unrecognizedSingle.toString(),daily:c.unrecognizedDaily.toString()};}catch{return null;}})()};},
    /** GATEWAY: decide a payment. verifiedDomain only when the order was fetched over https from that exact domain (discovery). */
    decide({payee,verifiedDomain,amount}){const a=BigInt(amount),t=now(),dd=day(t),tot=a+fee(a);
      const hit=[verifiedDomain?`domain:${lc(verifiedDomain)}`:null,payee?`payee:${getAddress(lc(payee))}`:null].filter(Boolean).map(k=>[k,S.trusted[k]]).find(([,v])=>v&&v.expiresAt>t);
      if(hit){const [k,v]=hit;let cc=null;try{cc=C();}catch{}if(cc&&(a>cc.mainSingle))return {ok:false,trusted:true,key:k,reason:'over_onchain_single'};if(a>BigInt(v.single))return {ok:false,trusted:true,key:k,reason:'over_joint_trust_single'};
        if(BigInt(v.spent?.[dd]??0)+tot>BigInt(v.daily))return {ok:false,trusted:true,key:k,reason:'over_joint_trust_daily'};return {ok:true,trusted:true,key:k};}
      let cc;try{cc=C();}catch{return {ok:false,trusted:false,reason:'owner_limits_not_set',detail:'run kipurse_setup: the owner must choose the limits first'};}
      if(a>cc.unrecognizedSingle)return {ok:false,trusted:false,reason:'over_unrecognized_cap',detail:`payee not on the owner's trust list: at most ${cc.unrecognizedSingle} atomic USDC per payment (owner-set); ask with kipurse_request_trust`};
      if(BigInt(S.untrustedSpend[dd]??0)+tot>cc.unrecognizedDaily)return {ok:false,trusted:false,reason:'over_unrecognized_daily',detail:'owner-set daily cap for unrecognized payees reached (incl. fees)'};return {ok:true,trusted:false};},
    recordPaid({decision,amount,purchaseKey}){const a=BigInt(amount),dd=day(now()),tot=a+fee(a);
      if(decision?.trusted&&S.trusted[decision.key]){const v=S.trusted[decision.key];v.spent[dd]=(BigInt(v.spent[dd]??0)+tot).toString();}else S.untrustedSpend[dd]=(BigInt(S.untrustedSpend[dd]??0)+tot).toString();
      save();audit('paid',{purchaseKey,amount:a.toString(),trusted:!!decision?.trusted,subject:decision?.key??null});},
    auditVerify(){let p='genesis';for(const l of store.readLines(auditFile)){const r=JSON.parse(l);const {hash,...rest}=r;if(r.prev!==p||sha(JSON.stringify(rest))!==hash)return false;p=hash;}return true;},
  };}
