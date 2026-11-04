// SPDX-License-Identifier: AGPL-3.0-only
// Response localization: the kit's user-facing text is written in Chinese; English clients (x-kp-lang: en or an English
// Accept-Language) get every string in a JSON response translated, including "%@" templates with nested values.
import fs from 'node:fs';
const EN=JSON.parse(fs.readFileSync(new URL('./i18n-en.json',import.meta.url),'utf8'));
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const TPL=Object.keys(EN).filter(k=>k.includes('%@')).sort((a,b)=>b.length-a.length).map(k=>[new RegExp('^'+k.split('%@').map(esc).join('([\\s\\S]*?)')+'$'),EN[k]]);
const CJK=/[\u4e00-\u9fff]/;
export function en(s){if(typeof s!=='string'||!CJK.test(s))return s;if(EN[s])return EN[s];
  for(const [re,out] of TPL){const m=re.exec(s);if(m){let i=1;return out.replace(/%@/g,()=>en(m[i++]));}}
  return s;}
export const langOf=req=>{const x=String(req.headers['x-kp-lang']??'').toLowerCase();if(x)return x.startsWith('zh')?'zh':'en';
  const a=String(req.headers['accept-language']??'').toLowerCase();return /^[a-y][a-z]/.test(a)&&!a.startsWith('zh')?'en':'zh';};
export function localize(v,lang){if(lang!=='en')return v;if(typeof v==='string')return en(v);if(Array.isArray(v))return v.map(x=>localize(x,lang));
  if(v&&typeof v==='object'){const o={};for(const [k,x] of Object.entries(v))o[k]=(k.endsWith('Zh')||k==='zh')?x:localize(x,lang);return o;}return v;}
export const untranslated=(v,acc=new Set())=>{if(typeof v==='string'){if(CJK.test(en(v)))acc.add(v);}else if(Array.isArray(v))v.forEach(x=>untranslated(x,acc));else if(v&&typeof v==='object')Object.entries(v).forEach(([k,x])=>{if(!(k.endsWith('Zh')||k==='zh'))untranslated(x,acc);});return acc;};
