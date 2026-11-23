// SPDX-License-Identifier: AGPL-3.0-only
// STORAGE SEAMS (see SCALING.md). Two interfaces; today's implementations are local (file / SQLite) for ONE VPS.
//  1. TenantState: per-user document keyed by tenant id (= wallet address, lowercase). Later: Postgres table partitioned by
//     hash(tenant) (or a shard map), same load/save/update contract. No call site scans across tenants.
//  2. KV (short-lived values + counters): challenges, rate-limit windows, revocation feed. Later: Redis (SET PX / GETDEL / INCR+PEXPIRE),
//     same method names. Keys are "<scope>:<tenant|global>:<name>" so they shard by the tenant part.
import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {randomBytes,createCipheriv,createDecipheriv,hkdfSync,createHash} from 'node:crypto';
export const tenantKey=w=>String(w).toLowerCase();
export const kvKey=(scope,tenant,name)=>`${scope}:${tenant?tenantKey(tenant):'global'}:${name}`;
/** File implementation: one JSON doc per tenant. `legacyFile` keeps the existing single-tenant runtime-state.json path. */
export function createFileTenantState({dir,legacyFile,legacyTenant}){
  const path=t=>legacyFile&&legacyTenant&&tenantKey(t)===tenantKey(legacyTenant)?legacyFile:`${dir}/tenant-${tenantKey(t)}.json`;
  return {kind:'file',
    load(t,init){const p=path(t);return fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):(typeof init==='function'?init():init??{});},
    save(t,doc){const p=path(t),tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(doc,null,1),{mode:0o600});fs.renameSync(tmp,p);}};}
/** SQLite KV with TTL. All ops are single statements (atomic within one host). */
export function createSqliteKV({file,now=()=>Date.now()}){
  const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL');db.exec('PRAGMA busy_timeout=3000');
  db.exec('PRAGMA secure_delete=ON');   // t1265: a deleted value (erase, expiry) is overwritten in the file, not left in free pages
  db.exec('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT, exp INTEGER)');db.exec('CREATE INDEX IF NOT EXISTS kv_exp ON kv(exp)');
  const q={put:db.prepare('INSERT INTO kv(k,v,exp) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,exp=excluded.exp'),
    get:db.prepare('SELECT v,exp FROM kv WHERE k=?'),del:db.prepare('DELETE FROM kv WHERE k=? RETURNING v,exp'),
    pref:db.prepare("SELECT k,v FROM kv WHERE k >= ? AND k < ? AND (exp IS NULL OR exp > ?) ORDER BY k LIMIT ?"),gc:db.prepare('DELETE FROM kv WHERE exp IS NOT NULL AND exp <= ?')};
  const live=r=>r&&(r.exp===null||r.exp>now());let ops=0;const tick=()=>{if(++ops%500===0)q.gc.run(now());};
  return {kind:'sqlite',
    put(k,v,ttlMs){tick();q.put.run(k,JSON.stringify(v),ttlMs?now()+ttlMs:null);},
    get(k){const r=q.get.get(k);return live(r)?JSON.parse(r.v):undefined;},
    /** get + delete in one statement (single-use challenges). */
    take(k){const r=q.del.get(k);return live(r)?JSON.parse(r.v):undefined;},
    del(k){q.del.get(k);},
    /** fixed-window counter: returns the count in the current window (rate limits). */
    incr(k,windowMs){tick();const r=q.get.get(k);let c=live(r)?JSON.parse(r.v):null;if(!c){c={n:0};q.put.run(k,'{}',now()+windowMs);}
      c.n++;db.prepare('UPDATE kv SET v=? WHERE k=?').run(JSON.stringify(c),k);return c.n;},
    /** keys under a prefix (bounded; used only for the small global revocation feed, never per-user scans on hot paths). */
    list(prefix,limit=10000){return q.pref.all(prefix,prefix+'\uffff',now(),limit).map(r=>({k:r.k,v:JSON.parse(r.v)}));},
    gc(){q.gc.run(now());},
    /** t1265: after an erase, fold the WAL back into the (secure_delete) main file so deleted values do not linger in kv.sqlite-wal */
    scrub(){try{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch{}},close(){db.close();}};}
/** In-memory KV with the same contract (tests / fork). */
export function createMemoryKV({now=()=>Date.now()}={}){const m=new Map();const live=r=>r&&(r.exp===null||r.exp>now());
  return {kind:'memory',put:(k,v,t)=>m.set(k,{v,exp:t?now()+t:null}),get:k=>live(m.get(k))?m.get(k).v:undefined,take:k=>{const r=m.get(k);m.delete(k);return live(r)?r.v:undefined;},del:k=>m.delete(k),
    incr:(k,w)=>{let r=m.get(k);if(!live(r)){r={v:{n:0},exp:now()+w};m.set(k,r);}r.v.n++;return r.v.n;},
    list:(p,l=10000)=>[...m.entries()].filter(([k,r])=>k.startsWith(p)&&live(r)).sort().slice(0,l).map(([k,r])=>({k,v:r.v})),gc(){},close(){}};}
/** Per-key + global fixed-window limiter on top of any KV. */
export function createRateLimiter(kv,{perKey=60,global=6000,windowMs=60000}={}){
  return {hit(scope,key){const n=kv.incr(kvKey('rl',null,scope+':'+key),windowMs);const g=kv.incr(kvKey('rl',null,'*:'+scope),windowMs);return n>perKey||g>global;}};}
/** t1265: KV keys whose values hold personal data (push device tokens, read grants (phone key + owner), onramp verification (email / phone)
 *  and orders, sign-in / new-wallet setup records (phone key + owner), V5.4 signer grants). With a data key their VALUES are sealed with
 *  AES-256-GCM under a per-tenant subkey (HKDF(data key, tenant address)); the key name is the AAD, so a value cannot be moved to another key.
 *  Old plaintext values stay readable and are sealed on their next write. Without a data key the KV is returned unchanged. */
export const PERSONAL_KV_SCOPES=['push','readgrant','onramp','onrampv','onrampo','signin','onbnew','v54grant','v54grant-s','v54grant-list'];
const ADDR_RE=/^0x[0-9a-f]{40}$/i;
export function sealKV(kv,dataKey,{scopes=PERSONAL_KV_SCOPES}={}){if(!kv||!dataKey)return kv;
  const k=Buffer.isBuffer(dataKey)?dataKey:Buffer.from(String(dataKey).trim(),'hex');if(k.length!==32)throw Error('data key must be 32 bytes');
  const subs=new Map();const sub=t=>{let x=subs.get(t);if(!x){x=Buffer.from(hkdfSync('sha256',k,Buffer.from(t),'kipurse-kv-v1',32));if(subs.size>2000)subs.clear();subs.set(t,x);}return x;};
  const tenantOf=key=>String(key).split(':').find(p=>ADDR_RE.test(p))?.toLowerCase()??'global';
  const personal=key=>scopes.includes(String(key).split(':')[0]);
  const seal=(key,v)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',sub(tenantOf(key)),iv);c.setAAD(Buffer.from(String(key)));
    const ct=Buffer.concat([c.update(JSON.stringify(v===undefined?null:v)),c.final()]);return {$kpe:Buffer.concat([iv,c.getAuthTag(),ct]).toString('base64')};};
  const open=(key,v)=>{if(!v||typeof v!=='object'||typeof v.$kpe!=='string')return v;
    try{const b=Buffer.from(v.$kpe,'base64'),d=createDecipheriv('aes-256-gcm',sub(tenantOf(key)),b.subarray(0,12));d.setAAD(Buffer.from(String(key)));d.setAuthTag(b.subarray(12,28));
      return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}catch{return undefined;}};
  return {...kv,sealed:true,
    put:(key,v,t)=>kv.put(key,personal(key)?seal(key,v):v,t),
    get:key=>open(key,kv.get(key)),
    take:key=>open(key,kv.take(key)),
    list:(p,l)=>kv.list(p,l).map(e=>({k:e.k,v:open(e.k,e.v)}))};}
/** t1265: one-way, non-reversible client id for rate-limit keys (raw IPs never become KV keys). */
export const ipHash=ip=>createHash('sha256').update('kp-rl-ip:'+String(ip??'')).digest('hex').slice(0,24);
/** t1265: strip URLs (RPC / bundler URLs can carry API keys) from text that is logged or returned. */
export const scrubUrls=s=>String(s??'').replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]*/gi,'<url>').replace(/\b(api[-_]?key|apikey|token|secret)=[^&\s]+/gi,'$1=<redacted>');
