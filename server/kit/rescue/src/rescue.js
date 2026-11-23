// SPDX-License-Identifier: Apache-2.0
// Static, open-source "Get my money back" page. No Kipurse server: the user signs in with the same Base Account and taps once.
import {createBaseAccountSDK} from '@base-org/account';
import {createPublicClient,http,getAddress} from 'viem';
import {CHAINS,ABI,parseCard,checkTo,buildRescue,gasRoute,fmt} from './plan.mjs';
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let card=parseCard(location.hash.slice(1)),cfg={},owner=null,info=null,provider=null,msg='',busy=false,done=null,toMode='me';
const chainId=()=>Number(card?.chainId??8453),C=()=>CHAINS[chainId()];
const pub=()=>createPublicClient({transport:http(C().rpc,{retryCount:2})});
const rd=(address,functionName,args=[])=>pub().readContract({address,abi:ABI,functionName,args});
async function load(){const W=card.wallet,u=card.usdc??C().usdc;const [w,v]=await Promise.all([rd(u,'balanceOf',[W]),card.vault?rd(card.vault,'balanceOf',[W]).then(()=>rd(u,'balanceOf',[card.vault])).catch(()=>0n):0n]);
  let fl=0n,flOpen=false;if(card.adapter){try{const fa=await rd(card.adapter,'floatAddress',[W]);fl=await rd(u,'balanceOf',[fa]);flOpen=fl>0n;}catch{}}
  info={wallet:w,vault:v,float:fl,floatOpen:flOpen,total:w+v+(flOpen?fl:0n)};}
async function signIn(){busy=true;msg='';draw();try{const sdk=createBaseAccountSDK({appName:'取回我的钱 · Kipurse',appChainIds:[chainId()]});provider=sdk.getProvider();
    const a=await provider.request({method:'eth_requestAccounts'});owner=getAddress(a[0]);
    const isOwner=await rd(card.wallet,'isOwnerAddress',[owner]).catch(()=>null);
    if(isOwner===false){msg='这个账户不是这个钱包的主人。请用当初设置 Kipurse 时的那个 Base / Coinbase 账户登录。';owner=null;}else await load();}
  catch(e){msg='没有登录成功：'+(e.message??e);}busy=false;draw();}
async function go(){const to=toMode==='me'?owner:$('#to').value;const ck=checkTo(to,card);if(!ck.ok){msg=ck.zh;return draw();}
  busy=true;msg='';draw();const route=gasRoute(cfg,chainId());
  try{const plan=buildRescue({card,owner,to:ck.to,balances:info,floatOpen:info.floatOpen,gas:route,chainId:chainId()});if(!plan.calls.length){msg='钱包里没有钱可以取。';busy=false;return draw();}
    const caps=route.url?{paymasterService:{url:route.url}}:undefined;
    const r=await provider.request({method:'wallet_sendCalls',params:[{version:'2.0.0',chainId:C().hex,from:owner,atomicRequired:true,calls:plan.calls,...(caps?{capabilities:caps}:{})}]});
    const id=r?.id??r;let st;for(let i=0;i<90;i++){st=await provider.request({method:'wallet_getCallsStatus',params:[id]}).catch(()=>null);if(st&&(st.status===200||st.status==='CONFIRMED'||st.status>=400))break;await new Promise(z=>setTimeout(z,2000));}
    const tx=st?.receipts?.[0]?.transactionHash;if(st&&(st.status===200||st.status==='CONFIRMED'))done={amount:plan.receive,to:plan.dest,tx};else msg='还没确认，请稍后刷新这页看余额。'+(tx?' 交易：'+tx:'');
    await load();}
  catch(e){const m=String(e.message??e);msg=/insufficient|funds|gas/i.test(m)&&route.mode==='self'?'你的账户需要一点点 ETH 付网络费（不到 0.01 美元）。在 Coinbase App 里给这个账户发 0.0001 ETH（Base 网络）就够了，然后再按一次。':'没有完成：'+m;}
  busy=false;draw();}
function draw(){const app=$('#app');const rt=gasRoute(cfg,chainId());
  if(!card){app.innerHTML=`<h1>取回我的钱</h1><p class=sub>Get my money back</p><div class=card><p>请打开 Kipurse App 或邮件里的「取回我的钱」链接。没有链接？粘贴你的 Kipurse 钱包地址：</p>
    <input id=card placeholder="0x…"><button id=use class=big>继续</button></div>${msg?`<p class=err>${esc(msg)}</p>`:''}`;
    $('#use').onclick=()=>{card=parseCard($('#card').value);if(!card)msg='地址不对，请复制粘贴';draw();};return;}
  const net=`<span class=chip>${esc(C().name)}</span>`;
  if(done){app.innerHTML=`<h1>✅ 已取回</h1><div class=card><p class=money>${fmt(done.amount)} <small>USDC</small></p><p>已转到 ${esc(done.to)}</p>${done.tx?`<a href="${C().explorer}/tx/${done.tx}" target=_blank rel=noopener>查看交易</a>`:''}<p class=sub>AI 已经不能再用这个钱包付款。</p></div>`;return;}
  app.innerHTML=`<h1>取回我的钱 ${net}</h1><p class=sub>Get my money back · 不需要 Kipurse 服务器</p>
  ${!owner?`<div class=card><p>用你设置 Kipurse 时的 <b>Base / Coinbase 账户</b> 登录，然后按一下就把钱全部取回。</p><button id=signin class=big ${busy?'disabled':''}>${busy?'请在弹窗里确认…':'用 Base 账户登录'}</button></div>`
  :`<div class=card><p class=sub>钱包里一共</p><p class=money>${info?fmt(info.total):'…'} <small>USDC</small></p>
    <p>取到哪里？</p><label><input type=radio name=to value=me ${toMode==='me'?'checked':''}> 我登录的这个 Base 账户（推荐，Base / Coinbase App 里直接能看到）</label>
    ${rt.mode==='erc20'?'':`<label><input type=radio name=to value=other ${toMode==='other'?'checked':''}> 别的地址（比如 Coinbase 的 USDC 收款地址，网络选 Base）</label>${toMode==='other'?'<input id=to placeholder="0x…">':''}`}
    <p class=sub>${rt.mode==='self'?'网络费不到 0.01 美元，由你的账户付（需要一点点 ETH）。':rt.mode==='erc20'?'网络费从取回的 USDC 里扣，不需要 ETH。':'网络费由 Kipurse 代付，你不需要 ETH。'} 不收 Kipurse 手续费。</p>
    <button id=go class=big ${busy||!info||info.total===0n?'disabled':''}>${busy?'请在弹窗里确认…':'全部取回'}</button></div>`}
  ${msg?`<p class=err>${esc(msg)}</p>`:''}
  <details><summary>高级（技术人员用）</summary><p>钱包 ${esc(card.wallet)}</p><p>这一按会在一个交易里：停止 AI 付款授权 → 收回预付和结算账户 → 把全部 USDC 转给你。也可以用开源退出工具 exit-kit.html 或在 ${C().explorer}/address/${esc(card.wallet)} 手动操作。</p></details>`;
  $('#signin')&&($('#signin').onclick=signIn);$('#go')&&($('#go').onclick=go);
  document.querySelectorAll('input[name=to]').forEach(r=>r.onchange=()=>{toMode=r.value;draw();});}
fetch('rescue-config.json').then(r=>r.ok?r.json():{}).catch(()=>({})).then(j=>{cfg=j;draw();});draw();
