// t1158u (handbook §6#77): Siri gets the same payment ability as every other AI. At Siri connect approval (phone Face ID) the server
// issues ONE Siri-scoped, revocable agent credential (agentId 'siri'). The app keeps it in the Keychain (this device only, unlocked).
// It only authorizes POST /siri/buy (the same kipurse_buy path, limits, trust list, 0.1% fee, duplicate protection as other AIs).
// Only its SHA-256 is stored; it is bound to the phone signer that approved it (a new / revoked phone voids it).
// Revoked by: Siri disconnect (agent stop), owner emergency stop / pause, a newer Siri approval (replaced), account erase.
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
export const SIRI_CRED_RE=/^ksc_[A-Za-z0-9_-]{43}$/;
const sha=t=>createHash('sha256').update(String(t)).digest('hex');
const PENDING_TTL_MS=7*86400e3,PENDING_MAX=20;
export function createSiriCred({store,save=()=>{},phoneFp=()=>null,now=()=>Date.now(),log=()=>{}}){
  const S=store;
  function issue(){const fp=phoneFp();if(!fp)return null;const t='ksc_'+randomBytes(32).toString('base64url');S.siriCred={h:sha(t),fp:String(fp),at:now()};save();try{log('siri_cred_issue',{});}catch{}return t;}
  function tokenOf(req){const t=String(req?.headers?.authorization??'').replace(/^Bearer\s+/i,'');return SIRI_CRED_RE.test(t)?t:null;}
  /** true only for the live credential of the CURRENT phone signer. */
  function check(req){const t=tokenOf(req);const c=S.siriCred;if(!t||!c?.h)return false;const a=Buffer.from(sha(t),'hex'),b=Buffer.from(c.h,'hex');
    if(a.length!==b.length||!timingSafeEqual(a,b))return false;const fp=phoneFp();return !!fp&&String(fp)===c.fp;}
  function revoke(reason='revoked'){const had=!!S.siriCred;if(had){delete S.siriCred;}if(S.siriPending)S.siriPending={};if(had)save();try{if(had)log('siri_cred_revoke',{reason:String(reason).slice(0,40)});}catch{}return had;}
  const status=()=>({issued:!!S.siriCred,at:S.siriCred?.at??null});
  /** over-limit / new payee: remember the exact Siri request so the owner's Face ID approval completes it (Siri cannot retry). */
  function remember(approvalId,args){if(!approvalId||!args)return;const P=S.siriPending??={};const n=now();for(const [k,v] of Object.entries(P))if(n-v.at>PENDING_TTL_MS)delete P[k];
    const keys=Object.keys(P);if(keys.length>=PENDING_MAX)delete P[keys.sort((x,y)=>P[x].at-P[y].at)[0]];P[String(approvalId)]={args,at:n};save();}
  function take(approvalId){const P=S.siriPending;const v=P?.[String(approvalId)];if(!v)return null;delete P[String(approvalId)];save();return now()-v.at>PENDING_TTL_MS?null:v.args;}
  return {issue,check,revoke,status,remember,take,tokenOf};}
