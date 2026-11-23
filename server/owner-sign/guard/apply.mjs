// Idempotent: prepend the KPVH guard and wrap every page-level wallet_sendCalls request with `await kpVH(...)`.
import fs from 'node:fs';
const G=fs.readFileSync(new URL('./kpvh.js',import.meta.url),'utf8');
export function wrap(src){let out='',i=0;const re=/\(\)\.request\(\{method:["']wallet_sendCalls["']/g;let m,n=0;
  while((m=re.exec(src))){const s=m.index+'().request('.length;let d=0,j=s,q=null;
    for(;j<src.length;j++){const ch=src[j];if(q){if(ch==='\\'){j++;continue;}if(ch===q)q=null;continue;}if(ch==='"'||ch==="'"||ch==='`'){q=ch;continue;}if(ch==='{')d++;else if(ch==='}'){d--;if(d===0)break;}}
    if(src[j+1]!==')')throw Error('unexpected shape at '+s);out+=src.slice(i,s)+'await kpVH('+src.slice(s,j+1)+')';i=j+1;n++;re.lastIndex=j+1;}
  return {code:out+src.slice(i),n};}
export function apply(src){if(src.includes('KPVH-GUARD v1'))return {code:src,n:0,already:true};const w=wrap(src);return {code:w.n?G+w.code:src,n:w.n};}
if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').pop())){for(const f of process.argv.slice(2)){const r=apply(fs.readFileSync(f,'utf8'));if(r.n)fs.writeFileSync(f,r.code);console.log(f,r.already?'already':r.n);}}
