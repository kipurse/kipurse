// SIRI = a FREE, server-authorized agent (agentId 'siri'), exactly like Claude / Grok Bot / Muse: the owner's purpose allowances,
// trust list, per-agent cap / stop, the global pause and the 0.1% protocol fee + at-cost gas all apply through kipurse_buy.
// Auth = the phone session (the enrolled phone's device auth); NO on-chain write and no upgrade fee. Anything beyond the
// allowance comes back as ask_owner -> the normal Face ID push flow. The app requires the device to be unlocked to run it.
import {createBuy} from './buy.mjs';
export const SIRI_ID='siri';
const PICK=['purpose','item','what','merchant','payee_name','user_request','amount','budget','max_price','url','method','to','payee','idempotencyKey','lang','reason'];
export function siriArgs(b){const o={};for(const k of PICK)if(b?.[k]!==undefined&&b[k]!==null){const v=b[k];if(typeof v==='string')o[k]=v.slice(0,k==='url'?2000:300);else if(typeof v==='number'&&Number.isFinite(v))o[k]=String(v);}
  if(o.url&&!/^https:\/\//i.test(o.url))delete o.url;if(o.method&&!['GET','POST'].includes(String(o.method).toUpperCase()))delete o.method;return o;}
export function createSiriAgent(E,{buyFactory=createBuy}={}){let B=null;const b=()=>B??=buyFactory(E);
  return {id:SIRI_ID,
    async handle(path,body,{authed,seen}={}){if(!authed)return [401,{error:'phone_session_required'}];
      if(path==='/siri/buy'){const a=siriArgs(body);if(!a.purpose&&!a.item)return [400,{error:'item_required'}];seen?.(SIRI_ID);return [200,await b().buy(a,SIRI_ID)];}
      if(path==='/siri/status'||path==='/siri/allowances')seen?.(SIRI_ID);
      if(path==='/siri/status'){const k=String(body?.purchaseKey??'');if(!k)return [400,{error:'purchase_key_required'}];return [200,await b().orderStatus({purchaseKey:k,lang:body?.lang},SIRI_ID)];}
      if(path==='/siri/allowances')return [200,b().allowances(SIRI_ID)];
      return [404,{error:'not_found'}];}};}
