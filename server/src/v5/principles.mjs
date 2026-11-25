// ============================================================================================================
// KIPURSE PRINCIPLES: the single source of truth for fee and safety rules.
// DO NOT CHANGE without a dated owner decision in the owner's decision log (kipurse-onboard-e2e). The server refuses to
// boot if config/env contradicts these (assertPrinciples), and test/principles.test.mjs fails on any change.
// Owner decisions: fees 2026-10-17/26 (t549, t550), honesty and Onramp 2026-10-27 (t565/t566), hardening 2026-10-27 (t572).
// ============================================================================================================
export const PRINCIPLES=Object.freeze({
  payerFeeBps:10,            // 0.1%, paid by the payer; merchant pays 0
  payerFeePpm:1000n,
  payerFeeCapBps:30,         // contract hard max 0.3%
  payerFeeMaxPpm:3000n,
  payerFeeMinAtomic:0n,      // no minimum fee
  payerFeeMaxAtomic:null,    // no per-payment upper cap
  gasMarginBps:0,            // network fee = actual cost in USDC, no markup
  phoneUpgradeMarginPct:0n,  // phone-key upgrade: actual cost
  phoneUpgradeMinAtomic:0n,  //   and no minimum
  sponsorship:'none', onboardBy:'deposit', fronting:false, newDues:false, oldDuesCollectedOn:'withdraw_only', // t1008/t1014: Kipurse pays nothing; no new dues; old recorded dues only on withdraw; never ETH
  // t763 (legacy wallets only): old dues for onboarding gas are collected from the wallet's first outgoing batch. Since t1022 the user pays
  // the opening fee in USDC in the same confirmation and Kipurse fronts nothing (fronting:false below)
  trustExpiry:0n,            // trust never expires (0 = no expiry, max deadline)
  siriConnect:'free_server_auth',
  onrampDestination:'user_wallet_only',
  arrivedRequiresOnchainTx:true,
  holdAboveAtomic:500_000_000n, // 500 USDC hold
  holdAppliesTo:'non_trusted_payees_only',
  gasToken:'USDC',           // t604 (2026-10-27 15:36 CT, locked): gas and fees ALWAYS in USDC, never ETH, for every user-facing on-chain action
  ethGasPath:false,          //   no transaction path may be funded with the user's ETH (only USDC or the onboarding sponsorship)
  everydayBelowFloor:true,   // t609: everyday limits (server, owner Face ID, free) are NEVER above the on-chain floor
  firstLimitsFree:false,     // t763 (supersedes t603): the first AI-limit authorization is paid from the wallet like every later change
  // t762/t763 (2026-10-29, locked, owner): opening needs the Coinbase Verified Account attestation (deposit history never counts);
  // deposit and withdraw only to/from that verified owner; the user pays every fee (deposit gas, withdraw gas, failed-op gas,
  // 0.1% transaction fee to Kipurse); Kipurse never bears net cost and fronts nothing (t1022: the user pays opening gas in USDC in the same confirmation).
  kycAttestationRequired:true, depositHistoryCountsAsKyc:false, kipurseNetCost:0, failedGasPaidBy:'user', withdrawFeeAtLeastRealCost:true,
  // t787 [zh]: no pooled wallet; every outflow signed by the owner; server holds only small powers; the app checks
  // every signature against a pinned sign page; small ops reserve; keys separated; emergency brake; external audit before real users.
  noPooledCustody:true, ownerSignsEveryOutflow:true, withdrawOnlyToVerifiedOwner:true, signPagePinRequired:true,
  sponsorCaps:Object.freeze({maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25}), externalAuditBeforeRealUsers:true,
});
const bad=(k,why)=>{throw Object.assign(Error(`PRINCIPLE_VIOLATION ${k}: ${why}. Change needs an owner decision in the owner's decision log`),{code:'principle_violation',principle:k});};
/** Throws if config, env or loaded module constants contradict PRINCIPLES. Call at startup (before listening). */
export async function assertPrinciples({cfg={},env=process.env,feePpmOnChain}={}){
  {const {clampEveryday}=await import('./everyday-limits.mjs');const c=clampEveryday({single:10n**12n,daily:10n**12n},{single:5n,daily:7n});if(c.single!==5n||c.daily!==7n)throw new Error('PRINCIPLE VIOLATION: everyday limits must never exceed the on-chain floor');}
  const P=PRINCIPLES;
  const m=env.KIPURSE_GAS_MARGIN_BPS;if(m!==undefined&&Number(m)!==P.gasMarginBps)bad('gasMarginBps','KIPURSE_GAS_MARGIN_BPS='+m);
  const gm=cfg?.gasPricing?.marginBps;if(gm!==undefined&&Number(gm)!==P.gasMarginBps)bad('gasMarginBps','config gasPricing.marginBps='+gm);
  const fp=cfg?.fee?.ppm;if(fp!==undefined&&BigInt(fp)!==P.payerFeePpm)bad('payerFee','config fee.ppm='+fp);
  if(feePpmOnChain!==undefined&&BigInt(feePpmOnChain)!==P.payerFeePpm)bad('payerFee','on-chain feePpm='+feePpmOnChain);
  const mf=cfg?.maxFeePpm;if(mf!==undefined&&BigInt(mf)>P.payerFeeMaxPpm)bad('payerFeeCap','config maxFeePpm='+mf);
  const abi=await import('./abi.mjs');if(abi.MAX_FEE_PPM!==P.payerFeeMaxPpm)bad('payerFeeCap','abi MAX_FEE_PPM');
  const q=abi.quoteNetworkFee({gasUnits:100000n,gasPriceWei:10n**9n,usdcPerEth:3000_000000n});if(q!==300000n)bad('gasMarginBps','quoteNetworkFee default adds a markup');
  const ps=await import('./phone-signer.mjs');
  if(ps.FEE_MARGIN_PCT!==P.phoneUpgradeMarginPct)bad('phoneUpgradeMargin','FEE_MARGIN_PCT='+ps.FEE_MARGIN_PCT);
  if(ps.FEE_MIN!==P.phoneUpgradeMinAtomic)bad('phoneUpgradeMin','FEE_MIN='+ps.FEE_MIN);
  const g=await import('./guardrails.mjs');if(g.TIER_LIMITS.holdAbove!==P.holdAboveAtomic)bad('hold','TIER_LIMITS.holdAbove');
  for(const k of ['KIPURSE_ONRAMP_DESTINATION','KIPURSE_ONRAMP_DEST_OVERRIDE'])if(env[k])bad('onrampDestination',k+' set');
  if(env.KIPURSE_SPONSOR_ALL||env.KIPURSE_SPONSOR_PAYMENTS)bad('sponsorship','payment sponsorship env set');
  if(env.KIPURSE_TRUST_EXPIRY_SEC&&Number(env.KIPURSE_TRUST_EXPIRY_SEC)!==0)bad('trustExpiry','KIPURSE_TRUST_EXPIRY_SEC');
  if(env.KIPURSE_SIRI_FEE&&Number(env.KIPURSE_SIRI_FEE)!==0)bad('siriConnect','KIPURSE_SIRI_FEE');
  // t604: USDC-only gas
  if(env.KIPURSE_GAS_TOKEN&&String(env.KIPURSE_GAS_TOKEN).toUpperCase()!==P.gasToken)bad('gasToken','KIPURSE_GAS_TOKEN='+env.KIPURSE_GAS_TOKEN);
  if(env.KIPURSE_ALLOW_ETH_GAS)bad('ethGasPath','KIPURSE_ALLOW_ETH_GAS set');
  const gt=cfg?.gasPricing?.token;if(gt!==undefined&&String(gt).toUpperCase()!==P.gasToken)bad('gasToken','config gasPricing.token='+gt);
  const lp=await import('./limits-public.mjs');
  if(lp.gasRoute({pm:null,fee:{canPayUSDC:false}}).route!==null||lp.gasRoute({pm:null,fee:null}).route!==null)bad('ethGasPath','limits page would hand out an unfunded (ETH) batch');
  if(lp.gasRoute({pm:'x'}).route!=='sponsored'||lp.gasRoute({pm:null,fee:{canPayUSDC:true}}).route!=='usdc')bad('gasToken','limits gas routes');
  const lf=await import('./limits-fee.mjs');const fq=lf.limitsChangeFee({callGas:100000n,gasPriceWei:10n**7n,ethUsd8:3000_00000000n,payerUSDC:0n});
  if(fq.token!==P.gasToken||fq.canPayUSDC!==false)bad('gasToken','limits fee quote');
  const os=await import('./onboard-sponsor.mjs');if(typeof os.createOnboardSponsor!=='function'||!os.FIRST_LIMITS_PREFIX)bad('firstLimitsFree','sponsor module');
  // t763 locked rules: refuse to boot if any is contradicted
  if(P.firstLimitsFree!==false)bad('firstLimitsFree','first limits must be paid by the wallet');
  if(!P.kycAttestationRequired||P.depositHistoryCountsAsKyc!==false)bad('kyc','Coinbase Verified Account attestation required; deposit history never counts');
  if(env.KIPURSE_REQUIRE_CBV==='0'&&Number(cfg?.chainId??8453)===8453)bad('kyc','KIPURSE_REQUIRE_CBV=0 on mainnet');
  if(P.kipurseNetCost!==0||P.failedGasPaidBy!=='user')bad('kipurseNetCost','Kipurse never bears net cost');
  {const ow=await import('./owner-withdraw.mjs');if(!(ow.WITHDRAW_REAL_GAS>=250_000n)||!(ow.WITHDRAW_PRICE_HEADROOM_PCT>=110n)||ow.WITHDRAW_MAX_WALLET_FEE>250_000n)bad('withdrawFee','withdraw fee must cover the real cost');
   const sp=await import('./onboard-sponsor.mjs');if(sp.WITHDRAW_REAL_GAS!==ow.WITHDRAW_REAL_GAS)bad('withdrawFee','sponsor and withdraw gas constants differ');}
  // t787 locked (machine-checkable part)
  if(!P.noPooledCustody||!P.ownerSignsEveryOutflow||!P.withdrawOnlyToVerifiedOwner||!P.signPagePinRequired||!P.externalAuditBeforeRealUsers)bad('t787','security iron rules');
  for(const k of ['KIPURSE_POOLED_CUSTODY','KIPURSE_CUSTODY','KIPURSE_OMNIBUS','KIPURSE_WITHDRAW_TO','KIPURSE_WITHDRAW_DEST_OVERRIDE','KIPURSE_SKIP_SIGN_PIN'])if(env[k])bad('t787',k+' set');
  for(const [k,c] of [['KIPURSE_SPONSOR_MAX_PER_DAY','maxPerDay'],['KIPURSE_SPONSOR_MAX_USD_PER_DAY','maxUsdPerDay'],['KIPURSE_SPONSOR_MAX_USD_PER_OP','maxUsdPerOp']])
    if(env[k]!==undefined&&!(Number(env[k])<=P.sponsorCaps[c]))bad('t787 caps',k+'='+env[k]+' above the locked cap');
  if(String(env.KIPURSE_ONBOARD_SPONSOR??'off').trim().toLowerCase()!=='off')bad('sponsorship','KIPURSE_ONBOARD_SPONSOR must be off (t1008)');
  if(P.sponsorship!=='none'||P.fronting!==false||P.newDues!==false)bad('sponsorship','Kipurse pays nothing (t1008)');
  return true;
}
