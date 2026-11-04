var KPEN=document.documentElement.lang!=="zh";// SPDX-License-Identifier: AGPL-3.0-only
// Public trust approval: the owner signs the trustBySig wallet message with his Base Account (passkey / Face ID). Server verifies, then relays.
import {createBaseAccountSDK} from '@base-org/account';
const D=JSON.parse(document.getElementById('kp-data').textContent),st=document.getElementById('st');const T=(zh,en)=>D.en?en:zh;
const say=(t,c)=>{st.textContent=t;st.style.color=c||'';};let P;const prov=()=>window.kpProvider??(P??=createBaseAccountSDK({appName:'Kipurse',appChainIds:[8453],preference:{telemetry:false}}).getProvider());
const hex=s=>'0x'+Array.from(new TextEncoder().encode(s),b=>b.toString(16).padStart(2,'0')).join('');
async function post(p,b){const r=await fetch('/approve/trust/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:D.id,...b})});const j=await r.json();if(!r.ok)throw Object.assign(Error(j.detail??j.error),{j});return j;}
async function me(){const [a]=await prov().request({method:'eth_requestAccounts'});if(a.toLowerCase()!==D.owner.toLowerCase())throw Error(T('请用钱包主人的 Base Account 登录：','Please sign in with the wallet owner’s Base Account: ')+D.owner);return a;}
const hide=()=>{for(const i of ['ok','no']){const e=document.getElementById(i);if(e)e.style.display='none';}};
let busy=false;const run=fn=>async()=>{if(busy)return;busy=true;try{await fn();}catch(e){if(e.j?.error==='not_pending'){hide();say(e.j.status==='trusted'?T('✅ 已经信任过了。','✅ Already trusted.'):T('这个请求已经处理过了：','Already handled: ')+e.j.status);}else say(e.message,'#c81e1e');}busy=false;};
document.getElementById('ok').onclick=run(async()=>{say(T('正在打开 Base Account…','Opening Base Account…'));const a=await me();say(T('正在准备确认内容…','Preparing…'));
  const {typedData}=await post('prepare',{});say(T('请在 Base Account 里确认…','Confirm the signature in Base Account…'));
  const sig=await prov().request({method:'eth_signTypedData_v4',params:[a,JSON.stringify(typedData)]});say(T('正在核对确认并上链…（约 10–30 秒）','Checking the signature and writing it on chain… (10–30 s)'));
  const r=await post('sign',{signature:sig});hide();say(T('✅ 已信任。现在可以回到 Muse，让它付款。','✅ Trusted. Go back to Muse and let it pay.')+(r.txHash?' tx '+r.txHash:''),'#080');});
document.getElementById('no').onclick=run(async()=>{const a=await me();const sig=await prov().request({method:'personal_sign',params:[hex(D.reject),a]});await post('reject',{signature:sig});hide();say(T('已拒绝。','Rejected.'));});
