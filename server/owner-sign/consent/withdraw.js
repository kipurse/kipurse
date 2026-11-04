/* KPVH-GUARD v1 (t621 #1, 2026-10-27): every Base Account batch on Kipurse pages must be exactly what the Kipurse APP decoded and
   checked first. The app puts a SHA-256 commitment of the batch in the URL fragment (#vh=..., never sent to any server). No commitment
   or a different batch -> nothing is sent. #vw=<wallet> (deposit page only) allows exactly: USDC -> that wallet, or a stray-coin
   return from that wallet back to the signer. */
var kpVHCanon=p=>'kpbatch1|'+Number(p.chainId)+'|'+String(p.from).toLowerCase()+'|'+(p.calls||[]).map(c=>String(c.to).toLowerCase()+','+BigInt(c.value||0).toString()+','+String(c.data||'0x').toLowerCase()).join(';');
var kpVHHash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');
var kpVHW=(p,vw)=>{const C=p.calls||[],w=String(vw).toLowerCase().replace(/^0x/,''),f=String(p.from).toLowerCase().replace(/^0x/,''),pd=a=>a.padStart(64,'0');
  if(!/^[0-9a-f]{40}$/.test(w)||!/^[0-9a-f]{40}$/.test(f)||C.length!==1)return false;const c=C[0],to=String(c.to).toLowerCase().replace(/^0x/,''),d=String(c.data||'').toLowerCase().replace(/^0x/,''),v=BigInt(c.value||0);
  if(to==='833589fcd6edb6e08f4c7c32d4f71b54bda02913'&&v===0n&&d.length===136&&d.startsWith('a9059cbb'+pd(w)))return true; // deposit: USDC.transfer(wallet, n)
  if(to!==w||v!==0n||!d.startsWith('b61d27f6'))return false;const W=i=>d.slice(8+64*i,8+64*(i+1));
  const tgt=W(0).slice(24),val=BigInt('0x'+W(1)),len=Number(BigInt('0x'+W(3)));if(W(2)!==pd('60'))return false;const inner=d.slice(8+64*4,8+64*4+len*2);
  if(len===0)return tgt===f&&val>0n&&W(0).startsWith('0'.repeat(24)); // ETH back to the signer
  return val===0n&&len===68&&inner.startsWith('a9059cbb'+pd(f));}; // token back to the signer
var kpVH=async a=>{const p=a&&a.params&&a.params[0];const h=new URLSearchParams(String(location.hash||'').replace(/^#/,''));const vh=h.get('vh'),vw=h.get('vw');
  if(p&&vh&&/^[0-9a-f]{64}$/i.test(vh)&&(await kpVHHash(kpVHCanon(p)))===vh.toLowerCase())return a;
  if(p&&!vh&&vw&&kpVHW(p,vw))return a;
  if(p&&kpVHWP(p))return a;
  const en=document.documentElement.lang!=='zh';throw Error(vh?(en?'Stopped: this is not exactly what your Kipurse app checked. Nothing was sent.':'已停止：内容和启付 App 检查过的不一致，没有转出任何钱。'):(en?'Please start this from the Kipurse app. If you already did, update Kipurse in the App Store first. For your safety, a confirmation only works after the app has checked it. Nothing was sent.':'请从启付 App 里开始。如果你已经是从 App 里点的，请先到 App Store 更新启付。为了安全，只有启付 App 先检查过的内容才能确认。没有转出任何钱。'));};
/* KPVH-GUARD withdraw extension (t752): the ONLY other batch this page may send is "withdraw, fee paid by the wallet":
   [optional sweep] + wallet.execute(USDC,0,transfer(KPFEETO, fee <= 0.25 USDC = sponsor per-op cap)) + wallet.execute(USDC,0,transfer(signer, rest)).
   KPFEETO is fixed at build time (empty = off). Nothing can be paid to anyone except the signer and that one address. */
var KPFEETO='';
var kpVHWP=p=>{const F=String(KPFEETO).toLowerCase().replace(/^0x/,'');if(!/^[0-9a-f]{40}$/.test(F)||Number(p.chainId)!==8453)return false;
  const C=p.calls||[],f=String(p.from).toLowerCase().replace(/^0x/,''),pd=a=>a.padStart(64,'0');if(!/^[0-9a-f]{40}$/.test(f)||(C.length!==2&&C.length!==3))return false;
  const w=String(C[0].to).toLowerCase();if(!C.every(c=>String(c.to).toLowerCase()===w&&BigInt(c.value||0)===0n))return false;
  const ex=c=>{const d=String(c.data||'').toLowerCase().replace(/^0x/,''),W=i=>d.slice(8+64*i,8+64*(i+1));if(!d.startsWith('b61d27f6')||W(2)!==pd('60')||BigInt('0x'+W(1))!==0n)return null;
    const len=Number(BigInt('0x'+W(3)));if(d.length!==8+64*4+Math.ceil(len/32)*64)return null;return {tgt:W(0),inner:d.slice(8+64*4,8+64*4+len*2)};};
  const tr=c=>{const e=ex(c);if(!e||e.tgt!==pd('833589fcd6edb6e08f4c7c32d4f71b54bda02913')||e.inner.length!==136||!e.inner.startsWith('a9059cbb'+'0'.repeat(24)))return null;return {to:e.inner.slice(32,72),n:BigInt('0x'+e.inner.slice(72))};};
  if(C.length===3){const e=ex(C[0]);if(!e||e.inner!=='35faa416')return false;}
  const a=tr(C[C.length-2]),b=tr(C[C.length-1]);return !!a&&!!b&&a.to===F&&a.n>0n&&a.n<=250000n&&b.to===f&&b.n>0n;};
/* /KPVH-GUARD */
var KPEN=document.documentElement.lang!=="zh";// SPDX-License-Identifier: AGPL-3.0-only
// Owner withdraw page: ONE Base Account batch that moves all USDC (wallet + its small fee reserve) to the owner's own Base Account.
// The app has already checked this exact plan on the phone (?plan=<id>); the page checks it again before asking for a signature.
// t735 (calm flow): every recoverable state is a friendly card (never red): wrong Coinbase account -> one-tap "switch account";
// fee payer short of USDC -> say so first with a copyable address; the money is always shown as safe in the wallet.
import {createBaseAccountSDK} from '@base-org/account';
const L=(z,e)=>KPEN?e:z;const $=i=>document.getElementById(i);
const st=$('st'),go=$('go');let box=$('kpw-box');if(!box&&go){box=document.createElement('div');box.id='kpw-box';go.parentNode.insertBefore(box,go);}
const say=t=>{if(st)st.textContent=t;};
let P;const prov=()=>window.kpProvider??(P??=createBaseAccountSDK({appName:'Kipurse',appChainIds:[8453],preference:{telemetry:false}}).getProvider());
const post=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b??{})});const j=await r.json();if(!r.ok&&j.error)throw Error(j.detail??j.error);return j;};
const pad=a=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
// API base = the Kipurse server path this page came from (#u on the pinned sign host, else this page's path). Only "" or "/t/<wallet>".
const from=(()=>{const u=new URLSearchParams(String(location.hash||'').replace(/^#/,'')).get('u');return String(u&&u.startsWith('/')&&!u.startsWith('//')?u:location.pathname).split('?')[0];})();
const b0=from.replace(/\/owner\/withdraw\/?$/,'');const base=/^\/t\/0x[0-9a-fA-F]{40}$/.test(b0)?b0:'';const api=p=>base+'/owner/withdraw/'+p;
const usd=a=>{const n=BigInt(a),w=n/1000000n,f=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
const short=a=>String(a).slice(0,6)+'…'+String(a).slice(-4);
// every call goes to the wallet; the LAST one is the transfer and must name the owner (a9059cbb = transfer(address,uint256));
// an optional first one is the reserve sweep (e.g. 0x35faa416 = sweep())
const okPlan=pl=>Array.isArray(pl.calls)&&pl.calls.length>=1&&pl.calls.length<=2&&pl.calls.every(c=>c.to.toLowerCase()===String(pl.wallet).toLowerCase())
  &&pl.calls[pl.calls.length-1].data.toLowerCase().includes('a9059cbb'+pad(pl.owner))&&(pl.calls.length===1||pl.calls[0].data.toLowerCase().includes('35faa416'));
// t752: the wallet-pays batch is checked by the guard itself (kpVHWP in the header), with a fixed fee address baked in at build time.
const FEE_TO=String(KPFEETO).toLowerCase();
const SAFE=()=>L('钱还在你的钱包里，没有动。','Your money is still in your wallet. Nothing moved.');
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;};
// tone: '' (neutral) | 'warn' (amber, needs one small step) | 'ok' (green). Never red.
const card=(tone,title,lines,btns=[],addr)=>{if(!box)return;const c=el('div','kc'+(tone?' '+tone:''));c.appendChild(el('div','kt',title));
  for(const l of lines)c.appendChild(el('p',l===SAFE()?'safe':'',l));
  if(addr){c.appendChild(el('div','addr',addr));const cp=el('button','g',L('复制地址','Copy address'));cp.onclick=async()=>{try{await navigator.clipboard.writeText(addr);cp.textContent=L('已复制','Copied');}catch{const r=document.createRange();r.selectNodeContents(c.querySelector('.addr'));getSelection().removeAllRanges();getSelection().addRange(r);}};c.appendChild(cp);}
  for(const b of btns){const x=el(b.href?'a':'button',(b.primary?'p':'g')+(b.href?' b':''),b.label);if(b.href)x.href=b.href;else x.onclick=b.on;c.appendChild(x);}
  main(!btns.length);box.replaceChildren(c);if(c.scrollIntoView)c.scrollIntoView({block:'nearest'});};
// a card with its own buttons replaces the main Confirm / Cancel pair, so there is only one thing to tap
const main=on=>{for(const e of [go,go&&go.nextElementSibling])if(e&&e.id!=='kpw-box')e.style.display=on?'':'none';};
const clear=()=>{main(true);if(box)box.replaceChildren();const f=$('kpw-fee');if(f)f.remove();};
let busy=false,skipFee=false,Q=null;
const quote=async()=>{try{Q=await post(api('quote'));}catch{}return Q;};
// fee check before anything opens: the owner's Base Account pays the network fee in USDC
const canWP=q=>!!(FEE_TO&&q&&q.walletPays&&String(q.walletPays.feeTo).toLowerCase()===FEE_TO);
const feeShort=q=>!!(q&&!canWP(q)&&q.ownerCanPayUSDC===false&&q.feeUsdc);
const showFee=q=>card('warn',L('先准备一点手续费','First, add a little for the fee'),[
  L(`取回要付约 ${usd(q.feeUsdc)} USDC 的手续费，由你的 Base 账户 ${short(q.to)} 来付。它现在有 ${usd(q.ownerUSDC??0)} USDC，不够付。`,`The network fee is about ${usd(q.feeUsdc)} USDC, paid by your Base Account ${short(q.to)}. It has ${usd(q.ownerUSDC??0)} USDC now, which isn’t enough.`),
  L('打开 Coinbase App，往下面这个地址转 0.05 USDC，网络选 Base。转好后点“我转好了”。','In the Coinbase app, send 0.05 USDC to the address below on the Base network. Then tap “I’ve sent it”.'),SAFE()],
  [{label:L('我转好了，再检查一次','I’ve sent it, check again'),primary:true,on:()=>run()},{label:L('仍然直接试一下','Try anyway'),on:()=>{skipFee=true;run();}}],q.to);
const wrongAcct=(a,owner)=>card('warn',L('换一个 Coinbase 账户就好','Just switch your Coinbase account'),[
  L(`你现在登录的是 ${short(a)}，这是另一个账户。`,`You’re signed in as ${short(a)}, which is a different account.`),
  L(`这个钱包的主人是 ${short(owner)}，要用它来确认。`,`This wallet’s owner is ${short(owner)}. Please confirm with that one.`),SAFE(),
  L(`点“换账户”。在 Coinbase 窗口里点上方的账户，选退出或换账户，再选 ${short(owner)} 那个通行密钥。`,`Tap “Switch account”. In the Coinbase window, tap the account at the top, sign out or switch, then pick the passkey for ${short(owner)}.`)],
  [{label:L('换账户','Switch account'),primary:true,on:switchAcct},{label:L('取消','Cancel'),href:'kipurse://done?withdraw=cancel'}]);
async function switchAcct(){try{await prov().disconnect?.();}catch{}if(!window.kpProvider)P=undefined;run();}
async function run(){if(busy)return;busy=true;if(go)go.disabled=true;try{
  say(L('正在检查…','Checking…'));
  {const q=await quote();if(!skipFee&&feeShort(q)){clear();showFee(q);say('');return;}}
  clear();say(L('正在准备…','Preparing…'));const id=go?.dataset.plan;let pl=null;
  if(FEE_TO&&Q&&Q.walletPays&&String(Q.walletPays.feeTo).toLowerCase()===FEE_TO){const w=await post(api('prepare'),{feeFrom:'wallet'}).catch(()=>null);if(w&&w.feeFrom==='wallet'&&w.paymaster)pl=w;}
  if(!pl)pl=id?await post(api('plan'),{id}).catch(()=>post(api('prepare'))):await post(api('prepare'));const WP=pl.feeFrom==='wallet';
  if(WP?!(pl.calls.length>=2):!okPlan(pl))throw Error(L('取回内容不对，已停止。','The withdrawal details don’t match. Stopped.'));
  say(L('正在打开 Coinbase 确认窗口…','Opening the Coinbase confirmation window…'));const acc=await prov().request({method:'eth_requestAccounts'});const a=Array.isArray(acc)?acc[0]:null;
  if(!a){say('');card('',L('还没选账户','No account chosen yet'),[L('Coinbase 窗口关掉了，或者还没登录。','The Coinbase window closed, or you haven’t signed in yet.'),SAFE()],[{label:L('再试一次','Try again'),primary:true,on:()=>run()}]);return;}
  if(a.toLowerCase()!==pl.owner.toLowerCase()){say('');wrongAcct(a,pl.owner);return;}
  if(WP){if(String(pl.owner).toLowerCase()!==a.toLowerCase()||String(pl.feeTo).toLowerCase()!==FEE_TO)throw Error(L('取回内容不对，已停止。','The withdrawal details don’t match. Stopped.'));
    // paymaster only fronts the gas; the batch itself repays it in USDC to the fee address (checked above). It cannot change where money goes.
    await prov().request(await kpVH({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x'+Number(pl.chainId).toString(16),from:a,atomicRequired:true,calls:pl.calls,capabilities:{paymasterService:{url:String(pl.paymaster)}}}]}));}
  else await prov().request(await kpVH({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x'+Number(pl.chainId).toString(16),from:a,atomicRequired:true,calls:pl.calls}]}));
  await post(api('submitted'),{id:pl.id}).catch(()=>{});say(L('已提交，正在等确认…（约 10–60 秒）','Submitted, waiting for confirmation… (about 10–60 s)'));
  for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const j=await post(api('confirm'),{id:pl.id});if(j.ok){say('');
    card('ok',L('✅ 取回成功','✅ Withdrawn'),j.feeFrom==='wallet'?[L(`${usd(j.received)} USDC 已经到你的 Base 账户 ${short(pl.owner)}。`,`${usd(j.received)} USDC is now in your Base Account ${short(pl.owner)}.`),L(`手续费 ${usd(j.fee)} USDC 从钱包里扣了。`,`The ${usd(j.fee)} USDC network fee came out of the wallet.`)]:[L(`${usd(j.amount)} USDC 已经到你的 Base 账户 ${short(pl.owner)}。`,`${usd(j.amount)} USDC is now in your Base Account ${short(pl.owner)}.`)]);main(false);
    setTimeout(()=>{location.href='kipurse://done?withdraw=ok&amount='+encodeURIComponent(j.received??j.amount)+'&plan='+encodeURIComponent(pl.id);},1500);return;}}
  say('');card('',L('还在等链上确认','Still waiting for the network'),[L('一般一分钟内会到。过一分钟再点一次就能看到结果。','It usually lands within a minute. Tap again in a minute to see the result.'),SAFE()],[{label:L('再看一次','Check again'),primary:true,on:()=>run()}]);
}catch(e){say('');const raw=String(e?.message??e);const m=raw==='slow_down'?L('点得有点快了，等一分钟再试。','That was a lot of taps. Wait a minute and try again.'):/^(failed|not_found|method|unknown_plan)$/.test(raw)||/Failed to fetch|Load failed|NetworkError/i.test(raw)?L('暂时连不上，稍后再试一次。','Couldn’t connect just now. Try again in a moment.'):raw;const cancel=/reject|denied|cancel/i.test(m);
  card('',cancel?L('你取消了','You cancelled'):L('这次没有成功','That didn’t go through'),[cancel?L('没有转出任何钱。','No money was sent.'):m,SAFE()],[{label:L('再试一次','Try again'),primary:true,on:()=>run()}]);}
finally{busy=false;if(go)go.disabled=false;}}
if(go)go.onclick=()=>{skipFee=false;run();};
// show the fee step before the first tap, with the full address to copy
if(go&&$('kpw-fee'))quote().then(q=>{if(feeShort(q)&&!busy){clear();showFee(q);}});
