// SPDX-License-Identifier: Apache-2.0
// "Get my money back" (rescue page) — pure logic, no network. Works without any Kipurse server: everything it needs is in the
// rescue card (URL fragment, never sent to a server) or typed by the user, plus public chain reads.
import {encodeFunctionData,parseAbi,getAddress,isAddress} from 'viem';
export const CHAINS={8453:{name:'Base',rpc:'https://mainnet.base.org',usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',explorer:'https://basescan.org',hex:'0x2105'},
  84532:{name:'Base Sepolia（测试网）',rpc:'https://sepolia.base.org',usdc:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',explorer:'https://sepolia.basescan.org',hex:'0x14a34'}};
export const SPM='0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const SP='(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
export const ABI=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable','function execute(address target,uint256 value,bytes data) payable',
  `function revoke(${SP} p)`,`function isValid(${SP} p) view returns (bool)`,'function sweep() returns (uint256)','function reconcileFloat(address wallet)',
  'function transfer(address,uint256) returns (bool)','function approve(address,uint256) returns (bool)','function balanceOf(address) view returns (uint256)',
  'function isOwnerAddress(address) view returns (bool)','function floatAddress(address) view returns (address)']);
const b64d=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return typeof atob==='function'?decodeURIComponent(escape(atob(s))):Buffer.from(s,'base64').toString('utf8');};
/** Rescue card from `#c=<base64url JSON>` (or a pasted card / plain wallet address). */
export function parseCard(input){const t=String(input??'').trim();if(!t)return null;
  if(/^0x[0-9a-fA-F]{40}$/.test(t))return {v:1,wallet:getAddress(t.toLowerCase())};
  let j;const m=/(?:^|[#&?])c=([A-Za-z0-9_-]+)/.exec(t);try{j=m?JSON.parse(b64d(m[1])):JSON.parse(t);}catch{return null;}
  if(j?.permission&&!j.wallet&&j.permission.account)j.wallet=j.permission.account;
  if(!j?.wallet||!isAddress(j.wallet,{strict:false}))return null;j.wallet=getAddress(j.wallet.toLowerCase());return j;}
const perm=p=>({...p,allowance:BigInt(p.allowance),salt:BigInt(p.salt),period:Number(p.period),start:Number(p.start),end:Number(p.end)});
/** Destination check in plain words (Base address only). */
export function checkTo(to,{wallet,vault}={}){const s=String(to??'').trim();
  if(!/^0x[0-9a-fA-F]{40}$/.test(s))return {ok:false,zh:'地址格式不对：Base 地址以 0x 开头，一共 42 位。请复制粘贴，不要手打'};
  if(/[a-f]/.test(s.slice(2))&&/[A-F]/.test(s.slice(2))&&!isAddress(s,{strict:true}))return {ok:false,zh:'地址校验没通过（可能抄错了一位），请重新复制'};
  const a=getAddress(s.toLowerCase());if([wallet,vault].filter(Boolean).map(x=>getAddress(x)).includes(a))return {ok:false,zh:'这是 Kipurse 钱包自己的地址，请填你自己的地址'};return {ok:true,to:a};}
/**
 * ONE owner batch (Base Account → wallet.executeBatch): revoke the AI permission (if known), close the float, sweep the payer vault,
 * then move everything to `to`. `gas` = {mode:'sponsored'|'erc20'|'self', erc20:{paymaster,cap}}.
 * erc20 mode: funds land in the owner's own Base Account, which approves the ERC-20 paymaster for at most `cap` USDC so the
 * network fee is paid in USDC (no ETH). Returns {calls, receive, labels}.
 */
export function buildRescue({card,owner,to,balances,floatOpen=false,gas={mode:'self'},chainId}){const C=CHAINS[chainId??card.chainId??8453];const usdc=getAddress(card.usdc??C.usdc);
  const W=getAddress(card.wallet);const inner=[],labels=[];
  if(card.permission){inner.push({target:getAddress(card.spm??SPM),value:0n,data:encodeFunctionData({abi:ABI,functionName:'revoke',args:[perm(card.permission)]})});labels.push('停止 AI 的付款授权');}
  if(floatOpen&&card.adapter){inner.push({target:getAddress(card.adapter),value:0n,data:encodeFunctionData({abi:ABI,functionName:'reconcileFloat',args:[W]})});labels.push('收回小额预付');}
  const vb=BigInt(balances?.vault??0),fb=floatOpen?BigInt(balances?.float??0):0n;
  if(card.vault&&vb>0n){inner.push({target:getAddress(card.vault),value:0n,data:encodeFunctionData({abi:ABI,functionName:'sweep'})});labels.push('收回结算账户里的钱');}
  const total=BigInt(balances?.wallet??0)+vb+fb;const o=getAddress(owner);
  const dest=gas.mode==='erc20'?o:getAddress(to??o);
  if(total>0n){inner.push({target:usdc,value:0n,data:encodeFunctionData({abi:ABI,functionName:'transfer',args:[dest,total]})});labels.push('把全部 USDC 转到你的地址');}
  if(!inner.length)return {calls:[],receive:'0',labels:[]};
  const calls=[{to:W,value:'0x0',data:encodeFunctionData({abi:ABI,functionName:'executeBatch',args:[inner]})}];
  if(gas.mode==='erc20'){const cap=BigInt(gas.erc20.cap??1000000);calls.push({to:usdc,value:'0x0',data:encodeFunctionData({abi:ABI,functionName:'approve',args:[getAddress(gas.erc20.paymaster),cap]})});labels.push('允许网络费用 USDC 付（最多 '+Number(cap)/1e6+' USDC）');
    if(to&&getAddress(to)!==o&&total>cap){calls.push({to:usdc,value:'0x0',data:encodeFunctionData({abi:ABI,functionName:'transfer',args:[getAddress(to),total-cap]})});labels.push('转到你填的地址（留一点付网络费）');}}
  return {calls,receive:total.toString(),labels,dest};}
/** Which gas route the page uses, best first. Nothing here needs ETH except 'self'. */
export function gasRoute(cfg,chainId){const c=cfg?.[chainId]??{};if(c.paymasterUrl)return {mode:'sponsored',url:c.paymasterUrl};
  if(c.erc20Paymaster?.url&&c.erc20Paymaster?.paymaster)return {mode:'erc20',url:c.erc20Paymaster.url,erc20:c.erc20Paymaster};return {mode:'self'};}
export const fmt=x=>{const v=BigInt(x),w=v/1000000n,f=(v%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
