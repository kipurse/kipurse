// SPDX-License-Identifier: AGPL-3.0-only
// t1187 (§6#87, owner approved 2026-11-18 14:36 CT): ONE-TIME page that lets the owner's Base Account confirm exactly ONE fixed batch:
//   1. deterministic deployer 0x4e59 <- V5.3 PayerVaultFactory init code   (CREATE2 -> 0x34d9…D57D)
//   2. deterministic deployer 0x4e59 <- V5.3 Kipurse adapter init code      (CREATE2 -> 0xb150…033C)
//   3. USDC.transfer(Kipurse fee address, 0.20 USDC)  - the fee, paid from the owner's own USDC in the same batch (never ETH)
// Kipurse's existing paymaster only fronts the gas for this exact batch (callsHash), the batch repays it in USDC (t752 shape).
// The page refuses any other batch (server: exact calls + sponsor callsHash; browser: KPVH #vh commitment) and is inert once both
// contracts have code. Nothing here touches any existing wallet, key, permission or ledger.
// t1189 (§6#89, 2026-11-18): Coinbase's bundler cannot estimate the ~12M-gas single batch ("estimateCallGas should make progress each
// time it is called", reproduced read-only on the CDP endpoint). Now TWO confirmations in order, each estimated OK on that endpoint:
//   step 1: deployer <- factory init code + USDC 0.05 fee leg;   step 2 (after the factory is on chain): deployer <- adapter init code + USDC 0.15.
// Same 0.20 USDC in total, each op repays its own fronted gas (t752 shape). The link carries one KPVH commitment per step (#vh1=…&vh2=…).
import fs from 'node:fs';import {createHash,randomBytes} from 'node:crypto';
import {getAddress,getContractAddress,slice,encodeFunctionData,parseAbi} from 'viem';
import {langOf,X} from './i18n.mjs';import {USDC_BASE,KIPURSE_FEE_TO,USDC_GAS_APPROVE_CAP} from './usdc-gas.mjs';import {commitment} from './batch-commit.mjs';
export const DEPLOY_V53_PREFIX='dv53-';
export const DEPLOYER='0x4e59b44847b379578588920cA78FbF26c0B4956C';
/** Fixed fee (6 dp): measured on a Base fork 2026-11-18 the batch uses ~12.03M gas (≈0.14 USD at 0.006 gwei, 1,761 USD/ETH); 0.20 leaves headroom. */
export const DEPLOY_V53_FEE_USDC=200_000n;
/** t1189: per-confirmation fee legs (sum = DEPLOY_V53_FEE_USDC), split by gas: step 1 ~3.1M gas, step 2 ~9.7M gas (CDP estimates 2026-11-18). */
export const DEPLOY_V53_STEP_FEES=Object.freeze([50_000n,150_000n]);
/** t1189: realistic gas per confirmation (CDP estimate limits: 0.26M+0.08M+2.80M; 0.58M+0.11M+9.03M; rounded up) for the 'underpaid' re-check. */
export const DEPLOY_V53_STEP_REAL_GAS=Object.freeze([3_300_000n,10_000_000n]);
/** Realistic gas of the sponsored op (12.03M measured + Base Account / EntryPoint / paymaster overhead), used for the 'underpaid' re-check. */
export const DEPLOY_V53_REAL_GAS=12_800_000n;
/** Worst-case (all gas limits x maxFeePerGas) Kipurse may front for THIS op only; the batch repays the real cost. Other kinds keep cfg.maxUsdPerOp. */
export const DEPLOY_V53_MAX_USD_PER_OP=1;
export const V53_PIN=Object.freeze({factory:'0x34d9Bdc9E10815fB6913AF5BC0DAad7E53dbD57D',adapter:'0xb150030be35903AdEE466d7733Bf0841B667033C',
  steps:[{address:'0x34d9Bdc9E10815fB6913AF5BC0DAad7E53dbD57D',sha256:'19a84073e44d17baae450bc001b96c9b51b0c19f48cc341505c5262fea9daad8'},
         {address:'0xb150030be35903AdEE466d7733Bf0841B667033C',sha256:'041c7149b272817a4c86e3792008ec20c919606ae4776ca19cf9d87995e71115'}]});
const sha=h=>createHash('sha256').update(Buffer.from(String(h).replace(/^0x/,''),'hex')).digest('hex');
/** Load + verify the fixed plan: exactly two steps, to the deployer, sha256-pinned, CREATE2 address = the pinned address. Throws otherwise. */
export function loadV53Plan(src){const D=typeof src==='string'?JSON.parse(fs.readFileSync(src,'utf8')):src;const S=D?.steps;
  if(!Array.isArray(S)||S.length!==2)throw Error('v53 plan: need exactly 2 steps');
  const steps=S.map((s,i)=>{const P=V53_PIN.steps[i];if(getAddress(s.to)!==DEPLOYER)throw Error('v53 plan: step '+i+' not to the deployer');
    if(!/^0x[0-9a-fA-F]+$/.test(String(s.data))||sha(s.data)!==P.sha256)throw Error('v53 plan: step '+i+' data hash');
    const a=getContractAddress({opcode:'CREATE2',from:DEPLOYER,salt:slice(s.data,0,32),bytecode:slice(s.data,32)});
    if(a!==getAddress(P.address)||getAddress(s.address)!==a)throw Error('v53 plan: step '+i+' address');return {label:String(s.label??''),to:DEPLOYER,address:a,data:String(s.data).toLowerCase()};});
  return {factory:steps[0].address,adapter:steps[1].address,steps};}
const TRA=parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
/** t1189: the batch of confirmation `step` (1 = factory + 0.05 USDC fee leg, 2 = adapter + 0.15 USDC fee leg). */
export function deployV53Calls(plan,step){const i=Number(step)-1;if(i!==0&&i!==1)throw Error('step');const f=DEPLOY_V53_STEP_FEES[i];
  if(DEPLOY_V53_STEP_FEES[0]+DEPLOY_V53_STEP_FEES[1]!==DEPLOY_V53_FEE_USDC||f<=0n||f>USDC_GAS_APPROVE_CAP)throw Error('fee');const s=plan.steps[i];
  return [{to:s.to,value:'0x0',data:s.data},{to:getAddress(USDC_BASE),value:'0x0',data:encodeFunctionData({abi:TRA,functionName:'transfer',args:[getAddress(KIPURSE_FEE_TO),f]})}];}
/** KPVH commitment of one step's batch (the link carries #vh1=<step 1>&vh2=<step 2>). */
export const deployV53Commitment=(plan,owner,step)=>commitment({chainId:8453,from:getAddress(owner),calls:deployV53Calls(plan,step)});
/** The link fragment for the owner: both step commitments. */
export const deployV53Fragment=(plan,owner)=>'vh1='+deployV53Commitment(plan,owner,1)+'&vh2='+deployV53Commitment(plan,owner,2);
const fmt=a=>{a=BigInt(a);const i=a/1_000_000n,f=(a%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');return String(i)+(f?'.'+(f.length<2?f.padEnd(2,'0'):f):'');};
const short=a=>a.slice(0,6)+'…'+a.slice(-4);
/** deps: plan (loadV53Plan), owner (the owner's Base Account), pub (getCode/readContract/getGasPrice), sponsor (registerDeployV53/rpc),
 *  ethUsd8 async()=>bigint, script ()=>bundle, base ()=>public origin. */
export function createDeployV53({plan,owner,pub,sponsor,ethUsd8=null,script=()=>'',base=()=>'https://pay.kipurse.com',maxBody=196608,readRaw}){
  const OWNER=getAddress(owner);const CALLS=[null,deployV53Calls(plan,1),deployV53Calls(plan,2)];
  const has=async a=>{const c=await pub.getCode({address:a});return !!c&&c!=='0x';};
  /** step: 1 = nothing deployed yet, 2 = factory on chain (adapter next), 0 = done, -1 = unexpected (adapter without factory). */
  async function state(){const [f,a]=await Promise.all([has(plan.factory),has(plan.adapter)]);return {factory:f,adapter:a,done:f&&a,step:f&&a?0:!f&&!a?1:f?2:-1};}
  /** Sponsor gate: a prepared step is only fundable while the chain is exactly at that step (inert once both contracts exist). */
  async function open(step){if(step!==1&&step!==2)return false;const s=await state();return s.step===step;}   // records without a step (old single batch) are never fundable
  async function realUsd(){try{const [gp,p]=await Promise.all([pub.getGasPrice(),ethUsd8?ethUsd8():null]);if(!p)return null;return Number((DEPLOY_V53_STEP_REAL_GAS[0]+DEPLOY_V53_STEP_REAL_GAS[1])*BigInt(gp)*BigInt(p)/10n**18n)/1e8;}catch{return null;}}
  async function prepare(b){const s=await state();if(s.done)return [200,{done:true}];if(s.step<0)return [409,{error:'partial'}];const i=s.step-1,fee=DEPLOY_V53_STEP_FEES[i];
    let from;try{from=getAddress(String(b?.from??''));}catch{return [400,{error:'not_owner'}];}if(from!==OWNER)return [400,{error:'not_owner'}];
    try{const bal=await pub.readContract({address:getAddress(USDC_BASE),abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[OWNER]});if(BigInt(bal)<fee)return [409,{error:'needs_usdc'}];}catch{return [503,{error:'rpc'}];}
    const id=sponsor?.registerDeployV53?.(randomBytes(12).toString('hex'),{owner:OWNER,calls:CALLS[s.step],reimburse:fee,step:s.step,realGas:DEPLOY_V53_STEP_REAL_GAS[i]});if(!id)return [503,{error:'unavailable'}];
    return [200,{id,step:s.step,chainId:8453,from:OWNER,calls:CALLS[s.step],paymaster:`${base()}/deploy-v53/paymaster?id=${id}`}];}
  const J=(res,c,o,h={})=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store',...h});res.end(JSON.stringify(o));};
  async function page(lang,nonce){const t=X(lang),s=await state(),u=await realUsd();const css=`body{margin:0;background:#F2F2F7;color:#111;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}.w{max-width:480px;margin:0 auto;padding:24px 18px 40px}.c{background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0}.t{font-size:24px;font-weight:700;margin:8px 0 4px}.m{color:#666;font-size:14px}.big{font-size:28px;font-weight:700}code{font-size:13px;word-break:break-all}button{display:block;box-sizing:border-box;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px;background:#0052FF;color:#fff}`;
    const head=`<!doctype html><html lang=${lang}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=referrer content=no-referrer><title>${t('部署启付 V5.3 合约','Deploy Kipurse V5.3 contracts')}</title><style>${css}</style><div class=w>
<div class=t>${t('部署启付 V5.3 合约（一次性）','Deploy Kipurse V5.3 contracts (one time)')}</div>`;
    if(s.done)return head+`<div class=c id=done><b>✅ ${t('两份 V5.3 合约都已经在 Base 上了。','Both V5.3 contracts are already on Base.')}</b><div class=m>${t('这个页面已经完成任务，不需要再做什么，可以关掉。','This page has done its job. Nothing else to do; you can close it.')}</div></div></div></html>`;
    if(s.step<0)return head+`<div class=c id=partial>${t('链上状态和预期不一致，这个页面已停止，不会提交任何内容。请告诉启付助手。','The on-chain state is not what this page expects, so it has stopped and will not submit anything. Please tell your Kipurse assistant.')}</div></div></html>`;
    const data=JSON.stringify({owner:OWNER,chainId:8453,prepare:'/deploy-v53/prepare',confirm:'/deploy-v53/confirm',feeTo:getAddress(KIPURSE_FEE_TO),fee:String(DEPLOY_V53_FEE_USDC),fees:DEPLOY_V53_STEP_FEES.map(String),step:s.step,pin:V53_PIN}).replace(/</g,'\\u003c');
    return head+`<div class=c id=what><b>${t('这一步做什么','What this does')}</b><div>${t('在 Base 上放两份启付 V5.3 公共合约：钱包工厂和 AI 付款适配器。以后新开的启付钱包会用它们。','Places two public Kipurse V5.3 contracts on Base: the wallet factory and the AI payment adapter. New Kipurse wallets will use them.')}</div>
<div class=m>${t('它们不能动你的钱。你现在的启付钱包不会被改动，继续照常使用。','They cannot move your money. Your current Kipurse wallet is not changed and keeps working as before.')}</div>
<div class=m>${t('工厂','Factory')} <code>${plan.factory}</code><br>${t('适配器','Adapter')} <code>${plan.adapter}</code><br>${t('通过公开部署器','Via the public deployer')} <code>${DEPLOYER}</code></div></div>
<div class=c id=fee><div class=m>${t('手续费（一共）','Fee (in total)')}</div><div class=big>${fmt(DEPLOY_V53_FEE_USDC)} USDC</div><div class=m>${t(`分两次付：第 1 步 ${fmt(DEPLOY_V53_STEP_FEES[0])}，第 2 步 ${fmt(DEPLOY_V53_STEP_FEES[1])}。从你的 Base 账户（${short(OWNER)}）里的 USDC 付，不用 ETH。`,`Paid in two parts: ${fmt(DEPLOY_V53_STEP_FEES[0])} in step 1 and ${fmt(DEPLOY_V53_STEP_FEES[1])} in step 2, from the USDC in your Base Account (${short(OWNER)}). No ETH needed.`)}${u!=null?' '+t(`Base 上的实际成本现在约 ${u.toFixed(2)} 美元，多留一点余量以防网络变忙。`,`The actual cost on Base is about $${u.toFixed(2)} right now; the rest is headroom in case the network gets busy.`):''}</div></div>
<div class=c id=how><div class=m>${t(`一共要在 Coinbase 里确认<b>两次</b>（合约太大，Coinbase 没法一次处理，所以分开）。第 1 次：部署工厂 + 付 ${fmt(DEPLOY_V53_STEP_FEES[0])} USDC。完成后这个页面会自动换成第 2 步，再点一次按钮。第 2 次：部署适配器 + 付 ${fmt(DEPLOY_V53_STEP_FEES[1])} USDC。每次确认后大约 10–60 秒完成。内容不一致时页面会停下，不会提交。`,`You confirm in Coinbase <b>twice</b> (the contracts are too big for Coinbase to handle in one go, so it is split). First: deploy the factory + pay ${fmt(DEPLOY_V53_STEP_FEES[0])} USDC. When that is done this page switches to step 2 by itself; tap the button again. Second: deploy the adapter + pay ${fmt(DEPLOY_V53_STEP_FEES[1])} USDC. Each takes about 10–60 seconds after you confirm. If anything differs, this page stops and submits nothing.`)}</div></div>
<div class=c id=steps><b id=s1>${s.step===2?'✅':'①'} ${t('第 1 步：部署工厂','Step 1: deploy the factory')}</b><br><b id=s2>② ${t('第 2 步：部署适配器','Step 2: deploy the adapter')}</b></div>
<div class=c id=safari style="display:none"><b>${t('请在 Safari 里打开这个页面','Please open this page in Safari')}</b><div class=m>${t('你现在是在别的 App 里看这个页面。Coinbase 的确认窗口在这里打不开，所以按钮先藏起来了，什么都没有发生。','You are viewing this page inside another app. The Coinbase confirmation window cannot open here, so the button is hidden. Nothing has happened.')}</div>
<div class=m>${t('点「在 Safari 中打开」；如果没反应，点「复制链接」，打开 Safari，粘贴到地址栏。','Tap “Open in Safari”. If nothing happens, tap “Copy link”, open Safari and paste it into the address bar.')}</div>
<button id=osf>${t('在 Safari 中打开','Open in Safari')}</button><button id=cpl style="background:#EEF2FF;color:#0052FF">${t('复制链接','Copy link')}</button><p class=m id=cps></p></div>
<button id=go>${s.step===2?t('第 2 步：在 Coinbase 里确认','Step 2: confirm in Coinbase'):t('第 1 步：在 Coinbase 里确认','Step 1: confirm in Coinbase')}</button><p class=m id=st></p>
<div class=c id=help style="display:none"><div class=m>${t('如果 Coinbase 窗口没打开、显示出错，或者一直转圈：先关掉那个窗口回到这里。这个页面需要在 iPhone 的 Safari 里打开（不要在 Grok Bot 或其他 App 里直接点开）。没有扣任何钱。','If the Coinbase window did not open, showed an error, or keeps spinning: close it and come back here. This page needs to be open in Safari on your iPhone (not inside Grok Bot or another app). No money was taken.')}</div><button id=cpl2 style="background:#EEF2FF;color:#0052FF">${t('复制链接','Copy link')}</button></div>
<script type="application/json" id=kp-data>${data}</script><script nonce="${nonce}" src="/deploy-v53.js"></script></div></html>`;}
  async function handle(req,res,u){const p=u.pathname;
    if(p==='/deploy-v53'&&(req.method==='GET'||req.method==='HEAD')){   // t1188: HEAD answers 200 like the proven sign host (the Base Account SDK checks COOP with HEAD)
      const lang=langOf(req,u),nonce=randomBytes(16).toString('base64');let html;try{html=await page(lang,nonce);}catch{return J(res,503,{error:'rpc'}),true;}
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; form-action 'none'; frame-ancestors 'none'`});res.end(req.method==='HEAD'?undefined:html);return true;}
    if(p==='/deploy-v53.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(script());return true;}
    if(p==='/deploy-v53/status'&&req.method==='GET'){try{return J(res,200,await state()),true;}catch{return J(res,503,{error:'rpc'}),true;}}
    if(p==='/deploy-v53/confirm'&&req.method==='POST'){try{const s=await state();return J(res,200,{ok:s.done,...s}),true;}catch{return J(res,503,{error:'rpc'}),true;}}
    if(p==='/deploy-v53/prepare'&&req.method==='POST'){let b={};try{b=JSON.parse(await readRaw(req)||'{}');}catch{}try{const [c,o]=await prepare(b);return J(res,c,o),true;}catch{return J(res,503,{error:'rpc'}),true;}}
    if(p==='/deploy-v53/paymaster'){const cors={'access-control-allow-origin':'*','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','cache-control':'no-store'};
      if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return true;}
      if(req.method!=='POST'||!sponsor?.enabled)return J(res,404,{error:'not_found'},cors),true;
      const id=String(u.searchParams.get('id')??'');if(!id.startsWith(DEPLOY_V53_PREFIX))return J(res,404,{error:'not_found'},cors),true;
      let b;try{b=JSON.parse(await readRaw(req,maxBody)||'{}');}catch(e){return J(res,e?.status===413?413:400,{error:e?.status===413?'too_large':'bad_json'},cors),true;}
      const r=await sponsor.rpc(id,b,{lang:String(req.headers?.['accept-language']??'zh').split(',')[0]});return J(res,200,r,cors),true;}
    return false;}
  return {handle,state,open,prepare,calls:step=>CALLS[step],commitment:step=>commitment({chainId:8453,from:OWNER,calls:CALLS[step]}),fragment:()=>deployV53Fragment(plan,OWNER)};}
