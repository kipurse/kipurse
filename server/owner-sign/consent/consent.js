var KPEN=document.documentElement.lang!=="zh";// SPDX-License-Identifier: AGPL-3.0-only
// Mainnet OAuth consent: the owner proves he owns the wallet by signing the shown message with his Base Account (passkey / Face ID).
// Free, no transaction. The server verifies the signature on chain (ERC-1271/6492) before issuing the agent's code.
import {createBaseAccountSDK} from '@base-org/account';
const D=JSON.parse(document.getElementById('kp-data').textContent),st=document.getElementById('st');const T=(zh,en)=>D.en?en:zh;
const say=(t,bad)=>{st.textContent=t;st.style.color=bad?'#c81e1e':'';};let P;const prov=()=>window.kpProvider??(P??=createBaseAccountSDK({appName:'Kipurse',appChainIds:[8453],preference:{telemetry:false}}).getProvider());
const hex=s=>'0x'+Array.from(new TextEncoder().encode(s),b=>b.toString(16).padStart(2,'0')).join('');
async function post(b){const r=await fetch('/oauth/owner-decide',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({req:D.req,...b})});const j=await r.json();if(!r.ok)throw Error(j.error_description??j.error);return j;}
const back=(url,ok)=>{const b=document.getElementById('back');b.innerHTML='';const a=document.createElement('a');a.className='btn p';a.href=url;a.id='backbtn';
  a.textContent=ok?T('返回 ','Return to ')+(D.client||'AI')+T(' 完成连接',' to finish connecting'):T('返回 ','Return to ')+(D.client||'AI');a.style.fontSize='20px';b.appendChild(a);
  for(const id of ['ok','no']){const e=document.getElementById(id);if(e)e.style.display='none';}a.scrollIntoView({block:'center'});
  say(ok?T('已批准。如果没有自动返回，请点上面的按钮。','Approved. If it doesn’t return by itself, tap the button above.'):T('已拒绝。','Declined.'));try{location.href=url;}catch{}};
const gone=t=>{clearInterval(poll);for(const id of ['ok','no']){const e=document.getElementById(id);if(e)e.style.display='none';}const b=document.getElementById('back');b.innerHTML='';say(t,true);};
// approved elsewhere / page reopened: show the return button from the status poll; used or expired: say so
const poll=setInterval(async()=>{try{const j=await (await fetch('/oauth/status?req='+encodeURIComponent(D.req))).json();if(j.redirect){clearInterval(poll);back(j.redirect,j.status==='approved');}
  else if(j.status==='used')gone(T('这个连接已经完成，请回到 ','This connection is already done — go back to ')+(D.client||'AI')+T('。',''));else if(j.status==='expired')gone(T('请求已过期，请回到 AI 重新连接。','This request expired — go back to your AI and connect again.'));}catch{}},3000);
let busy=false;const run=fn=>async()=>{if(busy)return;busy=true;try{await fn();}catch(e){say(e.message,true);}busy=false;};
document.getElementById('ok').onclick=run(async()=>{say(T('正在打开 Base Account…','Opening Base Account…'));const [a]=await prov().request({method:'eth_requestAccounts'});
  if(D.owner&&a.toLowerCase()!==D.owner.toLowerCase())throw Error(T('请用钱包主人的 Base Account 登录：','Please sign in with the wallet owner’s Base Account: ')+D.owner);
  const sig=await prov().request({method:'personal_sign',params:[hex(D.message),a]});say(T('正在核对确认…','Checking the signature…'));
  const j=await post({approve:true,signature:sig});clearInterval(poll);back(j.redirect,true);});
document.getElementById('no').onclick=run(async()=>{const j=await post({approve:false});clearInterval(poll);back(j.redirect,false);});
