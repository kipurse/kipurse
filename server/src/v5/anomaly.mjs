// SPDX-License-Identifier: AGPL-3.0-only
// ANOMALY AUTO-PAUSE (server side, per wallet). On-chain caps already bound the loss; this stops a misbehaving or stolen agent EARLY:
// too many payment attempts or too many different payees in a short window pauses that wallet's agent payments. The pause holds
// until the owner resumes it with the phone (Face ID) or it expires (default 24 h). Reads/withdrawals are never blocked.
import {kvKey} from './store.mjs';
export const PAY_METHODS=['pay','payAny','payMerchantOrder','payNormalized','paidFetch'];
const payeeOf=a=>{for(const x of a)if(x&&typeof x==='object'){const p=x.payee??x.to??x.recipient??x.url??x.merchant;if(p)return String(p).toLowerCase().slice(0,200);}return null;};
export function createAnomalyGuard({kv,now=()=>Date.now(),windowMs=10*60e3,maxPays=30,maxDaily=200,maxNewPayees=8,pauseMs=24*3600e3,onPause=()=>{}}={}){
  const k=(w,n)=>kvKey('safety',String(w).toLowerCase(),n);
  const st=w=>kv.get(k(w,'v'))??{t:[],p:{},day:{d:'',n:0}};
  function paused(w){const p=kv.get(k(w,'pause'));return p&&(p.until===null||p.until>now())?p:null;}
  /** ms: how long (default pauseMs); null = until the owner resumes. An automatic pause never shortens a longer one; the owner's own choice replaces it. */
  function pause(w,reason,ms=pauseMs){const old=paused(w);const until=ms===null?null:now()+ms;
    if(old&&reason!=='owner_stop'&&(old.until===null||(until!==null&&old.until>until)))return old;
    const p={reason,at:now(),until};kv.put(k(w,'pause'),p,ms===null?undefined:ms);onPause(w,reason);return p;}
  /** Call before a payment attempt. Returns null (go) or the pause record (stop). */
  function check(w,payee){const p=paused(w);if(p)return p;const s=st(w),t=now(),d=new Date(t).toISOString().slice(0,10);
    s.t=s.t.filter(x=>t-x<windowMs);s.t.push(t);if(s.day.d!==d)s.day={d,n:0};s.day.n++;
    for(const [x,ts] of Object.entries(s.p))if(t-ts>windowMs)delete s.p[x];if(payee&&!(payee in s.p))s.p[payee]=t;
    kv.put(k(w,'v'),s,Math.max(windowMs,86400e3));
    if(s.t.length>maxPays)return pause(w,'too_many_payments');if(s.day.n>maxDaily)return pause(w,'daily_payment_count');
    if(Object.keys(s.p).length>maxNewPayees)return pause(w,'too_many_payees');return null;}
  function resume(w){kv.del(k(w,'pause'));kv.del(k(w,'v'));return {ok:true};}
  function forget(w){resume(w);return {ok:true};}
  return {check,paused,pause,resume,forget};}
/** Wrap an engine so agent payment calls go through the guard first. Other methods pass through unchanged. */
export function guardEngine(E,{guard,wallet}){return new Proxy(E,{get(t,key){const v=t[key];if(!PAY_METHODS.includes(key)||typeof v!=='function')return v;
  return async(...a)=>{const p=guard.check(wallet,payeeOf(a));if(p)throw Object.assign(Error(`wallet_paused_for_safety: ${p.reason}. The owner can resume it in the Kipurse app (Face ID); ${p.until===null?'it lasts until the owner resumes it':'it also expires at '+new Date(p.until).toISOString()}.`),{code:'wallet_paused_for_safety'});
    return v.apply(t,a);};}});}
/** The owner's pause choices (app picker). Value = ms, null = until resumed. */
export const PAUSE_CHOICES={'24h':24*3600e3,'48h':48*3600e3,'7d':7*86400e3,'until_resume':null};
export function pauseMsOf(choice){if(choice===undefined||choice===null||choice==='')return PAUSE_CHOICES['24h'];return Object.hasOwn(PAUSE_CHOICES,String(choice))?PAUSE_CHOICES[String(choice)]:undefined;}
