// t609u Layer 2: EVERYDAY LIMITS (日常额度). Stored on the server, set only from the owner's phone session
// (device key + Face ID), free and instant. Enforced in the engine before any signing. ALWAYS <= the on-chain
// floor (Layer 1): anything higher is rejected on save and clamped on read (locked invariant).
// t1073: unset / unconfirmed AI limits authorize nothing. The on-chain floor, a missing row, a historical
// number, or the 10/50/200 display triple is not confirmation. Only a row written by set() counts, and
// that row is never invented for older data that lacks set()'s timestamp.
import {kvKey} from './store.mjs';
export const EVERYDAY_WHY={zh:'底线写在区块链上，就算我们的服务器出问题也突破不了；改它要付网络手续费（约 0.007 USDC），我们不加价。日常额度在底线以下随便改，免费、马上生效。',en:'The floor lives on the blockchain, so even if our servers fail it can’t be broken; changing it costs a network fee (about 0.007 USDC) and we add nothing. Everyday limits can be changed freely under the floor: free and instant.'};
const B=v=>{if(v===null||v===undefined||v==='')return null;const b=BigInt(v);if(b<0n)throw Object.assign(Error('bad_amount'),{code:'bad_amount'});return b;};
const min=(a,b)=>a===null?b:b===null?a:(a<b?a:b);
/** Pure invariant: everyday <= floor for every field. */
export function clampEveryday(ev,floor){return {single:min(ev?.single??null,floor.single),daily:min(ev?.daily??null,floor.daily)};}
/** Free or charged? Changing ONLY everyday limits (<= floor) is free. Changing the floor after the first time costs gas. */
export function changeCost({next,floor,firstFloorDone=true,feeUSDC=null}){
  const above=(next.single!=null&&BigInt(next.single)>BigInt(floor.single))||(next.daily!=null&&BigInt(next.daily)>BigInt(floor.daily));
  if(!above)return {free:true,layer:'everyday',feeUSDC:'0'};
  return {free:!firstFloorDone,layer:'floor',feeUSDC:firstFloorDone?(feeUSDC==null?null:String(feeUSDC)):'0',needsFloorChange:true};}
/** Atomic USDC (6 decimals) -> plain decimal. Null when the value is missing or not a positive integer. */
export function formatAtomic(v){let b;try{b=typeof v==='bigint'?v:BigInt(v);}catch{return null;}if(b<=0n)return null;const whole=b/1000000n,frac=b%1000000n;if(frac===0n)return whole.toString();return `${whole}.${frac.toString().padStart(6,'0').replace(/0+$/,'')}`;}
/** Connect-page amounts. A policy without an explicit total is not authorization.
 *  Display uses the saved amounts. `single`/`daily`/`term` are the clamped caps used for enforcement. */
export function consentSpend(view){
  if(!view||view.authorized!==true)return {authorized:false};
  const rs=view.requestedSingle??view.single,rd=view.requestedDaily??view.daily,rt=view.requestedTerm??view.term;
  let per,day,term;try{per=formatAtomic(rs);day=formatAtomic(rd);term=formatAtomic(rt);
    if(per==null||day==null||term==null)return {authorized:false};}catch{return {authorized:false};}
  return {authorized:true,perPayment:per,perDay:day,termTotal:term,at:view.at??null,
    effectivePerPayment:formatAtomic(view.single),effectivePerDay:formatAtomic(view.daily),effectiveTermTotal:formatAtomic(view.term)};}
const stamp=v=>{if(typeof v==='number'&&Number.isFinite(v))return v;if(typeof v==='string'&&/^\d+$/.test(v)){const n=Number(v);return Number.isFinite(n)?n:null;}return null;};
/** A complete save is single <= daily <= total, plus the timestamp set() writes.
 *  Single and daily without a total are not a policy. Amounts alone, or the chain floor, are not either. */
export function explicitEveryday(r){
  if(!r||typeof r!=='object'||Array.isArray(r)||r.confirmed===false)return null;
  const at=stamp(r.at);if(at==null)return null;
  let s,d,term;try{s=BigInt(r.single);d=BigInt(r.daily);term=BigInt(r.term);}catch{return null;}
  if(s<=0n||d<=0n||term<=0n||s>d||d>term)return null;
  return {single:s,daily:d,term,at};}
const UNCONFIRMED={state:'rejected',reason:'AI_LIMITS_UNCONFIRMED',nothingPaid:true,capHit:true,fix:'AI spending limits are not confirmed. Nothing was paid. The owner sets them in the Kipurse app; there is no default.',say_to_user:'没有付款：AI 总限额还没有确认，不能花钱。请先在启付里自己设置，没有默认额度。/ Not paid: AI spending limits are not confirmed, so nothing can be spent. Set them yourself in Kipurse. There is no default.'};
export function createEverydayLimits({kv,wallet,floor,now=()=>Date.now()}){
  const K=kvKey('everyday',null,String(wallet).toLowerCase());
  const raw=()=>{try{const s=kv.get(K);return s?(typeof s==='string'?JSON.parse(s):s):null;}catch{return null;}};
  const fl=()=>{const f=floor();return {single:BigInt(f.single),daily:BigInt(f.daily),term:f.term==null||f.term===''?null:BigInt(f.term)};};
  const floorOut=f=>({single:f.single.toString(),daily:f.daily.toString(),...(f.term==null?{}:{term:f.term.toString()})});
  const blank=f=>({single:null,daily:null,term:null,requestedSingle:null,requestedDaily:null,requestedTerm:null,floor:floorOut(f),custom:false,authorized:false,explicit:false,clamped:false,at:null});
  function present(row,f){const c=clampEveryday({single:row.single,daily:row.daily},f);let term=row.term;if(term!=null&&f.term!=null&&term>f.term)term=f.term;
    if(c.single==null||c.daily==null||c.single<=0n||c.daily<=0n)return blank(f);
    const clamped=c.single!==row.single||c.daily!==row.daily||(row.term!=null&&term!==row.term);
    return {single:c.single.toString(),daily:c.daily.toString(),term:term==null?null:term.toString(),requestedSingle:row.single.toString(),requestedDaily:row.daily.toString(),requestedTerm:row.term==null?null:row.term.toString(),floor:floorOut(f),custom:true,authorized:true,explicit:true,clamped,at:row.at};}
  function get(){const f=fl(),row=explicitEveryday(raw());return row?present(row,f):blank(f);}
  function set({single,daily,term}={}){const s=B(single),d=B(daily),t=B(term),f=fl();
    if(s===null||d===null||s<=0n||d<=0n)return {ok:false,error:'bad_amount'};
    if(t===null||t<=0n)return {ok:false,error:'term_required'};
    if(s>d)return {ok:false,error:'single_above_daily'};
    if(d>t)return {ok:false,error:'daily_above_term'};
    if(s>f.single||d>f.daily||(f.term!=null&&t>f.term))return {ok:false,error:'above_floor',floor:floorOut(f),cost:{free:false,layer:'floor'},why:EVERYDAY_WHY};
    kv.set(K,{single:s.toString(),daily:d.toString(),term:t.toString(),at:now(),confirmed:true});
    return {ok:true,free:true,feeUSDC:'0',...get()};}
  /** Engine hook. spentTerm is cumulative AI spend already recorded. Missing total or missing spentTerm refuses.
   *  The chain floor is not used as a stand-in budget. */
  function check({amount,spent24h=0n,spentTerm}={}){if(amount===undefined||amount===null)return null;const e=get(),a=BigInt(amount);
    if(!e.authorized||e.single==null||e.daily==null||e.term==null)return UNCONFIRMED;
    if(a>BigInt(e.single))return {state:'rejected',reason:'EVERYDAY_SINGLE_LIMIT',nothingPaid:true,capHit:true,limit:e.single,fix:'Over the owner’s everyday per-payment limit. Only the owner can raise it in the Kipurse app (Face ID).',say_to_user:'没有付款：超过了你设的日常单笔额度。可以在 App 里免费调高（在链上底线以内）。/ Not paid: over your everyday per-payment limit. You can raise it for free in the app (up to the on-chain floor).'};
    if(BigInt(spent24h)+a>BigInt(e.daily))return {state:'rejected',reason:'EVERYDAY_DAILY_LIMIT',nothingPaid:true,capHit:true,limit:e.daily,fix:'Over the owner’s everyday 24h limit. Only the owner can raise it in the Kipurse app (Face ID).',say_to_user:'没有付款：超过了你设的日常额度（24 小时内）。可以在 App 里免费调高（在链上底线以内）。/ Not paid: over your everyday limit for 24h. You can raise it for free in the app (up to the on-chain floor).'};
    if(spentTerm===undefined||spentTerm===null)return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true,fix:'The cumulative total could not be checked. Nothing was paid.',say_to_user:'没有付款：暂时核对不了总额，请稍后再试。/ Not paid: the total limit could not be checked right now.'};
    if(BigInt(spentTerm)+a>BigInt(e.term))return {state:'rejected',reason:'EVERYDAY_TERM_LIMIT',nothingPaid:true,capHit:true,limit:e.term,fix:'Over the owner’s explicit total AI budget. Nothing was paid.',say_to_user:'没有付款：超过了你设的 AI 总额。/ Not paid: over the total you set for AI spending.'};
    return null;}
  return {get,set,check,forget:()=>{try{kv.del?.(K);}catch{}return {ok:true};}};}
