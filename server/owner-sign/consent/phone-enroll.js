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
  const en=document.documentElement.lang!=='zh';throw Error(vh?(en?'Stopped: this is not exactly what your Kipurse app checked. Nothing was sent.':'已停止：内容和启付 App 检查过的不一致，没有转出任何钱。'):(en?'Please start this from the Kipurse app. If you already did, update Kipurse in the App Store first. For your safety, a confirmation only works after the app has checked it. Nothing was sent.':'请从启付 App 里开始。如果你已经是从 App 里点的，请先到 App Store 更新启付。为了安全，只有启付 App 先检查过的内容才能确认。没有转出任何钱。'));};
/* /KPVH-GUARD */
var KPEN=document.documentElement.lang!=="zh";// SPDX-License-Identifier: AGPL-3.0-only
// Owner signs ONE Base Account batch: deploy the phone approver + addOwnerAddress (or removeOwnerAtIndex to revoke).
import {createBaseAccountSDK} from '@base-org/account';
const D=JSON.parse(document.getElementById('kp-data').textContent),st=document.getElementById('st');const say=(t,c)=>{st.textContent=t;st.style.color=c||'';};
let P;const prov=()=>window.kpProvider??(P??=createBaseAccountSDK({appName:'Kipurse',appChainIds:[8453],preference:{telemetry:false}}).getProvider());
const post=async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json();};
let busy=false;document.getElementById('go').onclick=async()=>{if(busy)return;busy=true;try{
  say((KPEN?'Opening Base Account…':'正在打开 Base Account…'));const [a]=await prov().request({method:'eth_requestAccounts'});if(a.toLowerCase()!==D.owner.toLowerCase())throw Error((KPEN?'Please sign in with the wallet owner’s Base Account: ':'请用钱包主人的 Base Account 登录：')+D.owner);
  await prov().request(await kpVH({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x'+Number(D.chainId).toString(16),from:a,atomicRequired:true,calls:D.calls}]}));
  window.kpPending?.({});say((KPEN?'Submitted, waiting for Base to confirm… (about 10–60 s)':'已提交，等待 Base 确认…（约 10–60 秒）'));const url=D.mode==='enroll'?'/phone/enroll/confirm':'/phone/revoke/confirm';
  for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const j=await post(url,{id:D.id});if(j.ok){document.getElementById('go').style.display='none';window.kpDoneMsg?.(D.mode);say(D.mode==='enroll'?(KPEN?'✅ Added. Go back to the Kipurse app; from now on you can approve with Face ID.':'✅ 已添加。回到 Kipurse App，以后点批准链接就能用 Face ID 批准。'):(KPEN?'✅ Revoked.':'✅ 已撤销。'),'#080');busy=false;return;}if(j.error)throw Error(j.detail??j.error);}
  window.kpFail?.();say((KPEN?'Not on chain yet. Wait a minute, refresh the page and tap again.':'还没看到链上结果，过一分钟刷新页面再点一次。'));}catch(e){window.kpFail?.(e.message);say(e.message,'#c81e1e');}busy=false;};
