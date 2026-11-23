// SPDX-License-Identifier: Apache-2.0
// Hashed private denylist (fail closed). private-denylist.sha256 holds only one-way hashes of values that must never appear here
// (the operator's own wallets and values derived from them, private identifiers). The plain values are kept privately by the
// operator; this public check recognises them without revealing them.
//   node scripts/check-denylist.mjs                 hashed list (CI)
//   node scripts/check-denylist.mjs --plain FILE    also a local PLAIN list (operator only; never commit it): lines "addr 0x..",
//                                                   "hex32 <64 hex>", "token <word>", "phrase <text>" (case-insensitive substrings)
// Hashing: sha256("kipurse-denylist-v1|<kind>|<normalized>") for addr (40 lowercase hex), hex32 (64 lowercase hex), token (lowercase);
// abbreviated addresses ("0x1234…abcd", first 4 + last 4 hex) use scrypt (N=2^15) because 32 bits are cheap to brute-force with sha256.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {ROOT,listFiles,readText,lineOf} from './guard-files.mjs';
export const PREFIX='kipurse-denylist-v1|';
export const h=(kind,v)=>crypto.createHash('sha256').update(PREFIX+kind+'|'+v).digest('hex');
export const habbr=v=>crypto.scryptSync(v,PREFIX+'abbr',32,{N:1<<15,r:8,p:1,maxmem:64<<20}).toString('hex');
const HEXRUN=/[0-9a-fA-F]{40,}/g,ABBR=/0x([0-9a-fA-F]{4})\s?(?:…|\.{2,3})\s?([0-9a-fA-F]{4})(?![0-9a-fA-F])/g,TOKEN=/[A-Za-z0-9][A-Za-z0-9._@-]*[A-Za-z0-9]/g;
/** Candidate 40- and 64-hex values inside one hex run: the run itself, ABI-padded words and every offset of short runs. */
export function* hexCandidates(run){const r=run.toLowerCase(),n=r.length;
  if(n===40){yield ['addr',r];return;}
  const all=n<=4096;
  for(let i=0;i+40<=n;i++){const padded=i>=24&&r.startsWith('000000000000000000000000',i-24);
    if(all||padded||i%64===0||i%64===8||i+40===n)yield ['addr',r.slice(i,i+40)];
    if(i+64<=n&&(all||i%64===0||i%64===8))yield ['hex32',r.slice(i,i+64)];}}
export function loadHashed(root=ROOT){const out={addr:new Set(),hex32:new Set(),token:new Set(),abbr:new Set()};const p=path.join(root,'private-denylist.sha256');
  if(!fs.existsSync(p))throw Error('private-denylist.sha256 missing (fail closed)');
  for(const l of fs.readFileSync(p,'utf8').split('\n')){const s=l.replace(/#.*/,'').trim();if(!s)continue;const [k,d]=s.split(/\s+/);if(!out[k]||!/^[0-9a-f]{64}$/.test(d))throw Error('bad denylist line: '+s);out[k].add(d);}
  return out;}
export function loadPlain(file){const out={addr:new Set(),hex32:new Set(),token:new Set(),phrase:[]};
  for(const l of fs.readFileSync(file,'utf8').split('\n')){const s=l.replace(/^\s+|\s+$/g,'');if(!s||s.startsWith('#'))continue;const i=s.indexOf(' ');const k=s.slice(0,i),v=s.slice(i+1).trim();
    if(k==='addr')out.addr.add(v.replace(/^0x/i,'').toLowerCase());else if(k==='hex32')out.hex32.add(v.replace(/^0x/i,'').toLowerCase());
    else if(k==='token')out.token.add(v.toLowerCase());else if(k==='phrase')out.phrase.push(v.toLowerCase());else throw Error('bad plain denylist line: '+s);}
  return out;}
export function scan({root=ROOT,hashed=loadHashed(root),plain=null}={}){const hits=[];const abbrCache=new Map();
  const plainAbbr=new Set(),plainPfx=new Set();if(plain)for(const a of plain.addr){plainAbbr.add(a.slice(0,4)+a.slice(-4));plainPfx.add(a.slice(0,4));}
  for(const f of listFiles(root)){if(f==='private-denylist.sha256')continue;const t=readText(f,root);if(t==null)continue;const hit=(i,what)=>hits.push({file:f,line:lineOf(t,i),what});
    for(const m of t.matchAll(HEXRUN))for(const [k,v] of hexCandidates(m[0])){
      if(hashed[k].has(h(k,v)))hit(m.index,`hashed ${k}`);else if(plain&&plain[k].has(v))hit(m.index,`plain ${k} ${v.slice(0,4)}…`);}
    for(const m of t.matchAll(ABBR)){const v=(m[1]+m[2]).toLowerCase();
      if(hashed.abbr.size){if(!abbrCache.has(v))abbrCache.set(v,hashed.abbr.has(habbr(v)));if(abbrCache.get(v))hit(m.index,'hashed abbreviated address');}
      if(plain&&plainAbbr.has(v))hit(m.index,'plain abbreviated address 0x'+m[1]+'…');}
    if(plain)for(const m of t.matchAll(/0x([0-9a-fA-F]{4})(?:…|\.{2,3}|(?![0-9a-fA-F]))/g))if(plainPfx.has(m[1].toLowerCase()))hit(m.index,'plain short address prefix 0x'+m[1]);
    if(hashed.token.size||plain?.token.size)for(const m of t.matchAll(TOKEN)){const w=m[0].toLowerCase();const parts=[w,...w.split(/[._@-]/)];
      for(const p of parts){if(hashed.token.has(h('token',p)))hit(m.index,'hashed token');else if(plain?.token.has(p))hit(m.index,'plain token '+p.slice(0,3)+'…');}}
    if(plain){const lt=t.toLowerCase();for(const p of plain.phrase){let i=lt.indexOf(p);if(i>=0)hit(i,'plain phrase '+p.slice(0,3)+'…');}}}
  return hits;}
if(import.meta.url===`file://${process.argv[1]}`){const i=process.argv.indexOf('--plain');const plainFile=i>0?process.argv[i+1]:process.env.KIPURSE_PRIVATE_DENYLIST;
  const plain=plainFile?loadPlain(plainFile):null;const hits=scan({plain});
  for(const x of hits)console.log(`DENYLIST ${x.file}:${x.line} ${x.what}`);
  if(hits.length){console.log(`denylist check FAILED: ${hits.length} hit(s)`);process.exit(1);}
  console.log('denylist check OK'+(plain?' (hashed + local plain list)':' (hashed)'));}
