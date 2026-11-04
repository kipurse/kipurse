// SPDX-License-Identifier: AGPL-3.0-only
// USER DATA ERASE ("delete everything"). Every module that keeps per-user records registers a forget(wallet) part; one call
// removes them all. The request must carry a fresh phone signature over a domain-separated erase digest (single-use challenge),
// so a stolen read session alone cannot wipe anything. On-chain facts (payments, owners) cannot be erased; removing the phone
// approver from the wallet is a separate owner transaction. Off unless enabled.
import {createHash,randomBytes} from 'node:crypto';import {p256VerifyDigest} from './phone-signer.mjs';import {kvKey} from './store.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
export const eraseDigest=(wallet,nonce)=>'0x'+sha(`Kipurse erase all my data v1\nwallet:${String(wallet).toLowerCase()}\nnonce:${nonce}`);
// t784 (owner t783u): backups must forget erased users too. Each erase appends a TOMBSTONE (salted SHA-256 of the wallet + time, no address)
// to a file OUTSIDE data/ (shared/tombstones). On every boot the runtime re-runs the same erase for any tombstoned wallet whose state predates
// the tombstone (= data restored from an older backup). Backups are kept 7 days, so an erased user is gone from every backup within 7 days.
export const tombHash=w=>sha('kipurse-tombstone-v1:'+String(w).toLowerCase());
export function createTombstones({file,fs,now=()=>Date.now()}){
  const read=()=>{try{return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(o=>o&&typeof o.h==='string'&&Number.isFinite(o.t));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  return {file,
    add(wallet){const o={h:tombHash(wallet),t:now()};fs.mkdirSync(file.replace(/\/[^/]*$/,''),{recursive:true,mode:0o700});fs.appendFileSync(file,JSON.stringify(o)+'\n',{mode:0o600});try{fs.fsyncSync?.(fs.openSync(file,'r'));}catch{}return o;},
    latest(wallet){const h=tombHash(wallet);let t=null;for(const o of read())if(o.h===h&&(t===null||o.t>t))t=o.t;return t;},
    count:()=>read().length};}
/** Boot check. erasedAt = when this data last ran an erase (state field). Returns 'clean' | 'reapplied'. */
export async function applyTombstone({tomb,wallet,erasedAt,erase,mark}){const t=tomb.latest(wallet);if(t===null)return 'clean';
  if(Number(erasedAt??0)>=t)return 'clean';await erase(wallet);await mark(t);return 'reapplied';}
export function createUserDataEraser({enabled=false,resolveTenant,parts,now=()=>Date.now(),ttlMs=120e3,kv=null,tomb=null,onErased=null}){const ch0=new Map();
  const ch=kv?{get:n=>kv.get(kvKey('erase-chal',null,n)),set:(n,v)=>kv.put(kvKey('erase-chal',null,n),v,ttlMs),delete:n=>kv.del(kvKey('erase-chal',null,n)),[Symbol.iterator]:function*(){}}:ch0;
  async function erase(wallet){const done=[];for(const p of parts){await p.forget(wallet);done.push(p.name);}return done;}
  async function handle(req,res,u,{readBody}){const p=u.pathname;if(p!=='/user/erase/challenge'&&p!=='/user/erase')return false;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(o));};
    if(!enabled){json(404,{error:'erase_disabled'});return true;}if(req.method!=='POST'){json(405,{error:'method'});return true;}
    const ten=await resolveTenant(req);if(!ten){json(401,{error:'invalid_session'});return true;}
    for(const [k,v] of ch)if(v.exp<=now())ch.delete(k);
    if(p==='/user/erase/challenge'){const nonce=randomBytes(24).toString('hex');ch.set(nonce,{wallet:ten.wallet,exp:now()+ttlMs});json(200,{nonce,digest:eraseDigest(ten.wallet,nonce),phrase:'DELETE'});return true;}
    const b=await readBody(req);const c=ch.get(String(b.nonce??''));ch.delete(String(b.nonce??''));
    if(!c||c.wallet!==ten.wallet){json(400,{error:'bad_challenge'});return true;}if(b.phrase!=='DELETE'){json(400,{error:'phrase'});return true;}
    const a=ten.phone.active();let ok=false;try{ok=!!a&&p256VerifyDigest(a,eraseDigest(ten.wallet,b.nonce),String(b.r),String(b.s));}catch{}
    if(!ok){json(403,{error:'not_phone_signer'});return true;}
    const done=await erase(ten.wallet);let tt=null;if(tomb){try{tt=tomb.add(ten.wallet).t;}catch{}}if(onErased){try{await onErased(ten.wallet,tt??now());}catch{}}
    json(200,{ok:true,erased:done,tombstone:!!tt,note:'on-chain records stay on chain; remove the phone approver from the wallet separately'});return true;}
  return {handle,erase};}

/** Every per-wallet off-chain user record of one mainnet deployment (single wallet). Kept: on-chain state, the permission mirror
 *  (S.permission, needed to keep paying/withdrawing), the session key, operator config, and the financial minimum of the payment
 *  ledger (amount, payee, tx hashes, state, times; fee-vault/gas accounting tables untouched) — all public on chain anyway. */
/** Token agents (operator agents.json, hashed bearer tokens) are revoked by HASH in the tenant state, so a revoked token stays dead across
 *  restarts while a NEWLY minted token (new hash) for the same agent id works again. Live agents are untouched until an erase happens. */
export function applyAgentRevocations(S,agents){const r=new Set((S?.revokedAgentTokens??[]).map(h=>String(h).toLowerCase()));let n=0;
  for(const a of agents??[])if(a?.tokenSha256&&r.has(String(a.tokenSha256).toLowerCase())){a.disabled=true;n++;}return n;}
export function revokeAllAgents(S,save,agents,kv=null){const r=new Set((S.revokedAgentTokens??[]).map(h=>String(h).toLowerCase()));
  for(const a of agents??[]){a.disabled=true;if(a.tokenSha256)r.add(String(a.tokenSha256).toLowerCase());}S.revokedAgentTokens=[...r];save();
  if(kv)for(const h of r)kv.put(kvKey('revoked-agent',null,h),1);} // feed read by every worker (reloadRevocations)
/** Multi-instance: apply revocations other workers wrote to the shared KV. Returns how many agents were newly disabled. */
export function reloadRevocations(kv,agents){let n=0;const hs=new Set(kv.list(kvKey('revoked-agent',null,'')).map(e=>e.k.split(':').pop()));
  for(const a of agents??[])if(!a.disabled&&a.tokenSha256&&hs.has(String(a.tokenSha256).toLowerCase())){a.disabled=true;n++;}return n;}
export function mainnetEraseParts({S,save,ownerPay,phone,ledgerCache,limits,trustOwner,getDb,agents,kv}){
  const clear=o=>{if(o&&typeof o==='object')for(const k of Object.keys(o))delete o[k];};
  return [
    // first: cut every agent credential (bearer tokens + OAuth) before anything else, so a later failure can't leave an agent able to pay
    {name:'agent-credentials',forget:()=>revokeAllAgents(S,save,agents,kv)},
    {name:'owner-pay',forget:w=>ownerPay.forget(w)},
    {name:'phone-sessions',forget:()=>{S.phoneSession??={};S.phoneSession.sessions={};save();}},
    {name:'phone-enrollment',forget:()=>phone.forget()},
    {name:'agent-activity',forget:()=>{clear(S.agentLastSeen);S.agentLastSeen??={};save();}},
    {name:'oauth',forget:()=>{S.oauth??={};for(const k of ['clients','pending','codes','tokens']){S.oauth[k]??={};clear(S.oauth[k]);}for(const k of Object.keys(S.oauth))if(!['clients','pending','codes','tokens'].includes(k))delete S.oauth[k];
      S.oauthAgents??={};clear(S.oauthAgents);save();}},
    {name:'trust-requests',forget:()=>{const t=trustOwner?.();if(t)t.api.forget(t.cap);}},
    {name:'limits-records',forget:()=>{delete S.capChangedAt;save();limits?.forget?.();}},
    {name:'ledger-cache',forget:()=>ledgerCache?.forget?.()},
    {name:'payment-details',forget:()=>{const db=getDb?.();if(!db)return;db.exec('BEGIN IMMEDIATE');try{
      for(const t of ['intents','idempotency','claims','purchase_label','events'])db.exec(`DELETE FROM ${t}`);
      db.exec(`UPDATE purchases SET intent_id=NULL WHERE state IN ('paid','failed','reclaimed')`);
      // result keeps the fee / network fee / tx / digest (fee-vault settlement and tax receipts need them); only merchant replies go.
      const up=db.prepare('UPDATE purchases SET result=? WHERE purchase_key=?');
      for(const r of db.prepare(`SELECT purchase_key,result FROM purchases WHERE result IS NOT NULL AND state IN ('paid','failed','reclaimed')`).all()){
        let j;try{j=JSON.parse(r.result);}catch{continue;}if(j&&typeof j==='object'&&'merchantResponse' in j){delete j.merchantResponse;up.run(JSON.stringify(j),r.purchase_key);}}
      db.exec(`UPDATE purchase_meta SET merchant_id=NULL`);
      try{db.exec(`DELETE FROM tx_failures`);}catch{}
      db.exec('COMMIT');}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}}},
  ];}
