// Static docs site builder (no deps): docs/**/*.md + README -> docs-site/dist/*.html. Not deployed; deploy needs owner approval.
import fs from 'node:fs';import path from 'node:path';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..'),out=path.join(root,'docs-site/dist');fs.mkdirSync(out,{recursive:true});
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const md=s=>{let h='',inCode=false,tbl=[];const flush=()=>{if(!tbl.length)return;h+='<table>'+tbl.filter(r=>!/^\|[\s:|-]+\|$/.test(r)).map((r,i)=>'<tr>'+r.slice(1,-1).split('|').map(c=>`<${i?'td':'th'}>${inl(c.trim())}</${i?'td':'th'}>`).join('')+'</tr>').join('')+'</table>';tbl=[];};
  const inl=t=>esc(t).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>').replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2">$1</a>');
  for(const l of s.split('\n')){if(l.startsWith('```')){flush();h+=inCode?'</pre>':'<pre>';inCode=!inCode;continue;}if(inCode){h+=esc(l)+'\n';continue;}
    if(l.startsWith('|')){tbl.push(l.trim());continue;}flush();const m=/^(#{1,4}) (.*)/.exec(l);
    if(m)h+=`<h${m[1].length}>${inl(m[2])}</h${m[1].length}>`;else if(/^[-*] /.test(l))h+=`<li>${inl(l.slice(2))}</li>`;else if(l.trim())h+=`<p>${inl(l)}</p>`;}flush();return h;};
const pages=[['index','README.md']];const walk=d=>{for(const f of fs.readdirSync(path.join(root,d))){const p=path.join(d,f);if(fs.statSync(path.join(root,p)).isDirectory())walk(p);else if(f.endsWith('.md'))pages.push([p.replace(/[\/.]/g,'-').replace(/-md$/,''),p]);}};walk('docs');
const nav=pages.map(([n,p])=>`<a href="${n}.html">${esc(p)}</a>`).join('');
const css='body{margin:0;display:flex;font:15px/1.6 system-ui;background:#07070c;color:#e8e8f0}nav{width:260px;padding:20px;border-right:1px solid #222;display:flex;flex-direction:column;gap:6px;font-size:13px}nav a{color:#9ab}main{max-width:900px;padding:32px}a{color:#7cf}code,pre{background:#14141c;border-radius:4px;padding:2px 4px}pre{padding:12px;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #333;padding:4px 8px}';
for(const [n,p] of pages)fs.writeFileSync(path.join(out,n+'.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kipurse docs — ${esc(p)}</title><style>${css}</style><nav><b>Kipurse docs</b>${nav}</nav><main>${md(fs.readFileSync(path.join(root,p),'utf8'))}</main></html>`);
console.log('built',pages.length,'pages ->',out);
