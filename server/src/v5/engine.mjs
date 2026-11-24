// SPDX-License-Identifier: AGPL-3.0-only
// Kipurse V5 pay engine (M2, 2026-10-17), the V5 mode next to the V4 engine (src/v4/engine.mjs keeps serving V4).
// parse -> preflight (amount + protocol fee + network fee quote, per-cap maxPayable) -> claim (shared ledger, canonical key) -> pay -> record.
// Payee and amount come ONLY from parsed protocol data (detector). The adapter enforces per-payment caps on the AMOUNT and
// daily / term caps on amount + fees. Users bear all gas: networkFee = actual gas cost quoted here (no markup) <= owner max;
// this engine mirrors the adapter's routing so agents get a precise "why not" before anything is sent.
import {randomBytes} from 'node:crypto';import {guardFetch,readCapped} from './ssrf.mjs';import {scrubUrls} from './store.mjs';
/* t1278 S6: an error text that reaches an answer or a stored record: URLs (RPC / bundler keys) and token=... removed, length bounded */
const errText=(e,n=160)=>scrubUrls(e?.shortMessage??e?.message??e).slice(0,n);
// t796 L3: every merchant request goes through the SSRF guard (public https hosts only, no redirects). Injected test fetch skips DNS.
const mfetch=cfg=>guardFetch(cfg.fetch??globalThis.fetch,{allowLocal:!!cfg.allowHttpMerchantForTests,resolve:cfg.resolveHost??(cfg.fetch?async()=>[{address:'93.184.216.34'}]:undefined)});
import {getAddress,hashDomain,recoverTypedDataAddress,encodeFunctionData} from 'viem';
import {detect} from '../v4/detector.mjs';import {createSanctions} from './sanctions.mjs';import {normalizePaymentRequest} from './request.mjs';
import {V4Ledger} from '../v4/ledger.mjs';import {createOwnerAsks} from './owner-ask.mjs';
import {isRevokedSigner} from '../security/revoked-signers.mjs';
import {expiryReminders} from '../v4/reminders.mjs';
import {agentBudgetReason,agentBudgetStatus} from '../v4/agents.mjs';
import {abiFor,TRUST_FNS,ZERO,ZERO32,TIERS,decodePolicyV5,permissionFromJson,feeFor,maxPayableWithin,withFeeHeadroom,quoteNetworkFee} from './abi.mjs';
import {identityV5,signedLedgerKey,signedPurchaseKeyV5,merchantIdBytes} from './ref.mjs';
import {v5Client} from './chain.mjs';import {createMandates,purposeKey,purposeName,fmtUsdc as mUsd} from './mandates.mjs';import {classifyPayee,ADDRESS_SOURCES,groups4} from './address-trust.mjs';import {GUARD_DEFAULTS,normalizeOrder,checkOrder,checkTrial,TIER_LIMITS,claimedTier,ALL_SOURCES,TIER_SAY,checkAiVerified,blacklisted} from './guardrails.mjs';import {createTrustRequests} from './trust-requests.mjs';import {join as joinPath} from 'node:path';
import {createFloat} from './float.mjs';import {buildExitPlanV5} from './plan.mjs';import {createUserOpWriter,loadOrCreateSessionKey,GAS_MODES,sqliteQuotaStore} from './userop.mjs';import {decodeEventLog,parseAbi as parseAbiX} from 'viem';import {toCsv,receipt as taxReceipt,annualSummary} from './tax.mjs';
import {buildReceipt} from './receipt.mjs';import {caseState,refundRequest,RESPONSE_WINDOW_SEC} from './dispute-window.mjs';import {F2_WARNING} from './paymaster.mjs';import {authHeaderFor,redactSecrets} from './merchant-auth.mjs';import {discoverMerchant,orderToPayment,buildCreateOrder,orderSecrets,selectRoute} from './discovery.mjs';import {attestOrder,attestorOrderId,validDomain} from './attestor.mjs';import {verifyMerchantSignature} from './merchant-sig.mjs';import {readMerchantStatus} from './buy.mjs';import {QUESTIONS,disclosure,RISK_NOTICE_ZH,RISK_NOTICE_EN,buildOneSignatureBatchV5} from './owner-setup.mjs';import {depositInfo} from './owner-guard.mjs';
const USDC_OF={8453:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',84532:'0x036CbD53842c5426634e7929541eC2318f3dCF7e'};
import {GasBook,inflightLock,liveUsdcPerEth,ETH_USD_FEEDS,SEQUENCER_FEEDS,sequencerCheck,secondUsdcPerEth,divergenceBps,MAX_FAILURES_PER_AGENT_PER_DAY} from './gas.mjs';
import {trustTypedData,untrustTypedData,denySignerTypedData,approvalTypedData,newNonce} from './owner.mjs';
import {makeScope,scopeCheck} from './limit-scope.mjs';import {createApprovalUse,approvalKey,isOwnerApproval} from './approval-use.mjs';
import {costOf,costParts,incomingCost,missingOk} from './spend-cost.mjs';

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
  /* t1181u (§6#84): the engine's network + token; every off-chain limit record is pinned to it */
  const ENGINE_SCOPE=(()=>{try{return makeScope(cfg.chainId,cfg.token);}catch{return null;}})();
  const AU=createApprovalUse(ledger.db);/* t1181u: one owner approval = one x402 reservation (server side; contract fix on the branch) */
  const MD=createMandates({db:ledger.db,wallet:p.account,scope:ENGINE_SCOPE,costParams:()=>costParams(),walletCaps:()=>({single:B('single'),daily:B('daily'),term:B('term')}),nameOf:a=>{try{return nameOf(a);}catch{return null;}},onProposal:v=>{try{cfg.onMandateProposal?.(v);}catch{}}});
  const ASK=createOwnerAsks({db:ledger.db});/* t1170u §6#82: owner asks (new payee above an AI auto limit) */
  const OWNER_OK=Symbol('ownerApprovedAsk');/* set only by payApprovedByOwner (server code after the owner's Face ID); never reachable from AI JSON */
  /* t1278 S2: a signed order the SERVER fetched / built itself (autoSignedOrder, signed54, V5.1 attestor, layered attestor). Only these may be
     unbound (payer = 0); an order that came from the AI must name this wallet as payer, on every suite. Never reachable from AI JSON. */
  const SERVER_ORDER=Symbol('serverFetchedOrder');/* t1279 R1 (§6#139): an already-normalized request is trusted ONLY under this in-process Symbol; a JSON key "__normalized" from an AI is ignored */const NORMALIZED=Symbol('normalizedRequest');const normReq=n=>({[NORMALIZED]:n});const serverReq=so=>({signedOrder:so,[SERVER_ORDER]:true});
  /* t1278 S3/S4: the gate's decision for this payment (tier, order, allowance), handed by payGuarded / paidFetch / releaseHold to payNormalized
     for the in-transaction re-check at claim time. Server code only (a Symbol key never survives JSON). */
  const CTX=Symbol('guardCtx');
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
  const PAY_FNS=new Set(['payDirect','paySigned','paySignedTrusted','prepareAuthorization','fundFloat']);
  let bundlerQuota=null;try{bundlerQuota=cfg.bundlerQuotaStore??sqliteQuotaStore(ledger.db);}catch{bundlerQuota=null;}/* t1264: free-tier count survives restarts */
  let uow=null;const opWriter=gasMode!=='userop'?null:{async write(fn,args,o){uow??=createUserOpWriter({cfg,pub:c.pub,session:cfg.session??loadOrCreateSessionKey(cfg.sessionKeyFile),
    vault:getAddress(await c.read('vaultAddress',[p.account])),adapter:cfg.adapter,maxGasPerOp:B('maxNetworkFee'),
    dues:cfg.dues??null,quotaStore:bundlerQuota,
    onCharge:x=>gas.recordCharge({account:p.account,userOpHash:x.userOpHash,txHash:x.txHash,charged:x.charged,success:x.success,kind:x.kind})});return uow.write(fn,args,{...o,...(cfg.permitAtCap===true?{permitAtCap:true}:{}),kind:PAY_FNS.has(fn)?'pay':'owner'});}};   // t1252 (§6#121, V5.5): every gas permit at the owner's cap so the leftover allowance always covers the vault's own markSettled
  const f2Writer={async write(){throw Object.assign(Error('F2_X402_ONLY: degraded mode, no on-chain transactions; only x402 payments from an open float'),{code:'f2_x402_only'});}};
  const W=gasMode==='f2'?f2Writer:(writer??opWriter);
  const write=W?async(fn,args,o)=>W.write(fn,args,await at(fn,o)):async(fn,args,o)=>c.write(fn,args,await at(fn,o));
  const rd=async(fn,args,addr)=>c.read(fn,args,addr??(TRUST_FNS.has(fn)?await trustAddr():undefined));
  const execAddr=getAddress(P.executor);
  const agentsById=new Map((cfg.agents??[]).map(a=>[a.id,a]));
  const agentReason=(agentId,amount,networkFee=0n)=>{if(!cfg.agents)return null;const a=agentsById.get(agentId);if(!a)return 'unknown_agent';let cost=amount;try{cost=costIn(amount,networkFee);}catch{}return agentBudgetReason(a,ledger,amount,p,undefined,cost);};/* t1281: budgets count amount + fee */
  const chainNow=async()=>Number((await c.pub.getBlock()).timestamp);
  const domain={name:cfg.orderDomain?.name??'AgentWalletPaymentOrder',version:cfg.orderDomain?.version??'5',chainId:cfg.chainId,verifyingContract:getAddress(cfg.adapter)};
  const ownerCtx={adapter:cfg.adapter,chainId:cfg.chainId,version:V51?'5.1':'5'};
  // V5.1: the merchant domain is the STABLE order verifier (adapter.orders()); orders are consumed there per (wallet, signer, orderId)
  let verP=null;const verifierAddr=()=>verP??=cfg.orderVerifier?Promise.resolve(getAddress(cfg.orderVerifier)):c.read('orders',[]).then(getAddress);
  const orderUsedOnChain=async o=>V51?rd('used',[p.account,o.signer,o.orderId],await verifierAddr()):rd('orderUsed',[o.signer,o.orderId]);
  let feeCache=cfg.fee?{ppm:BigInt(cfg.fee.ppm),recipient:cfg.fee.recipient}:null;
  /* t1281 (§6#141): the live protocol fee rate, kept for the synchronous limit sums (inside the claim's BEGIN IMMEDIATE). Before the first chain
     read it is the owner-accepted maximum (Policy.maxFeePpm), i.e. never less than the real fee. */
  let PPM=feeCache?BigInt(feeCache.ppm):null;
  /* (a failed first read is not cached: the next call reads again; the limit sums meanwhile use the owner-accepted maximum) */
  const fee=async()=>{const pr=(feeCache??=(async()=>{const fc=await rd('fees');return {ppm:await rd('feePpm',[],fc),recipient:await rd('feeRecipient',[],fc).catch(()=>null),controller:fc};})());let f;try{f=await pr;}catch(e){if(feeCache===pr)feeCache=null;throw e;}try{PPM=BigInt(f.ppm);}catch{}return f;};
  const ppmNow=()=>PPM??B('maxFeePpm');
  /** t1281: the ONE cost formula's parameters (src/v5/spend-cost.mjs): every off-chain sum counts amount + protocol fee + network fee */
  const costParams=()=>({ppm:ppmNow(),maxNetworkFee:B('maxNetworkFee')});ledger.costParams=costParams;
  const costIn=(amount,networkFee=0n)=>incomingCost(amount,{ppm:ppmNow(),networkFee});
  const warmFee=async()=>{try{await fee();}catch{}};
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
  const float=createFloat({cfg,rd,write,p,B,ledger,fee,chainNow:()=>chainNow(),txLock,estimate,isPaused:()=>isPaused(),keyFile:(cfg.float?.sessionKeyFile)??(ledgerFile?ledgerFile+'.float-session.json':null),
    quote:async(n,gasUnits,fn,args)=>{const x=withRecovery(await networkFeeFor(n,gasUnits,dataOf({functionName:fn,args})));return {...x,applied:h=>settleGas(x,h)};}});
  const useRegistry=async()=>lc(P.registry??ZERO)!==lc(ZERO)&&!(await rd('registryOptOut',[p.account]));
  const reg=async(fn,args,dflt)=>{try{return await rd(fn,args,P.registry);}catch{return dflt;}}; // mirrors the adapter's try/catch: failing registry = not listed
  const liveTrust=async(binding,nowS)=>{const [m,ep]=binding;if(m===ZERO32)return null;const t=await rd('trustOf',[p.account,m]);
    return t[2]&&t[0]===ep&&BigInt(nowS)<t[1]?{merchant:m,single:t[3],daily:t[4],expiry:t[1]}:null;};
  const min=(a,b)=>a<b?a:b;

  /** t1264: a cached V5.5 inline (KPTR) trust counts only while its epoch is still the merchant's on-chain epoch (trust.trustOf): an untrust /
   *  epoch bump makes it stale -> normal tiers. Entries stored before t1264 carry no epoch: read as 0 (the epoch of a never-untrusted merchant),
   *  so any later untrust still kills them. Unreadable chain -> not trusted. The KV entry is not deleted here; cfg.onStaleInlineTrust is told. */
  async function inlineTrustLive(it,payee){if(!it?.merchant)return false;let t;try{t=await rd('trustOf',[p.account,it.merchant]);}catch{return false;}
    const ep=it.epoch!=null?BigInt(it.epoch):0n;if(BigInt(t?.[0]??0n)===ep)return true;
    try{cfg.onStaleInlineTrust?.({payee:getAddress(lc(payee)),merchant:it.merchant,epoch:ep.toString(),chainEpoch:String(t?.[0]??'')});}catch{}return false;}
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
      // t1214 (§6#100/#102): V5.4 owner signer grant (flag KIPURSE_V54_SIGNER_TRUST, suite v5.4 only; cfg.signerGrant is absent otherwise).
      // Only replaces the two "card" outcomes below; denied signer / registry block above still win. The chain re-checks everything.
      const viaGrant=async(why)=>{if(typeof cfg.signerGrant!=='function')return null;let g=null;try{g=await cfg.signerGrant({account:p.account,signer:s,order:n.signedOrder,nowS});}catch{g=null;}
        if(!g||!g.bytes)return null;n.signedOrder.grant=g.bytes;return {tier:'trusted',merchant:g.merchant,single:min(BigInt(g.single),B('single')),merchantDaily:BigInt(g.daily),viaGrant:true,grantReplaces:why};};
      if(t){const pb=await rd('trustedPayee',[p.account,n.payee]);if(pb[0]!==sb[0]||pb[1]!==sb[1])return (await viaGrant('payee_not_bound_to_signer_merchant'))??{tier:'trusted',merchant:t.merchant,reason:'payee_not_bound_to_signer_merchant'};
        return {tier:'trusted',merchant:t.merchant,single:min(t.single,B('single')),merchantDaily:t.daily};}
      if(useReg&&B('verifiedSingle')!==0n){const [m,sg,d]=await reg('lookupSigner',[s],[ZERO32,0n,0n]);
        if(m!==ZERO32){if(!(await reg('isPayeeOf',[m,n.payee],false)))return {tier:'verified',merchant:m,reason:'payee_not_bound_to_signer_merchant'};
          return {tier:'verified',merchant:m,single:min(sg,B('verifiedSingle')),merchantDaily:min(d,B('verifiedDaily'))};}}
      {const g=await viaGrant('signer_not_trusted');if(g)return g;}
      return {tier:'unknown_signer',reason:'signer_not_trusted'};
    }
    if(useReg&&(await reg('blocked',[n.payee],false)))return {tier:'denied',reason:'registry_blocked'};
    // t1250 (V5.5 + flag only; cfg.inlineTrustFor is absent otherwise): the owner's seat-V2 kind-6 inline trust ("remember", KPTR) for this payee.
    // The adapter re-verifies it through the wallet's ERC-1271 on every payment (untrust / key change kill it); the owner's own trust wins over the registry (K8).
    if(typeof cfg.inlineTrustFor==='function'){let it=null;try{it=await cfg.inlineTrustFor(n.payee,nowS);}catch{it=null;}
      if(it?.blob&&BigInt(it.expiry)>BigInt(nowS)+60n&&await inlineTrustLive(it,n.payee))return {tier:'trusted',merchant:it.merchant,single:min(BigInt(it.single),B('single')),merchantDaily:BigInt(it.daily),inline:it.blob};}
    const t=await liveTrust(await rd('trustedPayee',[p.account,n.payee]),nowS);
    if(t)return {tier:'trusted',merchant:t.merchant,single:min(t.single,B('single')),merchantDaily:t.daily};
    if(useReg&&B('verifiedSingle')!==0n){const [m,sg,d]=await reg('lookupPayee',[n.payee],[ZERO32,0n,0n]);
      if(m!==ZERO32)return {tier:'verified',merchant:m,single:min(sg,B('verifiedSingle')),merchantDaily:min(d,B('verifiedDaily'))};}
    return {tier:'stranger',merchant:null,single:B('openSingle')};
  }

  async function verifySigned(n,{server=false}={}){
    if(n.mode!=='signed')return n;const o=n.signedOrder;let s='';
    if(V51!==(o.v===2))return {ok:false,code:'order_domain_mismatch',detail:V51?'this V5.1 wallet needs a kipurse.signed-order.v2 order (stable verifier domain)':'a V5 wallet pays kipurse.signed-order.v1 orders only'};
    if(V51){const ver=await verifierAddr();if(lc(o.verifier)!==lc(ver)||Number(o.chainId)!==cfg.chainId)return {ok:false,code:'order_domain_mismatch',detail:'order signed for another verifier / chain'};
      try{s=await recoverTypedDataAddress({domain:orderDomain51({chainId:cfg.chainId,verifier:ver}),types:ORDER_TYPES51,primaryType:'PaymentOrder',
        message:{payee:o.payee,amount:o.amount,orderId:o.orderId,deadline:o.deadline,payer:o.payer??ZERO},signature:o.signature});}catch{}}
    else try{s=await recoverTypedDataAddress({domain:{...domain,verifyingContract:o.adapter},types:ORDER_TYPES,primaryType:'PaymentOrder',
      message:{payee:o.payee,amount:o.amount,orderId:o.orderId,deadline:o.deadline,chainId:o.chainId,adapter:o.adapter,payer:o.payer??ZERO},signature:o.signature});}catch{}
    if(o.payer&&lc(o.payer)!==lc(ZERO)&&lc(o.payer)!==lc(p.account))return {ok:false,code:'order_for_other_payer',detail:'the merchant signed this order for another wallet'};
    /* t1240 §6#110 F5 (security review): on V5.4 a signed order must be bound to THIS wallet - an unbound one (payer 0) could be someone else's
       order from a merchant the owner trusts, planted for this wallet's AI to pay */
    /* t1278 S2: on EVERY suite, an AI-supplied order must be bound to this wallet; only server-fetched orders (explicit internal flag) skip this */
    if(!server&&lc(o.payer??ZERO)===lc(ZERO))return {ok:false,code:'order_payer_unbound',detail:'this wallet pays only signed orders bound to it (payer = this wallet)'};
    if(lc(s)!==lc(o.claimedSigner))return {ok:false,code:'signature_invalid',detail:'recovered signer does not match the order signer'};
    return {...n,signedOrder:{...o,signer:getAddress(s)}};
  }
  const resolveN=async input=>{if(input&&Object.prototype.hasOwnProperty.call(input,NORMALIZED))return input[NORMALIZED];if(input&&typeof input==='object'&&'__normalized' in input)return {ok:false,code:'bad_request',detail:'unknown field __normalized'};if(input?.parsedId){const e=parsedCache.get(input.parsedId);if(!e)return {ok:false,code:'unknown_parsed_id',detail:'parse again (ids live 15 min, per process)'};return e.n;}
    const srv=input?.[SERVER_ORDER]===true||input?.request?.[SERVER_ORDER]===true;
    const n=detect(input?.request??input,{chains:[cfg.chainId]});if(!n.ok)return n;return verifySigned(n,{server:srv});};
  /** Canonical identity: same merchant requirement => same key for every agent (and the same on-chain purchaseKey). */
  /** Signed orders: keyed on (merchant, orderId) only, like adapter.signedPurchaseKey; the amount is never part of a key. */
  function identity(n,opts={},r){
    if(n.mode==='signed'){const m=r?.merchant;return m?{kind:'signed',purchaseKey:signedPurchaseKeyV5(m,n.signedOrder.orderId),ledgerKey:strip(signedPurchaseKeyV5(m,n.signedOrder.orderId)),refString:'signed:'+lc(m)+':'+lc(n.signedOrder.orderId)}
      :{kind:'signed',ledgerKey:strip(signedLedgerKey(n.signedOrder.signer,n.signedOrder.orderId)),refString:'signed:'+lc(n.signedOrder.signer)+':'+lc(n.signedOrder.orderId)};}
    const id=identityV5(n,opts);return {kind:'ref',...id,ledgerKey:strip(id.purchaseKey)};
  }
  const directory=n=>{const r=cfg.merchantRegistry??[];for(const m of r){if(n.signedOrder?.signer&&(m.signers??[]).map(lc).includes(lc(n.signedOrder.signer)))return m;if(n.payee&&(m.payTo??[]).map(lc).includes(lc(n.payee)))return m;}return null;};

  async function parse(request,{repeatKey,intentId,fallbackOrderId}={}){
    let n=detect(request,{chains:[cfg.chainId]});if(!n.ok)return n;n=await verifySigned(n,{server:request?.[SERVER_ORDER]===true});if(n.ok===false)return n;
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
    // t1250 (V5.5 only, cfg.priorPurchaseUsed is set only when KIPURSE_V55=1): a purchase the owner's previous wallet already paid on V5.4
    /* t1264: an unreadable prior wallet is NOT "already paid" (that marked purchases paid on an RPC error): readFailed -> preflight says retry later */
    if(typeof cfg.priorPurchaseUsed==='function'&&!used&&!orderUsed){let pr;try{pr=await cfg.priorPurchaseUsed({kind:id?.kind,purchaseKey:id?.purchaseKey,signedOrder:n?.signedOrder});}catch{return {ph,cnow,day,bal,term,today,openToday,verToday,merchToday,paused,used,orderUsed,readFailed:true};}
      if(pr?.used===true)return {ph,cnow,day,bal,term,today,openToday,verToday,merchToday,paused,used:id?.kind==='ref'?true:used,orderUsed:id?.kind==='ref'?orderUsed:true};}
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
      if(o.grant&&typeof cfg.signerGrant==='function')return {functionName:'paySignedTrusted',args:[p,{payee:o.payee,amount:o.amount,orderId:o.orderId,deadline:o.deadline,chainId:o.chainId,adapter:o.adapter,payer:o.payer??ZERO},o.signature,o.grant,nf,cnow+240]};   // t1214: V5.4 only
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
    const amount=n.amount,fe=feeFor(amount,f);const approved=!!ownerApproval&&n.mode!=='signed'&&!String(ownerApproval?.signature??'').toLowerCase().startsWith('0x4b505452');   /* t1250: a V5.5 KPTR inline trust is the Trusted route, not a one-time approval */
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
    if(s.readFailed)R.push('chain_read_failed_retry_later');/* t1264 */
    if(s.used||s.orderUsed)R.push('already_paid_on_chain');else if(row&&['paid','prepared','submitted'].includes(row.state))R.push('already_'+row.state);
    if(row&&BigInt(row.amount)!==amount&&['claimed','submitted','prepared','paid'].includes(row.state))R.push('price_changed');
    if(!R.length&&n.mode!=='x402_redirect'){const call=buildCall(n,id,s.cnow,ownerApproval,networkFee);
      try{await c.pub.simulateContract({address:cfg.adapter,abi:v5Abi,functionName:call.functionName,args:call.args,account:execAddr});simulation='ok';}
      catch(e){simulation='revert: '+scrubUrls(e?.shortMessage??e?.message).split('\n').find(l=>/reverted|reason/i.test(l))?.trim()?.slice(0,160);R.push('simulation_reverted');}}
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

  async function payNormalized(n,{agentId,intentId,repeatKey,ownerApproval,maxTotal,allowSameAmount,verifiedDomain,withdrawalId,allowance,ownerAsk,ctx=null}){
    {const sx=await sanctioned(n.payee,n.signedOrder?.signer);if(sx)return sx;}
    // t621 #6: every AI payment (direct, signed order, x402 after the 402 quote) is checked against the everyday limits right before signing
    if(agentId!=='owner'&&!withdrawalId&&!(ownerAsk===true&&ownerApproval)){/* t1170u: the owner's Face ID approval of this exact ask (server path only) is not an AI auto payment */await warmFee();let amt;try{amt=typeof n.amount==='bigint'?n.amount:(n.amount!==undefined&&n.amount!==null?BigInt(n.amount):undefined);}catch{amt=undefined;}
      const ed=everydayGate(amt,{scope:{chainId:n.chainId,token:n.token}});if(ed)return capHit(ed);}
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
    if(!ownerApproval&&r.inline)ownerApproval={signature:r.inline};   // t1250 V5.5: the stored kind-6 KPTR selects the inline-trust route on chain
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
    /* t1278 S11: a preflight that throws (RPC / chain read failure) fails CLOSED: retry later, nothing sent; a reverting simulation blocks too */
    if(cfg.preflightGuard!==false&&!started){let pf=null;try{pf=await preflight(normReq(n),{agentId,repeatKey,intentId,ownerApproval});}catch{return {state:'retry_later',reason:'preflight_failed',nothingPaid:true,retryAfterSec:Number(cfg.chainReadRetrySec??30),detail:'the pre-payment check could not run; nothing was sent. Retry later with the same idempotencyKey.'};}
      const block=(pf?.reasons??[]).filter(x=>/^over_(stranger|verified|merchant|trusted|permission|single|daily|term)|^stranger_disabled$|^insufficient_balance$|^wallet_paused$|^authorization_not_started$|^fee_above_owner_accepted$|^order_domain_mismatch$|^signer_revoked$|^simulation_reverted$/.test(x));
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
    let termLimit=null;
    const ownerAskOk=ownerAsk===true&&!!ownerApproval;/* t1264: the owner's Face ID approval of one ask is not an AI auto payment: no AI total */
    if(agentId!=='owner'&&!withdrawalId&&!ownerAskOk){try{const ev=cfg.everydayGet?.()??null;if(ev?.authorized===true&&ev.term!=null)termLimit=BigInt(ev.term);}catch{return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true};}}
    /* t1278 S4: the AI checks (everyday 24h, per-AI caps, the allowance it uses, the unattended total) ran before this point and read only
       finished records; they are run AGAIN inside the claim's BEGIN IMMEDIATE, counting every other claimed / in-flight / paid AI payment and
       pending holds, and this payment's provisional order row + one-off allowance use are written in that same transaction. */
    const guarded=agentId!=='owner'&&!withdrawalId&&!ownerAskOk;
    /* t1281: the authoritative re-check counts this payment as amount + fee + the network fee quoted above */
    const hooks=guarded?{check:()=>dupInTx(n,key)??recheckInTx({amount:n.amount,agentId,scope:{chainId:n.chainId,token:n.token},ctx,networkFee}),after:()=>claimOrderInTx(key,{agentId,n,ctx})}:{};
    let claim;try{claim=termLimit!=null?ledger.claimWithin(key,n,intentId,agentId,termLimit,{...hooks,cost:costIn(n.amount,networkFee)}):ledger.claim(key,n,intentId,agentId,hooks);}
    catch(e){if(e?.message!=='one_off_already_used')throw e;/* t1279 R9: the one-time allowance was used by a concurrent payment; the claim rolled back */
      return {state:'rejected',reason:'MANDATE_ALREADY_USED',nothingPaid:true,detail:'another payment used this one-time allowance first; nothing was sent',fix:'Nothing was paid. Ask the owner again (kipurse_buy / kipurse_request_trust).',say_to_user:'没有付款：这次的一次性批准已经被另一笔付款用掉了。/ Not paid: this one-time approval was already used by another payment.'};}
    if(claim.refused)return capHit({...claim.refused,nothingPaid:true,purchaseKey:undefined});
    if(!claim.won){const rw=claim.row;return {state:rw.state==='paid'||rw.state==='prepared'?'already_'+rw.state:'in_progress',purchaseKey:key,paidBy:rw.claimed_by,txHash:rw.tx_hash,result:rw.result?JSON.parse(rw.result):null};}
    ledger.setOrigin(key,withdrawalId!==undefined&&withdrawalId!==null?'withdrawal':agentId==='owner'?'owner':ownerAskOk?'owner_ask':'ai');/* t1264: only AI rows count against the AI total */
    if(termLimit!=null&&claim.admitted===false)return capHit({state:'rejected',reason:'EVERYDAY_TERM_LIMIT',nothingPaid:true,capHit:true,limit:termLimit.toString(),fix:'Another payment already reserved the explicit AI total. Nothing was paid.',say_to_user:'没有付款：加上还没付完的，会超过你设的 AI 总额。/ Not paid: with payments already reserved, this would go over the total you set.'});
    // one in-flight payment tx per account: a second purchase is told to retry (its claim is released, nothing sent)
    const release=txLock.try(p.account);
    if(!release){ledger.update(key,agentId,{state:'failed'});return {state:'retry_later',reason:'tx_in_flight',purchaseKey:key,retryAfterSec:5,detail:'one payment tx per wallet at a time; nothing was sent'};}
    try{
      if(termLimit!=null){const adm=ledger.admitAmount(key,costIn(n.amount,networkFee),termLimit);if(!adm.ok)return capHit({state:'rejected',reason:'EVERYDAY_TERM_LIMIT',nothingPaid:true,capHit:true,limit:termLimit.toString(),fix:'Another payment already reserved the explicit AI total. Nothing was paid.',say_to_user:'没有付款：加上还没付完的，会超过你设的 AI 总额。/ Not paid: with payments already reserved, this would go over the total you set.'});}
      return await payLocked(n,{agentId,key,id,r,cnow,ownerApproval,networkFee,nfx,jt,withdrawalId});}finally{release();}
  }
  /* t1264: purchases this process is sending right now (the restart / status reconcile never touches them) */
  const inflight=new Set();
  const usedNow=async(kind,purchaseKey,signedOrder)=>kind==='ref'?await rd('purchaseUsed',[p.account,purchaseKey]):await orderUsedOnChain(signedOrder);
  async function payLocked(n,o){inflight.add(o.key);try{return await payLocked0(n,o);}finally{inflight.delete(o.key);}}
  async function payLocked0(n,{agentId,key,id,r,cnow,ownerApproval,networkFee,nfx,jt,withdrawalId}){
    ledger.setMeta(key,agentId,{merchantId:directory(n)?.id??r.merchant??undefined,tier:r.tier});
    /* t1264: "is it already used on chain?" must be ANSWERED: a read error is not "paid" (it used to mark the purchase paid) and must not leave
       the claim stuck. Unreadable -> released (failed, no tx: the same request can claim it again), nothing sent, retry later. Only a real
       used:true marks it paid. */
    let usedOnChain;
    try{usedOnChain=!!(await usedNow(id.kind,id.purchaseKey,n.signedOrder));
      if(!usedOnChain&&typeof cfg.priorPurchaseUsed==='function'){const pr=await cfg.priorPurchaseUsed({kind:id.kind,purchaseKey:id.purchaseKey,signedOrder:n.signedOrder});usedOnChain=pr?.used===true;}}   // t1250 V5.5: paid on V5.4 by the previous wallet
    catch(e){ledger.update(key,agentId,{state:'failed',result:{error:'chain_read_failed',detail:errText(e)}});
      return {state:'retry_later',reason:'chain_read_failed',nothingPaid:true,purchaseKey:key,retryAfterSec:Number(cfg.chainReadRetrySec??30),
        detail:'could not read whether this purchase is already paid on chain; nothing was sent. Retry later with the same idempotencyKey.'};}
    if(usedOnChain){ledger.update(key,agentId,{state:'paid',result:{note:'purchase already used on chain'}});return {state:'already_paid_on_chain',purchaseKey:key};}
    let oaKey=null;/* t1181u */
    /* t1264 (contract C-1, server side): ONE owner approval = ONE use, for payDirect as well as prepareAuthorization. An approval that already
       opened a reservation (even one later cancelled / reclaimed) or paid is never sent again, on either route. Same key formula for both. */
    const useApproval=deadline=>{if(!isOwnerApproval(ownerApproval?.signature))return null;
      const k=approvalKey({chainId:cfg.chainId,adapter:cfg.adapter,account:p.account,purchaseKey:id.purchaseKey,payee:n.payee,amount:n.amount,deadline});const used=AU.check(k);
      if(used){ledger.update(key,agentId,{state:'failed'});return {refusal:{...used,purchaseKey:key}};}return {key:k};};
    /* t1264: what a later reconcile needs to settle this purchase if the answer of the send is lost (restart, timeout) */
    const pend=extra=>({pending:{kind:id.kind,onchainPurchaseKey:id.purchaseKey,signer:n.signedOrder?.signer??null,orderId:n.signedOrder?.orderId??null,mode:n.mode,at:Date.now(),
      nf:{total:String(nfx?.total??networkFee??0n),recovery:String(nfx?.recovery??0n)},networkFee:String(networkFee??0n),...(extra??{})}});
    try{
      if(n.mode==='direct'||n.mode==='signed'){
        const call=buildCall(n,id,cnow,ownerApproval,networkFee);
        if(n.mode==='direct'){const u=useApproval(BigInt(ownerApproval?.deadline??0));if(u?.refusal)return u.refusal;oaKey=u?.key??null;}
        const tx=await write(call.functionName,call.args,{label:call.functionName+':'+key,beforeSend:h=>{if(oaKey)AU.consume(oaKey,{purchaseKey:id.purchaseKey,txHash:h});ledger.update(key,agentId,{state:'submitted',tx_hash:h,result:pend()});}});
        const fe=feeFor(n.amount,await fee());settleGas(nfx,tx.hash);
        ledger.update(key,agentId,{state:'paid',result:{txHash:tx.hash,block:tx.blockNumber?.toString(),fee:fe.toString(),networkFee:networkFee.toString(),gasRecovery:nfx.recovery.toString(),gasUsed:tx.gasUsed?.toString()}});
        try{if(jt)cfg.jointTrust.recordPaid({decision:jt,amount:n.amount,purchaseKey:key,networkFee});if(withdrawalId!==undefined&&withdrawalId!==null)cfg.ownerGuard?.markWithdrawal(withdrawalId,{state:'paid',txHash:tx.hash});}catch{}
        return {state:'paid',purchaseKey:key,txHash:tx.hash,onchainPurchaseKey:id.purchaseKey,amount:n.amount.toString(),fee:fe.toString(),networkFee:networkFee.toString(),gasRecovery:nfx.recovery.toString(),total:(n.amount+fe+networkFee).toString(),receipt:buildReceipt({amount:n.amount,ppm:(await fee()).ppm,networkFee,payee:n.payee,txHash:tx.hash,status:'paid'})};
      }
      if(n.eip712?.name!==undefined||n.eip712?.version!==undefined){
        const want=await rd('DOMAIN_SEPARATOR',[],cfg.token);
        const got=hashDomain({domain:{name:n.eip712.name,version:n.eip712.version,chainId:cfg.chainId,verifyingContract:cfg.token},types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}]}});
        if(want!==got){ledger.update(key,agentId,{state:'failed'});return {state:'rejected',reason:'eip712_domain_mismatch',purchaseKey:key,detail:`merchant says ${n.eip712.name}/${n.eip712.version}`};}
      }
      const call=buildCall(n,id,cnow,ownerApproval,networkFee);const a=call.auth;
      // t1181u (§6#84): an owner approval prepares at most ONE reservation, also after the owner cancelled it (live V5.2 would allow a re-prepare)
      {const u=useApproval(a.validBefore);if(u?.refusal)return u.refusal;oaKey=u?.key??null;}
      // t1264: the reservation's digest / auth are known before sending (pure reads), so a late-confirmed prepare can still be closed / reclaimed
      const vault=await rd('vaultAddress',[p.account]);const nonce=id.purchaseKey;
      const digest=await rd('authorizationDigest',[vault,a.to,a.value,a.validAfter,a.validBefore,nonce]);
      // The vault's ERC-1271 approves exactly this digest; the signature bytes are opaque (32-byte digest, never 65 bytes / ERC-6492).
      const auth={from:vault,to:n.payee,value:n.amount.toString(),validAfter:a.validAfter.toString(),validBefore:a.validBefore.toString(),nonce};
      const tx=await write(call.functionName,call.args,{label:'prepareAuthorization:'+key,confirmations:cfg.prepareConfirmations??3,beforeSend:h=>{if(oaKey)AU.consume(oaKey,{purchaseKey:id.purchaseKey,txHash:h});ledger.update(key,agentId,{state:'submitted',tx_hash:h,result:pend({x402:{vault,digest,auth}})});}});
      settleGas(nfx,tx.hash);
      const header=x402Header(n,digest,auth);
      ledger.update(key,agentId,{state:'prepared',result:{prepareTx:tx.hash,vault,digest,auth,fee:feeFor(n.amount,await fee()).toString(),networkFee:networkFee.toString()}});
      return {state:'prepared',purchaseKey:key,txHash:tx.hash,vault,digest,auth,paymentHeader:header,fee:feeFor(n.amount,await fee()).toString(),networkFee:networkFee.toString(),gasRecovery:nfx.recovery.toString()};
    }catch(e){
      if(oaKey&&(e?.onChain===true||!ledger.get(key)?.tx_hash))AU.release(oaKey);/* t1181u: reverted on chain / never sent -> no reservation was opened; an unknown outcome keeps it used (fail safe) */
      const booked=bookFailure(e,agentId);
      const rw=ledger.get(key);
      if(rw.tx_hash){for(let i=0;i<10;i++){const u=await usedNow(id.kind,id.purchaseKey,n.signedOrder).catch(()=>false);
        if(u){if(n.mode==='direct'||n.mode==='signed'){try{settleGas(nfx,rw.tx_hash);}catch{}ledger.update(key,agentId,{state:'paid',result:{note:'purchase already used on chain',revertedTx:rw.tx_hash}});return {state:'already_paid_on_chain',purchaseKey:key,revertedTx:rw.tx_hash};}
          break;}/* x402: a used key = an open reservation, not a payment: the reconcile below records it as prepared */
          await new Promise(z=>setTimeout(z,cfg.retryDelayMs??1500));}}
      /* t1264: sent (tx / userOp hash known) and NOT a definitive on-chain revert: the outcome is UNKNOWN (bundler timeout, RPC drop, ...).
         Never "failed" (that invited a second payment): the row stays 'submitted', reconcileSubmitted settles it from the chain later. */
      if(rw.tx_hash&&e?.onChain!==true){try{if(n.mode!=='direct'&&n.mode!=='signed')await reconcileRow(ledger.get(key),{force:true});}catch{}
        const now2=ledger.get(key);
        if(now2?.state==='prepared'){let res=null;try{res=JSON.parse(now2.result);}catch{}return {state:'prepared_unconfirmed',purchaseKey:key,txHash:rw.tx_hash,nothingPaid:false,vault:res?.vault,digest:res?.digest,auth:res?.auth,
          detail:'the reservation was opened on chain but its confirmation came late; it is closed or reclaimed by the settle routine. Do not pay again.'};}
        return {state:'unknown',nothingPaid:false,purchaseKey:key,txHash:rw.tx_hash,retryAfterSec:Number(cfg.unknownRetrySec??60),
          detail:'sent; confirmation not seen yet — do not pay again; check status (same idempotencyKey or kipurse_get_purchase)'};}
      ledger.update(key,agentId,{state:'failed',result:{error:errText(e,300),revertedTx:rw.tx_hash??null}});
      if(e?.code==='daily_ops_used_up'&&!rw.tx_hash)return {...opsCalm(e),purchaseKey:key};/* t1185u §6#85: nothing was sent; the same request can be retried after the reset */
      // a definitive on-chain revert left the purchase unused: let a later retry claim it again (its gas is booked above)
      if(booked)ledger.db.prepare(`UPDATE purchases SET tx_hash=NULL WHERE purchase_key=?`).run(key);
      return {state:'failed',purchaseKey:key,error:errText(e,300),txHash:rw.tx_hash,
        ...(booked?{failedGasBooked:booked.debt.toString(),failuresToday:booked.failuresToday,note:'gas of the reverted tx is recovered on the next successful payment (within the owner cap)'}:{})};
    }
  }
  /* ---------------- t1264: reconcile purchases whose send outcome was lost ---------------- */
  const RECON={failAfterMs:Number(cfg.reconcile?.failAfterMs??30*60e3),dayWindow:cfg.reconcile?.dayWindow!==false};
  /** receipt of a sent tx / userOp: {status:'success'|'reverted'} | null (unknown). cfg.receiptFor overrides. */
  async function receiptOf(hash){try{if(typeof cfg.receiptFor==='function')return (await cfg.receiptFor(hash))??null;
      if(gasMode==='userop'){if(!uow?.receipt)return null;return (await uow.receipt(hash))??null;}
      if(typeof c.pub?.getTransactionReceipt!=='function')return null;const r=await c.pub.getTransactionReceipt({hash});return r?{status:r.status==='success'?'success':'reverted'}:null;}catch{return null;}}
  /** settle ONE 'submitted' row from the chain: used -> paid (x402: prepared); reverted receipt or past every deadline and unused -> failed
   *  (tx cleared, so the same purchase may be claimed again; the on-chain purchase key still stops any double payment); else unchanged. */
  async function reconcileRow(row,{force=false}={}){if(!row||row.state!=='submitted'||!row.tx_hash)return row?.state??null;if(!force&&inflight.has(row.purchase_key))return 'in_flight';
    let res=null;try{res=row.result?JSON.parse(row.result):null;}catch{}const pd=res?.pending??{};
    const kind=pd.kind??(String(row.ref??'').startsWith('signed:')?'signed':'ref');const opk=pd.onchainPurchaseKey??('0x'+row.purchase_key);
    let used;try{used=kind==='signed'?(pd.signer&&pd.orderId?!!(await orderUsedOnChain({signer:pd.signer,orderId:pd.orderId})):!!(await rd('purchaseUsed',[p.account,opk]))):!!(await rd('purchaseUsed',[p.account,opk]));}catch{return 'unreadable';}
    const x402=!!pd.x402||String(row.standard??'').startsWith('x402');const fresh=ledger.get(row.purchase_key);if(!fresh||fresh.state!=='submitted')return fresh?.state??null;
    if(used){const nf={total:BigInt(pd.nf?.total??0),recovery:BigInt(pd.nf?.recovery??0)};try{settleGas(nf,row.tx_hash);}catch{}
      if(x402&&pd.x402)ledger.update(row.purchase_key,row.claimed_by,{state:'prepared',result:{prepareTx:row.tx_hash,...pd.x402,networkFee:pd.networkFee??null,lateConfirm:true}});
      else ledger.update(row.purchase_key,row.claimed_by,{state:'paid',result:{txHash:row.tx_hash,note:'confirmed by reconcile (send outcome was lost)',networkFee:pd.networkFee??null}});
      ledger.event('reconcile',row.purchase_key,'reconciled',{to:x402&&pd.x402?'prepared':'paid'});return x402&&pd.x402?'prepared':'paid';}
    const rc=await receiptOf(row.tx_hash);const sentAt=Number(pd.at??row.updated_at??0);/* t1268 (§6#133): a vault userOp stays valid until the end of its UTC day (validateUserOp validUntil) -> never call it failed before that day is over (+10 min) */const old=Date.now()>Math.max(sentAt+RECON.failAfterMs,RECON.dayWindow?(Math.floor(sentAt/86400e3)+1)*86400e3+10*60e3:0);
    if(rc?.status==='reverted'||(!rc&&old)){ledger.update(row.purchase_key,row.claimed_by,{state:'failed',result:{error:rc?'reverted (reconcile)':'not confirmed before every deadline passed (reconcile)',revertedTx:row.tx_hash}});
      ledger.db.prepare(`UPDATE purchases SET tx_hash=NULL WHERE purchase_key=? AND state='failed'`).run(row.purchase_key);ledger.event('reconcile',row.purchase_key,'reconciled',{to:'failed'});return 'failed';}
    return 'submitted';}
  let reconRun=null;
  /** every 'submitted' row (engine start, status reads, owner-ask status). Never touches a row this process is sending. */
  function reconcileSubmitted({keys}={}){if(reconRun&&!keys)return reconRun;const run=(async()=>{const out=[];
      const rows=keys?keys.map(k=>ledger.get(k)).filter(Boolean):ledger.db.prepare(`SELECT * FROM purchases WHERE state='submitted' AND tx_hash IS NOT NULL`).all();
      for(const r of rows){try{out.push({purchaseKey:r.purchase_key,state:await reconcileRow(r)});}catch(e){out.push({purchaseKey:r.purchase_key,state:'error'});}}return out;})();
    if(!keys){reconRun=run;run.finally(()=>{reconRun=null;}).catch(()=>{});}return run;}
  /** the ledger answer for an unknown / interrupted purchase key (for idempotent replays and owner asks) */
  function settledView(key){const r=ledger.get(key);if(!r)return null;let res=null;try{res=r.result?JSON.parse(r.result):null;}catch{}
    if(r.state==='paid')return {state:'paid',purchaseKey:key,txHash:res?.txHash??r.tx_hash??null,nothingPaid:false,reconciled:true};
    if(r.state==='prepared')return {state:'prepared_unconfirmed',purchaseKey:key,txHash:res?.prepareTx??r.tx_hash??null,nothingPaid:false,reconciled:true};
    if(r.state==='failed')return {state:'failed',purchaseKey:key,nothingPaid:!r.tx_hash,reason:res?.error?String(res.error).slice(0,80):'payment_failed',reconciled:true};
    if(r.state==='submitted')return {state:'unknown',purchaseKey:key,txHash:r.tx_hash,nothingPaid:false,detail:'sent; confirmation not seen yet — do not pay again; check status'};
    return null;}
  /** t1185u (§6#85): the wallet's daily on-chain operations are used up. Calm, not an error: nothing paid, resets at 00:00 UTC, the owner can raise it. */
  function opsCalm(e){const at=e.resetsAt??null;let ct='';try{ct=new Date(at).toLocaleString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit',month:'short',day:'numeric',timeZoneName:'short'});}catch{}
    return {state:'rejected',reason:'DAILY_OPERATIONS_USED_UP',decision:'wait',nothingPaid:true,retryable:true,retryAfter:at,opsPerDayCount:e.cap??null,opsUsedTodayCount:e.used??null,
      fix:`Nothing was paid. This wallet's on-chain operations for today (${e.cap??'?'}) are used up. They reset automatically at 00:00 UTC${ct?` (${ct})`:''}; then retry the same order with a NEW Idempotency-Key (it is still paid only once), or the owner can raise the daily number in the Kipurse app (Wallet safety floor). Do not switch networks or wallets.`,
      say_to_user:`没有付款，钱也没少：今天这个钱包的链上操作次数（${e.cap??'?'} 次）用完了，这是保护手续费的安全设置。UTC 0 点会自动恢复${ct?`（${ct}）`:''}，到时我再付；你也可以在启付 App「钱包安全底线」里调高次数。/ Nothing was paid and no money moved: this wallet's on-chain operations for today (${e.cap??'?'}) are used up (a safety setting that protects your network fees). They reset automatically at 00:00 UTC${ct?` (${ct})`:''} and I can pay then; you can also raise the daily number in Kipurse (Wallet safety floor).`};}
  async function withIdem(idemKey,agentId,request,fn){
    if(!idemKey||!/^[A-Za-z0-9._:-]{8,128}$/.test(idemKey))return {state:'rejected',reason:'idempotency_key_required'};
    const b=ledger.idempotencyBegin(idemKey,agentId,request);
    if(b.status==='conflict')return {state:'rejected',reason:'idempotency_key_reused_with_different_request'};
    if(b.status==='replay'){const rp=b.response;
      /* t1264: a stored "unknown" (sent, not confirmed) is re-read from the ledger + chain, so the same key reports the settled result */
      if(rp&&rp.state==='unknown'&&rp.purchaseKey){try{await reconcileSubmitted({keys:[rp.purchaseKey]});}catch{}const v=settledView(rp.purchaseKey);
        if(v&&v.state!=='unknown'){const out={...rp,...v};delete out.detail;delete out.retryAfterSec;if(v.state!=='unknown')ledger.idempotencyEnd(idemKey,rp.purchaseKey,out);return out;}}
      return rp??{state:'in_progress',reason:'same request still running'};}
    /* t1264: fn throwing must not leave this key "in progress" forever: the row (no answer yet) is removed and the error passes on. The purchase
       itself stays protected by the ledger claim + the on-chain purchase key; a retry with the same key re-runs and is answered by them. */
    let out;try{out=await fn();}catch(e){try{ledger.db.prepare(`DELETE FROM idempotency WHERE idem_key=? AND response IS NULL`).run(idemKey);}catch{}throw e;}
    /* t1264: a TRANSIENT answer that sent nothing and tells the AI to retry with the SAME key (retry_later: tx_in_flight, gas_spike,
       chain_read_failed, bundler quota ...; opsCalm-style decision 'wait' + retryable) is not stored as the key's final answer: the same key
       really retries (the ledger claim + on-chain purchase key still guard it). Terminal answers (paid, policy refusals, unknown with a tx) stay stored. */
    const transient=out&&typeof out==='object'&&!out.txHash&&out.nothingPaid!==false&&(out.state==='retry_later'||(out.decision==='wait'&&out.retryable===true&&out.nothingPaid===true));
    if(transient){try{ledger.db.prepare(`DELETE FROM idempotency WHERE idem_key=? AND response IS NULL`).run(idemKey);}catch{}return out;}
    ledger.idempotencyEnd(idemKey,out?.purchaseKey,out);return out;
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
  /* t1281 (§6#141): amount + protocol fee + network fee per payment (spend-cost.mjs), like the on-chain daily / term caps */
  const sumTier=(tiers,ms=86400000)=>{try{const q=`SELECT o.amount,p.result,p.state FROM purchase_order o JOIN purchases p ON p.purchase_key=o.purchase_key WHERE o.tier IN (${tiers.map(()=>'?').join(',')}) AND o.created_at>=? AND p.state IN ('claimed','submitted','prepared','paid')`;
    const cp=costParams();return ledger.db.prepare(q).all(...tiers,Date.now()-ms).reduce((a,x)=>a+costOf(x,cp),0n);}catch(e){return missingOk(e);}};
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
      say_to_user:v.verified?'已核实 / Verified':(pt==='stranger'?'未核实：新收款方，第一次要你在手机上用 Face ID 批准一次，之后记住 / Not verified: new payee, approve once on your phone with Face ID, then it is remembered':'未核实 / Not verified')};}catch(e){return {ok:false,code:'verify_failed',detail:errText(e,200)};}};
  /** effective tier: null when the payee is refused (lookalike / dust / blacklist / blocked). */
  function payeeTier(v,source){if(v.required_action!=='none')return null;if(v.verified)return v.match?.kind==='paid_before'?(v.match?.viaAi?'ai_upgraded':'verified'):'trust_list';return claimedTier(source);}
  /* t1278 S4: completes this payment's provisional (__claim) row written at claim time; a finished row of an earlier call is never overwritten */
  const recordOrder=(r,{agentId,payee,amount,tier,status,order,source})=>{try{if(!r?.purchaseKey)return;ledger.db.prepare(`INSERT INTO purchase_order VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(purchase_key) DO UPDATE SET agent_id=excluded.agent_id,payee=excluded.payee,amount=excluded.amount,tier=excluded.tier,address_status=excluded.address_status,order_json=excluded.order_json WHERE purchase_order.order_json LIKE '{"__claim":1%'`).run(String(r.purchaseKey),Date.now(),agentId??null,payee??null,amount!==undefined&&amount!==null?String(amount):null,tier??null,status??null,JSON.stringify({...(order??{}),...(source?{source}:{})}));}catch{}};
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
  const capHit=r=>{if(!r?.capHit&&!['over_unrecognized_cap','OVER_USER_BUDGET'].includes(r?.reason))return r;/* t1280: a suspected duplicate is NOT a cap hit (it must not pause the whole wallet); its owner card is one per payee + amount instead */const t=Date.now();AN.capHits=AN.capHits.filter(x=>t-x<3600e3);AN.capHits.push(t);
    if(AN.capHits.length>=TL.capHits1h){AN.capHits=[];const a=anomaly('repeated_cap_hits');return {...r,paused:a.anomaly,say_to_user:r.say_to_user+' '+a.say_to_user};}return r;};
  const outflow24h=()=>sumTier(['trust_list','verified','owner_direct','ai_verified','ai_upgraded','stranger','x402','mandate']);
  // RT-2: one ceiling for everything the AI pays WITHOUT the owner (allowances + AI-checked + trial), whatever purpose it claims
  const UNATTENDED=['mandate','ai_verified','ai_upgraded','stranger'];
  /* t1281: spent and this payment both count amount + fee (+ the quoted network fee at claim time) */
  function unattendedCheck(amount,extra,networkFee=0n){if(amount===undefined)return null;const d=sumTier(UNATTENDED),m=sumTier(UNATTENDED,30*86400e3);const lim=BigInt(TL.unattendedDaily),limM=BigInt(TL.unattendedMonthly);const cost=costIn(amount,networkFee);
    if(d+cost<=lim&&m+cost<=limM)return null;const day=d+cost>lim;
    return {state:'rejected',reason:day?'AI_UNATTENDED_DAILY_TOTAL':'AI_UNATTENDED_MONTHLY_TOTAL',nothingPaid:true,capHit:true,...extra,detail:day?`AI paid without asking today ${fmtU(d)} + ${fmtU(cost)} > ${fmtU(lim)} (all purposes together, fees included)`:`30 days ${fmtU(m)} + ${fmtU(cost)} > ${fmtU(limM)} (fees included)`,
      fix:'The total the AI may pay without asking (all allowances, AI-checked and trial payees together) is used up. Ask the owner: call kipurse_request_trust for this payee or ask for a one-time approval; do not split or relabel the payment.',
      say_to_user:day?`没有付款：今天 AI 不经你确认能花的总额（所有用途合计 ${fmtU(lim)} USDC）已用完。需要的话在手机上用 Face ID 批准这一笔。/ Not paid: today's total the AI may spend without asking (${fmtU(lim)} USDC, all purposes) is used up.`:`没有付款：近 30 天 AI 不经你确认能花的总额（${fmtU(limM)} USDC）已用完。/ Not paid: the 30-day total the AI may spend without asking is used up.`};}
  /* ---------------- t1278 S4: re-check at claim time (synchronous; runs inside the ledger's BEGIN IMMEDIATE) ---------------- */
  const holdsPending=agent=>{try{const cp=costParams();return ledger.db.prepare(`SELECT agent_id,amount FROM payment_hold WHERE state='pending'`).all().filter(h=>agent===undefined||h.agent_id===agent).reduce((a,h)=>a+costOf({amount:h.amount??0,state:'hold'},cp),0n);}catch(e){return missingOk(e);}};/* t1281: amount + fee */
  /* t1280 (§6#140, owner: duplicate-purchase guard in the FREE version): an AI direct payment to the same payee for the same amount inside
     10 minutes under a different order key is held for the owner (push card via the owner-ask flow); checked inside the claim's BEGIN IMMEDIATE
     so two simultaneous copies never both pass. Not for x402 pay-per-call (repeated equal amounts are normal) or merchant-signed orders. The
     AI's allowSameAmount never skips it; the owner's own payments and an owner-approved ask are not guarded. */
  const DUP_WINDOW_MS=()=>1000*Number(cfg.duplicateWindowSec??600);
  function dupInTx(n,key){if(n?.mode!=='direct'||!n.payee||typeof n.amount!=='bigint')return null;
    const d=ledger.db.prepare(`SELECT purchase_key,state FROM purchases WHERE lower(payee)=lower(?) AND amount=? AND purchase_key<>? AND created_at>=? AND state IN ('claimed','submitted','prepared','paid') LIMIT 1`).get(n.payee,n.amount.toString(),key,Date.now()-DUP_WINDOW_MS());
    if(!d)return null;
    return {state:'rejected',reason:'POSSIBLE_DUPLICATE_PURCHASE',nothingPaid:true,askOwnerEligible:true,payee:n.payee,amountAtomic:n.amount.toString(),existing:{purchaseKey:d.purchase_key,state:d.state},
      detail:'the same amount to the same payee was already started or paid in the last 10 minutes under another order; nothing was sent',
      fix:'Nothing was paid. If the user really wants a second one, the owner approves it on the phone (kipurse_buy / kipurse_pay with an idempotencyKey sends the card). Do not change the amount to get around this.',
      say_to_user:'没有付款：10 分钟内已经给同一个收款方付过同样金额，像是重复购买。如果确实要再买一次，请在手机上确认。/ Not paid: the same amount went to the same payee in the last 10 minutes, so this looks like a duplicate. Confirm on your phone if you really want a second one.'};}
  /* t1281 (§6#141): authoritative: this payment counts amount + fee + its quoted network fee (single caps: the amount only) */
  function recheckInTx({amount,agentId,scope,ctx,networkFee}){try{const amt=BigInt(amount);const nf=networkFee===undefined||networkFee===null?B('maxNetworkFee'):BigInt(networkFee);
      if(cfg.everydayCheck){const r=cfg.everydayCheck({amount:amt,cost:costIn(amt,nf),spent24h:everydaySpent()+holdsPending(),spentTerm:ledger._committed(null),...(scope?{chainId:scope.chainId,token:scope.token}:{})})??null;if(r)return r;}
      {const ac=MD.agentCheck(agentId,amt,scope,holdsPending(agentId),{networkFee:nf});if(ac)return ac;}
      if(ctx?.mandate){const mm=MD.match({purpose:ctx.purpose,payee:ctx.payee,host:ctx.host,amount:amt,agentId,chainId:scope?.chainId,token:scope?.token,networkFee:nf});
        if(!mm.ok||mm.mandate?.id!==ctx.mandate.id)return {state:'rejected',reason:'MANDATE_'+String(mm.why??'changed').toUpperCase(),nothingPaid:true,capHit:/^over_/.test(String(mm.why??'')),
          detail:'another payment used this allowance first; nothing was sent',fix:'Nothing was paid. The owner allowance no longer covers this payment (another payment used it). Ask the owner (kipurse_buy / kipurse_request_trust); do not split the payment.'};}
      if(ctx&&(['ai_verified','ai_upgraded','stranger'].includes(ctx.tier)||(ctx.tier==='mandate'&&ctx.mandate?.kind!=='one_off'))){const uc=unattendedCheck(amt,{},nf);if(uc)return uc;}
      return null;}
    catch{return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true,fix:'The limit re-check failed; nothing was paid. Retry later.'};}}
  /** the payment's provisional order row (marked __claim; recordOrder completes it) + the one-off allowance use, in the claim transaction */
  function claimOrderInTx(key,{agentId,n,ctx}){if(!ctx)return;
    ledger.db.prepare(`INSERT OR REPLACE INTO purchase_order VALUES(?,?,?,?,?,?,?,?)`).run(String(key),Date.now(),agentId??null,n.payee??null,String(n.amount),ctx.tier??null,ctx.status??null,
      JSON.stringify({__claim:1,...(ctx.order??{}),...(ctx.mandate?{mandateId:ctx.mandate.id}:{}),...(ctx.source?{source:ctx.source}:{})}));
    if(ctx.mandate?.kind==='one_off'){if(!MD.consume(ctx.mandate.id))throw Error('one_off_already_used');ctx.consumed=true;}}
  /** after the payment: paid -> close the one-off (already consumed at claim); a definite failure (nothing sent / reverted) -> give it back */
  const definiteNoPay=r=>!!r&&typeof r==='object'&&(r.state==='failed'||((r.state==='rejected'||r.state==='retry_later')&&!r.txHash&&r.nothingPaid!==false));
  function settleUse(ctx,r){const m=ctx?.mandate;if(!m)return;if(r?.state==='paid')MD.used(m.id,{consumed:!!ctx.consumed});else if(ctx.consumed&&definiteNoPay(r)){MD.release(m.id);ctx.consumed=false;}}
  // t621 #8: the x402 small-payment float counts against the everyday limits: money funded into it in the last 24h and not yet
  // spent by vouchers is "committed" (spent vouchers are already in outflow24h as normal payment records, so nothing is counted twice).
  /* t1281: a float takes funded + fee reserve + its funding network fee from the wallet; vouchers count amount + fee (no tx of ours) */
  const floatCommitted24h=()=>{try{const since=Date.now()-86400e3;const f=BigInt(ledger.db.prepare(`SELECT COALESCE(SUM(funded),0)+COALESCE(SUM(fee_reserve),0)+COALESCE(SUM(network_fee),0) AS a FROM float_sessions WHERE funded_at>=?`).get(since).a);
    const cp=costParams();let v=0n;for(const x of ledger.db.prepare(`SELECT amount FROM float_vouchers WHERE state!='void' AND at>=?`).all(since))v+=costOf({amount:x.amount??0,result:{networkFee:'0'},state:'voucher'},cp);return f>v?f-v:0n;}catch(e){return missingOk(e);}};
  const everydaySpent=()=>outflow24h()+floatCommitted24h();
  /** Cumulative recorded payment amount. null means the total cannot be checked, so the caller must refuse. */
  const spentCumulative=()=>{try{return ledger.committedSpend();}catch{return null;}};
  /** t609u Layer 2 + t621 #6 + t1076 total. Fail CLOSED. allowUnknown: pre-checks before the amount is known. */
  function everydayGate(amount,{allowUnknown=false,scope}={}){if(!cfg.everydayCheck)return null;
    if(amount===undefined||amount===null){if(allowUnknown)return null;return {state:'rejected',reason:'EVERYDAY_AMOUNT_UNKNOWN',nothingPaid:true,fix:'The payment amount is unknown, so the owner’s everyday limits cannot be checked. Nothing was paid.',say_to_user:'没有付款：不知道这笔要付多少，没法核对你的日常额度。/ Not paid: the amount is unknown, so your everyday limits can’t be checked.'};}
    const spentTerm=spentCumulative();if(spentTerm==null)return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true,fix:'The cumulative total could not be read. Nothing was paid.',say_to_user:'没有付款：暂时核对不了总额。/ Not paid: the total could not be checked.'};
    try{return cfg.everydayCheck({amount:BigInt(amount),cost:costIn(BigInt(amount)),spent24h:everydaySpent(),spentTerm,...(scope?{chainId:scope.chainId,token:scope.token}:{})})??null;}/* t1281: amount + fee (network fee added at claim time) */catch{return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true,fix:'The everyday-limit check failed; nothing was paid. Retry later.',say_to_user:'没有付款：暂时核对不了日常额度，请稍后再试。/ Not paid: your everyday limits could not be checked right now.'};}}
  async function anomalyBefore({payee,amount,tier}){const t=Date.now();
    {const ed=everydayGate(amount,{allowUnknown:true});if(ed)return ed;}/* t609u Layer 2: everyday limits, before signing */for(const [k,ts] of AN.newPayees)if(t-ts>3600e3)AN.newPayees.delete(k);
    if(tier!=='trust_list'&&tier!=='verified'&&payee){const k=lc(payee);if(!AN.newPayees.has(k)){AN.newPayees.set(k,t);if(AN.newPayees.size>=TL.newPayees1h){AN.newPayees.clear();return anomaly('too_many_new_payees');}}}
    if(amount!==undefined){try{const bal=BigInt(await rd('balanceOf',[p.account],getAddress(cfg.token)));const out=outflow24h();if((out+costIn(amount))*100n>(bal+out)*BigInt(TL.balanceOutPct))return anomaly('large_outflow');}catch{}}
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
    setHold(id,'releasing');let r;try{const a=JSON.parse(h.args_json);a[CTX]={tier:h.tier,payee:h.payee,status:a.__status,order:a.order,source:a.addressSource};/* t1278 S4 */r=await payInner(a);recordOrder(r,{agentId:a.agentId,payee:h.payee,amount:h.amount,tier:h.tier,status:a.__status,order:a.order,source:a.addressSource});}catch(e){r={state:'failed',error:errText(e,200)};}
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
  /** t1181u: refuse (nothing paid) a payment whose network / token is not the scope of the wallet and of the saved everyday limits. */
  function scopeGate(scope){if(!scope||!ENGINE_SCOPE)return null;
    const sx=scopeCheck('wallet limit',ENGINE_SCOPE,scope,ENGINE_SCOPE);if(sx)return sx;
    let es=null;try{es=cfg.everydayScope?.()??null;}catch{return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true,fix:'The everyday-limit scope could not be read. Nothing was paid.'};}
    return es?scopeCheck('everyday AI limit',es,scope,ENGINE_SCOPE):null;}
  async function gate({payee,amount,agentId,source,mode,purpose,host,scope}){
    {const sg=scopeGate(scope);if(sg)return {reject:capHit(sg)};}
    const v=await verifyPayee({address:payee,source});if(!v.ok)return {reject:{state:'rejected',reason:'retry_later',detail:'payee check unavailable; nothing was sent',nothingPaid:true}};
    const fromHistory=source==='from_tx_history'&&!v.verified;
    if(v.required_action!=='none'||fromHistory){try{cfg.obs?.log?.('payee_refused',{status:v.status});}catch{}
      return {reject:{state:'rejected',reason:v.code??'UNVERIFIED_FROM_HISTORY',payee:v.address,payeeGroups:v.groups,verified:false,addressStatus:v.status,lookalikes:v.lookalikes,blacklist:v.blacklist,
        say_to_user:v.explain_zh+' / '+v.explain_en,nothingPaid:true,
        fix:v.required_action==='refuse'?'Do not pay this address.':'Do NOT retry with another address you found yourself. Tell the user it is NOT verified, then call kipurse_request_trust for this exact payee so the owner can approve it on the phone with Face ID; after approval, retry kipurse_pay.'}};}
    const tier=v.payee_tier;const extra={payee:v.address,payeeGroups:v.groups,verified:v.verified,addressStatus:v.status,payee_tier:tier,payee_tier_text:TIER_SAY[tier],...(amount!==undefined?{amountAtomic:String(amount)}:{})};
    {const ac=MD.agentCheck(agentId,amount,scope);if(ac){const ownerEst=tier==='trust_list'||tier==='verified'||tier==='owner_direct';/* t1170u: a new payee over a cap becomes an owner ask, not a refusal -> not counted for the repeated-cap-hit pause */
      return {reject:ownerEst||ac.reason==='AGENT_STOPPED'?capHit({...ac,...extra}):{...ac,...extra,askOwnerEligible:true}};}}
    // OWNER ALLOWANCE (purpose mandate / recurring / one-off): inside it the AI pays without asking, also a new merchant; checks above still applied
    // NO-AI-TRUST (owner 2026-10-26): the AI alone may only pay payees the OWNER established (trust list, owner-approved + remembered,
    // owner-paid before, owner-approved recurring / one-off / payee-scoped allowance). Anything else -> one Face ID.
    const known=tier==='trust_list'||tier==='verified';
    const mm=MD.match({purpose,payee:v.address,host,amount,agentId,chainId:scope?.chainId,token:scope?.token});
    if(!known&&tier!=='owner_direct'){const m=mm.ok?mm.mandate:null;const bound=m&&(m.kind==='one_off'||m.kind==='recurring'||m.payees.includes(lc(v.address)));if(!bound&&!(mm.mandate&&/^recurring_/.test(mm.why??'')))return {reject:newPayeeAsk(extra)};}
    if(mm.ok){const m=mm.mandate;const mx={...extra,payee_tier:'mandate',payee_tier_text:(m.purpose==='all'?'在你设的 AI 付款上限内 / Within your AI payment limit':m.kind==='recurring'?'在你批准的「'+purposeName(m.purpose,true)+'」自动续费内 / Inside your approved '+purposeName(m.purpose,false)+' renewal':'你用 Face ID 批准过的收款方，在你设的 AI 付款上限内 / A payee you approved with Face ID, within your AI payment limit'),mandate:{id:m.id,purpose:m.purpose,kind:m.kind}};
      if(m.kind!=='one_off'){const uc=unattendedCheck(amount,mx);if(uc)return {reject:capHit(uc)};}
      const realNew=m.kind!=='one_off'&&tier!=='trust_list'&&tier!=='verified'&&amount!==undefined&&amount>=BigInt(TL.mandateNewPayeeMin);
      const an=await anomalyBefore({payee:v.address,amount,tier:realNew?tier:'verified'});if(an)return {reject:an};
      // PRINCIPLE: the 500 hold applies to every non-trust-list payee, also inside the overall limit (only an exact owner Face ID one-off skips it)
      const big=amount!==undefined&&amount>=TL.holdAbove&&tier!=='trust_list'&&m.kind!=='one_off';
      if(big&&mode==='x402')return {reject:capHit({state:'rejected',reason:'X402_OVER_HOLD_LIMIT',nothingPaid:true,capHit:true,...extra,fix:'Web (x402) payments of 500 USDC or more need a payee on the owner trust list.'})};
      return {v,tier:'mandate',extra:mx,hold:big,mandate:m};}
    if(mm.why&&!['no_mandate','no_purpose','scope_mismatch'].includes(mm.why))return {reject:capHit({...mandateAsk(mm,{payee:v.address,host,amount,agentId,purpose}),...extra,capHit:/^over_/.test(mm.why),guardRefusal:true})};
    if(!known&&tier!=='owner_direct')return {reject:newPayeeAsk(extra)};
    // (removed 2026-10-26 UX fix: the old AI-verified tier cap was unreachable here - every non-owner-established payee returns newPayeeAsk above; handbook §3.2)
    if(UNATTENDED.includes(tier)){const uc=unattendedCheck(amount,extra);if(uc)return {reject:capHit(uc)};}
    const an=await anomalyBefore({payee:v.address,amount,tier});if(an)return {reject:an};
    if(mode==='x402'&&tier==='owner_direct')return {reject:{...ownerConfirm({payee:v.address,amount,name:nameOf(v.address),agentId}),guardRefusal:true}};
    const hold=mode!=='x402'&&amount!==undefined&&amount>=TL.holdAbove&&tier!=='trust_list';
    if(mode==='x402'&&amount!==undefined&&amount>=TL.holdAbove&&tier!=='trust_list')return {reject:capHit({state:'rejected',reason:'X402_OVER_HOLD_LIMIT',nothingPaid:true,capHit:true,...extra,fix:'Web (x402) payments of 500 USDC or more need a payee on the owner trust list (kipurse_request_trust -> owner Face ID).',say_to_user:'没有付款：网页付款达到 500 USDC 需要收款方在你的信任名单里。/ Not paid: web payments of 500 USDC or more need a trusted payee.'})};
    return {v,tier,extra,hold};}
  const payGuarded=async(o0)=>{let o=o0;await warmFee();/* t1281: the live fee rate for the limit sums */if(o&&Object.prototype.hasOwnProperty.call(o,'ownerAsk')&&o[OWNER_OK]!==true){const {ownerAsk:_x,...rest}=o;o=rest;}/* t1170u: ownerAsk only via the server path */
    if(o.withdrawalId||o.agentId==='owner')return payInner(o);/* owner Siri/phone pay = already Face ID approved by the owner */
    if(o[OWNER_OK]===true&&o.ownerApproval){/* t1170u: the owner tapped + Face ID on this exact request. AI policy gates (new payee, AI caps, everyday, holds) do not
      apply; sanctions (payNormalized), scam blacklist / lookalike / dust refusals still do; the wallet limits and the on-chain approval check stay the authority. */
      let n;try{n=await resolveN(o.request);}catch{n=null;}if(!n||n.ok===false||n.mode!=='direct'||!n.payee)return {state:'rejected',reason:'owner_ask_not_direct',nothingPaid:true};
      const v=await verifyPayee({address:n.payee});if(!v.ok)return {state:'rejected',reason:'retry_later',nothingPaid:true};if(v.required_action==='refuse')return {state:'rejected',reason:v.code??'refused',nothingPaid:true,say_to_user:(v.explain_zh??'')+' / '+(v.explain_en??'')};
      const order=normalizeOrder(o);const amount=typeof n.amount==='bigint'?n.amount:undefined;if(order?.merchant)try{setName(n.payee,order.merchant,'order');}catch{}
      const r=await payInner({...o,ownerAsk:true});recordOrder(r,{agentId:o.agentId,payee:n.payee,amount,tier:'owner_approved',status:v.status,order,source:o.addressSource});/* tier owner_approved: never auto-trusts (only 'trust' does, via the trust list) */
      return r&&typeof r==='object'&&!Array.isArray(r)?{...r,order_recorded:!!r.purchaseKey,ownerApproved:true}:r;}
    if(replayOf(o.idempotencyKey))return payInner(o);/* exactly-once replay of a finished payment: answer from the ledger */
    if(o.idempotencyKey){try{const h=ledger.db.prepare(`SELECT * FROM payment_hold WHERE idem_key=?`).get(o.idempotencyKey);if(h)return holdAnswer(h);}catch{}}
    if(isPaused())return {state:'rejected',reason:'wallet_paused_for_safety',nothingPaid:true,fix:'AI payments are paused; only the owner can resume them in the Kipurse app (Face ID).'};
    {const st=MD.agentCheck(o.agentId,undefined);if(st)return st;}
    let n;try{n=await resolveN(o.parsedId?{parsedId:o.parsedId}:o.request);}catch{n=null;}
    const order=normalizeOrder(o);const amount=typeof n?.amount==='bigint'?n.amount:undefined;
    const oc=checkOrder({order,amount,cfg:GUARD});if(oc){try{cfg.obs?.log?.('order_refused',{reason:oc.reason});}catch{}return capHit(oc);}
    const purpose=purposeKey(o.purpose??order?.purpose)??undefined;
    /* t1278 S3: a signed order is checked against this AI's own caps WITH its amount (and again at claim time) */
    if(n&&n.ok!==false&&n.mode==='signed'&&n.payee){const sc={chainId:n.chainId,token:n.token};const ac=MD.agentCheck(o.agentId,amount,sc);if(ac)return capHit(ac);
      const ctx={tier:'trust_list',payee:n.payee,order,source:o.addressSource};const r=await payInner({...o,[CTX]:ctx});recordOrder(r,{agentId:o.agentId,payee:n.payee,amount,tier:'trust_list',status:null,order,source:o.addressSource});
      return r&&typeof r==='object'&&!Array.isArray(r)?{...r,order_recorded:!!r.purchaseKey}:r;}
    /* t1278 S3: an x402 (eip3009) request handed to pay / payAny goes through the SAME gate as paidFetch (new-payee Face ID, per-AI caps, allowances,
       unattended total, anomaly, >= 500 USDC trust-list rule) and is recorded with its tier, so it counts toward the everyday 24h sums */
    if(n&&n.ok!==false&&n.mode==='eip3009'&&n.payee){const host=undefined;/* t1280 M1 (§6#140): this 402 object came from the AI's own JSON; its resource URL is not a site the server visited, so it never matches a host-scoped allowance (paidFetch uses the URL the server fetched) */
      const sc={chainId:n.chainId,token:n.token};const g=await gate({payee:n.payee,amount,agentId:o.agentId,source:o.addressSource,mode:'x402',purpose,host,scope:sc});if(g.reject){const {guardRefusal,...rj}=g.reject;return rj;}
      const tier=g.tier??'x402';const ord=g.mandate?{...(order??{}),purpose:MD.classifyCategory({purpose:o.purpose,item:order?.item,merchant:order?.merchant,host}),mandateId:g.mandate.id}:order;
      const ctx={tier,payee:n.payee,host,purpose,status:g.v?.status??null,order:ord,source:o.addressSource,mandate:g.mandate?{id:g.mandate.id,kind:g.mandate.kind}:null};
      const r=await payInner({...o,allowance:g.tier==='mandate',[CTX]:ctx});recordOrder(r,{agentId:o.agentId,payee:n.payee,amount,tier,status:ctx.status,order:ord,source:o.addressSource});settleUse(ctx,r);
      return r&&typeof r==='object'&&!Array.isArray(r)?{...r,...(g.extra??{}),order_recorded:!!r.purchaseKey}:r;}
    if(!n||n?.ok===false||n?.mode!=='direct'||!n.payee){const r=await payInner(o);recordOrder(r,{agentId:o.agentId,payee:n?.payee,amount,tier:null,status:null,order,source:o.addressSource});
      return r&&typeof r==='object'&&!Array.isArray(r)?{...r,order_recorded:!!r.purchaseKey}:r;}
    // ESCROW (testnet/fork only until the owner approves mainnet): a payment INTO the owner's escrow is gated on the MERCHANT it is for
    // (new-payee Face ID, scam list, sanctions, single limit); the escrow address itself must be on the owner's trust list on chain.
    const esc=!!cfg.escrow?.address&&lc(n.payee)===lc(cfg.escrow.address);
    if(esc&&!/^0x[0-9a-fA-F]{40}$/.test(String(o.escrowFor??'')))return {state:'rejected',reason:'escrow_needs_merchant',nothingPaid:true,detail:'escrow payments must name the merchant (escrowFor)'};
    if(!esc&&o.escrowFor!==undefined)return {state:'rejected',reason:'escrowFor_without_escrow',nothingPaid:true};
    const gp=esc?getAddress(lc(o.escrowFor)):n.payee;if(esc){const sx=await sanctioned(gp);if(sx)return sx;if(lc(gp)===lc(p.account)||lc(gp)===lc(cfg.escrow.address))return {state:'rejected',reason:'escrow_bad_merchant',nothingPaid:true};}
    const g=await gate({payee:gp,amount,agentId:o.agentId,source:o.addressSource,mode:'direct',purpose,scope:{chainId:n.chainId,token:n.token}});if(g.reject){const {guardRefusal,...rj}=g.reject;return rj;}
    if(esc&&g.tier==='owner_direct')return {state:'rejected',reason:'escrow_merchant_needs_owner_approval',nothingPaid:true};
    const nm=nameOf(n.payee)??(cleanName(order?.merchant??o.payeeName)||null);if(order?.merchant)setName(n.payee,order.merchant,'order');
    if(g.tier==='mandate'&&!g.hold){const ord={...(order??{}),purpose:MD.classifyCategory({purpose:o.purpose,item:order?.item,merchant:order?.merchant,host:order?.host}),mandateId:g.mandate.id};
      const ctx={tier:'mandate',payee:gp/* the payee the allowance was matched on (escrow: the merchant) */,purpose,status:g.v.status,order:ord,source:o.addressSource,mandate:{id:g.mandate.id,kind:g.mandate.kind}};/* t1278 S4 */
      const r=await payInner({...o,allowance:true,[CTX]:ctx});recordOrder(r,{agentId:o.agentId,payee:n.payee,amount,tier:'mandate',status:g.v.status,order:ord,source:o.addressSource});
      settleUse(ctx,r);
      return r&&typeof r==='object'?{...r,...g.extra,payee_name:nm,payeeVerified:g.v.verified,order_recorded:!!r.purchaseKey,say_to_user:r.say_to_user??(r.state==='paid'?`已付 ${fmtU(amount)} USDC 给 ${nm??'收款方'}（在你设的 AI 付款上限内）。/ Paid ${fmtU(amount)} USDC to ${nm??'the payee'} (within your AI payment limit).`:undefined)}:r;}
    if(g.tier==='owner_direct')return ownerConfirm({payee:n.payee,amount,name:nm,order,agentId:o.agentId,extra:g.extra});
    if(g.hold)return {...placeHold({...o,order},{payee:n.payee,amount,tier:g.tier,status:g.v.status}),...g.extra,payee_name:nm};
    const r=await payInner({...o,[CTX]:{tier:g.tier,payee:gp,purpose,status:g.v.status,order,source:o.addressSource}});recordOrder(r,{agentId:o.agentId,payee:n.payee,amount,tier:g.tier,status:g.v.status,order,source:o.addressSource});
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
    catch(e){return {state:'rejected',reason:e.code??'OWNER_CONFIRM_FAILED',detail:errText(e,200),nothingPaid:true,...extra};}
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
    let pr=null;try{pr=MD.propose({items,by:'agent:'+(agentId??'agent'),reason:`${why_en} (${mm.detail??''})`,dedupe:[mm.why,lc(payee??host??''),String(amount),pk].join('|')});}catch(e){return {state:'rejected',reason:'MANDATE_'+String(mm.why).toUpperCase(),nothingPaid:true,decision:'refuse',detail:errText(e)};}
    return {state:'awaiting_owner_approval',reason:'MANDATE_'+String(mm.why).toUpperCase(),decision:'ask_owner',approvalId:pr.id,nothingPaid:true,detail:mm.detail,
      fix:'Outside the owner allowance: the owner got ONE approval request on the phone (push, Face ID). Tell the user in one sentence, then poll kipurse_approval_status {approvalId}; when approved, call the same payment again (same idempotencyKey). Never split the payment to fit the allowance.',
      say_to_user:`还没付款：${fmtU(amount??0n)} USDC 给 ${nm}${why_zh}${pzh}。我已发到你手机，用 Face ID 同意后我就付。/ Not paid yet: ${fmtU(amount??0n)} USDC to ${nm} is ${why_en}${pen}. I sent it to your phone; approve with Face ID and I will pay.`};}
  /** Merchant order status (read-only GET on the status URL the merchant's own order response gave; https only; credential for that host only, never echoed). */
  async function merchantStatus(url,{credential}={}){let u;try{u=new URL(String(url));}catch{return {ok:false,error:'bad_status_url'};}
    const local=['127.0.0.1','localhost'].includes(u.hostname);if(u.protocol!=='https:'&&!(local&&cfg.allowHttpMerchantForTests))return {ok:false,error:'status_url_not_https'};
    // t1204 §6#93: the AI's own order credential for this call only (memory, never stored); owner config stays a fallback
    let auth=credential?{Authorization:'Bearer '+String(credential)}:null;if(!auth)try{auth=authHeaderFor(cfg.signedOrderAuth,u.toString().replace(/^http:/,'https:'));}catch{}
    if(!auth&&local&&cfg.allowHttpMerchantForTests&&cfg.testBearerForLocal)auth={Authorization:'Bearer '+(typeof cfg.testBearerForLocal==='function'?cfg.testBearerForLocal():cfg.testBearerForLocal)};
    try{const r=await mfetch(cfg)(u.toString(),{headers:{accept:'application/json',...(auth??{})},redirect:'error',signal:AbortSignal.timeout(cfg.signedOrderTimeoutMs??15000)});
      const j=await r.json().catch(()=>null);return {ok:r.ok,http:r.status,body:j};}catch(e){return {ok:false,error:'status_unreachable'};}}
  const setOrderExtra=(key,extra)=>{try{const x=ledger.db.prepare(`SELECT order_json FROM purchase_order WHERE purchase_key=?`).get(String(key));if(!x)return false;ledger.db.prepare(`UPDATE purchase_order SET order_json=? WHERE purchase_key=?`).run(JSON.stringify({...JSON.parse(x.order_json),...extra}),String(key));return true;}catch{return false;}};
  /* t1278 C2 (the contract cannot cancel a reservation without the owner): while AI payments are paused (owner stop / anomaly auto-pause) the
     server never hands out an open x402 authorization (payment header / auth / digest), not even from a stored answer; the reservation stays
     open on chain until the owner cancels it in the app (openReservations) or it expires and the settle routine reclaims it. */
  const WITHHOLD=new Set(['prepared','prepared_unconfirmed','payment_not_accepted','already_prepared']);
  const pausedHold=r=>{if(!r||typeof r!=='object'||Array.isArray(r)||!WITHHOLD.has(r.state)||!isPaused())return r;const {paymentHeader:_h,auth:_a,digest:_d,...rest}=r;
    return {...rest,state:'paused_reservation_open',reason:'wallet_paused_for_safety',reservationOpen:true,nothingPaid:false,withheld:true,
      fix:'AI payments are paused for safety. Kipurse does not hand out the open reservation; it expires and is reclaimed. Do not retry.',/* t1279 R12: no in-app cancel exists yet -> do not promise one */
      say_to_user:'AI 付款已暂停：这笔已预留，启付不会交给商家，到期后自动退回。/ AI payments are paused: Kipurse will not hand this reserved payment to the merchant; it is returned when it expires.'};};
  /* t1279 R2 (§6#139): while paused an AI must not read the prepared x402 authorization back from the ledger (get_purchase / GET /v1/purchases/:key) */
  const purchaseForAI=key=>{const r=ledger.get(key);if(!r||typeof r!=='object'||!isPaused())return r;const strip=o=>{if(!o||typeof o!=='object')return o;const {auth:_a,digest:_d,paymentHeader:_h,...rest}=o;return rest;};let res=r.result;if(typeof res==='string'){try{res=JSON.parse(res);}catch{res=null;}}if(res&&typeof res==='object'){res=strip(res);if(res.pending&&typeof res.pending==='object'){const {x402:_x,...p}=res.pending;res={...res,pending:p};}}return {...strip(r),...(res!==undefined?{result:res}:{}),withheld:true};};
  /** t1278 C2: open x402 reservations this server prepared (ledger view, no chain read): what the app offers to cancel after a stop */
  const openReservations=()=>{const out=[];try{for(const row of ledger.db.prepare(`SELECT purchase_key,payee,amount,result FROM purchases WHERE state IN ('prepared','submitted')`).all()){let res=null;try{res=JSON.parse(row.result??'null');}catch{res=null;}/* t1279 R8: a prepare tx still confirming is open too */
    const x=res?.pending?.x402??null;const d=res?.digest??res?.result?.digest??x?.digest??null;if(!d||res?.float)continue;const au=res?.auth??x?.auth;out.push({purchaseKey:row.purchase_key,digest:d,payee:row.payee,amount:row.amount,validBefore:au?.validBefore??null});}}catch{}return out;};
  const pay=o=>payGuarded(o).then(r=>o?.agentId==='owner'||o?.withdrawalId?r:pausedHold(r));
  /** Voice recap: totals for a period, by payee name, suspicious items. period: today | 7d | 30d | month */
  const spendingSummary=({period='today',tz='America/Chicago'}={})=>{const now=Date.now();let since;
    if(period==='7d')since=now-7*86400e3;else if(period==='30d')since=now-30*86400e3;else{const d=new Date(new Date(now).toLocaleString('en-US',{timeZone:tz}));const off=new Date(now).getTime()-d.getTime();d.setHours(0,0,0,0);if(period==='month')d.setDate(1);since=d.getTime()+off;}
    const rows=ledger.listFiltered({since,state:'paid',limit:5000});const by=new Map();let total=0n;const cp=costParams();/* t1281: amounts are amount + fee + network fee */
    for(const r of rows){if(r.origin_agent==='owner'&&false)continue;const a=costOf(r,cp);total+=a;const k=lc(r.payee);const e=by.get(k)??{name:nameOf(r.payee)??null,count:0,amount:0n,tier:orderFor(r.purchase_key)?.tier??null};e.count++;e.amount+=a;by.set(k,e);}
    const cats={};for(const r of rows){let c='other';try{const o=orderFor(r.purchase_key);c=MD.CATEGORIES.includes(o?.order?.purpose??o?.purpose)?(o?.order?.purpose??o?.purpose):MD.classifyCategory({purpose:o?.order?.purpose??o?.purpose,item:o?.order?.item??o?.item,merchant:o?.order?.merchant??o?.merchant});}catch{}
      const e=cats[c]??={key:c,zh:purposeName(c,true),en:purposeName(c,false),count:0,amount:0n};e.count++;e.amount+=costOf(r,cp);}
    const categories=Object.values(cats).sort((a,b)=>a.amount<b.amount?1:-1).map(e=>({...e,amount:fmtU(e.amount)}));
    const payees=[...by.values()].sort((a,b)=>a.amount<b.amount?1:-1).map(e=>({name:e.name??'未命名收款方 / unnamed payee',count:e.count,amount:fmtU(e.amount),tier:e.tier}));
    const susp=[];try{for(const d of (cfg.ownerGuard?.deposits()??[]))if((d.status==='wrong_token'||BigInt(d.amount??0)<10000n)&&Number(d.t??d.at??now)>=since/((d.t&&d.t<1e12)?1000:1))susp.push({kind:'dust_or_fake_token_deposit',note:'tiny or fake-token transfer, possible address poisoning'});}catch{}
    try{for(const h of listHolds({all:true}))if(h.createdAt>=since&&h.state==='canceled')susp.push({kind:'canceled_large_payment',name:h.name,amount:fmtU(h.amount)});}catch{}
    const p=(()=>{try{return isPaused();}catch{return false;}})();
    const say=`${({today:'今天',month:'本月','7d':'最近 7 天','30d':'最近 30 天'})[period]??period}共付 ${fmtU(total)} USDC，${rows.length} 笔`+(payees.length?`，最多的是 ${payees[0].name}（${payees[0].amount}）`:'')+(susp.length?`；有 ${susp.length} 条可疑记录`:'')+(p?'；AI 付款目前已暂停':'')+'。';
    return {period,since:new Date(since).toISOString(),total:fmtU(total),count:rows.length,categories,payees,suspicious:susp,paused:p,say_to_user:say};};
  const agentSafetyPause=reason=>{try{cfg.onAgentPause?.(reason??'agent_pause');}catch{}if(!cfg.onAgentPause)AN.localPause={reason:'agent_pause',at:Date.now()};return {ok:true,paused:true,say_to_user:'已暂停 AI 付款。只有你本人在 Kipurse App 里用 Face ID 才能恢复。/ AI payments paused. Only you can resume them in the Kipurse app with Face ID.'};};
  const payInner=o0=>{const {agentId=agentDefault,intentId,repeatKey,request,parsedId,idempotencyKey,maxAmount,ownerApproval,fallbackOrderId,allowSameAmount,verifiedDomain,withdrawalId,allowance,ownerAsk}=o0;const ctx=o0?.[CTX]??null;/* t1278 S4 */
    return withIdem(idempotencyKey,agentId,{op:'pay',v:5,intentId,repeatKey,request,parsedId,maxAmount,ownerApproval,fallbackOrderId,allowSameAmount},async()=>{
    let n=await resolveN(parsedId?{parsedId}:request);if(n.ok===false)return {state:'rejected',reason:n.code,detail:n.detail};
    if(fallbackOrderId&&!n.merchantOrderId&&n.mode==='direct')n={...n,merchantOrderId:fallbackOrderId};
    if(n.mode==='x402_redirect')return {state:'redirect',reason:'x402_redirect',next:{tool:'kipurse_paid_fetch',url:n.redirectUrl}};
    return payNormalized(n,{agentId,intentId,repeatKey,ownerApproval,maxTotal:maxAmount,allowSameAmount:allowSameAmount===true,verifiedDomain,withdrawalId,allowance:allowance===true,ownerAsk:ownerAsk===true,ctx});});};

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
    // t1204 §6#93: the credential the AI put in this order (held in memory for this one call only, keyed by the exact URL) comes first
    const aiCred=soCred.get(String(url0));let auth=aiCred?{Authorization:'Bearer '+aiCred}:null;
    if(!auth)try{auth=authHeaderFor(cfg.signedOrderAuth,u.toString());}catch{return {state:'rejected',reason:'merchant_credential_unavailable',detail:'the merchant needs its order credential for the signed order; put it in orderParams (from the user or the merchant)'};}
    if(!auth&&(cfg.signedOrderAuth??[]).some(r=>{const d=String(r.host).toLowerCase();return u.hostname===d||u.hostname.endsWith('.'+d);})&&!(local&&cfg.allowHttpMerchantForTests))return {state:'rejected',reason:'merchant_credential_unavailable'};
    if(!auth&&local&&cfg.allowHttpMerchantForTests&&cfg.testBearerForLocal)auth={Authorization:'Bearer '+(typeof cfg.testBearerForLocal==='function'?cfg.testBearerForLocal():cfg.testBearerForLocal)};
    let body;try{const res=await mfetch(cfg)(u.toString(),{headers:{accept:'application/json',...(auth??{})},redirect:'error',signal:AbortSignal.timeout(cfg.signedOrderTimeoutMs??15000)});
      if(!res.ok)return {state:'rejected',reason:'signed_order_unavailable',detail:'merchant answered HTTP '+res.status+'; unknown payee above the stranger cap is not paid unsigned'};body=await res.json();}
    catch(e){let m=redactSecrets(cfg.signedOrderAuth,String(e?.message??e));if(aiCred)m=m.split(aiCred).join('<redacted>');return {state:'rejected',reason:'signed_order_unavailable',detail:m.slice(0,200)};}
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
  const discCache=new Map();const soCred=new Map();/* t1204: signedOrderUrl -> AI credential, only while that one payment runs */
  const deepRedact=(v,secrets)=>{if(!secrets.length)return v;const fix=s=>{let t=s;for(const x of secrets)t=t.split(x).join('<redacted>');return t;};
    const walk=x=>typeof x==='string'?fix(x):Array.isArray(x)?x.map(walk):x&&typeof x==='object'&&Object.getPrototypeOf(x)===Object.prototype?Object.fromEntries(Object.entries(x).map(([k,y])=>[k,walk(y)])):x;return walk(v);};
  const say2=(zh,en)=>zh+' / '+en;
  async function discover(origin){const k=String(origin);const c=discCache.get(k);if(c&&c.t>Date.now()-10*60e3)return c.d;
    const d=await discoverMerchant(origin,{fetch:mfetch(cfg),chainId:cfg.chainId,usdc:USDC_OF[cfg.chainId],allowHttp:!!cfg.allowHttpMerchantForTests});discCache.set(k,{t:Date.now(),d});return d;}
  /** t1240 §6#110: check a merchant's signed order DTO (UsdcSignedOrder: payee, amountAtomic, orderId, orderDeadline, chainId, adapter, payer, signer,
   *  signature) against the order response v and the signer published on its origin d0. null = not usable (the normal path is taken). */
  async function signed54(so,v,d0){
    const A=k=>/^0x[0-9a-fA-F]{40}$/.test(String(so?.[k]??''));if(!A('payee')||!A('adapter')||!A('signer')||!A('payer'))return null;
    const req=serverReq({version:'kipurse.signed-order.v1',payee:so.payee,amount:String(so.amountAtomic),orderId:so.orderId,deadline:Number(so.orderDeadline),chainId:Number(so.chainId),
      adapter:so.adapter,signer:so.signer,signature:so.signature,payer:so.payer,merchant:{id:d0.host,ref:v.payment.id}});
    const n=await resolveN(req);if(!n||n.ok===false||n.mode!=='signed')return null;const o=n.signedOrder;const nowS=BigInt(await chainNow());
    if(lc(o.signer)!==lc(d0.expectedSigner))return null;                                   // the signer the merchant publishes, nobody else
    if(Number(o.chainId)!==Number(cfg.chainId)||lc(o.adapter)!==lc(cfg.adapter)||lc(o.payer??ZERO)!==lc(p.account))return null;
    if(lc(o.payee)!==lc(v.payment.to)||o.amount!==BigInt(v.payment.amountAtomic))return null;
    if(v.payment.expiresAt!=null&&o.deadline>BigInt(v.payment.expiresAt))return null;if(o.deadline<=nowS+60n)return null;
    return {signer:getAddress(o.signer),name:String(d0.host).toLowerCase(),request:req};}
  /* =================================================================================================================================
   * t1241 (handbook §6#111, owner 2026-11-21 ~18:05 CT): LAYERED MERCHANT TRUST (叠加信任). Merchants change NOTHING for Kipurse.
   * Only with V5.4 + the owner signer grant hook (cfg.signerGrant) + an attestor (cfg.attestor; the separate attestor service in prod).
   * Auto-pay of a merchant order needs ALL of: ① the owner's Face ID trust of <domain> whose ONE order signer is attestor(<domain>)
   * (V5.4 grant); ② deposit address / amount / expiry ONLY from Kipurse's own create-order call on the merchant's https origin;
   * ③ a valid merchant signature from the signer it publishes on its own origin, when it publishes one (else "unsigned merchant":
   * half the trust caps per payment and per day); ④ a fresh deposit address (no USDC, no tx), not sanctioned / scam / look-alike;
   * ⑤ the attestor's own independent re-check + signature (2-of-2); ⑥ the on-chain caps (paySignedTrusted); ⑦ after paying, the merchant
   * must confirm within the window, else the domain is paused for auto-pay (attestor refuses) and the owner is told.
   * Anything not met: the existing path (payAny -> owner ask), whose card then offers "trust <domain>" (signer = attestor(<domain>)).
   * ================================================================================================================================= */
  const LAY=!V51&&typeof cfg.signerGrant==='function'&&!!cfg.attestor;
  const ERC20_BAL=parseAbiX(['function balanceOf(address) view returns (uint256)']);
  const notifyOwner=ev=>{try{cfg.ownerNotify?.(ev);}catch{}};
  try{ledger.db.exec(`CREATE TABLE IF NOT EXISTS layered_pay(purchase_key TEXT PRIMARY KEY, domain TEXT NOT NULL, amount TEXT NOT NULL, created_at INTEGER NOT NULL, merchant_signed INTEGER NOT NULL, status_url TEXT, state TEXT NOT NULL, confirm_by INTEGER NOT NULL, checked_at INTEGER, merchant_status TEXT);
    CREATE TABLE IF NOT EXISTS layered_domain(domain TEXT PRIMARY KEY, paused_at INTEGER, reason TEXT);`);}catch{}
  const lpCred=new Map();/* merchant status credential of an auto-paid order: memory only (never stored), for the confirmation follow-up */const lpTimers=new Map();
  const CONF={windowMs:Number(cfg.merchantConfirm?.windowMs??30*60e3),pollMs:Number(cfg.merchantConfirm?.pollMs??20e3)};
  const domainPaused=d=>{try{return ledger.db.prepare(`SELECT * FROM layered_domain WHERE domain=? AND paused_at IS NOT NULL`).get(lc(d))??null;}catch{return null;}};
  async function pauseDomain(domain,reason){const d=lc(domain);let already=false;
    try{already=!!domainPaused(d);ledger.db.prepare(`INSERT INTO layered_domain VALUES(?,?,?) ON CONFLICT(domain) DO UPDATE SET paused_at=excluded.paused_at,reason=excluded.reason`).run(d,Date.now(),String(reason).slice(0,80));}catch{}
    try{await cfg.attestor?.pause?.(d,reason);}catch{}try{cfg.obs?.log?.('merchant_auto_pay_paused',{domain:d,reason:String(reason).slice(0,60)});}catch{}
    if(!already)notifyOwner({kind:'merchant_paused',domain:d,reason:String(reason).slice(0,60)});return {ok:true,domain:d,paused:true};}
  async function resumeDomain(domain){const d=lc(domain);try{ledger.db.prepare(`DELETE FROM layered_domain WHERE domain=?`).run(d);}catch{}try{await cfg.attestor?.resume?.(d);}catch{}try{cfg.obs?.log?.('merchant_auto_pay_resumed',{domain:d});}catch{}return {ok:true,domain:d,paused:false};}
  const RECEIVED=/^(paid|payment_received|received|processing|succeeded|fulfilled|complete|completed|confirmed|done|success|delivered|active|live|placed|won|ranked)$/i;
  const NOT_OK=/^(manual_review|needs_review|review|underpaid|overpaid|mismatch)$/i;
  /** ⑦ one look at the merchant's order status of an auto-paid order: confirmed -> done; failed / review / window over -> pause the domain */
  async function checkConfirm(key){lpTimers.delete(key);let row=null;try{row=ledger.db.prepare(`SELECT * FROM layered_pay WHERE purchase_key=?`).get(String(key));}catch{}if(!row||row.state!=='watching')return row?.state??null;
    let st=null;if(row.status_url){const m=await merchantStatus(row.status_url,{credential:lpCred.get(key)}).catch(()=>null);if(m?.ok)st=readMerchantStatus(m.body);}
    const ms=String(st?.merchantStatus??'');const set=(s)=>{try{ledger.db.prepare(`UPDATE layered_pay SET state=?,checked_at=?,merchant_status=? WHERE purchase_key=?`).run(s,Date.now(),ms.slice(0,40)||null,String(key));}catch{}};
    if(st&&(st.status==='fulfilled'||RECEIVED.test(ms))){set('confirmed');lpCred.delete(key);return 'confirmed';}
    if(st&&(st.status==='failed'||NOT_OK.test(ms))){set('unconfirmed');lpCred.delete(key);await pauseDomain(row.domain,'merchant_status_'+(ms||'failed'));return 'unconfirmed';}
    if(Date.now()>=row.confirm_by){set('unconfirmed');lpCred.delete(key);await pauseDomain(row.domain,'merchant_did_not_confirm');return 'unconfirmed';}
    set('watching');const t=setTimeout(()=>{checkConfirm(key).catch(()=>{});},Math.max(50,Math.min(CONF.pollMs,row.confirm_by-Date.now())));t.unref?.();lpTimers.set(key,t);return 'watching';}
  try{for(const r of ledger.db.prepare(`SELECT purchase_key FROM layered_pay WHERE state='watching'`).all()){const t=setTimeout(()=>{checkConfirm(r.purchase_key).catch(()=>{});},1000);t.unref?.();lpTimers.set(r.purchase_key,t);}}catch{}
  const freshAddress=cfg.freshAddress??(async a=>{const [b,n]=await Promise.all([c.pub.readContract({address:getAddress(cfg.token),abi:ERC20_BAL,functionName:'balanceOf',args:[getAddress(a)]}),c.pub.getTransactionCount({address:getAddress(a)})]);return BigInt(b)===0n&&Number(n)===0;});
  /** what this merchant domain already took today: max(on-chain merchant day spend, Kipurse's own layered payments in the last 24 h); null = unknown */
  async function merchantSpentToday(m,domain){let chain=0n;try{const ph=cfg.permissionHash??await rd('getHash',[p],cfg.manager);const cnow=await chainNow();
      if(cnow>=p.start)chain=BigInt(await rd('merchantDaySpent',[ph,m,BigInt(Math.floor((cnow-p.start)/86400))]));}catch{return null;}
    let local=0n;try{const cp=costParams();for(const r of ledger.db.prepare(`SELECT l.amount,p.result,p.state FROM layered_pay l JOIN purchases p ON p.purchase_key=l.purchase_key WHERE l.domain=? AND l.created_at>=? AND p.state IN ('claimed','submitted','prepared','paid')`).all(lc(domain),Date.now()-86400e3))local+=costOf(r,cp);}catch{}/* t1281: amount + fees, like the on-chain merchant day */
    return chain>local?chain:local;}
  /** the layered decision for one checked merchant order. Returns null (not applicable), {result} (answer the AI: paid / already paid / hard refusal)
   *  or {why, askSigner, domain, merchantSigned} (no auto-pay; the owner ask may offer "trust <domain>" with the attestor as its signer). */
  async function layered(order,v,d0,o,{cred}){
    const domain=lc(v.merchant);if(!validDomain(domain,{allowLocal:!!cfg.allowHttpMerchantForTests}))return null;
    const nowS=Number(await chainNow());const log=(k,x)=>{try{cfg.obs?.log?.(k,{domain,...x});}catch{}};
    // ③ evidence: a merchant that publishes a signer must sign THIS payee + amount (any declared EIP-712 form, any verifying contract)
    let merchantSigned=false;
    if(d0.expectedSigner){const decl=(d0.routes??[d0]).map(x=>x.signedOrder).find(Boolean)??null;
      const ev=await verifyMerchantSignature({so:order?.signedOrder,expectedSigner:d0.expectedSigner,payee:v.payment.to,amountAtomic:v.payment.amountAtomic,chainId:cfg.chainId,declared:decl,nowS,wallet:p.account});
      if(!ev.ok){log('merchant_signature_rejected',{code:ev.code});return {domain,merchantSigned:false,askSigner:null,why:ev.code};}/* no auto-pay, no domain trust offered on this order */
      merchantSigned=true;}
    let attAddr=null;try{attAddr=getAddress(lc(await cfg.attestor.address(domain)));}catch{attAddr=null;}
    if(!attAddr){log('attestor_unavailable',{});return null;}
    const base={domain,merchantSigned,askSigner:attAddr};
    // the same merchant order is never paid twice: (merchant, orderId) ledger key, and any started payment to this deposit address for this amount
    {const dup=(()=>{try{return ledger.db.prepare(`SELECT purchase_key,state,tx_hash FROM purchases WHERE lower(payee)=lower(?) AND amount=? AND state IN ('claimed','submitted','prepared','paid') LIMIT 1`).get(v.payment.to,String(v.payment.amountAtomic));}catch{return null;}})();
      if(dup)return {...base,result:{state:dup.state==='paid'?'already_paid':'in_progress',reason:dup.state==='paid'?'already_paid':'in_progress',purchaseKey:dup.purchase_key,txHash:dup.tx_hash??null,nothingPaidNow:true,
        say_to_user:dup.state==='paid'?say2('这一单已经付过了，不会再付。','This order was already paid; it will not be paid again.'):say2('这一单正在付款中，不会重复付。','This order is being paid; it will not be paid twice.')}};}
    if(domainPaused(domain))return {...base,why:'domain_paused'};
    let g=null;try{g=await cfg.signerGrant({account:p.account,signer:attAddr,order:{payer:p.account},nowS});}catch{g=null;}
    if(!g)return {...base,why:'no_owner_grant'};
    {const lk=strip(signedPurchaseKeyV5(g.merchant,attestorOrderId(domain,v.payment.id)));const prev=ledger.get(lk);
      if(prev&&['claimed','submitted','prepared','paid'].includes(prev.state))return {...base,result:{state:prev.state==='paid'?'already_paid':'in_progress',purchaseKey:lk,txHash:prev.tx_hash??null,nothingPaidNow:true}};}
    // ④ the deposit address: sanctions / scam list / look-alike / dust (verifyPayee) and FRESH (no USDC, no transaction yet)
    {const sx=await sanctioned(v.payment.to);if(sx)return {...base,askSigner:null,why:'sanctioned'};}
    const vp=await verifyPayee({address:v.payment.to});if(!vp.ok)return {...base,why:'payee_check_unavailable'};
    if(vp.required_action!=='none'){log('layered_payee_refused',{status:vp.status});return {...base,askSigner:null,why:'payee_'+String(vp.code??vp.status)};}
    let fresh=false;try{fresh=await freshAddress(v.payment.to);}catch{fresh=false;}if(!fresh)return {...base,why:'deposit_address_not_fresh'};
    // caps: signed merchant = the trust caps (the chain enforces them); unsigned merchant = HALF of them per payment and per day (entry 111 default)
    const amt=BigInt(v.payment.amountAtomic);const fe=feeFor(amt,await fee());
    if(amt>BigInt(g.single)||amt>B('single'))return {...base,why:'over_trust_single'};
    if(!merchantSigned){const spent=await merchantSpentToday(g.merchant,domain);if(spent===null)return {...base,why:'merchant_spend_unknown'};
      if(amt>BigInt(g.single)/2n)return {...base,why:'over_unsigned_half_single'};
      if(spent+amt+fe>BigInt(g.daily)/2n)return {...base,why:'over_unsigned_half_daily'};}
    const ik=o.idempotencyKey?String(o.idempotencyKey).slice(0,120)+':att':null;if(!ik)return {...base,why:'idempotency_key_required'};
    {const rr=replayOf(ik);let x=null;try{x=rr?JSON.parse(rr.response):null;}catch{x=null;}if(x&&x.state==='rejected'&&x.nothingPaid!==false&&!x.txHash)return {...base,why:'pay_'+String(x.reason??'rejected')};if(x)return {...base,result:x,extra:{layered:true,replay:true}};}/* exactly-once: the stored answer of this derived key */
    // ⑤ the attestor's own independent check + signature (2-of-2); the gateway holds no attestor key
    let at=null;try{at=await cfg.attestor.attest({domain,ref:v.payment.id,purchaseId:v.purchaseId??undefined,statusUrl:v.statusUrl,payee:v.payment.to,amountAtomic:String(v.payment.amountAtomic),expiresAt:v.payment.expiresAt,
      payer:p.account,chainId:cfg.chainId,adapter:cfg.adapter,...(cred?{credential:String(cred)}:{}),...(merchantSigned?{merchantSignedOrder:order.signedOrder}:{})});}catch{at=null;}
    if(!at?.ok){log('layered_attestor_refused',{code:String(at?.code??'unavailable').slice(0,40)});return {...base,why:'attestor_'+String(at?.code??'unavailable')};}
    if(!!at.merchantSigned!==merchantSigned){log('layered_evidence_mismatch',{});return {...base,askSigner:null,why:'evidence_mismatch'};}
    const so=at.signedOrder;
    if(!so||lc(so.signer)!==lc(attAddr)||lc(so.payee)!==lc(v.payment.to)||String(so.amount)!==String(v.payment.amountAtomic)||lc(so.payer)!==lc(p.account)||lc(so.adapter)!==lc(cfg.adapter)||Number(so.chainId)!==Number(cfg.chainId)
      ||lc(so.orderId)!==lc(attestorOrderId(domain,v.payment.id))||(v.payment.expiresAt!=null&&Number(so.deadline)>Number(v.payment.expiresAt)))return {...base,askSigner:null,why:'attested_order_mismatch'};
    const r=await pay({...o,idempotencyKey:ik,request:serverReq(so),merchant:v.merchant,verifiedDomain:v.merchant});
    if(r?.state==='paid'){const key=r.purchaseKey;
      try{ledger.db.prepare(`INSERT OR IGNORE INTO layered_pay VALUES(?,?,?,?,?,?,'watching',?,NULL,NULL)`).run(String(key),domain,amt.toString(),Date.now(),merchantSigned?1:0,v.statusUrl??null,Date.now()+CONF.windowMs);}catch{}
      if(cred)lpCred.set(key,String(cred));try{setOrderExtra(key,{statusUrl:v.statusUrl??null,layered:true,merchantSigned,domain});}catch{}
      notifyOwner({kind:'auto_paid',domain,amount:fmtU(amt),merchantSigned});log('layered_auto_paid',{merchantSigned});
      if(v.statusUrl){const t=setTimeout(()=>{checkConfirm(key).catch(()=>{});},Math.min(CONF.pollMs,5000));t.unref?.();lpTimers.set(key,t);}
      else{try{ledger.db.prepare(`UPDATE layered_pay SET state='unconfirmed' WHERE purchase_key=?`).run(String(key));}catch{}await pauseDomain(domain,'merchant_has_no_status');}
      return {...base,result:r,extra:{layered:true,attested:true,merchantSigned,trustDomain:domain}};}
    if(r?.reason==='idempotency_key_reused_with_different_request'||r?.state==='in_progress')return {...base,result:{state:'in_progress',reason:'in_progress',nothingPaidNow:true,say_to_user:say2('这一单正在付款中，不会重复付。','This order is being paid; it will not be paid twice.')}};/* a concurrent call for the same order */
    if(r&&(r.state==='rejected'||r.state==='retry_later')&&r.nothingPaid!==false&&!r.txHash&&!r.purchaseKey){/* t1241 (lead review, 0A#7 locked): the derived key's stored answer is never deleted; a refused attested payment stays refused and a retry goes to the owner ask */
      if(r.state==='retry_later')return {...base,result:r};return {...base,why:'pay_'+String(r.reason??'rejected')};}
    return {...base,result:r,extra:{layered:true,attested:true,merchantSigned,trustDomain:domain}};}
  const payMerchantOrder=async({origin,orderParams={},merchantPurchaseId,signedOrder,...o})=>{
    // t1204 §6#93 (owner: AI fills the order content, Kipurse only pays): the AI sends the merchant's documented order fields (incl. a
    // listing/management token the user gave it); Kipurse forwards them as-is to that merchant's https origin only, never stores, logs
    // or echoes them, and still decides payee/amount/expiry only from the merchant's order response + the owner's limits.
    const P=orderParams&&typeof orderParams==='object'&&!Array.isArray(orderParams)?{...orderParams}:{};
    let d0;try{d0=await discover(origin);}catch(e){return {state:'rejected',reason:e.code??'discovery_failed',detail:e.detail};}
    let tok=null;try{const h=authHeaderFor(cfg.signedOrderAuth,d0.origin.replace(/^http:/,'https:'));tok=h?h.Authorization.slice(7):null;}catch{}
    if(!tok&&cfg.allowHttpMerchantForTests&&cfg.testBearerForLocal)tok=typeof cfg.testBearerForLocal==='function'?cfg.testBearerForLocal():cfg.testBearerForLocal;
    const secrets=[...new Set([...orderSecrets(d0,P),...(d0.routes??[]).flatMap(r=>orderSecrets(r,P)),...(tok?[String(tok)]:[])])].sort((a,b)=>b.length-a.length);
    const red=s=>deepRedact(String(s),secrets);
    const sel=selectRoute(d0,P,{fallbackCredential:!!tok});
    if(!sel.ok){const host=d0.host,need=sel.missing,list=need.join(', ');
      return {state:'rejected',reason:'missing_order_fields',decision:'refuse',nothingPaid:true,merchant:host,orderApi:sel.route.create.path,missingFields:need,
        requiredFields:sel.route.create.required.filter(k=>k!==sel.route.create.idempotencyField),alternatives:sel.alternatives,docs:d0.sources,
        fix:`Nothing paid. ${host}'s order API ${sel.route.create.path} needs these orderParams fields from you: ${list}. Get them from the user or from the merchant (see its docs) and call again with the same merchantPurchaseId. Kipurse keeps no merchant credentials: put e.g. a listing/management token in orderParams; it is sent only to ${host} over https and never stored, logged or shown.`+(sel.alternatives.length?` Other order APIs of this merchant: ${sel.alternatives.map(a=>a.path+' (missing '+(a.missing.join(', ')||'nothing')+')').join('; ')}.`:''),
        say_to_user:say2(`还没付款：${host} 下单还缺这些信息：${list}。请告诉我（或在 ${host} 上找到），我再下单。启付不保存商家凭据。`,`Not paid: ${host} needs these order details first: ${list}. Please give them to me (or find them on ${host}) and I will place the order. Kipurse does not keep merchant credentials.`)};}
    const d=sel.route;
    if(!merchantPurchaseId)return {state:'rejected',reason:'merchant_purchase_id_required',detail:`the merchant's ${d.create.idempotencyField??'idempotency'} key; reuse it on every retry`};
    const aiCred=d.create.bodyAuth&&P[d.create.bodyAuth]!=null&&P[d.create.bodyAuth]!==''?String(P[d.create.bodyAuth]):null;
    const cred=aiCred??tok;const f=mfetch(cfg);
    const done=(r,v,extra={})=>{const out=deepRedact({...r,...extra,merchant:v.merchant,merchantPurchaseId,statusUrl:v.statusUrl,discovered:{section:d.section,create:d.create.path,status:d.status?.path??null,sources:d.sources}},secrets);
      if(cred)Object.defineProperty(out,'_merchantAuth',{value:cred,enumerable:false});/* in-memory only, for the follow-up status poll of THIS call */return out;};
    /* t1240 §6#110: V5.4 + owner signer grants on: ask the merchant for an order signed for THIS adapter and bound to THIS wallet, only when its
       public capabilities say it signs for this adapter, names the payer field and publish a signer on its own origin (else: exactly as before) */
    const so54=!V51&&typeof cfg.signerGrant==='function'&&!!d.signedOrder?.available&&!!d.signedOrder.optIn&&!!d.signedOrder.payerParam&&!!d0.expectedSigner&&lc(d.signedOrder.verifyingContract)===lc(cfg.adapter);
    /* t1241 §6#111 ③: layered mode asks a merchant that publishes its own order signer and documents the signedOrder opt-in for its usual signed
       order (no payer, no Kipurse contract: the merchant changes nothing); the signature is evidence only */
    const laySo=LAY&&!so54&&!!d.signedOrder?.available&&!!d.signedOrder.optIn&&!!d0.expectedSigner;
    let order;try{const rq=buildCreateOrder(d,P,{credential:aiCred?null:tok,purchaseId:merchantPurchaseId,signedOrder:!!(signedOrder&&V51)||so54||laySo,payer:so54?p.account:null});
      const r=await f(rq.url,{...rq.init,signal:AbortSignal.timeout(cfg.signedOrderTimeoutMs??15000)});const j=await r.json().catch(()=>null);
      if(!r.ok)return {state:'rejected',reason:'merchant_order_refused',nothingPaid:true,detail:red(`HTTP ${r.status} ${j?.error??j?.code??''}`).slice(0,160),retryAfterSeconds:j?.retryAfterSeconds};order=j;}
    catch(e){return {state:'rejected',reason:e.code??'merchant_order_failed',nothingPaid:true,detail:scrubUrls(red(e.detail??e.message)).slice(0,160)};}
    const v=orderToPayment(order,d,{chainId:cfg.chainId,usdc:USDC_OF[cfg.chainId],nowS:Number(await chainNow())});
    if(!v.ok)return {state:'rejected',reason:v.code,nothingPaid:true,detail:v.detail==null?v.detail:red(v.detail).slice(0,160),merchantPurchaseId};
    // V5.1 attestor: our own key signs the checked order -> paid within the merchant DOMAIN's trust caps (no merchant signature needed)
    const att=V51&&!o.noAttest?(cfg.attestors?.[lc(v.merchant)]??null):null; // ONE attestor key per trusted domain (a signer binds to exactly one merchant on chain)
    if(att){const so=await attestOrder(att,v,{payer:p.account,chainId:cfg.chainId,verifier:await verifierAddr(),types:ORDER_TYPES51,domain:orderDomain51});
      const r=await pay({...o,request:serverReq(so)});return done(r,v,{attested:true});}
    /* t1240 §6#110: a merchant-signed order (checked here: signature, published signer, this chain / adapter / wallet, same payee / amount /
       expiry as the order response). With the owner's grant for that signer -> pay it on the signed route (paySignedTrusted; the chain re-checks
       all of it). Without a grant -> unchanged path below; the owner ask then carries the signer so ONE "trust" covers this merchant's later orders. */
    let sv=null;if(so54&&order?.signedOrder&&order.signedOrder.available!==false){try{sv=await signed54(order.signedOrder,v,d0);}catch{sv=null;}}
    if(sv){let g=null;try{g=await cfg.signerGrant({account:p.account,signer:sv.signer,order:{payer:p.account},nowS:Number(await chainNow())});}catch{g=null;}
      if(g){const r=await pay({...o,request:sv.request,merchant:v.merchant,verifiedDomain:v.merchant});
        if(!(r?.state==='rejected'&&r?.nothingPaid!==false))return done(r,v,{signedTrusted:true});}}
    /* t1241 §6#111: layered merchant trust (V5.4 + grant hook + attestor only; a merchant-signed order for our adapter above keeps its own path) */
    let lay=null;if(LAY&&!(sv&&cfg.signerGrant)){try{lay=await layered(order,v,d0,o,{cred});}catch(e){lay=null;try{cfg.obs?.log?.('layered_error',{e:String(e?.message??e).slice(0,80)});}catch{}}
      if(lay?.result)return done(lay.result,v,lay.extra??{});}
    const soUrl=v.signedOrderOffered&&v.statusUrl?v.statusUrl:o.signedOrderUrl;
    if(soUrl&&aiCred)soCred.set(String(soUrl),aiCred);
    try{const r=await payAny({...o,verifiedDomain:v.merchant,payment:v.payment,merchant:v.merchant,signedOrderUrl:soUrl});const out=done(r,v);
      /* t1212 §6#97 (owner: 「改，新收款方一次 Face ID 批准就付这一笔」): a refused order payment carries, in memory only, exactly what the server
         would pay after the owner's ONE Face ID (payee / amount / order id from the merchant's checked order response; never the AI's order fields). */
      if(r?.state==='rejected')Object.defineProperty(out,'_askSpec',{value:{kind:'payAny',args:{payment:v.payment,merchant:v.merchant,verifiedDomain:v.merchant,...(o.orderRef!==undefined?{orderRef:o.orderRef}:{}),order:o.order,purpose:o.purpose,addressSource:o.addressSource},
        ...(sv?{signer:sv.signer,signerMerchant:sv.name}:{})/* t1240: verified merchant signer for the owner's trust (never from the AI) */,
        ...(!sv&&lay?.askSigner?{signer:lay.askSigner,signerMerchant:lay.domain,merchantSigned:!!lay.merchantSigned,attested:true}:{})/* t1241: trust <domain> with attestor(<domain>) as its one signer (server-made, never from the AI) */},enumerable:false});
      return out;}
    finally{if(soUrl&&aiCred)soCred.delete(String(soUrl));}};
  // ---- owner setup / limits / trust / deposits / withdrawals (spec 2026-10-20) ----
  const needG=()=>{if(!cfg.ownerGuard)throw Object.assign(Error('owner guard not configured'),{code:'owner_guard_not_configured'});return cfg.ownerGuard;};
  const wrap=f=>async(...a)=>{try{return await f(...a);}catch(e){return {state:'rejected',reason:e.code??'invalid',detail:errText(e,400),errors:e.errors};}};
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
    if(so?.signedOrder)return {...(await pay({...o,request:serverReq(so.signedOrder)})),signedOrderRequested:true};
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
  const paidFetch=async(o)=>{await warmFee();/* t1281 */if(o.agentId==='owner')return paidFetchInner(o);if(replayOf(o.idempotencyKey))return pausedHold(await paidFetchInner(o));/* t1278 C2 */const order=normalizeOrder(o);
    if(isPaused())return {state:'rejected',reason:'wallet_paused_for_safety',nothingPaid:true,fix:'AI payments are paused; only the owner can resume them in the Kipurse app (Face ID).'};
    {const st=MD.agentCheck(o.agentId,undefined);if(st)return st;}
    const oc=checkOrder({order,amount:undefined,cfg:GUARD});if(oc)return oc;const r=await paidFetchInner(o);const info=x402Info.get(o.idempotencyKey);x402Info.delete(o.idempotencyKey);
    if(r?.guardRefusal){try{ledger.db.prepare(`DELETE FROM idempotency WHERE idem_key=?`).run(o.idempotencyKey);}catch{}const {guardRefusal,...rest}=r;return rest;}/* refusals are not cached: retry works after Face ID trust */
    const cat=MD.classifyCategory({purpose:o.purpose,item:order?.item,merchant:order?.merchant,host:order?.host});const ord=info?.mandate?{...(order??{}),purpose:cat,mandateId:info.mandate.id}:{...(order??{}),purpose:cat};
    recordOrder(r,{agentId:o.agentId,payee:info?.payee??null,amount:info?.amount,tier:info?.tier??'x402',status:info?.status??null,order:ord,source:o.addressSource});
    if(info?.ctx)settleUse(info.ctx,r);else if(info?.mandate&&r?.state==='paid')MD.used(info.mandate.id);/* t1278 S4 */
    return info&&r&&typeof r==='object'?{...r,payee_tier:info.tier,payee_tier_text:info.extra?.payee_tier_text??TIER_SAY[info.tier],...(info.mandate?{mandate:info.mandate}:{})}:r;};
  /* t1264: the agent's request goes through the SSRF guard (public https only, no private / loopback / link-local hosts, no redirects;
     injected test fetch = cfg.fetch / cfg.allowHttpMerchantForTests as for every other merchant call). Agent-supplied headers lose hop-by-hop,
     Host, Content-Length, Cookie-less proxy / forwarding and cf-* headers (and any payment header it tries to set itself). */
  const DROP_HDR=/^(host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|forwarded|x-forwarded-.*|x-real-ip|cf-.*|cdn-loop|payment-signature|x-payment)$/i;
  const cleanHeaders=h=>{const out={};if(!h||typeof h!=='object'||Array.isArray(h))return out;for(const [k,v] of Object.entries(h)){const kk=String(k).trim();
    if(!kk||DROP_HDR.test(kk)||!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(kk)||v===undefined||v===null||typeof v==='object')continue;const vv=String(v);if(/[\r\n\0]/.test(vv)||vv.length>4096)continue;out[kk]=vv;}return out;};
  const paidFetchInner=({agentId=agentDefault,intentId,repeatKey,url,method='GET',headers:hdr0={},body,idempotencyKey,maxAmount,ownerApproval,addressSource,purpose})=>withIdem(idempotencyKey,agentId,{op:'fetch',v:5,intentId,repeatKey,url,method,body,maxAmount},async()=>{
    const fetchImpl=mfetch(cfg);const headers=cleanHeaders(hdr0);
    let first;try{first=await fetchImpl(url,{method,headers,body});}catch(e){if(e?.code==='ssrf_blocked')return {state:'rejected',reason:'url_not_allowed',nothingPaid:true,detail:'only public https URLs can be paid for (no private, local or redirecting hosts)'};throw e;}
    /* t1278 S5: bodies are read with a 256 KB cap (after decompression); an oversize 402 body is refused, nothing paid */
    if(first.status!==402)return {state:'no_payment_needed',status:first.status,body:(await readCapped(first)).text.slice(0,20000)};
    const fb=await readCapped(first);if(fb.truncated)return {state:'rejected',reason:'x402_response_too_large',nothingPaid:true};const text=fb.text;let parsed;try{parsed=JSON.parse(text);}catch{}
    const n=detect({status:402,headers:first.headers,body:parsed??text,url},{chains:[cfg.chainId]});
    if(!n.ok)return {state:'rejected',reason:n.code,detail:n.detail};
    if(agentId!=='owner'){if(!n.payee)return {state:'rejected',reason:'x402_payee_unknown',nothingPaid:true,guardRefusal:true};
      let host=null;try{host=new URL(url).hostname.toLowerCase();}catch{}
      const g=await gate({payee:n.payee,amount:typeof n.amount==='bigint'?n.amount:BigInt(n.amount??0),agentId,source:addressSource,mode:'x402',purpose:purposeKey(purpose)??undefined,host,scope:{chainId:n.chainId,token:n.token}});if(g.reject)return {...g.reject,guardRefusal:true};
      x402Info.set(idempotencyKey,{tier:g.tier,payee:n.payee,amount:String(n.amount),status:g.v.status,mandate:g.mandate?{id:g.mandate.id,purpose:g.mandate.purpose}:null,extra:g.extra,
        ctx:{tier:g.tier??'x402',payee:n.payee,host,purpose:purposeKey(purpose)??undefined,status:g.v.status,order:g.mandate?{mandateId:g.mandate.id}:{},source:addressSource,mandate:g.mandate?{id:g.mandate.id,kind:g.mandate.kind}:null}});}/* t1278 S4 */
    const fl=cfg.float?.enabled?await floatFetch(n,{agentId,intentId,repeatKey,url,method,headers,body,fetchImpl,maxAmount}):null;
    if(fl)return fl;
    const r=await payNormalized(n,{agentId,intentId,repeatKey,ownerApproval,maxTotal:maxAmount,allowance:x402Info.get(idempotencyKey)?.tier==='mandate',ctx:x402Info.get(idempotencyKey)?.ctx??null});
    if(['in_progress','already_prepared','already_paid'].includes(r.state)){
      for(let i=0;i<90;i++){const row=ledger.get(r.purchaseKey);if(row.state==='paid')return {state:'paid_by_other_agent',purchaseKey:r.purchaseKey,paidBy:row.claimed_by,result:row.result?JSON.parse(row.result):null};
        if(row.state==='failed'||row.state==='reclaimed')return {state:'other_agent_'+row.state,purchaseKey:r.purchaseKey};await new Promise(z=>setTimeout(z,1000));}
      return {state:'in_progress',purchaseKey:r.purchaseKey,paidBy:r.paidBy};}
    if(r.state!=='prepared')return r;
    if(agentId!=='owner'&&isPaused())return pausedHold(r);   /* t1278 C2: paused while the reservation was prepared -> never sent to the merchant */
    let second;for(let attempt=0;attempt<3;attempt++){
      second=await fetchImpl(url,{method,headers:{...headers,[r.paymentHeader.name]:r.paymentHeader.value},body});
      if(second.status!==402||attempt===2)break;await readCapped(second);await new Promise(z=>setTimeout(z,cfg.retryDelayMs??4000));}
    const resp=second.headers.get('PAYMENT-RESPONSE')??second.headers.get('X-PAYMENT-RESPONSE');
    let settlement;try{settlement=resp?JSON.parse(Buffer.from(resp,'base64').toString()):undefined;}catch{}
    const out={state:second.ok?'paid':'payment_not_accepted',status:second.status,purchaseKey:r.purchaseKey,prepareTx:r.txHash,auth:r.auth,digest:r.digest,settlement,
      amount:n.amount.toString(),fee:r.fee,networkFee:r.networkFee,gasRecovery:r.gasRecovery,total:(n.amount+BigInt(r.fee??0)+BigInt(r.networkFee??0)).toString(),body:(await readCapped(second)).text.slice(0,20000)};
    ledger.update(r.purchaseKey,agentId,second.ok?{state:'paid',settle_tx:settlement?.transaction??null,result:{...out,vault:r.vault,digest:r.digest}}:{state:'prepared',result:{...r,merchantResponse:out}});
    // ONE sponsored tx per x402 payment: no inline markSettled. Fees wait in the adapter until settleRoutine closes reservations in a batch.
    // t1252 (§6#121, V5.5): markSettledInline = the VAULT closes it with its own USDC-gas UserOp (Circle uses the allowance the cap-sized prepare permit left)
    if(second.ok&&cfg.markSettledInline===true)pendingClose.push(markSettledOne(r.digest,r.auth).then(x=>{try{cfg.obs?.log?.('x402_mark_settled',{state:x?.state});}catch{}return x;}).catch(e=>{try{cfg.obs?.log?.('x402_mark_settled',{state:'error',error:String(e?.shortMessage??e?.message??e).slice(0,120)});}catch{}}));
    // t1250 V5.5 (R2-02; cfg.afterX402Settled is set only when KIPURSE_V55=1): markSettled right away from an ORDINARY account, because the vault's
    // gas permits stay refused until the settled reservation leaves its cached reserve. Never blocks or changes this answer.
    if(second.ok&&typeof cfg.afterX402Settled==='function')pendingClose.push(Promise.resolve().then(()=>cfg.afterX402Settled({digest:r.digest,auth:r.auth,vault:r.vault})).catch(()=>{}));
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
      total:(n.amount+BigInt(v.fee)).toString(),note:v.note,body:(await readCapped(second)).text.slice(0,20000)};
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
      }catch(e){out.push({key:row.purchase_key,digest,state:'error',error:errText(e)});}
    }
    for(let i=0;i<toMark.length;i+=maxBatch){const part=toMark.slice(i,i+maxBatch);
      try{const tx=await write('markSettled',[part.map(x=>x.digest)],{label:'markSettled:batch:'+part.length});
        for(const x of part){ledger.db.prepare(`UPDATE purchases SET state='paid',settle_tx=COALESCE(settle_tx,?) WHERE purchase_key=?`).run('markSettled '+tx.hash,x.key);out.push({key:x.key,digest:x.digest,state:'marked',txHash:tx.hash,batch:part.length});}}
      catch(e){for(const x of part)out.push({key:x.key,digest:x.digest,state:'error',error:errText(e)});}}
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
  /* t1170u §6#82: owner asks. spec = {kind:'payAny'|'pay', args} exactly as the AI called it. */
  const askRequest=async spec=>{const a=spec?.args??{};if(spec?.kind==='payAny'){const x=normalizePaymentRequest(a.payment,{chainId:cfg.chainId,merchant:a.merchant,orderRef:a.orderRef,expiresAt:a.expiresAt});
      if(!x.ok||x.kind!=='request')return null;return {request:x.request,fallbackOrderId:x.merchantOrderId??undefined};}
    if(spec?.kind==='pay'&&a.request&&!a.parsedId)return {request:a.request,fallbackOrderId:a.fallbackOrderId};return null;};
  const askN=async spec=>{const q=await askRequest(spec);if(!q)return null;let n;try{n=await resolveN(q.request);}catch{return null;}if(!n||n.ok===false||n.mode!=='direct'||!n.payee||typeof n.amount!=='bigint')return null;
    if(q.fallbackOrderId&&!n.merchantOrderId)n={...n,merchantOrderId:q.fallbackOrderId};return {n,q};};
  const WALLET_HARD=/^(over_single_cap|over_daily_cap|over_term_cap)/;const ONCHAIN_TIER=/^over_(stranger|unrecognized|verified|trusted|merchant)/;
  /** is this refused request a NEW payee above an AI auto limit (-> owner ask), above the wallet limit (-> no card), or neither? */
  async function ownerAskClass(spec,{agentId}={}){const z=await askN(spec);if(!z)return {ok:false,code:'not_direct'};const {n}=z;const a=spec.args??{};
    if(isPaused())return {ok:false,code:'paused'};{const st=MD.agentCheck(agentId);if(st?.reason==='AGENT_STOPPED')return {ok:false,code:'agent_stopped'};}
    const v=await verifyPayee({address:n.payee,source:a.addressSource});if(!v.ok||v.required_action!=='none')return {ok:false,code:'payee_refused'};
    const tier=v.payee_tier;let newPayee=!(tier==='trust_list'||tier==='verified'||tier==='owner_direct');
    if(newPayee){const m=MD.match({purpose:purposeKey(a.purpose)??undefined,payee:n.payee,amount:n.amount,agentId});if(m.ok&&(m.mandate.kind==='one_off'||m.mandate.kind==='recurring'||m.mandate.payees?.includes(lc(n.payee))))newPayee=false;}
    let pk=null;try{pk=identity(n,{repeatKey:a.repeatKey,intentId:a.intentId}).ledgerKey;}catch{pk=null;}/* t1264: the order identity (owner-ask dedupe) */
    const out={ok:true,payee:getAddress(lc(n.payee)),amount:n.amount.toString(),newPayee,purchaseKey:pk};
    /* t1212 §6#97: a known payee is asked only when an ON-CHAIN payee cap refuses it (an allowance approval can never lift that cap, so the
       old path asked again and again); everything else about a known payee stays as it was */
    if(!newPayee){let pa=null;try{pa=await preflight(normReq(n),{agentId,intentId:a.intentId,repeatKey:a.repeatKey});}catch{}const tierCap=(pa?.reasons??[]).filter(x=>ONCHAIN_TIER.test(x));
      if(!tierCap.length)return out;let po=null;try{po=await preflight(normReq(n),{agentId:'owner',intentId:a.intentId,repeatKey:a.repeatKey});}catch{}
      const hard=(po?.reasons??[]).find(x=>WALLET_HARD.test(x));if(hard)return {...out,overWallet:true,walletReason:hard};return {...out,overWallet:false,overAuto:true,onchainTierCap:true,why:tierCap};}
    let po=null;try{po=await preflight(normReq(n),{agentId:'owner',intentId:a.intentId,repeatKey:a.repeatKey});}catch{}
    const hard=(po?.reasons??[]).find(x=>WALLET_HARD.test(x));if(hard)return {...out,overWallet:true,walletReason:hard};
    const why=[];{const ed=everydayGate(n.amount);if(ed&&/^EVERYDAY_(SINGLE|DAILY|TERM)_LIMIT/.test(String(ed.reason)))why.push(ed.reason);}
    {const ac=MD.agentCheck(agentId,n.amount);if(ac&&/_CAP$/.test(String(ac.reason)))why.push(ac.reason);}
    {const mm=MD.match({purpose:purposeKey(a.purpose)??undefined,payee:n.payee,amount:n.amount,agentId});if(mm.why&&/^over_/.test(mm.why))why.push(mm.why);}
    {let pa=null;try{pa=await preflight(normReq(n),{agentId,intentId:a.intentId,repeatKey:a.repeatKey});}catch{}for(const x of (pa?.reasons??[]))if(/^over_(stranger|unrecognized|verified|trusted|merchant)/.test(x))why.push(x);}
    return {...out,overWallet:false,overAuto:why.length>0,why};}
  /** the owner's on-chain approval for exactly this request (same identity the payment will use) */
  async function ownerAskApproval(spec,{windowSec=600}={}){const z=await askN(spec);if(!z)return {ok:false,code:'not_direct'};const {n}=z;const a=spec.args??{};
    let id;try{id=identity(n,{repeatKey:a.repeatKey,intentId:a.intentId});}catch{return {ok:false,code:'purchase_ref_required'};}
    const cnow=await chainNow();const deadline=BigInt(cnow+Math.min(900,Math.max(120,windowSec)));
    const {typedData,digest}=approvalTypedData(ownerCtx,{account:p.account,purchaseKey:id.purchaseKey,payee:n.payee,amount:n.amount,deadline});
    return {ok:true,purchaseKey:id.ledgerKey,onchainPurchaseKey:id.purchaseKey,payee:getAddress(lc(n.payee)),amount:n.amount,fee:feeFor(n.amount,await fee()),maxNetworkFee:B('maxNetworkFee'),deadline,typedData,digest};}
  /** server-side execution after the owner's tap + Face ID (only the launcher calls this). Derived idempotency key; same request identity. */
  async function payApprovedByOwner(spec,{agentId,idempotencyKey,ownerApproval}){const q=await askRequest(spec);if(!q)return {state:'rejected',reason:'owner_ask_not_direct',nothingPaid:true};
    const {payment,merchant,orderRef,expiresAt,ownerApproval:_ignored,idempotencyKey:_k,parsedId:_p,request:_r,fallbackOrderId:_f,...rest}=spec.args??{};
    const r=await pay({...rest,agentId,request:q.request,fallbackOrderId:q.fallbackOrderId,idempotencyKey,ownerApproval,[OWNER_OK]:true});
    if(r?.purchaseKey&&merchant&&merchant!=='owner-withdrawal')try{ledger.setLabel(r.purchaseKey,merchant);}catch{}return r;}
  /* t1264: an ask the server was paying when it stopped (or whose payment outcome was unknown) is settled from the ledger row of its derived
     key ownerKey(id): paid -> paid; failed without a tx -> failed (nothing paid); submitted -> reconciled from the chain, else stays executing
     with result {state:'unknown'} (never "failed", the AI must not start it again). No ledger row and no answer after STALE ms -> the payment
     never started: failed, nothing paid. */
  const ASK_STALE_MS=Number(cfg.reconcile?.askStaleMs??10*60e3);
  async function reconcileOwnerAsk(approvalId){const a=ASK.get(approvalId);if(!a||a.state!=='executing')return a;
    const idk='owner-ask:'+String(a.approvalId);let key=null,resp=null;
    try{const ir=ledger.db.prepare(`SELECT purchase_key,response FROM idempotency WHERE idem_key=?`).get(idk);if(ir){key=ir.purchase_key??null;try{resp=ir.response?JSON.parse(ir.response):null;}catch{resp=null;}}}catch{}
    if(!key){try{const z=await askN(a.spec);if(z)key=identity(z.n,{repeatKey:a.spec?.args?.repeatKey,intentId:a.spec?.args?.intentId}).ledgerKey;}catch{key=null;}}
    if(key&&inflight.has(key))return a;
    if(key){try{await reconcileSubmitted({keys:[key]});}catch{}}
    const prev=a.result??{};const keep={...(prev.trust!==undefined?{trust:prev.trust}:{})};
    const v=key?settledView(key):null;
    if(v?.state==='paid')return ASK.finish(a.approvalId,'paid',{...keep,state:'paid',reason:null,purchaseKey:key,txHash:v.txHash??null,nothingPaid:false,reconciled:true});
    if(v?.state==='failed'&&v.nothingPaid)return ASK.finish(a.approvalId,'failed',{...keep,state:'failed',reason:v.reason??'payment_failed',purchaseKey:key,txHash:null,nothingPaid:true,reconciled:true});
    if(v?.state==='unknown'||v?.state==='prepared_unconfirmed'||(v?.state==='failed'&&!v.nothingPaid))return ASK.note(a.approvalId,{...prev,state:'unknown',purchaseKey:key,txHash:v.txHash??null,nothingPaid:false});
    /* no purchase row: the answer that was stored, or nothing started */
    if(resp&&['rejected','retry_later'].includes(resp.state)&&resp.nothingPaid!==false&&!resp.txHash)return ASK.finish(a.approvalId,'failed',{...keep,state:resp.state,reason:resp.reason??'payment_failed',purchaseKey:key,txHash:null,nothingPaid:true,reconciled:true});
    const row=key?ledger.get(key):null;
    if(!row&&!resp&&Date.now()-Number(a.decidedAt??0)>ASK_STALE_MS){try{ledger.db.prepare(`DELETE FROM idempotency WHERE idem_key=? AND response IS NULL`).run(idk);}catch{}
      return ASK.finish(a.approvalId,'failed',{...keep,state:'failed',reason:'interrupted_before_payment',purchaseKey:key,txHash:null,nothingPaid:true,reconciled:true});}
    return a;}
  async function reconcileOwnerAsks(){const out=[];for(const a of ASK.executing()){try{const b=await reconcileOwnerAsk(a.approvalId);out.push({id:a.approvalId,state:b?.state??null,result:b?.result?.state??null});}catch{out.push({id:a.approvalId,state:'error'});}}return out;}
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
    reconcileSubmitted().catch(()=>{});/* t1264: status reads settle sends whose outcome was lost (non-blocking) */
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
  /* t1281: fee + networkFee per row (atomic strings), the same formula as every limit sum (spend-cost.mjs); the app adds them the same way */
  const listPurchases=(q={})=>{const cp=costParams();return ledger.listFiltered(q).map(r=>{const c=costParts(r,cp);return {purchaseKey:r.purchase_key,state:r.state,standard:r.standard,payee:r.payee,amount:r.amount,fee:c.fee.toString(),networkFee:c.networkFee.toString(),ref:r.ref,agent:r.origin_agent??r.claimed_by,merchant:r.merchant_id,label:r.label??null,tier:r.tier,txHash:r.tx_hash,createdAt:r.created_at,order:orderFor(r.purchase_key)};});};
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
  /* t1241 §6#111: layered trust controls for the launcher / app (owner side only; never an AI tool) */
  const layeredTrust={enabled:LAY,pauseDomain,resumeDomain,checkConfirm,
    pausedDomains:()=>{try{return ledger.db.prepare(`SELECT domain,paused_at AS pausedAt,reason FROM layered_domain WHERE paused_at IS NOT NULL`).all();}catch{return [];}},
    payments:(domain)=>{try{return ledger.db.prepare(`SELECT purchase_key AS purchaseKey,domain,amount,created_at AS createdAt,merchant_signed AS merchantSigned,state,merchant_status AS merchantStatus FROM layered_pay WHERE (? IS NULL OR domain=?) ORDER BY created_at DESC LIMIT 50`).all(domain??null,domain??null);}catch{return [];}}};
  /* t1243 §6#113: run fn holding this wallet's one-in-flight-tx lock (the background trust of an approved ask), so an AI payment meanwhile
     is told retry_later (nothing sent) instead of racing the vault's userOp nonce. Waits for a running payment; after waitMs it runs anyway
     (the on-chain nonce still makes every op one-time, 0A#7 layer 5). */
  async function withWalletTx(fn,{waitMs=60000,pollMs=200}={}){const t0=Date.now();let rel=txLock.try(p.account);
    while(!rel&&Date.now()-t0<waitMs){await new Promise(r=>setTimeout(r,pollMs));rel=txLock.try(p.account);}
    try{return await fn();}finally{rel?.();}}
  /* t1264: on start (non-blocking): settle sends whose outcome was lost and asks left executing by a restart */
  if(cfg.reconcileOnStart!==false){const t=setTimeout(()=>{reconcileSubmitted().then(()=>reconcileOwnerAsks()).catch(()=>{});},Number(cfg.reconcileOnStartMs??1000));t.unref?.();}
  /** t1264: does this payee route as owner-trusted right now (stored trust on chain, or a live inline KPTR trust)? For the owner-ask trust reconcile. */
  const payeeTrustState=async payee=>{const r=await route({mode:'direct',payee:getAddress(lc(payee))},await chainNow());return {trusted:r.tier==='trusted'&&!r.reason,inline:!!r.inline,merchant:r.merchant??null,tier:r.tier};};
  return {version:5,reconcileSubmitted,openReservations,purchaseForAI,payeeTrustState,reconcileOwnerAsks,reconcileOwnerAsk,purchaseState:settledView,withWalletTx,layeredTrust,sanctions:SC,mandates:MD,ownerAsks:ASK,repushProposal:v=>{try{cfg.onMandateProposal?.(v);}catch{}},ownerAskClass,ownerAskApproval,payApprovedByOwner,logObs:(k,v)=>{try{cfg.obs?.log?.(k,v);}catch{}},merchantStatus,setOrderExtra,isPaused:()=>isPaused(),ledgerPath:ledgerFile,orderFor,orderForTx,listHolds,cancelHold,releaseHold,spendingSummary,agentSafetyPause,addressBook,resolvePayeeName,nameOf,setPayeeName:(a,n)=>setName(a,n,'owner',true),pendingHoldsDue:()=>{try{return ledger.db.prepare(`SELECT count(*) AS n FROM payment_hold WHERE state='pending'`).get().n;}catch{return 0;}},guardrails:()=>({trialSingle:GUARD.trialSingle.toString(),trialDaily:GUARD.trialDaily.toString(),evidenceThreshold:GUARD.evidenceThreshold.toString(),trialUsed24h:trialSpent24h().toString()}),verifyPayee,requestTrustFromOwner,trustRequestStatus,requestRefund,disputes,cardCreate,cards,cardSimulate,idle,status,limits,parse,preflight,pay,payAny,payMerchantOrder,setup,setLimits,proposeTrust,trustList,depositInfo:depositInfoFn,deposits:depositsList,requestWithdrawal,executeWithdrawal,discoverMerchant:discover,parseAny,paidFetch,payNormalized,settleRoutine,markSettledOne,reclaimExpired:settleRoutine,
    exportCsv:(o={})=>toCsv(ledger.db,{tz:cfg.timeZone??'America/Chicago',...o,chainId:cfg.chainId,token:cfg.token}),
    receipt:(key,o={})=>taxReceipt(ledger.db,key,{tz:cfg.timeZone??'America/Chicago',...o,chainId:cfg.chainId,token:cfg.token,payer:p.account}),
    annualSummary:(year,o={})=>annualSummary(ledger.db,year??new Date().getFullYear(),{tz:cfg.timeZone??'America/Chicago',...o,chainId:cfg.chainId,token:cfg.token}),
    exitPlan,recordGasSettlement,collectFees,floatFund:async o=>{/* t1278 S10: nothing is funded while AI payments are paused (owner stop / anomaly) */if(isPaused())return {state:'rejected',reason:'wallet_paused_for_safety',nothingPaid:true,fix:'AI payments are paused; only the owner can resume them in the Kipurse app (Face ID).'};
      /* t621 #8: funding the float is checked against the everyday 24h limit */const ev=(()=>{try{return cfg.everydayGet?.()??null;}catch{return 'err';}})();
      if(ev==='err')return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true};
      if(ev&&(ev.authorized===false||ev.daily==null||ev.term==null))return {state:'rejected',reason:'AI_LIMITS_UNCONFIRMED',nothingPaid:true};
      if(ev){let amt;try{amt=o?.amount!==undefined?BigInt(o.amount):BigInt(await rd('floatCap',[p.account]));}catch{return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true};}
        const spentTerm=spentCumulative();if(spentTerm==null)return {state:'rejected',reason:'EVERYDAY_CHECK_FAILED',nothingPaid:true};
        await warmFee();const amtCost=costIn(amt);/* t1281: the float takes amount + its fee reserve (network fee: counted in the ledger reservation) */
        if(spentTerm+amtCost>BigInt(ev.term))return capHit({state:'rejected',reason:'EVERYDAY_TERM_LIMIT',nothingPaid:true,capHit:true,limit:ev.term,fix:'Funding the float would exceed the explicit AI total. Nothing was funded.',say_to_user:'没有充入小额池：这会超过你设的 AI 总额。/ Not funded: it would go over the total you set.'});
        if(everydaySpent()+amtCost>BigInt(ev.daily))return capHit({state:'rejected',reason:'EVERYDAY_DAILY_LIMIT',nothingPaid:true,capHit:true,limit:ev.daily,fix:'Funding the micropayment float would go over the owner’s everyday 24h limit (the float counts as spent). Nothing was funded.',say_to_user:'没有充入小额池：这会超过你设的日常额度（小额池里的钱算作已花）。/ Not funded: it would go over your everyday limit (the float counts as spent).'});}
      return float.fund(o);},floatReconcile:()=>float.reconcile(),floatStatus:()=>float.status(),gasBook:gas,resetAgentFailures:a=>gas.resetFailures(a),trustRequest,trustSubmit,untrustRequest,untrustSubmit,denySignerRequest,denySignerSubmit,approvalRequest,pause,claimPurchase,merchantInfo,listPurchases,ledger,client:c,permission:p,policy:P};
}
