// SPDX-License-Identifier: AGPL-3.0-only
// READ-ONLY phone session for the Kipurse app on MAINNET. The app proves it holds the ACTIVE phone signer key (Secure Enclave P-256,
// enrolled on chain as KipursePhoneApprover) by signing a server challenge; it gets a short-lived bearer token that can ONLY read:
// balance, vault, caps, connected agents, recent payments, pending trust requests. No spending power, no settings, no approvals here
// (trust approvals keep using /approve/trust/phone-*, which the wallet verifies on chain).
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';import {p256VerifyDigest,fingerprint} from './phone-signer.mjs';import {kvKey} from './store.mjs';
const J=x=>JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v);
const sha=s=>createHash('sha256').update(s).digest();
/** Digest the phone signs. Domain-separated text, hashed with SHA-256 (never a valid EIP-712 / wallet hash). The app recomputes it itself. */
export const sessionDigest=(wallet,nonce)=>'0x'+sha(`Kipurse read-only session v1\nwallet:${String(wallet).toLowerCase()}\nnonce:${nonce}`).toString('hex');
/** t849: Sign in with Coinbase (verified owner) on a phone that is NOT the active approver leaves a read grant for that phone key
 * (signin.mjs, 30 days, one per wallet, replaced on the next sign-in). It only unlocks GET /phone/session/state: check() still
 * accepts ONLY active-approver sessions, so pay / limits / safety / erase / Siri / onramp stay approver-only. */
export const readGrantKey=wallet=>kvKey('readgrant',wallet,'phone');
/** store/save (optional): persist sessions across restarts/deploys. Only SHA-256 hashes of tokens are stored, with their expiry. */
export function createPhoneSession({phone,wallet,readState,now=()=>Date.now(),ttlMs=12*3600e3,challengeTtlMs=120e3,store=null,save=()=>{},kv=null}){
  // kv (store.mjs): challenges + rate-limit windows shared by every worker; without it, process memory (single instance / tests)
  const challenges=kv?{get:n=>kv.get(kvKey('chal',wallet,n)),set:(n,e)=>kv.put(kvKey('chal',wallet,n),e,challengeTtlMs),delete:n=>kv.del(kvKey('chal',wallet,n)),get size(){return 0;},[Symbol.iterator]:function*(){}}:new Map(),hits=new Map();
  if(store)store.sessions??={};
  const tokens={get:h=>store?store.sessions[h]:mem.get(h),set:(h,v)=>{if(store){store.sessions[h]=v;save();}else mem.set(h,v);},delete:h=>{if(store){if(store.sessions[h]){delete store.sessions[h];save();}}else mem.delete(h);},
    entries:()=>store?Object.entries(store.sessions):[...mem.entries()]};const mem=new Map();
  const limited=(ip,max=30)=>{if(kv)return kv.incr(kvKey('rl',null,'phone-session:'+ip),60000)>max;const n=now(),h=hits.get(ip)??[0,n];if(n-h[1]>60000){h[0]=0;h[1]=n;}h[0]++;hits.set(ip,h);return h[0]>max;};
  const gc=()=>{const n=now();for(const [k,v] of challenges)if(v<=n)challenges.delete(k);for(const [k,v] of tokens.entries())if(v.exp<=n)tokens.delete(k);};
  const hashTok=t=>sha('kps:'+t).toString('hex');
  function check(req){const t=String(req.headers.authorization??'').replace(/^Bearer\s+/i,'');if(!/^kps_[A-Za-z0-9_-]{43}$/.test(t))return null;gc();
    const h=hashTok(t),s=tokens.get(h);if(!s)return null;const a=phone.active();
    if(s.grant)return null;// t849: read-grant sessions never authorize anything but /phone/session/state
    if(!a||a.fingerprint!==s.fingerprint){tokens.delete(h);return null;}// signer revoked / replaced -> every session ends
    return s;}
  const grantOf=()=>{if(!kv)return null;const g=kv.get(readGrantKey(wallet));return g&&g.x&&g.y&&(!g.exp||g.exp>now())?g:null;};
  /** Read-only: active-approver sessions, or a read-grant session whose grant is still the same key. */
  function checkRead(req){const s0=check(req);if(s0)return {...s0,bound:true};const t=String(req.headers.authorization??'').replace(/^Bearer\s+/i,'');if(!/^kps_[A-Za-z0-9_-]{43}$/.test(t))return null;
    const h=hashTok(t),s=tokens.get(h);if(!s?.grant)return null;const g=grantOf();if(!g||fingerprint(g.x,g.y)!==s.fingerprint){tokens.delete(h);return null;}return {...s,bound:false};}
  async function handle(req,res,u,{readBody,ip}){const p=u.pathname;if(!p.startsWith('/phone/session'))return false;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(J(o));};
    if(limited(ip??'')){json(429,{error:'slow_down'});return true;}
    if(p==='/phone/session/challenge'&&req.method==='POST'){gc();if(challenges.size>500){json(429,{error:'slow_down'});return true;}
      const nonce=randomBytes(24).toString('hex');challenges.set(nonce,now()+challengeTtlMs);json(200,{nonce,digest:sessionDigest(wallet,nonce),wallet,expiresInSec:Math.floor(challengeTtlMs/1000)});return true;}
    if(p==='/phone/session'&&req.method==='POST'){const b=await readBody(req);const nonce=String(b.nonce??'');gc();
      const exp=challenges.get(nonce);if(!/^[0-9a-f]{48}$/.test(nonce)||!exp){json(400,{error:'bad_challenge'});return true;}challenges.delete(nonce);// single use
      const a=phone.active();let ok=false;if(a){try{ok=p256VerifyDigest(a,sessionDigest(wallet,nonce),String(b.r),String(b.s));}catch{ok=false;}}
      if(!ok){const g=grantOf();let gok=false;if(g){try{gok=p256VerifyDigest(g,sessionDigest(wallet,nonce),String(b.r),String(b.s));}catch{gok=false;}}
        if(gok){const fp=fingerprint(g.x,g.y),t='kps_'+randomBytes(32).toString('base64url');tokens.set(hashTok(t),{exp:Math.min(now()+ttlMs,g.exp??Infinity),fingerprint:fp,grant:true});
          json(200,{token:t,expiresInSec:Math.floor(ttlMs/1000),fingerprint:fp,scope:'read',bound:false});return true;}
        json(a?403:409,{error:a?'not_phone_signer':'no_phone_signer'});return true;}
      const t='kps_'+randomBytes(32).toString('base64url');tokens.set(hashTok(t),{exp:now()+ttlMs,fingerprint:a.fingerprint});
      json(200,{token:t,expiresInSec:Math.floor(ttlMs/1000),fingerprint:a.fingerprint,scope:'read',bound:true});return true;}
    if(p==='/phone/session/state'&&req.method==='GET'){const s=checkRead(req);if(!s){json(401,{error:'invalid_session'});return true;}
      try{json(200,{...await readState(),scope:'read',bound:s.bound,fingerprint:s.fingerprint,serverTime:new Date(now()).toISOString()});}catch(e){json(502,{error:'state_unavailable',detail:String(e.message).slice(0,200)});}return true;}
    if(p==='/phone/session/end'&&req.method==='POST'){const t=String(req.headers.authorization??'').replace(/^Bearer\s+/i,'');if(t)tokens.delete(hashTok(t));json(200,{ok:true});return true;}
    json(404,{error:'not_found'});return true;}
  return {handle,check,checkRead,_tokens:tokens};}
