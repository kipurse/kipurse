// SPDX-License-Identifier: AGPL-3.0-only
// USER DATA ERASE ("delete everything"). Every module that keeps per-user records registers a forget(wallet) part; one call
// removes them all. The request must carry a fresh phone signature over a domain-separated erase digest (single-use challenge),
// so a stolen read session alone cannot wipe anything. On-chain facts (payments, owners) cannot be erased; removing the phone
// approver from the wallet is a separate owner transaction. Off unless enabled.
import {createHash,createHmac,randomBytes} from 'node:crypto';import {p256VerifyDigest} from './phone-signer.mjs';import {kvKey} from './store.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
export const eraseDigest=(wallet,nonce)=>'0x'+sha(`Kipurse erase all my data v1\nwallet:${String(wallet).toLowerCase()}\nnonce:${nonce}`);
// t784 (owner t783u): backups must forget erased users too. Each erase appends a TOMBSTONE (salted SHA-256 of the wallet + time, no address)
// to a file OUTSIDE data/ (shared/tombstones). On every boot the runtime re-runs the same erase for any tombstoned wallet whose state predates
// the tombstone (= data restored from an older backup). Backups are kept 7 days, so an erased user is gone from every backup within 7 days.
/* t1265: v1 tombstones were an UNSALTED sha256 of the address (anyone with the file could test a known address). New tombstones are
   HMAC-SHA256 under a secret kept OUTSIDE data/ (KIPURSE_TOMBSTONE_KEY_FILE, else a subkey of the at-rest data key). latest() still matches
   the old v1 lines, so users erased before this change stay erased. Without any key (library use / tests) v1 is written as before. */
export const tombHash=(w,key=null)=>key?createHmac('sha256',key).update('kipurse-tombstone-v2:'+String(w).toLowerCase()).digest('hex'):sha('kipurse-tombstone-v1:'+String(w).toLowerCase());
export function createTombstones({file,fs,now=()=>Date.now(),key=null,oldKeys=[]}){
  const read=()=>{try{return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(o=>o&&typeof o.h==='string'&&Number.isFinite(o.t));}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  return {file,keyed:!!key,
    add(wallet){const o={h:tombHash(wallet,key),t:now(),...(key?{v:2}:{})};fs.mkdirSync(file.replace(/\/[^/]*$/,''),{recursive:true,mode:0o700});fs.appendFileSync(file,JSON.stringify(o)+'\n',{mode:0o600});try{fs.fsyncSync?.(fs.openSync(file,'r'));}catch{}return o;},
    latest(wallet){const hs=new Set([tombHash(wallet),...[key,...oldKeys].filter(Boolean).map(k=>tombHash(wallet,k))]);let t=null;for(const o of read())if(hs.has(o.h)&&(t===null||o.t>t))t=o.t;return t;},
    count:()=>read().length};}
/** t1265: the tombstone key. KIPURSE_TOMBSTONE_KEY_FILE (64 hex, mode 0400/0600, outside data/), else HKDF of the at-rest data key, else null. */
export async function tombstoneKey({file=null,dataKey=null,fs=null}={}){
  if(file){const f=fs??(await import('node:fs')).default;const st=f.statSync(file);if(st.mode&0o077)throw Error('tombstone key file must be mode 0400/0600');
    const k=Buffer.from(f.readFileSync(file,'utf8').trim(),'hex');if(k.length!==32)throw Error('tombstone key must be 64 hex chars');return k;}
  if(dataKey){const {hkdfSync}=await import('node:crypto');return Buffer.from(hkdfSync('sha256',Buffer.isBuffer(dataKey)?dataKey:Buffer.from(String(dataKey),'hex'),Buffer.alloc(0),'kipurse-tombstone-v2',32));}
  return null;}
/** Boot check. erasedAt = when this data last ran an erase (state field). Returns 'clean' | 'reapplied'. */
export async function applyTombstone({tomb,wallet,erasedAt,erase,mark}){const t=tomb.latest(wallet);if(t===null)return 'clean';
  if(Number(erasedAt??0)>=t)return 'clean';await erase(wallet);await mark(t);return 'reapplied';}
export function createUserDataEraser({enabled=false,resolveTenant,parts,now=()=>Date.now(),ttlMs=120e3,kv=null,tomb=null,onErased=null}){const ch0=new Map();
  // t1265: take = get + delete in ONE step (sqlite DELETE .. RETURNING), so two concurrent requests cannot both redeem one challenge
  const ch=kv?{take:n=>kv.take(kvKey('erase-chal',null,n)),set:(n,v)=>kv.put(kvKey('erase-chal',null,n),v,ttlMs),delete:n=>kv.del(kvKey('erase-chal',null,n)),[Symbol.iterator]:function*(){}}
    :{take:n=>{const v=ch0.get(n);ch0.delete(n);return v;},set:(n,v)=>ch0.set(n,v),delete:n=>ch0.delete(n),[Symbol.iterator]:()=>ch0[Symbol.iterator]()};
  async function erase(wallet){const done=[];for(const p of parts){await p.forget(wallet);done.push(p.name);}return done;}
  async function handle(req,res,u,{readBody}){const p=u.pathname;if(p!=='/user/erase/challenge'&&p!=='/user/erase')return false;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(o));};
    if(!enabled){json(404,{error:'erase_disabled'});return true;}if(req.method!=='POST'){json(405,{error:'method'});return true;}
    const ten=await resolveTenant(req);if(!ten){json(401,{error:'invalid_session'});return true;}
    for(const [k,v] of ch)if(v.exp<=now())ch.delete(k);
    if(p==='/user/erase/challenge'){const nonce=randomBytes(24).toString('hex');ch.set(nonce,{wallet:ten.wallet,exp:now()+ttlMs});json(200,{nonce,digest:eraseDigest(ten.wallet,nonce),phrase:'DELETE'});return true;}
    const b=await readBody(req);const c=ch.take(String(b.nonce??''));
    if(!c||c.wallet!==ten.wallet||!(c.exp>now())){json(400,{error:'bad_challenge'});return true;}if(b.phrase!=='DELETE'){json(400,{error:'phrase'});return true;}
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
/** t1247 (§6#117, App Review 5.1.1(v)): KV records keyed by wallet that the erase must also remove — push device tokens (+ the one-time
 *  move flag) and the Apple Pay onramp verification (email / phone, kept 61 days) with its orders. */
/** t1265 adds: the sign-in read grant (phone key + owner), Coinbase onramp sessions (onramp:<w>:<ref>), the owner's inline V5.5 trusts,
 *  V5.4 signer grants (+ their signer / list indexes), and the per-wallet migration record (kept only as the permission fields the runtime
 *  needs to keep paying / withdrawing: on-chain facts). `keepMigration:false` (a retired wallet) deletes that record too. */
export function kvUserParts(kv,{keepMigration=()=>true}={}){const lc=w=>String(w).toLowerCase();const delPrefix=p=>{for(const e of kv.list(p))kv.del(e.k);};
  return [
    {name:'push-tokens',forget:w=>{kv.del(kvKey('push',lc(w),'tokens'));kv.del(kvKey('push',lc(w),'moved'));}},
    {name:'onramp-verification',forget:w=>{kv.del(`onrampv:${lc(w)}`);delPrefix(`onrampo:${lc(w)}:`);delPrefix(`onramp:${lc(w)}:`);}},
    {name:'read-grant',forget:w=>{kv.del(kvKey('readgrant',lc(w),'phone'));}},
    /* t1278 S9: the sign-in records of this wallet (owner, wallet, phone key; kept up to 30 days for an unproven bind) and their proofs */
    {name:'signin-records',forget:w=>{const k=kvKey('signin-w',lc(w),'ids');let ids=[];try{ids=kv.get(k)??[];}catch{ids=[];}
      for(const id of Array.isArray(ids)?ids:[])if(/^[0-9a-f]{32}$/.test(String(id))){kv.del(kvKey('signin',null,id));kv.del(kvKey('signin-p',null,id));}kv.del(k);}},
    {name:'signer-grants',forget:w=>{delPrefix(`v55inline:${lc(w)}:`);delPrefix(`v54grant:${lc(w)}:`);delPrefix(`v54grant-s:${lc(w)}:`);kv.del(`v54grant-list:${lc(w)}`);}},
    {name:'migration-record',forget:w=>{const k=kvKey('migrate54',lc(w),'record');const m=kv.get(k);if(!m)return;
      if(!keepMigration(w)){kv.del(k);return;}
      const min={newPermission:m.newPermission??null,migratedAt:m.migratedAt??null,rolledBackAt:m.rolledBackAt??null,...(m.rollback?.v52Permission?{rollback:{v52Permission:m.rollback.v52Permission}}:{}),erased:true};kv.put(k,min);}},
  ];}
/** t1265: the V5.5 move record is keyed by the OWNER (Base Account). Deleted once the move is finished (or never started); an in-flight move
 *  keeps it (the owner's next signature needs it) and the caller logs that. Returns 'deleted' | 'kept_in_flight' | 'none'. */
export function forgetOwnerMoveRecord(kv,owner){const k=kvKey('v55',String(owner).toLowerCase(),'record');const r=kv.get(k);if(!r)return 'none';
  if(r.movedAt||!r.preparedAt){kv.del(k);return 'deleted';}return 'kept_in_flight';}
/** t1265: delete every <file>.pre-encrypt.bak next to the given files / inside the given dirs (the at-rest migration backup). */
export function removeBackups(fs,{files=[],dirs=[]}){let n=0;const rm=f=>{try{if(fs.existsSync(f)){fs.rmSync(f,{force:true});n++;}}catch{}};
  for(const f of files)if(f){rm(f+'.pre-encrypt.bak');rm(f+'.tmp');}
  for(const d of dirs){let l=[];try{l=fs.readdirSync(d);}catch{continue;}for(const x of l)if(x.endsWith('.pre-encrypt.bak'))rm(d+'/'+x);}return n;}
/** t1265 (5.1.1(v)): personal data in the payment ledger. KEPT (documented financial minimum, needed for fee-vault settlement, tax receipts and
 *  the anti-duplicate / anti-replay layers): purchases (amount, payee address, standard, chain, state, tx hash / digest / fees, times; the
 *  merchant reply is removed), purchase_meta (agent id, tier, time), idempotency is cleared, ap2_usage + owner_approval_use + owner_ask_key +
 *  float_vouchers / float_sessions (hashes, nonces, amounts, tx hashes, times: single-use layers), gas_debt / gas_recovery / op_charges,
 *  mandate_repush, agent caps, the dedupe key of every proposal. REMOVED: intents, idempotency, claims, labels, events, tx_failures, the
 *  payee book (names), owner-approved payees (name / host / purpose), proposal texts (user_request, reason, items), every mandate (active ones
 *  are revoked first, then all are deleted), owner-ask name / note / spec, purchase_order JSON, hold arguments (pending holds are cancelled),
 *  layered-pay merchant status URL / reply. Every table is optional (older ledgers lack some). */
export function scrubLedgerDb(db){if(!db)return;const has=t=>{try{return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);}catch{return false;}};
  const ex=(t,sql)=>{if(has(t))db.exec(sql);};
  try{db.exec('PRAGMA secure_delete=ON');}catch{}
  db.exec('BEGIN IMMEDIATE');try{
    for(const t of ['intents','idempotency','claims','purchase_label','events'])ex(t,`DELETE FROM ${t}`);
    ex('purchases',`UPDATE purchases SET intent_id=NULL WHERE state IN ('paid','failed','reclaimed')`);
    // result keeps the fee / network fee / tx / digest (fee-vault settlement and tax receipts need them); only merchant replies go.
    if(has('purchases')){const up=db.prepare('UPDATE purchases SET result=? WHERE purchase_key=?');
      for(const r of db.prepare(`SELECT purchase_key,result FROM purchases WHERE result IS NOT NULL AND state IN ('paid','failed','reclaimed')`).all()){
        let j;try{j=JSON.parse(r.result);}catch{continue;}if(j&&typeof j==='object'&&'merchantResponse' in j){delete j.merchantResponse;up.run(JSON.stringify(j),r.purchase_key);}}}
    ex('purchase_meta',`UPDATE purchase_meta SET merchant_id=NULL`);
    ex('tx_failures',`DELETE FROM tx_failures`);
    ex('payee_book',`DELETE FROM payee_book`);
    ex('owner_payee',`DELETE FROM owner_payee`);
    ex('mandate_proposal',`UPDATE mandate_proposal SET state='expired' WHERE state='pending'`);
    ex('mandate_proposal',`UPDATE mandate_proposal SET user_request=NULL, reason=NULL, by=NULL, items_json='[]'`);
    ex('mandate',`UPDATE mandate SET state='revoked' WHERE state='active'`);
    ex('mandate',`DELETE FROM mandate`);
    ex('owner_ask',`UPDATE owner_ask SET state='expired' WHERE state='pending'`);
    ex('owner_ask',`UPDATE owner_ask SET name=NULL, note=NULL, spec_json='{}'`);
    ex('purchase_order',`UPDATE purchase_order SET order_json='{}'`);
    ex('payment_hold',`UPDATE payment_hold SET state='failed', result_json='{"error":"erased"}' WHERE state='pending'`);
    ex('payment_hold',`UPDATE payment_hold SET args_json='{}' WHERE state<>'executing'`);
    ex('layered_pay',`UPDATE layered_pay SET status_url=NULL, merchant_status=NULL`);
    db.exec('COMMIT');}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
  try{db.exec('VACUUM');}catch{}try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch{}}
export function mainnetEraseParts({S,save,ownerPay,phone,ledgerCache,limits,trustOwner,getDb,agents,kv,siri}){
  const clear=o=>{if(o&&typeof o==='object')for(const k of Object.keys(o))delete o[k];};
  return [
    // first: cut every agent credential (bearer tokens + OAuth) before anything else, so a later failure can't leave an agent able to pay
    {name:'agent-credentials',forget:()=>revokeAllAgents(S,save,agents,kv)},
    // t1275: Siri too - the ksc_ credential (else the same phone key re-enrolled makes the old token live again), the stored Siri request bodies, the connect record
    {name:'siri',forget:()=>{try{siri?.revoke?.('erase');}catch{}delete S.siriCred;delete S.siriPending;delete S.siriAgent;save();}},
    {name:'owner-pay',forget:w=>ownerPay.forget(w)},
    {name:'phone-sessions',forget:()=>{S.phoneSession??={};S.phoneSession.sessions={};save();}},
    {name:'phone-enrollment',forget:()=>phone.forget()},
    {name:'agent-activity',forget:()=>{clear(S.agentLastSeen);S.agentLastSeen??={};save();}},
    {name:'oauth',forget:()=>{S.oauth??={};for(const k of ['clients','pending','codes','tokens']){S.oauth[k]??={};clear(S.oauth[k]);}for(const k of Object.keys(S.oauth))if(!['clients','pending','codes','tokens'].includes(k))delete S.oauth[k];
      S.oauthAgents??={};clear(S.oauthAgents);save();}},
    {name:'trust-requests',forget:()=>{const t=trustOwner?.();if(t)t.api.forget(t.cap);}},
    {name:'limits-records',forget:()=>{delete S.capChangedAt;save();limits?.forget?.();}},
    {name:'ledger-cache',forget:()=>ledgerCache?.forget?.()},
    {name:'payment-details',forget:()=>scrubLedgerDb(getDb?.())},   // t1265: see scrubLedgerDb for what is kept
  ];}

/** t1265 (5.1.1(v)): erase a wallet the owner MOVED AWAY from (registry retired + movedTo). Its runtime is never built (its permission was
 *  revoked on chain), so the erase works on its files directly: state is cut to {permission, erasedAt, revokedAgentTokens}, agents are
 *  revoked (hashes kept so tokens stay dead) and emptied, the ledger DB gets the same scrub as a live wallet, the chain-scan cache and the
 *  rules dir (trust requests, owner rules, audit logs of that wallet) are deleted, every KV part runs, index entries that point at it are
 *  removed, and at-rest backups are deleted. deps: store (readJson/writeJson/openDb), files {state,agents,ledgerCache,engine{ledgerFile,ownerRulesDir}},
 *  index (createIndex), parts (extra {name,forget(w)}). Returns the list of parts done. */
export async function eraseRetiredWallet({wallet,fs,store,files,kv,index=null,parts=[],now=()=>Date.now()}){const w=String(wallet).toLowerCase();const done=[];
  const st=store.readJson(files.state,{})??{};const ag=(()=>{try{return store.readJson(files.agents,[])??[];}catch{return [];}})();
  const rev=new Set((st.revokedAgentTokens??[]).map(h=>String(h).toLowerCase()));for(const a of ag)if(a?.tokenSha256)rev.add(String(a.tokenSha256).toLowerCase());
  if(index){const del=(kind,key)=>{try{if(key&&index.get(kind,key)===w)index.del(kind,key);}catch{}};
    for(const a of ag)del('agent',a?.tokenSha256);const o=st.oauth??{};for(const m of [o.tokens,o.codes,o.pending,o.clients,o.refresh])for(const k of Object.keys(m??{}))del('oauth',k);
    for(const p of [st.phone?.active,st.phone?.retiring,...Object.values(st.phone?.pending??{})])del('phone',p?.x);}
  for(const h of rev)try{kv.put(kvKey('revoked-agent',null,h),1);}catch{}
  store.writeJson(files.state,{permission:st.permission,erasedAt:now(),revokedAgentTokens:[...rev]});store.writeJson(files.agents,[]);done.push('state','agents');
  if(files.engine?.ledgerFile&&(fs.existsSync(files.engine.ledgerFile)||fs.existsSync(files.engine.ledgerFile+'.enc'))){const db=store.openDb(files.engine.ledgerFile,{});try{scrubLedgerDb(db);}finally{try{db.close();}catch{}}done.push('payment-details');}
  if(files.ledgerCache)try{fs.rmSync(files.ledgerCache,{force:true});done.push('ledger-cache');}catch{}
  if(files.engine?.ownerRulesDir)try{fs.rmSync(files.engine.ownerRulesDir,{recursive:true,force:true});done.push('rules');}catch{}
  for(const p of [...kvUserParts(kv,{keepMigration:()=>false}),...parts]){await p.forget(wallet);done.push(p.name);}
  removeBackups(fs,{files:[files.state,files.agents,files.ledgerCache,files.engine?.ledgerFile],dirs:[]});try{kv.scrub?.();}catch{}
  return done;}
/** t1265: the wallets an erase of `wallet` must also reach: every registered wallet of the same owner whose movedTo chain ends at `wallet`
 *  (0x5150 -> V5.4 -> V5.5 ...), plus the record's own movedFrom chain. */
export function movedFromChain(reg,wallet,followMoved){const cur=reg.get(wallet);if(!cur)return [];const me=String(wallet).toLowerCase();const out=new Map();
  for(let r=cur,i=0;r?.movedFrom&&i<16;i++){const p=reg.get(r.movedFrom);if(!p||String(p.wallet).toLowerCase()===me||out.has(String(p.wallet).toLowerCase()))break;out.set(String(p.wallet).toLowerCase(),p);r=p;}
  for(const r of reg.byOwner?.(cur.owner)??[])if(r.retired&&String(r.wallet).toLowerCase()!==me&&String(followMoved(r.wallet,a=>reg.get(a))).toLowerCase()===me)out.set(String(r.wallet).toLowerCase(),r);
  return [...out.values()];}
