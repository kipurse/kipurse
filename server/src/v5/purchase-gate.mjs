// t635u (owner approved): every Apple Pay / Onramp purchase needs the Coinbase Verified Account attestation for the wallet
// OWNER's Base Account, for existing wallets too (owner's own included). Fail closed: RPC trouble -> no purchase, friendly retry.
// Withdraw, pause and all other money-OUT/safety actions are never gated (they never call this).
import {CBV_GUIDE} from './cb-verified.mjs';import {ttlCache} from './ratelimit.mjs';
export function createPurchaseGate({check,cacheMs=60e3,log=()=>{}}){const C=ttlCache(cacheMs);
  return async function gate(owner,lang='en'){const o=String(owner??'').toLowerCase();const zh=lang==='zh';
    if(!/^0x[0-9a-f]{40}$/.test(o))return [409,{ok:false,error:'not_verified',detail:zh?CBV_GUIDE.zh:CBV_GUIDE.en}];
    if(C.get(o))return null;let r;try{r=await check(o);}catch{r=null;}
    if(!r){log('purchase_gate',{result:'unavailable'});return [503,{ok:false,error:'verify_unavailable',retry:true,detail:zh?'暂时无法确认 Coinbase 验证状态，没有扣钱。请稍后再试。':'We could not check your Coinbase verification right now. Nothing was charged. Please try again shortly.'}];}
    if(r.verified!==true){log('purchase_gate',{result:'not_verified'});return [403,{ok:false,error:'not_verified',verifyUrl:'https://www.coinbase.com/onchain-verify',detail:zh?CBV_GUIDE.zh:CBV_GUIDE.en}];}
    C.set(o,true);return null;};}
