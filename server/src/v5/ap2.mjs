// AP2 (Agent Payments Protocol, ap2-protocol.org, current spec: Checkout / Payment Mandates as SD-JWT credentials).
// Kipurse maps an AP2 Payment Mandate onto its OWN rules and never loosens them:
//   - the OPEN Payment Mandate (vct mandate.payment.open.1) must be issued by the owner's trusted surface (owner P-256 key, the
//     Kipurse app / phone key) and carry cnf.jwk = the agent key;
//   - the CLOSED Payment Mandate (vct mandate.payment.1, kb+sd-jwt) must be signed by that agent key and bind the open one (sd_hash);
//   - every AP2 constraint is checked (fail closed on unknown types), THEN the payment goes through the normal pay entry, so the
//     single overall limit, new-payee Face ID, scam blocks, 0.1% fee and actual gas all still apply. AP2 can only make a payment
//     stricter, never approve something Kipurse would refuse.
// TESTNET / LOCAL ONLY for now: not wired into the production MCP tool list.
import {createHash,webcrypto} from 'node:crypto';import {isAddress,getAddress} from 'viem';
export const AP2_VCT={openPayment:'mandate.payment.open.1',payment:'mandate.payment.1',openCheckout:'mandate.checkout.open.1',checkout:'mandate.checkout.1'};
const KNOWN=new Set(['payment.amount_range','payment.allowed_payees','payment.budget','payment.agent_recurrence','payment.execution_date','payment.allowed_payment_instruments','payment.allowed_pisps','payment.reference']);
const FREQ_S={ON_DEMAND:0,DAILY:86400,WEEKLY:7*86400,BIWEEKLY:14*86400,MONTHLY:28*86400,QUARTERLY:89*86400,ANNUALLY:365*86400};
const b64u=s=>Buffer.from(s,'base64url');const sha=s=>createHash('sha256').update(s).digest('base64url');
const rej=(code,detail)=>({ok:false,code,...(detail!==undefined?{detail:String(detail)}:{})});
const jsonOf=s=>{try{return JSON.parse(b64u(s).toString('utf8'));}catch{return undefined;}};
/** Split one SD-JWT (issuer JWT ~ disclosures ~). */
export function parseSdJwt(str){const parts=String(str).split('~');const jwt=parts[0];const [h,p,s]=jwt.split('.');
  const header=jsonOf(h),payload=jsonOf(p);if(!header||!payload||!s)return null;
  const disclosures=parts.slice(1).filter(Boolean).map(b=>{const v=jsonOf(b);return Array.isArray(v)&&v.length>=2?{b64:b,digest:sha(b),salt:v[0],value:v.length===2?v[1]:v[2],name:v.length===3?v[1]:undefined}:null;});
  if(disclosures.some(d=>!d))return null;return {header,payload,sig:s,signingInput:h+'.'+p,disclosures};}
/** Replace {"...": digest} references with their disclosed values (recursively). Undisclosed references stay as {"...": d}. */
function resolve(v,map,depth=0){if(depth>16)throw Error('ap2_too_deep');if(Array.isArray(v))return v.map(x=>resolve(x,map,depth+1));
  if(v&&typeof v==='object'){if(Object.keys(v).length===1&&typeof v['...']==='string')return map.has(v['...'])?resolve(map.get(v['...']),map,depth+1):v;
    const o={};for(const [k,x] of Object.entries(v))o[k]=resolve(x,map,depth+1);return o;}return v;}
export async function verifyEs256(jwk,signingInput,sig){try{if(jwk?.kty!=='EC'||jwk?.crv!=='P-256')return false;
  const k=await webcrypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y},{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  return await webcrypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},k,b64u(sig),Buffer.from(signingInput));}catch{return false;}}
const sameJwk=(a,b)=>a&&b&&a.x===b.x&&a.y===b.y&&a.crv===b.crv;
/** Amount -> USDC atomic (6 dp). USDC minor units = 6; USD minor units = 2 (1 USD = 1 USDC). Others refused. */
export function atomicOfAmount(a){const n=a?.amount;if(!Number.isSafeInteger(n)||n<=0)return undefined;
  if(a.currency==='USDC')return BigInt(n);if(a.currency==='USD')return BigInt(n)*10_000n;return undefined;}
const boundAtomic=(n,cur)=>cur==='USDC'?BigInt(Math.round(Number(n))):cur==='USD'?BigInt(Math.round(Number(n)))*10_000n:undefined;
const payeeMatch=(p,m)=>m&&!m['...']&&((m.id!==undefined&&String(m.id).toLowerCase()===String(p.id).toLowerCase())||(m.website&&p.website&&m.website===p.website&&m.id===undefined));

/** createAp2({db, ownerKeys, aud, now}) -> {verify(token), record(v), pay(buy, token, agentId)} */
export function createAp2({db,ownerKeys=[],aud='kipurse',now=()=>Math.floor(Date.now()/1000),maxKbAgeSec=300,chainId=84532}={}){
  if(db)db.exec(`CREATE TABLE IF NOT EXISTS ap2_usage(closed_hash TEXT PRIMARY KEY, open_hash TEXT NOT NULL, amount TEXT NOT NULL, at INTEGER NOT NULL, purchase_key TEXT)`);
  const used=new Map();// fallback when no db
  const history=oh=>db?db.prepare(`SELECT amount,at FROM ap2_usage WHERE open_hash=? ORDER BY at`).all(oh):[...used.values()].filter(u=>u.open_hash===oh);
  const seen=ch=>db?!!db.prepare(`SELECT 1 FROM ap2_usage WHERE closed_hash=?`).get(ch):used.has(ch);
  async function verify(token){
    const s=String(token??'');const i=s.indexOf('~~');if(i<0)return rej('ap2_closed_mandate_missing','expected <open sd-jwt>~~<closed kb+sd-jwt>');
    const openStr=s.slice(0,i+1),closedStr=s.slice(i+2);const O=parseSdJwt(openStr),C=parseSdJwt(closedStr);if(!O||!C)return rej('ap2_malformed');
    if(O.header.alg!=='ES256'||C.header.alg!=='ES256')return rej('ap2_alg_not_es256');
    // 1) open mandate: issued by the OWNER's trusted surface key
    let issuer=null;for(const k of ownerKeys)if(await verifyEs256(k,O.signingInput,O.sig)){issuer=k;break;}
    if(!issuer)return rej('ap2_open_not_signed_by_owner','the open Payment Mandate must be signed in the Kipurse app (owner key)');
    const om=new Map(O.disclosures.map(d=>[d.digest,d.value]));const open=resolve(O.payload.delegate_payload?.[0],om);
    if(open?.vct!==AP2_VCT.openPayment)return rej('ap2_wrong_vct',open?.vct);
    const t=now();if(open.exp!==undefined&&t>open.exp)return rej('ap2_open_expired');if(open.iat!==undefined&&open.iat>t+60)return rej('ap2_open_not_yet_valid');
    if(!open.cnf?.jwk)return rej('ap2_open_no_agent_key');
    // 2) closed mandate: signed by the agent key from cnf, bound to this exact open mandate
    if(C.header.typ!=='kb+sd-jwt')return rej('ap2_closed_wrong_typ',C.header.typ);
    if(!await verifyEs256(open.cnf.jwk,C.signingInput,C.sig))return rej('ap2_closed_bad_agent_signature');
    if(C.payload.sd_hash!==sha(openStr))return rej('ap2_closed_not_bound_to_open');
    if(aud&&C.payload.aud!==aud)return rej('ap2_wrong_audience',C.payload.aud);
    if(!Number.isSafeInteger(C.payload.iat)||Math.abs(t-C.payload.iat)>maxKbAgeSec)return rej('ap2_closed_stale');
    const cm=new Map(C.disclosures.map(d=>[d.digest,d.value]));const closed=resolve(C.payload.delegate_payload?.[0],cm);
    if(closed?.vct!==AP2_VCT.payment)return rej('ap2_wrong_vct',closed?.vct);
    if(closed.exp!==undefined&&t>closed.exp)return rej('ap2_closed_expired');
    const amount=atomicOfAmount(closed.payment_amount);if(amount===undefined)return rej('ap2_bad_amount','currency must be USDC (6 dp) or USD (2 dp)');
    const payee=closed.payee;if(!payee?.id||!isAddress(String(payee.id),{strict:false}))return rej('ap2_payee_not_onchain','payee.id must be the 0x address on Base');
    if(!closed.transaction_id)return rej('ap2_no_transaction_id');
    const openHash=sha(openStr),closedHash=sha(closedStr);if(seen(closedHash))return rej('ap2_replay');
    // 3) every constraint of the open mandate; unknown types fail closed
    const hist=history(openHash);
    for(const c of open.constraints??[]){if(!KNOWN.has(c?.type))return rej('ap2_unknown_constraint',c?.type);
      switch(c.type){
        case 'payment.amount_range':{if(c.currency!==closed.payment_amount.currency)return rej('ap2_currency_mismatch');const mx=boundAtomic(c.max,c.currency),mn=c.min!==undefined?boundAtomic(c.min,c.currency):0n;
          if(mx===undefined||amount>mx||amount<mn)return rej('ap2_amount_out_of_range');break;}
        case 'payment.allowed_payees':if(!(c.allowed??[]).some(m=>payeeMatch(payee,m)))return rej('ap2_payee_not_allowed');break;
        case 'payment.budget':{const mx=boundAtomic(c.max,c.currency);if(c.currency!==closed.payment_amount.currency||mx===undefined)return rej('ap2_currency_mismatch');
          const spent=hist.reduce((a,h)=>a+BigInt(h.amount),0n);if(spent+amount>mx)return rej('ap2_budget_exceeded');break;}
        case 'payment.agent_recurrence':{const gap=FREQ_S[c.frequency];if(gap===undefined)return rej('ap2_bad_frequency',c.frequency);
          if(c.max_occurrences!==undefined&&hist.length+1>c.max_occurrences)return rej('ap2_max_occurrences');
          if(hist.length&&t-hist.at(-1).at<gap)return rej('ap2_too_soon');break;}
        case 'payment.execution_date':{const ex=closed.execution_date?Date.parse(closed.execution_date)/1000:t;
          if(c.not_before&&ex<Date.parse(c.not_before)/1000)return rej('ap2_not_before');if(c.not_after&&ex>Date.parse(c.not_after)/1000)return rej('ap2_not_after');break;}
        case 'payment.allowed_payment_instruments':if(!(c.allowed??[]).some(x=>x?.id&&x.id===closed.payment_instrument?.id))return rej('ap2_instrument_not_allowed');break;
        case 'payment.allowed_pisps':if(!(c.allowed??[]).some(x=>x?.domain_name&&x.domain_name===closed.pisp?.domain_name))return rej('ap2_pisp_not_allowed');break;
        case 'payment.reference':return rej('ap2_checkout_reference_unsupported','checkout-mandate chains are not supported yet');
      }}
    // single-use open mandates (no recurrence constraint) may be presented once
    if(!(open.constraints??[]).some(c=>c.type==='payment.agent_recurrence')&&hist.length)return rej('ap2_open_mandate_already_used');
    return {ok:true,openHash,closedHash,to:getAddress(String(payee.id).toLowerCase()),amountAtomic:amount,payee,transactionId:closed.transaction_id,instrument:closed.payment_instrument??null,exp:open.exp??null};
  }
  function record(v,purchaseKey){const row={closed_hash:v.closedHash,open_hash:v.openHash,amount:v.amountAtomic.toString(),at:now(),purchase_key:purchaseKey??null};
    if(db)db.prepare(`INSERT INTO ap2_usage(closed_hash,open_hash,amount,at,purchase_key) VALUES(?,?,?,?,?)`).run(row.closed_hash,row.open_hash,row.amount,row.at,row.purchase_key);else used.set(v.closedHash,row);}
  /** Verify, then pay through the NORMAL pay entry (all Kipurse rules apply on top). Usage is recorded only when paid. */
  async function pay(buy,token,agentId,{user_request}={}){const v=await verify(token);if(!v.ok)return {state:'rejected',nothingPaid:true,reason:v.code,detail:v.detail,via:'ap2'};
    const amt=(Number(v.amountAtomic)/1e6).toString();
    const r=await buy.buy({to:v.to,amount:amt,merchant:v.payee.name??v.payee.id,item:'AP2 '+v.transactionId,user_request,merchantOrderId:'ap2:'+v.transactionId,orderRef:'ap2:'+v.transactionId,idempotencyKey:'ap2-'+v.closedHash.slice(0,40)},agentId);
    if(r.state==='paid')record(v,r.purchaseKey);return {...r,via:'ap2',ap2:{openHash:v.openHash,closedHash:v.closedHash,transactionId:v.transactionId}};}
  return {verify,record,pay};
}
