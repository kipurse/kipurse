// SIRI = a FREE, server-authorized agent (agentId 'siri'), exactly like Claude / Grok Bot / Muse: the owner's purpose allowances,
// trust list, per-agent cap / stop, the global pause and the 0.1% protocol fee + at-cost gas all apply through kipurse_buy.
// Auth = the phone session (the enrolled phone's device auth); NO on-chain write and no upgrade fee. Anything beyond the
// allowance comes back as ask_owner -> the normal Face ID push flow. The app requires the device to be unlocked to run it.
import {createBuy} from './buy.mjs';
export const SIRI_ID='siri';
const PICK=['purpose','item','what','merchant','payee_name','user_request','amount','budget','max_price','url','method','to','payee','idempotencyKey','orderRef','lang','reason'];
export function siriArgs(b){const o={};for(const k of PICK)if(b?.[k]!==undefined&&b[k]!==null){const v=b[k];if(typeof v==='string')o[k]=v.slice(0,k==='url'?2000:300);else if(typeof v==='number'&&Number.isFinite(v))o[k]=String(v);}
  if(o.url&&!/^https:\/\//i.test(o.url))delete o.url;if(o.method&&!['GET','POST'].includes(String(o.method).toUpperCase()))delete o.method;return o;}
/** t1158 (decision 77 B): Siri may name a saved payee (trust list / paid before / owner-approved). The SERVER resolves the name from its
 *  own address book (the app's address is not trusted for a name): exactly one trusted / verified entry -> kipurse_buy's own
 *  resolvePayeeName (pays inside the limits); exactly one still-unverified entry -> its address as a plain payee (engine: ask_owner, Face ID push).
 *  No match / several matches -> left to kipurse_buy, which answers ask_owner + "who should I pay?" and pays nothing. */
export function siriPayee(a,E){if(a.to||a.payment||!a.payee_name)return a;let m=[];try{const n=String(a.payee_name).trim().toLowerCase();m=(E.addressBook?.()??[]).filter(x=>String(x.name??'').trim().toLowerCase()===n);}catch{m=[];}
  if(m.length!==1||m[0].status!=='new')return a;/* trusted / verified: kipurse_buy resolves the name itself (resolvePayeeName), unchanged */
  const {payee_name,...rest}=a;return {...rest,to:m[0].address,merchant:a.merchant??m[0].name};}/* saved but not verified: plain address, no trusted-source claim -> engine asks the owner */
export function createSiriAgent(E,{buyFactory=createBuy}={}){let B=null;const b=()=>B??=buyFactory(E);
  return {id:SIRI_ID,
    /** t1158: the owner approved (Face ID) a Siri payment that was over the limit / to a new payee. Siri cannot retry by itself, so the
     *  server completes exactly that request once: derived key (same key again = replay, never a second payment), same orderRef. */
    async complete(args){const k=String(args?.idempotencyKey??'');if(!/^[A-Za-z0-9._:-]{8,120}$/.test(k))return {decision:'refuse',state:'rejected',reason:'idempotency_key_required'};
      return b().buy({...siriPayee(siriArgs(args),E),idempotencyKey:k+':a',orderRef:String(args?.orderRef??k).slice(0,300)},SIRI_ID);},
    async handle(path,body,{authed,seen}={}){if(!authed)return [401,{error:'phone_session_required'}];
      if(path==='/siri/buy'){const a=siriPayee(siriArgs(body),E);if(!a.purpose&&!a.item)return [400,{error:'item_required'}];seen?.(SIRI_ID);return [200,await b().buy(a,SIRI_ID)];}
      if(path==='/siri/status'||path==='/siri/allowances')seen?.(SIRI_ID);
      if(path==='/siri/status'){const k=String(body?.purchaseKey??'');if(!k)return [400,{error:'purchase_key_required'}];return [200,await b().orderStatus({purchaseKey:k,lang:body?.lang},SIRI_ID)];}
      if(path==='/siri/allowances')return [200,b().allowances(SIRI_ID)];
      return [404,{error:'not_found'}];}};}
