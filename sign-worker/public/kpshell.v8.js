/* Kipurse signing shell (t629 A1, v2 t735, v3 t784, v4 t791 language guard, v5 t887b wallet wording, v7 t1040 dark glass). Served ONLY from an immutable Cloudflare Pages deployment whose index.html hash is pinned in
   the Kipurse app; this file and every bundle are loaded with Subresource Integrity, so a compromised Kipurse server cannot swap the
   code that checks the batch. The server only supplies data (the page text and the calls); the KPVH guard inside each bundle refuses
   any batch whose SHA-256 differs from the commitment the APP put in the URL fragment. Anything unexpected -> stop, nothing sent. */
(()=>{'use strict';
const API='https://pay.kipurse.com';
const SRI={"onboard.js":"sha384-xadSV/9pddXd7NAbrsY9asaIiChec0cDb4ILGiBELM5rydla6320+AylWgoWEgiP","onboard-new.js":"sha384-euWg9WsIaMh4JeWF6i9qvhsbcRAsHrbiQeMPku/64mn1ykt5+Wyldt4zoT3Sg1e/","deposit.v6.js":"sha384-qtl1F4dz86F2dZqlWLCNM5bep8ratvglhayRkYN0D2IYtJ9fPZnZwAraPJ23BUCe","limits.v2.js":"sha384-x/qozDB4QmdS1MuHTzAnSWvgHJP1BIUN6/62U2vlkpocepC4r0jDB5cFR7thb6oA","withdraw.v3.js":"sha384-qB5b2glZe+AkuHcgY6paKljmQV0oba5QyTvhwLCuEVbgc3oSypNzreyLnzOwRphu","emergency.js":"sha384-B4FzL8nSqqE3w4o6NeDYXvXeIuty10Fvn5UmBDLS0YCEGfEvXAajdBBnnLUnZIq3","approve-trust.js":"sha384-GSrLMvTFuOSFoHgBVIqklopOZxWYgo4RELNyZOVbbaIDev8+qPJtUV73PSUP7J50","phone-enroll.v2.js":"sha384-6rB2syFKZwUUvcpgjaVhmAVUm843H6AUm7PlkzRySrbd/fmfxPE8kpgFAFFp6xm3","limits-done.js":"sha384-WDuedbrkp5DowST1SCxFAtjhZhCMkzrIK5vnYNDRATWli6pj4eBnjbNjN0VjJfXg","deposit-ui.v7.js":"sha384-63IHsDM3JSnu6kqAvYOWhh/mxPqpFPxAIDZX6cgfoSe6yV/q4+7uy+81T6VowN68"};
const MAP={'/onboard.js':'onboard.js','/onboard/new.js':'onboard-new.js','/deposit.js':'deposit.v6.js','/owner/limits.js':'limits.v2.js','/owner/limits-done.js':'limits-done.js',
  '/owner/withdraw.js':'withdraw.v3.js','/owner/emergency.js':'emergency.js','/approve/trust.js':'approve-trust.js','/phone/enroll.js':'phone-enroll.v2.js'};
const INLINE={'/deposit':'deposit-ui.v7.js'};
const H=new URLSearchParams(location.hash.replace(/^#/,''));const root=document.getElementById('kp-root');
const zh=/^zh/i.test(new URLSearchParams(String(H.get('u')||'').split('?')[1]||'').get('lang')||navigator.language||'');
let dead=false;const stop=(why)=>{dead=true;window.KP_STOPPED=why;document.documentElement.lang=zh?'zh':'en';document.documentElement.style.colorScheme='dark';for(const n of [...document.body.childNodes])if(n.tagName!=='SCRIPT'||n.type==='application/json')n.remove();const d=document.createElement('div');d.className='kp-stop';
  d.textContent=zh?'为了安全，这一步先停下了，没有转出任何钱，也没有扣费。请回到启付 App 再试一次。（'+why+'）':'Paused for safety. Nothing was sent or charged. Go back to the Kipurse app and try again. ('+why+')';document.body.appendChild(d);};
// 1. the page path must be a Kipurse server path (no other host, no scheme tricks)
const u=String(H.get('u')||'');if(!/^\/[A-Za-z0-9/_\-.]*(\?[A-Za-z0-9_\-.=&%~]*)?$/.test(u)||u.startsWith('//'))return stop('bad_path');
const path=u.split('?')[0].replace(/^\/t\/0x[0-9a-fA-F]{40}/,'');
// 2. relative API calls made by the bundles go to the Kipurse server, never to this static host
const of=window.fetch.bind(window),own=new Set(['/','/index.html',...Object.values(MAP).map(x=>'/'+x)]);
const rw=s=>{if(typeof s!=='string')return s;if(s.startsWith(location.origin+'/'))s=s.slice(location.origin.length);if(s.startsWith('/')&&!s.startsWith('//')&&!own.has(s.split('?')[0]))return API+s;if(s&&!s.startsWith('/')&&!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s))return new URL(s,API+u).href;return s;};
window.fetch=(i,o)=>{if(typeof i==='string')return of(rw(i),o);if(i instanceof URL)return of(rw(i.href),o);if(i&&i.url){const n=rw(i.url);return of(n===i.url?i:new Request(n,i),o);}return of(i,o);};
const load=f=>new Promise((ok,ko)=>{const h=SRI[f];if(!h)return ko(Error('unknown_script'));const s=document.createElement('script');s.src='/'+f;s.integrity=h;s.crossOrigin='anonymous';s.onload=ok;s.onerror=()=>ko(Error('integrity'));document.body.appendChild(s);});
const clean=n=>{for(const e of [...n.querySelectorAll('script,iframe,object,embed,link,meta,base,form')])e.remove();
  for(const e of n.querySelectorAll('*'))for(const a of [...e.attributes]){const k=a.name.toLowerCase();if(k.startsWith('on')||((k==='href'||k==='src'||k==='action'||k==='formaction')&&/^\s*(javascript|data):/i.test(a.value)))e.removeAttribute(a.name);}};

// t791 language guard: one language per screen = the phone's. Applies to status lines the bundles write after load.
const KPZ={'signature is not from the wallet owner':'这个确认不是来自钱包主人的账户，什么都没改。','not_owner':'这个确认不是来自钱包主人的账户，什么都没改。',
 'challenge expired or used; start again':'这一步已过期，请重新点一次。','bad_nonce':'这一步已过期，请重新点一次。','expired':'这一步已过期，请回到启付 App 重新开始。',
 'slow_down':'操作太频繁了，请等一分钟再试。','rate_limited':'操作太频繁了，请等一分钟再试。','failed to fetch':'连不上网络，请稍后再试。','load failed':'连不上网络，请稍后再试。','network':'连不上网络，请稍后再试。',
 'base account signature required':'需要钱包主人的 Base Account 确认。','user rejected the request.':'你取消了，什么都没改。','user rejected':'你取消了，什么都没改。'};
const KPE={'not_owner':'That confirmation isn’t from this wallet’s owner. Nothing changed.','signature is not from the wallet owner':'That confirmation isn’t from this wallet’s owner. Nothing changed.','challenge expired or used; start again':'This step expired. Tap again.','failed to fetch':'Can’t connect. Please try again later.','load failed':'Can’t connect. Please try again later.','bad_nonce':'This step expired. Tap again.','expired':'This step expired. Go back to the Kipurse app and start again.',
 'slow_down':'Too many tries. Please wait a minute.','rate_limited':'Too many tries. Please wait a minute.','network':'Can’t connect. Please try again later.'};
const GZ='这一步没有完成，没有转出任何钱，也没有扣费。请回到启付 App 再试一次。',GE='That didn’t go through. Nothing was sent or charged. Go back to the Kipurse app and try again.';
const RED=/rgb\(\s*(1[5-9]\d|2\d\d)\s*,\s*([0-6]?\d)\s*,\s*([0-6]?\d)\s*\)/;
const kpFix=(el)=>{if(!el||el.nodeType!==1||el.children.length||el.closest('.kp-stop'))return;const t=(el.textContent||'').trim();if(!t)return;
  const isSt=el.id==='st'||RED.test(getComputedStyle(el).color);if(!isSt)return;
  if(RED.test(getComputedStyle(el).color))el.style.color='#E8E4FF';
  const cjk=/[\u4e00-\u9fff]/.test(t),k=t.toLowerCase().replace(/[.!]+$/,'');let n=null;
  if(lang==='zh'){if(!cjk&&/[a-z]{2,}/i.test(t))n=KPZ[k]??KPZ[t.toLowerCase()]??GZ;}
  else{if(cjk)n=GE;else if(KPE[k])n=KPE[k];else if(/^[a-z_]{3,40}$/.test(k))n=GE;}
  if(n&&n!==t)el.textContent=n;};
const kpWatch=()=>{const mo=new MutationObserver(ms=>{for(const m of ms){const e=m.type==='characterData'?m.target.parentElement:m.target;kpFix(e);if(m.type==='childList')for(const a of m.addedNodes)if(a.nodeType===1){kpFix(a);for(const c of a.querySelectorAll?.('*')??[])kpFix(c);}}});
  mo.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['style','class']});};
let lang=zh?'zh':'en';(async()=>{
  let r;try{r=await of(API+u,{headers:{'x-kp-shell':'1'},cache:'no-store'});}catch{return stop('network');}
  if(!r.ok&&r.status!==404&&r.status!==410)return stop('http_'+r.status);
  const doc=new DOMParser().parseFromString(await r.text(),'text/html');
  lang=zh?'zh':'en';document.documentElement.lang=lang;document.documentElement.style.colorScheme='dark';if(doc.title)document.title=doc.title;
  const want=[];for(const s of doc.querySelectorAll('script')){if(s.type==='application/json')continue;
    if(s.getAttribute('src')){const p=new URL(s.getAttribute('src'),API+u).pathname.replace(/^\/t\/0x[0-9a-fA-F]{40}/,'');const f=MAP[p]||MAP[s.getAttribute('src')];if(!f)return stop('unknown_script');want.push(f);}
    else{const f=INLINE[path];if(!f)continue;want.push(f);}}
  const data=[...doc.querySelectorAll('script[type="application/json"]')];
  const st=[...doc.querySelectorAll('style')].map(s=>s.textContent).join('\n');if(st){const e=document.createElement('style');e.textContent=st;document.head.appendChild(e);}const kpDark=document.createElement('style');kpDark.id='kp-dark-v8';kpDark.textContent='\n/* t1040 /v8: App-matching dark glass + purple→cyan (forced; do not follow light server CSS) */\nhtml,body{background:#0A0820!important;color:#F5F3FF!important}\nbody{background:\n  radial-gradient(60% 50% at 12% 0%,rgba(124,58,237,.38),transparent 70%),\n  radial-gradient(50% 45% at 100% 95%,rgba(34,211,238,.12),transparent 70%),\n  linear-gradient(180deg,#100C2E 0%,#0A0820 55%,#050510 100%)!important;min-height:100vh}\n:root{--a:#8B5CF6!important;--bg:#0A0820!important;--card:rgba(255,255,255,.08)!important;--t:#F5F3FF!important;--s:#A8A3C7!important;color-scheme:dark!important}\n#kp-root,.kp-stop,.w{max-width:480px;margin:40px auto;padding:18px}\n.kp-stop{background:rgba(255,255,255,.08)!important;border:1px solid rgba(255,255,255,.14)!important;border-radius:20px!important;color:#E8E4FF!important;font-weight:600;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}\n.c,.card{background:rgba(255,255,255,.08)!important;border:1px solid rgba(255,255,255,.14)!important;border-radius:20px!important;color:#F5F3FF!important;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);box-shadow:0 8px 28px rgba(0,0,0,.35)}\n.t,.big,h1,h2,b,strong{color:#F5F3FF!important}\n.m,.s,p,.meta,small,li{color:#A8A3C7!important}\n.addr,.fp,.mono,input{background:rgba(255,255,255,.06)!important;color:#F5F3FF!important;border:1px solid rgba(255,255,255,.14)!important}\ninput::placeholder{color:#7C7799}\n.sr{border-bottom-color:rgba(255,255,255,.10)!important}\nbutton,a.btn{background:linear-gradient(90deg,#7C3AED,#4F46E5,#0891B2)!important;color:#fff!important;border:1px solid rgba(255,255,255,.22)!important;border-radius:14px!important;box-shadow:0 6px 18px rgba(91,44,255,.30)}\nbutton.s,a.s,.g button{background:rgba(139,92,246,.16)!important;color:#C4B5FD!important;border:1px solid rgba(139,92,246,.28)!important;box-shadow:none}\n.g button.on{background:linear-gradient(90deg,#7C3AED,#0891B2)!important;color:#fff!important}\n.g button:disabled{background:rgba(255,255,255,.04)!important;color:#6B6685!important}\n.warn{background:rgba(251,191,36,.12)!important;color:#FBBF24!important;border:1px solid rgba(251,191,36,.28)!important}\n.lnk,a:not(.btn){color:#22D3EE!important}\n.sx{border-color:#FBBF24!important}\n/* keep QR scannable */\n.qr{background:#fff!important;border-radius:16px;padding:12px;display:inline-block}\n.qr svg{background:#fff}\n#cs{color:#E8E4FF}\n';document.head.appendChild(kpDark);
  clean(doc.body);for(const a of doc.body.querySelectorAll('a[href]')){const h=a.getAttribute('href');if(h&&!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)&&!h.startsWith('#'))a.setAttribute('href',new URL(h,API+u).href);}root.replaceWith(...[...doc.body.childNodes]);
  for(const d of data){const e=document.createElement('script');e.type='application/json';if(d.id)e.id=d.id;e.textContent=d.textContent;document.body.appendChild(e);}
  window.KP_API=API;kpWatch();try{for(const f of want)await load(f);}catch(e){return stop(e.message);}
})();})();
