// SPDX-License-Identifier: AGPL-3.0-only
// EMERGENCY page (mainnet), for an owner whose phone is NOT bound (reinstall, new or lost phone): /owner/emergency.
// No phone, no session, no cookie. Every action needs a FRESH signature by the wallet owner's own Base Account over a one-time,
// server-written message that names the action and this wallet; the server verifies it (ERC-1271/6492 on chain) BEFORE acting.
// Only actions that make the wallet SAFER are offered: pause AI payments, cancel payments waiting in the 10-minute hold.
// Withdraw-all is the existing /owner/withdraw page (also Base Account only; the destination is always the owner).
// Resuming AI payments is NOT here on purpose: that needs a bound phone (Face ID).
import {randomBytes} from 'node:crypto';import {getAddress} from 'viem';import {langOf} from './i18n.mjs';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const SIGN_SHELL='https://sign.kipurse.com';   // t887 (old workers.dev host still served)
export const EMERGENCY_ACTIONS=['pause','cancel_holds'];
export const emergencyMessage=({action,wallet,nonce})=>`Kipurse emergency v1\naction: ${action==='pause'?'pause AI payments':'cancel all waiting payments'}\nwallet: ${String(wallet).toLowerCase()}\nnonce: ${nonce}\nThis sends no money. Only the wallet owner can sign it.`;
export function createOwnerEmergency({wallet,owner,verifyOwner,pause,cancelHolds,pendingHolds=()=>0,script=()=>'',obs=null,now=()=>Date.now(),ttlMs=5*60e3}){
  const WALLET=getAddress(wallet),OWNER=getAddress(owner);const ch=new Map();const hits=new Map();
  const limited=(ip,max=20)=>{const n=now(),h=hits.get(ip)??[0,n];if(n-h[1]>60000){h[0]=0;h[1]=n;}h[0]++;hits.set(ip,h);return h[0]>max;};
  const gc=()=>{const t=now();for(const [k,v] of ch)if(v.exp<t)ch.delete(k);if(ch.size>500)ch.clear();};
  function challenge(action){if(!EMERGENCY_ACTIONS.includes(action))return [400,{error:'bad_action',choices:EMERGENCY_ACTIONS}];gc();
    const nonce=randomBytes(16).toString('hex');ch.set(nonce,{action,exp:now()+ttlMs});return [200,{nonce,action,owner:OWNER,message:emergencyMessage({action,wallet:WALLET,nonce})}];}
  async function act({nonce,signature}={}){const sig=String(signature??'');
    if(!/^0x[0-9a-fA-F]{2,}$/.test(sig)||sig.length>20000)return [401,{error:'not_owner',detail:'Base Account signature required'}];
    const n=String(nonce??'');const c=ch.get(n);ch.delete(n);if(!c||c.exp<now())return [401,{error:'bad_nonce',detail:'challenge expired or used; start again'}];
    let ok=false;try{ok=await verifyOwner(emergencyMessage({action:c.action,wallet:WALLET,nonce:n}),sig);}catch{ok=false;}
    if(!ok){obs?.log?.('emergency',{action:c.action,ok:false});return [401,{error:'not_owner',detail:'signature is not from the wallet owner'}];}
    obs?.log?.('emergency',{action:c.action,ok:true});
    if(c.action==='pause')return [200,{ok:true,action:'pause',...(await pause())}];
    return [200,{ok:true,action:'cancel_holds',...(await cancelHolds())}];}
  // t789: "withdraw all" opens the PINNED sign-host withdraw page (same pinned set, /v5 = v4 bytes + tight CSP (t796)), never this server's own page.
  const withdrawHref=en=>{const inner=`/t/${WALLET.toLowerCase()}/owner/withdraw?lang=${en?'en':'zh'}`;return `${SIGN_SHELL}/v5/t/${WALLET.toLowerCase()}/owner/withdraw#u=${encodeURIComponent(inner)}`;};
  function page(en){const X=(z,e)=>en?e:z;return `<!doctype html><html lang=${en?'en':'zh'}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${X('紧急操作','Emergency')}</title>
<style>:root{--a:#5B4CF0;--bg:#F2F2F7;--card:#fff;--t:#111;--s:#6b6b78;color-scheme:light dark}@media(prefers-color-scheme:dark){:root{--a:#8B7CFF;--bg:#000;--card:#1c1c1e;--t:#f5f5f7;--s:#9a9aa5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:17px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.w{max-width:460px;margin:0 auto;padding:24px 20px 40px}
.t{font-size:24px;font-weight:700;margin:6px 0}.s{color:var(--s)}.c{background:var(--card);border-radius:18px;padding:14px 16px;margin:12px 0}
button,.btn{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px;cursor:pointer;text-align:center;text-decoration:none}.p{background:var(--a);color:#fff}.r{background:#c81e1e;color:#fff}.g{background:rgba(91,76,240,.12);color:var(--a)}.muted{color:var(--s);font-size:14px}</style>
<div style="background:#c00;color:#fff;text-align:center;font-weight:700;padding:8px">${X('Base 主网','Base Mainnet')}</div><div class=w>
<div class=t>${X('紧急操作（不用手机）','Emergency (no phone needed)')}</div>
<p class=s>${X('这台手机还没绑定也能用。每一步都要钱包主人的 Base Account 确认，别人拿到这个链接也做不了任何事。','Works even if this phone isn’t bound. Every step needs the wallet owner’s Base Account signature; anyone else with this link can do nothing.')}</p>
<div class=c><b>${X('钱包','Wallet')}</b><div style="font-family:ui-monospace,monospace;font-size:13px;word-break:break-all">${esc(WALLET)}</div><div class=muted>${X('等待中的大额付款：','Payments waiting: ')}<span id=holds>${esc(pendingHolds())}</span></div></div>
<button class=r id=pause>${X('暂停 AI 付款','Pause AI payments')}</button>
<button class=p id=cancel>${X('取消所有等待中的付款','Cancel all waiting payments')}</button>
<a class="btn g" id=withdraw href="${esc(withdrawHref(en))}">${X('全部取回到我的 Base Account','Withdraw all to my Base Account')}</a>
<p class=muted id=st>${X('确认免费，不发交易。恢复 AI 付款需要先绑定手机（Face ID）。','Signing is free and sends no transaction. To resume AI payments, bind your phone first (Face ID).')}</p>
<script type="application/json" id=kp-data>${JSON.stringify({owner:OWNER,en}).replace(/</g,'\\u003c')}</script><script src="emergency.js"></script></div></html>`;}
  async function handle(req,res,u,{readBody,ip}={}){const p=u.pathname;if(p!=='/owner/emergency'&&p!=='/owner/emergency.js'&&!p.startsWith('/owner/emergency/'))return false;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(o));};
    if(limited(String(ip??'')))return json(429,{error:'slow_down'}),true;
    if(p==='/owner/emergency.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(script());return true;}
    if(p==='/owner/emergency'&&req.method==='GET'){const en=langOf(req,u)==='en';res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer',
      'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; frame-ancestors 'none'"});res.end(page(en));return true;}
    if(req.method!=='POST')return json(405,{error:'method'}),true;const b=await readBody(req).catch(()=>({}));
    if(p==='/owner/emergency/challenge'){const [c,o]=challenge(String(b?.action??''));return json(c,o),true;}
    if(p==='/owner/emergency/act'){const [c,o]=await act(b??{});return json(c,o),true;}
    return json(404,{error:'not_found'}),true;}
  return {handle,challenge,act};}
