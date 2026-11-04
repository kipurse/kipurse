// SPDX-License-Identifier: Apache-2.0
// V5 owner plans (PLAN ONLY: builds calldata, never signs or broadcasts).
//  - migration: ONE atomic owner batch (wallet.executeBatch / wallet_sendCalls): revoke old permission(s) -> approve the V5
//    permission (caps with fee headroom) -> owner trust for named merchants [-> optional registry opt-out].
//  - exit: what the owner runs with our service completely down: pause, revoke, cancel open reservations, sweep the vault.
import {encodeFunctionData,getAddress,toHex,parseAbi} from 'viem';
import {v5Abi,ZERO,encodePolicyV5,decodePolicyV5,permissionFromJson,permissionToJson,spendPermissionHash,withFeeHeadroom} from './abi.mjs';
import {merchantIdBytes} from './ref.mjs';
export const SPM_BASE='0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const call=(to,fn,args)=>({to:getAddress(to),value:0n,data:encodeFunctionData({abi:v5Abi,functionName:fn,args})});
const usd=a=>`${(Number(a)/1e6).toFixed(6).replace(/0+$/,'').replace(/\.$/,'')} USDC`;
const MAX_TERM=365*86400,DAY=86400;
/** Use-case presets (owner decision 2026-10-17: Conservative / Standard / Generous), merchant-amount caps in atomic USDC.
 *  Per-payment caps count the amount only; daily / term caps count amount + fees (headroom added by the plan).
 *  Conservative = optimization plan "trial" row; Generous = "purchasing" row; Standard is in between [assumption, owner may tune]. */
// EXAMPLES ONLY (2026-10-20 owner rule): never auto-applied. A plan uses a preset only with acceptExamplePreset:true; owner-facing
// flows (kipurse_setup) require every number to be chosen by the human.
export const PRESETS={
  conservative:{single:5_000_000,daily:10_000_000,term:50_000_000,openSingle:100_000,openDaily:1_000_000,verifiedSingle:5_000_000,verifiedDaily:10_000_000,maxNetworkFee:50_000,floatCap:5_000_000,days:90},
  standard:{single:10_000_000,daily:20_000_000,term:200_000_000,openSingle:100_000,openDaily:1_000_000,verifiedSingle:5_000_000,verifiedDaily:10_000_000,maxNetworkFee:50_000,floatCap:5_000_000,days:90},
  generous:{single:50_000_000,daily:100_000_000,term:1_000_000_000,openSingle:100_000,openDaily:1_000_000,verifiedSingle:20_000_000,verifiedDaily:50_000_000,maxNetworkFee:100_000,floatCap:5_000_000,days:180},
};
export const presetStated=name=>{const x=PRESETS[name];if(!x)throw Error('PLAN: unknown preset '+name);const {days,maxNetworkFee,floatCap,...caps}=x;return {stated:Object.fromEntries(Object.entries(caps).map(([k,v])=>[k,String(v)])),maxNetworkFee:String(maxNetworkFee),floatCap:String(floatCap),days};};
/** Policy as the adapter checks it (_policy). Throws on a policy the adapter would reject. */
export function validatePolicy(pol,{feePpm}){
  const B=k=>BigInt(pol[k]??0);const e=m=>{throw Error('POLICY: '+m);};
  if(!pol.executor||getAddress(pol.executor)===ZERO)e('executor');
  if(B('term')===0n)e('term = 0 (no term cap) is not allowed');
  if(B('daily')===0n||B('single')===0n||B('single')>B('daily')||B('daily')>B('term'))e('single <= daily <= term');
  if(B('openSingle')>B('single')||B('openDaily')>B('daily'))e('stranger caps must fit permission caps');
  if(B('verifiedSingle')>B('single')||B('verifiedDaily')>B('daily'))e('registry caps must fit permission caps');
  if(B('maxFeePpm')>3000n)e('maxFeePpm above the 0.3% contract hard max');
  if(BigInt(feePpm)>B('maxFeePpm'))e('adapter fee rate above the owner-accepted rate');
  if(B('maxNetworkFee')===0n)e('maxNetworkFee (owner gas cap per payment) is required: users bear all gas');
  return true;
}
/** stated: caps in MERCHANT amounts (what the owner reads in the UI). Per-payment caps stay as stated (they count the amount);
 *  daily / term caps get protocol-fee headroom (network fees also count there and are shown in every preflight total). */
export function capsWithHeadroom(stated,ppm){const o={};for(const k of ['single','openSingle','verifiedSingle'])o[k]=String(stated[k]??0);
  for(const k of ['daily','term','openDaily','verifiedDaily'])o[k]=withFeeHeadroom(stated[k]??0,ppm).toString();return o;}

export function buildMigrationPlanV5(o0){let o=o0;
  const chainId=o.chainId,manager=getAddress(o.manager??SPM_BASE),adapter=getAddress(o.adapter),trustC=getAddress(o.trust??o.adapter),token=getAddress(o.token),wallet=getAddress(o.wallet);
  const feePpm=BigInt(o.fee.ppm);if(o.preset&&o.acceptExamplePreset!==true)throw Error('PLAN: presets are examples only; pass explicit owner-chosen values (or acceptExamplePreset:true for tests)');
  if(o.preset){const ps=presetStated(o.preset);o={...o,stated:{...ps.stated,...(o.stated??{})},maxNetworkFee:o.maxNetworkFee??ps.maxNetworkFee,floatCap:o.floatCap??ps.floatCap,end:o.end??Number(o.start)+ps.days*DAY};}
  const caps=o.headroom===false?Object.fromEntries(Object.entries(o.stated).map(([k,v])=>[k,String(v)])):capsWithHeadroom(o.stated,feePpm);
  const policy={executor:getAddress(o.executor),guardian:getAddress(o.guardian??ZERO),...caps,registry:getAddress(o.registry??ZERO),
    maxFeePpm:String(o.maxFeePpm??feePpm),maxNetworkFee:String(o.maxNetworkFee??(()=>{throw Error('PLAN: maxNetworkFee must be chosen explicitly');})())};
  validatePolicy(policy,{feePpm});
  if(BigInt(policy.term)===0n)throw Error('PLAN: a migration permission needs a finite term (allowance = term)');
  const start=Number(o.start),end=Number(o.end);if(!(end>start&&end-start<=MAX_TERM))throw Error('PLAN: 0 < term <= 365 days');
  // SPM allowance = the real term cap (never max uint): a second, independent on-chain limit.
  const permission={account:wallet,spender:adapter,token,allowance:BigInt(policy.term),period:end-start,start,end,salt:BigInt(o.salt??0),extraData:encodePolicyV5(policy)};
  const calls=[],labels=[];
  for(const old of o.revoke??[]){const q=permissionFromJson(old);calls.push(call(manager,'revoke',[q]));labels.push(`revoke old permission (spender ${q.spender}, salt ${q.salt})`);}
  calls.push(call(manager,'approve',[permission]));labels.push('approve V5 permission');
  const trusts=[];
  for(const t of o.trusts??[]){
    const name=String(t.merchantId).trim().toLowerCase();const exp=BigInt(t.expiry??(start+(t.days??90)*DAY));
    if(!(exp>BigInt(start)&&exp<=BigInt(start+365*DAY)))throw Error('PLAN: trust expiry must be within 365 days (never permanent) for '+name);
    const tr={merchant:merchantIdBytes(name),name,payees:t.payees.map(a=>getAddress(a)),signers:(t.signers??[]).map(a=>getAddress(a)),
      single:BigInt(t.single),daily:o.headroom===false?BigInt(t.daily??t.single):withFeeHeadroom(t.daily??t.single,feePpm),expiry:exp};
    if(tr.single>BigInt(policy.single))throw Error('PLAN: trust single above permission single for '+t.merchantId);
    calls.push(call(trustC,'setTrust',[tr]));labels.push(`trust ${tr.name}: ${usd(t.single)}/payment, ${usd(t.daily??t.single)}/day (+fee headroom), until ${new Date(Number(tr.expiry)*1000).toISOString()}`);trusts.push({merchantId:t.merchantId,...tr});
  }
  // M3 micropayment float cap (per day, owner-adjustable; 0 = off). Presets: 5 USDC.
  if(o.floatCap!==undefined&&BigInt(o.floatCap)>0n){calls.push(call(trustC,'setFloatCap',[BigInt(o.floatCap)]));labels.push(`micropayment float: up to ${usd(o.floatCap)} per day (sub-$1 x402 payments without a tx each)`);}
  // ZERO-RESERVE (design 2026-10-17): bind the session signer + per-op USDC gas cap to the owner's vault (deploys it) and seed the
  // vault's USDC gas buffer (owner money, default 0.20 USDC, refundable at exit). Same single owner signature.
  if(o.zeroReserve){calls.push(call(adapter,'registerPermission',[permission]));labels.push(`zero-reserve: make your vault the gas payer (session signer ${policy.executor}, at most ${usd(policy.maxNetworkFee)} of gas per operation)`);
    const buf=BigInt(o.zeroReserve.buffer??200000);if(buf>0n){if(!o.zeroReserve.vault)throw Error('PLAN: zeroReserve.vault (adapter.vaultAddress(wallet)) is required for the gas buffer');
      calls.push(call(token,'transfer',[getAddress(o.zeroReserve.vault),buf]));labels.push(`zero-reserve: ${usd(buf)} gas buffer into your own vault (yours, returned at exit)`);}
    const bf=o.zeroReserve.bundlerFee;if(bf){if(!o.zeroReserve.vault)throw Error('PLAN: zeroReserve.vault is required for a bundler fee');
      calls.push({to:getAddress(o.zeroReserve.vault),value:0n,data:encodeFunctionData({abi:parseAbi(['function setBundlerFee(address to,uint96 maxPerOp)']),functionName:'setBundlerFee',args:[getAddress(bf.to),BigInt(bf.maxPerOp)]})});
      labels.push(getAddress(bf.to)==='0xf14ef5dc4723245866c22c749a0a84afceba0dd9'?`account-opening fee fronted by Kipurse: ${usd(BigInt(bf.maxPerOp))} taken once with your first AI payment, to the Kipurse ops account ${getAddress(bf.to)}`:`optional bundler fee: allow at most ${usd(BigInt(bf.maxPerOp))} per operation to the bundler operator ${getAddress(bf.to)} (you pay it; off unless you set it)`);}}
  if(o.registryOptOut){calls.push(call(trustC,'setRegistryOptOut',[true]));labels.push('opt out of the Kipurse merchant registry');}
  const executeBatch=encodeFunctionData({abi:v5Abi,functionName:'executeBatch',args:[calls.map(c=>({target:c.to,value:c.value,data:c.data}))]});
  const ct=t=>new Date(t*1000).toLocaleString('en-US',{timeZone:'America/Chicago',timeZoneName:'short'});
  return JSON.parse(JSON.stringify({WARNING:'PLAN ONLY - nothing was signed or broadcast. The owner reviews and signs this batch in their own wallet.',
    chainId,wallet,owner:o.owner??null,manager,adapter,token,policy,permission:permissionToJson(permission),permissionHash:spendPermissionHash(permission,{chainId,manager}),
    feeHeadroom:{rule:'on-chain cap = stated cap + ceil(stated * feePpm / 1e6); payments whose merchant amounts sum to the stated cap always fit',feePpm:feePpm.toString(),stated:o.stated,onchain:caps},
    human:{perPayment:usd(o.stated.single),perDay:usd(o.stated.daily),total:usd(o.stated.term),stranger:`${usd(o.stated.openSingle??0)}/payment, ${usd(o.stated.openDaily??0)}/day`,
      registry:policy.registry===ZERO?'not used':`${policy.registry} (${usd(o.stated.verifiedSingle??0)}/payment, ${usd(o.stated.verifiedDaily??0)}/day)`,
      fee:`${Number(feePpm)/10000}% of each payment, paid by this wallet, no cap, no minimum; merchants pay 0 (owner accepts at most ${Number(policy.maxFeePpm)/10000}%)`,
      gas:`each payment also pays its own actual gas in USDC (+ margin), never more than ${usd(policy.maxNetworkFee)} per payment; nobody subsidizes gas`,validity:`${ct(start)} → ${ct(end)} (never renews)`},
    trusts,calls:calls.map((c,i)=>({label:labels[i],to:c.to,value:'0',data:c.data})),
    walletExecuteBatch:{to:wallet,data:executeBatch},
    walletSendCalls:{version:'2.0.0',chainId:toHex(chainId),from:wallet,atomicRequired:true,calls:calls.map(c=>({to:c.to,value:'0x0',data:c.data}))}},(k,v)=>typeof v==='bigint'?v.toString():v));
}

/** Service-down exit: every call is made by the owner's wallet; nothing depends on Kipurse servers or the executor. */
export function buildExitPlanV5({chainId,wallet,adapter,trust,manager=SPM_BASE,permission,vault,openDigests=[],floatOpen=false,gasDebt}){
  const p=permissionFromJson(permission);const calls=[call(trust??adapter,'setPaused',[true]),call(manager,'revoke',[p])];const labels=['pause the wallet on the adapter','revoke the V5 spend permission'];
  for(const d of openDigests){calls.push(call(adapter,'cancelReservation',[d]));labels.push('cancel open x402 reservation '+d.slice(0,10));}
  if(floatOpen){calls.push(call(adapter,'reconcileFloat',[getAddress(wallet)]));labels.push('close the micropayment float (unspent float + fee reserve back to the wallet)');}
  if(vault){calls.push(call(vault,'sweep',[]));labels.push('sweep the payer vault back to the wallet');}
  const data=encodeFunctionData({abi:v5Abi,functionName:'executeBatch',args:[calls.map(c=>({target:c.to,value:c.value,data:c.data}))]});
  return JSON.parse(JSON.stringify({WARNING:'PLAN ONLY',chainId,wallet:getAddress(wallet),calls:calls.map((c,i)=>({label:labels[i],to:c.to,value:'0',data:c.data})),walletExecuteBatch:{to:getAddress(wallet),data},
    note:'Funds never leave the owner wallet except through the permission; after revoke no agent can spend. Late-settled fees and any vault dust can be swept by anyone at any time.',
    settleGasDebt:settleStep(wallet,gasDebt)},(k,v)=>typeof v==='bigint'?v.toString():v));
}
/** OPTIONAL, SEPARATE owner-signed step: pay outstanding failed-tx gas (USDC) to the fee recipient. Never part of the exit batch, so a missing
 *  balance or a refusal can never block the exit. The gateway marks the debt recovered only after it sees this transfer on chain. */
function settleStep(wallet,d){
  if(!d||BigInt(d.amount??0)<=0n)return null;const amount=BigInt(d.amount);
  const c=call(d.token,'transfer',[getAddress(d.recipient),amount]);
  return {optional:true,separateSignature:true,amount:amount.toString(),recipient:getAddress(d.recipient),token:getAddress(d.token),debts:d.debts??[],
    label:`optional: settle ${usd(amount)} of gas from ${d.debts?.length??'earlier'} failed transaction(s) (gas we spent on your behalf that was never recovered)`,
    calls:[{label:'transfer outstanding failed-tx gas to the Kipurse fee recipient',to:c.to,value:'0',data:c.data}],
    walletExecute:{to:getAddress(wallet),data:encodeFunctionData({abi:v5Abi,functionName:'execute',args:[c.to,0n,c.data]})},
    note:'Independent of the exit batch above: sign it before, after, or never. Skipping it does not affect the exit.'};
}

/** Renewal / term roll-over in ONE owner signature (default 90 days): revoke the current V5 permission, approve the SAME policy for a fresh
 *  term, re-trust merchants with fresh expiries and re-set the float cap. On-chain caps are reused verbatim (fee headroom is never added twice).
 *  `adapter` may name a newer adapter (V5 -> V5.x upgrade); it defaults to the current spender. Plan only: never signs, never broadcasts. */
export function buildRenewalPlanV5({chainId,current,trust,manager=SPM_BASE,owner=null,days=90,start,salt,trusts=[],floatCap,feePpm=1000,adapter,
  term,maxNetworkFee,nowS=Math.floor(Date.now()/1000)}){
  const p=permissionFromJson(current);const pol=decodePolicyV5(p.extraData);const S=Number(start??nowS+600);
  if(!(Number(days)>0&&Number(days)<=365))throw Error('PLAN: renewal term must be 1..365 days');
  if(S<Number(p.end)-30*DAY)throw Error('PLAN: renew at most 30 days before the current permission ends (it never renews by itself)');
  const st=k=>String(pol[k]??0);
  const plan=buildMigrationPlanV5({chainId,wallet:p.account,owner,adapter:adapter??p.spender,trust,token:p.token,manager,executor:pol.executor,guardian:pol.guardian,registry:pol.registry,
    stated:{single:st('single'),daily:st('daily'),term:String(term??pol.term),openSingle:st('openSingle'),openDaily:st('openDaily'),verifiedSingle:st('verifiedSingle'),verifiedDaily:st('verifiedDaily')},
    headroom:false,maxFeePpm:st('maxFeePpm'),maxNetworkFee:String(maxNetworkFee??pol.maxNetworkFee),fee:{ppm:String(feePpm)},start:S,end:S+Number(days)*DAY,
    salt:salt??(BigInt(p.salt)+1n),revoke:[current],trusts:trusts.map(t=>({...t,expiry:t.expiry??(S+Number(t.days??days)*DAY)})),floatCap});
  return {...plan,kind:'renewal',renews:{permissionHash:spendPermissionHash(p,{chainId,manager:manager??SPM_BASE}),oldEnd:Number(p.end),newEnd:S+Number(days)*DAY,days:Number(days)},
    note:'One signature: the old permission is revoked and the new term starts in the same batch. Open reservations and an open float stay reclaimable/reconcilable; they do not depend on the permission.'};
}
