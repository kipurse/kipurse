// t1008/t1014/t1020 option A (owner): every opening / withdraw / limit change is paid in USDC by the USER through Coinbase's CDP ERC-20
// paymaster (ERC-7677 context {erc20: USDC}). The paymaster pulls USDC from the signer's Base Account (approve in the SAME batch, one confirmation)
// and pays the chain itself. Kipurse holds no ETH, fronts nothing, nets $0. Never an ETH path; if CDP refuses, nothing is sent (fail closed).
import {encodeFunctionData,decodeFunctionData,parseAbi,getAddress} from 'viem';
export const USDC_BASE='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** CDP ERC-20 paymaster on Base (EntryPoint v0.6 = Coinbase Smart Wallet / Base Account; checked on a Base fork 2026-11-04). */
export const CDP_ERC20_PAYMASTER='0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c';
/** Max USDC the paymaster may take for one confirmation (approve amount, and the ceiling on tokenPayment.maxFee). 0.25 USDC. */
export const USDC_GAS_APPROVE_CAP=250_000n;
export const USDC_GAS_PREFIX='ug-';
const A=parseAbi(['function approve(address spender,uint256 amount) returns (bool)','function transfer(address to,uint256 amount) returns (bool)']);
const lc=s=>String(s??'').toLowerCase();
/** Switch: KIPURSE_GAS_PAYMASTER=erc20_usdc turns option A on (needs CDP ERC-20 gas enabled for USDC on the project). Default off. */
export const usdcGasMode=(env=process.env)=>lc(String(env.KIPURSE_GAS_PAYMASTER??'').trim())==='erc20_usdc';
export function approveCall(cap=USDC_GAS_APPROVE_CAP){if(BigInt(cap)<=0n||BigInt(cap)>USDC_GAS_APPROVE_CAP)throw Error('approve cap');
  return {to:USDC_BASE,value:'0x0',data:encodeFunctionData({abi:A,functionName:'approve',args:[CDP_ERC20_PAYMASTER,BigInt(cap)]})};}
export function depositCall(wallet,amount){const a=BigInt(amount);if(a<=0n)throw Object.assign(Error('deposit amount'),{code:'deposit_amount'});
  return {to:USDC_BASE,value:'0x0',data:encodeFunctionData({abi:A,functionName:'transfer',args:[getAddress(wallet),a]})};}
/** t1022 fee address = Kipurse ops account (same as DUES_SLOT / withdraw feeTo). Same-tx repay pays here. */
export const KIPURSE_FEE_TO='0xf14ef5dc4723245866c22c749a0a84afceba0dd9';
/** t1026: opening fee = actual network cost in USDC (gas*price + L1), + safety buffer, hard-capped. Not a fixed 0.05. */
export const OPENING_GAS=2_300_000n;                 // same envelope as onboard.mjs ONBOARD_GAS (new wallet + vault)
/** t1086: first phone key (approver deploy + addOwnerAddress) rides in that same opening batch.
 *  1.8M is the measured enroll gas for deploy + addOwner + refund (phone-signer UPGRADE_GAS). One quote uses the sum; it is not a second fee. */
export const FIRST_KEY_GAS=1_800_000n;
export const OPENING_WITH_FIRST_KEY_GAS=OPENING_GAS+FIRST_KEY_GAS;
export const OPENING_L1_WEI=1_000_000_000_000n;     // Base L1 data fee allowance (matches phone-signer L1_ALLOWANCE_WEI)
export const OPENING_FEE_BUFFER_BPS=2000n;           // +20% safety buffer (threat-model quote = actual + 20%)
export const OPENING_FEE_CAP_USDC=USDC_GAS_APPROVE_CAP; // hard cap 0.25 USDC
/** @deprecated t1026: was fixed 0.05; now equals the hard cap (legacy dues/tests). Prefer openingFeeUSDC(). */
export const OPENING_FEE_USDC=OPENING_FEE_CAP_USDC;
/** Pure: wei cost → USDC (6 dp, ceil) with buffer and hard cap. User sees this exact amount before confirming. */
export function openingFeeUSDC({gasPriceWei,ethUsd8,gas=OPENING_GAS,l1Wei=OPENING_L1_WEI,bufferBps=OPENING_FEE_BUFFER_BPS,cap=OPENING_FEE_CAP_USDC}={}){
  if(gasPriceWei==null||ethUsd8==null)throw Error('openingFeeUSDC needs gasPriceWei+ethUsd8');
  const wei=BigInt(gas)*BigInt(gasPriceWei)+BigInt(l1Wei);
  const raw=(wei*BigInt(ethUsd8)+10n**20n-1n)/10n**20n; // ceil wei*usd8 / 1e20 → USDC 6dp
  const buf=(raw*(10_000n+BigInt(bufferBps))+9_999n)/10_000n;
  const fee=buf<1n?1n:buf>BigInt(cap)?BigInt(cap):buf;
  return {fee,raw,wei,capped:buf>BigInt(cap),bufferBps:BigInt(bufferBps),cap:BigInt(cap)};}
export function feeRepayCall(fee){const f=BigInt(fee??0);if(f<=0n||f>USDC_GAS_APPROVE_CAP)throw Error('fee');
  return {to:USDC_BASE,value:'0x0',data:encodeFunctionData({abi:A,functionName:'transfer',args:[getAddress(KIPURSE_FEE_TO),f]})};}
export function fmtOpeningFeeUSDC(atomic){const n=BigInt(atomic),w=n/1_000_000n,f=(n%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;}
export function openingFeeNote(feeAtomic){const a=fmtOpeningFeeUSDC(feeAtomic);
  return {zh:`开通手续费约 ${a} USDC（按实时报价），在这次确认里从你的 Coinbase 钱包余额扣，Kipurse 不出这笔钱。`,
          en:`Opening fee about ${a} USDC (actual network cost), taken from your Coinbase wallet balance in this confirmation. Kipurse does not pay it.`};}
/** t1185 (decision 86): opening seeds the owner's OWN payer vault with 0.15 USDC from his Base Account (gas reserve so the first AI payment
 *  works; his money, returned at exit). The App accepts only 0.10..0.20 to the vault it computes itself. */
export const OPENING_VAULT_SEED=150_000n,OPENING_VAULT_SEED_MIN=100_000n,OPENING_VAULT_SEED_MAX=200_000n;
export function vaultSeedCall(vault,amount=OPENING_VAULT_SEED){const a=BigInt(amount);if(a<OPENING_VAULT_SEED_MIN||a>OPENING_VAULT_SEED_MAX)throw Error('vault seed');
  return {to:USDC_BASE,value:'0x0',data:encodeFunctionData({abi:A,functionName:'transfer',args:[getAddress(vault),a]})};}
export function vaultSeedNote(amount=OPENING_VAULT_SEED){const a=fmtOpeningFeeUSDC(amount);
  return {zh:`另放 ${a} USDC 到你钱包的手续费备用金，用来付 AI 付款的手续费。钱还是你的，取回时一起退给你。`,
          en:`Plus ${a} USDC into your wallet's fee reserve to cover network fees for AI payments. It is still your money and comes back when you withdraw.`};}
/** A USDC call is allowed as: approve(CDP, <=cap), transfer(feeTo, <=cap) [same-tx repay], transfer(this wallet, >0) [deposit],
 *  or (t1185 decision 86) transfer(this wallet's vault, 0.10..0.20) [vault seed]. */
export function usdcCallProblem(c,{wallet,vault,feeTo=KIPURSE_FEE_TO}){if(lc(c?.to)!==lc(USDC_BASE))return 'not_usdc';if(BigInt(c.value??0)!==0n)return 'value';
  let d;try{d=decodeFunctionData({abi:A,data:c.data});}catch{return 'usdc_call';}
  if(d.functionName==='approve')return lc(d.args[0])===lc(CDP_ERC20_PAYMASTER)&&d.args[1]>0n&&d.args[1]<=USDC_GAS_APPROVE_CAP?null:'approve';
  if(d.functionName==='transfer'){
    if(feeTo&&lc(d.args[0])===lc(feeTo)&&d.args[1]>0n&&d.args[1]<=USDC_GAS_APPROVE_CAP)return null;
    if(vault&&lc(d.args[0])===lc(vault)&&d.args[1]>=OPENING_VAULT_SEED_MIN&&d.args[1]<=OPENING_VAULT_SEED_MAX)return null;
    return wallet&&lc(d.args[0])===lc(wallet)&&d.args[1]>0n?null:'transfer';}
  return 'usdc_call';}
/** Force the ERC-7677 context to USDC payment, whatever the page sent. */
export function withErc20Context(params){const p=Array.isArray(params)?[...params]:[];while(p.length<3)p.push(undefined);p[3]={erc20:lc(USDC_BASE)};return p;}
/** The paymaster answer must say the USER pays in USDC, at most the cap. Otherwise refuse (never fall back to sponsorship or ETH). */
export function tokenPaymentProblem(result){const t=result?.tokenPayment;if(!t||typeof t!=='object')return 'no_token_payment';
  if(lc(t.address??t.tokenAddress)!==lc(USDC_BASE))return 'not_usdc';let m;try{m=BigInt(t.maxFee);}catch{return 'max_fee';}
  return m>0n&&m<=USDC_GAS_APPROVE_CAP?null:'max_fee';}
