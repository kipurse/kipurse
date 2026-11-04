// SPDX-License-Identifier: AGPL-3.0-only
// Sponsored NEW-USER onboarding (ERC-7677 paymaster proxy). Kipurse pays gas for exactly ONE thing: the first "开通" batch of a
// Base Account that has no Kipurse wallet yet, and only if every call is byte-identical to the batch the server prepared for it
// (factory createAccount, deterministic deployer, the new wallet's own setup calls). Everything else stays user-paid.
// OFF unless the operator created the paymaster env file. The upstream URL is never logged, returned, or put in error text.
import {decodeFunctionData,parseAbi,getAddress,keccak256,encodeAbiParameters} from 'viem';
const EXEC=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)','function execute(address target,uint256 value,bytes data)']);
/** Decode a smart-account callData (executeBatch or single execute) into [{to,value,data}]. */
export function decodeAccountCalls(callData){const d=decodeFunctionData({abi:EXEC,data:callData});return d.functionName==='execute'?[{to:d.args[0],value:d.args[1],data:d.args[2]}]:d.args[0].map(c=>({to:c.target,value:c.value,data:c.data}));}
/** Owner decision t603u (2026-10-27): the FIRST AI-limit authorization after install is part of onboarding and free (one per owner, ever, same caps). */
export const FIRST_LIMITS_PREFIX='lim-';
/** t752 (owner): withdraw-all pays its network fee from the WALLET's own USDC. Kipurse's paymaster fronts the gas only if the batch
 *  is byte-identical to the prepared plan AND that plan repays at least the gas cost in USDC to the fixed fee address in the same op. */
export const WITHDRAW_PREFIX='wd-';
/** t906: phone (Face ID approver) enrollment, wallet-pays: the sponsor fronts gas, the SAME batch repays the fee from the Kipurse wallet. */
export const ENROLL_PREFIX='pe-';export const ENROLL_REAL_GAS=1_800_000n;
export const ENTRYPOINTS=['0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789','0x0000000071727De22E5E9d8BAf0edAc6f37da032','0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'].map(a=>a.toLowerCase());
const lc=a=>String(a??'').toLowerCase();
/** Canonical hash of a call list ({to,value,data}) so the proxy can compare the user op with what prepare() returned. */
export function callsHash(calls){return keccak256(encodeAbiParameters([{type:'tuple[]',components:[{name:'t',type:'address'},{name:'v',type:'uint256'},{name:'d',type:'bytes'}]}],
  [calls.map(c=>({t:getAddress(c.to),v:BigInt(c.value??0),d:c.data??'0x'}))]));}
export function sponsorConfig(env=process.env){const url=String(env.KIPURSE_ONBOARD_PAYMASTER_URL??'').trim();const n=(k,d)=>{const v=Number(env[k]);return Number.isFinite(v)&&v>=0?v:d;};
  return {url:/^https:\/\/\S+$/.test(url)?url:null,maxPerDay:n('KIPURSE_SPONSOR_MAX_PER_DAY',20),maxUsdPerDay:n('KIPURSE_SPONSOR_MAX_USD_PER_DAY',2),maxUsdPerOp:n('KIPURSE_SPONSOR_MAX_USD_PER_OP',0.25)};}
/**
 * cfg: {url,maxPerDay,maxUsdPerDay,maxUsdPerOp}; kv; reg (byOwner); ethUsd8: async()=>bigint (Chainlink 8 dp); fetch; obs; now; chainId.
 * lookup(id) -> the prepared onboarding record {state,kind,owner,expect,wallet,callsHash,allowed:[addr]} (or undefined).
 */
/** t763u: realistic gas of a sponsored Base Account (v0.6, 7702) withdraw op: measured 248,864 on 2026-10-29 (tx 0x1dcf38fd…); +20% headroom. */
export const WITHDRAW_REAL_GAS=300_000n;
/** t852 (owner): ONE fixed account-opening fee, the same for every user, owed once and collected once (whole, in one op: = the fee slot cap).
 *  Measured 2026-10-25 (tx 0x2fa85124…, wallet 0xdEaD…): actualGasCost 15,806,082,500,000 wei = ~0.0355 USD at 2,244.76 USD/ETH.
 *  Any difference between the real cost and this amount is Kipurse's (absorbed), never the user's. */
export const ONBOARD_FEE_USDC=50_000n;
// t854 (owner approved): wallets opened before the fixed fee existed are waived — never charged the opening fee.
// the owner wallet was never sponsored (owes nothing); 0xdEaD… was sponsored 2026-10-25, waived (Kipurse absorbs ~$0.035).
export const ONBOARD_FEE_WAIVED=Object.freeze({'0x000000000000000000000000000000000000dead':'waived-t854'});
export const onboardFeeWaived=(w)=>!!w&&Object.prototype.hasOwnProperty.call(ONBOARD_FEE_WAIVED,String(w).toLowerCase());
export function createOnboardSponsor({cfg,kv,reg,ethUsd8,lookup,fetchImpl=globalThis.fetch,obs,now=()=>Date.now(),chainId=8453,reserveMs=30*60e3,gasPrice=null}){
  // t763u: everything Kipurse fronts is owed by the wallet and collected from its first outgoing batch (withdraw or payment). Kipurse never keeps a cost.
  const DUE=w=>'dues:'+lc(w);
  function dues(wallet){const d=kv.get(DUE(wallet));return d?BigInt(d.owed)-BigInt(d.paid):0n;}
  function addDue(wallet,usdc,reason){if(!wallet||usdc<=0n)return;if(reason==='onboarding_fee'&&onboardFeeWaived(wallet))return;const d=kv.get(DUE(wallet))??{owed:'0',paid:'0',items:[]};kv.put(DUE(wallet),{owed:String(BigInt(d.owed)+usdc),paid:d.paid,items:[...(d.items??[]).slice(-20),{reason,usdc:String(usdc),at:now()}]});}
  function payDue(wallet,usdc){const d=kv.get(DUE(wallet));if(!d||usdc<=0n)return 0n;const open=BigInt(d.owed)-BigInt(d.paid);const take=usdc<open?usdc:open;kv.put(DUE(wallet),{...d,paid:String(BigInt(d.paid)+take)});return take;}
  const enabled=!!cfg?.url;const LIM=id=>'sponsor:limrec:'+id,FL=o=>'sponsor:firstlimits:'+lc(o);const OWN0=o=>'sponsor:owner:'+lc(o),DAY=()=>'sponsor:day:'+new Date(now()).toISOString().slice(0,10),SEEN=id=>'sponsor:op:'+id;
  const log=r=>{try{obs?.log?.('onboard_sponsor',{reason:r});}catch{}};
  const day=()=>kv.get(DAY())??{n:0,usd:0};const isLim=id=>String(id).startsWith(FIRST_LIMITS_PREFIX);const isWd=id=>String(id).startsWith(WITHDRAW_PREFIX)||String(id).startsWith(ENROLL_PREFIX);const isPe=id=>String(id).startsWith(ENROLL_PREFIX);const WDR=id=>'sponsor:wdrec:'+id;
  const OWN=(o,id)=>id!==undefined&&isWd(id)?'sponsor:wdown:'+id:id!==undefined&&isLim(id)?FL(o):OWN0(o);
  const rec=id=>isWd(id)?kv.get(WDR(id)):isLim(id)?kv.get(LIM(id)):lookup(id);
  const kindOf=id=>isPe(id)?'phone_enroll':isWd(id)?'withdraw':isLim(id)?'first_limits':'new';
  /** Wallet-pays withdraw possible right now (sponsor on, daily caps not used up)? Not once-per-owner: every withdraw repays itself. */
  function withdrawAvailable(){if(!enabled)return false;const d=day();return d.n<cfg.maxPerDay&&d.usd<cfg.maxUsdPerDay;}
  /** Register the exact prepared withdraw batch. reimburse = USDC (6 dp) the batch pays to the fee address. Returns sponsor id or null. */
  function registerWithdraw(planId,{owner,wallet,calls,reimburse}){if(!withdrawAvailable())return null;const id=WITHDRAW_PREFIX+String(planId);
    kv.put(WDR(id),{state:'prepared',kind:'withdraw',owner:getAddress(owner),expect:getAddress(owner),wallet:getAddress(wallet),allowed:[getAddress(wallet)],callsHash:callsHash(calls),reimburse:String(BigInt(reimburse))},2*3600e3);return id;}
  /** t906: register the exact enrollment batch (owner's Base Account only signs; reimburse = fee the batch pays the fee address). Same caps. */
  function registerEnroll(enrollId,{owner,wallet,calls,reimburse}){if(!withdrawAvailable())return null;const id=ENROLL_PREFIX+String(enrollId);
    kv.put(WDR(id),{state:'prepared',kind:'phone_enroll',owner:getAddress(owner),expect:getAddress(owner),wallet:getAddress(wallet),allowed:[getAddress(wallet),'0x4e59b44847b379578588920cA78FbF26c0B4956C'],callsHash:callsHash(calls),reimburse:String(BigInt(reimburse))},2*3600e3);return id;}
  /** Free first limits authorization still possible for this (already onboarded) owner? Same daily caps; never raised. */
  function firstLimitsAvailable(owner){if(!enabled)return false;let o;try{o=getAddress(owner);}catch{return false;}const s=kv.get(FL(o));if(s?.state==='done')return false;
    const d=day();return d.n<cfg.maxPerDay&&d.usd<cfg.maxUsdPerDay;}
  /** Register the exact prepared limits batch (owner's Base Account -> wallet) for sponsorship. Returns the sponsor id or null. */
  function registerFirstLimits(planId,{owner,wallet,calls}){if(!firstLimitsAvailable(owner))return null;const id=FIRST_LIMITS_PREFIX+String(planId);
    kv.put(LIM(id),{state:'prepared',kind:'first_limits',owner:getAddress(owner),expect:getAddress(owner),wallet:getAddress(wallet),allowed:[getAddress(wallet)],callsHash:callsHash(calls)},2*3600e3);return id;}
  function markFirstLimitsDone(owner){if(!enabled)return;try{kv.put(FL(getAddress(owner)),{state:'done',at:now()});}catch{}}
  /** Is a sponsored onboarding still possible for this owner (no wallet yet, never sponsored, caps not used up)? */
  function available(owner){if(!enabled)return false;let o;try{o=getAddress(owner);}catch{return false;}
    if(reg?.byOwner?.(o)?.length)return false;const s=kv.get(OWN(o));if(s?.state==='done')return false;
    const d=day();return d.n<cfg.maxPerDay&&d.usd<cfg.maxUsdPerDay;}
  /** Gate one ERC-7677 request. Returns null if allowed, else a short reason code. Pure checks + reservation for pm_getPaymasterData. */
  async function gate(id,method,params){
    if(!enabled)return 'disabled';if(method!=='pm_getPaymasterStubData'&&method!=='pm_getPaymasterData')return 'method';
    const [op,ep,ch]=Array.isArray(params)?params:[];if(!op||typeof op!=='object')return 'bad_op';
    if(!ENTRYPOINTS.includes(lc(ep)))return 'entrypoint';if(Number(BigInt(ch??0))!==chainId)return 'chain';
    const o=rec(id);if(!o||o.state!=='prepared'||o.kind!==kindOf(id))return 'not_prepared';
    if(!o.expect||lc(o.expect)!==lc(o.owner))return 'not_signed_in';if(lc(op.sender)!==lc(o.owner))return 'sender';
    if(!(isWd(id)?withdrawAvailable():isLim(id)?firstLimitsAvailable(o.owner):available(o.owner))&&kv.get(SEEN(id))===undefined)return 'unavailable';
    let calls;try{calls=decodeAccountCalls(op.callData);}catch{return 'calldata';}
    const allow=new Set((o.allowed??[]).map(lc));if(!calls.length||calls.some(c=>!allow.has(lc(c.to))||BigInt(c.value)!==0n))return 'target';
    if(callsHash(calls)!==o.callsHash)return 'calls_mismatch';
    const s=kv.get(OWN(o.owner,id));if(s?.state==='done')return 'already';if(s?.state==='reserved'&&s.id!==id&&now()-s.at<reserveMs)return 'busy';
    if(method==='pm_getPaymasterStubData')return null;
    // final data: cost check + caps + reservation (counted once per onboarding id)
    const g=['callGasLimit','verificationGasLimit','preVerificationGas','paymasterVerificationGasLimit','paymasterPostOpGasLimit'].reduce((a,k)=>a+BigInt(op[k]??0),0n)+100000n;
    const fee=BigInt(op.maxFeePerGas??0);if(fee<=0n)return 'gas_price';const usd=Number(g*fee*BigInt(await ethUsd8())/10n**18n)/1e8;
    if(usd>cfg.maxUsdPerOp)return 'op_cap';
    // t758: no 'underpaid' check here: `usd` is the WORST case (all gas limits x maxFeePerGas, incl. Base L1 data in preVerificationGas), many times the real
    // cost, so it refused every real withdraw. The wallet repays the quoted real cost in USDC; Kipurse's exposure stays bounded by op_cap + day caps (unchanged).
    if(isWd(id)&&gasPrice){let gp=null;try{gp=BigInt(await gasPrice());}catch{}if(gp===null)return 'gas_price';
      const real=Number((isPe(id)?ENROLL_REAL_GAS*gp:WITHDRAW_REAL_GAS*gp*11n/10n)*BigInt(await ethUsd8())/10n**18n)/1e8;   // enroll fee = UPGRADE_GAS x price + L1 allowance, at cost   // sane real cost now (+10%), not the worst case
      if(BigInt(Math.ceil(real*1e6))>BigInt(o.reimburse??0))return 'underpaid';}
    if(kv.get(SEEN(id))===undefined){const d=day();if(d.n+1>cfg.maxPerDay||d.usd+usd>cfg.maxUsdPerDay)return 'day_cap';
      kv.put(DAY(),{n:d.n+1,usd:d.usd+usd},2*86400e3);kv.put(SEEN(id),{usd},2*86400e3);}
    kv.put(OWN(o.owner,id),{state:'reserved',id,at:now()});return null;}
  /** Called after the onboarding is confirmed on chain: the owner can never be sponsored again. */
  function markDone(id,owner,wallet){if(!enabled)return;const s=kv.get(OWN(owner));if(s?.state==='reserved'&&s.id===id){kv.put(OWN(owner),{state:'done',at:now()});
    if(wallet&&kv.get(SEEN(id)))addDue(wallet,ONBOARD_FEE_USDC,'onboarding_fee');}}
  const paidByLabel=()=>'Your Kipurse balance';   // t911: plain ASCII, upstream icon kept (t910 zh name without icon broke Coinbase's sponsor row)
  async function rpc(id,body,opt={}){const rid=body?.id??1;const err=(c,m)=>({jsonrpc:'2.0',id:rid,error:{code:c,message:m}});
    let reason;try{reason=await gate(id,body?.method,body?.params);}catch{reason='invalid';}
    if(reason){log(reason==='method'?'method:'+String(body?.method).replace(/[^a-zA-Z0-9_]/g,'').slice(0,40):reason);return err(-32001,'not sponsored: '+reason);}
    try{const ac=new AbortController();const t=setTimeout(()=>ac.abort(),10e3);
      const r=await fetchImpl(cfg.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:rid,method:body.method,params:body.params}),signal:ac.signal}).finally(()=>clearTimeout(t));
      const j=await r.json();log(j?.error?'upstream_error':'ok');
      if(j?.error)return err(-32002,'paymaster refused');
      // t910: withdraw + phone enrollment fees are paid from the user's own Kipurse wallet balance in the same batch; the paymaster only fronts gas.
      // Never let the wallet say Kipurse sponsors it: replace the upstream sponsor label (ERC-7677 sponsor.name) with the honest one.
      let result=j.result;if(isWd(id)&&result&&typeof result==='object'){if(result.sponsor&&typeof result.sponsor==='object')result={...result,sponsor:{...result.sponsor,name:paidByLabel(opt.lang)}};}
      return {jsonrpc:'2.0',id:rid,result};}
    catch{log('upstream_unreachable');return err(-32003,'paymaster unavailable');}}
  return {enabled,available,gate,rpc,markDone,firstLimitsAvailable,registerFirstLimits,markFirstLimitsDone,withdrawAvailable,registerWithdraw,registerEnroll,dues,addDue,payDue};}
