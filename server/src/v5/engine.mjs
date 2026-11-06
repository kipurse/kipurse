// SPDX-License-Identifier: AGPL-3.0-only
// Kipurse V5 pay engine (M2, 2026-10-17), the V5 mode next to the V4 engine (src/v4/engine.mjs keeps serving V4).
// parse -> preflight (amount + protocol fee + network fee quote, per-cap maxPayable) -> claim (shared ledger, canonical key) -> pay -> record.
// Payee and amount come ONLY from parsed protocol data (detector). The adapter enforces per-payment caps on the AMOUNT and
// daily / term caps on amount + fees. Users bear all gas: networkFee = actual gas cost quoted here (no markup) <= owner max;
// this engine mirrors the adapter's routing so agents get a precise "why not" before anything is sent.
import {randomBytes} from 'node:crypto';import {guardFetch} from './ssrf.mjs';
// t796 L3: every merchant request goes through the SSRF guard (public https hosts only, no redirects). Injected test fetch skips DNS.
const mfetch=cfg=>guardFetch(cfg.fetch??globalThis.fetch,{allowLocal:!!cfg.allowHttpMerchantForTests,resolve:cfg.resolveHost??(cfg.fetch?async()=>[{address:'93.184.216.34'}]:undefined)});
import {getAddress,hashDomain,recoverTypedDataAddress,encodeFunctionData} from 'viem';
import {detect} from '../v4/detector.mjs';import {createSanctions} from './sanctions.mjs';import {normalizePaymentRequest} from './request.mjs';
import {V4Ledger} from '../v4/ledger.mjs';
import {isRevokedSigner} from '../security/revoked-signers.mjs';
import {expiryReminders} from '../v4/reminders.mjs';
import {agentBudgetReason,agentBudgetStatus} from '../v4/agents.mjs';
import {abiFor,TRUST_FNS,ZERO,ZERO32,TIERS,decodePolicyV5,permissionFromJson,feeFor,maxPayableWithin,withFeeHeadroom,quoteNetworkFee} from './abi.mjs';
import {identityV5,signedLedgerKey,signedPurchaseKeyV5,merchantIdBytes} from './ref.mjs';
import {v5Client} from './chain.mjs';import {createMandates,purposeKey,purposeName,fmtUsdc as mUsd} from './mandates.mjs';import {classifyPayee,ADDRESS_SOURCES,groups4} from './address-trust.mjs';import {GUARD_DEFAULTS,normalizeOrder,checkOrder,checkTrial,TIER_LIMITS,claimedTier,ALL_SOURCES,TIER_SAY,checkAiVerified,blacklisted} from './guardrails.mjs';import {createTrustRequests} from './trust-requests.mjs';import {join as joinPath} from 'node:path';
import {createFloat} from './float.mjs';import {buildExitPlanV5} from './plan.mjs';import {createUserOpWriter,loadOrCreateSessionKey,GAS_MODES} from './userop.mjs';import {decodeEventLog,parseAbi as parseAbiX} from 'viem';import {toCsv,receipt as taxReceipt,annualSummary} from './tax.mjs';
import {buildReceipt} from './receipt.mjs';import {caseState,refundRequest,RESPONSE_WINDOW_SEC} from './dispute-window.mjs';import {F2_WARNING} from './paymaster.mjs';import {authHeaderFor,redactSecrets} from './merchant-auth.mjs';import {discoverMerchant,orderToPayment,buildCreateOrder} from './discovery.mjs';import {attestOrder} from './attestor.mjs';import {QUESTIONS,disclosure,RISK_NOTICE_ZH,RISK_NOTICE_EN,buildOneSignatureBatchV5} from './owner-setup.mjs';import {depositInfo} from './owner-guard.mjs';
const USDC_OF={8453:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',84532:'0x036CbD53842c5426634e7929541eC2318f3dCF7e'};
import {GasBook,inflightLock,liveUsdcPerEth,ETH_USD_FEEDS,SEQUENCER_FEEDS,sequencerCheck,secondUsdcPerEth,divergenceBps,MAX_FAILURES_PER_AGENT_PER_DAY} from './gas.mjs';
import {trustTypedData,untrustTypedData,denySignerTypedData,approvalTypedData,newNonce} from './owner.mjs';

const j=x=>JSON.parse(JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v));
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64');
/** x402 payment header for a normalized request (v2 PAYMENT-SIGNATURE / v1 X-PAYMENT). Pure; shared by vault and float paths and the e2e test. */
export function x402Header(n,signature,auth){return n.standard==='x402-v1'?{name:'X-PAYMENT',value:b64({x402Version:1,scheme:'exact',network:n.raw.network,payload:{signature,authorization:auth}})}:{name:'PAYMENT-SIGNATURE',value:b64({x402Version:2,resource:n.resource??undefined,accepted:n.raw,payload:{signature,authorization:auth}})};}
const lc=s=>String(s??'').toLowerCase();
const strip=h=>String(h).replace(/^0x/,'').toLowerCase();
export const ORDER_TYPES={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},{name:'adapter',type:'address'},{name:'payer',type:'address'}]};
/** One-tap trust defaults: 90 days (max 365, never permanent) and bounded default caps (still <= the permission caps). */
/** V5.1 merchant order (stable KipurseOrderVerifier domain "Kipurse PaymentOrder" v1; chainId + verifier live in the domain). */
export const ORDER_TYPES51={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'payer',type:'address'}]};
export const orderDomain51=({chainId,verifier})=>({name:'Kipurse PaymentOrder',version:'1',chainId:Number(chainId),verifyingContract:getAddress(verifier)});
export const TRUST_DEFAULTS={days:90,maxDays:365,single:5_000_000n,daily:20_000_000n};
/** Reasons the owner can lift with a one-time OwnerApproval (direct / x402 only; the Approved tier keeps permission caps). */
export const isOwnerApprovable=r=>r==='stranger_disabled'||/^over_(stranger|verified|merchant)(_cap|_daily_cap_incl_fees)$/.test(r);
const TIER_CAPS=new Set(['stranger','verified','merchant','stranger_daily','verified_daily','merchant_daily']);

export function createEngineV5(cfg,{ledgerFile,agentDefault='agent',writer,client}={}){
  const V51=String(cfg.version??'5')==='5.1';const v5Abi=abiFor(cfg.version);
  const ledger=new V4Ledger(ledgerFile,{store:cfg.atRest});
  // AI PAYMENT GUARDRAILS: order record per agent payment (user's words, item, merchant, budget, price evidence, tier)
  try{ledger.db.exec(`CREATE TABLE IF NOT EXISTS purchase_order(purchase_key TEXT PRIMARY KEY, created_at INTEGER NOT NULL, agent_id TEXT, payee TEXT, amount TEXT, tier TEXT, address_status TEXT, order_json TEXT NOT NULL)`);}catch{}
  const GUARD={...GUARD_DEFAULTS,...(cfg.guardrails??{})};const TL={...TIER_LIMITS,...(cfg.tierLimits??{})};
  const gas=new GasBook(ledger.db);const txLock=inflightLock(); // failed-gas debt, 3-failure breaker, one in-flight tx per account
  const p=permissionFromJson(cfg.permission);
  const MD=createMandates({db:ledger.db,wallet:p.account,walletCaps:()=>({single:B('single'),daily:B('daily'),term:B('term')}),nameOf:a=>{try{return nameOf(a);}catch{return null;}},onProposal:v=>{try{cfg.onMandateProposal?.(v);}catch{}}});
  const P=cfg.policy??decodePolicyV5(p.extraData);const B=k=>BigInt(P[k]??0);
  const c=client??v5Client({chainId:cfg.chainId,rpc:cfg.rpc,adapter:cfg.adapter,executorKey:cfg.executorKey,impersonate:cfg.impersonateExecutor,maxPriorityFeeWei:cfg.maxPriorityFeeWei,version:cfg.version});
  // OFAC sanctions screening: every payment (agent AND owner), trust entry and withdrawal destination. Oracle read only on Base mainnet.
  const SC=cfg.sanctions??createSanctions({pub:cfg.chainId===8453&&cfg.sanctionsOracle!==false?c.pub:null,chainId:cfg.chainId,extra:cfg.sanctionsExtra??[]});
  const sanctioned=async(...as)=>{const h=await SC.checkAll(as.filter(Boolean));return h?{state:'rejected',reason:'SANCTIONED_ADDRESS',nothingPaid:true,payee:h.address,sanctions:{source:h.source},say_to_user:h.say_zh+' / '+h.say_en,fix:'Do not pay or trust this address. There is no override.'}:null;};
  // Owner controls live in KipurseTrustV5 (adapter.trust()); route those reads / writes there automatically.
  let trustP=cfg.trust?Promise.resolve(getAddress(cfg.trust)):null;const trustAddr=()=>trustP??=c.read('trust',[]).then(getAddress);
  const at=async(fn,o)=>TRUST_FNS.has(fn)&&!o?.address?{...o,address:await trustAddr()}:o;
  // gasMode: 'userop' = ZERO-RESERVE primary (vault is the 4337 sender, Circle paymaster, USDC gas from the vault);
  //          'f2' = degraded: no on-chain tx at all (x402 float vouchers only; limits enforced off-chain by the gateway);
  //          'legacy' = testnet-only executor EOA paying ETH (NOT allowed on mainnet).
  const gasMode=cfg.gasMode??'legacy';if(!GAS_MODES.includes(gasMode))throw Error('unknown gasMode '+gasMode);
  if(gasMode==='legacy'&&cfg.chainId===8453&&!writer&&!cfg.allowLegacyOnMainnet)throw Error('ZERO-RESERVE: the executor-pays (legacy) gas mode is not allowed on Base mainnet; use gasMode userop');
  const PAY_FNS=new Set(['payDirect','paySigned','prepareAuthorization','fundFloat']);
  let uow=null;const opWriter=gasMode!=='userop'?null:{async write(fn,args,o){uow??=createUserOpWriter({cfg,pub:c.pub,session:cfg.session??loadOrCreateSessionKey(cfg.sessionKeyFile),
    vault:getAddress(await c.read('vaultAddress',[p.account])),adapter:cfg.adapter,maxGasPerOp:B('maxNetworkFee'),
    dues:cfg.dues??null,
    onCharge:x=>gas.recordCharge({account:p.account,userOpHash:x.userOpHash,txHash:x.txHash,charged:x.charged,success:x.success,kind:x.kind})});return uow.write(fn,args,{...o,kind:PAY_FNS.has(fn)?'pay':'owner'});}};
  const f2Writer={async write(){throw Object.assign(Error('F2_X402_ONLY: degraded mode, no on-chain transactions; only x402 payments from an open float'),{code:'f2_x402_only'});}};
  const W=gasMode==='f2'?f2Writer:(writer??opWriter);
  const write=W?async(fn,args,o)=>W.write(fn,args,await at(fn,o)):async(fn,args,o)=>c.write(fn,args,await at(fn,o));
  const rd=async(fn,args,addr)=>c.read(fn,args,addr??(TRUST_FNS.has(fn)?await trustAddr():undefined));
  const execAddr=getAddress(P.executor);
  const agentsById=new Map((cfg.agents??[]).map(a=>[a.id,a]));
  const agentReason=(agentId,amount)=>{if(!cfg.agents)return null;const a=agentsById.get(agentId);if(!a)return 'unknown_agent';return agentBudgetReason(a,ledger,amount,p);};
  const chainNow=async()=>Number((await c.pub.getBlock()).timestamp);
  const domain={name:cfg.orderDomain?.name??'AgentWalletPaymentOrder',version:cfg.orderDomain?.version??'5',chainId:cfg.chainId,verifyingContract:getAddress(cfg.adapter)};
  const ownerCtx={adapter:cfg.adapter,chainId:cfg.chainId,version:V51?'5.1':'5'};
  // V5.1: the merchant domain is the STABLE order verifier (adapter.orders()); orders are consumed there per (wallet, signer, orderId)
  let verP=null;const verifierAddr=()=>verP??=cfg.orderVerifier?Promise.resolve(getAddress(cfg.orderVerifier)):c.read('orders',[]).then(getAddress);
  const orderUsedOnChain=async o=>V51?rd('used',[p.account,o.signer,o.orderId],await verifierAddr()):rd('orderUsed',[o.signer,o.orderId]);
  let feeCache=cfg.fee?{ppm:BigInt(cfg.fee.ppm),recipient:cfg.fee.recipient}:null;
  const fee=async()=>feeCache??=(async()=>{const fc=await rd('fees');return {ppm:await rd('feePpm',[],fc),recipient:await rd('feeRecipient',[],fc).catch(()=>null),controller:fc};})();
  const GP=cfg.gasPricing??{};
  /** Network fee for this call: actual gas (estimate x current gas price, + x402 closing share) in USDC, at actual cost (no markup). */
  /** Base (OP stack) L1 data fee of this tx, from the GasPriceOracle predeploy. The unsigned-tx envelope (~110 bytes) is
   *  padded with non-zero bytes so the estimate errs high. Testnet/mainnet Base only; config l1FeeWei overrides. */
  const GPO='0x420000000000000000000000000000000000000F';
  async function l1Fee(data){
    if(GP.l1FeeWei!==undefined)return BigInt(GP.l1FeeWei);if(!data||![8453,84532].includes(cfg.chainId)||GP.l1Oracle===false)return 0n;
    try{return await c.pub.readContract({address:GPO,abi:[{type:'function',name:'getL1Fee',stateMutability:'view',inputs:[{type:'bytes'}],outputs:[{type:'uint256'}]}],functionName:'getL1Fee',args:[data+'ff'.repeat(120)]});}
    catch{throw Object.assign(Error('NETWORK_FEE_UNQUOTABLE'),{code:'network_fee_unquotable',detail:'l1_fee_unreadable'});}
  }
  const dataOf=call=>{try{return encodeFunctionData({abi:v5Abi,functionName:call.functionName,args:call.args});}catch{return null;}};
  async function networkFeeFor(n,gasUnits,data){
    // zero reserve: the vault already paid the paymaster; top it up by exactly the actual charges not yet topped up (no margin)
    // the payment pays back only earlier PAYMENT ops; owner-action gas (trust relays etc.) stays on the owner's vault buffer unless it runs low
    if(gasMode==='userop'){let t=gas.pendingTopUp(p.account,'pay');const own=gas.pendingTopUp(p.account,'owner');
      if(own>0n){const minBuf=BigInt(cfg.userOp?.minVaultBufferAtomic??(B('maxNetworkFee')*2n));let bal=0n;
        try{bal=BigInt(await rd('balanceOf',[await c.read('vaultAddress',[p.account])],getAddress(cfg.token)));}catch{bal=0n;} // unreadable -> refill (never let the buffer run dry)
        if(bal<minBuf)t+=own;}
      const cap=B('maxNetworkFee');return t<cap?t:cap;}
    if(GP.fixedAtomic!==undefined)return BigInt(GP.fixedAtomic); // tests only
    const usdcPerEth=await ethPrice();
    const gasPriceWei=GP.gasPriceWei!==undefined?BigInt(GP.gasPriceWei):await c.pub.getGasPrice()+BigInt(cfg.maxPriorityFeeWei??0); // conservative: node price + our tip cap
    return quoteNetworkFee({gasUnits:gasUnits??BigInt(GP.defaultGas??260000),gasPriceWei,usdcPerEth,marginBps:GP.marginBps??0,
      closeGas:n.mode==='eip3009'?BigInt(GP.x402CloseGas??60000):0n,l1FeeWei:await l1Fee(data)});
  }
  /** ETH/USD: testnet = fixed config (usdcPerEth); mainnet = live Chainlink feed (gasPricing.oracle: true | {address,maxAgeSec,minUsd,maxUsd}). */
  let lastUsdcPerEth=GP.usdcPerEth!==undefined?BigInt(GP.usdcPerEth):null;let secondCache=null,lastPriceCheck=null;
  async function ethPrice(){
    if(GP.usdcPerEth!==undefined)return BigInt(GP.usdcPerEth);
    if(GP.oracle){const o=GP.oracle===true?{}:GP.oracle;const address=o.address??ETH_USD_FEEDS[cfg.chainId];const nowS=await chainNow();
      // 1) L2 sequencer must be up and past its grace period (Base mainnet feed; none exists on Base Sepolia)
      const seqAddr=o.sequencer===false?null:(o.sequencer?.address??SEQUENCER_FEEDS[cfg.chainId]);
      if(seqAddr)await sequencerCheck(c.pub,{address:seqAddr,graceSec:o.sequencer?.graceSec??3600,nowS});
      else if(cfg.chainId===8453&&o.sequencer!==false)throw Object.assign(Error('NETWORK_FEE_UNQUOTABLE: sequencer_feed_missing'),{code:'network_fee_unquotable',detail:'sequencer_feed_missing'});
      // 2) primary Chainlink ETH/USD
      const primary=await liveUsdcPerEth(c.pub,{...o,address,nowS});
      // 3) independent second source; refuse on > maxDivergenceBps (default 2%); quote with the HIGHER price (users bear all gas, never under-recover)
      if(o.second===false)return lastUsdcPerEth=primary;
      const sc=o.second??{};const now=Date.now();
      if(!secondCache||now-secondCache.at>(sc.cacheMs??30000))secondCache={at:now,v:await secondUsdcPerEth({fetchImpl:cfg.priceFetch??globalThis.fetch,...sc})};
      const d=divergenceBps(primary,secondCache.v);lastPriceCheck={primary:primary.toString(),second:secondCache.v.toString(),divergenceBps:d,source:sc.source??'coinbase-exchange',sequencer:seqAddr?'up':'unavailable_on_this_chain'};
      if(d>(o.maxDivergenceBps??200)){secondCache=null;throw Object.assign(Error('NETWORK_FEE_UNQUOTABLE: eth_usd_divergence'),{code:'network_fee_unquotable',detail:'eth_usd_divergence',divergenceBps:d});}
      return lastUsdcPerEth=primary>secondCache.v?primary:secondCache.v;}
    throw Object.assign(Error('NETWORK_FEE_UNQUOTABLE'),{code:'network_fee_unquotable'});
  }
  /** Network fee charged in this tx = own gas quote + recovery of earlier failed-tx gas (oldest first), capped at the owner max. */
  const withRecovery=quote=>{if(gasMode==='userop')return {quote,recovery:0n,total:quote,topUp:true}; // failed ops were already paid by the owner's vault
    const rec=quote>B('maxNetworkFee')?0n:gas.recoverable(p.account,quote,B('maxNetworkFee'));return {quote,recovery:rec,total:quote+rec};};
  const settleGas=(x,h)=>gasMode==='userop'?gas.markToppedUp(p.account,x.total,h):gas.applyRecovery(p.account,x.recovery,h);
  const bookFailure=(e,agentId)=>{if(!e?.onChain)return null;if(gasMode==='userop')return gas.recordFailure({account:p.account,agentId,txHash:e.hash}); // counts toward 3/day; no debt (vault paid)
    return gas.recordFailure({account:p.account,agentId,txHash:e.hash,gasUsed:e.gasUsed,gasPrice:e.gasPrice,usdcPerEth:lastUsdcPerEth});};
  const parsedCache=new Map();
  const estimate=async(functionName,args)=>{try{return await c.pub.estimateContractGas({address:cfg.adapter,abi:v5Abi,functionName,args,account:execAddr});}catch{return null;}};
  const float=createFloat({cfg,rd,write,p,B,ledger,fee,chainNow:()=>chainNow(),txLock,estimate,keyFile:(cfg.float?.sessionKeyFile)??(ledgerFile?ledgerFile+'.float-session.json':null),
    quote:async(n,gasUnits,fn,args)=>{const x=withRecovery(await networkFeeFor(n,gasUnits,dataOf({functionName:fn,args})));return {...x,applied:h=>settleGas(x,h)};}});
  const useRegistry=async()=>lc(P.registry??ZERO)!==lc(ZERO)&&!(await rd('registryOptOut',[p.account]));
  const reg=async(fn,args,dflt)=>{try{return await rd(fn,args,P.registry);}catch{return dflt;}}; // mirrors the adapter's try/catch: failing registry = not listed
  const liveTrust=async(binding,nowS)=>{const [m,ep]=binding;if(m===ZERO32)return null;const t=await rd('trustOf',[p.account,m]);
    return t[2]&&t[0]===ep&&BigInt(nowS)<t[1]?{merchant:m,single:t[3],daily:t[4],expiry:t[1]}:null;};
  const min=(a,b)=>a<b?a:b;

  /** Off-chain mirror of KipurseAdapterV5._routePayee / _routeSigned. */
  async function route(n,nowS){
    if(await rd('deniedPayee',[p.account,n.payee]))return {tier:'denied',reason:'payee_denied'};
    const useReg=await useRegistry();
    if(n.mode==='signed'&&V51){ // mirror of KipurseAdapterV51._routeSigned (owner trust first, then registry)
      const s=n.signedOrder.signer;
      if(await rd('deniedSigner',[p.account,s]))return {tier:'denied',reason:'signer_denied'};
      const [tm,ts,td,bound]=await rd('signerTrust',[p.account,s,n.payee]);
      if(tm!==ZERO32){if(!bound)return {tier:'trusted',merchant:tm,reason:'payee_not_bound_to_signer_merchant'};return {tier:'trusted',merchant:tm,single:min(ts,B('single')),merchantDaily:td};}
      if(useReg&&((await reg('blocked',[s],false))||(await reg('blocked',[n.payee],false))))return {tier:'denied',reason:'registry_blocked'};
      if(useReg&&B('verifiedSingle')!==0n){const [m,sg,d]=await reg('lookupSigner',[s],[ZERO32,0n,0n]);
        if(m!==ZERO32){if(!(await reg('isPayeeOf',[m,n.payee],false)))return {tier:'verified',merchant:m,reason:'payee_not_bound_to_signer_merchant'};
          return {tier:'verified',merchant:m,single:min(sg,B('verifiedSingle')),merchantDaily:min(d,B('verifiedDaily'))};}}
      return {tier:'unknown_signer',reason:'signer_not_trusted'};
    }
    if(n.mode==='signed'){
      const s=n.signedOrder.signer;
      if(await rd('deniedSigner',[p.account,s]))return {tier:'denied',reason:'signer_denied'};
      if(useReg&&((await reg('blocked',[s],false))||(await reg('blocked',[n.payee],false))))return {tier:'denied',reason:'registry_blocked'};
      const sb=await rd('trustedSigner',[p.account,s]);const t=await liveTrust(sb,nowS);
      if(t){const pb=await rd('trustedPayee',[p.account,n.payee]);if(pb[0]!==sb[0]||pb[1]!==sb[1])return {tier:'trusted',merchant:t.merchant,reason:'payee_not_bound_to_signer_merchant'};
        return {tier:'trusted',merchant:t.merchant,single:min(t.single,B('single')),merchantDaily:t.daily};}
      if(useReg&&B('verifiedSingle')!==0n){const [m,sg,d]=await reg('lookupSigner',[s],[ZERO32,0n,0n]);
        if(m!==ZERO32){if(!(await reg('isPayeeOf',[m,n.payee],false)))return {tier:'verified',merchant:m,reason:'payee_not_bound_to_signer_merchant'};
          return {tier:'verified',merchant:m,single:min(sg,B('verifiedSingle')),merchantDaily:min(d,B('verifiedDaily'))};}}
      return {tier:'unknown_signer',reason:'signer_not_trusted'};
    }
    if(useReg&&(await reg('blocked',[n.payee],false)))return {tier:'denied',reason:'registry_blocked'};
    const t=await liveTrust(await rd('trustedPayee',[p.account,n.payee]),nowS);
    if(t)return {tier:'trusted',merchant:t.merchant,single:min(t.single,B('single')),merchantDaily:t.daily};
    if(useReg&&B('verifiedSingle')!==0n){const [m,sg,d]=await reg('lookupPayee',[n.payee],[ZERO32,0n,0n]);
      if(m!==ZERO32)return {tier:'verified',merchant:m,single:min(sg,B('verifiedSingle')),merchantDaily:min(d,B('verifiedDaily'))};}
    return {tier:'stranger',merchant:null,single:B('openSingle')};
  }

  async function verifySigned(n){
    if(n.mode!=='signed')return n;const o=n.signedOrder;let s='';
    if(V51!==(o.v===2))return {ok:false,code:'order_domain_mismatch',detail:V51?'this V5.1 wallet needs a kipurse.signed-order.v2 order (stable verifier domain)':'a V5 wallet pays kipurse.signed-order.v1 orders only'};
    if(V51){const ver=await verifierAddr();if(lc(o.verifier)!==lc(ver)||Number(o.chainId)!==cfg.chainId)return {ok:false,code:'order_domain_mismatch',detail:'order signed for another verifier / chain'};
      try{s=await recoverTypedDataAddress({domain:orderDomain51({chainId:cfg.chainId,verifier:ver}),types:ORDER_TYPES51,primaryType:'PaymentOrder',
        message:{payee:o.payee,amount:o.amount,orderId:o.orderId,deadline:o.deadline,payer:o.payer??ZERO},signature:o.signature});}catch{}}
    else try{s=await recoverTypedDataAddress({domain:{...domain,verifyingContract:o.adapter},types:ORDER_TYPES,primaryType:'PaymentOrder',
      message:{payee:o.payee,amount:o.amount,orderId:o.orderId,deadline:o.deadline,chainId:o.chainId,adapter:o.adapter,payer:o.payer??ZERO},signature:o.signature});}catch{}
    if(o.payer&&lc(o.payer)!==lc(ZERO)&&lc(o.payer)!==lc(p.account))return {ok:false,code:'order_for_other_payer',detail:'the merchant signed this order for another wallet'};
    if(lc(s)!==lc(o.claimedSigner))return {ok:false,code:'signature_invalid',detail:'recovered signer does not match the order signer'};
    return {...n,signedOrder:{...o,signer:getAddress(s)}};
  }
  const resolveN=async input=>{if(input?.__normalized)return input.__normalized;if(input?.parsedId){const e=parsedCache.get(input.parsedId);if(!e)return {ok:false,code:'unknown_parsed_id',detail:'parse again (ids live 15 min, per process)'};return e.n;}
    const n=detect(input?.request??input,{chains:[cfg.chainId]});if(!n.ok)return n;return verifySigned(n);};
  /** Canonical identity: same merchant requirement => same key for every agent (and the same on-chain purchaseKey). */
  /** Signed orders: keyed on (merchant, orderId) only, like adapter.signedPurchaseKey; the amount is never part of a key. */
  function identity(n,opts={},r){
    if(n.mode==='signed'){const m=r?.merchant;return m?{kind:'signed',purchaseKey:signedPurchaseKeyV5(m,n.signedOrder.orderId),ledgerKey:strip(signedPurchaseKeyV5(m,n.signedOrder.orderId)),refString:'signed:'+lc(m)+':'+lc(n.signedOrder.orderId)}
      :{kind:'signed',ledgerKey:strip(signedLedgerKey(n.signedOrder.signer,n.signedOrder.orderId)),refString:'signed:'+lc(n.signedOrder.signer)+':'+lc(n.signedOrder.orderId)};}
    const id=identityV5(n,opts);return {kind:'ref',...id,ledgerKey:strip(id.purchaseKey)};
  }
  const directory=n=>{const r=cfg.merchantRegistry??[];for(const m of r){if(n.signedOrder?.signer&&(m.signers??[]).map(lc).includes(lc(n.signedOrder.signer)))return m;if(n.payee&&(m.payTo??[]).map(lc).includes(lc(n.payee)))return m;}return null;};

  async function parse(request,{repeatKey,intentId,fallbackOrderId}={}){
    let n=detect(request,{chains:[cfg.chainId]});if(!n.ok)return n;n=await verifySigned(n);if(n.ok===false)return n;
    if(fallbackOrderId&&!n.merchantOrderId&&n.mode==='direct')n={...n,merchantOrderId:fallbackOrderId};
    const r=await route(n,await chainNow());
    const warnings=[...(n.warnings??[])];let id=null;try{id=identity(n,{repeatKey,intentId},r);}catch{warnings.push('purchase_ref_required: pass intentId or repeatKey');}const f=await fee();const fe=feeFor(n.amount,f);
    const parsedId='prs_'+randomBytes(9).toString('base64url');parsedCache.set(parsedId,{n,at:Date.now()});
    for(const [k,v] of parsedCache)if(Date.now()-v.at>900000)parsedCache.delete(k);
    const dm=directory(n);
    return j({ok:true,parsedId,standard:n.standard,mode:n.mode,chainId:n.chainId,token:n.token,payee:n.payee,amount:n.amount,amountUsdc:(Number(n.amount)/1e6).toString(),
      fee:fe,total:n.amount+fe,merchant:dm?{id:dm.id,name:dm.name}:null,tier:r.tier,routeIssue:r.reason??null,signer:n.signedOrder?.signer??null,
      merchantRef:id?.refString??null,purchaseKey:id?.ledgerKey??null,resource:n.resource?.url??null,redirectUrl:n.redirectUrl??null,expiresAt:n.expiresAt??null,warnings});
  }

  async function chainState(r,id,n){
    const ph=cfg.permissionHash??await rd('getHash',[p],cfg.manager);const cnow=await chainNow();const started=cnow>=p.start;
    const day=BigInt(Math.max(0,Math.floor((cnow-p.start)/86400)));const z=async(cond,f)=>cond?f():0n;
    const [bal,term,today,openToday,verToday,merchToday,paused,used,orderUsed]=await Promise.all([
      rd('balanceOf',[p.account],cfg.token),rd('termSpent',[ph]),z(started,()=>rd('daySpent',[ph,day])),z(started,()=>rd('openDaySpent',[ph,day])),
      z(started,()=>rd('verifiedDaySpent',[ph,day])),z(started&&r?.merchant,()=>rd('merchantDaySpent',[ph,r.merchant,day])),rd('isPaused',[p.account]),
      id?.kind==='ref'?rd('purchaseUsed',[p.account,id.purchaseKey]):false,n?.mode==='signed'?orderUsedOnChain(n.signedOrder):false]);
    return {ph,cnow,day,bal,term,today,openToday,verToday,merchToday,paused,used,orderUsed};
  }
  /** Every cap that applies to this route: {name, limit, used, perPayment}. Per-payment caps compare the merchant AMOUNT only;
   *  daily caps and the term compare amount + protocol fee + network fee. */
  function capsFor(r,s){
    const out=[{name:'single',limit:B('single'),used:0n},{name:'daily',limit:B('daily'),used:s.today},{name:'term',limit:B('term'),used:s.term}];
    if(r.tier==='stranger')out.push({name:'stranger',limit:B('openSingle'),used:0n},{name:'stranger_daily',limit:B('openDaily'),used:s.openToday});
    if(r.tier==='verified')out.push({name:'verified',limit:r.single,used:0n},{name:'verified_daily',limit:B('verifiedDaily'),used:s.verToday},{name:'merchant_daily',limit:r.merchantDaily,used:s.merchToday});
    if(r.tier==='trusted')out.push({name:'merchant',limit:r.single,used:0n},{name:'merchant_daily',limit:r.merchantDaily,used:s.merchToday});
    return out;
  }

  function buildCall(n,id,cnow,approval){
    const sig=approval?.signature??'0x';const nf=BigInt(arguments[4]??0n);
    if(n.mode==='direct')return {functionName:'payDirect',args:[p,{payee:n.payee,amount:n.amount,merchantRef:id.merchantRef,repeatKey:id.repeatKey,deadline:BigInt(approval?.deadline??cnow+600)},sig,nf,cnow+240]};
    if(n.mode==='signed'){const o=n.signedOrder;
      if(V51)return {functionName:'paySigned',args:[p,{payee:o.payee,amount:o.amount,orderId:o.orderId,deadline:o.deadline,payer:o.payer??ZERO},o.signature,nf,cnow+240]};
      return {functionName:'paySigned',args:[p,{payee:o.payee,amount:o.amount,orderId:o.orderId,deadline:o.deadline,chainId:o.chainId,adapter:o.adapter,payer:o.payer??ZERO},o.signature,nf,cnow+240]};}
    if(n.mode==='eip3009'){const vb=BigInt(approval?.deadline??cnow+Math.min(n.maxTimeoutSeconds??60,300)+60);
      const a={to:n.payee,value:n.amount,validAfter:BigInt(cnow-60),validBefore:vb,merchantRef:id.merchantRef,repeatKey:id.repeatKey};
      return {functionName:'prepareAuthorization',args:[p,a,sig,nf,cnow+240],auth:a};}
    throw Error('UNSUPPORTED_MODE '+n.mode);
  }

  /** "Can I pay this, what does it cost in total (amount + 0.1% protocol fee + actual gas), and why / why not?" Never pays. */
  async function preflight(input,{agentId=agentDefault,repeatKey,intentId,ownerApproval}={}){
    const n=await resolveN(input);if(n.ok===false)return {canPay:false,reasons:[n.code],detail:n.detail};
    const R=[];const nowS=await chainNow(); // chain time: the adapter checks term start/end against block.timestamp
    if(n.chainId!==cfg.chainId)R.push('wrong_chain');
    if(cfg.maxPaymentAtomic!==undefined&&n.amount>BigInt(cfg.maxPaymentAtomic))R.push('over_gateway_test_limit');
    if(n.mode==='signed'){if(isRevokedSigner(n.signedOrder.signer))R.push('signer_revoked');
      if((V51?lc(n.signedOrder.verifier)!==lc(await verifierAddr()):lc(n.signedOrder.adapter)!==lc(cfg.adapter))||Number(n.signedOrder.chainId)!==cfg.chainId)R.push('order_domain_mismatch');
      if(Number(n.signedOrder.deadline)<=nowS+60)R.push('order_expired');}
    if(n.expiresAt&&Number(n.expiresAt)<=nowS)R.push('order_expired');
    if(nowS>=p.end)R.push('authorization_expired');if(nowS<p.start)R.push('authorization_not_started');
    const ar=agentReason(agentId,n.amount);if(ar)R.push(ar);
    const r=await route(n,nowS);if(r.reason)R.push(r.reason);
    let id=null;try{id=identity(n,{repeatKey,intentId},r);}catch{R.push('purchase_ref_required');}
    const s=await chainState(r,id,n);const f=await fee();
    const amount=n.amount,fe=feeFor(amount,f);const approved=!!ownerApproval&&n.mode!=='signed';
    // gas: estimate the real call (with the owner max as placeholder fee; gas does not depend on it), then price it
    let gasUnits=null,simulation=null,nf=null,cdata=null;
    if(id&&!r.reason&&n.mode!=='x402_redirect'){
      try{const call=buildCall(n,id,s.cnow,ownerApproval,B('maxNetworkFee'));cdata=dataOf(call);gasUnits=await c.pub.estimateContractGas({address:cfg.adapter,abi:v5Abi,functionName:call.functionName,args:call.args,account:execAddr});}catch{}}
    let nfDetail=null;try{nf=await networkFeeFor(n,gasUnits,cdata);}catch(e){R.push(e.code??'network_fee_unquotable');nfDetail=e.detail??null;}
    const nfx=withRecovery(nf??0n);const networkFee=nfx.total,fees=fe+networkFee,total=amount+fees;
    if(nf!==null&&nf>B('maxNetworkFee'))R.push('gas_spike_retry_later'); // gas above the owner-signed max: never sent, never subsidized
    if(gas.stopped(agentId))R.push('agent_stopped_failed_tx_today');
    if(txLock.busy(p.account))R.push('tx_in_flight_retry_later');
    const caps=r.reason?[]:capsFor(r,s);const byCap={};let overall=null;
    for(const cp of caps){const room=cp.limit>cp.used?cp.limit-cp.used:0n;const perPayment=cp.used===0n&&!['daily','term'].includes(cp.name)&&!cp.name.endsWith('_daily');
      const mp=perPayment?room:maxPayableWithin(room>networkFee?room-networkFee:0n,f);
      byCap[cp.name]={limit:cp.limit,used:cp.used,remaining:room,maxPayable:mp,counts:perPayment?'amount':'amount+fees'};
      if(approved&&TIER_CAPS.has(cp.name))continue;
      if(overall===null||mp<overall)overall=mp;
      const over=perPayment?amount>room:total>room;
      if(over)R.push(cp.name==='stranger'&&cp.limit===0n?'stranger_disabled':perPayment?`over_${cp.name}_cap`:`over_${cp.name}_cap_incl_fees`);}
    if(B('maxFeePpm')<f.ppm)R.push('fee_above_owner_accepted');
    if(s.bal<total)R.push('insufficient_balance');if(s.paused)R.push('wallet_paused');
    const row=id?ledger.get(id.ledgerKey):null;
    if(s.used||s.orderUsed)R.push('already_paid_on_chain');else if(row&&['paid','prepared','submitted'].includes(row.state))R.push('already_'+row.state);
    if(row&&BigInt(row.amount)!==amount&&['claimed','submitted','prepared','paid'].includes(row.state))R.push('price_changed');
    if(!R.length&&n.mode!=='x402_redirect'){const call=buildCall(n,id,s.cnow,ownerApproval,networkFee);
      try{await c.pub.simulateContract({address:cfg.adapter,abi:v5Abi,functionName:call.functionName,args:call.args,account:execAddr});simulation='ok';}
      catch(e){simulation='revert: '+String(e.shortMessage??e.message).split('\n').find(l=>/reverted|reason/i.test(l))?.trim()?.slice(0,160);R.push('simulation_reverted');}}
    const uniq=[...new Set(R)];
    const needsOwnerApproval=n.mode!=='signed'&&!approved&&uniq.length>0&&uniq.every(isOwnerApprovable);
    return j({...(gasMode==='f2'?{gasMode,warning:F2_WARNING}:{}),canPay:uniq.length===0,reasons:uniq,needsOwnerApproval,tier:r.tier,merchant:directory(n)?.id??(r.merchant??null),
      standard:n.standard,mode:n.mode,payee:n.payee,
      quote:{amount,fee:fe,networkFee,gasQuote:nf??null,gasRecovery:nfx.recovery,total,feePpm:f.ppm,feePercent:Number(f.ppm)/10000,maxNetworkFee:B('maxNetworkFee'),receipt:buildReceipt({amount,ppm:f.ppm,networkFee,payee:n.payee,merchant:directory(n)?.id??(r.merchant??null)}),
        note:'payer pays amount + 0.1% protocol fee + network fee (= actual gas cost, no markup, never subsidized); merchant pays 0 and receives amount. Per-payment caps count the amount; daily/term caps count the total.'},
      fee:{protocolAtomic:fe,networkAtomic:networkFee},amount,totalCostAtomic:total,maxPayable:{overall:overall??0n,byCap},
      gas:{units:gasUnits,unquotableDetail:nfDetail,priceCheck:lastPriceCheck,paidBy:'payer (reimbursed in USDC in the same tx)',x402CloseShareIncluded:n.mode==='eip3009',outstandingFailedGas:gas.outstanding(p.account),failuresToday:gas.failuresToday(agentId),maxFailuresPerDay:MAX_FAILURES_PER_AGENT_PER_DAY},
      purchaseKey:id?.ledgerKey??null,merchantRef:id?.refString??null,onchainPurchaseKey:id?.purchaseKey??null,existing:row?{state:row.state,paidBy:row.claimed_by,amount:row.amount}:null,simulation,
      next:n.mode==='x402_redirect'?{tool:'kipurse_paid_fetch',url:n.redirectUrl}:needsOwnerApproval?{tool:'kipurse_approval_request'}:undefined});
  }

  async function payNormalized(n,{agentId,intentId,repeatKey,ownerApproval,maxTotal,allowSameAmount,verifiedDomain,withdrawalId,allowance}){
    {const sx=await sanctioned(n.payee,n.signedOrder?.signer);if(sx)return sx;}
    // t621 #6: every AI payment (direct, signed order, x402 after the 402 quote) is checked against the everyday limits right before signing
    if(agentId!=='owner'&&!withdrawalId){let amt;try{amt=typeof n.amount==='bigint'?n.amount:(n.amount!==undefined&&n.amount!==null?BigInt(n.amount):undefined);}catch{amt=undefined;}
      const ed=everydayGate(amt);if(ed)return capHit(ed);}
    if(n.mode==='signed'&&!n.signedOrder?.signer){n=await verifySigned(n);if(n.ok===false)return {state:'rejected',reason:n.code};}
    const nowS=await chainNow();
    if(n.chainId!==cfg.chainId)return {state:'rejected',reason:'wrong_chain'};
    if(cfg.maxPaymentAtomic!==undefined&&n.amount>BigInt(cfg.maxPaymentAtomic))return {state:'rejected',reason:'over_gateway_test_limit'};
    if(n.mode==='signed'&&isRevokedSigner(n.signedOrder.signer))return {state:'rejected',reason:'signer_revoked'};
    if(nowS>=p.end)return {state:'rejected',reason:'authorization_expired'};
    // never (re)send at or after the merchant's expiry: late payments go to merchant manual handling; keep a margin for inclusion time
    if(n.expiresAt&&nowS>=Number(n.expiresAt)-Number(cfg.expiryMarginSec??60))return {state:'rejected',reason:'order_expired',detail:'the merchant order expires before this payment could confirm; nothing was sent'};
    if(n.mode==='signed'&&nowS>=Number(n.signedOrder.deadline)-Number(cfg.expiryMarginSec??60))return {state:'rejected',reason:'order_expired',detail:'signed order deadline too close; nothing was sent'};
    const ar=agentReason(agentId,n.amount);if(ar)return {state:'rejected',reason:ar};
    if(gas.stopped(agentId))return {state:'rejected',reason:'agent_stopped_failed_tx_today',detail:`${MAX_FAILURES_PER_AGENT_PER_DAY} payment txs of this agent reverted on chain today; it is stopped until tomorrow (UTC) or an owner reset`};
    // revoked / not-yet-approved permission (e.g. after a renewal migration): refuse before anything reaches the bundler
    if(cfg.preflightGuard!==false){let ok=null;try{ok=await rd('isValid',[p],getAddress(cfg.manager??'0xf85210B21cC50302F477BA56686d2019dC9b67Ad'));}catch{}
      if(ok===false)return {state:'rejected',reason:'permission_not_valid',detail:'the owner permission for this adapter is revoked, expired or not approved; nothing was sent'};}
    const r=await route(n,nowS);if(r.reason)return {state:'rejected',reason:r.reason};
    if(n.mode==='signed'&&agentId!=='owner'&&withdrawalId===undefined&&r.tier!=='trusted')return {state:'rejected',reason:'SIGNER_NOT_OWNER_APPROVED',detail:'only merchant signers the owner approved can be paid by the AI'};
    // gateway-enforced owner rules (NOT on chain; bound if this host is compromised = the on-chain caps): joint trust list with the
    // owner-set unrecognized caps, owner-approved withdrawals to the registered address only, and quarantined deposits never spendable
    let jt=null;
    if(cfg.jointTrust||cfg.ownerGuard){
      if(withdrawalId!==undefined){if(!cfg.ownerGuard?.isApprovedWithdrawal(withdrawalId,n.payee,n.amount))return {state:'rejected',reason:'withdrawal_not_owner_approved'};}
      else if(cfg.jointTrust&&!allowance){jt=cfg.jointTrust.decide({payee:n.payee,verifiedDomain,amount:n.amount});if(!jt.ok)return {state:'rejected',reason:jt.reason,detail:jt.detail};}
      if(cfg.ownerGuard){const bal=BigInt(await rd('balanceOf',[p.account],getAddress(cfg.token)));
        const need=n.amount+feeFor(n.amount,await fee());if(need>cfg.ownerGuard.spendable(bal))return {state:'rejected',reason:'funds_quarantined_or_insufficient',detail:'quarantined deposits are not spendable by agents; the owner can release or withdraw them'};}}
    let id;try{id=identity(n,{intentId,repeatKey},r);}catch{return {state:'rejected',reason:'purchase_ref_required',detail:'this request has no merchant reference: pass intentId (shared by the team) or repeatKey'};}
    // cap guard (V5.1 rehearsal finding): mirror the adapter's tier caps / balance BEFORE claiming, so a doomed payment is refused with
    // its real reason instead of reaching the bundler (which would reject it in simulation). The adapter stays the authority.
    // a purchase already started/paid is answered by the ledger (exactly-once), never by a cap error (Sepolia attestor e2e finding)
    const started=['claimed','submitted','prepared','paid'].includes(ledger.get(id.ledgerKey)?.state);
    if(cfg.preflightGuard!==false&&!started){let pf=null;try{pf=await preflight({__normalized:n},{agentId,repeatKey,intentId,ownerApproval});}catch{}
      const block=(pf?.reasons??[]).filter(x=>/^over_(stranger|verified|merchant|trusted|permission|single|daily|term)|^stranger_disabled$|^insufficient_balance$|^wallet_paused$|^authorization_not_started$|^fee_above_owner_accepted$|^order_domain_mismatch$|^signer_revoked$/.test(x));
      if(block.length)return {state:'rejected',reason:block[0],reasons:block,detail:'the adapter would refuse this payment; nothing was sent'};}
    const key=id.ledgerKey;const prev=ledger.get(key);
    if(prev&&BigInt(prev.amount)!==n.amount&&['claimed','submitted','prepared','paid'].includes(prev.state))return {state:'rejected',reason:'price_changed',purchaseKey:key,detail:`this purchase was already started/paid for ${prev.amount}; a changed amount is never paid again`};
    const cnow=await chainNow();
    // network fee = actual gas of THIS call (+ x402 closing share) at actual cost; refuse rather than subsidize
    let networkFee;try{let g=null,cd=null;try{const c0=buildCall(n,id,cnow,ownerApproval,B('maxNetworkFee'));cd=dataOf(c0);g=await c.pub.estimateContractGas({address:cfg.adapter,abi:v5Abi,functionName:c0.functionName,args:c0.args,account:execAddr});}catch{}
      networkFee=await networkFeeFor(n,g,cd);}catch(e){return {state:'rejected',reason:e.code??'network_fee_unquotable',detail:e.detail};}
    if(networkFee>B('maxNetworkFee'))return {state:'retry_later',reason:'gas_spike',retryAfterSec:cfg.gasSpikeRetrySec??60,gasQuote:networkFee.toString(),maxNetworkFee:B('maxNetworkFee').toString(),
      detail:'current gas costs more than the owner-signed per-payment maximum; nothing was sent. Retry later.'};
    const nfx=withRecovery(networkFee);networkFee=nfx.total;
    if(maxTotal!==undefined&&n.amount+feeFor(n.amount,await fee())+networkFee>BigInt(maxTotal))return {state:'rejected',reason:'over_agent_max_amount_incl_fees'};
    // Exact-amount deposit orders (Stripe/Coinbase deposit mode, deposit JSON with expiry): the merchant matches by payee + amount, one
    // open order per amount. A second payment of the SAME amount to the SAME address under a DIFFERENT reference inside the window is
    // almost surely a duplicate (e.g. one agent keyed it by pi id, another by merchant order id): refuse unless explicitly allowed.
    if(n.mode==='direct'&&(n.expiresAt||['stripe-pi','coinbase-business'].includes(n.standard))&&!allowSameAmount){
      const since=Date.now()-1000*Number(cfg.sameAmountWindowSec??86400);
      const dup=ledger.db.prepare(`SELECT purchase_key,state,ref FROM purchases WHERE lower(payee)=lower(?) AND amount=? AND purchase_key<>? AND created_at>=? AND state IN ('claimed','submitted','prepared','paid') LIMIT 1`).get(n.payee,n.amount.toString(),key,since);
      if(dup)return {state:'rejected',reason:'possible_duplicate_same_payee_amount',purchaseKey:key,existing:{purchaseKey:dup.purchase_key,state:dup.state,ref:dup.ref},
        detail:'an exact-amount deposit order to this address for this amount was already started/paid under another reference; nothing was sent. Pass allowSameAmount only if this is truly a new order.'};}
    const claim=ledger.claim(key,n,intentId,agentId);
    if(!claim.won){const rw=claim.row;return {state:rw.state==='paid'||rw.state==='prepared'?'already_'+rw.state:'in_progress',purchaseKey:key,paidBy:rw.claimed_by,txHash:rw.tx_hash,result:rw.result?JSON.parse(rw.result):null};}
    // one in-flight payment tx per account: a second purchase is told to retry (its claim is released, nothing sent)
    const release=txLock.try(p.account);
    if(!release){ledger.update(key,agentId,{state:'failed'});return {state:'retry_later',reason:'tx_in_flight',purchaseKey:key,retryAfterSec:5,detail:'one payment tx per wallet at a time; nothing was sent'};}
    try{return await payLocked(n,{agentId,key,id,r,cnow,ownerApproval,networkFee,nfx});}finally{release();}
  }
  async function payLocked(n,{agentId,key,id,r,cnow,ownerApproval,networkFee,nfx}){
    ledger.setMeta(key,agentId,{merchantId:directory(n)?.id??r.merchant??undefined,tier:r.tier});
    const usedOnChain=id.kind==='ref'?await rd('purchaseUsed',[p.account,id.purchaseKey]):await orderUsedOnChain(n.signedOrder);
    if(usedOnChain){ledger.update(key,agentId,{state:'paid',result:{note:'purchase already used on chain'}});return {state:'already_paid_on_chain',purchaseKey:key};}
    try{
      if(n.mode==='direct'||n.mode==='signed'){
        const call=buildCall(n,id,cnow,ownerApproval,networkFee);
        const tx=await write(call.functionName,call.args,{label:call.functionName+':'+key,beforeSend:h=>ledger.update(key,agentId,{state:'submitted',tx_hash:h})});
        const fe=feeFor(n.amount,await fee());settleGas(nfx,tx.hash);
        ledger.update(key,agentId,{state:'paid',result:{txHash:tx.hash,block:tx.blockNumber?.toString(),fee:fe.toString(),networkFee:networkFee.toString(),gasRecovery:nfx.recovery.toString(),gasUsed:tx.gasUsed?.toString()}});
        try{if(jt)cfg.jointTrust.recordPaid({decision:jt,amount:n.amount,purchaseKey:key});if(withdrawalId!==undefined)cfg.ownerGuard?.markWithdrawal(withdrawalId,{state:'paid',txHash:tx.hash});}catch{}
        return {state:'paid',purchaseKey:key,txHash:tx.hash,onchainPurchaseKey:id.purchaseKey,amount:n.amount.toString(),fee:fe.toString(),networkFee:networkFee.toString(),gasRecovery:nfx.recovery.toString(),total:(n.amount+fe+networkFee).toString(),receipt:buildReceipt({amount:n.amount,ppm:(await fee()).ppm,networkFee,payee:n.payee,txHash:tx.hash,status:'paid'})};
      }
      if(n.eip712?.name!==undefined||n.eip712?.version!==undefined){
        const want=await rd('DOMAIN_SEPARATOR',[],cfg.token);
        const got=hashDomain({domain:{name:n.eip712.name,version:n.eip712.version,chainId:cfg.chainId,verifyingContract:cfg.token},types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}]}});
        if(want!==got){ledger.update(key,agentId,{state:'failed'});return {state:'rejected',reason:'eip712_domain_mismatch',purchaseKey:key,detail:`merchant says ${n.eip712.name}/${n.eip712.version}`};}
      }
      const call=buildCall(n,id,cnow,ownerApproval,networkFee);const a=call.auth;
      const tx=await write(call.functionName,call.args,{label:'prepareAuthorization:'+key,confirmations:cfg.prepareConfirmations??3,beforeSend:h=>ledger.update(key,agentId,{state:'submitted',tx_hash:h})});
      settleGas(nfx,tx.hash);
      const vault=await rd('vaultAddress',[p.account]);const nonce=id.purchaseKey;
      const digest=await rd('authorizationDigest',[vault,a.to,a.value,a.validAfter,a.validBefore,nonce]);
      // The vault's ERC-1271 approves exactly this digest; the signature bytes are opaque (32-byte digest, never 65 bytes / ERC-6492).
      const auth={from:vault,to:n.payee,value:n.amount.toString(),validAfter:a.validAfter.toString(),validBefore:a.validBefore.toString(),nonce};
      const header=x402Header(n,digest,auth);
      ledger.update(key,agentId,{state:'prepared',result:{prepareTx:tx.hash,vault,digest,auth,fee:feeFor(n.amount,await fee()).toString(),networkFee:networkFee.toString()}});
      return {state:'prepared',purchaseKey:key,txHash:tx.hash,vault,digest,auth,paymentHeader:header,fee:feeFor(n.amount,await fee()).toString(),networkFee:networkFee.toString(),gasRecovery:nfx.recovery.toString()};
    }catch(e){
      const booked=bookFailure(e,agentId);
      const rw=ledger.get(key);
      if(rw.tx_hash){for(let i=0;i<10;i++){const u=await(id.kind==='ref'?rd('purchaseUsed',[p.account,id.purchaseKey]):orderUsedOnChain(n.signedOrder)).catch(()=>false);
        if(u){ledger.update(key,agentId,{state:'paid',result:{note:'purchase already used on chain',revertedTx:rw.tx_hash}});return {state:'already_paid_on_chain',purchaseKey:key,revertedTx:rw.tx_hash};}await new Promise(z=>setTimeout(z,cfg.retryDelayMs??1500));}}
      ledger.update(key,agentId,{state:'failed',result:{error:String(e.shortMessage??e.message).slice(0,300),revertedTx:rw.tx_hash??null}});
      // a definitive on-chain revert left the purchase unused: let a later retry claim it again (its gas is booked above)
      if(booked)ledger.db.prepare(`UPDATE purchases SET tx_hash=NULL WHERE purchase_key=?`).run(key);
      return {state:'failed',purchaseKey:key,error:String(e.shortMessage??e.message).slice(0,300),txHash:rw.tx_hash,
        ...(booked?{failedGasBooked:booked.debt.toString(),failuresToday:booked.failuresToday,note:'gas of the reverted tx is recovered on the next successful payment (within the owner cap)'}:{})};
    }
  }

  async function withIdem(idemKey,agentId,request,fn){
    if(!idemKey||!/^[A-Za-z0-9._:-]{8,128}$/.test(idemKey))return {state:'rejected',reason:'idempotency_key_required'};
    const b=ledger.idempotencyBegin(idemKey,agentId,request);
    if(b.status==='conflict')return {state:'rejected',reason:'idempotency_key_reused_with_different_request'};
    if(b.status==='replay')return b.response??{state:'in_progress',reason:'same request still running'};
    const out=await fn();ledger.idempotencyEnd(idemKey,out.purchaseKey,out);return out;
  }
  /** ADDRESS TRUST: full-address server-side verification of a plain payee (see address-trust.mjs). */
  /** ADDRESS TRUST + SOURCE TIERS (owner 2026-10-26 07:28 CT). Known payees:
   *  trust_list : owner trust list / on-chain trusted / own addresses / owner_direct payees after their first paid payment (auto-added)
   *  paid_before: paid outside trial (legacy rows, trust-list era) or >= 3 clean ai_verified payments (auto-upgrade); no open dispute
   *  trial_paid : only ever paid as a trial (stranger) -> never verified */
  const tierRows=()=>{try{return ledger.db.prepare(`SELECT o.purchase_key,lower(o.payee) AS payee,o.tier FROM purchase_order o JOIN purchases p ON p.purchase_key=o.purchase_key WHERE p.state='paid'`).all();}catch{return [];}};
  function knownPayees(){const K=[];const add=(a,label,kind,viaAi=false)=>{if(/^0x[0-9a-fA-F]{40}$/.test(String(a??'')))K.push({address:getAddress(lc(a)),label:label??null,kind,...(viaAi?{viaAi:true}:{})});};
    try{const tagged=new Map();for(const t of tierRows())tagged.set(t.purchase_key,t.tier);
      const issue=new Set();try{for(const d of (cfg.disputes?.list?.()??[]))if(d&&d.status!=='closed'&&d.purchaseKey)issue.add(d.purchaseKey);}catch{}
      const good=new Set(),od=new Set(),ai=new Map(),bad=new Set(),seen=new Map();
      for(const r of ledger.listFiltered({state:'paid',limit:5000})){const k=lc(r.payee);seen.set(k,r);const t=tagged.get(r.purchase_key);if(issue.has(r.purchase_key)){bad.add(k);continue;}
        if(t===undefined||t==='trust_list')good.add(k);/* NO-AI-TRUST: AI payment history never verifies a payee */else if(t==='owner_direct')od.add(k);else if(t==='ai_verified'||t==='ai_upgraded')ai.set(k,(ai.get(k)??0)+1);}
      for(const [k,r] of seen){const lab=r.label??r.merchant_id;if(od.has(k)&&!bad.has(k))add(r.payee,lab,'trust_list');else if((good.has(k)||(ai.get(k)??0)>=TL.aiUpgradeAfter)&&!bad.has(k))add(r.payee,lab,'paid_before',!good.has(k));/* RT-1: upgraded only by AI payments -> still AI limits */else add(r.payee,lab,'trial_paid');}}catch{}
    try{for(const r of MD.remembered())add(r.address,r.name,'trust_list');}catch{}/* owner Face ID 'approve and remember' */
    try{const o=cfg.__trustRequestsOwner;if(o){const l=o.api.list(o.cap);for(const r of [...l.recent,...l.pending])if(r.status==='trusted')add(r.payee,r.merchantName,'trust_list');}}catch{}
    try{for(const t of (cfg.jointTrust?.list()?.trusted??[]))if(t.active!==false)add(t.subject??t.key,null,'trust_list');}catch{}
    try{add(cfg.ownerGuard?.limits()?.withdrawalAddress,'withdrawal','own');}catch{}
    add(cfg.owner,'owner','own');return K;}
  function inboundTransfers(){try{return (cfg.ownerGuard?.deposits()??[]).map(d=>({from:d.from,amount:d.amount,usdc:d.status!=='wrong_token'}));}catch{return [];}}
  const sumTier=(tiers,ms=86400000)=>{try{const q=`SELECT o.amount FROM purchase_order o JOIN purchases p ON p.purchase_key=o.purchase_key WHERE o.tier IN (${tiers.map(()=>'?').join(',')}) AND o.created_at>=? AND p.state IN ('claimed','submitted','prepared','paid')`;
    return ledger.db.prepare(q).all(...tiers,Date.now()-ms).reduce((a,x)=>a+BigInt(x.amount??0),0n);}catch{return 0n;}};
  const trialSpent24h=()=>sumTier(['stranger']);
  const verifyPayee=async({address,source}={})=>{try{if(!/^0x[0-9a-fA-F]{40}$/.test(String(address??'')))return {ok:false,code:'bad_payee',detail:'address must be 0x + 40 hex characters'};
    if(source!==undefined&&!ALL_SOURCES.includes(source))source='other';
    const a=getAddress(lc(address));let tier=null;try{tier=(await route({mode:'direct',payee:a},await chainNow())).tier;}catch{}
    {const h=await SC.check(a);if(h)return {ok:true,address:a,verified:false,status:'sanctioned',required_action:'refuse',code:'SANCTIONED_ADDRESS',sanctions:{source:h.source},explain_zh:h.say_zh,explain_en:h.say_en,payee_tier:null,payee_tier_text:null,say_to_user:h.say_zh+' / '+h.say_en};}
    const bl=blacklisted(a,cfg.blacklistFile);
    const v=bl?{...classifyPayee({address:a,tier:'denied',known:[],inbound:[],source}),code:'SCAM_BLACKLIST',blacklist:bl,explain_zh:'这个地址在公开的诈骗地址黑名单里，不能付款。',explain_en:'This address is on a public scam blacklist. Do not pay it.'}
      :classifyPayee({address:a,tier,known:knownPayees(),inbound:inboundTransfers(),source});
    const pt=payeeTier(v,source);
    return {ok:true,...v,payee_tier:pt,payee_tier_text:pt?TIER_SAY[pt]:null,
      say_to_user:v.verified?'已核实 / Verified':(pt==='stranger'?'未核实：新收款方，第一次要你在手机上用 Face ID 批准一次，之后记住 / Not verified: new payee, approve once on your phone with Face ID, then it is remembered':'未核实 / Not verified')};}catch(e){return {ok:false,code:'verify_failed',detail:String(e?.message).slice(0,200)};}};
  /** effective tier: null when the payee is refused (lookalike / dust / blacklist / blocked). */
  function payeeTier(v,source){if(v.required_action!=='none')return null;if(v.verified)return v.match?.kind==='paid_before'?(v.match?.viaAi?'ai_upgraded':'verified'):'trust_list';return claimedTier(source);}
  const recordOrder=(r,{agentId,payee,amount,tier,status,order,source})=>{try{if(!r?.purchaseKey)return;ledger.db.prepare(`INSERT OR IGNORE INTO purchase_order VALUES(?,?,?,?,?,?,?,?)`).run(String(r.purchaseKey),Date.now(),agentId??null,payee??null,amount!==undefined&&amount!==null?String(amount):null,tier??null,status??null,JSON.stringify({...(order??{}),...(source?{source}:{})}));}catch{}};
  const orderFor=key=>{try{const x=ledger.db.prepare(`SELECT * FROM purchase_order WHERE purchase_key=?`).get(String(key));if(!x)return null;const j=JSON.parse(x.order_json)??{};let nm=null;try{nm=x.payee?nameOf(x.payee):null;}catch{}return {...j,tier:x.tier,addressStatus:x.address_status,agent:x.agent_id,at:x.created_at,payee:x.payee??null,payeeName:nm};}catch{return null;}};
  /** For the app: order/source record by payment tx hash. */
  const orderForTx=tx=>{try{const rows=ledger.db.prepare(`SELECT purchase_key FROM purchases WHERE state='paid' AND (lower(tx_hash)=lower(?) OR result LIKE ?)`).all(String(tx),'%'+String(tx).toLowerCase().slice(2,66)+'%');for(const r of rows){const o=orderFor(r.purchase_key);if(o)return o;}}catch{}return null;};
  const replayOf=k=>{try{return k?ledger.db.prepare(`SELECT response FROM idempotency WHERE idem_key=? AND response IS NOT NULL`).get(k):null;}catch{return null;}};
  // ---- ANOMALY AUTO-PAUSE (>= 3 new payees / 1h, >= 3 cap hits / 1h, > 50% of the balance out in 24h) -> owner resumes with Face ID ----
  const AN={newPayees:new Map(),capHits:[]};
  const anomaly=reason=>{try{cfg.obs?.log?.('anomaly_pause',{reason});}catch{}try{cfg.onAnomaly?.(reason);}catch{}AN.localPause=cfg.onAnomaly?null:{reason,at:Date.now()};
    return {state:'rejected',reason:'wallet_paused_for_safety',anomaly:reason,nothingPaid:true,fix:'AI payments are paused for safety. Tell the user; only the owner can resume them in the Kipurse app with Face ID. Do not retry.',
      say_to_user:'为了安全，AI 付款已自动暂停（'+({too_many_new_payees:'1 小时内出现多个新收款方',repeated_cap_hits:'多次碰到限额',large_outflow:'24 小时内转出超过余额一半'}[reason]??reason)+'）。请在 Kipurse App 里用 Face ID 恢复。/ AI payments were paused for safety. Resume them in the Kipurse app with Face ID.'};};
  const isPaused=()=>{try{if(cfg.isPaused?.())return true;}catch{}return !!AN.localPause;};
  const capHit=r=>{if(!r?.capHit&&!['over_unrecognized_cap','OVER_USER_BUDGET'].includes(r?.reason))return r;const t=Date.now();AN.capHits=AN.capHits.filter(x=>t-x<3600e3);AN.capHits.push(t);
    if(AN.capHits.length>=TL.capHits1h){AN.capHits=[];const a=anomaly('repeated_cap_hits');return {...r,paused:a.anomaly,say_to_user:r.say_to_user+' '+a.say_to_user};}return r;};
  const outflow24h=()=>sumTier(['trust_list','verified','owner_direct','ai_verified','ai_upgraded','stranger','x402','mandate']);
  // RT-2: one ceiling for everything the AI pays WITHOUT the owner (allowances + AI-checked + trial), whatever purpose it claims
  const UNATTENDED=['mandate','ai_verified','ai_upgraded','stranger'];
  function unattendedCheck(amount,extra){if(amount===undefined)return null;const d=sumTier(UNATTENDED),m=sumTier(UNATTENDED,30*86400e3);const lim=BigInt(TL.unattendedDaily),limM=BigInt(TL.unattendedMonthly);
    if(d+amount<=lim&&m+amount<=limM)return null;const day=d+amount>lim;
    return {state:'rejected',reason:day?'AI_UNATTENDED_DAILY_TOTAL':'AI_UNATTENDED_MONTHLY_TOTAL',nothingPaid:true,capHit:true,...extra,detail:day?`AI paid without asking today ${fmtU(d)} + ${fmtU(amount)} > ${fmtU(lim)} (all purposes together)`:`30 days ${fmtU(m)} + ${fmtU(amount)} > ${fmtU(limM)}`,
      fix:'The total the AI may pay without asking (all allowances, AI-checked and trial payees together) is used up. Ask the owner: call kipurse_request_trust for this payee or ask for a one-time approval; do not split or relabel the payment.',
      say_to_user:day?`没有付款：今天 AI 不经你确认能花的总额（所有用途合计 ${fmtU(lim)} USDC）已用完。需要的话在手机上用 Face ID 批准这一笔。/ Not paid: today's total the AI may spend without asking (${fmtU(lim)} USDC, all purposes) is used up.`:`没有付款：近 30 天 AI 不经你确认能花的总额（${fmtU(limM)} USDC）已用完。/ Not paid: the 30-day total the AI may spend without asking is used up.`};}
  // t621 #8: the x402 small-payment float counts against the everyday limits: money funded into it in the last 24h and not yet
  // spent by vouchers is "committed" (spent vouchers are already in outflow24h as normal payment records, so nothing is counted twice).
  const floatCommitted24h=()=>{try{const since=Date.now()-86400e3;const f=BigInt(ledger.db.prepare(`SELECT COALESCE(SUM(funded),0) AS a FROM float_sessions WHERE funded_at>=?`).get(since).a);
    const v=BigInt(ledger.db.prepare(`SELECT COALESCE(SUM(amount),0) AS a FROM float_vouchers WHERE state!='void' AND at>=?`).get(since).a);return f>v?f-v:0n;}catch{return 0n;}};
  const everydaySpent=()=>outflow24h()+floatCommitted24h();
  /** Cumulative recorded payment amount. null means the total cannot be checked, so the caller must refuse. */
  const spentCumulative=()=>{try{const q=`SELECT o.amount AS amount FROM purchase_order o JOIN purchases p ON p.purchase_key=o.purchase_key WHERE p.state IN ('claimed','submitted','prepared','paid')`;
    return ledger.db.prepare(q).all().reduce((a,x)=>a+BigInt(x.amount??0),0n);}catch{return null;}};
  /** t609u Layer 2 + t621 #6 + t1076 total. Fail CLOSED. allowUnknown: pre-checks before the amount is known. */
  function everydayGate(amount,{allowUnknown=false}={}){if(!cfg.everydayCheck)return null;
    if(amount===undefined||amount===null){if(allowUnknown)return null;return {state:'rejected',reason:'EVERYDAY_AMOUNT_UNKNOWN',nothingPaid:true,fix:'The payment amount is unknown, so the owner’s everyday limits cannot be checked. Nothing was paid.',say_to_user:'没有付款：不知道这笔要付多少，没法核对你的日常额度。/ Not paid: the amount is unknown, so your everyday limits can’t be checked.'};}
    const spentTerm=spentCumulative();if(spentTerm==null)return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true,fix:'The cumulative total could not be read. Nothing was paid.',say_to_user:'没有付款：暂时核对不了总额。/ Not paid: the total could not be checked.'};
    try{return cfg.everydayCheck({amount:BigInt(amount),spent24h:everydaySpent(),spentTerm})??null;}catch{return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true,fix:'The everyday-limit check failed; nothing was paid. Retry later.',say_to_user:'没有付款：暂时核对不了日常额度，请稍后再试。/ Not paid: your everyday limits could not be checked right now.'};}}
  async function anomalyBefore({payee,amount,tier}){const t=Date.now();
    {const ed=everydayGate(amount,{allowUnknown:true});if(ed)return ed;}/* t609u Layer 2: everyday limits, before signing */for(const [k,ts] of AN.newPayees)if(t-ts>3600e3)AN.newPayees.delete(k);
    if(tier!=='trust_list'&&tier!=='verified'&&payee){const k=lc(payee);if(!AN.newPayees.has(k)){AN.newPayees.set(k,t);if(AN.newPayees.size>=TL.newPayees1h){AN.newPayees.clear();return anomaly('too_many_new_payees');}}}
    if(amount!==undefined){try{const bal=BigInt(await rd('balanceOf',[p.account],getAddress(cfg.token)));const out=outflow24h();if((out+amount)*100n>(bal+out)*BigInt(TL.balanceOutPct))return anomaly('large_outflow');}catch{}}
    return null;}
  // ---- 10-MINUTE HOLD (>= 500 USDC to a payee not on the trust list): cancelable in the app; runs after 10 min if not canceled ----
  try{ledger.db.exec(`CREATE TABLE IF NOT EXISTS payment_hold(id TEXT PRIMARY KEY, idem_key TEXT UNIQUE, created_at INTEGER NOT NULL, release_at INTEGER NOT NULL, state TEXT NOT NULL, agent_id TEXT, payee TEXT, amount TEXT, tier TEXT, args_json TEXT NOT NULL, result_json TEXT)`);}catch{}
  // ---- ADDRESS BOOK: payees as name + address (agents and voice speak names; the app shows the full address on detail) ----
  try{ledger.db.exec(`CREATE TABLE IF NOT EXISTS payee_book(address TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT, updated_at INTEGER NOT NULL)`);}catch{}
  const cleanName=n=>String(n??'').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,60);
  const setName=(a,n,src,force=false)=>{const nm=cleanName(n);if(!nm||nm==='direct'||!/^0x[0-9a-fA-F]{40}$/.test(String(a??'')))return;try{ledger.db.prepare(force?`INSERT INTO payee_book VALUES(?,?,?,?) ON CONFLICT(address) DO UPDATE SET name=excluded.name,source=excluded.source,updated_at=excluded.updated_at`:`INSERT OR IGNORE INTO payee_book VALUES(?,?,?,?)`).run(lc(a),nm,src??null,Date.now());}catch{}};
  const nameOf=a=>{if(!a)return null;try{const r=ledger.db.prepare(`SELECT name FROM payee_book WHERE address=?`).get(lc(a));if(r)return r.name;}catch{}try{const k=knownPayees().find(x=>lc(x.address)===lc(a)&&x.label&&x.label!=='direct');if(k)return k.label;}catch{}return null;};
  const addressBook=()=>{const out=new Map();try{for(const r of ledger.db.prepare(`SELECT * FROM payee_book`).all())out.set(r.address,{name:r.name,address:getAddress(r.address)});}catch{}
    for(const k of knownPayees())if(k.label&&k.label!=='direct'&&!out.has(lc(k.address)))out.set(lc(k.address),{name:k.label,address:k.address});
    const kn=new Map(knownPayees().map(k=>[lc(k.address),k.kind]));return [...out.values()].map(x=>({...x,status:({trust_list:'trusted',own:'trusted',paid_before:'verified'})[kn.get(lc(x.address))]??'new'}));};
  /** pay by name: only an exact, unique name of a trusted / verified payee. */
  const resolvePayeeName=name=>{const n=cleanName(name).toLowerCase();if(!n)return {ok:false,code:'payee_name_required'};const m=addressBook().filter(x=>x.name.toLowerCase()===n);
    if(!m.length)return {ok:false,code:'UNKNOWN_PAYEE_NAME',fix:'No saved payee with that name. Ask the user for the payee (or its address) instead. Names are only saved after a payment or an owner approval.'};
    if(m.length>1)return {ok:false,code:'AMBIGUOUS_PAYEE_NAME',fix:'Several saved payees have that name; ask the user which one.'};
    if(m[0].status==='new')return {ok:false,code:'PAYEE_NOT_VERIFIED',fix:'That saved payee is not verified yet; pay it with its address and addressSource, or ask the owner to approve it.'};return {ok:true,address:m[0].address,name:m[0].name,status:m[0].status};};
  const holdTimers=new Map();
  const holdView=h=>h&&({id:h.id,state:h.state,payee:h.payee,name:(()=>{try{return nameOf(h.payee);}catch{return null;}})(),amount:h.amount,tier:h.tier,createdAt:h.created_at,releaseAt:h.release_at,agent:h.agent_id,item:(()=>{try{return JSON.parse(h.args_json).order?.item??null;}catch{return null;}})(),result:h.result_json?JSON.parse(h.result_json):null});
  const getHold=id=>{try{return ledger.db.prepare(`SELECT * FROM payment_hold WHERE id=?`).get(String(id));}catch{return null;}};
  const setHold=(id,state,result)=>{try{ledger.db.prepare(`UPDATE payment_hold SET state=?,result_json=? WHERE id=?`).run(state,result?JSON.stringify(result,(k,v)=>typeof v==='bigint'?v.toString():v):null,id);}catch{}};
  async function releaseHold(id){holdTimers.delete(id);const h=getHold(id);if(!h||h.state!=='pending')return holdView(h);
    if(isPaused()){setHold(id,'stopped_paused',{state:'rejected',reason:'wallet_paused_for_safety'});return holdView(getHold(id));}
    setHold(id,'releasing');let r;try{const a=JSON.parse(h.args_json);r=await payInner(a);recordOrder(r,{agentId:a.agentId,payee:h.payee,amount:h.amount,tier:h.tier,status:a.__status,order:a.order,source:a.addressSource});}catch(e){r={state:'failed',error:String(e?.message).slice(0,200)};}
    setHold(id,r?.state==='paid'?'paid':'failed',r);return holdView(getHold(id));}
  const armHold=h=>{if(holdTimers.has(h.id))return;const ms=Math.max(0,h.release_at-Date.now());const tm=setTimeout(()=>{releaseHold(h.id).catch(()=>{});},ms);tm.unref?.();holdTimers.set(h.id,tm);};
  try{for(const h of ledger.db.prepare(`SELECT * FROM payment_hold WHERE state='pending'`).all())armHold(h);}catch{}
  const listHolds=({all=false}={})=>{try{return ledger.db.prepare(all?`SELECT * FROM payment_hold ORDER BY created_at DESC LIMIT 50`:`SELECT * FROM payment_hold WHERE state='pending' ORDER BY created_at DESC`).all().map(holdView);}catch{return [];}};
  const cancelHold=id=>{const h=getHold(id);if(!h)return {ok:false,error:'unknown_hold'};if(h.state!=='pending')return {ok:false,error:'not_pending',hold:holdView(h)};
    const tm=holdTimers.get(h.id);if(tm)clearTimeout(tm);holdTimers.delete(h.id);setHold(h.id,'canceled',{state:'canceled',by:'owner'});try{cfg.obs?.log?.('hold_canceled',{});}catch{}return {ok:true,hold:holdView(getHold(h.id))};};
  function placeHold(o,{payee,amount,tier,status}){const existing=o.idempotencyKey?ledger.db.prepare(`SELECT * FROM payment_hold WHERE idem_key=?`).get(o.idempotencyKey):null;
    if(existing)return holdAnswer(existing);
    const id='hold_'+randomBytes(8).toString('hex');const now=Date.now();
    ledger.db.prepare(`INSERT INTO payment_hold VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).run(id,o.idempotencyKey??id,now,now+TL.holdMs,'pending',o.agentId??null,payee,String(amount),tier,JSON.stringify({...o,__status:status},(k,v)=>typeof v==='bigint'?v.toString():v));
    const h=getHold(id);armHold(h);try{cfg.onHold?.({...holdView(h),name:nameOf(payee),amountText:fmtU(amount)});}catch{}try{cfg.obs?.log?.('hold_placed',{tier});}catch{}return holdAnswer(h);}
  function holdAnswer(h){const v=holdView(h);if(h.state==='paid'||h.state==='failed')return {...(v.result??{}),hold:v};
    return {state:h.state==='pending'?'held':h.state,holdId:h.id,releaseAt:new Date(h.release_at).toISOString(),nothingPaidYet:h.state==='pending',hold:v,
      fix:'Payments of 500 USDC or more to a payee that is not on the owner trust list wait 10 minutes so the owner can cancel in the Kipurse app. It runs automatically; call kipurse_pay again with the SAME idempotencyKey after releaseAt to see the result. Do not pay again with a new key.',
      say_to_user:h.state==='pending'?'这笔达到 500 USDC，先等 10 分钟再付；这段时间你可以在 Kipurse App 里取消。/ 500 USDC or more: it waits 10 minutes before paying; you can cancel it in the Kipurse app.':h.state==='canceled'?'这笔付款已被你取消。/ You canceled this payment.':'这笔付款没有执行（钱包已暂停）。/ Not paid (wallet paused).'};}
  const newPayeeAsk=extra=>({state:'rejected',reason:'NEW_PAYEE_NEEDS_OWNER',nothingPaid:true,...extra,payee_tier:'new',payee_tier_text:'新收款方，需要你用 Face ID 批准一次 / New payee: needs your Face ID once',
    fix:'This payee was not established by the owner (AI checks, web pages, documents and AI payment history never count). Use kipurse_buy (it sends the owner ONE Face ID approval; approving remembers this payee) or kipurse_request_trust, then retry with the SAME idempotencyKey. Never try another address.',
    say_to_user:'还没付款：这是新收款方（AI 可能被骗）。已发到你手机，用 Face ID 批准一次，以后就记住它。/ Not paid yet: new payee (the AI could be tricked). Approve once on your phone with Face ID; it will be remembered.'});
  /** One gate for every agent payment (direct, x402): blacklist / lookalike / dust -> refuse; tier limits; anomaly; hold decision. */
  async function gate({payee,amount,agentId,source,mode,purpose,host}){
    const v=await verifyPayee({address:payee,source});if(!v.ok)return {reject:{state:'rejected',reason:'retry_later',detail:'payee check unavailable; nothing was sent',nothingPaid:true}};
    const fromHistory=source==='from_tx_history'&&!v.verified;
    if(v.required_action!=='none'||fromHistory){try{cfg.obs?.log?.('payee_refused',{status:v.status});}catch{}
      return {reject:{state:'rejected',reason:v.code??'UNVERIFIED_FROM_HISTORY',payee:v.address,payeeGroups:v.groups,verified:false,addressStatus:v.status,lookalikes:v.lookalikes,blacklist:v.blacklist,
        say_to_user:v.explain_zh+' / '+v.explain_en,nothingPaid:true,
        fix:v.required_action==='refuse'?'Do not pay this address.':'Do NOT retry with another address you found yourself. Tell the user it is NOT verified, then call kipurse_request_trust for this exact payee so the owner can approve it on the phone with Face ID; after approval, retry kipurse_pay.'}};}
    const tier=v.payee_tier;const extra={payee:v.address,payeeGroups:v.groups,verified:v.verified,addressStatus:v.status,payee_tier:tier,payee_tier_text:TIER_SAY[tier],...(amount!==undefined?{amountAtomic:String(amount)}:{})};
    {const ac=MD.agentCheck(agentId,amount);if(ac)return {reject:capHit({...ac,...extra})};}
    // OWNER ALLOWANCE (purpose mandate / recurring / one-off): inside it the AI pays without asking, also a new merchant; checks above still applied
    // NO-AI-TRUST (owner 2026-10-26): the AI alone may only pay payees the OWNER established (trust list, owner-approved + remembered,
    // owner-paid before, owner-approved recurring / one-off / payee-scoped allowance). Anything else -> one Face ID.
    const known=tier==='trust_list'||tier==='verified';
    const mm=MD.match({purpose,payee:v.address,host,amount,agentId});
    if(!known&&tier!=='owner_direct'){const m=mm.ok?mm.mandate:null;const bound=m&&(m.kind==='one_off'||m.kind==='recurring'||m.payees.includes(lc(v.address)));if(!bound&&!(mm.mandate&&/^recurring_/.test(mm.why??'')))return {reject:newPayeeAsk(extra)};}
    if(mm.ok){const m=mm.mandate;const mx={...extra,payee_tier:'mandate',payee_tier_text:(m.purpose==='all'?'在你设的 AI 付款上限内 / Within your AI payment limit':m.kind==='recurring'?'在你批准的「'+purposeName(m.purpose,true)+'」自动续费内 / Inside your approved '+purposeName(m.purpose,false)+' renewal':'你用 Face ID 批准过的收款方，在你设的 AI 付款上限内 / A payee you approved with Face ID, within your AI payment limit'),mandate:{id:m.id,purpose:m.purpose,kind:m.kind}};
      if(m.kind!=='one_off'){const uc=unattendedCheck(amount,mx);if(uc)return {reject:capHit(uc)};}
      const realNew=m.kind!=='one_off'&&tier!=='trust_list'&&tier!=='verified'&&amount!==undefined&&amount>=BigInt(TL.mandateNewPayeeMin);
      const an=await anomalyBefore({payee:v.address,amount,tier:realNew?tier:'verified'});if(an)return {reject:an};
      // PRINCIPLE: the 500 hold applies to every non-trust-list payee, also inside the overall limit (only an exact owner Face ID one-off skips it)
      const big=amount!==undefined&&amount>=TL.holdAbove&&tier!=='trust_list'&&m.kind!=='one_off';
      if(big&&mode==='x402')return {reject:capHit({state:'rejected',reason:'X402_OVER_HOLD_LIMIT',nothingPaid:true,capHit:true,...extra,fix:'Web (x402) payments of 500 USDC or more need a payee on the owner trust list.'})};
      return {v,tier:'mandate',extra:mx,hold:big,mandate:m};}
    if(mm.why&&!['no_mandate','no_purpose'].includes(mm.why))return {reject:capHit({...mandateAsk(mm,{payee:v.address,host,amount,agentId,purpose}),...extra,capHit:/^over_/.test(mm.why),guardRefusal:true})};
    if(!known&&tier!=='owner_direct')return {reject:newPayeeAsk(extra)};
    // (removed 2026-10-26 UX fix: the old AI-verified tier cap was unreachable here - every non-owner-established payee returns newPayeeAsk above; handbook §3.2)
    if(UNATTENDED.includes(tier)){const uc=unattendedCheck(amount,extra);if(uc)return {reject:capHit(uc)};}
    const an=await anomalyBefore({payee:v.address,amount,tier});if(an)return {reject:an};
    if(mode==='x402'&&tier==='owner_direct')return {reject:{...ownerConfirm({payee:v.address,amount,name:nameOf(v.address),agentId}),guardRefusal:true}};
    const hold=mode!=='x402'&&amount!==undefined&&amount>=TL.holdAbove&&tier!=='trust_list';
    if(mode==='x402'&&amount!==undefined&&amount>=TL.holdAbove&&tier!=='trust_list')return {reject:capHit({state:'rejected',reason:'X402_OVER_HOLD_LIMIT',nothingPaid:true,capHit:true,...extra,fix:'Web (x402) payments of 500 USDC or more need a payee on the owner trust list (kipurse_request_trust -> owner Face ID).',say_to_user:'没有付款：网页付款达到 500 USDC 需要收款方在你的信任名单里。/ Not paid: web payments of 500 USDC or more need a trusted payee.'})};
    return {v,tier,extra,hold};}
  const payGuarded=async(o)=>{if(o.withdrawalId||o.agentId==='owner')return payInner(o);/* owner Siri/phone pay = already Face ID approved by the owner */
    if(replayOf(o.idempotencyKey))return payInner(o);/* exactly-once replay of a finished payment: answer from the ledger */
    if(o.idempotencyKey){try{const h=ledger.db.prepare(`SELECT * FROM payment_hold WHERE idem_key=?`).get(o.idempotencyKey);if(h)return holdAnswer(h);}catch{}}
    if(isPaused())return {state:'rejected',reason:'wallet_paused_for_safety',nothingPaid:true,fix:'AI payments are paused; only the owner can resume them in the Kipurse app (Face ID).'};
    {const st=MD.agentCheck(o.agentId,undefined);if(st)return st;}
    let n;try{n=await resolveN(o.parsedId?{parsedId:o.parsedId}:o.request);}catch{n=null;}
    const order=normalizeOrder(o);const amount=typeof n?.amount==='bigint'?n.amount:undefined;
    const oc=checkOrder({order,amount,cfg:GUARD});if(oc){try{cfg.obs?.log?.('order_refused',{reason:oc.reason});}catch{}return capHit(oc);}
    if(!n||n?.ok===false||n?.mode!=='direct'||!n.payee){const r=await payInner(o);recordOrder(r,{agentId:o.agentId,payee:n?.payee,amount,tier:n?.mode==='signed'?'trust_list':null,status:null,order,source:o.addressSource});
      return r&&typeof r==='object'&&!Array.isArray(r)?{...r,order_recorded:!!r.purchaseKey}:r;}
    const purpose=purposeKey(o.purpose??order?.purpose)??undefined;
    // ESCROW (testnet/fork only until the owner approves mainnet): a payment INTO the owner's escrow is gated on the MERCHANT it is for
    // (new-payee Face ID, scam list, sanctions, single limit); the escrow address itself must be on the owner's trust list on chain.
    const esc=!!cfg.escrow?.address&&lc(n.payee)===lc(cfg.escrow.address);
    if(esc&&!/^0x[0-9a-fA-F]{40}$/.test(String(o.escrowFor??'')))return {state:'rejected',reason:'escrow_needs_merchant',nothingPaid:true,detail:'escrow payments must name the merchant (escrowFor)'};
    if(!esc&&o.escrowFor!==undefined)return {state:'rejected',reason:'escrowFor_without_escrow',nothingPaid:true};
    const gp=esc?getAddress(lc(o.escrowFor)):n.payee;if(esc){const sx=await sanctioned(gp);if(sx)return sx;if(lc(gp)===lc(p.account)||lc(gp)===lc(cfg.escrow.address))return {state:'rejected',reason:'escrow_bad_merchant',nothingPaid:true};}
    const g=await gate({payee:gp,amount,agentId:o.agentId,source:o.addressSource,mode:'direct',purpose});if(g.reject){const {guardRefusal,...rj}=g.reject;return rj;}
    if(esc&&g.tier==='owner_direct')return {state:'rejected',reason:'escrow_merchant_needs_owner_approval',nothingPaid:true};
    const nm=nameOf(n.payee)??(cleanName(order?.merchant??o.payeeName)||null);if(order?.merchant)setName(n.payee,order.merchant,'order');
    if(g.tier==='mandate'&&!g.hold){const r=await payInner({...o,allowance:true});const ord={...(order??{}),purpose:MD.classifyCategory({purpose:o.purpose,item:order?.item,merchant:order?.merchant,host:order?.host}),mandateId:g.mandate.id};recordOrder(r,{agentId:o.agentId,payee:n.payee,amount,tier:'mandate',status:g.v.status,order:ord,source:o.addressSource});
      if(r?.state==='paid')MD.used(g.mandate.id);
      return r&&typeof r==='object'?{...r,...g.extra,payee_name:nm,payeeVerified:g.v.verified,order_recorded:!!r.purchaseKey,say_to_user:r.say_to_user??(r.state==='paid'?`已付 ${fmtU(amount)} USDC 给 ${nm??'收款方'}（在你设的 AI 付款上限内）。/ Paid ${fmtU(amount)} USDC to ${nm??'the payee'} (within your AI payment limit).`:undefined)}:r;}
    if(g.tier==='owner_direct')return ownerConfirm({payee:n.payee,amount,name:nm,order,agentId:o.agentId,extra:g.extra});
    if(g.hold)return {...placeHold({...o,order},{payee:n.payee,amount,tier:g.tier,status:g.v.status}),...g.extra,payee_name:nm};
    const r=await payInner(o);recordOrder(r,{agentId:o.agentId,payee:n.payee,amount,tier:g.tier,status:g.v.status,order,source:o.addressSource});
    return r&&typeof r==='object'?{...r,...g.extra,payee_name:nm,payeeVerified:g.v.verified,trial_only:g.tier==='stranger',order_recorded:!!r.purchaseKey,say_to_user:r.say_to_user??sayPaid(r,{name:nm,amount,tier:g.tier})}:r;};
  const fmtU=a=>{const n=BigInt(a??0),w=n/1000000n,f=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
  const TIER_SHORT={trust_list:['信任名单','on your trust list'],verified:['已核实','verified'],ai_verified:['你已批准','you approved'],ai_upgraded:['你已批准','you approved'],stranger:['你已批准','you approved'],mandate:['在你设的 AI 付款上限内','within your AI payment limit']};
  function sayPaid(r,{name,amount,tier}){if(r.state!=='paid')return undefined;const who=name??'收款方',whoEn=name??'the payee';const t=TIER_SHORT[tier]??['',''];
    return `已付 ${fmtU(amount)} USDC 给 ${who}（${t[0]}）。/ Paid ${fmtU(amount)} USDC to ${whoEn} (${t[1]}).`;}
  /** owner_direct claimed by the agent ("the owner told me this address"): never trusted on the AI's word. First payment -> owner confirms on the
   *  phone (name, amount, full address, Face ID) -> trust list. Nothing is paid now; retry after the owner confirmed. */
  function ownerConfirm({payee,amount,name,order,agentId,extra}){
    if(!TR)return {state:'rejected',reason:'OWNER_CONFIRM_UNAVAILABLE',nothingPaid:true,...extra};
    const nm=name||'新收款方 / New payee';let r;try{r=TR.request({payee,merchantName:nm,chain:undefined,reason:'Owner gave this address to the AI'+(order?.user_request?': "'+String(order.user_request).slice(0,300)+'"':'')+(amount!==undefined?'; first payment '+fmtU(amount)+' USDC':''),single:B('single').toString(),total:B('daily').toString(),expiresInDays:365,agentId:agentId??'agent'});}
    catch(e){return {state:'rejected',reason:e.code??'OWNER_CONFIRM_FAILED',detail:String(e.message).slice(0,200),nothingPaid:true,...extra};}
    setName(payee,nm,'owner_confirm');try{if(!r.idempotent)cfg.onPayeeConfirm?.({id:r.id,name:nm,payee:String(payee),amount:amount!==undefined?fmtU(amount):null});}catch{}
    return {state:'awaiting_owner_confirm',reason:'OWNER_CONFIRM_REQUIRED',trustRequestId:r.id,nothingPaid:true,...extra,payee_name:nm,payee_tier:'owner_direct_pending',
      fix:'The owner must confirm this new payee on the phone (Face ID). Tell the user, then call kipurse_get_trust_request_status with trustRequestId; when it is trusted, call kipurse_pay again.',
      say_to_user:`还没付款：${nm} 是新收款方，请在手机上看一下名字、金额和完整地址，用 Face ID 确认。确认后我再付。/ Not paid yet: please confirm ${nm} on your phone with Face ID, then I will pay.`};}
  /** Outside / over an allowance: ONE owner approval request (push + Face ID) for exactly this payment (or the changed subscription). Nothing paid. */
  function mandateAsk(mm,{payee,host,amount,agentId,purpose}){const m=mm.mandate;const nm=(payee&&nameOf(payee))||host||'收款方';const pk=purposeKey(purpose)??m?.purpose??'daily';
    let items,why_zh,why_en;const pzh=m?.purpose?`（AI 付款上限内）`:'',pen=m?.purpose?` (within your AI payment limit)`:'';
    if(mm.why==='recurring_price_up'){items=[{purpose:m.purpose,single:fmtU(amount),recurring:{...m.recurring,amount:fmtU(amount)},replaces:m.id}];why_zh=`${nm} 的续费从 ${fmtU(m.recurring.amount)} 涨到 ${fmtU(amount)} USDC`;why_en=`${nm} renewal went up from ${fmtU(m.recurring.amount)} to ${fmtU(amount)} USDC`;}
    else if(mm.why==='recurring_payee_changed'&&payee){items=[{purpose:m.purpose,single:fmtU(amount??m.recurring.amount),recurring:{...m.recurring,payee,amount:fmtU(amount??m.recurring.amount)},replaces:m.id}];why_zh=`续费的收款方变了（现在是 ${nm}）`;why_en=`the renewal payee changed (now ${nm})`;}
    else{items=[{purpose:pk,single:fmtU(amount??0n),oneOff:{payee:payee??null,host:payee?null:host}}];
      why_zh=({over_single:'超过每笔额度',over_daily:'超过今天的额度',over_monthly:'超过本月的额度',payee_not_in_mandate:'不在这项额度指定的收款方里',recurring_already_paid:'这个周期已经续过费了',recurring_payee_changed:'续费的收款方变了'})[mm.why]??'超出额度';
      why_en=({over_single:'above the per-payment limit',over_daily:'above today\'s limit',over_monthly:'above this month\'s limit',payee_not_in_mandate:'not one of the payees of this allowance',recurring_already_paid:'already renewed this period',recurring_payee_changed:'the renewal payee changed'})[mm.why]??'outside the allowance';}
    let pr=null;try{pr=MD.propose({items,by:'agent:'+(agentId??'agent'),reason:`${why_en} (${mm.detail??''})`,dedupe:[mm.why,lc(payee??host??''),String(amount),pk].join('|')});}catch(e){return {state:'rejected',reason:'MANDATE_'+String(mm.why).toUpperCase(),nothingPaid:true,decision:'refuse',detail:String(e.message).slice(0,160)};}
    return {state:'awaiting_owner_approval',reason:'MANDATE_'+String(mm.why).toUpperCase(),decision:'ask_owner',approvalId:pr.id,nothingPaid:true,detail:mm.detail,
      fix:'Outside the owner allowance: the owner got ONE approval request on the phone (push, Face ID). Tell the user in one sentence, then poll kipurse_approval_status {approvalId}; when approved, call the same payment again (same idempotencyKey). Never split the payment to fit the allowance.',
      say_to_user:`还没付款：${fmtU(amount??0n)} USDC 给 ${nm}${why_zh}${pzh}。我已发到你手机，用 Face ID 同意后我就付。/ Not paid yet: ${fmtU(amount??0n)} USDC to ${nm} is ${why_en}${pen}. I sent it to your phone; approve with Face ID and I will pay.`};}
  /** Merchant order status (read-only GET on the status URL the merchant's own order response gave; https only; credential for that host only, never echoed). */
  async function merchantStatus(url){let u;try{u=new URL(String(url));}catch{return {ok:false,error:'bad_status_url'};}
    const local=['127.0.0.1','localhost'].includes(u.hostname);if(u.protocol!=='https:'&&!(local&&cfg.allowHttpMerchantForTests))return {ok:false,error:'status_url_not_https'};
    let auth=null;try{auth=authHeaderFor(cfg.signedOrderAuth,u.toString().replace(/^http:/,'https:'));}catch{}
    if(!auth&&local&&cfg.allowHttpMerchantForTests&&cfg.testBearerForLocal)auth={Authorization:'Bearer '+(typeof cfg.testBearerForLocal==='function'?cfg.testBearerForLocal():cfg.testBearerForLocal)};
    try{const r=await mfetch(cfg)(u.toString(),{headers:{accept:'application/json',...(auth??{})},redirect:'error',signal:AbortSignal.timeout(cfg.signedOrderTimeoutMs??15000)});
      const j=await r.json().catch(()=>null);return {ok:r.ok,http:r.status,body:j};}catch(e){return {ok:false,error:'status_unreachable'};}}
  const setOrderExtra=(key,extra)=>{try{const x=ledger.db.prepare(`SELECT order_json FROM purchase_order WHERE purchase_key=?`).get(String(key));if(!x)return false;ledger.db.prepare(`UPDATE purchase_order SET order_json=? WHERE purchase_key=?`).run(JSON.stringify({...JSON.parse(x.order_json),...extra}),String(key));return true;}catch{return false;}};
  const pay=o=>payGuarded(o);
  /** Voice recap: totals for a period, by payee name, suspicious items. period: today | 7d | 30d | month */
  const spendingSummary=({period='today',tz='America/Chicago'}={})=>{const now=Date.now();let since;
    if(period==='7d')since=now-7*86400e3;else if(period==='30d')since=now-30*86400e3;else{const d=new Date(new Date(now).toLocaleString('en-US',{timeZone:tz}));const off=new Date(now).getTime()-d.getTime();d.setHours(0,0,0,0);if(period==='month')d.setDate(1);since=d.getTime()+off;}
    const rows=ledger.listFiltered({since,state:'paid',limit:5000});const by=new Map();let total=0n;
    for(const r of rows){if(r.origin_agent==='owner'&&false)continue;const a=BigInt(r.amount??0);total+=a;const k=lc(r.payee);const e=by.get(k)??{name:nameOf(r.payee)??null,count:0,amount:0n,tier:orderFor(r.purchase_key)?.tier??null};e.count++;e.amount+=a;by.set(k,e);}
    const cats={};for(const r of rows){let c='other';try{const o=orderFor(r.purchase_key);c=MD.CATEGORIES.includes(o?.order?.purpose??o?.purpose)?(o?.order?.purpose??o?.purpose):MD.classifyCategory({purpose:o?.order?.purpose??o?.purpose,item:o?.order?.item??o?.item,merchant:o?.order?.merchant??o?.merchant});}catch{}
      const e=cats[c]??={key:c,zh:purposeName(c,true),en:purposeName(c,false),count:0,amount:0n};e.count++;e.amount+=BigInt(r.amount??0);}
    const categories=Object.values(cats).sort((a,b)=>a.amount<b.amount?1:-1).map(e=>({...e,amount:fmtU(e.amount)}));
    const payees=[...by.values()].sort((a,b)=>a.amount<b.amount?1:-1).map(e=>({name:e.name??'未命名收款方 / unnamed payee',count:e.count,amount:fmtU(e.amount),tier:e.tier}));
    const susp=[];try{for(const d of (cfg.ownerGuard?.deposits()??[]))if((d.status==='wrong_token'||BigInt(d.amount??0)<10000n)&&Number(d.t??d.at??now)>=since/((d.t&&d.t<1e12)?1000:1))susp.push({kind:'dust_or_fake_token_deposit',note:'tiny or fake-token transfer, possible address poisoning'});}catch{}
    try{for(const h of listHolds({all:true}))if(h.createdAt>=since&&h.state==='canceled')susp.push({kind:'canceled_large_payment',name:h.name,amount:fmtU(h.amount)});}catch{}
    const p=(()=>{try{return isPaused();}catch{return false;}})();
    const say=`${({today:'今天',month:'本月','7d':'最近 7 天','30d':'最近 30 天'})[period]??period}共付 ${fmtU(total)} USDC，${rows.length} 笔`+(payees.length?`，最多的是 ${payees[0].name}（${payees[0].amount}）`:'')+(susp.length?`；有 ${susp.length} 条可疑记录`:'')+(p?'；AI 付款目前已暂停':'')+'。';
    return {period,since:new Date(since).toISOString(),total:fmtU(total),count:rows.length,categories,payees,suspicious:susp,paused:p,say_to_user:say};};
  const agentSafetyPause=reason=>{try{cfg.onAgentPause?.(reason??'agent_pause');}catch{}if(!cfg.onAgentPause)AN.localPause={reason:'agent_pause',at:Date.now()};return {ok:true,paused:true,say_to_user:'已暂停 AI 付款。只有你本人在 Kipurse App 里用 Face ID 才能恢复。/ AI payments paused. Only you can resume them in the Kipurse app with Face ID.'};};
  const payInner=({agentId=agentDefault,intentId,repeatKey,request,parsedId,idempotencyKey,maxAmount,ownerApproval,fallbackOrderId,allowSameAmount,verifiedDomain,withdrawalId,allowance})=>withIdem(idempotencyKey,agentId,{op:'pay',v:5,intentId,repeatKey,request,parsedId,maxAmount,ownerApproval,fallbackOrderId,allowSameAmount},async()=>{
    let n=await resolveN(parsedId?{parsedId}:request);if(n.ok===false)return {state:'rejected',reason:n.code,detail:n.detail};
    if(fallbackOrderId&&!n.merchantOrderId&&n.mode==='direct')n={...n,merchantOrderId:fallbackOrderId};
    if(n.mode==='x402_redirect')return {state:'redirect',reason:'x402_redirect',next:{tool:'kipurse_paid_fetch',url:n.redirectUrl}};
    return payNormalized(n,{agentId,intentId,repeatKey,ownerApproval,maxTotal:maxAmount,allowSameAmount:allowSameAmount===true,verifiedDomain,withdrawalId,allowance:allowance===true});});

  /** V5.1 signed-order upgrade (optional for merchants). Only when: V5.1 wallet, direct request, payee NOT trusted / registered
   *  (stranger tier) and amount > the stranger cap, and the merchant offers a signed order (payment.signedOrderUrl or the caller's
   *  signedOrderUrl). GET <url>?signedOrder=1&payer=<wallet>&chainId=..&verifier=..; the answer must be a v2 order for the SAME payee
   *  and SAME amount (else nothing is paid). Returns {signedOrder} | {state:'rejected',...} | null (= continue unsigned). */
  async function autoSignedOrder(x,payment,urlArg){
    const url0=urlArg??payment?.signedOrderUrl??payment?.links?.signedOrder;if(!V51||!url0||x.kind!=='request')return null;
    const n=detect(x.request,{chains:[cfg.chainId]});if(!n.ok||n.mode!=='direct')return null;
    if(n.amount<=B('openSingle'))return null;const rt=await route(n,await chainNow());if(rt.tier!=='stranger')return null;
    let u;try{u=new URL(String(url0));}catch{return {state:'rejected',reason:'bad_signed_order_url'};}
    const local=['127.0.0.1','localhost'].includes(u.hostname);if(u.protocol!=='https:'&&!(local&&cfg.allowHttpMerchantForTests))return {state:'rejected',reason:'signed_order_url_not_https'};
    const ver=await verifierAddr();u.searchParams.set('signedOrder','1');u.searchParams.set('payer',p.account);u.searchParams.set('chainId',String(cfg.chainId));u.searchParams.set('verifier',ver);
    // merchant credential (e.g. ExampleShop listing ownerToken): https + own host only; never echoed (errors are redacted)
    let auth=null;try{auth=authHeaderFor(cfg.signedOrderAuth,u.toString());}catch{return {state:'rejected',reason:'merchant_credential_unavailable'};}
    if(!auth&&(cfg.signedOrderAuth??[]).some(r=>{const d=String(r.host).toLowerCase();return u.hostname===d||u.hostname.endsWith('.'+d);})&&!(local&&cfg.allowHttpMerchantForTests))return {state:'rejected',reason:'merchant_credential_unavailable'};
    if(!auth&&local&&cfg.allowHttpMerchantForTests&&cfg.testBearerForLocal)auth={Authorization:'Bearer '+(typeof cfg.testBearerForLocal==='function'?cfg.testBearerForLocal():cfg.testBearerForLocal)};
    let body;try{const res=await mfetch(cfg)(u.toString(),{headers:{accept:'application/json',...(auth??{})},redirect:'error',signal:AbortSignal.timeout(cfg.signedOrderTimeoutMs??15000)});
      if(!res.ok)return {state:'rejected',reason:'signed_order_unavailable',detail:'merchant answered HTTP '+res.status+'; unknown payee above the stranger cap is not paid unsigned'};body=await res.json();}
    catch(e){return {state:'rejected',reason:'signed_order_unavailable',detail:redactSecrets(cfg.signedOrderAuth,String(e?.message??e)).slice(0,200)};}
    const so=body?.signedOrder??body;const m=detect({signedOrder:so},{chains:[cfg.chainId]});
    if(!m.ok)return {state:'rejected',reason:'signed_order_invalid',detail:m.code};
    if(m.signedOrder?.v!==2)return {state:'rejected',reason:'signed_order_invalid',detail:'expected a v2 (stable verifier) order'};
    // addresses case-insensitive; expiry as unix seconds on both sides (unsigned: unix, signed: ISO + orderDeadline); token fields not compared
    if(lc(m.payee)!==lc(n.payee)||m.amount!==n.amount)return {state:'rejected',reason:'signed_order_mismatch',detail:'the signed order names another payee or amount than the payment request; nothing paid'};
    if(n.expiresAt&&Number(m.signedOrder.deadline)>Number(n.expiresAt))return {state:'rejected',reason:'signed_order_mismatch',detail:'signed deadline is later than the unsigned order expiry'};
    // we always request payer = this wallet; an unbound (0x0) or foreign payer is refused
    if(lc(m.signedOrder.payer)!==lc(p.account))return {state:'rejected',reason:lc(m.signedOrder.payer)===lc(ZERO)?'order_payer_unbound':'order_for_other_payer'};
    return {signedOrder:so};
  }
  /** Merchant order via PUBLIC discovery (llms.txt / capabilities / openapi): create the order on the merchant's documented endpoint,
   *  then pay ONLY the address/amount/expiry from that order response (re-validated). Credential: cfg.signedOrderAuth rule for the host,
   *  placed where the docs say (JSON body or Bearer); never echoed. merchantPurchaseId = the merchant idempotency key (reuse on retry). */
  const discCache=new Map();
  async function discover(origin){const k=String(origin);const c=discCache.get(k);if(c&&c.t>Date.now()-10*60e3)return c.d;
    const d=await discoverMerchant(origin,{fetch:mfetch(cfg),chainId:cfg.chainId,usdc:USDC_OF[cfg.chainId],allowHttp:!!cfg.allowHttpMerchantForTests});discCache.set(k,{t:Date.now(),d});return d;}
  const payMerchantOrder=async({origin,orderParams={},merchantPurchaseId,signedOrder,...o})=>{
    let d;try{d=await discover(origin);}catch(e){return {state:'rejected',reason:e.code??'discovery_failed',detail:e.detail};}
    if(!merchantPurchaseId)return {state:'rejected',reason:'merchant_purchase_id_required',detail:`the merchant's ${d.create.idempotencyField??'idempotency'} key; reuse it on every retry`};
    let tok=null;try{const h=authHeaderFor(cfg.signedOrderAuth,d.origin.replace(/^http:/,'https:'));tok=h?h.Authorization.slice(7):null;}catch{}
    if(!tok&&cfg.allowHttpMerchantForTests&&cfg.testBearerForLocal)tok=typeof cfg.testBearerForLocal==='function'?cfg.testBearerForLocal():cfg.testBearerForLocal;
    const red=s=>tok?String(s).split(tok).join('<redacted>'):String(s);const f=mfetch(cfg);
    let order;try{const rq=buildCreateOrder(d,orderParams,{credential:tok,purchaseId:merchantPurchaseId,signedOrder:!!(signedOrder&&V51)});
      const r=await f(rq.url,{...rq.init,signal:AbortSignal.timeout(cfg.signedOrderTimeoutMs??15000)});const j=await r.json().catch(()=>null);
      if(!r.ok)return {state:'rejected',reason:'merchant_order_refused',detail:red(`HTTP ${r.status} ${j?.error??j?.code??''}`).slice(0,160),retryAfterSeconds:j?.retryAfterSeconds};order=j;}
    catch(e){return {state:'rejected',reason:e.code??'merchant_order_failed',detail:red(e.detail??e.message).slice(0,160)};}
    const v=orderToPayment(order,d,{chainId:cfg.chainId,usdc:USDC_OF[cfg.chainId],nowS:Number(await chainNow())});
    if(!v.ok)return {state:'rejected',reason:v.code,detail:v.detail,merchantPurchaseId};
    // V5.1 attestor: our own key signs the checked order -> paid within the merchant DOMAIN's trust caps (no merchant signature needed)
    const att=V51&&!o.noAttest?(cfg.attestors?.[lc(v.merchant)]??null):null; // ONE attestor key per trusted domain (a signer binds to exactly one merchant on chain)
    if(att){const so=await attestOrder(att,v,{payer:p.account,chainId:cfg.chainId,verifier:await verifierAddr(),types:ORDER_TYPES51,domain:orderDomain51});
      const r=await pay({...o,request:{signedOrder:so}});return {...r,attested:true,merchant:v.merchant,merchantPurchaseId,statusUrl:v.statusUrl,discovered:{section:d.section,create:d.create.path,status:d.status?.path??null,sources:d.sources}};}
    const r=await payAny({...o,verifiedDomain:v.merchant,payment:v.payment,merchant:v.merchant,signedOrderUrl:v.signedOrderOffered&&v.statusUrl?v.statusUrl:o.signedOrderUrl});
    return {...r,merchant:v.merchant,merchantPurchaseId,statusUrl:v.statusUrl,discovered:{section:d.section,create:d.create.path,status:d.status?.path??null,sources:d.sources}};};
  // ---- owner setup / limits / trust / deposits / withdrawals (spec 2026-10-20) ----
  const needG=()=>{if(!cfg.ownerGuard)throw Object.assign(Error('owner guard not configured'),{code:'owner_guard_not_configured'});return cfg.ownerGuard;};
  const wrap=f=>async(...a)=>{try{return await f(...a);}catch(e){return {state:'rejected',reason:e.code??'invalid',detail:String(e.message).slice(0,400),errors:e.errors};}};
  const setup=wrap(async({answers}={})=>{if(!answers)return {questions:QUESTIONS,disclosure:disclosure({feeRecipient:(await fee()).recipient}),riskNotice:{zh:RISK_NOTICE_ZH,en:RISK_NOTICE_EN},
      note:'Ask the owner EVERY question; examples are illustrations only and are never applied. Show the disclosure and get riskNoticeAcknowledged + technicalConsent = true.'};
    const plan=buildOneSignatureBatchV5({answers,current:cfg.permission,adapter:cfg.adapter,manager:cfg.manager,owner:cfg.owner,chainId:cfg.chainId,nowS:await chainNow()});
    cfg.ownerGuard?.stageFromPlan(plan);return {plan,next:'the owner signs this ONE batch on the signing page; the off-chain limits activate when that exact permission is valid on chain'};});
  const setLimits=wrap(async({changes,agentId})=>needG().setLimits(changes,{agentId}));
  const proposeTrust=wrap(async o=>{if(!cfg.jointTrust)throw Error('trust list not configured');return cfg.jointTrust.propose(o);});
  const trustList=wrap(async()=>cfg.jointTrust?cfg.jointTrust.list():{trusted:[],pending:[]});
  const depositInfoFn=wrap(async()=>({...(await depositInfo({wallet:p.account,chainId:cfg.chainId})),dailyLimit:cfg.ownerGuard?.limits()?.depositDailyLimit??null}));
  const depositsList=wrap(async()=>({deposits:needG().deposits().map(d=>(d.status==='wrong_token'||BigInt(d.amount??0)<10000n)?{...d,flag:d.flag??'suspicious_dust',warning:'Tiny or fake-token transfer: possible address poisoning. NEVER use this sender as a payee.'}:d),quarantined:needG().quarantined().toString()}));
  const requestWithdrawal=wrap(async({amount,agentId})=>needG().requestWithdrawal({amount,agentId}));
  /** After the owner approved on the owner surface: pay it through the adapter (0.1% + gas; counts against the on-chain caps). */
  const executeWithdrawal=wrap(async({withdrawalId,agentId=agentDefault})=>{const g=needG();const w=g.pending().withdrawals.find(x=>x.id===withdrawalId&&x.state==='approved');
    if(!w)return {state:'rejected',reason:'withdrawal_not_owner_approved'};
    const r=await payAny({agentId,payment:{to:w.to,amountAtomic:w.amount},merchant:'owner-withdrawal',orderRef:w.id,withdrawalId:w.id,idempotencyKey:'wd-'+w.id});
    if(r.state!=='paid')g.markWithdrawal(w.id,r);return r;});
  /** ONE call for any merchant payment request: plain address + amount, EIP-681, x402 (402 response or https URL), Stripe/Coinbase
   *  deposit objects, deposit-address JSON, or (optional) a merchant-signed order. Routes to direct pay, x402 or paySigned. */
  const payAny=async({payment,merchant,orderRef,expiresAt,...o})=>{const x=normalizePaymentRequest(payment,{chainId:cfg.chainId,merchant,orderRef,expiresAt});
    if(!x.ok)return {state:'rejected',reason:x.code,detail:x.detail};
    if(x.kind==='fetch')return paidFetch({...o,url:x.url});
    // V5.1: an unknown payee above the stranger cap + a merchant that offers signed orders -> ask it for one (payer = this wallet)
    const so=await autoSignedOrder(x,payment,o.signedOrderUrl);if(so?.state)return so;
    if(so?.signedOrder)return {...(await pay({...o,request:{signedOrder:so.signedOrder}})),signedOrderRequested:true};
    // a protocol order id wins; the agent's merchant+orderRef is the reference when the request carries none (EIP-681 / plain address)
    const r=await pay({...o,request:x.request,fallbackOrderId:x.merchantOrderId??undefined});
    if(r?.purchaseKey&&merchant&&merchant!=='owner-withdrawal')try{ledger.setLabel(r.purchaseKey,merchant);}catch{}
    if(r.state==='redirect')return paidFetch({...o,idempotencyKey:String(o.idempotencyKey).slice(0,120)+':x402',url:r.next.url});
    return r;};
  const parseAny=async({payment,merchant,orderRef,expiresAt,...o})=>{const x=normalizePaymentRequest(payment,{chainId:cfg.chainId,merchant,orderRef,expiresAt});
    if(!x.ok)return x;if(x.kind==='fetch')return {ok:true,route:'x402_paid_fetch',url:x.url};
    const r=await parse(x.request,{...o,fallbackOrderId:x.merchantOrderId??undefined});
    return r.ok===false?r:{...r,route:r.mode==='signed'?'paySigned':r.mode==='direct'?'payDirect':r.mode==='x402_redirect'?'x402_paid_fetch':'x402_prepare'};};
  const pendingClose=[];
  const x402Info=new Map();
  const paidFetch=async(o)=>{if(o.agentId==='owner')return paidFetchInner(o);if(replayOf(o.idempotencyKey))return paidFetchInner(o);const order=normalizeOrder(o);
    if(isPaused())return {state:'rejected',reason:'wallet_paused_for_safety',nothingPaid:true,fix:'AI payments are paused; only the owner can resume them in the Kipurse app (Face ID).'};
    {const st=MD.agentCheck(o.agentId,undefined);if(st)return st;}
    const oc=checkOrder({order,amount:undefined,cfg:GUARD});if(oc)return oc;const r=await paidFetchInner(o);const info=x402Info.get(o.idempotencyKey);x402Info.delete(o.idempotencyKey);
    if(r?.guardRefusal){try{ledger.db.prepare(`DELETE FROM idempotency WHERE idem_key=?`).run(o.idempotencyKey);}catch{}const {guardRefusal,...rest}=r;return rest;}/* refusals are not cached: retry works after Face ID trust */
    const cat=MD.classifyCategory({purpose:o.purpose,item:order?.item,merchant:order?.merchant,host:order?.host});const ord=info?.mandate?{...(order??{}),purpose:cat,mandateId:info.mandate.id}:{...(order??{}),purpose:cat};
    recordOrder(r,{agentId:o.agentId,payee:info?.payee??null,amount:info?.amount,tier:info?.tier??'x402',status:info?.status??null,order:ord,source:o.addressSource});
    if(info?.mandate&&r?.state==='paid')MD.used(info.mandate.id);
    return info&&r&&typeof r==='object'?{...r,payee_tier:info.tier,payee_tier_text:info.extra?.payee_tier_text??TIER_SAY[info.tier],...(info.mandate?{mandate:info.mandate}:{})}:r;};
  const paidFetchInner=({agentId=agentDefault,intentId,repeatKey,url,method='GET',headers={},body,idempotencyKey,maxAmount,ownerApproval,addressSource,purpose,fetchImpl=cfg.fetch??fetch})=>withIdem(idempotencyKey,agentId,{op:'fetch',v:5,intentId,repeatKey,url,method,body,maxAmount},async()=>{
    const first=await fetchImpl(url,{method,headers,body});
    if(first.status!==402)return {state:'no_payment_needed',status:first.status,body:(await first.text()).slice(0,20000)};
    const text=await first.text();let parsed;try{parsed=JSON.parse(text);}catch{}
    const n=detect({status:402,headers:first.headers,body:parsed??text,url},{chains:[cfg.chainId]});
    if(!n.ok)return {state:'rejected',reason:n.code,detail:n.detail};
    if(agentId!=='owner'){if(!n.payee)return {state:'rejected',reason:'x402_payee_unknown',nothingPaid:true,guardRefusal:true};
      let host=null;try{host=new URL(url).hostname.toLowerCase();}catch{}
      const g=await gate({payee:n.payee,amount:typeof n.amount==='bigint'?n.amount:BigInt(n.amount??0),agentId,source:addressSource,mode:'x402',purpose:purposeKey(purpose)??undefined,host});if(g.reject)return {...g.reject,guardRefusal:true};
      x402Info.set(idempotencyKey,{tier:g.tier,payee:n.payee,amount:String(n.amount),status:g.v.status,mandate:g.mandate?{id:g.mandate.id,purpose:g.mandate.purpose}:null,extra:g.extra});}
    const fl=cfg.float?.enabled?await floatFetch(n,{agentId,intentId,repeatKey,url,method,headers,body,fetchImpl,maxAmount}):null;
    if(fl)return fl;
    const r=await payNormalized(n,{agentId,intentId,repeatKey,ownerApproval,maxTotal:maxAmount,allowance:x402Info.get(idempotencyKey)?.tier==='mandate'});
    if(['in_progress','already_prepared','already_paid'].includes(r.state)){
      for(let i=0;i<90;i++){const row=ledger.get(r.purchaseKey);if(row.state==='paid')return {state:'paid_by_other_agent',purchaseKey:r.purchaseKey,paidBy:row.claimed_by,result:row.result?JSON.parse(row.result):null};
        if(row.state==='failed'||row.state==='reclaimed')return {state:'other_agent_'+row.state,purchaseKey:r.purchaseKey};await new Promise(z=>setTimeout(z,1000));}
      return {state:'in_progress',purchaseKey:r.purchaseKey,paidBy:r.paidBy};}
    if(r.state!=='prepared')return r;
    let second;for(let attempt=0;attempt<3;attempt++){
      second=await fetchImpl(url,{method,headers:{...headers,[r.paymentHeader.name]:r.paymentHeader.value},body});
      if(second.status!==402||attempt===2)break;await second.text().catch(()=>{});await new Promise(z=>setTimeout(z,cfg.retryDelayMs??4000));}
    const resp=second.headers.get('PAYMENT-RESPONSE')??second.headers.get('X-PAYMENT-RESPONSE');
    let settlement;try{settlement=resp?JSON.parse(Buffer.from(resp,'base64').toString()):undefined;}catch{}
    const out={state:second.ok?'paid':'payment_not_accepted',status:second.status,purchaseKey:r.purchaseKey,prepareTx:r.txHash,auth:r.auth,digest:r.digest,settlement,
      amount:n.amount.toString(),fee:r.fee,networkFee:r.networkFee,gasRecovery:r.gasRecovery,total:(n.amount+BigInt(r.fee??0)+BigInt(r.networkFee??0)).toString(),body:(await second.text()).slice(0,20000)};
    ledger.update(r.purchaseKey,agentId,second.ok?{state:'paid',settle_tx:settlement?.transaction??null,result:{...out,vault:r.vault,digest:r.digest}}:{state:'prepared',result:{...r,merchantResponse:out}});
    // ONE sponsored tx per x402 payment: no inline markSettled. Fees wait in the adapter until settleRoutine closes reservations in a batch.
    if(second.ok&&cfg.markSettledInline===true)pendingClose.push(markSettledOne(r.digest,r.auth).catch(()=>{}));
    return out;
  });

  /** Sub-threshold x402 exact payment from the daily float: a session-key voucher, no tx of ours. null = use the normal path. */
  async function floatFetch(n,{agentId,intentId,repeatKey,url,method,headers,body,fetchImpl,maxAmount}){
    if(n.mode!=='eip3009'||n.chainId!==cfg.chainId)return null;
    if(maxAmount!==undefined&&n.amount+feeFor(n.amount,await fee())>BigInt(maxAmount))return {state:'rejected',reason:'over_agent_max_amount_incl_fees'};
    const ar=agentReason(agentId,n.amount);if(ar)return {state:'rejected',reason:ar};
    if(await SC.check(n.payee))return null; // sanctioned: the normal path refuses with SANCTIONED_ADDRESS
    const nowS=await chainNow();const r=await route(n,nowS);if(r.reason)return null; // denied / blocked: the normal path explains why
    let id;try{id=identity(n,{intentId,repeatKey},r);}catch{return null;}
    const key=id.ledgerKey;const prev=ledger.get(key);
    if(prev&&BigInt(prev.amount)!==n.amount&&['claimed','submitted','prepared','paid'].includes(prev.state))return {state:'rejected',reason:'price_changed',purchaseKey:key};
    const claim=ledger.claim(key,n,intentId,agentId);if(!claim.won)return null; // another agent has it: the normal path waits / reports
    const v=await float.voucher(n,id,{nowS});
    if(!v){ledger.update(key,agentId,{state:'failed'});return null;}
    if(v.state!=='voucher'){ledger.update(key,agentId,v.state==='already_paid_on_chain'?{state:'paid',result:{note:'float voucher already settled'}}:{state:'failed'});return v;}
    ledger.setMeta(key,agentId,{merchantId:directory(n)?.id??r.merchant??undefined,tier:'float'});
    const header=x402Header(n,v.signature,v.auth);
    ledger.update(key,agentId,{state:'prepared',result:{float:true,auth:v.auth,fee:v.fee,networkFee:'0'}});
    const second=await fetchImpl(url,{method,headers:{...headers,[header.name]:header.value},body});
    const resp=second.headers.get('PAYMENT-RESPONSE')??second.headers.get('X-PAYMENT-RESPONSE');let settlement;try{settlement=resp?JSON.parse(Buffer.from(resp,'base64').toString()):undefined;}catch{}
    const out={state:second.ok?'paid':'payment_not_accepted',via:'float',status:second.status,purchaseKey:key,auth:v.auth,settlement,amount:n.amount.toString(),fee:v.fee,networkFee:'0',
      total:(n.amount+BigInt(v.fee)).toString(),note:v.note,body:(await second.text()).slice(0,20000)};
    ledger.update(key,agentId,second.ok?{state:'paid',settle_tx:settlement?.transaction??null,result:{float:true,auth:v.auth,fee:v.fee,networkFee:'0',settlement}}:{state:'prepared',result:{float:true,auth:v.auth,merchantResponse:out.status}});
    float.markVoucher(v.auth.nonce,second.ok?'settled':'signed');
    return out;
  }
  /** Owner exit plan (service-down safe): pause + revoke + cancel open reservations + close float + sweep vault in ONE batch, plus an
   *  OPTIONAL separately signed step that settles outstanding failed-tx gas (never blocks the exit). */
  async function exitPlan(){
    const fc=await rd('fees');const recipient=await rd('feeRecipient',[],fc);const vault=await rd('vaultAddress',[p.account]);
    let floatOpen=false;try{floatOpen=(await rd('floats',[p.account]))[4];}catch{}
    const openDigests=[];for(const row of ledger.db.prepare(`SELECT result FROM purchases WHERE state='prepared'`).all()){let res;try{res=JSON.parse(row.result);}catch{continue;}
      const d=res.digest??res.result?.digest;if(!d||res.float)continue;try{if((await rd('reservations',[d]))[4])openDigests.push(d);}catch{}}
    const debts=gas.debts(p.account).filter(d=>BigInt(d.amount)>BigInt(d.recovered)).map(d=>({id:d.id,txHash:d.tx_hash,amount:(BigInt(d.amount)-BigInt(d.recovered)).toString()}));
    return buildExitPlanV5({chainId:cfg.chainId,wallet:p.account,adapter:cfg.adapter,trust:await trustAddr(),manager:cfg.manager,permission:cfg.permission,vault,openDigests,floatOpen,
      gasDebt:{amount:gas.outstanding(p.account),recipient,token:cfg.token,debts}});
  }
  /** After the owner signed the optional settle step: verify the on-chain USDC transfer wallet -> fee recipient, then mark debts recovered (FIFO). */
  async function recordGasSettlement(txHash){
    const rc=await c.pub.getTransactionReceipt({hash:txHash});if(rc.status!=='success')return {state:'rejected',reason:'tx_failed'};
    if(gas.db.prepare(`SELECT 1 FROM gas_recovery WHERE tx_hash=?`).get(txHash))return {state:'already_recorded'};
    const fc=await rd('fees');const recipient=String(await rd('feeRecipient',[],fc)).toLowerCase();let paid=0n;
    const T=parseAbiX(['event Transfer(address indexed from,address indexed to,uint256 value)']);
    for(const l of rc.logs){if(l.address.toLowerCase()!==cfg.token.toLowerCase())continue;try{const e=decodeEventLog({abi:T,data:l.data,topics:l.topics});
      if(e.args.from.toLowerCase()===p.account.toLowerCase()&&e.args.to.toLowerCase()===recipient)paid+=e.args.value;}catch{}}
    if(paid===0n)return {state:'rejected',reason:'no_matching_transfer'};
    const o=gas.outstanding(p.account);const applied=paid<o?paid:o;gas.applyRecovery(p.account,applied,txHash);
    return {state:'recorded',paid:paid.toString(),applied:applied.toString(),outstanding:gas.outstanding(p.account).toString()};
  }
  /** markSettled one reservation once the facilitator's transferWithAuthorization landed. Anyone may call it on chain. */
  async function markSettledOne(digest,auth,{waitTries=10,waitMs=2000}={}){
    for(let i=0;i<waitTries;i++){if(await rd('authorizationState',[auth.from,auth.nonce],cfg.token))break;if(i===waitTries-1)return {digest,state:'not_settled_yet'};await new Promise(z=>setTimeout(z,waitMs));}
    const rs=await rd('reservations',[digest]);if(!rs[4])return {digest,state:'already_closed'};
    const tx=await write('markSettled',[[digest]],{label:'markSettled:'+digest});return {digest,state:'marked',txHash:tx.hash};
  }
  /** ROUTINE (code only, no scheduler): close every open x402 reservation this ledger knows about.
   *  settled on the token -> ONE batched markSettled([...]) for all of them (fees move to accruedFees; after FEE_CLAIM_WINDOW
   *  the contract returns the protocol fee to the owner); expired and unused -> reclaim (amount + protocol fee back; the network
   *  fee already paid for gas incl. this closing share). Idempotent; safe from any agent, the owner's tooling, or an operator cron. */
  async function settleRoutine({nowS,maxBatch=50}={}){
    const now=nowS??await chainNow();const out=[];const toMark=[];
    for(const row of ledger.list().filter(r=>['prepared','paid'].includes(r.state)&&r.result)){
      let res;try{res=JSON.parse(row.result);}catch{continue;}if(res.float)continue;const digest=res.digest??res.result?.digest;const auth=res.auth;if(!digest||!auth)continue;
      const rs=await rd('reservations',[digest]);if(!rs[4]){out.push({key:row.purchase_key,digest,state:'closed'});continue;}
      const used=await rd('authorizationState',[auth.from,auth.nonce],cfg.token);
      if(used){toMark.push({key:row.purchase_key,digest});continue;}
      try{
        if(BigInt(now)>=BigInt(rs[2])){const tx=await write('reclaim',[digest],{label:'reclaim:'+digest});
          ledger.db.prepare(`UPDATE purchases SET state='reclaimed',settle_tx=? WHERE purchase_key=?`).run('reclaim '+tx.hash,row.purchase_key);out.push({key:row.purchase_key,digest,state:'reclaimed',txHash:tx.hash});continue;}
        out.push({key:row.purchase_key,digest,state:'waiting',validBefore:rs[2].toString()});
      }catch(e){out.push({key:row.purchase_key,digest,state:'error',error:String(e.shortMessage??e.message).slice(0,160)});}
    }
    for(let i=0;i<toMark.length;i+=maxBatch){const part=toMark.slice(i,i+maxBatch);
      try{const tx=await write('markSettled',[part.map(x=>x.digest)],{label:'markSettled:batch:'+part.length});
        for(const x of part){ledger.db.prepare(`UPDATE purchases SET state='paid',settle_tx=COALESCE(settle_tx,?) WHERE purchase_key=?`).run('markSettled '+tx.hash,x.key);out.push({key:x.key,digest:x.digest,state:'marked',txHash:tx.hash,batch:part.length});}}
      catch(e){for(const x of part)out.push({key:x.key,digest:x.digest,state:'error',error:String(e.shortMessage??e.message).slice(0,160)});}}
    return j(out);
  }
  /** Anyone: move accrued fees to the fee recipient in one transfer (code only; no scheduler). */
  async function collectFees(){const acc=await rd('accruedFees');if(acc===0n)return {state:'nothing_to_collect'};const tx=await write('collectFees',[],{label:'collectFees'});return j({state:'collected',amount:acc,txHash:tx.hash});}

  // ---------------- owner actions (trust / untrust / deny signer / one-time approval) ----------------
  // The gateway prepares EIP-712 typed data; the OWNER signs it in their wallet; anyone (the executor) relays it.
  // Every request also carries the equivalent direct owner call for wallet_sendCalls.
  const walletCallTo=(target,fn,args)=>({to:p.account,data:encodeFunctionData({abi:v5Abi,functionName:'execute',args:[getAddress(target),0n,encodeFunctionData({abi:v5Abi,functionName:fn,args})]})});
  let trustSync=cfg.trust?getAddress(cfg.trust):null;trustAddr().then(a=>{trustSync=a;}).catch(()=>{});
  const walletCall=(fn,args)=>walletCallTo(TRUST_FNS.has(fn)?(trustSync??cfg.adapter):cfg.adapter,fn,args);
  /** One-tap trust. merchantId = the human-readable merchant name/domain the owner sees (merchant = keccak256(name)).
   *  Defaults: 90 days (max 365, never permanent), caps min(TRUST_DEFAULTS, permission caps). The per-payment cap is on the
   *  amount; the daily cap counts fees, so it gets protocol-fee headroom unless capsIncludeFee. */
  async function trustRequest({merchantId,payees=[],signers=[],single,daily,expiresInDays=TRUST_DEFAULTS.days,deadlineSec=3600,capsIncludeFee=false,anyPayee=false}){
    // V5.1 anyPayee: the owner trusts the merchant's ORDER SIGNER(S) to name a fresh payee per order (within these caps); unsigned
    // payments to unknown addresses stay stranger tier. Needs at least one signer; payees may then be empty.
    if(anyPayee&&!V51)return {ok:false,code:'any_payee_needs_v5_1'};
    if(anyPayee&&!(Array.isArray(signers)&&signers.length))return {ok:false,code:'any_payee_needs_signer'};
    if(!merchantId||!Array.isArray(payees)||(!payees.length&&!anyPayee))return {ok:false,code:'merchant_and_payees_required'};
    {const h=await SC.checkAll([...payees,...(signers??[])]);if(h)return {ok:false,code:'SANCTIONED_ADDRESS',address:h.address,detail:h.say_en,say_to_user:h.say_zh+' / '+h.say_en};}
    const name=String(merchantId).trim().toLowerCase();
    if(!(expiresInDays>0&&expiresInDays<=TRUST_DEFAULTS.maxDays))return {ok:false,code:'trust_days_1_to_365',detail:'trust always expires; max 365 days'};
    const f=await fee();const hd=v=>capsIncludeFee?BigInt(v):withFeeHeadroom(v,f.ppm);
    const s1=single!==undefined?BigInt(single):min(TRUST_DEFAULTS.single,B('single'));const d1=daily!==undefined?BigInt(daily):min(TRUST_DEFAULTS.daily,B('daily'));
    const cnow=await chainNow();const exp=BigInt(cnow+Math.round(expiresInDays*86400));
    const trust={merchant:merchantIdBytes(name),name,payees:payees.map(a=>getAddress(a)),signers:signers.map(a=>getAddress(a)),single:s1,daily:hd(d1),expiry:exp,...(V51?{anyPayee:!!anyPayee}:{})};
    if(trust.single>trust.daily)return {ok:false,code:'single_above_daily'};
    if(trust.single>B('single'))return {ok:false,code:'single_above_permission_single',detail:'the permission single cap still applies on chain'};
    const epoch=(await rd('trustOf',[p.account,trust.merchant]))[0];const nonce=newNonce(),deadline=BigInt(cnow+deadlineSec);
    const {typedData,digest}=trustTypedData(ownerCtx,{account:p.account,trust,epoch,nonce,deadline});
    return j({ok:true,action:'trust',merchantId:name,trust,epoch,nonce,deadline,typedData,digest,ownerDirectCall:walletCall('setTrust',[trust]),
      human:`Trust ${name}: up to ${Number(s1)/1e6} USDC per payment, ${Number(d1)/1e6} USDC per day, for ${expiresInDays} days`+(anyPayee?' (orders signed by its signer may name a new deposit address each time)':''),
      note:'owner signs typedData (eth_signTypedData_v4 in the wallet; it shows the merchant name); then the owner-side kit relays it (agents cannot). Valid only for the current epoch.'});
  }
  async function trustSubmit({trust,nonce,deadline,signature}){
    {const h=await SC.checkAll([...(trust?.payees??[]),...(trust?.signers??[])]);if(h)return {state:'rejected',reason:'SANCTIONED_ADDRESS',address:h.address,say_to_user:h.say_zh+' / '+h.say_en};}
    const t={merchant:trust.merchant,name:trust.name,payees:trust.payees.map(a=>getAddress(a)),signers:(trust.signers??[]).map(a=>getAddress(a)),single:BigInt(trust.single),daily:BigInt(trust.daily),expiry:BigInt(trust.expiry),...(V51?{anyPayee:!!trust.anyPayee}:{})};
    const tx=await write('trustBySig',[p.account,t,nonce,BigInt(deadline),signature],{label:'trustBySig:'+t.merchant});return {state:'trusted',txHash:tx.hash,merchant:t.merchant,name:t.name};
  }
  async function untrustRequest({merchantId,deadlineSec=3600}){
    const merchant=merchantIdBytes(merchantId);const cnow=await chainNow();const nonce=newNonce(),deadline=BigInt(cnow+deadlineSec);
    const {typedData,digest}=untrustTypedData(ownerCtx,{account:p.account,merchant,nonce,deadline});
    return j({ok:true,action:'untrust',merchantId,merchant,nonce,deadline,typedData,digest,ownerDirectCall:walletCall('untrust',[merchant])});
  }
  async function untrustSubmit({merchant,nonce,deadline,signature}){const tx=await write('untrustBySig',[p.account,merchant,nonce,BigInt(deadline),signature],{label:'untrustBySig:'+merchant});return {state:'untrusted',txHash:tx.hash,merchant};}
  async function denySignerRequest({signer,deadlineSec=3600}){const cnow=await chainNow();const nonce=newNonce(),deadline=BigInt(cnow+deadlineSec);
    const {typedData,digest}=denySignerTypedData(ownerCtx,{account:p.account,signer,nonce,deadline});return j({ok:true,action:'deny_signer',signer:getAddress(signer),nonce,deadline,typedData,digest,ownerDirectCall:walletCall('setDeniedSigner',[getAddress(signer),true])});}
  async function denySignerSubmit({signer,nonce,deadline,signature}){const tx=await write('denySignerBySig',[p.account,getAddress(signer),nonce,BigInt(deadline),signature],{label:'denySignerBySig:'+signer});return {state:'signer_denied',txHash:tx.hash};}
  /** One-time owner approval for a single direct / x402 purchase above its tier caps (still within the permission caps). */
  async function approvalRequest(input,{repeatKey,intentId,windowSec}={}){
    const n=await resolveN(input);if(n.ok===false)return {ok:false,code:n.code};if(n.mode==='signed')return {ok:false,code:'signed_orders_use_trust'};
    let id;try{id=identity(n,{repeatKey,intentId});}catch{return {ok:false,code:'purchase_ref_required'};}
    const cnow=await chainNow();const deadline=BigInt(cnow+(windowSec??(n.mode==='eip3009'?540:3600))); // x402: the deadline becomes validBefore (<= 600 s at prepare time)
    const {typedData,digest}=approvalTypedData(ownerCtx,{account:p.account,purchaseKey:id.purchaseKey,payee:n.payee,amount:n.amount,deadline});
    return j({ok:true,action:'approve_once',purchaseKey:id.ledgerKey,onchainPurchaseKey:id.purchaseKey,payee:n.payee,amount:n.amount,fee:feeFor(n.amount,await fee()),maxNetworkFee:B('maxNetworkFee'),deadline,typedData,digest,
      next:'owner signs; then pay with ownerApproval {signature, deadline}'});
  }
  /** Executor emergency pause: expires by itself after 24 h (a guardian or owner pause lasts until the owner unpauses).
   *  One executor per tenant (KMS later), so a compromised executor can at most pause one tenant for 24 h. */
  async function pause(){const tx=await write('pause',[p],{label:'pause'});const cnow=await chainNow();return {state:'paused',txHash:tx.hash,expiresAt:cnow+86400,note:'executor pause auto-expires after 24h; the owner can unpause earlier',unpause:walletCall('setPaused',[false])};}

  async function status(){
    const s=await chainState(null,null,null);const f=await fee();const vault=await rd('vaultAddress',[p.account]);const pausedUntil=await rd('pausedUntil',[p.account]).catch(()=>0n);
    const [vb,vr]=await Promise.all([rd('balanceOf',[vault],cfg.token),rd('reserved',[],vault).catch(()=>0n)]);
    return j({version:5,gasMode,warning:gasMode==='f2'?F2_WARNING:null,chainId:cfg.chainId,wallet:p.account,adapter:cfg.adapter,usdc:s.bal,permissionHash:s.ph,termSpent:s.term,todaySpent:s.today,strangerTodaySpent:s.openToday,verifiedTodaySpent:s.verToday,paused:s.paused,pausedUntil,
      caps:{single:P.single,daily:P.daily,term:P.term,openSingle:P.openSingle,openDaily:P.openDaily,verifiedSingle:P.verifiedSingle,verifiedDaily:P.verifiedDaily,note:'per-payment caps count the merchant amount; daily and term caps count amount + protocol fee + network fee'},
      registry:lc(P.registry)===lc(ZERO)?null:P.registry,protocolFee:{ppm:f.ppm,percent:Number(f.ppm)/10000,cap:'none',minimum:'none',paidBy:'payer (merchant pays 0)',recipient:f.recipient,controller:f.controller??null,ownerAccepted:{maxFeePpm:P.maxFeePpm}},
      networkFee:{rule:'actual gas cost of each payment, in USDC, no markup; never subsidized',ownerMaxPerPayment:P.maxNetworkFee,marginBps:GP.marginBps??0,
        ethUsd:GP.usdcPerEth!==undefined?'fixed (testnet config)':GP.oracle?'live Chainlink ETH/USD':'unset',priceCheck:lastPriceCheck,outstandingFailedGas:gas.outstanding(p.account)},
      vault:{address:vault,balance:vb,reserved:vr},gatewayTestLimit:cfg.maxPaymentAtomic??null,validFrom:p.start,validUntil:p.end,expiry:expiryReminders(p,{now:s.cnow})});
  }
  async function limits({agentId=agentDefault}={}){
    const st=await status();const s=await chainState(null,null,null);const f=await fee();const sub=(a,b)=>a>b?a-b:0n;
    const rem={single:B('single'),today:sub(B('daily'),s.today),term:sub(B('term'),s.term),strangerSingle:B('openSingle'),strangerToday:sub(B('openDaily'),s.openToday),verifiedToday:sub(B('verifiedDaily'),s.verToday)};
    const mp=Object.fromEntries(Object.entries(rem).map(([k,v])=>[k,['single','strangerSingle'].includes(k)?v:maxPayableWithin(v,f)]));
    return j({...st,remaining:rem,maxPayableMerchantAmount:mp,agent:cfg.agents?agentBudgetStatus(agentsById.get(agentId),ledger,p,s.cnow)??{agentId,error:'unknown_agent'}:null});
  }
  async function merchantInfo({payee,signer,merchantId}={}){
    const out={directory:(cfg.merchantRegistry??[]).find(m=>m.id===merchantId||(payee&&(m.payTo??[]).map(lc).includes(lc(payee)))||(signer&&(m.signers??[]).map(lc).includes(lc(signer))))??null};
    if(merchantId){const t=await rd('trustOf',[p.account,merchantIdBytes(merchantId)]);out.ownerTrust={merchant:merchantIdBytes(merchantId),epoch:t[0],expiry:t[1],active:t[2],single:t[3],daily:t[4],...(V51?{anyPayee:t[5]}:{})};}
    if(payee||signer){const n=signer?{mode:'signed',payee:getAddress(payee??ZERO),signedOrder:{signer:getAddress(signer)}}:{mode:'direct',payee:getAddress(payee)};out.route=await route(n,await chainNow());}
    out.history=ledger.history({payee,merchantId});return j(out);
  }
  const claimPurchase=({agentId=agentDefault,intentId,lineKey,ttlSec=600,note})=>{
    if(!/^[A-Za-z0-9._:-]{1,128}$/.test(String(intentId))||!/^[A-Za-z0-9._:/-]{1,256}$/.test(String(lineKey)))return {won:false,error:'bad_intent_or_line_key'};
    return ledger.claimLine(intentId,lineKey,agentId,{ttlMs:Math.min(Math.max(10,ttlSec),86400)*1000,note});};
  const listPurchases=(q={})=>ledger.listFiltered(q).map(r=>({purchaseKey:r.purchase_key,state:r.state,standard:r.standard,payee:r.payee,amount:r.amount,ref:r.ref,agent:r.origin_agent??r.claimed_by,merchant:r.merchant_id,label:r.label??null,tier:r.tier,txHash:r.tx_hash,createdAt:r.created_at,order:orderFor(r.purchase_key)}));
  const idle=async()=>{await Promise.all(pendingClose);await c.idle?.();};
  const requestRefund=({purchaseKey,reason='other',note=''}={},agentId)=>{if(!cfg.disputes)throw Error('disputes are not enabled on this gateway');
    const pr=listPurchases({limit:100000}).find(x=>x.purchaseKey===purchaseKey||x.txHash===purchaseKey);if(!pr)return {state:'rejected',reason:'unknown_purchase',detail:'no payment with that purchase key; see kipurse_list_purchases'};
    const c=cfg.disputes.open({purchase:pr,reason,note,by:agentId?'agent:'+agentId:'owner'});
    return {state:'opened',case:{...c,state:caseState(c),respondBy:c.openedAt+RESPONSE_WINDOW_SEC},refundRequest:refundRequest(c,{wallet:p.account}),refundTo:p.account,network:'Base',asset:'USDC',
      merchantInstructions:`To refund, send up to ${(Number(c.amount)/1e6).toFixed(6)} USDC on Base to ${p.account} (reference ${c.reference}). Kipurse matches refunds from the paying address ${c.payee} automatically.`};};
  const disputes=()=>cfg.disputes?cfg.disputes.list().map(c=>({...c,state:caseState(c),respondBy:c.openedAt+RESPONSE_WINDOW_SEC})):[];
  const cardCreate=async(o,agentId)=>{if(!cfg.cards)return {state:'rejected',reason:'no_card_provider',detail:'real-world cards are not enabled on this gateway'};
    return cfg.cards.create({...o,agentId},({to,amountAtomic,merchant,orderRef,idempotencyKey})=>payAny({agentId,order:o.order??normalizeOrder(o),payment:{to,amountAtomic,asset:'USDC'},merchant,orderRef,idempotencyKey,maxAmount:o.maxAmount}));};
  const cards=()=>cfg.cards?cfg.cards.list():[];
  const cardSimulate=(cardId,o)=>{if(!cfg.cards?.test)return {approved:false,reason:'simulation_only_in_test_mode'};return cfg.cards.authorize(cardId,o);};
  // Universal agent->owner trust requests (same path for every agent key). The owner half lives on cfg (non-enumerable), never on the engine.
  const TR=(()=>{const file=cfg.trustRequestsFile??(cfg.ownerRulesDir?joinPath(cfg.ownerRulesDir,'trust-requests.json'):null);if(!file)return null;
    const r=createTrustRequests({store:cfg.atRest,file,chainId:Number(cfg.chainId),prepare:o=>trustRequest(o),submit:o=>trustSubmit(o),notify:cfg.ownerNotify,ownerSigner:cfg.ownerSigner?{wallet:getAddress(cfg.ownerSigner.wallet??p.account),ownerIndex:Number(cfg.ownerSigner.ownerIndex)}:null});
    Object.defineProperty(cfg,'__trustRequestsOwner',{value:{api:r.ownerApi,cap:r.ownerCapability},enumerable:false,configurable:true});return r.agentApi;})();
  const approvalLink=r=>cfg.trustApprovalBase&&r&&['awaiting_owner','awaiting_signature'].includes(r.status)?{ownerApprovalUrl:cfg.trustApprovalBase+'?id='+r.id,
    ownerInstruction:'Send this link to your HUMAN owner and wait. Only he can approve, by signing with his own Base Account on that page. Then poll kipurse_get_trust_request_status until "trusted".'}:{};
  const requestTrustFromOwner=wrap(async o=>{if(!TR)throw Error('trust requests not configured');const r=TR.request(o);return {...r,...approvalLink(r)};});
  const trustRequestStatus=wrap(async ({id})=>{if(!TR)throw Error('trust requests not configured');const r=TR.status(id);return {...r,...approvalLink(r)};});
  return {version:5,sanctions:SC,mandates:MD,merchantStatus,setOrderExtra,isPaused:()=>isPaused(),ledgerPath:ledgerFile,orderFor,orderForTx,listHolds,cancelHold,releaseHold,spendingSummary,agentSafetyPause,addressBook,resolvePayeeName,nameOf,setPayeeName:(a,n)=>setName(a,n,'owner',true),pendingHoldsDue:()=>{try{return ledger.db.prepare(`SELECT count(*) AS n FROM payment_hold WHERE state='pending'`).get().n;}catch{return 0;}},guardrails:()=>({trialSingle:GUARD.trialSingle.toString(),trialDaily:GUARD.trialDaily.toString(),evidenceThreshold:GUARD.evidenceThreshold.toString(),trialUsed24h:trialSpent24h().toString()}),verifyPayee,requestTrustFromOwner,trustRequestStatus,requestRefund,disputes,cardCreate,cards,cardSimulate,idle,status,limits,parse,preflight,pay,payAny,payMerchantOrder,setup,setLimits,proposeTrust,trustList,depositInfo:depositInfoFn,deposits:depositsList,requestWithdrawal,executeWithdrawal,discoverMerchant:discover,parseAny,paidFetch,payNormalized,settleRoutine,markSettledOne,reclaimExpired:settleRoutine,
    exportCsv:(o={})=>toCsv(ledger.db,{tz:cfg.timeZone??'America/Chicago',...o,chainId:cfg.chainId,token:cfg.token}),
    receipt:(key,o={})=>taxReceipt(ledger.db,key,{tz:cfg.timeZone??'America/Chicago',...o,chainId:cfg.chainId,token:cfg.token,payer:p.account}),
    annualSummary:(year,o={})=>annualSummary(ledger.db,year??new Date().getFullYear(),{tz:cfg.timeZone??'America/Chicago',...o,chainId:cfg.chainId,token:cfg.token}),
    exitPlan,recordGasSettlement,collectFees,floatFund:async o=>{/* t621 #8: funding the float is checked against the everyday 24h limit */const ev=(()=>{try{return cfg.everydayGet?.()??null;}catch{return 'err';}})();
      if(ev==='err')return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true};
      if(ev&&(ev.authorized===false||ev.daily==null||ev.term==null))return {state:'rejected',reason:'AI_LIMITS_UNCONFIRMED',nothingPaid:true};
      if(ev){let amt;try{amt=o?.amount!==undefined?BigInt(o.amount):BigInt(await rd('floatCap',[p.account]));}catch{return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true};}
        const spentTerm=spentCumulative();if(spentTerm==null)return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true};
        if(spentTerm+amt>BigInt(ev.term))return capHit({state:'rejected',reason:'EVERYDAY_TERM_LIMIT',nothingPaid:true,capHit:true,limit:ev.term,fix:'Funding the float would exceed the explicit AI total. Nothing was funded.',say_to_user:'没有充入小额池：这会超过你设的 AI 总额。/ Not funded: it would go over the total you set.'});
        if(everydaySpent()+amt>BigInt(ev.daily))return capHit({state:'rejected',reason:'EVERYDAY_DAILY_LIMIT',nothingPaid:true,capHit:true,limit:ev.daily,fix:'Funding the micropayment float would go over the owner’s everyday 24h limit (the float counts as spent). Nothing was funded.',say_to_user:'没有充入小额池：这会超过你设的日常额度（小额池里的钱算作已花）。/ Not funded: it would go over your everyday limit (the float counts as spent).'});}
      return float.fund(o);},floatReconcile:()=>float.reconcile(),floatStatus:()=>float.status(),gasBook:gas,resetAgentFailures:a=>gas.resetFailures(a),trustRequest,trustSubmit,untrustRequest,untrustSubmit,denySignerRequest,denySignerSubmit,approvalRequest,pause,claimPurchase,merchantInfo,listPurchases,ledger,client:c,permission:p,policy:P};
}
