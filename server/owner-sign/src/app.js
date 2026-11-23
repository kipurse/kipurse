// SPDX-License-Identifier: AGPL-3.0-only
// Owner signing page: the owner's Base Account signs here; the server only prepares and relays.
import {createBaseAccountSDK} from '@base-org/account';
const $=s=>document.querySelector(s),app=$('#app'),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=a=>(Number(BigInt(a??0))/1e6).toString()+' USDC';let CSRF,ST,P,ME,MSG='',BUSY=false;
const api=async(p,b)=>{const r=await fetch('/api/'+p,{method:b?'POST':'GET',headers:{'content-type':'application/json','x-kp-csrf':CSRF},body:b?JSON.stringify(b):undefined});const j=await r.json();if(!r.ok)throw Error(j.detail??j.error);return j;};
const provider=()=>P??=createBaseAccountSDK({appName:'Kipurse',appChainIds:[8453],preference:{telemetry:false}}).getProvider();
async function me(){if(ME)return ME;const [a]=await provider().request({method:'eth_requestAccounts'});if(a.toLowerCase()!==ST.owner.toLowerCase())throw Error('Please sign in with your Base Account '+ST.owner+' (this is '+a+')');return ME=a;}
const act=fn=>async()=>{if(BUSY)return;BUSY=true;MSG='';draw();try{MSG=await fn();}catch(e){MSG='<span class=bad>'+esc(e.message)+'</span>';}BUSY=false;await refresh();};
const capRaise=act(async()=>{await me();const p=await api('capPrepare',{});if(!confirm('You will sign ONE batch in your Base Account:\n\n- '+p.labels.join('\n- ')+'\n\nPer payment: '+p.human.perPayment+'\nPer day: '+p.human.perDay+'\nTotal: '+p.human.total+'\nValid: '+p.human.validity))return 'Cancelled.';
  const id=await provider().request(p.send);for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,3000));const c=await api('capConfirm',{});if(c.ok)return '<span class=ok>Done: per-payment cap is now '+esc(p.human.perPayment)+'.</span>';}
  return 'Sent ('+esc(typeof id==='string'?id:id?.id??'')+'). Waiting for Base; tap the button again in a minute.';});
const approve=id=>act(async()=>{await me();const r=await api('trustApprove',{id});const sig=await provider().request({method:'eth_signTypedData_v4',params:[ME,JSON.stringify(r.typedData)]});
  const d=await api('trustSign',{id,signature:sig});return '<span class=ok>Trusted on chain.</span> <span class=mono>'+esc(d.txHash??'')+'</span>';});
const reject=id=>act(async()=>{await api('trustReject',{id});return 'Rejected.';});
function draw(){if(!ST){app.textContent='Loading…';return;}const s=ST.status??{},pend=ST.trustRequests?.pending??[];
  app.innerHTML=`<h2>Kipurse · owner signing</h2><p><small>Wallet <span class=mono>${esc(ST.wallet)}</span><br>Your Base Account <span class=mono>${esc(ST.owner)}</span></small></p>${MSG?`<p>${MSG}</p>`:''}
  <div class=card><h3>1 · Per-payment cap</h3><p>Now: <b>${usd(s.single)}</b> per payment, ${usd(s.daily)} per day.</p>${s.capOk?'<p class=ok>Ready for this payment size.</p>':`<p>Raise it to <b>${usd(s.targetSingle)}</b> per payment (nothing else changes). One signature; your Base Account pays a tiny network fee.</p><button id=cap ${BUSY?'disabled':''}>Raise cap · sign in Base Account</button>`}</div>
  <div class=card><h3>2 · Payees an AI asked you to trust</h3>${pend.length?'':'<p>None right now.</p>'}${pend.map(r=>`<div class=card><p><b>Address — check every character:</b><br><span class=mono>${esc(r.payee)}</span></p>
   <p>Chain: ${esc(r.chain)} · up to <b>${usd(r.single)}</b> per payment, <b>${usd(r.total)}</b> per day · ${esc(r.expiresInDays)} days</p>
   <p class=warn><small>Written by the AI (unverified):</small><br>${esc(r.merchantName)} — ${esc(r.reason)}<br><small>asked by ${esc(r.requestedBy.join(', '))}</small></p>
   <button data-a="${esc(r.id)}" ${BUSY||!s.capOk?'disabled':''}>Trust &amp; sign in Base Account</button><button class=alt data-r="${esc(r.id)}" ${BUSY?'disabled':''}>Reject</button>${s.capOk?'':'<small>Do step 1 first.</small>'}</div>`).join('')}</div>
  <p><small>An AI can only ask. Nothing is trusted until you sign. The network fee for adding trust is paid in USDC from your own vault.</small></p>`;
  $('#cap')?.addEventListener('click',capRaise);app.querySelectorAll('[data-a]').forEach(b=>b.onclick=approve(b.dataset.a));app.querySelectorAll('[data-r]').forEach(b=>b.onclick=reject(b.dataset.r));}
async function refresh(){ST=await api('state');draw();}
(async()=>{CSRF=(await (await fetch('/api/csrf')).json()).csrf;await refresh();setInterval(()=>{if(!BUSY)refresh().catch(()=>{});},10000);})().catch(e=>app.textContent='Error: '+e.message);
