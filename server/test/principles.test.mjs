// Fails if any owner principle changes. Changing these needs a dated owner decision in OWNER_HANDBOOK.md.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {PRINCIPLES,assertPrinciples} from '../src/v5/principles.mjs';
import {quoteNetworkFee,MAX_FEE_PPM} from '../src/v5/abi.mjs';import {upgradeFeeUSDC,FEE_MARGIN_PCT,FEE_MIN} from '../src/v5/phone-signer.mjs';import {TIER_LIMITS} from '../src/v5/guardrails.mjs';
test('principle values are exactly the owner decisions',()=>{
  assert.ok(Object.isFrozen(PRINCIPLES));
  assert.deepEqual({...PRINCIPLES},{payerFeeBps:10,payerFeePpm:1000n,payerFeeCapBps:30,payerFeeMaxPpm:3000n,payerFeeMinAtomic:0n,payerFeeMaxAtomic:null,gasMarginBps:0,phoneUpgradeMarginPct:0n,phoneUpgradeMinAtomic:0n,
    sponsorship:'onboarding_fronted_recouped',trustExpiry:0n,siriConnect:'free_server_auth',onrampDestination:'user_wallet_only',arrivedRequiresOnchainTx:true,holdAboveAtomic:500_000_000n,holdAppliesTo:'non_trusted_payees_only',gasToken:'USDC',ethGasPath:false,everydayBelowFloor:true,firstLimitsFree:false,
    kycAttestationRequired:true,depositHistoryCountsAsKyc:false,kipurseNetCost:0,failedGasPaidBy:'user',withdrawFeeAtLeastRealCost:true,noPooledCustody:true,ownerSignsEveryOutflow:true,withdrawOnlyToVerifiedOwner:true,signPagePinRequired:true,sponsorCaps:{maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25},externalAuditBeforeRealUsers:true});
  assert.throws(()=>{'use strict';PRINCIPLES.gasMarginBps=2000;});
});
test('code constants match principles',async()=>{
  assert.equal(MAX_FEE_PPM,3000n);assert.equal(FEE_MARGIN_PCT,0n);assert.equal(FEE_MIN,0n);assert.equal(TIER_LIMITS.holdAbove,500_000_000n);
  assert.equal(quoteNetworkFee({gasUnits:100000n,gasPriceWei:10n**9n,usdcPerEth:3000_000000n}),300000n,'network fee = actual cost, no markup');
  const u=upgradeFeeUSDC({gasPriceWei:100_000n,ethUsd8:3000_00000000n});assert.equal(u.fee,u.raw,'upgrade: no minimum clamp at low gas');
  assert.ok(u.fee<5000n,'no 0.005 minimum');
  assert.equal(await assertPrinciples({env:{}}),true);
});
test('boot refuses contradicting config/env',async()=>{
  for(const [o,re] of [[{env:{KIPURSE_GAS_MARGIN_BPS:'2000'}},/gasMarginBps/],[{env:{},cfg:{gasPricing:{marginBps:2000}}},/gasMarginBps/],[{env:{},cfg:{fee:{ppm:'2000'}}},/payerFee/],
    [{env:{},cfg:{maxFeePpm:'5000'}},/payerFeeCap/],[{env:{},feePpmOnChain:1500n},/payerFee/],[{env:{KIPURSE_ONRAMP_DESTINATION:'0xabc'}},/onramp/],[{env:{KIPURSE_SPONSOR_PAYMENTS:'1'}},/sponsorship/],
    [{env:{KIPURSE_TRUST_EXPIRY_SEC:'86400'}},/trustExpiry/],[{env:{KIPURSE_SIRI_FEE:'1'}},/siri/]])
    await assert.rejects(assertPrinciples(o),re);
  assert.equal(await assertPrinciples({env:{KIPURSE_GAS_MARGIN_BPS:'0'},cfg:{gasPricing:{marginBps:0},fee:{ppm:'1000'},maxFeePpm:'3000'},feePpmOnChain:1000n}),true);
});
test('wiring: launcher asserts at boot; kit config has zero margin; texts say actual cost',()=>{
  const L=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');assert.match(L,/assertPrinciples\(/);
  const K=fs.readFileSync(new URL('../kit/server.mjs',import.meta.url),'utf8');assert.match(K,/marginBps:0\b/);assert.doesNotMatch(K,/marginBps:[1-9]/);
  const M=fs.readFileSync(new URL('../src/v5/mcp.mjs',import.meta.url),'utf8');assert.doesNotMatch(M,/\+ margin/);
  const E=fs.readFileSync(new URL('../src/v5/engine.mjs',import.meta.url),'utf8');assert.doesNotMatch(E,/marginBps\?\?[1-9]/);
  const O=fs.readFileSync(new URL('../src/v5/onramp.mjs',import.meta.url),'utf8');assert.match(O,/destinationAddress/);
});
// t787u iron rules: pooled custody / withdraw redirect / skipping the sign-page pin / raised sponsor caps refuse to boot
test('t787 security iron rules are locked',async()=>{const {assertPrinciples,PRINCIPLES:P}=await import('../src/v5/principles.mjs');
  assert.equal(P.noPooledCustody,true);assert.equal(P.withdrawOnlyToVerifiedOwner,true);assert.equal(P.signPagePinRequired,true);assert.deepEqual({...P.sponsorCaps},{maxPerDay:20,maxUsdPerDay:2,maxUsdPerOp:0.25});
  assert.ok(Object.isFrozen(P)&&Object.isFrozen(P.sponsorCaps));
  for(const env of [{KIPURSE_POOLED_CUSTODY:'1'},{KIPURSE_WITHDRAW_TO:'0x1'},{KIPURSE_SKIP_SIGN_PIN:'1'},{KIPURSE_SPONSOR_MAX_PER_DAY:'21'},{KIPURSE_SPONSOR_MAX_USD_PER_DAY:'3'},{KIPURSE_SPONSOR_MAX_USD_PER_OP:'0.5'}])
    await assert.rejects(assertPrinciples({env}),e=>e.code==='principle_violation',JSON.stringify(env));
  assert.equal(await assertPrinciples({env:{KIPURSE_SPONSOR_MAX_PER_DAY:'20',KIPURSE_SPONSOR_MAX_USD_PER_OP:'0.25'}}),true);});
