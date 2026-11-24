// SPDX-License-Identifier: AGPL-3.0-only
// ONE-TIME SETUP ("开通"): ONE owner signature, ONE atomic batch, ONE gas payment, sent from the owner's own Base Account
// (gas in USDC via the Base Account's paymaster, or its ETH; Kipurse never sponsors or refunds). The batch:
//   1. deploy the phone approver (V2: Face ID trust approvals + owner payments = Siri)  [deterministic deployer, CREATE2]
//   2. wallet.executeBatch(spend permission + caps plan: revoke old / approve new / register the gas-payer vault)
//   3. wallet.addOwnerAddress(approver)
//   4. wallet.removeOwnerAtIndex(...) for every dead approver still on the wallet (earlier phones, erased data)
// Nothing changes unless the whole batch lands. confirm() then checks everything ON CHAIN before switching the runtime.
// Siri needs no extra on-chain step: it is enabled by the V2 approver (+ the operator's owner-pay flag).
import {langOf,X} from './i18n.mjs';import {randomBytes} from 'node:crypto';import {getAddress,encodeFunctionData,parseAbi} from 'viem';
import {approverInit,DETERMINISTIC_DEPLOYER,WALLET_ABI,fingerprint,ETH_USD_FEED,L1_ALLOWANCE_WEI} from './phone-signer.mjs';import {checkLimits,STRANGER_CAPS_API} from './limits-public.mjs';
import {ownAddrHtml} from './addr-display.mjs';import {scrubUrls} from './store.mjs';import {selfCall,assertNoTopLevelOwnerCall} from './owner-selfcall.mjs';
export const ONBOARD_GAS=2_300_000n;  // measured on a Base fork, see test/fork/onboard-fork.e2e.mjs (re-setup ~2.0M; new wallet incl. vault ~2.2M)
const FEED_ABI=parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)']);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=a=>{const n=BigInt(a),w=n/1000000n,f=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
const J=x=>JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v).replace(/</g,'\\u003c');
/** Pure: estimated network fee the Base Account pays (no margin, no refund): gas*price + L1 allowance, in wei and USDC (6dp, ceil). */
export function onboardFee({gas=ONBOARD_GAS,gasPriceWei,ethUsd8,l1Wei=L1_ALLOWANCE_WEI}){const wei=BigInt(gas)*BigInt(gasPriceWei)+BigInt(l1Wei);return {wei,usdc:(wei*BigInt(ethUsd8)+10n**20n-1n)/10n**20n};}
/** t1265: what a caller sees of an error: our own snake_case code (+ our own text, URLs scrubbed); anything else (RPC, library) only 'failed'. */
export function publicError(e){const own=typeof e?.code==='string'&&/^[a-z][a-z0-9_]{1,40}$/.test(e.code);
  return own?{error:e.code,detail:scrubUrls(String(e.message??'')).slice(0,200)}:{error:'failed'};}
export function createOnboarding({verified=null,S,save,pub,wallet,owner,trust,chainId=8453,base,phone,plan,confirmPlan,approverVersion='v2',ownerPay=()=>false,token,feed=ETH_USD_FEED,script,enabled=false,keyProof=null}){
  const W=getAddress(wallet),OWNER=getAddress(owner);S.onboard??={};const O=()=>S.onboard;
  const gc=()=>{const n=Date.now();for(const [k,v] of Object.entries(O()))if(v.exp<n)delete O()[k];};
  async function quote(){const [gp,rd,eth,bal]=await Promise.all([pub.getGasPrice(),pub.readContract({address:feed,abi:FEED_ABI,functionName:'latestRoundData'}),pub.getBalance({address:OWNER}),
      token?pub.readContract({address:token,abi:ERC20,functionName:'balanceOf',args:[OWNER]}):Promise.resolve(null)]);
    const f=onboardFee({gasPriceWei:gp,ethUsd8:rd[1]});
    return {gas:ONBOARD_GAS.toString(),gasPriceWei:gp.toString(),feeWei:f.wei.toString(),feeUSDC:usd(f.usdc>0n?f.usdc:1n),payer:OWNER,payerEthWei:eth.toString(),payerUSDC:bal===null?null:bal.toString(),
      payerCanPayEth:eth>=f.wei,payerCanPayUSDC:bal===null?null:bal>=f.usdc+(f.usdc/2n),sponsoredByKipurse:false,includesPhoneApprover:true,signatures:1,transactions:1};}
  /** The ordered call list for ONE wallet_sendCalls (atomicRequired) from the Base Account. */
  function batch({approver,plan:pl,remove}){return assertNoTopLevelOwnerCall([{to:DETERMINISTIC_DEPLOYER,value:'0x0',data:approver.deployData,label:'deploy phone approver ('+approverVersion+')'},
    {to:W,value:'0x0',data:pl.walletExecuteBatch.data,label:'spend permission + caps: '+pl.calls.map(c=>c.label).join(' · ')},
    selfCall(W,encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[approver.address]}),'add the phone approver as a scoped owner'),   // t1238 §6#106: self-call
    ...remove.map(r=>({...phone.removeCall(r),label:'remove dead approver '+r.approver}))]);}
  // t1109u (0A/0B/t763u): every (re)opening needs the owner's Coinbase Verified Account attestation; fails closed, nothing charged.
  async function cbvOk(){if(typeof verified!=='function')return {verified:false,reason:'unavailable'};try{return await verified(OWNER);}catch{return {verified:false,reason:'unavailable'};}}
  async function start({x,y,single,daily,term,days,openSingle,openDaily}){gc();
    {const v=await cbvOk();if(!v?.verified)throw Object.assign(Error(v?.reason==='unavailable'?'Coinbase verification check is unavailable; nothing was charged. Try again.':'This Base Account has no Coinbase Verified Account attestation yet. Nothing was charged.'),{code:v?.reason==='unavailable'?'verify_unavailable':'not_verified'});}
    /* t1265: the pending cap counts per requester (the proven phone key): at most 2 open setups per key (the oldest is replaced), and the
       wallet-wide cap (20) only holds proven requesters, so nobody without the owner's proof can fill it and block the owner. */
    {const fp=fingerprint(x,y);const mine=Object.entries(O()).filter(([,v])=>v.fingerprint===fp).sort((a,b)=>a[1].exp-b[1].exp);
      while(mine.length>=2){delete O()[mine.shift()[0]];}if(Object.keys(O()).length>=20)throw Object.assign(Error('too many pending setups'),{code:'busy'});}
    const c=checkLimits({single,daily,term,days:days??90,openSingle,openDaily});if(c.error)throw Object.assign(Error(c.detail),{code:c.error});/* t1281: owner's stranger limits ride to plan() */
    const quoted=await quote();if(quoted.payerCanPayUSDC===false)throw Object.assign(Error('USDC 不够付开户和这台手机钥匙这一笔，已停止，没有扣钱。'),{code:'needs_usdc'});
    const pl=await plan(c);const a=approverInit({wallet:W,trust,x,y,maxSingle:c.single,maxDaily:c.daily,version:approverVersion});
    // dead approvers + the current/retiring approver (a new key replaces it), never the new one
    const seen=new Set([getAddress(a.address)]);const remove=[];for(const r of await phone.deadOwners(a.address))if(!seen.has(r.approver)){seen.add(r.approver);remove.push(r);}
    for(const r of [phone.active(),phone.retiring()])if(r?.approver&&!seen.has(getAddress(r.approver))){const i=await phone.findIndex(r.approver);if(i>=0){seen.add(getAddress(r.approver));remove.push({approver:getAddress(r.approver),index:i});}}
    const pid=phone.addPending({x,y,remove:[],maxSingle:c.single.toString(),maxDaily:c.daily.toString(),approver:a.address,version:approverVersion});
    const id=randomBytes(12).toString('hex');O()[id]={pid,plan:pl,remove,approver:a.address,fingerprint:fingerprint(x,y),choice:{single:c.single.toString(),daily:c.daily.toString(),term:c.term.toString(),days:c.days},exp:Date.now()+30*60e3};save();
    const calls=batch({approver:a,plan:pl,remove});O()[id].calls=calls.map(({to,value,data})=>({to,value,data}));save();
    return {id,url:`${base()}/onboard?id=${id}`,approver:a.address,fingerprint:fingerprint(x,y),removes:remove.map(r=>r.approver),labels:calls.map(c=>c.label),calls:O()[id].calls,quote:quoted};}
  async function confirm(id){const o=O()[id];if(!o)throw Object.assign(Error('unknown or expired setup'),{code:'unknown'});
    const ph=await phone.confirm(o.pid);if(!ph.ok)return {ok:false,detail:ph.detail};
    const pv=await confirmPlan(o.plan);if(!pv.valid)return {ok:false,detail:'permission not valid on chain yet'};
    await phone.retiringConfirm();const left=await phone.pruneDead();
    delete O()[id];save();const pc=await phone.payCapable();
    return {ok:true,approver:ph.approver,fingerprint:ph.fingerprint,permissionHash:pv.permissionHash,deadLeft:left,siri:pc.ok&&ownerPay(),faceIdApprovals:true};}
  function page(o,nonce,lang){const L=o.calls.length,t=X(lang);return `<!doctype html><html lang=${lang}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${t('开通 Kipurse','Set up Kipurse')}</title>
<style>body{margin:0;background:#F2F2F7;color:#111;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}.w{max-width:480px;margin:0 auto;padding:22px 18px 40px}.c{background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0}.t{font-size:24px;font-weight:700;margin:10px 0}.fp{font:700 26px ui-monospace,monospace;letter-spacing:1px;text-align:center;padding:10px;background:#EEF;border-radius:12px}.mono{font:13px ui-monospace,monospace;word-break:break-all}.m{color:#666;font-size:14px}button{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px;background:#5B4CF0;color:#fff}</style>
<div style="background:#c00;color:#fff;text-align:center;font-weight:700;padding:8px">${t('Base 主网','Base Mainnet')}</div><div class=w><div class=t>${t('开通 Kipurse：一次确认','Set up Kipurse: one signature')}</div>
<p>${t('先核对：下面这串字符必须和 Kipurse App 里显示的<b>完全一样</b>。','First check: this code must <b>exactly</b> match the one in the Kipurse app.')}</p><div class=fp>${esc(o.fingerprint)}</div>
<div class=c><b>${t(`这一笔确认里同时完成（${L} 步，要么全成，要么全不变）`,`This one signature does all of this (${L} steps, all or nothing)`)}</b><ul><li>${t(`AI 花钱上限：每笔 ${usd(o.choice.single)} · 每天 ${usd(o.choice.daily)} · 总额 ${usd(o.choice.term)} USDC · ${esc(o.choice.days)} 天`,`AI spending limits: ${usd(o.choice.single)} per payment · ${usd(o.choice.daily)} per day · ${usd(o.choice.term)} USDC total · ${esc(o.choice.days)} days`)}</li><li>${t(`这台 iPhone 成为受限确认人：Face ID 批准收款方${approverVersion!=='v1'?'、Siri 付款':''}（不能转走钱、不能改上限）`,`This iPhone becomes a limited signer: Face ID approves payees${approverVersion!=='v1'?' and Siri payments':''} (it can’t move money out or change limits)`)}</li>${o.remove.length?`<li>${t(`移除 ${o.remove.length} 个作废的旧手机确认人`,`Removes ${o.remove.length} old phone signer(s)`)}</li>`:''}</ul><div class=m>${t('钱包','Wallet')}</div><div class=mono>${ownAddrHtml(W,t)}</div></div>
<div class=c><b>${t('手续费：只有这一笔，由你的 Base Account 支付','Network fee: just this one, paid by your Base Account')}</b><div class=m id=fee>${t('Base Account 会显示准确金额，用 USDC 支付，不需要 ETH。Kipurse 不出钱、不代付、不再另收。','Base Account shows the exact amount, paid in USDC (no ETH needed). Kipurse pays nothing and charges nothing extra.')}</div></div>
<button id=go>${t('核对无误，用 Base Account 确认','Looks right — sign with Base Account')}</button><p class=m id=st>${t('需要一次 Base Account 确认。','Needs one Base Account signature.')}</p></div>
<script type="application/json" id=kp-data>${J({mode:'enroll',id:o.__id,owner:OWNER,chainId,calls:o.calls})}</script><script nonce="${nonce}" src="/owner/limits-done.js?v=20261022b"></script><script nonce="${nonce}" src="/onboard.js"></script></html>`;}
  async function handle(req,res,u,{readBody}){const p=u.pathname;if(p!=='/onboard'&&!p.startsWith('/onboard/')&&p!=='/onboard.js')return false;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(o,(k,v)=>typeof v==='bigint'?v.toString():v));};
    if(!enabled){json(404,{error:'onboard_disabled'});return true;}
    const nonce=randomBytes(12).toString('base64url');
    try{if(p==='/onboard.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(script());return true;}
      if(p==='/onboard/quote'&&req.method==='GET'){json(200,{...await quote(),strangerCaps:STRANGER_CAPS_API/* t1281 */});return true;}
      /* t1265 (same rule as /phone/enroll, t1240 F1): a re-setup link carrying a phone key is created ONLY for a requester who proves the owner -
         a live phone session of this wallet, or this exact key was just signed in with the owner's Coinbase account (sign-in read grant).
         Without it anyone could mint a real-domain "set up Kipurse" page that adds THEIR key to someone else's wallet (phishing). */
      if(p==='/onboard/start'&&req.method==='POST'){const b=await readBody(req);
        let proven=false;try{proven=typeof keyProof==='function'&&!!(await keyProof(req,{x:String(b.x),y:String(b.y)}));}catch{proven=false;}
        if(!proven){json(401,{error:'sign_in_first'});return true;}
        json(200,await start({x:String(b.x),y:String(b.y),single:b.single,daily:b.daily,term:b.term,days:b.days,openSingle:b.openSingle,openDaily:b.openDaily}));return true;}
      if(p==='/onboard/confirm'&&req.method==='POST'){const b=await readBody(req);json(200,await confirm(String(b.id??'')));return true;}
      if(p==='/onboard'&&req.method==='GET'){gc();const id=String(u.searchParams.get('id')??'');const o=O()[id];
        res.writeHead(o?200:404,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer',
          'content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; form-action 'none'; frame-ancestors 'none'`});
        {const lang=langOf(req,u);res.end(o?page({...o,__id:id},nonce,lang):`<!doctype html><html lang=${lang}><meta charset=utf-8><p>${X(lang)('这个开通请求不存在或已过期，请回 App 重新点「开通」。','This setup request doesn’t exist or has expired. Go back to the app and tap “Set up” again.')}</p></html>`);}return true;}
      json(404,{error:'not_found'});return true;}catch(e){json(400,publicError(e));return true;}}
  return {handle,start,confirm,quote,batch};}
