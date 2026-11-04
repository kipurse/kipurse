// t609u Layer 2: EVERYDAY LIMITS (日常额度). Stored on the server, set only from the owner's phone session
// (device key + Face ID), free and instant. Enforced in the engine before any signing. ALWAYS <= the on-chain
// floor (Layer 1): anything higher is rejected on save and clamped on read (locked invariant).
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
export function createEverydayLimits({kv,wallet,floor,now=()=>Date.now()}){
  const K=kvKey('everyday',null,String(wallet).toLowerCase());
  const raw=()=>{try{const s=kv.get(K);return s?(typeof s==='string'?JSON.parse(s):s):null;}catch{return null;}};
  const fl=()=>{const f=floor();return {single:BigInt(f.single),daily:BigInt(f.daily)};};
  function get(){const r=raw(),f=fl();const e=clampEveryday({single:r?.single!=null?BigInt(r.single):null,daily:r?.daily!=null?BigInt(r.daily):null},f);
    return {single:e.single.toString(),daily:e.daily.toString(),floor:{single:f.single.toString(),daily:f.daily.toString()},custom:!!r,at:r?.at??null};}
  function set({single,daily}){const s=B(single),d=B(daily),f=fl();
    if(s===null||d===null)return {ok:false,error:'bad_amount'};
    if(s>d)return {ok:false,error:'single_above_daily'};
    if(s>f.single||d>f.daily)return {ok:false,error:'above_floor',floor:{single:f.single.toString(),daily:f.daily.toString()},cost:{free:false,layer:'floor'},why:EVERYDAY_WHY};
    kv.set(K,{single:s.toString(),daily:d.toString(),at:now()});return {ok:true,free:true,feeUSDC:'0',...get()};}
  /** Engine hook: null = go; else rejection (nothing paid). spent24h = rolling outflow already paid. */
  function check({amount,spent24h=0n}){if(amount===undefined||amount===null)return null;const e=get(),a=BigInt(amount);
    if(a>BigInt(e.single))return {state:'rejected',reason:'EVERYDAY_SINGLE_LIMIT',nothingPaid:true,capHit:true,limit:e.single,fix:'Over the owner’s everyday per-payment limit. Only the owner can raise it in the Kipurse app (Face ID).',say_to_user:'没有付款：超过了你设的日常单笔额度。可以在 App 里免费调高（在链上底线以内）。/ Not paid: over your everyday per-payment limit. You can raise it for free in the app (up to the on-chain floor).'};
    if(BigInt(spent24h)+a>BigInt(e.daily))return {state:'rejected',reason:'EVERYDAY_DAILY_LIMIT',nothingPaid:true,capHit:true,limit:e.daily,fix:'Over the owner’s everyday 24h limit. Only the owner can raise it in the Kipurse app (Face ID).',say_to_user:'没有付款：超过了你设的日常额度（24 小时内）。可以在 App 里免费调高（在链上底线以内）。/ Not paid: over your everyday limit for 24h. You can raise it for free in the app (up to the on-chain floor).'};
    return null;}
  return {get,set,check,forget:()=>{try{kv.del?.(K);}catch{}return {ok:true};}};}
