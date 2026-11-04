// SPDX-License-Identifier: AGPL-3.0-only
// Owner onboarding (kipurse_setup). The WALLET HAS NO PREDEFINED NUMBERS: every limit comes from the human, asked by the agent.
// Technical parameters (per-operation gas cap, fee) are NOT asked: they are explained plainly and need the owner's explicit consent.
// Output: ONE owner signature on the live V5 adapter (revoke current permission -> approve new -> register), plus the off-chain
// settings that activate only once that exact permission is approved on chain.
import {getAddress,isAddress,encodeFunctionData} from 'viem';
import {v5Abi,encodePolicyV5,decodePolicyV5,permissionFromJson,permissionToJson,spendPermissionHash,ZERO} from './abi.mjs';import {SPM_BASE} from './plan.mjs';
import {checkAnswersZh,TERM_PRESETS,TERM_MIN_DAYS,TERM_MAX_DAYS} from './answer-rules.mjs';
export {TERM_MIN_DAYS,TERM_MAX_DAYS};
/** Preset buttons only: any whole number of days TERM_MIN_DAYS..TERM_MAX_DAYS is valid (contract: period <= 365 days). */
export const TERM_DAYS=TERM_PRESETS;
export const RISK_NOTICE_ZH='这个钱包完全由 AI 控制。请只在里面放少量资金。';
export const RISK_NOTICE_EN='This wallet is fully AI-controlled; keep only a small amount in it.';
export const PROTOCOL_FEE_PPM=1000n,CONTRACT_MAX_FEE_PPM=3000n;
/** Technical parameters chosen by Kipurse (not asked): explained in DISCLOSURE, applied only after explicit consent. */
export const TECHNICAL={maxNetworkFeeAtomic:50000n,feePpm:PROTOCOL_FEE_PPM};
/** The questions the agent asks, one by one. `example` values are ILLUSTRATIONS ONLY and are never applied. */
export const QUESTIONS=[
  {key:'termDays',zh:'授权多长时间？常用 30、90、180 或 365 天，也可以自己填 1 到 365 之间的任意天数。到期后自动失效，不会自动续期。',type:'days',options:TERM_DAYS,min:TERM_MIN_DAYS,max:TERM_MAX_DAYS,custom:true,example:90},
  {key:'perPayment',zh:'AI 每一笔付款最多可以付多少 USDC？',type:'usdc',custom:true,example:'5'},
  {key:'perDay',zh:'AI 每天合计最多可以花多少 USDC？（含 0.1% 手续费和 gas）',type:'usdc',custom:true,example:'10'},
  {key:'termTotal',zh:'整个授权期内合计最多可以花多少 USDC？（含手续费和 gas）',type:'usdc',custom:true,example:'30'},
  {key:'unrecognizedPerPayment',zh:'付给“还没有被你批准信任的收款方”时，每笔最多多少 USDC？（不能超过上面的每笔上限）',type:'usdc',custom:true,example:'0.5'},
  {key:'unrecognizedPerDay',zh:'付给“未被信任的收款方”每天合计最多多少 USDC？（不能超过每天上限）',type:'usdc',custom:true,example:'1'},
  {key:'depositDailyLimit',zh:'每天最多接收多少 USDC 充值？超出的部分不会退回，会先隔离，你随时可以提走。',type:'usdc',custom:true,example:'20'},
  {key:'withdrawalAddress',zh:'提现到哪个地址？（你自己的 Base 地址，以后提现只能到这里）',type:'address',example:'0x… (你的 Base Account 地址)'},
];
export function disclosure({maxNetworkFeeAtomic=TECHNICAL.maxNetworkFeeAtomic,typicalGasUsdc='0.005–0.02',feeRecipient}={}){
  return {zh:[
    `重要提示：${RISK_NOTICE_ZH}`,
    '手续费：每笔付款收取金额的 0.1%，由付款方（你的钱包）支付，商户不付任何费用。没有最低收费，也没有封顶。合约规定手续费最高不能超过 0.3%；而你这次确认的授权把上限锁定在 0.1%，在这次授权期内无法被调高。',
    `手续费给谁：${feeRecipient?feeRecipient:'Kipurse 的手续费接收地址'}（链上公开可查）。`,
    `Gas（手续费）：用 USDC 支付，从你的钱包扣，不需要 ETH，也不需要预存。Base 上一笔付款通常约 ${typicalGasUsdc} USDC；系统给每笔设了 ${(Number(maxNetworkFeeAtomic)/1e6).toFixed(2)} USDC 的硬上限，超过就不付、稍后再试。`,
    '链上与链下：每笔、每天、总额上限和期限写在链上，任何人（包括 Kipurse）都改不了。未信任收款方上限、信任名单、每日充值上限和隔离由网关执行；如果网关所在电脑被攻破，最坏情况是按链上上限被花掉，你随时可以在链上撤销授权。',
    '退出：你随时可以暂停、撤销授权，或直接在链上把钱转走（只付 gas，不受上限限制）。',
  ],en:[`IMPORTANT: ${RISK_NOTICE_EN}`,'Fee: 0.1% of each payment, paid by you (the payer); merchants pay nothing; no minimum, no cap. Contract hard max 0.3%; this authorization locks the max at 0.1% for its whole term.',
    `Fee recipient: ${feeRecipient??'the Kipurse fee recipient'} (public on chain).`,`Gas: paid in USDC from the wallet, no ETH, no reserve; typically ${typicalGasUsdc} USDC per payment, hard cap ${(Number(maxNetworkFeeAtomic)/1e6).toFixed(2)} USDC per operation.`,
    'On chain vs gateway: per-payment/daily/term caps and the term are on chain. Unrecognized-payee caps, the trust list, the deposit limit and quarantine are enforced by the gateway; if its host is compromised the bound is the on-chain caps, and you can revoke on chain at any time.',
    'Exit: pause, revoke, or move funds directly on chain at any time (gas only, no caps).']};}
const usdcAtomic=v=>{const m=/^\s*(\d{1,12})(?:\.(\d{1,6}))?\s*$/.exec(String(v??''));if(!m)return undefined;return BigInt(m[1])*1000000n+BigInt((m[2]??'').padEnd(6,'0')||'0');};
/** Validate the human's answers. Throws listing EVERY missing/invalid value; never fills anything in. */
export function validateAnswers(a={},{wallet}={}){const errs=[],out={};
  const r=checkAnswersZh(a);for(const e of r.errors)errs.push(e.zh);Object.assign(out,r.values);
  if(!a.withdrawalAddress||!isAddress(String(a.withdrawalAddress),{strict:false})||/^0x0{40}$/i.test(String(a.withdrawalAddress)))errs.push('提现地址：请填你自己的 Base 地址（0x 开头）');
  else{out.withdrawalAddress=getAddress(String(a.withdrawalAddress).toLowerCase());if(wallet&&out.withdrawalAddress===getAddress(wallet))errs.push('提现地址：不能是 AI 钱包本身');}
  if(a.riskNoticeAcknowledged!==true)errs.push('请先勾选：'+RISK_NOTICE_ZH+'（riskNoticeAcknowledged）');
  if(a.technicalConsent!==true)errs.push('请先勾选同意 0.1% 手续费和用 USDC 付 gas（technicalConsent）');
  if(errs.length){const e=Error('设置有误：'+errs.join('；'));e.errors=errs;throw e;}out.warnings=r.warnings;return out;}
const call=(to,fn,args)=>({to:getAddress(to),value:'0',data:encodeFunctionData({abi:v5Abi,functionName:fn,args})});
/** ONE owner signature on the live V5 adapter: revoke current -> approve new (fresh term from `start`) -> registerPermission. No deploy,
 *  no funding (the existing vault keeps its gas buffer). On-chain stranger caps = main caps; the owner-set unrecognized caps are gateway-enforced. */
export function buildOneSignatureBatchV5({answers,current,adapter,manager=SPM_BASE,owner,chainId=8453,nowS=Math.floor(Date.now()/1000),startDelaySec=600,example=false}){
  const v=validateAnswers(answers,{wallet:permissionFromJson(current).account});const cur=permissionFromJson(current);const old=decodePolicyV5(cur.extraData);
  const pol={executor:old.executor,guardian:ZERO,single:v.perPayment.toString(),daily:v.perDay.toString(),term:v.termTotal.toString(),openSingle:v.perPayment.toString(),openDaily:v.perDay.toString(),
    verifiedSingle:'0',verifiedDaily:'0',registry:ZERO,maxFeePpm:TECHNICAL.feePpm.toString(),maxNetworkFee:TECHNICAL.maxNetworkFeeAtomic.toString()};
  const start=nowS+startDelaySec;const np={account:cur.account,spender:getAddress(adapter),token:cur.token,allowance:v.termTotal,period:v.termDays*86400,start,end:start+v.termDays*86400,salt:BigInt(cur.salt)+1n,extraData:encodePolicyV5(pol)};
  const calls=[call(manager,'revoke',[cur]),call(manager,'approve',[np]),call(adapter,'registerPermission',[np])];
  const usd=x=>(Number(x)/1e6).toString()+' USDC';
  return JSON.parse(JSON.stringify({WARNING:example?'EXAMPLE VALUES - NOT FOR SIGNING (fork simulation only)':'PLAN ONLY - nothing was signed or broadcast. ONE owner signature.',example:!!example,
    kind:'v5-one-signature-setup',chainId,wallet:cur.account,owner:owner?getAddress(owner):null,adapter:getAddress(adapter),manager:getAddress(manager),
    revokes:{permissionHash:spendPermissionHash(cur,{chainId,manager}),spender:cur.spender,end:Number(cur.end)},
    permission:permissionToJson(np),permissionHash:spendPermissionHash(np,{chainId,manager}),policy:pol,
    offchain:{unrecognizedPerPayment:v.unrecognizedPerPayment.toString(),unrecognizedPerDay:v.unrecognizedPerDay.toString(),depositDailyLimit:v.depositDailyLimit.toString(),withdrawalAddress:v.withdrawalAddress},
    human:{term:`${v.termDays} days (${new Date(start*1000).toISOString()} -> ${new Date((start+v.termDays*86400)*1000).toISOString()}), no auto-renew`,perPayment:usd(v.perPayment),perDay:usd(v.perDay),termTotal:usd(v.termTotal),
      unrecognized:`${usd(v.unrecognizedPerPayment)}/payment, ${usd(v.unrecognizedPerDay)}/day (gateway)`,depositDailyLimit:usd(v.depositDailyLimit)+' (gateway; excess quarantined)',withdrawalAddress:v.withdrawalAddress,
      fee:'0.1% (locked for this term; contract max 0.3%)',gasCap:usd(TECHNICAL.maxNetworkFeeAtomic)+' per operation'},
    calls,walletSendCalls:{version:'2.0.0',chainId:'0x'+chainId.toString(16),from:cur.account,atomicRequired:true,calls:calls.map(c=>({to:c.to,value:'0x0',data:c.data}))},
    walletExecuteBatch:{to:cur.account,data:encodeFunctionData({abi:v5Abi,functionName:'executeBatch',args:[calls.map(c=>({target:c.to,value:0n,data:c.data}))]})}},(k,x)=>typeof x==='bigint'?x.toString():x));}
