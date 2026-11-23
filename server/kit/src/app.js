import {createBaseAccountSDK} from '@base-org/account';
import {checkAnswersZh,checkLimitChangeZh,TERM_MIN_DAYS,TERM_MAX_DAYS} from '../../src/v5/answer-rules.mjs';
const $=s=>document.querySelector(s);const app=$('#app');const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let ERR='',LIM={},WD='',CSRF=null,ST=null,P=null,OWNER=null,ANS={},STEP=0,PREP=null,AGENT=null,MSG='';
const api=async(p,b)=>{const r=await fetch('/api/'+p,{method:b?'POST':'GET',headers:{'content-type':'application/json','x-kp-csrf':CSRF},body:b?JSON.stringify(b):undefined});const j=await r.json();if(!r.ok)throw Error(j.error);return j;};
const T=(zh,en)=>`${zh}<div class=en>${en}</div>`;
// plain-word choices (examples only: the owner picks; nothing is pre-selected)
const CH={termDays:[30,90,180,365],perPayment:['1','2','5','10'],perDay:['2','5','10','20'],termTotal:['10','20','50','100'],unrecognizedPerPayment:['0.1','0.2','0.5','1'],unrecognizedPerDay:['0.2','0.5','1','2'],depositDailyLimit:['5','10','20','50']};
const Q={withdraw:['取回多少？','How much?','USDC'],termDays:['授权多久？','How long?','天 days'],perPayment:['AI 每笔最多付多少？','Max per payment','USDC'],perDay:['AI 每天最多花多少？','Max per day','USDC'],termTotal:['整个期间最多花多少？','Max for the whole period','USDC'],
  unrecognizedPerPayment:['付给陌生收款方，每笔最多？','Unknown payee: max per payment','USDC'],unrecognizedPerDay:['付给陌生收款方，每天最多？','Unknown payee: max per day','USDC'],depositDailyLimit:['每天最多接收多少充值？（超出先隔离，不退回）','Max deposits per day (extra is held, not bounced)','USDC']};
const KEYS=Object.keys(Q).filter(k=>k!=='withdraw');
// iOS app handoff: ?answers=<base64url JSON> pre-fills the questions (still validated + consented here); ?return=kipurse sends the owner back to the app.
const QS=new URLSearchParams(location.search);const RET=QS.get('return')==='kipurse';const DO=QS.get('do');let DONE_DO=false;// app handoff for account deletion: do=exit (take everything back + revoke) / do=revoke (revoke only)
const back=step=>{if(RET)setTimeout(()=>{location.href='kipurse://done?step='+encodeURIComponent(step);},600);};
try{const a=QS.get('answers');if(a){const j=JSON.parse(decodeURIComponent(escape(atob(a.replace(/-/g,'+').replace(/_/g,'/')))));for(const k of KEYS)if(j[k]!=null)ANS[k]=String(j[k]);STEP=KEYS.length;}}catch{}
async function provider(){if(P)return P;const sdk=createBaseAccountSDK({appName:'Kipurse (TEST)',appChainIds:[84532],preference:{telemetry:false}});P=sdk.getProvider();return P;}
async function connect(){const p=await provider();const [a]=await p.request({method:'eth_requestAccounts'});OWNER=a;try{await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x14a34'}]});}catch{}render();}
async function sendCalls(calls){const p=await provider();const r=await p.request({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:'0x14a34',from:OWNER,atomicRequired:true,calls}]});
  const id=typeof r==='string'?r:r.id;for(let i=0;i<240;i++){const s=await p.request({method:'wallet_getCallsStatus',params:[id]});if(s.status===200||s.status==='CONFIRMED'||s.status==='success')return s;if(Number(s.status)>=400||s.status==='FAILED')throw Error('失败 failed');await new Promise(z=>setTimeout(z,1500));}throw Error('timeout');}
const step=(n,title,body,state)=>`<div class="step ${state}"><h2>${state==='done'?'✅':n+'.'} ${title}</h2>${state==='todo'?'':body}</div>`;
// big preset buttons + '自己填' (numeric keypad on iPhone). Presets are examples only; nothing is pre-selected.
function chips(k,cur=ANS[k],attr='data-k',inAttr='data-in',unit=Q[k][2],list=CH[k]){const isDays=k==='termDays';
  return `<div class=chips>${list.map(v=>`<button class="${String(cur)===String(v)?'sel':''}" ${attr}="${k}" data-v="${v}">${v} ${unit}</button>`).join('')}</div>
  <label class=own>自己填 / your own:<span class=row><input type=text ${isDays?'inputmode=numeric pattern="[0-9]*"':'inputmode=decimal'} autocomplete=off enterkeyhint=done ${inAttr}="${k}" placeholder="${isDays?`${TERM_MIN_DAYS}–${TERM_MAX_DAYS}`:'例如 3.5'}" value="${list.map(String).includes(String(cur??''))?'':esc(cur??'')}"><b>${unit}</b></span></label>
  ${isDays?`<p class=en>合约允许 ${TERM_MIN_DAYS} 到 ${TERM_MAX_DAYS} 天的任意整数天。Any whole number of days ${TERM_MIN_DAYS}–${TERM_MAX_DAYS}.</p>`:'<p class=en>USDC，最多 6 位小数 / up to 6 decimals</p>'}`;}
const stepCheck=()=>{const sub=Object.fromEntries(KEYS.slice(0,STEP+1).map(k=>[k,ANS[k]]));const r=checkAnswersZh(sub,{partial:true});const k=KEYS[STEP];
  const mine=r.errors.filter(e=>e.key===k||KEYS.indexOf(e.key)<=STEP);return {...r,errors:mine};};
function setupBody(){if(STEP<KEYS.length){const k=KEYS[STEP];return `<p>第 ${STEP+1}/${KEYS.length} 题 · ${T(Q[k][0],Q[k][1])}</p>${chips(k)}<p class=en>这些数字只是例子，你自己选。Numbers are examples; you choose.</p>${ERR?`<p class=bad>${esc(ERR)}</p>`:''}
    <button id=next ${ANS[k]==null||ANS[k]===''?'disabled':''}>下一步 Next</button>${STEP?'<button class=alt id=back>上一步 Back</button>':''}`;}
  const d=ST.disclosure;const all=checkAnswersZh(ANS);return `${all.errors.map(e=>`<p class=bad>${esc(e.zh)}</p>`).join('')}${all.warnings.map(w=>`<div class=warn><b>⚠️ ${esc(w)}</b></div>`).join('')}<table>${KEYS.map(k=>`<tr><td>${Q[k][0]}</td><td><b>${esc(ANS[k])}</b> ${Q[k][2]}</td></tr>`).join('')}<tr><td>提现地址 Withdraw to</td><td class=mono>${esc(OWNER)}（你自己的钱包）</td></tr></table><button class=alt id=back>修改 Change</button>
    <div class=warn><b>${esc(ST.riskZh)}</b><div class=en>${esc(ST.riskEn)}</div></div><ul>${d.zh.slice(1).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>
    <label><input type=checkbox id=ack> 我明白：这个钱包完全由 AI 控制，我只放少量资金；以后存进去的钱也受这次授权管。 <span class=en>I understand.</span></label>
    <label><input type=checkbox id=consent> 我同意：手续费 0.1%（最高 0.3%），gas 用 USDC 付。 <span class=en>I agree to the fee and gas.</span></label>
    <button id=prep disabled data-bad="${all.ok?'':'1'}">准备 Prepare</button>`;}
function depositBlock(d,wallet){return `<p>${T('把测试 USDC 转到这个地址（Base Sepolia）：','Send test USDC (Base Sepolia) to:')}</p><div>${d.qrSvg}</div><p class=mono>${esc(wallet)}</p>
  <button class=alt data-copy="${esc(wallet)}">复制地址 Copy address</button><a class="btn alt" style="background:#eee;color:#111" href="https://faucet.circle.com/" target=_blank rel=noopener>免费领测试 USDC / Get free test USDC</a>
  <p class=en>只收 Base 网络上的 USDC。其他链或 USDC.e 会丢。Only USDC on Base; other chains / USDC.e may be lost.</p>`;}
function fundStatus(){const b=Number(ST.balance??0)/1e6,el=ST.elsewhere??[],t=ST.checkedAt?new Date(ST.checkedAt).toLocaleTimeString():'';
  const wrong=el.map(x=>`<li>${esc(x.chain)}：${esc(x.amount)} USDC 在${x.who==='owner'?'你的 Base Account（不是上面这个地址）':'这个地址'}上</li>`).join('');
  return `<p style="font-size:22px">余额 Balance: <b>${b.toFixed(2)} USDC</b></p>`+(b>=0.2?`<p class=ok>✅ 已到账 ${b} USDC，可以签名了 / Arrived, you can sign</p>`:
    `<p>⏳ ${b>0?`已到账 ${b} USDC，还差 ${(0.2-b).toFixed(2)}，至少要 0.2`:'等待到账…'}（每 5 秒自动检查，最后检查 ${esc(t)}）<span class=en>Waiting for test USDC on Base Sepolia (auto-checks every 5 s)</span></p>
    ${wrong?`<div class=warn><b>链选错了 / 地址不对：</b><ul>${wrong}</ul>水龙头上要选 <b>Base Sepolia</b>，地址要填上面这个地址。请在 faucet.circle.com 重新领一次。</div>`:''}
    <div class=warn>领币时：网络选 <b>Base Sepolia</b>（不是 Ethereum Sepolia），地址粘贴上面那个地址。水龙头说“已发送”后通常 10–60 秒到账。签名授权按钮在到账 ≥0.2 后自动变亮，点签名时才会弹出确认（Face ID / 密码）。</div>`);}
function render(){if(!ST)return;const s=ST.setup,act=s?.active;let h='';
  if(DO&&s&&!DONE_DO){const ex=DO==='exit';h+=`<div class="step now"><h2>${ex?T('🚪 全部取回并撤销授权','Take everything back and revoke'):T('🔒 在链上撤销 AI 的付款授权','Revoke the AI spend permission on chain')}</h2>
    <p>${ex?T('一次签名：暂停 AI、撤销授权、取消未完成的预授权、把结算账户里的钱扫回，然后把全部 USDC 转到你自己的地址：','One signature: pause, revoke, cancel open reservations, sweep the vault, then send ALL USDC to your own address:'):T('一次签名：暂停 AI、撤销授权、把结算账户里的钱扫回你的钱包（钱留在你的钱包里）。','One signature: pause, revoke, sweep the vault back into your wallet (funds stay in your wallet).')}</p>
    <p class=mono>${esc(s.owner)}</p><p class=en>需要少量 gas（测试网 ETH，由你的 Base Account 支付或代付）。Needs a little gas.</p>
    <button class=red id=do>${ex?'用 Base Account 签名并全部取回':'用 Base Account 签名撤销'}<br><small>Sign with Base Account</small></button><button class=alt id=dontdo>先不做，返回 App / Not now</button></div>`;}
  h+=step(1,T('连接钱包','Connect your wallet'),OWNER?`<p class=ok>已连接 Connected</p><p class=mono>${esc(OWNER)}</p>`:`<button id=connect>用 Base Account 连接（Face ID）<br><small>Connect with Base Account</small></button>`,OWNER||s?'done':'now');
  h+=step(2,T('回答几个问题，然后签一次名','Answer a few questions, then sign once'),act?`<table>${Object.entries(s.human).map(([k,v])=>`<tr><td>${esc((Q[k]??[k])[0])}</td><td>${esc(v)}</td></tr>`).join('')}</table>`:
    PREP||s?`${depositBlock(PREP?.deposit??ST.deposit??{qrSvg:''},s?.wallet??PREP.wallet)}${fundStatus()}
      <button class=alt id=refresh>🔄 刷新 Refresh</button>
      <button id=sign ${Number(ST.balance??0)>=200000?'':'disabled'}>✍️ 签名授权（一次） Sign once</button>${ST.walletDeployed&&!act?'<p>已签名，等待生效（约 3 分钟）… Signed, starting in ~3 min…</p>':''}`:setupBody(),act?'done':OWNER?'now':'todo');
  h+=step(3,T('连接你的 AI','Connect your AI'),AGENT?`<a class=btn href="${esc(AGENT.cursor)}">一键加到 Cursor / Add to Cursor</a>
    <button data-copy="${esc(AGENT.claudeCode)}">复制一行给 Claude Code / Copy for Claude Code</button><button data-copy="${esc(AGENT.codex)}">复制一行给 Codex / Copy for Codex</button>
    <button class=alt data-copy="${esc(AGENT.url)}">复制 MCP 地址（其他 AI）/ Copy MCP URL</button><p class=en>这个地址里有这个 AI 专用的钥匙，别发给别人。它不能批准信任、不能改大上限。The link contains this AI's own key; it cannot approve trust or raise limits. Claude Desktop 需要公网 HTTPS 地址（暂未提供）/ needs a public HTTPS URL (not offered yet).</p>`
    :`<button id=agent>生成连接 Create connection</button>${ST.agents.length?`<p>已连接的 AI：${ST.agents.filter(a=>!a.revoked).map(a=>esc(a.name)).join('、')}</p>`:''}`,act?(ST.agents.length?'done':'now'):'todo');
  if(act){const L=ST.limits??{};const pend=ST.trust?.pending??[];const pc=ST.pending?.changes??[],pw=ST.pending?.withdrawals??[];
    h+=step(4,T('我的钱包','My wallet'),`<p style="font-size:28px;margin:4px 0"><b>${(Number(ST.balance)/1e6).toFixed(2)} USDC</b></p>${Number(ST.quarantined)>0?`<p>隔离中（AI 不能用）Held: ${(Number(ST.quarantined)/1e6).toFixed(2)}</p>`:''}
      ${(ST.trustRequests?.pending??[]).map(r=>`<div class=warn>🤖 AI 请求信任收款方 / An AI asks you to trust a payee<br>收款地址 Address (check every character): <span class=mono>${esc(r.payee)}</span><br>链 Chain: ${esc(r.chain)} · 每笔最多 ${(r.single/1e6)} / 每天最多 ${(r.total/1e6)} USDC · ${esc(r.expiresInDays)} 天 days
        <br><small>AI 自己写的名字和理由（未经核实）/ Name and reason written by the AI (unverified): ${esc(r.merchantName)} — ${esc(r.reason)} · ${esc(r.requestedBy.join(', '))}</small><br>
        <button data-treq=approve data-id="${r.id}">✅ 信任并签名 Trust &amp; sign</button><button class=alt data-treq=reject data-id="${r.id}">拒绝 Reject</button></div>`).join('')}
      ${pend.map(p=>`<div class=warn>🤖 AI 想信任 / AI asks to trust: <span class=mono>${esc(p.subject.id)}</span><br>理由 Reason: ${esc(p.reason)}<br>每笔 ${(p.single/1e6)} / 每天 ${(p.daily/1e6)} USDC
        <button data-trust=approve data-id="${p.id}">✅ 同意 Approve</button><button class=alt data-trust=reject data-id="${p.id}">不同意 Reject</button></div>`).join('')}
      ${pc.map(c=>`<div class=warn>放宽上限 Loosen limit: ${esc(JSON.stringify(c.changes))}<button data-lim="${c.id}">✅ 同意 Approve</button></div>`).join('')}
      ${pw.map(w=>`<div class=warn>AI 申请提现 ${(w.amount/1e6)} USDC → 你的钱包<button data-wd="${w.id}">✅ 同意并转出 Approve</button></div>`).join('')}
      <details><summary>充值 Deposit</summary><div id=dep></div></details>
      <h3>信任名单 Trusted</h3>${(ST.trust?.trusted??[]).filter(t=>t.active).map(t=>`<p class=mono>${esc(t.key)} · ${t.single/1e6}/${t.daily/1e6} <button class=alt data-untrust="${esc(t.key)}">取消 Remove</button></p>`).join('')||'<p>无 none</p>'}
      <h3>修改上限 Change limits</h3><p class=en>调低立即生效；调高要你再点一次同意；不能超过链上上限（每笔 ${(Number(ST.main?.single??0)/1e6)} / 每天 ${(Number(ST.main?.daily??0)/1e6)} USDC）。</p>
      ${['unrecognizedPerPayment','unrecognizedPerDay','depositDailyLimit'].map(k=>`<div class=lim><p>${Q[k][0]} 现在 now: <b>${Number(L[k]??0)/1e6}</b> USDC</p>${chips(k,LIM[k],'data-lk','data-lin','USDC',CH[k])}</div>`).join('')}
      ${ERR?`<p class=bad>${esc(ERR)}</p>`:''}<button id=savelim ${Object.keys(LIM).length?'':'disabled'}>保存上限 Save limits</button>
      <h3>最近付款 Recent payments</h3><table>${(ST.purchases??[]).slice(0,8).map(p=>`<tr><td>${esc(p.state)}</td><td>${(Number(p.amount??0)/1e6)}</td><td class=mono>${esc(String(p.payee??'').slice(0,12))}…</td></tr>`).join('')||'<tr><td>无 none</td></tr>'}</table>
      <h3>取回到我的钱包 Withdraw</h3>${chips('withdraw',WD,'data-wk','data-win','USDC',['1','2','5','10'])}<button class=alt id=wd ${WD?'':'disabled'}>取回 ${esc(WD||'…')} USDC / Withdraw</button><button class=alt id=pause>⏸ 暂停 AI 付款 24 小时 / Pause</button><button class=red id=exit>🚪 全部取回并停止 / Take everything back and stop</button>`,'now');}
  h+=`<p id=msg>${MSG}</p>`;app.innerHTML=h;wire();}
function wire(){const on=(s,f)=>document.querySelectorAll(s).forEach(e=>e.onclick=()=>run(()=>f(e)));
  on('#connect',connect);on('#do',async()=>{if(!OWNER){const p=await provider();const [a]=await p.request({method:'eth_requestAccounts'});OWNER=a;}if(OWNER.toLowerCase()!==s0().toLowerCase())throw Error('请用设置时那个 Base Account 签名（'+s0().slice(0,6)+'…'+s0().slice(-4)+'）');
    const x=DO==='exit'?await api('exitCalls',{}):await api('revokeCalls',{});await sendCalls(x.calls);DONE_DO=true;MSG=`<span class=ok>${DO==='exit'?'已全部取回 '+esc(x.returns)+' USDC ✓':'已在链上撤销授权 ✓'}</span>`;await refresh();back(DO==='exit'?'exit':'revoke');});
  on('#dontdo',()=>{DONE_DO=true;render();back('skip');});on('#refresh',async()=>{MSG='';await refresh();});on('[data-k]',e=>{ANS[e.dataset.k]=e.dataset.v;ERR='';render();});document.querySelectorAll('[data-in]').forEach(e=>e.oninput=()=>{ANS[e.dataset.in]=e.value;ERR='';document.querySelectorAll(`[data-k="${e.dataset.in}"]`).forEach(b=>b.classList.remove('sel'));const b=$('#next');if(b)b.disabled=!e.value.trim();});
  on('[data-lk]',e=>{LIM[e.dataset.lk]=e.dataset.v;ERR='';render();});document.querySelectorAll('[data-lin]').forEach(e=>e.oninput=()=>{if(e.value.trim())LIM[e.dataset.lin]=e.value;else delete LIM[e.dataset.lin];const b=$('#savelim');if(b)b.disabled=!Object.keys(LIM).length;});
  on('[data-wk]',e=>{WD=e.dataset.v;render();});document.querySelectorAll('[data-win]').forEach(e=>e.oninput=()=>{WD=e.value;const b=$('#wd');if(b)b.disabled=!e.value.trim();});
  on('#next',()=>{const r=stepCheck();if(!r.ok){ERR=r.errors.map(e=>e.zh).join('；');return render();}ERR='';STEP++;render();});on('#back',()=>{ERR='';STEP=Math.max(0,STEP-1);render();});
  const ck=()=>{const b=$('#prep');if(b)b.disabled=b.dataset.bad==='1'||!($('#ack').checked&&$('#consent').checked);};if($('#ack')){$('#ack').onchange=ck;$('#consent').onchange=ck;}
  on('#prep',async()=>{PREP=await api('prepare',{owner:OWNER,answers:{...ANS,termDays:Number(ANS.termDays),withdrawalAddress:OWNER,riskNoticeAcknowledged:true,technicalConsent:true}});await refresh();back('prepared');});
  on('#sign',async()=>{if(!OWNER){const p=await provider();const [a]=await p.request({method:'eth_requestAccounts'});OWNER=a;}if(s0()&&OWNER.toLowerCase()!==s0().toLowerCase())throw Error('请用设置时那个 Base Account 签名（'+s0().slice(0,6)+'…'+s0().slice(-4)+'）');const calls=PREP?.calls??ST.setup.calls;if(!calls)throw Error('请刷新 reload');await sendCalls(calls);MSG='<span class=ok>已签名 Signed ✓</span>';await refresh();back('signed');});
  on('#agent',async()=>{AGENT=await api('newAgent',{name:'My AI'});render();});
  on('[data-copy]',async e=>{await navigator.clipboard.writeText(e.dataset.copy);MSG='<span class=ok>已复制 Copied ✓</span>';render();});
  on('[data-treq]',async e=>{const id=e.dataset.id;if(e.dataset.treq==='reject'){await api('trustRequestReject',{id});return refresh();}
    if(!OWNER){const p=await provider();const [a]=await p.request({method:'eth_requestAccounts'});OWNER=a;}if(ST.setup?.owner&&OWNER.toLowerCase()!==ST.setup.owner.toLowerCase())throw Error('请用设置时那个 Base Account 签名');
    const r=await api('trustRequestApprove',{id});const p=await provider();const sig=await p.request({method:'eth_signTypedData_v4',params:[OWNER,JSON.stringify(r.typedData,(k,v)=>typeof v==='bigint'?v.toString():v)]});
    await api('trustRequestSign',{id,signature:sig});await refresh();});
  on('[data-trust]',async e=>{await api('trust',{action:e.dataset.trust,id:e.dataset.id});await refresh();});on('[data-untrust]',async e=>{await api('trust',{action:'revoke',key:e.dataset.untrust});await refresh();});
  on('[data-lim]',async e=>{await api('limits',{approveId:e.dataset.lim});await refresh();});on('[data-wd]',async e=>{const r=await api('withdraw',{approveId:e.dataset.wd});MSG=esc(r.state);await refresh();});
  on('#savelim',async()=>{const r=checkLimitChangeZh(LIM,{current:ST.limits,main:ST.main});if(!r.ok){ERR=r.errors.map(e=>e.zh).join('；');return render();}
    if(r.warnings.length&&!confirm(r.warnings.join('\n')))return;const x=await api('limits',{changes:LIM});LIM={};ERR='';MSG=x.pendingOwnerApproval?'<span class=ok>调高需要你在上面点“同意” / tap Approve above</span>':'<span class=ok>已保存 Saved ✓</span>';await refresh();});
  on('#wd',async()=>{const r0=checkLimitChangeZh({depositDailyLimit:WD});if(!r0.ok){MSG='<span class=bad>取回金额：'+esc(r0.errors[0].zh.split('：')[1])+'</span>';return render();}const r=await api('withdraw',{amount:WD});WD='';MSG=r.state==='paid'?'<span class=ok>已转到你的钱包 Sent ✓</span>':esc(r.reason??r.state);await refresh();});
  on('#pause',async()=>{await api('pause',{});MSG='<span class=ok>已暂停 Paused ✓</span>';await refresh();});
  on('#exit',async()=>{if(!confirm('确定全部取回？Take everything back?'))return;const x=await api('exitCalls',{});await sendCalls(x.calls);MSG=`<span class=ok>已取回 ${esc(x.returns)} USDC ✓</span>`;await refresh();back('exit');});
  const dep=$('#dep');if(dep&&ST.setup)dep.innerHTML=depositBlock(ST.deposit??{qrSvg:''},ST.setup.wallet);}
async function run(f){try{MSG='…';await f();}catch(e){MSG='<span class=bad>'+esc(e.message)+'</span>';render();}}
const s0=()=>ST?.setup?.owner;
async function refresh(){ST=await api('state');const a=document.activeElement;if(a&&a.tagName==='INPUT'&&a.type==='text')return;render();}
(async()=>{try{CSRF=(await (await fetch('/api/csrf')).json()).csrf;if(!CSRF)throw 0;await refresh();setInterval(()=>{if(!document.hidden)refresh().catch(()=>{});},5000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh().catch(()=>{});});}catch{app.innerHTML='<div class=step><h2>请用启动时打开的链接进入 / Please open the link from the start step.</h2></div>';}})();
