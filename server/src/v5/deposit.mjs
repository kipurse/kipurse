// SPDX-License-Identifier: AGPL-3.0-only
// ADD MONEY page (/deposit?w=<wallet>). The server reads two USDC balances first and shows ONE clear primary action:
//   HAS  – the Coinbase account the owner signed in with (his Base Account) holds >= LOW USDC: one-tap transfer
//          (a plain USDC.transfer he confirms in the Coinbase popup; no address copy-paste).
//   ZERO – it holds less: (a) "Buy USDC with card / Apple Pay" via Coinbase Onramp, ONLY when an Onramp provider is configured;
//          (b) step-by-step "Send from the Coinbase app" with the wallet address, QR code, copy button and a Base-network warning;
//          (c) "I've sent it, check" which re-reads the wallet balance and reports arrival.
// Query: ?mode=tap|send forces a state (tap = wallet-only: no exchange/Onramp/Coinbase-app entries), ?amount=<atomic> pre-selects (capped at balance), ?check=1 -> JSON balances, ?buy=1&amt=N -> 302 to Coinbase Onramp (404 when not configured).
// Kipurse never charges and never sponsors gas here. Nothing is logged.
import {langOf,X} from './i18n.mjs';import {randomBytes} from 'node:crypto';import {getAddress,parseAbi,encodeFunctionData,decodeFunctionData} from 'viem';
import {ownAddrHtml} from './addr-display.mjs';
const ADDR=/^0x[0-9a-fA-F]{40}$/;export const LOW=1_000_000n;export const PRESETS=[5,10,50,100,1000];   // 1 USDC: below this the one-tap path is not the main action
// WRONG TOKEN: anything but USDC sent to the wallet cannot be used by the AI (the spend permission and the adapter are USDC-only),
// but the wallet's owner #0 (the user's Base Account) can send it back to himself: wallet.execute(token,0,transfer(owner,all))
// or, for ETH, wallet.execute(owner,all,0x). Destination is ALWAYS the registered owner; the user signs and pays the fee.
export const STRAY=[{sym:'ETH',addr:null,dec:18},{sym:'USDT',addr:'0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',dec:6},
  {sym:'WETH',addr:'0x4200000000000000000000000000000000000006',dec:18},{sym:'DAI',addr:'0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',dec:18},
  {sym:'cbBTC',addr:'0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',dec:8}];
export const fmtU=(a,dec)=>{a=BigInt(a);const b=10n**BigInt(dec),i=a/b,f=(a%b).toString().padStart(dec,'0').slice(0,6).replace(/0+$/,'');if(i===0n&&!f&&a>0n)return '<0.000001';return i.toLocaleString('en-US')+(f?'.'+f:'');};
const EXA=parseAbi(['function execute(address target, uint256 value, bytes data)']),TRA=parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
export function returnCalls({wallet,owner,asset,amount}){const a=BigInt(amount);if(a<=0n)throw Object.assign(Error('empty'),{code:'empty'});
  const args=asset.addr?[getAddress(asset.addr),0n,encodeFunctionData({abi:TRA,functionName:'transfer',args:[getAddress(owner),a]})]:[getAddress(owner),a,'0x'];
  return [{to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:EXA,functionName:'execute',args})}];}
/** Independent rule: one call, to the wallet, value 0, execute(); money goes ONLY to the owner. */
export function checkReturnCalls(calls,{wallet,owner,asset}){if(!Array.isArray(calls)||calls.length!==1)return 'one_call_only';const c=calls[0];
  if(getAddress(c.to)!==getAddress(wallet)||BigInt(c.value??0)!==0n)return 'wrong_target';let o;try{o=decodeFunctionData({abi:EXA,data:c.data});}catch{return 'not_execute';}
  const [tgt,val,data]=o.args;
  if(!asset.addr)return getAddress(tgt)===getAddress(owner)&&val>0n&&data==='0x'?null:'destination_not_owner';
  if(getAddress(tgt)!==getAddress(asset.addr)||val!==0n)return 'wrong_token';let t;try{t=decodeFunctionData({abi:TRA,data});}catch{return 'not_transfer';}
  return getAddress(t.args[0])===getAddress(owner)?null:'destination_not_owner';}
export const fmt=a=>{if(a==null)return null;a=BigInt(a);const i=a/1_000_000n,f=(a%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');return i.toLocaleString('en-US')+(f?'.'+f.slice(0,2).padEnd(2,'0'):'');};
const plain=a=>{a=BigInt(a);const i=a/1_000_000n,f=(a%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');return String(i)+(f?'.'+f:'');};
export function stateOf(ownerBal,mode){if(mode==='tap'&&ownerBal!=null&&ownerBal>0n)return 'has';if(mode==='send')return 'zero';return ownerBal!=null&&ownerBal>=LOW?'has':'zero';}
export function createDeposit({purchaseGate=null,reg,script,token,chainId=8453,usdcOf=null,strayOf=null,onramp=null,qr=null,base=()=>'https://pay.kipurse.com',timeoutMs=4000}){
  const bal=async a=>{if(!usdcOf)return null;try{return BigInt(await Promise.race([usdcOf(a),new Promise((_,r)=>setTimeout(()=>r(Error('t')),timeoutMs))]));}catch{return null;}};
  const strays=async a=>{if(!strayOf)return [];try{const r=await Promise.race([strayOf(a),new Promise((_,r)=>setTimeout(()=>r(Error('t')),timeoutMs))]);
    return STRAY.map(x=>({...x,amount:BigInt(r?.[x.sym]??0)})).filter(x=>x.amount>0n);}catch{return [];}};
  const qrSvg=async a=>{try{if(qr)return await qr(a);const {default:QR}=await import('qrcode');return await QR.toString(a,{type:'svg',margin:1,width:200,errorCorrectionLevel:'M'});}catch{return '';}};
  const css=`body{margin:0;background:#F2F2F7;color:#111;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}.w{max-width:480px;margin:0 auto;padding:24px 18px 40px}.c{background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0}.t{font-size:24px;font-weight:700;margin:8px 0 4px}.m{color:#666;font-size:14px}.big{font-size:30px;font-weight:700}button,a.btn{display:block;box-sizing:border-box;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px;background:#0052FF;color:#fff;text-align:center;text-decoration:none}button.s,a.s{background:#EEF2FF;color:#0052FF}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:8px}.g button{margin:0;background:#EEF2FF;color:#0052FF;padding:0 4px;height:58px;font-size:17px;line-height:1.2;display:flex;flex-direction:column;align-items:center;justify-content:center}.g button.on{background:#0052FF;color:#fff}.g button:disabled{background:#F2F2F7;color:#AEAEB2}.g button small{font-size:12px;font-weight:500;margin-top:2px}input{width:100%;box-sizing:border-box;font-size:20px;padding:12px;border:1px solid #ddd;border-radius:12px;margin-top:10px}ol{padding-left:22px;margin:6px 0}li{margin:8px 0}.addr{font:15px/1.4 ui-monospace,Menlo,monospace;word-break:break-all;background:#F2F2F7;border-radius:10px;padding:10px;margin-top:8px}.qr{text-align:center;margin-top:10px}.qr svg{width:200px;height:200px}.sx{border:2px solid #E8A33D}.sr{padding:8px 0;border-bottom:1px solid #eee}.warn{background:#FFF4E5;color:#8A4B00;border-radius:12px;padding:10px 12px;font-size:15px;margin-top:10px}.lnk{display:block;text-align:center;margin-top:14px;color:#0052FF;font-size:16px;text-decoration:none}`;
  const page=async({rec,nonce,lang,ob,wb,state,lp,sx=[],pre=null,wo=false})=>{const t=X(lang),W=rec.wallet,hasBal=ob!=null&&ob>0n,FROM=state==='has';
    const sh=sx.length?`<div class="c sx" id=stray><b>⚠️ ${t('钱包里收到了不能用的币','Your wallet received coins it can’t use')}</b>${sx.map(x=>`<div class=sr><div>${t(`收到了 ${fmtU(x.amount,x.dec)} ${x.sym}，不能用于 AI 支付。`,`Received ${fmtU(x.amount,x.dec)} ${x.sym}. It can’t be used for AI payments.`)}</div><button class=s data-ret="${x.sym}">${t(`一键退回 ${x.sym} 到我的 Coinbase 账户`,`Send the ${x.sym} back to my Coinbase account`)}</button></div>`).join('')}<div class=m>${t(`只会退回到你的 Coinbase 钱包（${rec.owner.slice(0,6)}…${rec.owner.slice(-4)}），别的地址都不行。在 Coinbase 弹窗里确认；手续费很少（一般不到 $0.01），由你的 Coinbase 账户付，启付不收费也不垫付。`,`It can only go back to your Coinbase Wallet (${rec.owner.slice(0,6)}…${rec.owner.slice(-4)}), nowhere else. Confirm in the Coinbase popup; the network fee is tiny (usually under $0.01) and is paid by your Coinbase account. Kipurse charges nothing and pays nothing.`)}</div><p class=m id=rs></p></div>`:'';
    const head=`<!doctype html><html lang=${lang}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${t('给钱包充值','Add money')}</title><style>${css}</style><div class=w>
<div class=t>${t('给启付钱包充值','Add money to your Kipurse wallet')}</div>
<div class=c id=dst><div class=m>${t('启付钱包现在有','Your Kipurse wallet has')}</div><div class=big id=wb>${wb==null?'—':fmt(wb)} USDC</div><div class=m>${t('USDC 是数字美元，1 USDC ≈ 1 美元。你的 AI 用它来付钱。','USDC is a digital dollar: 1 USDC ≈ $1. Your AI pays with it.')}</div></div>`;
    const check=`<button class=s id=chk>${t('我已转账，查看是否到账','I’ve sent it — check if it arrived')}</button><p class=m id=cs></p>`;
    const data=JSON.stringify({wallet:W,owner:rec.owner,token,chainId,wb0:wb==null?null:String(wb),ob:ob==null?null:String(ob),check:`/deposit?w=${W}&check=1`,ret:`/deposit?w=${W}&ret=`}).replace(/</g,'\\u003c');
    const ui=`<script nonce="${nonce}">(function(){var d=JSON.parse(document.getElementById('kp-data').textContent),EN=${lang==='zh'?'false':'true'};
var cp=document.getElementById('cp');if(cp)cp.onclick=function(){var ok=function(){cp.textContent=EN?'Copied ✓':'已复制 ✓';setTimeout(function(){cp.textContent=EN?'Copy address':'复制地址';},2000);};
 if(navigator.clipboard)navigator.clipboard.writeText(d.wallet).then(ok,function(){prompt('',d.wallet);});else prompt('',d.wallet);};
var b=document.getElementById('chk'),cs=document.getElementById('cs'),n=0,tm=null;function f(x){var a=BigInt(x),i=a/1000000n,r=(a%1000000n).toString().padStart(6,'0').slice(0,2);return i.toLocaleString('en-US')+(r==='00'?'':'.'+r);}
function once(){return fetch(d.check,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){if(j.wallet==null)throw 0;var now=BigInt(j.wallet),was=d.wb0==null?null:BigInt(d.wb0);
 document.getElementById('wb').textContent=f(j.wallet)+' USDC';if(was!==null&&now>was){cs.style.color='#080';cs.textContent=(EN?'✅ Arrived: +':'✅ 已到账：+')+f(String(now-was))+' USDC. '+(EN?'You can go back to the Kipurse app.':'可以回到启付 App 了。');d.wb0=j.wallet;return true;}return false;});}
if(b)b.onclick=function(){if(tm)return;n=0;cs.style.color='';cs.textContent=EN?'Checking…':'正在查看…';(function loop(){once().then(function(ok){if(ok){tm=null;return;}n++;if(n>=24){tm=null;cs.textContent=EN?'Not arrived yet. A transfer on Base usually takes under a minute — tap again to check.':'还没到账。Base 上转账一般 1 分钟内到，稍后再点一次查看。';return;}
 cs.textContent=EN?'Not arrived yet, still checking…':'还没到账，正在继续查看…';tm=setTimeout(loop,5000);}).catch(function(){tm=null;cs.style.color='#c81e1e';cs.textContent=EN?'Couldn’t check right now. Try again.':'暂时查不到，请再试一次。';});})();};})();</script>`;
    const tail=`<script type="application/json" id=kp-data>${data}</script>${ui.replace(/EN\?'([^']*)':'([^']*)'/g,(m,e,z)=>JSON.stringify(lang==='zh'?z:e))}${state==='has'||sx.length?`<script nonce="${nonce}" src="/deposit.js"></script>`:''}</div></html>`;
    const q=(m)=>`/deposit?w=${W}&lang=${lang}&mode=${m}`;
    if(state==='has'){const max=plain(ob),sel=pre,pre_=PRESETS,pre2=pre_;
      const parts=head.split('<div class=c id=dst>');   // t887: from -> to order: Coinbase 钱包 (source) ↓ 启付钱包 (destination)
      return parts[0]+`<div class=c id=src><div class=m>${t('从：你的 Coinbase 钱包（Base 账户）现在有','From: your Coinbase Wallet (Base Account) has')}</div><div class=big>${fmt(ob)} USDC</div><div class=m>${rec.owner.slice(0,6)}…${rec.owner.slice(-4)}</div></div>
<div id=dir style="text-align:center;font-size:15px;font-weight:600;color:#0052FF">↓ ${t('Coinbase 钱包 → 启付钱包','Coinbase Wallet → Kipurse wallet')}</div>
<div class=c id=dst>`+parts[1].replace(t('启付钱包现在有','Your Kipurse wallet has'),t('到：你的启付钱包现在有','To: your Kipurse wallet has'))+sh+`<div class=c><b>${t('在 Coinbase 弹窗里确认就行，不用复制地址。','Just confirm in the Coinbase popup. No address to copy.')}</b></div>
<div class=c><b>${t('转入多少 USDC？','How much USDC?')}</b><div class=g>${pre2.map(v=>BigInt(v)*1_000_000n<=ob?`<button data-a=${v}${sel!=null&&sel===BigInt(v)*1_000_000n&&sel!==ob?' class=on':''}>${v.toLocaleString('en-US')}</button>`:`<button data-a=${v} disabled aria-disabled=true>${v.toLocaleString('en-US')}<small>${t('余额不够','Not enough')}</small></button>`).join('')}<button data-a="${max}"${sel!=null&&sel===ob?' class=on':''}>${t('全部','All')}<small>${fmt(ob)}</small></button></div><input id=amt inputmode=decimal autocomplete=off${sel!=null?` value="${plain(sel)}"`:''} placeholder="${t('其他金额，如 2,500','Other amount, e.g. 2,500')}"></div>
<div class=c><div class=m>${t('手续费很少（一般不到 $0.01），可以在弹窗里用 USDC 付，不需要 ETH。启付不收任何费用。','The network fee is tiny (usually under $0.01) and can be paid in USDC in the popup — no ETH needed. Kipurse charges nothing.')}</div></div>
<button id=go>${t('转入钱包','Add to wallet')}</button><p class=m id=st></p>${check}`+tail;}   // t886: no Coinbase app / exchange link on the wallet-transfer page
    const svg=await qrSvg(W);
    if(wo)return head+sh+`<div class=c id=wo><b>${t('你的 Coinbase 钱包里没有 USDC','Your Coinbase Wallet has no USDC')}</b><div class=m>${t('可以从别的钱包把 USDC 转到下面这个你自己的启付钱包地址。只转 USDC，网络只能选 Base。','You can send USDC from another wallet to your own Kipurse address below. USDC only, on the Base network only.')}</div></div>
<div class=qr>${svg}</div><div class=addr>${ownAddrHtml(W,t)}</div><button class=s id=cp>${t('复制地址','Copy address')}</button>${check}`+tail;   // t886: wallet-only, no exchange / Onramp
    const buy=onramp?`<div class=c><b>${t('还没有 USDC？用银行卡或 Apple Pay 买','No USDC yet? Buy it with a card or Apple Pay')}</b><div class=m>${t('由 Coinbase 处理付款，买到的 USDC 直接进你的启付钱包。Coinbase 的费用会在付款前显示；启付不收费。','Coinbase handles the payment and sends the USDC straight to your Kipurse wallet. Coinbase shows any fee before you pay; Kipurse charges nothing.')}</div>
<a class=btn id=buy href="/deposit?w=${W}&lang=${lang}&buy=1">${t('用银行卡 / Apple Pay 购买','Buy with card / Apple Pay')}</a></div>`:'';
    const low=hasBal?`<a class=lnk href="${q('tap')}">${t(`你的 Coinbase 钱包里有 ${fmt(ob)} USDC，点这里直接转入`,`Your Coinbase Wallet has ${fmt(ob)} USDC — tap to move it in`)}</a>`:'';
    return head+sh+buy+`<div class=c><b>${onramp?t('或者：从 Coinbase App 转进来','Or: send from the Coinbase app'):t('从 Coinbase App 转进来','Send from the Coinbase app')}</b><ol>
<li>${t('打开 Coinbase App。如果里面还没有 USDC，先在 App 里点「买入」，用银行卡或 Apple Pay 买 USDC。','Open the Coinbase app. If you don’t have USDC there yet, tap “Buy” in the app and buy USDC with a card or Apple Pay.')}</li>
<li>${t('点「发送」，<b>只选 USDC</b>（不要选 USDT、ETH 或其他币），填金额。','Tap “Send”, choose <b>USDC only</b> (not USDT, ETH or any other coin) and enter the amount.')}</li>
<li>${t('收款地址：扫下面的二维码，或复制地址粘贴进去。','Recipient: scan the QR code below, or copy the address and paste it.')}</li>
<li>${t('网络选 <b>Base</b>，然后确认发送。','Choose the <b>Base</b> network, then confirm.')}</li>
<li>${t('回到这里，点「我已转账，查看是否到账」。','Come back here and tap “I’ve sent it — check if it arrived”.')}</li></ol>
<div class=qr>${svg}</div><div class=addr>${ownAddrHtml(W,t)}</div><button class=s id=cp>${t('复制地址','Copy address')}</button>
<div class=warn id=only><b>⚠️ ${t('只能充 USDC，网络只能选 Base。','USDC only, on the Base network only.')}</b><br>${t('转错了的币（比如 USDT、ETH）AI 不能用。如果是在 Base 网络上转错了 ETH、USDT、WETH、DAI 或 cbBTC，这个页面和启付 App 会显示出来，你可以一键退回自己的 Coinbase 账户（手续费你自己付，一般不到 $0.01）。其他币，或者选了别的网络（比如 Ethereum、Solana），启付没法帮你找回。','Any other coin (like USDT or ETH) can’t be used by your AI. If you send ETH, USDT, WETH, DAI or cbBTC on Base by mistake, this page and the Kipurse app will show it and you can send it back to your own Coinbase account in one tap (you pay the network fee, usually under $0.01). Other coins, or another network (like Ethereum or Solana), can’t be recovered by Kipurse.')}</div>
<div class=m style="margin-top:8px">${t('Coinbase 会在发送前显示费用（如果有）。启付不收费。','Coinbase shows any fee before you send. Kipurse charges nothing.')}</div></div>
${check}${low}`+tail;};
  async function handle(req,res,u){const p=u.pathname;
    if(p==='/deposit.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(script());return true;}
    if(p!=='/deposit'||req.method!=='GET')return false;const w=String(u.searchParams.get('w')??'');const rec0=ADDR.test(w)?reg.get(w):null;const lang=langOf(req,u);
    if(!rec0){res.writeHead(404,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(`<!doctype html><html lang=${lang}><meta charset=utf-8><p>${X(lang)('找不到这个钱包。','Wallet not found.')}</p></html>`);return true;}
    const rec={wallet:getAddress(rec0.wallet),owner:getAddress(rec0.owner)};
    if(u.searchParams.get('check')==='1'){const [o,wb]=await Promise.all([bal(rec.owner),bal(rec.wallet)]);res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({wallet:wb==null?null:String(wb),owner:o==null?null:String(o)}));return true;}
    if(u.searchParams.get('buy')==='1'){const t=X(lang);if(!onramp){res.writeHead(404,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(`<!doctype html><html lang=${lang}><meta charset=utf-8><p>${t('暂时不能用银行卡购买，请用 Coinbase App 转入。','Card purchase isn’t available yet. Please send from the Coinbase app.')}</p></html>`);return true;}
      {const g=purchaseGate?await purchaseGate(rec.owner,lang):[503,{error:'verify_unavailable'}];if(g){res.writeHead(g[0],{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(`<!doctype html><html lang=${lang}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font:17px -apple-system,sans-serif;max-width:480px;margin:30px auto;padding:0 18px"><p>${String(g[1].detail??'').replace(/[<&]/g,'')}</p><p><a href="https://www.coinbase.com/onchain-verify">coinbase.com/onchain-verify</a></p></body></html>`);return true;}}
      try{const a=Number(u.searchParams.get('amt'));const s=await onramp.session({address:rec.wallet,amount:a>0&&a<=10000?a:undefined,clientIp:String(req.headers?.['cf-connecting-ip']??'')||undefined,redirectUrl:`${base()}/deposit?w=${rec.wallet}&lang=${lang}`});
        res.writeHead(302,{location:s.url,'cache-control':'no-store','referrer-policy':'no-referrer'});res.end();}
      catch{res.writeHead(503,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(`<!doctype html><html lang=${lang}><meta charset=utf-8><p>${t('Coinbase 购买暂时打不开，请稍后再试，或用 Coinbase App 转入。','Coinbase purchase isn’t available right now. Try again later, or send from the Coinbase app.')}</p></html>`);}return true;}
    if(u.searchParams.get('stray')==='1'){const sx=await strays(rec.wallet);res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({wallet:rec.wallet,owner:rec.owner,stray:sx.map(x=>({sym:x.sym,token:x.addr,decimals:x.dec,amount:String(x.amount),shown:fmtU(x.amount,x.dec)}))}));return true;}
    if(u.searchParams.has('ret')){const sym=String(u.searchParams.get('ret'));const asset=STRAY.find(x=>x.sym===sym);const j=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(o));};
      if(!asset){j(404,{error:'unknown_token'});return true;}const x=(await strays(rec.wallet)).find(y=>y.sym===sym);if(!x){j(409,{error:'empty'});return true;}
      const calls=returnCalls({wallet:rec.wallet,owner:rec.owner,asset,amount:x.amount});const bad=checkReturnCalls(calls,{wallet:rec.wallet,owner:rec.owner,asset});if(bad){j(500,{error:bad});return true;}
      j(200,{sym,amount:String(x.amount),shown:fmtU(x.amount,x.dec),to:rec.owner,wallet:rec.wallet,chainId,calls});return true;}
    const [ob,wb,sx]=await Promise.all([bal(rec.owner),bal(rec.wallet),strays(rec.wallet)]);const mode=String(u.searchParams.get('mode')??''),state=stateOf(ob,mode),wo=mode==='tap';
    const ra=String(u.searchParams.get('amount')??'');const pre=/^[0-9]{1,13}$/.test(ra)&&BigInt(ra)>0n&&ob!=null&&ob>0n?(BigInt(ra)>ob?ob:BigInt(ra)):null;   // t886: app-chosen amount (atomic USDC), capped at the on-chain Base Account balance
    const nonce=randomBytes(12).toString('base64url');
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer',
      'content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; form-action 'none'; frame-ancestors 'none'`});
    res.end(await page({rec,nonce,lang,ob,wb,state,sx,pre,wo}));return true;}
  return {handle};}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
