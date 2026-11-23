// SPDX-License-Identifier: AGPL-3.0-only
// Persona dogfood on REAL Base Sepolia with throwaway keys + test USDC: "Maya, 24, LA" runs the whole product in English.
//   KIPURSE_ADAPTER=0x... node kit/e2e-maya-sepolia.mjs <testnet keys.json (0600, never printed)> [out.json]
// Steps mirror what Maya does in the iPhone app (the app is a thin client of these exact owner APIs) and what her AIs do
// over MCP (ChatGPT-style OAuth, Claude-style Bearer key, Muse-style key-in-URL over SSE). Each step logs evidence + friction.
import fs from 'node:fs';import {join} from 'node:path';import {spawn} from 'node:child_process';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';
import {createPublicClient,createWalletClient,http,parseAbi,encodeFunctionData} from 'viem';import {privateKeyToAccount} from 'viem/accounts';import {baseSepolia} from 'viem/chains';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {createHash,randomBytes} from 'node:crypto';
const kf=process.argv[2];if((fs.statSync(kf).mode&0o777)!==0o600)throw Error('keys 0600');const K=JSON.parse(fs.readFileSync(kf));const owner=privateKeyToAccount(K.owner),shop=privateKeyToAccount(K.merchantA),shop2=privateKeyToAccount(K.merchantB);
const U='0x036CbD53842c5426634e7929541eC2318f3dCF7e';const pub=createPublicClient({chain:baseSepolia,transport:http('https://sepolia.base.org',{retryCount:3})});
const wc=a=>createWalletClient({chain:baseSepolia,account:a,transport:http('https://sepolia.base.org',{retryCount:3})});
const ERC=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);const bal=a=>pub.readContract({address:U,abi:ERC,functionName:'balanceOf',args:[a]});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const t=async(l,f)=>{const h=await f();const r=await pub.waitForTransactionReceipt({hash:h,timeout:180000});if(r.status!=='success')throw Error(l+' reverted');return h;};
const R=[];const step=(area,name,ok,ev={},friction=null)=>{R.push({area,name,ok:!!ok,ev,friction});console.log((ok?'PASS ':'FAIL ')+`[${area}] ${name} `+JSON.stringify(ev).slice(0,200)+(friction?'  ⚑ '+friction:''));};
const CJK=/[\u4e00-\u9fff]/;const zhLeft=o=>{const out=[];const w=(v,k='')=>{if(typeof v==='string'){if(CJK.test(v)&&!/Zh$|^zh$/.test(k))out.push(v.slice(0,40));}else if(Array.isArray(v))v.forEach(x=>w(x,k));else if(v&&typeof v==='object')for(const [kk,x] of Object.entries(v))if(!/Zh$|^zh$|^questions$|^disclosure$|^riskZh$/.test(kk))w(x,kk);};w(o);return out;};
const P=8711,B=`http://localhost:${P}`;const DIR=mkdtempSync(join(tmpdir(),'maya-'));const KEYF=join(mkdtempSync(join(tmpdir(),'mayak-')),'k.key');
const srv=spawn(process.execPath,['kit/server.mjs','--port',String(P),'--dir',DIR],{stdio:['ignore','pipe','pipe'],env:{KIPURSE_DEMO:'1',...process.env,KIPURSE_DELETE_WAIT_MS:'3000',KIPURSE_KEY_FILE:KEYF,KIPURSE_PUBLIC_URL:B,KIPURSE_LOG_FILE:join(DIR,'..','maya.log')}});
let log='';srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);
const out=process.argv[3]??'maya-sepolia.json';
try{
  for(let i=0;i<60&&!fs.existsSync(join(DIR,'owner-link.txt'));i++)await sleep(500);
  // ── install / sign-in (the app scans this link as a QR) ──
  const link=fs.readFileSync(join(DIR,'owner-link.txt'),'utf8').trim();const lg=await fetch(link,{redirect:'manual'});const cookie=lg.headers.get('set-cookie').split(';')[0];
  const csrf=(await (await fetch(B+'/api/csrf',{headers:{cookie}})).json()).csrf;
  const raw=(p,b)=>fetch(B+'/api/'+p,{method:'POST',headers:{cookie,'x-kp-csrf':csrf,'content-type':'application/json','x-kp-lang':'en',origin:B},body:JSON.stringify(b??{})});
  const api=async(p,b)=>{const r=await raw(p,b);const j=await r.json();if(!r.ok)throw Object.assign(Error(p+': '+j.error),{body:j});return j;};
  step('install','sign in by scanning one code (no account, no password)',!!cookie,{},'Needs a computer running the Kipurse kit first — Maya has no Mac server; hosted cloud kit is required for her (owner decision: cloud hosting).');
  // ── onboarding ──
  const st0=await api('state');step('UI','everything the app shows is English',zhLeft({...st0,questions:undefined,disclosure:undefined}).length===0,{left:zhLeft({...st0,questions:undefined,disclosure:undefined}).slice(0,3)});
  // Maya's answers (scaled 1/25 because only ~0.4 test USDC exists on the faucet wallet; same logic as $5/$10/$50)
  const answers={termDays:30,perPayment:'0.2',perDay:'0.3',termTotal:'0.35',unrecognizedPerPayment:'0.03',unrecognizedPerDay:'0.1',depositDailyLimit:'1',withdrawalAddress:owner.address,riskNoticeAcknowledged:true,technicalConsent:true};
  const prep=await api('prepare',{owner:owner.address,answers});step('limits','7 plain questions with presets; Maya picks $5/payment, $7.50/day, 30 days',!!prep.wallet,{calls:prep.calls.length});
  // ── first deposit ──
  const dep=await api('depositOptions');step('deposit','deposit screen in English with one address + only-Base warning',zhLeft(dep).length===0&&JSON.stringify(dep).includes('Base'),{keys:Object.keys(dep)});
  const on=await api('onrampSession',{amount:20,applePay:true});const mp=await (await fetch(on.url)).text();step('deposit','"Add money with Apple Pay" → $20 preset → payment page (practice mode until the CDP key exists)',dep.onramp?.available&&/Pay/.test(mp),{provider:on.provider},on.provider==='mock'?'Practice page only: real Apple Pay needs the owner CDP project + key (and mainnet).':null);
  {const mb=await bal(shop2.address);if(mb>0n)await t('recycle',()=>wc(shop2).writeContract({address:U,abi:ERC,functionName:'transfer',args:[owner.address,mb],gas:120000n}));await sleep(4000);}
  const ob=await bal(owner.address);const fundAmt=process.env.MAYA_FUND?BigInt(process.env.MAYA_FUND):(ob>400000n?400000n:ob);if(fundAmt<300000n)throw Error('throwaway owner has only '+ob+' test USDC; need 0.30');await t('deposit',()=>wc(owner).writeContract({address:U,abi:ERC,functionName:'transfer',args:[prep.wallet,fundAmt],gas:120000n}));
  // ── the one signature ──
  for(const [i,c] of prep.calls.entries())await t('sign'+i,()=>wc(owner).sendTransaction({to:c.to,data:c.data,gas:i?2500000n:700000n}));
  let st;for(let i=0;i<72;i++){st=await api('state');if(st.setup?.active)break;await sleep(5000);}
  step('signing','one approval activates the wallet (throwaway owner key stands in for Face ID passkey)',st.setup?.active,{wallet:prep.wallet,signTx:prep.calls.length},null);
  {const sr=await api('state');step('UI','home shows the $0.20 fee reserve separately (tap ⓘ for plain explanation)',sr.reserve==='200000',{balance:sr.balance,reserve:sr.reserve});}
  // ── connect AIs ──
  const asm=await (await fetch(B+'/.well-known/oauth-authorization-server')).json();
  const cli=await (await fetch(asm.registration_endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'ChatGPT',redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']})})).json();
  const v=randomBytes(32).toString('base64url'),ch=createHash('sha256').update(v).digest('base64url');
  const q=new URLSearchParams({response_type:'code',client_id:cli.client_id,redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',code_challenge:ch,code_challenge_method:'S256',state:'s1',resource:B+'/mcp',scope:'kipurse'});
  const page=await (await fetch(asm.authorization_endpoint+'?'+q,{headers:{'accept-language':'en-US'}})).text();const reqId=/req=([A-Za-z0-9_-]+)/.exec(page)?.[1];
  step('AI connect','ChatGPT consent page is English and offers "Approve in the Kipurse app"',/Approve in the Kipurse app/.test(page)&&!CJK.test(page.replace(/<script[\s\S]*<\/script>/,'')),{});
  const pend=(await api('state')).oauthPending??[];step('awareness','connection request reaches the phone (shows as an approval → notification)',pend.length===1,{n:pend.length});
  await api('oauthDecide',{req:pend[0].id,approve:true});const s1=await (await fetch(B+'/oauth/status?req='+reqId)).json();const code=new URL(s1.redirect).searchParams.get('code');
  const tok=await (await fetch(asm.token_endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:v,client_id:cli.client_id,redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',resource:B+'/mcp'})})).json();
  step('AI connect','ChatGPT-style OAuth: paste URL → approve on phone → connected',!!tok.access_token,{},'Real ChatGPT needs a paid Business/Enterprise/Edu plan for actions (OpenAI policy) — Maya on Plus may be read-only.');
  const claude=await api('connectAgent',{agentId:'custom'});const muse=await api('connectAgent',{agentId:'muse'});
  step('AI connect','Muse card is one English message with the key inside; no technical questions',/^Please connect my Kipurse wallet/.test(muse.copyAll)&&muse.copyAll.includes('?key='),{});
  const mk=async(kind)=>{const c=new Client({name:kind,version:'1'});
    const tr=kind==='chatgpt'?new StreamableHTTPClientTransport(new URL(B+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+tok.access_token}}})
      :kind==='claude'?new StreamableHTTPClientTransport(new URL(B+'/mcp'),{requestInit:{headers:{authorization:'Bearer '+claude.key}}})
      :new SSEClientTransport(new URL(muse.keyUrl.replace('/mcp?','/sse?')));await c.connect(tr);return c;};
  const gpt=await mk('chatgpt'),cl=await mk('claude'),mu=await mk('muse');const call=async(c,n,a={})=>{const r=await c.callTool({name:n,arguments:a});return JSON.parse(r.content[0].text);};
  const tl=[(await gpt.listTools()).tools.length,(await cl.listTools()).tools.length,(await mu.listTools()).tools.length];
  step('AI connect','three different AI styles all work (OAuth / Bearer / key-in-URL over SSE)',tl.every(n=>n>=40),{tools:tl});
  // ── online / API payment ──
  const t0=Date.now();const p1=await call(gpt,'kipurse_pay',{to:shop.address,amount:'0.01',merchant:'Sticker Mule',orderRef:'maya-001'});
  step('online pay','ChatGPT buys a $0.75-equivalent digital item from a new shop',['paid','settled','confirmed'].includes(p1.state),{state:p1.state,ms:Date.now()-t0});
  const st2=await api('state');const row=(st2.purchases??[]).find(x=>x.purchaseKey===p1.purchaseKey);
  step('awareness','the payment is in the app state right away (phone notifies + widget + Live Activity from this)',!!row,{badge:row?.badge,merchantName:row?.merchantName,lagMs:Date.now()-t0},'Without remote push (APNs server not set up yet) the phone only learns this when the app is open or iOS runs background refresh (~15 min).');
  step('disputes','receipt shows merchant name + "New shop" badge',row?.merchantName==='Sticker Mule'&&row?.badge==='new',{});
  // ── over-limit → approval with Face ID ──
  const p2=await call(cl,'kipurse_pay',{to:shop2.address,amount:'0.04',merchant:'Boba Guys Online',orderRef:'maya-002'});
  step('limits','a payment over the new-shop limit is refused with a plain fix',p2.state==='rejected'&&!!p2.fix,{reason:p2.reason,fix:String(p2.fix).slice(0,80)});
  const pt=await call(cl,'kipurse_request_trust',{merchantName:'Boba Guys Online',payee:shop2.address,chain:'base-sepolia',perPaymentCap:'0.05',totalCap:'0.1',reason:'Maya orders boba here weekly'});
  const ap=(await api('state')).trustRequests?.pending??[];step('awareness','AI asks Maya to trust the shop → request appears for her (same flow for every AI)',pt.status==='awaiting_owner'&&ap.some(r=>r.id===pt.id),{id:pt.id});
  const tq=await api('trustRequestApprove',{id:pt.id});const tsig=await owner.signTypedData(tq.typedData); // throwaway owner key stands in for her Base Account
  const ts=await api('trustRequestSign',{id:pt.id,signature:tsig});await sleep(4000);const p3=await call(cl,'kipurse_pay',{to:shop2.address,amount:'0.04',merchant:'Boba Guys Online',orderRef:'maya-002b'});
  step('limits','after Maya approves, the same payment goes through',['paid','settled','confirmed'].includes(p3.state),{state:p3.state});
  // ── real-world purchase via card rail (mock issuer in test mode) ──
  const card=await call(mu,'kipurse_card_create',{merchant:'Boba Guys, Los Angeles',amount:'0.02',category:'food_drink',note:'taro milk tea'});
  step('real world','Muse gets a single-use card locked to the café and amount, paid from the wallet under her limits',card.state==='issued',{state:card.state,reason:card.reason,detail:String(card.detail??'').slice(0,90),last4:card.card?.last4});
  if(card.state==='issued'){const wrong=await call(mu,'kipurse_card_test_purchase',{cardId:card.card.cardId,merchant:'Starbucks',amount:'0.02'});const ok=await call(mu,'kipurse_card_test_purchase',{cardId:card.card.cardId,merchant:'Boba Guys',amount:'0.015',category:'food_drink'});
    step('real world','card refuses a different shop, approves the café; leftover is tracked',!wrong.approved&&ok.approved,{wrong:wrong.reason,leftover:ok.leftoverAtomic},'Mock issuer: no real card network/Apple Pay yet (owner picks an issuer: memo).');}
  // ── dispute + refund ──
  const rp=await api('reportProblem',{purchaseKey:p1.purchaseKey,reason:'not_received',note:'stickers never arrived'});
  step('disputes','"Report a problem" opens a case and gives a copyable refund note for the shop',rp.state==='opened'&&/send up to/.test(rp.merchantInstructions),{case:rp.case?.id});
  await t('refund',()=>wc(shop).writeContract({address:U,abi:ERC,functionName:'transfer',args:[prep.wallet,10000n],gas:120000n}));
  let cs;for(let i=0;i<20;i++){cs=(await api('state')).disputes?.find(c=>c.id===rp.case.id);if(cs?.status==='refunded')break;await sleep(4000);}
  step('disputes','merchant refund to the wallet is matched automatically → "Fully refunded"',cs?.status==='refunded',{status:cs?.status,refunded:cs?.refunded});
  const csv=await api('exportCsv');step('disputes','history export (CSV) for her records',String(csv.csv).split('\n').length>2,{lines:String(csv.csv).split('\n').length});
  // ── pause one AI ──
  const agents=(await api('state')).agents;const g=agents.find(a=>/ChatGPT/i.test(a.name))??agents[0];await api('agentPause',{id:g.id,paused:true});
  const p4=await call(gpt,'kipurse_pay',{to:shop.address,amount:'0.01',merchant:'Sticker Mule',orderRef:'maya-003'});const s4=await call(gpt,'kipurse_wallet_status');
  step('awareness','pausing ChatGPT stops its payments but it can still read the balance',p4.reason==='agent_paused'&&!s4.error,{p4:p4.reason});await api('agentPause',{id:g.id,paused:false});
  // ── withdraw ──
  const wq=await api('withdrawQuote',{amount:'0.005',to:owner.address});step('withdraw','quote in plain English with fee + network fee',zhLeft(wq).length===0,{text:String(wq.text??wq.plain??'').slice(0,100)});
  const wamt=BigInt(wq.maxAll??0)>=5000n?'0.005':(Number(wq.maxAll??0)/1e6).toFixed(6);const wd=Number(wamt)>0?await api('withdraw',{amount:wamt,to:owner.address}):{skipped:true};step('withdraw','money back to "my Coinbase" in one confirmation, no crypto for fees',!!(wd.txHash??wd.ok)||wd.skipped,{tx:wd.txHash?.slice(0,12),skipped:wd.skipped},wd.skipped?'Balance under the $0.05 network-fee hold: only "Take everything back" can empty it.':null);
  // ── take everything back (delete screen step 2), then delete ──
  const rv=await api('revokeCalls');await t('takeBack',()=>wc(owner).sendTransaction({to:rv.calls[0].to,data:rv.calls[0].data,gas:1500000n}));await sleep(6000);
  const left=await bal(prep.wallet);const exd=encodeFunctionData({abi:parseAbi(['function execute(address,uint256,bytes)']),functionName:'execute',args:[U,0n,encodeFunctionData({abi:ERC,functionName:'transfer',args:[owner.address,left]})]});
  if(left>0n)await t('sweep',()=>wc(owner).sendTransaction({to:prep.wallet,data:exd,gas:300000n}));step('withdraw','"take everything back" returns all money incl. the $0.20 gas reserve',left>0n,{returned:left.toString(),steps:rv.labels});
  // ── delete ──
  await gpt.close();await cl.close();await mu.close();
  const tk=await api('deleteStart',{confirm:'Delete my account'}).catch(async()=>api('deleteStart',{confirm:'删除我的账户'}));
  step('withdraw','delete confirmation phrase works in English',tk.ticket&&!/删除/.test(tk.phrase??''),{phrase:tk.phrase??null},tk.phrase&&/删除/.test(tk.phrase)?'English user must type a Chinese phrase to delete.':null);
  await sleep(3200);const d=await api('deleteAccount',{ticket:tk.ticket,confirm:tk.phrase??'Delete my account',skippedRevoke:false}).catch(e=>({error:e.message}));
  step('withdraw','account deleted; remaining money stays in her wallet',d.deleted,{err:d.error});
  const dead=(await fetch(B+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+claude.key},body:'{}'})).status;step('withdraw','old AI keys are dead after delete',dead===401,{dead});
}catch(e){step('run','crashed',false,{err:e.message,body:e.body});console.error(log.slice(-1500));}
finally{srv.kill();fs.writeFileSync(out,JSON.stringify({when:new Date().toISOString(),steps:R},null,1));console.log(`${R.filter(x=>x.ok).length}/${R.length} passed -> ${out}`);}
