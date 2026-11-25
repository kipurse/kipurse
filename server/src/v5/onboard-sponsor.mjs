// SPDX-License-Identifier: AGPL-3.0-only
// Sponsored NEW-USER onboarding (ERC-7677 paymaster proxy). Kipurse pays gas for exactly ONE thing: the first "[zh]" batch of a
// Base Account that has no Kipurse wallet yet, and only if every call is byte-identical to the batch the server prepared for it
// (factory createAccount, deterministic deployer, the new wallet's own setup calls). Everything else stays user-paid.
// OFF unless the operator created the paymaster env file. The upstream URL is never logged, returned, or put in error text.
import {decodeFunctionData,parseAbi,getAddress,keccak256,encodeAbiParameters} from 'viem';
const EXEC=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)','function execute(address target,uint256 value,bytes data)']);
/** Decode a smart-account callData (executeBatch or single execute) into [{to,value,data}]. */
export function decodeAccountCalls(callData){const d=decodeFunctionData({abi:EXEC,data:callData});return d.functionName==='execute'?[{to:d.args[0],value:d.args[1],data:d.args[2]}]:d.args[0].map(c=>({to:c.target,value:c.value,data:c.data}));}
/** Owner decision t603 (2026-10-27): the FIRST AI-limit authorization after install is part of onboarding and free (one per owner, ever, same caps). */
export const FIRST_LIMITS_PREFIX='lim-';
/** t752 (owner): withdraw-all pays its network fee from the WALLET's own USDC. Kipurse's paymaster fronts the gas only if the batch
 *  is byte-identical to the prepared plan AND that plan repays at least the gas cost in USDC to the fixed fee address in the same op. */
export const WITHDRAW_PREFIX='wd-';
/** t906: phone (Face ID approver) enrollment, wallet-pays: the sponsor fronts gas, the SAME batch repays the fee from the Kipurse wallet. */
export const ENROLL_PREFIX='pe-';export const ENROLL_REAL_GAS=1_800_000n;
/** t1123 (decision 63): later wallet-safety-limit change, wallet-pays (t752 shape): the sponsor fronts gas only for the exact prepared batch,
 *  which repays the fee from the Kipurse wallet to the fixed fee address. Same day caps and same 'underpaid' re-check as withdraw. */
export const LIMITS_WALLET_PREFIX='lw-';
/** t1139 (decision 71, owner decision t1139 option a): resume after an emergency stop also lifts the ON-CHAIN pause. The owner's Base Account
 *  confirms ONE batch (wallet -> fee address USDC leg + wallet.execute(trust, setPaused(false))); the sponsor fronts gas only for that exact
 *  batch, which repays the actual cost from the Kipurse wallet (t752/t1123 wallet-pays shape). Same caps and 'underpaid' re-check as limits. */
export const RESUME_PREFIX='ur-';
/** t1187 (decision 87): the ONE-TIME V5.3 deploy batch from the owner's Base Account (factory + adapter via the 0x4e59 deployer + USDC fee leg
 *  to the fixed fee address). The sponsor fronts gas only for that exact batch, which repays the fee in USDC (t752 shape), never ETH. */
import {DEPLOY_V53_PREFIX,DEPLOY_V53_REAL_GAS,DEPLOY_V53_MAX_USD_PER_OP,DEPLOYER as V53_DEPLOYER} from './deploy-v53.mjs';
/** t1214 (decision 102): the ONE-TIME V5.4 adapter deploy (developer's own deploy, 0A#9.1) from the owner's Base Account: deployer + USDC fee leg,
 *  same t752 shape as V5.3; and the owner's wallet migration to V5.4 (owner's Base Account confirms; every call goes to his own wallet, the
 *  deterministic deployer (approver V4) or the V5.4 adapter (registerPermission); the fee is repaid from his Kipurse wallet). Both OFF unless
 *  their page is enabled (deployV54Open / migrateV54Open deps; null = closed). */
import {DEPLOY_V54_PREFIX,DEPLOY_V54_MAX_USD_PER_OP} from './deploy-v54.mjs';
import {MIGRATE_V54_PREFIX,MIGRATE_V54_MAX_USD_PER_OP} from './migrate-v54.mjs';
import {V55_PREFIX,V55_MAX_USD_PER_OP} from './sign-v55.mjs';   // t1250: constants only; V5.5 ids are recognised only when v55Open is passed
// t1189 (decision 89): the deploy is two confirmations; each record carries its step (only fundable while the chain is at that step) and its own real gas.
export const ENTRYPOINTS=['0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789','0x0000000071727De22E5E9d8BAf0edAc6f37da032','0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'].map(a=>a.toLowerCase());
const lc=a=>String(a??'').toLowerCase();
/** Canonical hash of a call list ({to,value,data}) so the proxy can compare the user op with what prepare() returned. */
export function callsHash(calls){return keccak256(encodeAbiParameters([{type:'tuple[]',components:[{name:'t',type:'address'},{name:'v',type:'uint256'},{name:'d',type:'bytes'}]}],
  [calls.map(c=>({t:getAddress(c.to),v:BigInt(c.value??0),d:c.data??'0x'}))]));}
/** t1008/t1014: Kipurse never sponsors onboarding or the first limits. Switch KIPURSE_ONBOARD_SPONSOR (default 'off'; 'on' is refused at boot by assertPrinciples). */
export const onboardSponsorOn=(env=process.env)=>String(env.KIPURSE_ONBOARD_SPONSOR??'off').trim().toLowerCase()==='on';
import {usdcGasMode,usdcCallProblem,withErc20Context,tokenPaymentProblem,USDC_GAS_PREFIX,USDC_BASE} from './usdc-gas.mjs';
export function sponsorConfig(env=process.env){const url=String(env.KIPURSE_ONBOARD_PAYMASTER_URL??'').trim();const n=(k,d)=>{const v=Number(env[k]);return Number.isFinite(v)&&v>=0?v:d;};
  return {url:/^https:\/\/\S+$/.test(url)?url:null,maxPerDay:n('KIPURSE_SPONSOR_MAX_PER_DAY',20),maxUsdPerDay:n('KIPURSE_SPONSOR_MAX_USD_PER_DAY',2),maxUsdPerOp:n('KIPURSE_SPONSOR_MAX_USD_PER_OP',0.25)};}
/**
 * cfg: {url,maxPerDay,maxUsdPerDay,maxUsdPerOp}; kv; reg (byOwner); ethUsd8: async()=>bigint (Chainlink 8 dp); fetch; obs; now; chainId.
 * lookup(id) -> the prepared onboarding record {state,kind,owner,expect,wallet,callsHash,allowed:[addr]} (or undefined).
 */
/** t763: realistic gas of a sponsored Base Account (v0.6, 7702) withdraw op: measured 248,864 on 2026-10-29 (tx 0x1dcf38fd…); +20% headroom. */
export const WITHDRAW_REAL_GAS=300_000n;
/** t852 (owner): ONE fixed account-opening fee, the same for every user, owed once and collected once (whole, in one op: = the fee slot cap).
 *  Measured 2026-10-25 (tx 0x2fa85124…, wallet 0xdEaD…): actualGasCost 15,806,082,500,000 wei = ~0.0355 USD at 2,244.76 USD/ETH.
 *  Any difference between the real cost and this amount is Kipurse's (absorbed), never the user's. */
export const ONBOARD_FEE_USDC=50_000n;
// t854 (owner approved): wallets opened before the fixed fee existed are waived — never charged the opening fee.
// the owner wallet was never sponsored (owes nothing); 0xdEaD… was sponsored 2026-10-25, waived (Kipurse absorbs ~$0.035).
export const ONBOARD_FEE_WAIVED=Object.freeze({'0x000000000000000000000000000000000000dead':'waived-t854'});
export const onboardFeeWaived=(w)=>!!w&&Object.prototype.hasOwnProperty.call(ONBOARD_FEE_WAIVED,String(w).toLowerCase());
export function createOnboardSponsor({cfg,kv,reg,ethUsd8,lookup,fetchImpl=globalThis.fetch,obs,now=()=>Date.now(),chainId=8453,reserveMs=30*60e3,gasPrice=null,deployV53Open=null,deployV54Open=null,migrateV54Open=null,v55Open=null,onboardOn=onboardSponsorOn(),usdcGas=usdcGasMode()}){
  // t763 (legacy): any old dues are owed by the wallet (new wallets have none; the user pays opening gas in USDC, t1022) and collected from its first outgoing batch (withdraw or payment). Kipurse never keeps a cost.
  const DUE=w=>'dues:'+lc(w);
  function dues(wallet){const d=kv.get(DUE(wallet));return d?BigInt(d.owed)-BigInt(d.paid):0n;}
  function addDue(wallet,usdc,reason){if(!wallet||usdc<=0n)return;if(reason==='onboarding_fee'&&(onboardFeeWaived(wallet)||!onboardOn))return;const d=kv.get(DUE(wallet))??{owed:'0',paid:'0',items:[]};kv.put(DUE(wallet),{owed:String(BigInt(d.owed)+usdc),paid:d.paid,items:[...(d.items??[]).slice(-20),{reason,usdc:String(usdc),at:now()}]});}
  function payDue(wallet,usdc){const d=kv.get(DUE(wallet));if(!d||usdc<=0n)return 0n;const open=BigInt(d.owed)-BigInt(d.paid);const take=usdc<open?usdc:open;kv.put(DUE(wallet),{...d,paid:String(BigInt(d.paid)+take)});return take;}
  const enabled=!!cfg?.url;const LIM=id=>'sponsor:limrec:'+id,FL=o=>'sponsor:firstlimits:'+lc(o);const OWN0=o=>'sponsor:owner:'+lc(o),DAY=()=>'sponsor:day:'+new Date(now()).toISOString().slice(0,10),SEEN=id=>'sponsor:op:'+id;
  const log=r=>{try{obs?.log?.('onboard_sponsor',{reason:r});}catch{}};
  const day=()=>kv.get(DAY())??{n:0,usd:0};const isLim=id=>String(id).startsWith(FIRST_LIMITS_PREFIX);const isLw=id=>String(id).startsWith(LIMITS_WALLET_PREFIX);const isUr=id=>String(id).startsWith(RESUME_PREFIX);const isDv=id=>String(id).startsWith(DEPLOY_V53_PREFIX);const isDv4=id=>String(id).startsWith(DEPLOY_V54_PREFIX);const isMg=id=>String(id).startsWith(MIGRATE_V54_PREFIX);const isV55=id=>!!v55Open&&String(id).startsWith(V55_PREFIX);/* t1250: V5.5 deploy / move, only while the V5.5 pages are on (v55Open set) */const isWd=id=>String(id).startsWith(WITHDRAW_PREFIX)||String(id).startsWith(ENROLL_PREFIX)||isLw(id)||isUr(id)||isDv(id)||isDv4(id)||isMg(id)||isV55(id);const isPe=id=>String(id).startsWith(ENROLL_PREFIX);const isUg=id=>String(id).startsWith(USDC_GAS_PREFIX);const WDR=id=>'sponsor:wdrec:'+id;
  const OWN=(o,id)=>id!==undefined&&(isWd(id)||isUg(id))?'sponsor:wdown:'+id:id!==undefined&&isLim(id)?FL(o):OWN0(o);
  const rec=id=>isWd(id)||isUg(id)?kv.get(WDR(id)):isLim(id)?kv.get(LIM(id)):lookup(id);
  const kindOf=id=>isV55(id)?'v55':isDv(id)?'deploy_v53':isDv4(id)?'deploy_v54':isMg(id)?'migrate_v54':isUg(id)?'usdc_gas':isPe(id)?'phone_enroll':isLw(id)?'limits_wallet':isUr(id)?'resume_wallet':isWd(id)?'withdraw':isLim(id)?'first_limits':'new';
  /** Wallet-pays withdraw possible right now (sponsor on, daily caps not used up)? Not once-per-owner: every withdraw repays itself. */
  function withdrawAvailable(){if(!enabled)return false;if(usdcGas)return true;const d=day();return d.n<cfg.maxPerDay&&d.usd<cfg.maxUsdPerDay;}
  /** Register the exact prepared withdraw batch. reimburse = USDC (6 dp) the batch pays to the fee address. Returns sponsor id or null. */
  function registerWithdraw(planId,{owner,wallet,calls,reimburse}){if(!withdrawAvailable())return null;const id=WITHDRAW_PREFIX+String(planId);
    kv.put(WDR(id),{state:'prepared',kind:'withdraw',owner:getAddress(owner),expect:getAddress(owner),wallet:getAddress(wallet),allowed:[getAddress(wallet)],callsHash:callsHash(calls),reimburse:String(BigInt(reimburse))},2*3600e3);return id;}
  /** t906: register the exact enrollment batch (owner's Base Account only signs; reimburse = fee the batch pays the fee address). Same caps. */
  function registerEnroll(enrollId,{owner,wallet,calls,reimburse}){if(!withdrawAvailable())return null;const id=ENROLL_PREFIX+String(enrollId);
    kv.put(WDR(id),{state:'prepared',kind:'phone_enroll',owner:getAddress(owner),expect:getAddress(owner),wallet:getAddress(wallet),allowed:[getAddress(wallet),'0x4e59b44847b379578588920cA78FbF26c0B4956C'],callsHash:callsHash(calls),reimburse:String(BigInt(reimburse))},2*3600e3);return id;}
  /** t1123: register the exact later-limits-change batch (owner's Base Account only signs; every call goes to the wallet itself;
   *  reimburse = fee the batch pays the fixed fee address). Same caps as withdraw. */
  function registerLimitsWallet(planId,{owner,wallet,calls,reimburse}){if(!withdrawAvailable())return null;const id=LIMITS_WALLET_PREFIX+String(planId);
    kv.put(WDR(id),{state:'prepared',kind:'limits_wallet',owner:getAddress(owner),expect:getAddress(owner),wallet:getAddress(wallet),allowed:[getAddress(wallet)],callsHash:callsHash(calls),reimburse:String(BigInt(reimburse))},2*3600e3);return id;}
  /** t1139: register the exact resume batch (fee leg + wallet.execute(trust, setPaused(false))); every call goes to the wallet itself. */
  function registerResume(planId,{owner,wallet,calls,reimburse}){if(!withdrawAvailable())return null;const id=RESUME_PREFIX+String(planId);
    kv.put(WDR(id),{state:'prepared',kind:'resume_wallet',owner:getAddress(owner),expect:getAddress(owner),wallet:getAddress(wallet),allowed:[getAddress(wallet)],callsHash:callsHash(calls),reimburse:String(BigInt(reimburse))},2*3600e3);return id;}
  /** t1187: register the exact V5.3 deploy batch (owner's Base Account signs; targets: the deployer + USDC fee leg only). Same day caps. */
  function registerDeployV53(planId,{owner,calls,reimburse,step,realGas}){if(!withdrawAvailable()||usdcGas)return null;const id=DEPLOY_V53_PREFIX+String(planId);
    kv.put(WDR(id),{state:'prepared',kind:'deploy_v53',owner:getAddress(owner),expect:getAddress(owner),wallet:null,allowed:[getAddress(V53_DEPLOYER),getAddress(USDC_BASE)],callsHash:callsHash(calls),reimburse:String(BigInt(reimburse)),...(step!==undefined?{step:Number(step)}:{}),...(realGas!==undefined?{realGas:String(BigInt(realGas))}:{})},2*3600e3);return id;}
  /** t1214: the exact V5.4 deploy batch (deployer + USDC fee leg from the owner's Base Account). Only while the page is open. */
  function registerDeployV54(planId,{owner,calls,reimburse,realGas}){if(!deployV54Open||!withdrawAvailable()||usdcGas)return null;const id=DEPLOY_V54_PREFIX+String(planId);
    kv.put(WDR(id),{state:'prepared',kind:'deploy_v54',owner:getAddress(owner),expect:getAddress(owner),wallet:null,allowed:[getAddress(V53_DEPLOYER),getAddress(USDC_BASE)],callsHash:callsHash(calls),reimburse:String(BigInt(reimburse)),realGas:String(BigInt(realGas))},2*3600e3);return id;}
  /** t1214: the exact migration batch of the owner's wallet to V5.4 (targets: the wallet itself, the deployer for approver V4, the V5.4 adapter). */
  function registerMigrateV54(planId,{owner,wallet,adapter,calls,reimburse,realGas,mode='migrate',extraAllowed=[]}){if(!migrateV54Open||!withdrawAvailable()||usdcGas)return null;const id=MIGRATE_V54_PREFIX+String(planId);
    kv.put(WDR(id),{state:'prepared',kind:'migrate_v54',owner:getAddress(owner),expect:getAddress(owner),wallet:getAddress(wallet),allowed:[getAddress(wallet),getAddress(V53_DEPLOYER),getAddress(adapter),...extraAllowed.map(a=>getAddress(a))],callsHash:callsHash(calls),reimburse:String(BigInt(reimburse)),realGas:String(BigInt(realGas)),mode:mode==='rollback'?'rollback':mode==='seat'?'seat':'migrate'},2*3600e3);return id;}
  /** t1250 (decision 119): the exact V5.5 deploy batch (deployer + USDC fee leg from the Base Account) or the V5.4 -> V5.5 move batch (old wallet, new
   *  wallet, Coinbase factory, deployer). Only while the V5.5 page is on (v55Open); each batch repays its real cost in USDC. */
  function registerV55(planId,{owner,wallet=null,calls,reimburse,realGas,mode,step=null,allowed}){if(!v55Open||!withdrawAvailable()||usdcGas)return null;const id=V55_PREFIX+String(planId);
    kv.put(WDR(id),{state:'prepared',kind:'v55',owner:getAddress(owner),expect:getAddress(owner),wallet:wallet?getAddress(wallet):null,allowed:allowed.map(a=>getAddress(a)),callsHash:callsHash(calls),reimburse:String(BigInt(reimburse)),realGas:String(BigInt(realGas)),mode:mode==='move'?'move':'deploy',step},2*3600e3);return id;}
  /** Free first limits authorization still possible for this (already onboarded) owner? Same daily caps; never raised. */
  function firstLimitsAvailable(owner){if(!enabled||(!onboardOn&&!usdcGas))return false;if(usdcGas)return true;let o;try{o=getAddress(owner);}catch{return false;}const s=kv.get(FL(o));if(s?.state==='done')return false;
    const d=day();return d.n<cfg.maxPerDay&&d.usd<cfg.maxUsdPerDay;}
  /** Register the exact prepared limits batch (owner's Base Account -> wallet) for sponsorship. Returns the sponsor id or null. */
  function registerFirstLimits(planId,{owner,wallet,calls}){if(!firstLimitsAvailable(owner))return null;const id=FIRST_LIMITS_PREFIX+String(planId);
    kv.put(LIM(id),{state:'prepared',kind:'first_limits',owner:getAddress(owner),expect:getAddress(owner),wallet:getAddress(wallet),allowed:[getAddress(wallet)],callsHash:callsHash(calls)},2*3600e3);return id;}
  function markFirstLimitsDone(owner){if(!enabled)return;try{kv.put(FL(getAddress(owner)),{state:'done',at:now()});}catch{}}
  /** Is a sponsored onboarding still possible for this owner (no wallet yet, never sponsored, caps not used up)? */
  /** t1022: paymaster allowed when SAME batch repays fee in USDC (net $0), even with onboardOn=off. No free sponsorship. */
  function sameTxRepayAvailable(owner){if(!enabled)return false;let o;try{o=getAddress(owner);}catch{return false;}
    if(reg?.byOwner?.(o)?.length)return false;const s=kv.get(OWN(o));if(s?.state==='done')return false;
    const d=day();return d.n<cfg.maxPerDay&&d.usd<cfg.maxUsdPerDay;}
  function available(owner){if(sameTxRepayAvailable(owner))return true;if(!enabled||(!onboardOn&&!usdcGas))return false;let o;try{o=getAddress(owner);}catch{return false;}
    if(reg?.byOwner?.(o)?.length)return false;const s=kv.get(OWN(o));if(s?.state==='done')return false;if(usdcGas)return true;
    const d=day();return d.n<cfg.maxPerDay&&d.usd<cfg.maxUsdPerDay;}
  /** Option A: register any exact user batch (withdraw, limits, enroll) that the USER pays in USDC via the CDP ERC-20 paymaster. */
  function registerUsdcGas(planId,{kind,owner,wallet,calls,extra=[]}){if(!enabled||!usdcGas)return null;const id=USDC_GAS_PREFIX+String(planId);
    kv.put(WDR(id),{state:'prepared',kind:'usdc_gas',sub:String(kind??''),owner:getAddress(owner),expect:getAddress(owner),wallet:getAddress(wallet),usdcGas:true,allowed:[getAddress(wallet),USDC_BASE,...extra.map(getAddress)],callsHash:callsHash(calls)},2*3600e3);return id;}
  /** Gate one ERC-7677 request. Returns null if allowed, else a short reason code. Pure checks + reservation for pm_getPaymasterData. */
  async function gate(id,method,params){
    if(!enabled)return 'disabled';if(method!=='pm_getPaymasterStubData'&&method!=='pm_getPaymasterData')return 'method';
    const [op,ep,ch]=Array.isArray(params)?params:[];if(!op||typeof op!=='object')return 'bad_op';
    if(!ENTRYPOINTS.includes(lc(ep)))return 'entrypoint';if(Number(BigInt(ch??0))!==chainId)return 'chain';
    const o=rec(id);if(!o||o.state!=='prepared'||o.kind!==kindOf(id))return 'not_prepared';
    if(!o.expect||lc(o.expect)!==lc(o.owner))return 'not_signed_in';if(lc(op.sender)!==lc(o.owner))return 'sender';
    if(!usdcGas&&!(isWd(id)?withdrawAvailable():isLim(id)?firstLimitsAvailable(o.owner):available(o.owner))&&kv.get(SEEN(id))===undefined)return 'unavailable';
    let calls;try{calls=decodeAccountCalls(op.callData);}catch{return 'calldata';}
    if(usdcGas&&o.usdcGas!==true)return 'not_usdc_gas';
    const allow=new Set((o.allowed??[]).map(lc));if(!calls.length||calls.some(c=>!allow.has(lc(c.to))||BigInt(c.value)!==0n))return 'target';
    if(calls.some(c=>lc(c.to)===lc(USDC_BASE)&&usdcCallProblem(c,{wallet:o.wallet,vault:o.vault})))return 'usdc_call';
    if(callsHash(calls)!==o.callsHash)return 'calls_mismatch';
    if(isDv4(id)){let op0=false;try{op0=deployV54Open?await deployV54Open():false;}catch{}if(!op0)return 'deploy_closed';}   // t1214: inert once the V5.4 adapter exists
    if(isMg(id)){let op0=false;try{op0=migrateV54Open?await migrateV54Open(o):false;}catch{}if(!op0)return 'migrate_closed';}   // t1214: only while the wallet is still on V5.2 exactly as planned
    if(isV55(id)){let op0=false;try{op0=await v55Open(o);}catch{}if(!op0)return 'v55_closed';}   // t1250: only while the chain is where that batch starts
    if(isDv(id)){let op0=false;try{op0=deployV53Open?await deployV53Open(o.step):false;}catch{}if(!op0)return 'deploy_closed';}   // inert once the contracts exist; t1189: only while the chain is at this record's step
    const s=kv.get(OWN(o.owner,id));if(s?.state==='done')return 'already';if(s?.state==='reserved'&&s.id!==id&&now()-s.at<reserveMs)return 'busy';
    if(method==='pm_getPaymasterStubData')return null;
    if(usdcGas){kv.put(OWN(o.owner,id),{state:'reserved',id,at:now()});return null;} // user pays in USDC: no Kipurse cost, so no Kipurse caps
    // final data: cost check + caps + reservation (counted once per onboarding id)
    const g=['callGasLimit','verificationGasLimit','preVerificationGas','paymasterVerificationGasLimit','paymasterPostOpGasLimit'].reduce((a,k)=>a+BigInt(op[k]??0),0n)+100000n;
    const fee=BigInt(op.maxFeePerGas??0);if(fee<=0n)return 'gas_price';const usd=Number(g*fee*BigInt(await ethUsd8())/10n**18n)/1e8;
    if(usd>(isDv(id)?Math.max(cfg.maxUsdPerOp,DEPLOY_V53_MAX_USD_PER_OP):isDv4(id)?Math.max(cfg.maxUsdPerOp,DEPLOY_V54_MAX_USD_PER_OP):isMg(id)?Math.max(cfg.maxUsdPerOp,MIGRATE_V54_MAX_USD_PER_OP):isV55(id)?Math.max(cfg.maxUsdPerOp,V55_MAX_USD_PER_OP):cfg.maxUsdPerOp))return 'op_cap';
    // t758: no 'underpaid' check here: `usd` is the WORST case (all gas limits x maxFeePerGas, incl. Base L1 data in preVerificationGas), many times the real
    // cost, so it refused every real withdraw. The wallet repays the quoted real cost in USDC; Kipurse's exposure stays bounded by op_cap + day caps (unchanged).
    if(isWd(id)&&gasPrice){let gp=null;try{gp=BigInt(await gasPrice());}catch{}if(gp===null)return 'gas_price';
      const real=Number((isDv(id)?BigInt(o.realGas??DEPLOY_V53_REAL_GAS)*gp*11n/10n:isDv4(id)||isMg(id)||isV55(id)?BigInt(o.realGas)*gp*11n/10n:isPe(id)?ENROLL_REAL_GAS*gp:WITHDRAW_REAL_GAS*gp*11n/10n)*BigInt(await ethUsd8())/10n**18n)/1e8;   // enroll fee = UPGRADE_GAS x price + L1 allowance, at cost   // sane real cost now (+10%), not the worst case
      if(BigInt(Math.ceil(real*1e6))>BigInt(o.reimburse??0))return 'underpaid';}
    if(kv.get(SEEN(id))===undefined){const d=day();if(d.n+1>cfg.maxPerDay||d.usd+usd>cfg.maxUsdPerDay)return 'day_cap';
      kv.put(DAY(),{n:d.n+1,usd:d.usd+usd},2*86400e3);kv.put(SEEN(id),{usd},2*86400e3);}
    kv.put(OWN(o.owner,id),{state:'reserved',id,at:now()});return null;}
  /** Called after the onboarding is confirmed on chain: the owner can never be sponsored again. */
  function markDone(id,owner,wallet){if(!enabled)return;const s=kv.get(OWN(owner));if(s?.state==='reserved'&&s.id===id){kv.put(OWN(owner),{state:'done',at:now()});
    if(wallet&&kv.get(SEEN(id))){const rec0=lookup?.(id);if(!(rec0&&rec0.feeRepay))addDue(wallet,ONBOARD_FEE_USDC,'onboarding_fee');}}} // t1022: no dues when fee already repaid in the opening batch
  const paidByLabel=(lang,id)=>isDv(id)||isDv4(id)||(isV55(id)&&rec(id)?.mode==='deploy')?'Your USDC':'Your Kipurse balance';   // t911: plain ASCII, upstream icon kept (t910 zh name without icon broke Coinbase's sponsor row)
  async function rpc(id,body,opt={}){const rid=body?.id??1;const err=(c,m)=>({jsonrpc:'2.0',id:rid,error:{code:c,message:m}});
    let reason;try{reason=await gate(id,body?.method,body?.params);}catch{reason='invalid';}
    if(reason){log(reason==='method'?'method:'+String(body?.method).replace(/[^a-zA-Z0-9_]/g,'').slice(0,40):reason);return err(-32001,'not sponsored: '+reason);}
    try{const ac=new AbortController();const t=setTimeout(()=>ac.abort(),10e3);
      const r=await fetchImpl(cfg.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:rid,method:body.method,params:usdcGas?withErc20Context(body.params):body.params}),signal:ac.signal}).finally(()=>clearTimeout(t));
      const j=await r.json();log(j?.error?'upstream_error':'ok');
      if(j?.error)return err(-32002,'paymaster refused');
      if(usdcGas){const tp=tokenPaymentProblem(j.result);if(tp){log('usdc_gas:'+tp);return err(-32004,'not paid in USDC by the user: '+tp);}return {jsonrpc:'2.0',id:rid,result:j.result};}
      // t910: withdraw + phone enrollment fees are paid from the user's own Kipurse wallet balance in the same batch; the paymaster only fronts gas.
      // Never let the wallet say Kipurse sponsors it: replace the upstream sponsor label (ERC-7677 sponsor.name) with the honest one.
      let result=j.result;if(isWd(id)&&result&&typeof result==='object'){if(result.sponsor&&typeof result.sponsor==='object')result={...result,sponsor:{...result.sponsor,name:paidByLabel(opt.lang,id)}};}
      return {jsonrpc:'2.0',id:rid,result};}
    catch{log('upstream_unreachable');return err(-32003,'paymaster unavailable');}}
  return {enabled,onboardOn,usdcGas,registerUsdcGas,sameTxRepayAvailable,available,gate,rpc,markDone,firstLimitsAvailable,registerFirstLimits,markFirstLimitsDone,withdrawAvailable,registerWithdraw,registerEnroll,registerDeployV53,registerDeployV54,registerMigrateV54,registerV55,registerLimitsWallet,registerResume,dues,addDue,payDue};}
