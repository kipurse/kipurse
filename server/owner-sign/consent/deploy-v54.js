// SPDX-License-Identifier: AGPL-3.0-only
// t1214 (decision 102, owner t1230; decision 101 owner t1227 "[zh]"): ONE-TIME V5.4 adapter deploy page, the same proven way as V5.3
// (decision 87–90). The owner's Base Account confirms exactly ONE fixed batch: deployer <- V5.4 adapter init code (it creates its own trust
// contract and registers its vault implementations in the V5.3 factory) + USDC fee leg 0.15 to the fixed Kipurse fee address.
// Gas is fronted by Kipurse's paymaster for that exact batch only and repaid in USDC inside it; never ETH (Coinbase's estimator handles
// this single ~9.5M-gas batch: CDP estimate t1214 = call 9,493,432). The KPVH guard (link #vh=) refuses any other batch; this script
// re-checks the pin. Another app's built-in browser: button hidden, open in Safari. No automatic retry, never a loop.
import {createBaseAccountSDK} from '@base-org/account';
const KPEN=document.documentElement.lang!=='zh';const $=i=>document.getElementById(i);
const D=JSON.parse($('kp-data').textContent),st=$('st'),go=$('go'),help=$('help');const say=(t,c)=>{st.textContent=t;st.style.color=c||'';};
const DEPLOYER='0x4e59b44847b379578588920ca78fbf26c0b4956c',USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const PIN=['0x99d8dfec40023f53f6e451f9afff7efc223b7aaa','896ff350a8d71c6a0dd88e348f421b94954ccfad21e3e805c924105a7e2b6a23'];
const hex=a=>Array.from(new Uint8Array(a)).map(b=>b.toString(16).padStart(2,'0')).join('');
const sha=async h=>hex(await crypto.subtle.digest('SHA-256',new Uint8Array(String(h).replace(/^0x/,'').match(/../g).map(x=>parseInt(x,16)))));
const pd=a=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
async function pinned(j){const C=j&&j.calls;if(!Array.isArray(C)||C.length!==2)return false;
  if(String(C[0].to).toLowerCase()!==DEPLOYER||BigInt(C[0].value||0)!==0n)return false;if((await sha(C[0].data))!==PIN[1])return false;
  if(String(D.pin&&D.pin.adapter||'').toLowerCase()!==PIN[0])return false;
  const f=C[1];if(String(f.to).toLowerCase()!==USDC||BigInt(f.value||0)!==0n)return false;
  if(String(f.data).toLowerCase()!=='0xa9059cbb'+pd(D.feeTo)+pd(BigInt(D.fee).toString(16)))return false;
  return typeof j.paymaster==='string'&&j.paymaster.startsWith(location.origin+'/deploy-v54/paymaster?id=dv54-');}
/** Another app's built-in browser (WKWebView: iOS without the "Safari/" token, or a known in-app token). Safari, the Safari view other apps use
 *  (same UA as Safari), and full browsers keep window.opener for the Coinbase window. */
function inAppBrowser(ua,maxTouch){const iOS=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&maxTouch>1);
  if(/FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|WeChat|Twitter|LinkedInApp|Snapchat|TikTok|musical_ly|Bytedance|Weibo|QQ\/|GSA\/|Grok/i.test(ua))return true;
  return iOS&&!/Safari\//.test(ua);}
const link=()=>location.origin+location.pathname+location.hash;
const copy=async(b,out)=>{try{await navigator.clipboard.writeText(link());b.textContent=KPEN?'Copied ✓':'已复制 ✓';if(out)out.textContent=KPEN?'Now open Safari and paste it into the address bar.':'现在打开 Safari，粘贴到地址栏。';}
  catch{if(out)out.textContent=link();}};
for(const id of ['cpl','cpl2']){const b=$(id);if(b)b.onclick=()=>copy(b,$('cps'));}
{const b=$('osf');if(b)b.onclick=()=>{location.href='x-safari-'+link();};}
const H=new URLSearchParams(String(location.hash||'').replace(/^#/,'')),VH=H.get('vh');
const linkOk=!!VH&&/^[0-9a-f]{64}$/i.test(VH);
const done=()=>{go.style.display='none';help.style.display='none';say(KPEN?'✅ Done. The V5.4 contract is on Base. This page is now finished; you can close it.':'✅ 完成。V5.4 合约已经在 Base 上了。这个页面已经完成任务，可以关掉。','#080');};
const ERR={not_owner:KPEN?'This is a different Coinbase account. Please sign in with your own Base Account ':'这是另一个 Coinbase 账户。请用你自己的 Base 账户登录 ',needs_usdc:KPEN?'Your Base Account does not have enough USDC for this step’s fee. Add some USDC and refresh this page.':'你的 Base 账户里的 USDC 不够付这一步的手续费。先放一点 USDC，再刷新这个页面。',
  partial:KPEN?'The on-chain state is not what this page expects. Nothing was submitted.':'链上状态和预期不一致，没有提交任何内容。',unavailable:KPEN?'Paying the fee in USDC is not possible right now. Nothing was submitted. Please try again later.':'现在暂时没法用 USDC 付手续费，没有提交任何内容。请稍后再试。'};
const post=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json();};
let P;const prov=()=>window.kpProvider??(P??=createBaseAccountSDK({appName:'Kipurse',appChainIds:[8453],preference:{telemetry:false}}).getProvider());
let J=null,ready=null;
async function prep(){const j=await post(D.prepare,{from:D.owner});if(j.done){done();return null;}if(j.error)throw Error(ERR[j.error]||(KPEN?'Not possible right now. Nothing was submitted.':'现在没法继续，没有提交任何内容。'));
  if(!(await pinned(j)))throw Error(KPEN?'Stopped: this is not exactly the fixed deploy batch. Nothing was sent.':'已停止：内容和固定的部署批次不一致，没有转出任何钱。');return j;}
if(inAppBrowser(navigator.userAgent,navigator.maxTouchPoints||0)){go.style.display='none';$('safari').style.display='';}
else if(!linkOk){go.style.display='none';say(KPEN?'This is an old link. Please use the new link from your Kipurse assistant (open it in Safari). Nothing has happened.':'这是旧链接。请用启付助手刚发的新链接（同样在 Safari 里打开）。什么都没有发生。','#b45309');}
else{prov();   // create the Base Account SDK now (its COOP check runs before the tap, like the proven sign pages)
  go.disabled=true;say(KPEN?'Getting the batch ready…':'正在准备…');
  ready=prep().then(j=>{J=j;if(j){go.disabled=false;say('');}return j;},e=>{say(e.message,'#b45309');return null;});}
const calm=e=>{const m=String(e&&e.message||e||'');if(/reject|denied|cancel/i.test(m))return KPEN?'You cancelled. Nothing was submitted.':'你取消了，没有提交任何内容。';
  if(/popup|blocked|opener|closed/i.test(m))return KPEN?'The Coinbase window could not stay open here. Nothing was submitted.':'Coinbase 窗口在这里打不开或被关掉了，没有提交任何内容。';
  if(/Failed to fetch|Load failed|NetworkError/i.test(m))return KPEN?'Couldn’t connect just now. Nothing was submitted. Try again in a moment.':'暂时连不上，没有提交任何内容。稍后再试一次。';return m;};
let busy=false;go.onclick=async()=>{if(busy||!J)return;busy=true;go.disabled=true;help.style.display='none';try{
  say(KPEN?'Opening Coinbase…':'正在打开 Coinbase…');const acc=await prov().request({method:'eth_requestAccounts'});const a=Array.isArray(acc)?acc[0]:null;   // first thing after the tap: the window opens inside the gesture
  if(!a)throw Error(KPEN?'No account was chosen. Nothing was submitted.':'没有选账户，没有提交任何内容。');
  if(String(a).toLowerCase()!==String(D.owner).toLowerCase())throw Error(ERR.not_owner+D.owner.slice(0,6)+'…'+D.owner.slice(-4)+(KPEN?'. Nothing was submitted.':'。没有提交任何内容。'));
  say(KPEN?'Check it in Coinbase (deploy + 0.15 USDC fee), then confirm.':'请在 Coinbase 里看一下（部署 + 0.15 USDC 手续费），然后确认。');
  await prov().request({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x2105',from:a,atomicRequired:true,calls:J.calls,capabilities:{paymasterService:{url:J.paymaster}}}]});
  J=null;say(KPEN?'Submitted, waiting for Base to confirm… (about 10–60 s)':'已提交，等待 Base 确认…（约 10–60 秒）');
  for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const s=await post(D.confirm,{}).catch(()=>({}));if(s.ok){done();return;}}
  say(KPEN?'Not on chain yet. Wait a minute and refresh this page. Do not confirm again unless the page asks.':'还没看到链上结果。等一分钟后刷新页面；除非页面再次提示，不要重复确认。');}
 catch(e){say(calm(e),'#b45309');help.style.display='';try{J=await prep();}catch{}}   // fresh prepared id for the next manual tap; no automatic retry
 finally{busy=false;if(go.style.display!=='none')go.disabled=!J;}};
// coming back from another tab/app while the Coinbase window is still pending: show the calm help card (no retry, no loop)
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&busy)help.style.display='';});
