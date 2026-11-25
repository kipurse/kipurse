// SPDX-License-Identifier: AGPL-3.0-only
// t1214 (decision 102 / decision 101): the owner's "switch to V5.4" page (and its rollback, ?mode=rollback). Opened ONLY from the developer/test App,
// which decoded and checked the batch first and put its SHA-256 commitment in the link (#vh=, never sent to a server). The KPVH guard
// refuses any batch that differs by one byte. The owner's Base Account confirms once in Coinbase; the fee is the actual cost in USDC from
// the Kipurse wallet inside the same batch (Kipurse's paymaster fronts the gas for that exact batch only). Never ETH, no auto-retry.
import {createBaseAccountSDK} from '@base-org/account';
const KPEN=document.documentElement.lang!=='zh';const $=i=>document.getElementById(i);
const D=JSON.parse($('kp-data').textContent),st=$('st'),go=$('go');const say=(t,c)=>{st.textContent=t;st.style.color=c||'';};
const vh=new URLSearchParams(String(location.hash||'').replace(/^#/,'')).get('vh');
const post=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json();};
let P;const prov=()=>window.kpProvider??(P??=createBaseAccountSDK({appName:'Kipurse',appChainIds:[8453],preference:{telemetry:false}}).getProvider());
const iab=/FBAN|FBAV|Instagram|MicroMessenger|Twitter|LinkedInApp|GSA\/|Grok/i.test(navigator.userAgent)||(/iPhone|iPad|iPod/.test(navigator.userAgent)&&!/Safari\//.test(navigator.userAgent));
let J=null;
async function prep(){const j=await post(D.prepare,{from:D.owner,mode:D.mode});if(j.error)throw Error(KPEN?'Not possible right now ('+j.error+'). Nothing was submitted.':'现在没法继续（'+j.error+'），没有提交任何内容。');
  if(typeof j.paymaster!=='string'||!j.paymaster.startsWith(location.origin+'/migrate-v54/paymaster?id=mg54-'))throw Error(KPEN?'Stopped. Nothing was sent.':'已停止，没有转出任何钱。');return j;}
if(iab){go.style.display='none';say(KPEN?'Please open this page in Safari. Nothing has happened.':'请在 Safari 里打开这个页面。什么都没有发生。','#b45309');}
else if(!vh||!/^[0-9a-f]{64}$/i.test(vh)){go.style.display='none';say(KPEN?'Open this from the Kipurse test app. Nothing has happened.':'请从启付测试版 App 打开。什么都没有发生。','#b45309');}
else{prov();go.disabled=true;say(KPEN?'Getting the batch ready…':'正在准备…');prep().then(j=>{J=j;go.disabled=false;say('');},e=>say(e.message,'#b45309'));}
let busy=false;go.onclick=async()=>{if(busy||!J)return;busy=true;go.disabled=true;try{
  const acc=await prov().request({method:'eth_requestAccounts'});const a=Array.isArray(acc)?acc[0]:null;
  if(!a||String(a).toLowerCase()!==String(D.owner).toLowerCase())throw Error(KPEN?'Please use your own Base Account. Nothing was submitted.':'请用你自己的 Base 账户。没有提交任何内容。');
  await prov().request({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x2105',from:a,atomicRequired:true,calls:J.calls,capabilities:{paymasterService:{url:J.paymaster}}}]});
  J=null;say(KPEN?'Submitted, waiting for Base… (10–60 s)':'已提交，等待 Base 确认…（约 10–60 秒）');
  for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const s=await fetch(D.status).then(r=>r.json()).catch(()=>({}));
    if((D.mode==='rollback'&&s.rolledBack)||(D.mode!=='rollback'&&s.migrated)){go.style.display='none';say(KPEN?'✅ Done. You can close this page.':'✅ 完成。可以关掉这个页面。','#080');return;}}
  say(KPEN?'Not on chain yet. Wait a minute and refresh. Do not confirm again unless the page asks.':'还没看到链上结果。等一分钟后刷新；除非页面再次提示，不要重复确认。');}
 catch(e){const m=String(e&&e.message||e);say(/reject|denied|cancel/i.test(m)?(KPEN?'You cancelled. Nothing was submitted.':'你取消了，没有提交任何内容。'):m,'#b45309');try{J=await prep();}catch{}}
 finally{busy=false;if(go.style.display!=='none')go.disabled=!J;}};
