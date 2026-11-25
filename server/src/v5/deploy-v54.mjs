// SPDX-License-Identifier: AGPL-3.0-only
// t1214 (decision 102, owner t1230 "[zh]"; decision 101 owner t1227 "[zh]"): ONE-TIME page that lets the owner's
// own Base Account confirm exactly ONE fixed batch, the same practical way as the V5.3 deploy (decision 87–89):
//   1. deterministic deployer 0x4e59 <- V5.4 adapter init code   (CREATE2 -> 0x99D8…7Aaa; the adapter creates its KipurseTrustV54)
//   2. USDC.transfer(Kipurse fee address, 0.15 USDC)                - the fee, from the owner's own Base Account USDC, never ETH
// This is the DEVELOPER's own contract deploy (0A#9.1): Kipurse's paymaster fronts the gas for this exact batch only (callsHash) and the
// batch repays it in USDC. Refuses any other batch (server: exact calls + sponsor callsHash; browser: KPVH #vh commitment + pins), and is
// inert once the adapter has code. OFF unless KIPURSE_DEPLOY_V54=1 (the page/route does not exist otherwise). Nothing here touches any
// wallet, key, permission or ledger. One confirmation: Coinbase's estimator handles it (read-only CDP estimate 2026-11-19: call 9,493,432 /
// verification 115,179 / pre-verification 618,155; stub + final paymaster data OK; simulateHandleOp with those limits executes the batch).
// Before handing the batch to the page, prepare() asks the sponsor for stub data on the exact op (preflight): if Coinbase would not front
// the gas, the page shows a calm line and no button, so Coinbase never offers to take ETH instead (decision 90/#91 lesson).
import fs from 'node:fs';import {createHash,randomBytes} from 'node:crypto';
import {getAddress,getContractAddress,slice,encodeFunctionData,parseAbi,encodeAbiParameters,toHex} from 'viem';
import {langOf,X} from './i18n.mjs';import {USDC_BASE,KIPURSE_FEE_TO,USDC_GAS_APPROVE_CAP} from './usdc-gas.mjs';import {commitment} from './batch-commit.mjs';
export const DEPLOY_V54_PREFIX='dv54-';
export const DEPLOYER='0x4e59b44847b379578588920cA78FbF26c0B4956C';
export const deployV54On=(env=process.env)=>String(env.KIPURSE_DEPLOY_V54??'').trim()==='1';
/** Fixed fee (6 dp). Real cost ~10.2M gas (CDP limits 9.49M + 0.12M + 0.62M) ≈ 0.11 USD at 0.006 gwei / 1,735 USD/ETH; 0.15 leaves headroom
 *  (same amount the V5.3 adapter step paid for a contract of the same size class). */
export const DEPLOY_V54_FEE_USDC=150_000n;
/** Realistic gas of the sponsored op for the 'underpaid' re-check (x1.1 there): CDP estimate sum 10,226,766, rounded up. */
export const DEPLOY_V54_REAL_GAS=10_300_000n;
/** Worst case (all limits x maxFeePerGas) Kipurse may front for THIS op only (same as V5.3); the batch repays the real cost. */
export const DEPLOY_V54_MAX_USD_PER_OP=1;
export const V54_PIN=Object.freeze({adapter:'0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa',initCodeKeccak:'0x7c8635e4c877d803dbf643475133655d00c67ebf524d8f50693d004cd57883c5',
  sha256:'896ff350a8d71c6a0dd88e348f421b94954ccfad21e3e805c924105a7e2b6a23'});
const sha=h=>createHash('sha256').update(Buffer.from(String(h).replace(/^0x/,''),'hex')).digest('hex');
/** Load + verify the fixed plan: exactly one step, to the deployer, sha256-pinned, CREATE2 address = the pinned address. Throws otherwise. */
export function loadV54Plan(src){const D=typeof src==='string'?JSON.parse(fs.readFileSync(src,'utf8')):src;const S=D?.steps;
  if(!Array.isArray(S)||S.length!==1)throw Error('v54 plan: need exactly 1 step');const s=S[0];
  if(getAddress(s.to)!==DEPLOYER)throw Error('v54 plan: not to the deployer');
  if(!/^0x[0-9a-fA-F]+$/.test(String(s.data))||sha(s.data)!==V54_PIN.sha256)throw Error('v54 plan: data hash');
  const a=getContractAddress({opcode:'CREATE2',from:DEPLOYER,salt:slice(s.data,0,32),bytecode:slice(s.data,32)});
  if(a!==getAddress(V54_PIN.adapter)||getAddress(s.address)!==a)throw Error('v54 plan: address');
  return {adapter:a,step:{label:String(s.label??''),to:DEPLOYER,address:a,data:String(s.data).toLowerCase()}};}
const TRA=parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
/** The one batch: deployer <- adapter init code, then the USDC fee leg from the owner's Base Account to the fixed fee address. */
export function deployV54Calls(plan){const f=DEPLOY_V54_FEE_USDC;if(f<=0n||f>USDC_GAS_APPROVE_CAP)throw Error('fee');
  return [{to:plan.step.to,value:'0x0',data:plan.step.data},{to:getAddress(USDC_BASE),value:'0x0',data:encodeFunctionData({abi:TRA,functionName:'transfer',args:[getAddress(KIPURSE_FEE_TO),f]})}];}
export const deployV54Commitment=(plan,owner)=>commitment({chainId:8453,from:getAddress(owner),calls:deployV54Calls(plan)});
export const deployV54Fragment=(plan,owner)=>'vh='+deployV54Commitment(plan,owner);
const EP06='0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const EXB=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);
const NONCE=parseAbi(['function getNonce(address sender,uint192 key) view returns (uint256)']);
/** Stub signature in the Coinbase Smart Wallet / Base Account shape (owner index 0), only for the sponsor's stub-data preflight. */
const STUB_SIG=encodeAbiParameters([{type:'tuple',components:[{name:'ownerIndex',type:'uint8'},{name:'signatureData',type:'bytes'}]}],[{ownerIndex:0,signatureData:'0x'+'ff'.repeat(65)}]);
const fmt=a=>{a=BigInt(a);const i=a/1_000_000n,f=(a%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');return String(i)+(f?'.'+(f.length<2?f.padEnd(2,'0'):f):'');};
const short=a=>a.slice(0,6)+'…'+a.slice(-4);
/** deps: plan (loadV54Plan), owner (the owner's Base Account), pub (getCode/readContract/getGasPrice), sponsor (registerDeployV54/rpc),
 *  ethUsd8 async()=>bigint, script ()=>bundle, base ()=>public origin. */
export function createDeployV54({plan,owner,pub,sponsor,ethUsd8=null,script=()=>'',base=()=>'https://pay.kipurse.com',maxBody=196608,readRaw}){
  const OWNER=getAddress(owner);const CALLS=deployV54Calls(plan);
  async function state(){const c=await pub.getCode({address:plan.adapter});const done=!!c&&c!=='0x';return {adapter:done,done};}
  /** Sponsor gate: fundable only while the adapter is not on chain yet. */
  async function open(){return !(await state()).done;}
  async function realUsd(){try{const [gp,p]=await Promise.all([pub.getGasPrice(),ethUsd8?ethUsd8():null]);if(!p)return null;return Number(DEPLOY_V54_REAL_GAS*BigInt(gp)*BigInt(p)/10n**18n)/1e8;}catch{return null;}}
  /** Ask the sponsor (through the same gate the wallet will use) for stub data on the exact op. Any refusal -> not offered. */
  async function preflight(id){if(!sponsor?.rpc)return false;let nonce;try{nonce=await pub.readContract({address:EP06,abi:NONCE,functionName:'getNonce',args:[OWNER,0n]});}catch{return false;}
    const gp=await pub.getGasPrice().catch(()=>6_000_000n);
    const op={sender:OWNER,nonce:toHex(nonce),initCode:'0x',callData:encodeFunctionData({abi:EXB,functionName:'executeBatch',args:[CALLS.map(c=>({target:c.to,value:0n,data:c.data}))]}),
      callGasLimit:'0x0',verificationGasLimit:'0x0',preVerificationGas:'0x0',maxFeePerGas:toHex(BigInt(gp)*2n),maxPriorityFeePerGas:toHex(BigInt(gp)/10n||1n),paymasterAndData:'0x',signature:STUB_SIG};
    try{const r=await sponsor.rpc(id,{jsonrpc:'2.0',id:1,method:'pm_getPaymasterStubData',params:[op,EP06,'0x2105',{}]},{lang:'en'});return !!r?.result&&!r.error;}catch{return false;}}
  async function prepare(b){const s=await state();if(s.done)return [200,{done:true}];
    let from;try{from=getAddress(String(b?.from??''));}catch{return [400,{error:'not_owner'}];}if(from!==OWNER)return [400,{error:'not_owner'}];
    try{const bal=await pub.readContract({address:getAddress(USDC_BASE),abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[OWNER]});if(BigInt(bal)<DEPLOY_V54_FEE_USDC)return [409,{error:'needs_usdc'}];}catch{return [503,{error:'rpc'}];}
    const id=sponsor?.registerDeployV54?.(randomBytes(12).toString('hex'),{owner:OWNER,calls:CALLS,reimburse:DEPLOY_V54_FEE_USDC,realGas:DEPLOY_V54_REAL_GAS});if(!id)return [503,{error:'unavailable'}];
    if(!(await preflight(id)))return [503,{error:'unavailable'}];
    return [200,{id,chainId:8453,from:OWNER,calls:CALLS,paymaster:`${base()}/deploy-v54/paymaster?id=${id}`}];}
  const J=(res,c,o,h={})=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store',...h});res.end(JSON.stringify(o));};
  async function page(lang,nonce){const t=X(lang),s=await state(),u=await realUsd();const css=`body{margin:0;background:#F2F2F7;color:#111;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}.w{max-width:480px;margin:0 auto;padding:24px 18px 40px}.c{background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0}.t{font-size:24px;font-weight:700;margin:8px 0 4px}.m{color:#666;font-size:14px}.big{font-size:28px;font-weight:700}code{font-size:13px;word-break:break-all}button{display:block;box-sizing:border-box;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px;background:#0052FF;color:#fff}`;
    const head=`<!doctype html><html lang=${lang}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=referrer content=no-referrer><title>${t('部署启付 V5.4 合约','Deploy the Kipurse V5.4 contract')}</title><style>${css}</style><div class=w>
<div class=t>${t('部署启付 V5.4 合约（一次性）','Deploy the Kipurse V5.4 contract (one time)')}</div>`;
    if(s.done)return head+`<div class=c id=done><b>✅ ${t('V5.4 合约已经在 Base 上了。','The V5.4 contract is already on Base.')}</b><div class=m>${t('这个页面已经完成任务，不需要再做什么，可以关掉。','This page has done its job. Nothing else to do; you can close it.')}</div></div></div></html>`;
    const data=JSON.stringify({owner:OWNER,chainId:8453,prepare:'/deploy-v54/prepare',confirm:'/deploy-v54/confirm',feeTo:getAddress(KIPURSE_FEE_TO),fee:String(DEPLOY_V54_FEE_USDC),pin:V54_PIN}).replace(/</g,'\\u003c');
    return head+`<div class=c id=what><b>${t('这一步做什么','What this does')}</b><div>${t('在 Base 上放一份启付 V5.4 公共合约（AI 付款适配器，可以「信任商家的下单身份」）。它会自动建好自己的信任合约。','Places one public Kipurse V5.4 contract on Base (the AI payment adapter with “trust a merchant’s signer”). It sets up its own trust contract.')}</div>
<div class=m>${t('它不能动你的钱。你现在的启付钱包不会被改动，继续照常使用；换到 V5.4 是之后单独的一步。','It cannot move your money. Your current Kipurse wallet is not changed and keeps working; switching it to V5.4 is a separate later step.')}</div>
<div class=m>${t('适配器','Adapter')} <code>${plan.adapter}</code><br>${t('通过公开部署器','Via the public deployer')} <code>${DEPLOYER}</code></div></div>
<div class=c id=fee><div class=m>${t('手续费','Fee')}</div><div class=big>${fmt(DEPLOY_V54_FEE_USDC)} USDC</div><div class=m>${t(`从你的 Base 账户（${short(OWNER)}）里的 USDC 付，不用 ETH。`,`From the USDC in your Base Account (${short(OWNER)}). No ETH needed.`)}${u!=null?' '+t(`Base 上的实际成本现在约 ${u.toFixed(2)} 美元，多留一点余量以防网络变忙。`,`The actual cost on Base is about $${u.toFixed(2)} right now; the rest is headroom in case the network gets busy.`):''}</div></div>
<div class=c id=how><div class=m>${t('在 Coinbase 里确认一次。确认后大约 10–60 秒完成。内容不一致、或者 Coinbase 现在不能用 USDC 付手续费时，页面会停下，不会提交，也不会让你用 ETH 付。','Confirm once in Coinbase. It takes about 10–60 seconds after you confirm. If anything differs, or Coinbase cannot take the fee in USDC right now, this page stops and submits nothing, and never asks you to pay in ETH.')}</div></div>
<div class=c id=safari style="display:none"><b>${t('请在 Safari 里打开这个页面','Please open this page in Safari')}</b><div class=m>${t('你现在是在别的 App 里看这个页面。Coinbase 的确认窗口在这里打不开，所以按钮先藏起来了，什么都没有发生。','You are viewing this page inside another app. The Coinbase confirmation window cannot open here, so the button is hidden. Nothing has happened.')}</div>
<div class=m>${t('点「在 Safari 中打开」；如果没反应，点「复制链接」，打开 Safari，粘贴到地址栏。','Tap “Open in Safari”. If nothing happens, tap “Copy link”, open Safari and paste it into the address bar.')}</div>
<button id=osf>${t('在 Safari 中打开','Open in Safari')}</button><button id=cpl style="background:#EEF2FF;color:#0052FF">${t('复制链接','Copy link')}</button><p class=m id=cps></p></div>
<button id=go>${t('在 Coinbase 里确认部署','Confirm the deploy in Coinbase')}</button><p class=m id=st></p>
<div class=c id=help style="display:none"><div class=m>${t('如果 Coinbase 窗口没打开、显示出错，或者一直转圈：先关掉那个窗口回到这里。这个页面需要在 iPhone 的 Safari 里打开（不要在 Grok Bot 或其他 App 里直接点开）。没有扣任何钱。如果 Coinbase 提示要用 ETH 付手续费，请取消。','If the Coinbase window did not open, showed an error, or keeps spinning: close it and come back here. This page needs to be open in Safari on your iPhone (not inside Grok Bot or another app). No money was taken. If Coinbase asks to pay the network fee in ETH, cancel.')}</div><button id=cpl2 style="background:#EEF2FF;color:#0052FF">${t('复制链接','Copy link')}</button></div>
<script type="application/json" id=kp-data>${data}</script><script nonce="${nonce}" src="/deploy-v54.js"></script></div></html>`;}
  async function handle(req,res,u){const p=u.pathname;
    if(p==='/deploy-v54'&&(req.method==='GET'||req.method==='HEAD')){
      const lang=langOf(req,u),nonce=randomBytes(16).toString('base64');let html;try{html=await page(lang,nonce);}catch{return J(res,503,{error:'rpc'}),true;}
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; form-action 'none'; frame-ancestors 'none'`});res.end(req.method==='HEAD'?undefined:html);return true;}
    if(p==='/deploy-v54.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(script());return true;}
    if(p==='/deploy-v54/status'&&req.method==='GET'){try{return J(res,200,await state()),true;}catch{return J(res,503,{error:'rpc'}),true;}}
    if(p==='/deploy-v54/confirm'&&req.method==='POST'){try{const s=await state();return J(res,200,{ok:s.done,...s}),true;}catch{return J(res,503,{error:'rpc'}),true;}}
    if(p==='/deploy-v54/prepare'&&req.method==='POST'){let b={};try{b=JSON.parse(await readRaw(req)||'{}');}catch{}try{const [c,o]=await prepare(b);return J(res,c,o),true;}catch{return J(res,503,{error:'rpc'}),true;}}
    if(p==='/deploy-v54/paymaster'){const cors={'access-control-allow-origin':'*','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','cache-control':'no-store'};
      if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return true;}
      if(req.method!=='POST'||!sponsor?.enabled)return J(res,404,{error:'not_found'},cors),true;
      const id=String(u.searchParams.get('id')??'');if(!id.startsWith(DEPLOY_V54_PREFIX))return J(res,404,{error:'not_found'},cors),true;
      let b;try{b=JSON.parse(await readRaw(req,maxBody)||'{}');}catch(e){return J(res,e?.status===413?413:400,{error:e?.status===413?'too_large':'bad_json'},cors),true;}
      const r=await sponsor.rpc(id,b,{lang:String(req.headers?.['accept-language']??'zh').split(',')[0]});return J(res,200,r,cors),true;}
    return false;}
  return {handle,state,open,prepare,preflight,calls:()=>CALLS,commitment:()=>commitment({chainId:8453,from:OWNER,calls:CALLS}),fragment:()=>deployV54Fragment(plan,OWNER)};}
