// SPDX-License-Identifier: AGPL-3.0-only
// PUBLIC, SIGNATURE-GATED LIMITS PAGE (mainnet). The owner picks per-payment / daily / total caps in the app; this page builds the ONE
// wallet batch for exactly those numbers and the owner sends it from HIS Base Account. Nothing changes unless that batch lands on chain:
// confirm only swaps the runtime to the new permission once it is valid ON CHAIN. No key here; anyone can open the page, only the owner can sign.
import {langOf,X,en} from './i18n.mjs';import {randomBytes} from 'node:crypto';
import {rewritePaymasterBody,sanitizePaymasterResponse,erc20PaymasterURL} from './limits-fee.mjs';
const J=x=>JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=a=>{const n=BigInt(a),w=n/1000000n,f=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
/** "12.5" -> 12500000n ; null if not a positive USDC amount with <= 6 decimals. */
export const parseUsdc=v=>{const s=String(v??'').trim();if(!/^\d{1,7}(\.\d{1,6})?$/.test(s))return null;const [w,f='']=s.split('.');const n=BigInt(w)*1000000n+BigInt(f.padEnd(6,'0'));return n>0n?n:null;};
export const LIMITS_MAX_TERM=1000000n*1000000n;
/** Validates the owner's choice. days: 1..365 (new end = now + days) or undefined (keep the current end). */
export function checkLimits({single,daily,term,days}){const s=parseUsdc(single),d=parseUsdc(daily),t=parseUsdc(term);
  if(s===null||d===null||t===null)return {error:'bad_amount',detail:'每笔、每天、总额都要是正数（最多 6 位小数）'};
  if(s>d)return {error:'single_above_daily',detail:'每笔不能大于每天'};if(d>t)return {error:'daily_above_term',detail:'每天不能大于总额'};
  if(t>LIMITS_MAX_TERM)return {error:'term_too_high',detail:'总额最多 1,000,000 USDC（一百万）'};
  let dd;if(days!==undefined&&days!==''&&days!==null){dd=Number(days);if(!Number.isInteger(dd)||dd<1||dd>365)return {error:'bad_days',detail:'期限 1–365 天'};}
  return {single:s,daily:d,term:t,days:dd};}
/** Permission window for a limits change: start a little in the past (clock skew), end = start + days (NOT now + days), so period <= 365 days exactly. */
export const LIMITS_START_SKEW=30;
export function limitsWindow(chainNowSec,days,curEnd){const start=Number(chainNowSec)-LIMITS_START_SKEW;const end=days?start+Number(days)*86400:Number(curEnd);return {start,end};}
/** Success: animated overlay (new caps + real on-chain start/end in the phone's local time), then kipurse://limits-updated?... so the app
 *  (ASWebAuthenticationSession / sheet) closes itself and refreshes. A tap-able fallback appears only if we are still here after 3 s. */
export const limitsDoneUrl=j=>'kipurse://limits-updated?'+new URLSearchParams({single:j.single,daily:j.daily,term:j.term,start:j.start,end:j.end});
export const LIMITS_DONE_JS=`(()=>{const Z=document.documentElement.lang==='zh',L=(z,e)=>Z?z:e;const u=a=>{a=BigInt(a||0);const w=a/1000000n,f=(a%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return (f?w+'.'+f:''+w)+' USDC';};
const t=s=>{const d=new Date(Number(s)*1000),p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());};
let o=null;const hideForm=()=>document.querySelectorAll('.b.g,#go,.w > .c,.w > .t,.w > .s,.w > .m').forEach(e=>e.style.display='none');
const view=(icon,title,lines,note)=>{if(!o){o=document.createElement('div');o.id='kp-ov';o.setAttribute('style','position:fixed;inset:0;z-index:9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--bg,#F2F2F7);text-align:center;padding:24px');document.body.appendChild(o);}
  o.innerHTML='<style>@keyframes kpSpin{to{transform:rotate(360deg)}}@keyframes kpPop{0%{transform:scale(.3);opacity:0}60%{transform:scale(1.12);opacity:1}100%{transform:scale(1)}}@keyframes kpDraw{to{stroke-dashoffset:0}}</style>'+icon
  +'<div id=kp-title style="font-size:24px;font-weight:700"></div><div id=kp-v style="font-size:16px;line-height:1.7"></div><div class=m id=kp-note></div>';
  o.querySelector('#kp-title').textContent=title;const v=o.querySelector('#kp-v');(lines||[]).forEach(x=>{const r=document.createElement('div');r.textContent=x;v.appendChild(r);});o.querySelector('#kp-note').textContent=note||'';return o;};
const SPIN='<div style="width:72px;height:72px;border-radius:50%;border:7px solid rgba(91,76,240,.18);border-top-color:#5B4CF0;animation:kpSpin .9s linear infinite"></div>';
const OK='<svg width=96 height=96 viewBox="0 0 96 96" style="animation:kpPop .5s ease-out both"><circle cx=48 cy=48 r=44 fill="#0B6E4F"/><path d="M28 50l14 14 26-30" fill=none stroke="#fff" stroke-width=8 stroke-linecap=round stroke-linejoin=round stroke-dasharray=80 stroke-dashoffset=80 style="animation:kpDraw .45s .35s ease-out forwards"/></svg>';
const BAD='<div style="width:84px;height:84px;border-radius:50%;background:#c81e1e;color:#fff;font-size:52px;font-weight:700;line-height:84px">!</div>';
const btn=(txt,href,cls)=>{const b=document.createElement('a');b.className='b '+(cls||'p');b.href=href;b.textContent=txt;b.style.maxWidth='420px';b.style.width='100%';o.appendChild(b);return b;};
const back=href=>{setTimeout(()=>{location.href=href;},1600);setTimeout(()=>{o.querySelector('#kp-note').textContent=L('如果没有自动回去，点这里：','If it doesn\\u2019t go back by itself, tap here:');btn(L('回到 Kipurse','Back to Kipurse'),href);},3200);};
window.kpPending=x=>{try{hideForm();view(SPIN,L('授权中…','Authorizing…'),[],L('确认已提交，正在等 Base 链上确认（通常 10–60 秒）。可以留在这里，也可以回到 Kipurse。','Signature sent. Waiting for Base to confirm (usually 10–60 s). You can stay here or go back to Kipurse.'));
  if(x&&x.submitted&&x.id)fetch(x.submitted,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:x.id})}).catch(()=>{});}catch(e){}};
window.kpDone=j=>{try{const href=(${limitsDoneUrl.toString()})(j);hideForm();
  view(OK,L('授权完成','Authorized'),[L('每笔最多 ','Max per payment ')+u(j.single),L('每天最多 ','Max per day ')+u(j.daily),L('总额最多 ','Max total ')+u(j.term),L('生效时间 ','Starts ')+t(j.start),L('结束时间 ','Ends ')+t(j.end)],L('新 AI 付款上限已生效，正在回到 Kipurse…','New AI payment limits are active. Returning to Kipurse…'));if(navigator.vibrate)navigator.vibrate(30);back(href);}catch(e){}};
window.kpDoneMsg=mode=>{try{hideForm();view(OK,L('授权完成','Authorized'),[mode==='enroll'?L('这台手机已成为确认人，以后用 Face ID 批准','This phone is now a signer. Approve with Face ID from now on.'):L('手机确认已撤销','Phone signer revoked')],L('正在回到 Kipurse…','Returning to Kipurse…'));back('kipurse://done?phone='+(mode==='enroll'?'enrolled':'revoked'));}catch(e){}};
window.kpFail=m=>{try{if(!o)return;view(BAD,L('授权没有完成','Not authorized'),[m||L('还没看到链上结果。','Not on chain yet.')],L('没有扣钱。可以刷新再试，或回到 Kipurse 看结果。','Nothing was charged. Refresh to try again, or go back to Kipurse to check.'));
  const r=btn(L('刷新重试','Refresh and retry'),'#','p');r.onclick=ev=>{ev.preventDefault();location.reload();};btn(L('回到 Kipurse','Back to Kipurse'),'kipurse://done','g');}catch(e){}};})();`;
/** USDC-only gas (principle gasToken='USDC', t604u): a limits batch is handed out for signing ONLY with the free first-authorization
 *  sponsorship (paymaster) or when the owner's Base Account holds enough USDC to pay the fee itself. Never an ETH-funded path. */
/** Plain-language reason a limit change costs a small fee (t606u). */
export const WHY_FEE={zh:'为什么改上限要一点手续费：上限保存在区块链上，这样连我们也改不了；每改一次要付给网络一点手续费，我们不加价。',en:'Why changing limits costs a small fee: your limits live on the blockchain, so not even we can change them. Each change pays the network a tiny fee, and we add nothing on top.'};
export function gasRoute({pm,fee}){if(pm)return {route:'sponsored'};if(fee&&fee.canPayUSDC===true)return {route:'usdc'};return {route:null};}
export const fmtUsdc=a=>{a=BigInt(a);const w=a/1000000n,f=(a%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
export function createPublicLimits({plan,confirm,current,script,base,sponsor=()=>null,fee=async()=>null,feeQuote=null,refund=null,onConfirmed=()=>{},now=()=>Date.now(),pollMs=3000,pollTries=60,walletPaymaster=()=>null,paymasterFetch=null,erc20URL=null}){
  const erc20=()=>(erc20URL??erc20PaymasterURL)();
  const forward=paymasterFetch??(async body=>{const r=await fetch(erc20(),{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify(body)});return await r.json();});
  const prepared=new Map(),hits=new Map(),done=new Map();let pend=null;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const result=(pl,r)=>{const pm=pl?.permission??{},po=pl?.policy??{};return {ok:true,permissionHash:r.permissionHash,single:String(po.single??''),daily:String(po.daily??''),term:String(po.term??''),start:String(pm.start??''),end:String(pm.end??'')};};
  const finish=async id=>{const e=prepared.get(id);if(!e)return done.get(id)??null;const r=await confirm(e.plan.raw);if(!r?.valid)return null;try{onConfirmed({sponsored:!!e.pm,owner:e.plan.owner});}catch{}const out=result(e.plan.raw,r);done.set(id,out);prepared.delete(id);if(pend?.id===id)pend=null;return out;};
  const limited=(ip,max=20)=>{const n=now(),h=hits.get(ip)??[0,n];if(n-h[1]>60000){h[0]=0;h[1]=n;}h[0]++;hits.set(ip,h);return h[0]>max;};
  const gc=()=>{for(const [k,v] of prepared)if(!v.submittedAt&&now()-v.at>900000)prepared.delete(k);if(done.size>50)done.clear();};
  const shell=(inner,nonce,data,lang='zh')=>`<!doctype html><html lang=${lang}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${X(lang)('修改上限','Change limits')}</title>
<style>:root{--a:#5B4CF0;--bg:#F2F2F7;--card:#fff;--t:#111;--s:#6b6b78;color-scheme:light dark}@media(prefers-color-scheme:dark){:root{--a:#8B7CFF;--bg:#000;--card:#1c1c1e;--t:#f5f5f7;--s:#9a9aa5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:17px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.w{max-width:460px;margin:0 auto;padding:24px 20px 40px}
.t{font-size:26px;font-weight:700;margin:6px 0 4px}.s{color:var(--s);margin:0 0 12px}.c{background:var(--card);border-radius:18px;padding:6px 16px;margin:12px 0}.row{display:flex;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid rgba(128,128,128,.2)}.row:last-child{border:0}
.n{font-weight:600;text-align:right}.o{color:var(--s);font-weight:400;font-size:14px;margin-right:6px;text-decoration:line-through}button,a.b{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:12px;cursor:pointer;text-align:center;text-decoration:none}
.p{background:var(--a);color:#fff}.g{background:rgba(91,76,240,.12);color:var(--a)}.m{color:var(--s);font-size:14px}.e{color:#c81e1e;font-weight:600}</style>
<div style="background:#0B6E4F;color:#fff;text-align:center;font-weight:600;padding:8px;font-size:14px">${X(lang)('Base 主网','Base Mainnet')}</div><div class=w>${inner}</div>${data?`<script type="application/json" id=kp-data>${J(data).replace(/</g,'\\u003c')}</script><script nonce="${nonce}" src="/owner/limits-done.js?v=20261022b"></script><script nonce="${nonce}" src="/owner/limits.js"></script>`:''}</html>`;
  async function handle(req,res,u,{readBody,ip}){const p=u.pathname;if(p!=='/owner/limits'&&!p.startsWith('/owner/limits/')&&p!=='/owner/limits.js'&&p!=='/owner/limits-done.js')return false;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(J(o));};
    if(limited(ip??'')){json(429,{error:'slow_down'});return true;}
    if(p==='/owner/limits-done.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(LIMITS_DONE_JS);return true;}
    if(p==='/owner/limits.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(script());return true;}
    if(p==='/owner/limits'&&req.method==='GET'){const lang=langOf(req,u),t=X(lang);const q=Object.fromEntries(u.searchParams);const c=checkLimits(q);const nonce=randomBytes(12).toString('base64url');
      res.writeHead(c.error?400:200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
        'content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; img-src data:; form-action 'none'; frame-ancestors 'none'`});
      if(c.error){res.end(shell(`<div class=t>${t('上限不对','These limits aren’t valid')}</div><p class=e>${esc(lang==='zh'?c.detail:(en(c.detail)??'Please check the numbers.'))}</p><a class="b g" href="kipurse://done">${t('回到 Kipurse','Back to Kipurse')}</a>`,null,null,lang));return true;}
      let cur=null;try{cur=await current();}catch{}let fq=null;try{fq=await feeQuote?.();}catch{}
      const feeLine=fq?(fq.fromWallet?t(`修改钱包安全上限需要一点手续费（约 ${fmtUsdc(fq.usdc)} USDC），从启付余额里扣`,`Changing the wallet safety limit needs a small network fee (about ${fmtUsdc(fq.usdc)} USDC), taken from your Kipurse balance.`):(fq.firstFree?t(`这是你第一次设置上限：手续费由 Kipurse 代付，你付 $0。以后每次修改上限，手续费按实际成本约 ${fmtUsdc(fq.usdc)} USDC，从你的启付钱包里用 USDC 扣，0 加价，永远不用 ETH。`,`This is your first limit setup: Kipurse pays the network fee, you pay $0. Each later change costs the actual network fee, about ${fmtUsdc(fq.usdc)} USDC, taken in USDC from your Kipurse wallet at 0% markup. Never ETH.`):t(`手续费按实际成本约 ${fmtUsdc(fq.usdc)} USDC，从你的启付钱包里用 USDC 扣，0 加价，永远不用 ETH。`,`Network fee: about ${fmtUsdc(fq.usdc)} USDC at actual cost, taken in USDC from your Kipurse wallet, 0% markup. Never ETH.`))):t('手续费只用 USDC 付，永远不用 ETH。','The network fee is paid in USDC only, never ETH.');
      const end=c.days?new Date((limitsWindow(Math.floor(now()/1000),c.days).end)*1000):cur?.end?new Date(Number(cur.end)*1000):null;
      const row=(k,o,n)=>`<div class=row><span>${k}</span><span class=n>${o&&o!==n?`<span class=o>${esc(o)}</span>`:''}${esc(n)}</span></div>`;
      res.end(shell(`<div class=t>${t('修改 AI 付款上限','Change AI payment limits')}</div><p class=s>${t('用你的 Base Account 确认一次，链上生效。','Sign once with your Base Account; it takes effect on chain.')}</p>
<div class=c>${row(t('每笔最多','Max per payment'),cur?usd(cur.single)+' USDC':'',usd(c.single)+' USDC')}${row(t('每天最多','Max per day'),cur?usd(cur.daily)+' USDC':'',usd(c.daily)+' USDC')}${row(t('总额最多','Max total'),cur?usd(cur.term)+' USDC':'',usd(c.term)+' USDC')}${row(t('到期','Ends'),null,end?end.toISOString().slice(0,10):t('不变','Unchanged'))}</div>
<p class=m>${t('确认后：旧授权作废，新授权生效（新总额从 0 开始算）。不会转走任何钱。','After signing, the old authorization ends and the new one starts (the new total counts from 0). No money moves.')}</p>
<p class=m id=fee>${feeLine}</p><p class=m id=why>${t(WHY_FEE.zh,WHY_FEE.en)}</p>
<button class=p id=go>${t('用 Base Account 确认','Sign with Base Account')}</button><a class="b g" href="kipurse://done">${t('取消','Cancel')}</a><p class=m id=st></p>`,nonce,{single:c.single.toString(),daily:c.daily.toString(),term:c.term.toString(),days:c.days??null,plan:/^[0-9a-f]{32}$/.test(String(q.plan??''))?String(q.plan):null},lang));return true;}
    if(p==='/owner/limits/fee'&&req.method==='GET'){let fq=null;try{fq=await feeQuote?.();}catch{}if(!fq){json(503,{error:'fee_unavailable'});return true;}
      const out={usdc:String(fq.usdc),usdcText:fmtUsdc(fq.usdc),firstFree:!!fq.firstFree,gasToken:'USDC',markupBps:0,paidFrom:fq.fromWallet?'kipurse_wallet_usdc':'kipurse_wallet',why:WHY_FEE};
      if(fq.fromWallet){out.feeFrom='kipurse_wallet';out.fromWallet=true;}
      json(200,out);return true;}
    if(p==='/owner/limits/paymaster'){if(req.method!=='POST'){json(405,{error:'method'});return true;}
      const open=walletPaymaster?.()??null;if(!open||!String(open).endsWith('/owner/limits/paymaster')||String(open).includes('/onboard/')){json(404,{error:'not_found'});return true;}
      const b=await readBody(req);if(JSON.stringify(b??null).length>200000){json(413,{error:'too_large'});return true;}
      const rw=rewritePaymasterBody(b);if(!rw.ok){json(400,{error:rw.error});return true;}
      let up;try{up=await forward(rw.body);}catch{json(502,{error:'paymaster_unavailable'});return true;}
      json(200,sanitizePaymasterResponse(rw.body.method,up));return true;}
    if(req.method!=='POST'){json(405,{error:'method'});return true;}
    const b=await readBody(req);gc();
    try{
      if(p==='/owner/limits/prepare'&&b.plan){const id=String(b.plan),e=prepared.get(id);if(!e||e.submittedAt){json(404,{error:'unknown_plan'});return true;}
          // the app already decoded and checked THIS plan on the phone; the page signs exactly it (no new plan)
          const extra=e.feeFrom==='kipurse_wallet'?{feeFrom:'kipurse_wallet',wallet:e.plan.wallet,from:e.plan.wallet,sponsored:false}:{};
          json(200,{id,owner:e.plan.owner,chainId:e.plan.chainId,human:e.plan.human,labels:e.plan.labels,calls:e.plan.calls,pm:e.pm??null,sponsored:!!e.pm,fee:e.fee??null,gasToken:'USDC',...extra});return true;}
      if(p==='/owner/limits/prepare'){const c=checkLimits({single:usd(String(b.single??'0')||'0'),daily:usd(String(b.daily??'0')||'0'),term:usd(String(b.term??'0')||'0'),days:b.days??undefined});
        if(c.error){json(400,c);return true;}if(prepared.size>50){json(429,{error:'slow_down'});return true;}
        let pl=await plan(c);const id=randomBytes(16).toString('hex');
        if(pl?.fromWallet){let f=null;try{f=await fee(pl);}catch{f=null;}
          const feeOut=f?{gas:String(f.gas??''),gasPriceWei:String(f.gasPriceWei??''),usdc:String(f.usdc),usdcText:fmtUsdc(f.usdc),walletUSDC:f.walletUSDC==null?null:String(f.walletUSDC),canPayUSDC:f.canPayUSDC===true,fromWallet:true,walletPays:false,reason:f.reason??null,cap:f.cap==null?null:String(f.cap)}:null;
          const over=!f||f.reason==='fee_above_cap'||(f.cap!=null&&BigInt(f.usdc)>=BigInt(f.cap));
          const short=!over&&(f.reason==='kipurse_balance_insufficient_for_fee'||f.walletUSDC==null||BigInt(f.walletUSDC)<BigInt(f.usdc));
          if(over||short){const code=!f?'fee_unavailable':over?'fee_above_cap':'kipurse_balance_insufficient_for_fee';
            const detail=code==='kipurse_balance_insufficient_for_fee'?{zh:'启付余额不足以支付手续费',en:'The Kipurse balance can’t cover the network fee.'}:code==='fee_above_cap'?{zh:`这次手续费约 ${feeOut?.usdcText??'?'} USDC，超过了允许的上限，已停止，没有扣钱。`,en:`This network fee is about ${feeOut?.usdcText??'?'} USDC, over the allowed cap. Stopped. Nothing was charged.`}:{zh:'现在算不出手续费，已停止，没有扣钱。请稍后再试。',en:'Could not work out the network fee right now. Stopped; nothing was charged. Please try again later.'};
            json(code==='fee_unavailable'?503:402,{error:code,fee:feeOut,detail});return true;}
          let pmUrl=null;try{erc20();pmUrl=walletPaymaster?.()??null;}catch{pmUrl=null;}
          if(!pmUrl||!String(pmUrl).endsWith('/owner/limits/paymaster')||String(pmUrl).includes('/onboard/')){json(503,{error:'paymaster_unavailable'});return true;}
          prepared.set(id,{plan:pl,at:now(),choice:c,pm:pmUrl,fee:feeOut,feeFrom:'kipurse_wallet'});
          json(200,{id,owner:pl.owner,wallet:pl.wallet,from:pl.wallet,chainId:pl.chainId,human:pl.human,labels:pl.labels,calls:pl.calls,pm:pmUrl,sponsored:false,fee:feeOut,feeFrom:'kipurse_wallet',gasToken:'USDC'});return true;}
        let pm=null;try{pm=await sponsor(id,pl);}catch{pm=null;}let f=null;try{f=await fee(pl);}catch{f=null;}
        const g=gasRoute({pm,fee:f});const feeOut=f?{gas:String(f.gas??''),gasPriceWei:String(f.gasPriceWei??''),usdc:String(f.usdc),usdcText:fmtUsdc(f.usdc),payerUSDC:f.payerUSDC==null?null:String(f.payerUSDC),canPayUSDC:f.canPayUSDC===true}:null;
        if(feeOut&&f){feeOut.walletUSDC=f.walletUSDC==null?null:String(f.walletUSDC);feeOut.reason=f.reason??null;feeOut.walletPays=!!f.walletPays;feeOut.floatNeedText=f.floatNeed?fmtUsdc(f.floatNeed):null;}
        if(!g.route){const why=WHY_FEE;const r=feeOut?.reason;
          const detail=!feeOut?{zh:'现在算不出手续费，已停止，没有扣钱。请稍后再试。',en:'Could not work out the network fee right now. Stopped; nothing was charged. Please try again later.'}:r==='wallet_low'?{zh:`${why.zh}\n这次约 ${feeOut.usdcText} USDC，从你的启付钱包里扣。现在钱包里的 USDC 不够，请先给钱包充值。没有扣钱。`,en:`${why.en}\nThis change costs about ${feeOut.usdcText} USDC, taken from your Kipurse wallet. The wallet doesn't have enough USDC, so please top it up first. Nothing was charged.`}
            :r!=='float_low'?{zh:`${why.zh}\n这次约 ${feeOut.usdcText} USDC，要用 USDC 付。现在 USDC 不够，已停止，没有扣钱。`,en:`${why.en}\nThis change costs about ${feeOut.usdcText} USDC, paid in USDC. There isn't enough USDC, so we stopped. Nothing was charged.`}
            :{zh:`${why.zh}\n这次约 ${feeOut.usdcText} USDC，由启付钱包付。确认时要先由你的 Base Account 垫付约 ${feeOut.floatNeedText} USDC，同一笔交易里马上从钱包还给它。现在 Base Account 里没有这点 USDC，已停止，没有扣钱。`,en:`${why.en}\nThis change costs about ${feeOut.usdcText} USDC, paid by your Kipurse wallet. When signing, your Base Account must first front about ${feeOut.floatNeedText} USDC, which the wallet pays back in the same transaction. Your Base Account doesn't have that USDC now, so we stopped. Nothing was charged.`};
          json(402,{error:r==='wallet_low'?'wallet_needs_topup':r==='float_low'?'base_account_needs_float':'needs_usdc_for_gas',payer:r==='wallet_low'?'kipurse_wallet':'base_account',fee:feeOut,why,detail});return true;}
        if(g.route==='usdc'&&refund&&f?.walletPays){pl={...pl,calls:[...pl.calls,refund(f.usdc)]};}
        prepared.set(id,{plan:pl,at:now(),choice:c,pm,fee:feeOut});
        json(200,{id,owner:pl.owner,chainId:pl.chainId,human:pl.human,labels:pl.labels,calls:pl.calls,pm,sponsored:!!pm,fee:feeOut,gasToken:'USDC'});return true;}
      if(p==='/owner/limits/confirm'){const id=String(b.id??'');if(!prepared.has(id)&&!done.has(id)){json(404,{error:'unknown_plan'});return true;}const r=await finish(id);json(200,r??{ok:false});return true;}
      if(p==='/owner/limits/submitted'){const id=String(b.id??''),e=prepared.get(id);if(!e){json(200,{ok:!!done.get(id)});return true;}if(e.submittedAt){json(200,{ok:true});return true;}
        e.submittedAt=now();e.at=now();const c=e.choice??{};pend={id,since:Math.floor(now()/1000),single:String(c.single??''),daily:String(c.daily??''),term:String(c.term??''),days:c.days??null,failed:false};
        (async()=>{for(let i=0;i<pollTries;i++){await sleep(pollMs);try{if(await finish(id))return;}catch{}}if(pend?.id===id)pend.failed=true;})();json(200,{ok:true});return true;}
      json(404,{error:'not_found'});return true;
    }catch(e){json(400,{error:e.code??'failed',detail:String(e.message).slice(0,300)});return true;}}
  /** For the app's read-only state: a signed-and-submitted change that is not on chain yet (or failed to land in ~3 min). */
  const pending=()=>pend&&(now()/1000-pend.since<1800)?{...pend}:null;
  // delete-everything: forget finished-change history and the progress banner. In-flight prepared plans are KEPT: a change the owner
  // already signed must still update the stored permission when Base confirms it (otherwise payments would use a revoked permission).
  const forget=()=>{done.clear();pend=null;hits.clear();};
  return {handle,pending,forget,url:q=>`${base()}/owner/limits?${new URLSearchParams(q)}`};}
