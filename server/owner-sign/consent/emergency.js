// SPDX-License-Identifier: AGPL-3.0-only
// Emergency page: the owner signs ONE server-written message with his Base Account (free, no transaction); the server verifies it, then acts.
import {createBaseAccountSDK} from '@base-org/account';
const D=JSON.parse(document.getElementById('kp-data').textContent),st=document.getElementById('st');const T=(zh,en)=>D.en?en:zh;
const say=(t,c)=>{st.textContent=t;st.style.color=c||'';};let P;const prov=()=>window.kpProvider??(P??=createBaseAccountSDK({appName:'Kipurse',appChainIds:[8453],preference:{telemetry:false}}).getProvider());
const hex=s=>'0x'+Array.from(new TextEncoder().encode(s),b=>b.toString(16).padStart(2,'0')).join('');
const post=async(p,b)=>{const r=await fetch('emergency/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw Error(j.detail??j.error);return j;};
let busy=false;const run=action=>async()=>{if(busy)return;busy=true;try{
  say(T('正在打开 Base Account…','Opening Base Account…'));const [a]=await prov().request({method:'eth_requestAccounts'});
  if(a.toLowerCase()!==D.owner.toLowerCase())throw Error(T('请用钱包主人的 Base Account 登录：','Please sign in with the wallet owner’s Base Account: ')+D.owner);
  const c=await post('challenge',{action});say(T('请在 Base Account 里确认（免费）…','Confirm the free signature in Base Account…'));
  const sig=await prov().request({method:'personal_sign',params:[hex(c.message),a]});const r=await post('act',{nonce:c.nonce,signature:sig});
  if(action==='pause')say(T('✅ AI 付款已暂停。要恢复，先绑定手机，再用 Face ID 恢复。','✅ AI payments are paused. To resume, bind your phone, then resume with Face ID.'),'#080');
  else{say(T('✅ 已取消 ','✅ Cancelled ')+(r.cancelled??0)+T(' 笔等待中的付款。',' waiting payment(s).'),'#080');const h=document.getElementById('holds');if(h)h.textContent=String(r.left??0);}
}catch(e){say(/reject|denied|cancel/i.test(String(e?.message))?T('你取消了，什么都没改。','You cancelled. Nothing changed.'):e.message,'#c81e1e');}busy=false;};
document.getElementById('pause').onclick=run('pause');document.getElementById('cancel').onclick=run('cancel_holds');
