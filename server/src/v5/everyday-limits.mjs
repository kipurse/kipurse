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
/** Connect-page amounts. Never copies the chain floor into an unconfirmed view. */
export function consentSpend(view){
  if(!view||view.authorized!==true||view.single==null||view.daily==null)return {authorized:false};
  let per,day,term=null;try{per=formatAtomic(view.single);day=formatAtomic(view.daily);if(per==null||day==null)return {authorized:false};
    if(view.term!=null&&view.term!==''){term=formatAtomic(view.term);if(term==null)return {authorized:false};}}catch{return {authorized:false};}
  return {authorized:true,perPayment:per,perDay:day,termTotal:term,at:view.at??null};}
/** A stored row is an explicit owner save only when set() wrote it: positive single <= daily, and a finite `at`.
 *  Amounts alone, `confirmed:true` alone, or a copy of 10/50/200 do not qualify. `confirmed:false` never qualifies. */
export function explicitEveryday(r){
  if(!r||typeof r!=='object'||Array.isArray(r)||r.confirmed===false)return null;
  if(typeof r.at!=='number'||!Number.isFinite(r.at))return null;
  let s,d,term=null;try{s=BigInt(r.single);d=BigInt(r.daily);}catch{return null;}
  if(s<=0n||d<=0n||s>d)return null;
  if(r.term!=null&&r.term!==''){try{term=BigInt(r.term);}catch{return null;}if(term<=0n||term<d)return null;}
  return {single:s,daily:d,term,at:r.at};}
const UNCONFIRMED={state:'rejected',reason:'AI_LIMITS_UNCONFIRMED',nothingPaid:true,capHit:true,fix:'AI spending limits are not confirmed. Nothing was paid. The owner sets them in the Kipurse app; there is no default.',say_to_user:'没有付款：AI 总限额还没有确认，不能花钱。请先在启付里自己设置，没有默认额度。/ Not paid: AI spending limits are not confirmed, so nothing can be spent. Set them yourself in Kipurse. There is no default.'};
export function createEverydayLimits({kv,wallet,floor,now=()=>Date.now()}){
  const K=kvKey('everyday',null,String(wallet).toLowerCase());
  const raw=()=>{try{const s=kv.get(K);return s?(typeof s==='string'?JSON.parse(s):s):null;}catch{return null;}};
  const fl=()=>{const f=floor();return {single:BigInt(f.single),daily:BigInt(f.daily),term:f.term==null||f.term===''?null:BigInt(f.term)};};
  const floorOut=f=>({single:f.single.toString(),daily:f.daily.toString(),...(f.term==null?{}:{term:f.term.toString()})});
  const blank=f=>({single:null,daily:null,term:null,floor:floorOut(f),custom:false,authorized:false,explicit:false,at:null});
  function get(){const f=fl(),row=explicitEveryday(raw());if(!row)return blank(f);
    const c=clampEveryday({single:row.single,daily:row.daily},f);let term=row.term;if(term!=null&&f.term!=null&&term>f.term)term=f.term;
    if(c.single==null||c.daily==null||c.single<=0n||c.daily<=0n)return blank(f);
    return {single:c.single.toString(),daily:c.daily.toString(),term:term==null?null:term.toString(),floor:floorOut(f),custom:true,authorized:true,explicit:true,at:row.at};}
  function set({single,daily,term}={}){const s=B(single),d=B(daily),f=fl();
    if(s===null||d===null||s<=0n||d<=0n)return {ok:false,error:'bad_amount'};
    if(s>d)return {ok:false,error:'single_above_daily'};
    let t=null;if(term!=null&&term!==''){t=B(term);if(t===null||t<=0n)return {ok:false,error:'bad_amount'};if(t<d)return {ok:false,error:'daily_above_term'};}
    if(s>f.single||d>f.daily||(t!=null&&f.term!=null&&t>f.term))return {ok:false,error:'above_floor',floor:floorOut(f),cost:{free:false,layer:'floor'},why:EVERYDAY_WHY};
    const row={single:s.toString(),daily:d.toString(),at:now(),confirmed:true};if(t!=null)row.term=t.toString();
    kv.set(K,row);return {ok:true,free:true,feeUSDC:'0',...get()};}
  /** Engine hook: null = go; else rejection (nothing paid). spent24h = rolling outflow already paid.
   *  Unconfirmed limits reject. They are not replaced with the floor. */
  function check({amount,spent24h=0n}){if(amount===undefined||amount===null)return null;const e=get(),a=BigInt(amount);
    if(!e.authorized||e.single==null||e.daily==null)return UNCONFIRMED;
    if(a>BigInt(e.single))return {state:'rejected',reason:'EVERYDAY_SINGLE_LIMIT',nothingPaid:true,capHit:true,limit:e.single,fix:'Over the owner’s everyday per-payment limit. Only the owner can raise it in the Kipurse app (Face ID).',say_to_user:'没有付款：超过了你设的日常单笔额度。可以在 App 里免费调高（在链上底线以内）。/ Not paid: over your everyday per-payment limit. You can raise it for free in the app (up to the on-chain floor).'};
    if(BigInt(spent24h)+a>BigInt(e.daily))return {state:'rejected',reason:'EVERYDAY_DAILY_LIMIT',nothingPaid:true,capHit:true,limit:e.daily,fix:'Over the owner’s everyday 24h limit. Only the owner can raise it in the Kipurse app (Face ID).',say_to_user:'没有付款：超过了你设的日常额度（24 小时内）。可以在 App 里免费调高（在链上底线以内）。/ Not paid: over your everyday limit for 24h. You can raise it for free in the app (up to the on-chain floor).'};
    return null;}
  return {get,set,check,forget:()=>{try{kv.del?.(K);}catch{}return {ok:true};}};}
