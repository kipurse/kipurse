/* Kipurse signing shell (t629 A1, v2 t735). Served ONLY from an immutable Cloudflare Pages deployment whose index.html hash is pinned in
   the Kipurse app; this file and every bundle are loaded with Subresource Integrity, so a compromised Kipurse server cannot swap the
   code that checks the batch. The server only supplies data (the page text and the calls); the KPVH guard inside each bundle refuses
   any batch whose SHA-256 differs from the commitment the APP put in the URL fragment. Anything unexpected -> stop, nothing sent. */
(()=>{'use strict';
const API='https://pay.kipurse.com';
const SRI={"onboard.js":"sha384-xadSV/9pddXd7NAbrsY9asaIiChec0cDb4ILGiBELM5rydla6320+AylWgoWEgiP","onboard-new.js":"sha384-euWg9WsIaMh4JeWF6i9qvhsbcRAsHrbiQeMPku/64mn1ykt5+Wyldt4zoT3Sg1e/","deposit.js":"sha384-liPaUt2UA84VD+QijLQf9munlQoXZYt6wx5Ace6dej8vinHb6oaFquuyBnCAVI3S","limits.js":"sha384-lE8560+hVu6000nLYcCIiDs+EQ33GZn+lM8ngT2mjEg4LLdRNzGVI934P+Y8ee/o","withdraw.v2.js":"sha384-4U9E21Wf9zT4MzMiCUHTDctVChmAk37uViL9lgbkokliXAUN1MfYMjnrKMiQe/iJ","phone-enroll.js":"sha384-vyd+CVYc1E79n00OIHBaSTHcIK/1Afz/ozk4tl7xqX6yPEVBhyvYtr0VJdBPlp+7","limits-done.js":"sha384-WDuedbrkp5DowST1SCxFAtjhZhCMkzrIK5vnYNDRATWli6pj4eBnjbNjN0VjJfXg","deposit-ui.js":"sha384-Qk9wRwUOI0eg39obV1oD3t0m7Mcj6Sb+nHiWMHMBDbsef0bqBdJ1fuWd7ZLNWfOg"};
const MAP={'/onboard.js':'onboard.js','/onboard/new.js':'onboard-new.js','/deposit.js':'deposit.js','/owner/limits.js':'limits.js','/owner/limits-done.js':'limits-done.js',
  '/owner/withdraw.js':'withdraw.v2.js','/phone/enroll.js':'phone-enroll.js'};
const INLINE={'/deposit':'deposit-ui.js'};
const H=new URLSearchParams(location.hash.replace(/^#/,''));const root=document.getElementById('kp-root');
const zh=/^zh/i.test(new URLSearchParams(String(H.get('u')||'').split('?')[1]||'').get('lang')||navigator.language||'');
let dead=false;const stop=(why)=>{dead=true;window.KP_STOPPED=why;document.documentElement.lang=zh?'zh':'en';for(const n of [...document.body.childNodes])if(n.tagName!=='SCRIPT'||n.type==='application/json')n.remove();const d=document.createElement('div');d.className='kp-stop';
  d.textContent=zh?'已停止，没有转出任何钱。请回到启付 App 重新开始。（'+why+'）':'Stopped. Nothing was sent. Go back to the Kipurse app and start again. ('+why+')';document.body.appendChild(d);};
// 1. the page path must be a Kipurse server path (no other host, no scheme tricks)
const u=String(H.get('u')||'');if(!/^\/[A-Za-z0-9/_\-.]*(\?[A-Za-z0-9_\-.=&%~]*)?$/.test(u)||u.startsWith('//'))return stop('bad_path');
const path=u.split('?')[0].replace(/^\/t\/0x[0-9a-fA-F]{40}/,'');
// 2. relative API calls made by the bundles go to the Kipurse server, never to this static host
const of=window.fetch.bind(window),own=new Set(['/','/index.html',...Object.values(MAP).map(x=>'/'+x)]);
const rw=s=>{if(typeof s!=='string')return s;if(s.startsWith(location.origin+'/'))s=s.slice(location.origin.length);if(s.startsWith('/')&&!s.startsWith('//')&&!own.has(s.split('?')[0]))return API+s;return s;};
window.fetch=(i,o)=>{if(typeof i==='string')return of(rw(i),o);if(i instanceof URL)return of(rw(i.href),o);if(i&&i.url){const n=rw(i.url);return of(n===i.url?i:new Request(n,i),o);}return of(i,o);};
const load=f=>new Promise((ok,ko)=>{const h=SRI[f];if(!h)return ko(Error('unknown_script'));const s=document.createElement('script');s.src='/'+f;s.integrity=h;s.crossOrigin='anonymous';s.onload=ok;s.onerror=()=>ko(Error('integrity'));document.body.appendChild(s);});
const clean=n=>{for(const e of [...n.querySelectorAll('script,iframe,object,embed,link,meta,base,form')])e.remove();
  for(const e of n.querySelectorAll('*'))for(const a of [...e.attributes]){const k=a.name.toLowerCase();if(k.startsWith('on')||((k==='href'||k==='src'||k==='action'||k==='formaction')&&/^\s*(javascript|data):/i.test(a.value)))e.removeAttribute(a.name);}};
(async()=>{
  let r;try{r=await of(API+u,{headers:{'x-kp-shell':'1'},cache:'no-store'});}catch{return stop('network');}
  if(!r.ok&&r.status!==404&&r.status!==410)return stop('http_'+r.status);
  const doc=new DOMParser().parseFromString(await r.text(),'text/html');
  const lang=doc.documentElement.getAttribute('lang')==='zh'?'zh':'en';document.documentElement.lang=lang;if(doc.title)document.title=doc.title;
  const want=[];for(const s of doc.querySelectorAll('script')){if(s.type==='application/json')continue;
    if(s.getAttribute('src')){const p=new URL(s.getAttribute('src'),API+u).pathname.replace(/^\/t\/0x[0-9a-fA-F]{40}/,'');const f=MAP[p]||MAP[s.getAttribute('src')];if(!f)return stop('unknown_script');want.push(f);}
    else{const f=INLINE[path];if(!f)continue;want.push(f);}}
  const data=[...doc.querySelectorAll('script[type="application/json"]')];
  const st=[...doc.querySelectorAll('style')].map(s=>s.textContent).join('\n');if(st){const e=document.createElement('style');e.textContent=st;document.head.appendChild(e);}
  clean(doc.body);root.replaceWith(...[...doc.body.childNodes]);
  for(const d of data){const e=document.createElement('script');e.type='application/json';if(d.id)e.id=d.id;e.textContent=d.textContent;document.body.appendChild(e);}
  window.KP_API=API;try{for(const f of want)await load(f);}catch(e){return stop(e.message);}
})();})();
