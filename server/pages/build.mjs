// Build the static signing host (Cloudflare Pages). node pages/build.mjs -> pages/dist + pages/dist/PIN.json
// The app pins sha256(index.html); index.html pins kpshell.js by SRI; kpshell.js pins every bundle by SRI.
import fs from 'node:fs';import {createHash} from 'node:crypto';import {LIMITS_DONE_JS} from '../src/v5/limits-public.mjs';
const D=new URL('./dist/',import.meta.url),S=new URL('../owner-sign/static/',import.meta.url),P=new URL('./',import.meta.url);
fs.rmSync(D,{recursive:true,force:true});fs.mkdirSync(D);
const sri=b=>'sha384-'+createHash('sha384').update(b).digest('base64');const files={};
for(const f of ['onboard.js','onboard-new.js','deposit.js','limits.js','withdraw.js','phone-enroll.js'])files[f]=fs.readFileSync(new URL(f,S));
files['limits-done.js']=Buffer.from(LIMITS_DONE_JS);files['deposit-ui.js']=fs.readFileSync(new URL('deposit-ui.js',P));
for(const [f,b] of Object.entries(files)){if(f!=='limits-done.js'&&f!=='deposit-ui.js'&&!b.includes('KPVH-GUARD v1'))throw Error('bundle without guard: '+f);fs.writeFileSync(new URL(f,D),b);}
const shell=Buffer.from(fs.readFileSync(new URL('shell.src.js',P),'utf8').replace('__SRI__',JSON.stringify(Object.fromEntries(Object.entries(files).map(([f,b])=>[f,sri(b)])))));
fs.writeFileSync(new URL('kpshell.js',D),shell);
const html=`<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Kipurse</title><meta name=referrer content=no-referrer>
<style>body{margin:0;background:#F2F2F7;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}#kp-root,.kp-stop{max-width:480px;margin:40px auto;padding:18px}.kp-stop{background:#fff;border-radius:16px;color:#c81e1e;font-weight:600}</style>
<div id=kp-root>…</div><script src="/kpshell.js" integrity="${sri(shell)}" crossorigin="anonymous"></script></html>\n`;
fs.writeFileSync(new URL('index.html',D),html);
fs.writeFileSync(new URL('_headers',D),`/*\n  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src https:; img-src data: https:; frame-src https://keys.coinbase.com; form-action 'none'; frame-ancestors 'none'; base-uri 'none'\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n  Cache-Control: no-store\n`);
const pin={indexSha256:createHash('sha256').update(html).digest('hex'),shellSri:sri(shell),built:new Date().toISOString()};
fs.writeFileSync(new URL('PIN.json',P),JSON.stringify(pin,null,1));console.log(JSON.stringify(pin));
