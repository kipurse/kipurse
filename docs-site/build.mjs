// Docs site builder (no deps). Same look as kipurse.com: theme/ holds the main site's CSS, WebGL aurora (bg.js), fx.js, fonts, logo.
// docs/**/*.md -> dist/. English default; 中文 toggle switches chrome and body: Simplified Chinese bodies live in docs-site/zh/<same path>.md. Deploy needs owner approval.
import fs from 'node:fs';import path from 'node:path';
const here=path.dirname(new URL(import.meta.url).pathname),root=path.resolve(here,'..'),out=path.join(here,'dist');
fs.rmSync(out,{recursive:true,force:true});fs.cpSync(path.join(here,'theme'),out,{recursive:true});
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const inl=t=>esc(t).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2">$1</a>');
function md(s){let h='',code=false,tbl=[],list=null;const fl=()=>{if(list){h+=`</${list}>`;list=null;}if(!tbl.length)return;const rows=tbl.filter(r=>!/^\|[\s:|-]+\|$/.test(r));
  h+='<div class="tw"><table>'+rows.map((r,i)=>'<tr>'+r.slice(1,-1).split('|').map(c=>`<${i?'td':'th'}>${inl(c.trim())}</${i?'td':'th'}>`).join('')+'</tr>').join('')+'</table></div>';tbl=[];};
  let title=null;for(const l of s.split('\n')){if(l.startsWith('```')){fl();h+=code?'</code></pre>':'<pre><code>';code=!code;continue;}if(code){h+=esc(l)+'\n';continue;}
    if(l.startsWith('|')){if(list){h+=`</${list}>`;list=null;}tbl.push(l.trim());continue;}if(tbl.length)fl();
    const m=/^(#{1,4}) (.*)/.exec(l);const li=/^\s*[-*] (.*)/.exec(l),ol=/^\s*\d+\. (.*)/.exec(l);
    if(m){fl();if(m[1].length===1&&!title){title=m[2];continue;}h+=`<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`;}
    else if(li||ol){const t=li?'ul':'ol';if(list!==t){fl();h+=`<${t}>`;list=t;}h+=`<li>${inl((li||ol)[1])}</li>`;}
    else if(l.trim()){fl();h+=`<p>${inl(l)}</p>`;}else if(list){h+=`</${list}>`;list=null;}}fl();return {title,html:h};}
const GROUPS={design:['Design','设计'],security:['Security','安全'],fees:['Fees','费用'],ops:['Operations','运维'],compliance:['Compliance','合规'],'siri-ai':['Siri & AI','Siri 与 AI']};
const clean=t=>(t??'').replace(/\s*\((?:t\d+|updated|draft|NOT|prepared|owner|Siri AI skill)[^)]*\)/gi,'').replace(/\s+—\s+\d{4}-\d{2}-\d{2}$/,'').trim();
const bil=t=>{t=clean(t);const m=/^(.*?[\u4e00-\u9fff].*?)\s+\/\s+(.*)$/.exec(t);return m?`<span class="l-zh">${inl(m[1])}</span><span class="l-en">${inl(m[2])}</span>`:inl(t);};
const pages=[];const walk=d=>{for(const f of fs.readdirSync(path.join(root,d)).sort()){const p=path.join(d,f);if(fs.statSync(path.join(root,p)).isDirectory())walk(p);
  else if(f.endsWith('.md')){const g=p.split('/')[1];const zf=path.join(here,'zh',p.replace(/^docs\//,''));const zh=fs.existsSync(zf)?md(fs.readFileSync(zf,'utf8')):null;pages.push({zh,slug:p.replace(/^docs\//,'').replace(/\.md$/,'').replace(/[\/.]/g,'-').toLowerCase(),src:p,group:g,...md(fs.readFileSync(path.join(root,p),'utf8'))});}}};walk('docs');
const CSS=`main{max-width:1120px;margin:0 auto;padding:0 20px}.dh{padding:72px 0 28px;text-align:center}.dh h1{font-size:clamp(34px,5.4vw,62px);line-height:1.05;letter-spacing:-.03em;margin:18px 0 12px}
.dh .lead{max-width:680px;margin:0 auto;color:var(--mut)}.grp{margin:40px 0 10px;font:12px GeistMono,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--c)}
.dg{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}.dc{position:relative;display:block;text-decoration:none;color:inherit;border:1px solid var(--line);background:var(--card);border-radius:18px;padding:20px;transition:.3s;backdrop-filter:blur(8px)}
.dc:hover{transform:translateY(-4px);border-color:rgba(20,210,238,.5);box-shadow:0 10px 40px rgba(139,116,255,.25)}.dc h3{font-size:17px;margin:4px 0 6px}.dc p{font:12px GeistMono,monospace;color:#7d7b94;margin:0}
.lay{display:grid;grid-template-columns:230px 1fr;gap:28px;padding:36px 0 40px}.side{position:sticky;top:76px;align-self:start;display:flex;flex-direction:column;gap:4px;font-size:14px}
.side b{font:11px GeistMono,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--c);margin:14px 0 4px}.side a{color:var(--mut);text-decoration:none;padding:5px 10px;border-radius:10px}.side a:hover,.side a.on{color:var(--fg);background:var(--card)}
.art{border:1px solid var(--line);background:rgba(10,10,18,.55);backdrop-filter:blur(14px);border-radius:22px;padding:36px clamp(20px,4vw,48px);min-width:0}
.art h1{font-size:clamp(28px,4vw,44px);letter-spacing:-.02em;line-height:1.1;margin:0 0 18px;background:linear-gradient(90deg,#fff,var(--p));-webkit-background-clip:text;background-clip:text;color:transparent}
.art h2{font-size:24px;margin:34px 0 10px}.art h3{font-size:18px;margin:24px 0 8px}.art p,.art li{color:#d6d4e6;line-height:1.7}.art a{color:var(--c)}.art code{font:13px GeistMono,monospace;background:rgba(139,116,255,.14);border-radius:6px;padding:1px 6px}
.art pre{background:rgba(0,0,0,.45);border:1px solid var(--line);border-radius:14px;padding:16px;overflow:auto}.art pre code{background:none;padding:0}
.tw{overflow-x:auto;margin:16px 0;border:1px solid var(--line);border-radius:14px}.art table{border-collapse:collapse;width:100%;font-size:14px}.art th{text-align:left;color:var(--fg);background:rgba(139,116,255,.12)}
.art td,.art th{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}.art tr:last-child td{border-bottom:0}.src{margin-top:28px;font:12px GeistMono,monospace;color:#7d7b94}
.sr{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border:1px solid var(--line);background:var(--card);border-radius:16px;margin:10px 0}.up{color:#5ef0b0}.down{color:#ff6b8b}
html:not([lang=en]) .l-en,html[lang=en] .l-zh{display:none}body{min-height:100vh;display:flex;flex-direction:column}main{flex:1;width:100%}footer{width:100%;box-sizing:border-box}#bg,.bg-fallback{position:fixed!important;height:100vh!important;-webkit-mask-image:none!important;mask-image:none!important}.nav nav{display:flex!important;gap:18px}@media(max-width:820px){.lay{grid-template-columns:1fr;padding-top:20px}.side{display:none}.nav nav .wide{display:none}.nav{gap:12px}.nav nav{gap:14px}.dh{padding-top:48px}}`;
const T={en:{brand:'Kipurse',home:'Home',docs:'Docs',status:'Status',h:'Kipurse documentation',p:'Design, security, fees and operations — the same files as the open-source repo, rendered.',src:'Source',sp:'Checked live from your browser when you open this page. Nothing runs in the background on our side.',
  st:'System status',priv:'Privacy',sup:'Support',down:'If the gateway is unreachable your money is still yours: the offline exit needs no Kipurse server.'},
  zh:{brand:'启付',home:'主页',docs:'文档',status:'状态',h:'启付文档',p:'设计、安全、费用和运维——和开源仓库是同一批文件。',src:'源文件',sp:'打开页面时由你的浏览器实时检查，我们这边没有任何后台任务。',st:'系统状态',priv:'隐私政策',sup:'帮助',down:'即使网关连不上，钱依然是你的：离线提现不需要启付服务器。'}};
const lj=`(function(){var T=${JSON.stringify(T)};var q=new URLSearchParams(location.search).get("lang"),l="en";try{l=q=="zh"||q=="en"?q:(localStorage.getItem("kp-lang")||"en")}catch(e){}
function r(){var t=T[l];document.documentElement.lang=l=="zh"?"zh-Hans":"en";document.querySelectorAll("[data-t]").forEach(function(e){if(t[e.dataset.t])e.textContent=t[e.dataset.t]});document.getElementById("lang").textContent=l=="zh"?"EN":"中文";}
document.getElementById("lang").onclick=function(){l=l=="zh"?"en":"zh";try{localStorage.setItem("kp-lang",l)}catch(e){}r()};r();})();`;
fs.writeFileSync(path.join(out,'docs.js'),lj);
const shell=(title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title>
<meta name="theme-color" content="#07070c"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="preload" href="/fonts/Geist.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/bg.css"><style>${CSS}</style></head><body>
<canvas id="bg" aria-hidden="true"></canvas><div class="bg-fallback" aria-hidden="true"></div><div class="grain" aria-hidden="true"></div>
<header class="nav"><a class="brand" href="/"><img src="/assets/logo.svg" alt="" width="28" height="28"><span data-t="brand">Kipurse</span></a>
<nav><a class="wide" href="https://kipurse.com/" data-t="home">Home</a><a href="/" data-t="docs">Docs</a><a href="/status" data-t="status">Status</a><a class="wide" href="https://github.com/kipurse/kipurse" rel="noopener">GitHub ↗</a></nav>
<button class="lang" id="lang" aria-label="Language" style="margin-left:0">中文</button></header>
<main>${body}</main><footer><p>© 2026 Blessbridge Global Trading LLC · <span data-t="brand">Kipurse</span></p><p><a href="https://kipurse.com/privacy/" data-t="priv">Privacy</a> · <a href="https://kipurse.com/support/" data-t="sup">Support</a></p></footer>
<script src="/docs.js"></script><script src="/bg.js"></script><script src="/fx.js"></script></body></html>`;
const gl=g=>`<span class="l-en">${GROUPS[g][0]}</span><span class="l-zh">${GROUPS[g][1]}</span>`;
const ttl=p=>p.zh?`<span class="l-en">${inl(clean(p.title??p.slug).split(' / ').pop())}</span><span class="l-zh">${inl(clean(p.zh.title))}</span>`:bil(p.title??p.slug);
const body=p=>p.zh?`<div class="l-en">${p.html}</div><div class="l-zh">${p.zh.html}</div>`:p.html;
const side=cur=>{let h='';for(const g of Object.keys(GROUPS)){const ps=pages.filter(p=>p.group===g);if(!ps.length)continue;h+=`<b>${gl(g)}</b>`+ps.map(p=>`<a href="/${p.slug}"${p.slug===cur?' class=on':''}>${ttl(p)}</a>`).join('');}return `<aside class="side">${h}</aside>`;};
let grid='';for(const g of Object.keys(GROUPS)){const ps=pages.filter(p=>p.group===g);if(!ps.length)continue;grid+=`<p class="grp">${gl(g)}</p><div class="dg">`+ps.map(p=>`<a class="dc" href="/${p.slug}"><h3>${ttl(p)}</h3><p>${esc(p.src)}</p></a>`).join('')+'</div>';}
fs.writeFileSync(path.join(out,'index.html'),shell('Kipurse docs',`<section class="dh"><p class="pill"><span class="dot"></span>github.com/kipurse/kipurse</p><h1 class="glow" data-t="h">Kipurse documentation</h1><p class="lead" data-t="p"></p></section>${grid}<div style="height:40px"></div>`));
for(const p of pages)fs.writeFileSync(path.join(out,p.slug+'.html'),shell(clean(p.title??p.slug).split(' / ').pop()+' — Kipurse docs',`<div class="lay">${side(p.slug)}<article class="art"><p style="margin:0 0 14px"><a href="/" style="font:12px GeistMono,monospace;color:var(--c);text-decoration:none">← <span data-t="docs">Docs</span></a></p><h1>${ttl(p)}</h1>${body(p)}<p class="src"><span data-t="src">Source</span>: <a href="https://github.com/kipurse/kipurse/blob/main/${p.src}">${esc(p.src)}</a></p></article></div>`));
const S=[["Agent gateway (Base mainnet)","https://pay.kipurse.com/.well-known/oauth-authorization-server"],["Test gateway (Base Sepolia)","https://mcp.kipurse.com/.well-known/oauth-authorization-server"],["Website","https://kipurse.com/"],["Base network","https://mainnet.base.org"]];
fs.writeFileSync(path.join(out,'status.html'),shell('Kipurse status',`<section class="dh"><h1 class="glow" data-t="st">System status</h1><p class="lead" data-t="sp"></p></section><div style="max-width:720px;margin:0 auto" id="sl"></div><p class="lead" style="text-align:center;color:var(--mut);margin:24px auto 40px;max-width:640px" data-t="down"></p>
<script>(function(){var S=${JSON.stringify(S)},l=document.getElementById("sl");S.forEach(function(s){var d=document.createElement("div");d.className="sr";d.innerHTML="<span>"+s[0]+"</span><span>…</span>";l.appendChild(d);var t=performance.now();
fetch(s[1],{mode:"no-cors",cache:"no-store"}).then(function(){d.lastChild.className="up";d.lastChild.textContent="● up · "+Math.round(performance.now()-t)+" ms"}).catch(function(){d.lastChild.className="down";d.lastChild.textContent="● unreachable"})})})();</script>`));
console.log('built',pages.length+2,'pages ->',out);
