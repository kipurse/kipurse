// SPDX-License-Identifier: Apache-2.0
// Address allowlist (fail closed): every 0x + 40-hex address in the repository must be listed in public-addresses.txt or look
// obviously synthetic (see synthetic() below). An unknown address fails the check, because it might be a real person's wallet.
// To add one: put it in public-addresses.txt under the right heading with a short reason. Never add a real user's wallet.
//   node scripts/check-addresses.mjs            (exit 1 on any unknown address)
import fs from 'node:fs';import path from 'node:path';import {ROOT,CONFIG,listFiles,readText,matchesAny,lineOf} from './guard-files.mjs';
const ADDR=/(?<![0-9A-Za-z_])0x([0-9a-fA-F]{40})(?![0-9A-Za-z_])/g;
export function loadAllowlist(root=ROOT){const set=new Map();const txt=fs.readFileSync(path.join(root,'public-addresses.txt'),'utf8');
  txt.split('\n').forEach((l,i)=>{const s=l.replace(/#.*/,'').trim();if(!s)return;const m=s.match(/^0x([0-9a-fA-F]{40})$/);
    if(!m)throw Error(`public-addresses.txt:${i+1}: not an address: ${s}`);set.set(m[1].toLowerCase(),i+1);});return set;}
/** Obviously made-up test addresses: mostly one digit, long runs, short repeating patterns, counting sequences. */
export function synthetic(hex){const a=hex.toLowerCase();const c={};for(const ch of a)c[ch]=(c[ch]??0)+1;
  if(Math.max(...Object.values(c))>=20)return true;
  if(/(.)\1{7}/.test(a))return true;
  for(let p=1;p<=10;p++){let same=0;for(let i=0;i+p<40;i++)if(a[i]===a[i+p])same++;if(same>=30)return true;}
  if(/0123456789|123456789a|abcdef01|fedcba98|9876543210/.test(a))return true;
  return false;}
export function checkAddresses(root=ROOT){const allow=loadAllowlist(root);const bad=[];const used=new Set();
  for(const f of listFiles(root)){if(f==='public-addresses.txt'||matchesAny(f,CONFIG.addressCheckExempt))continue;const t=readText(f,root);if(t==null)continue;
    for(const m of t.matchAll(ADDR)){const a=m[1].toLowerCase();if(allow.has(a)){used.add(a);continue;}if(synthetic(a))continue;bad.push({file:f,line:lineOf(t,m.index),addr:'0x'+m[1]});}}
  const unused=[...allow.keys()].filter(a=>!used.has(a));return {bad,unused};}
if(import.meta.url===`file://${process.argv[1]}`){const {bad,unused}=checkAddresses();
  for(const b of bad)console.log(`UNKNOWN ADDRESS ${b.file}:${b.line} ${b.addr}`);
  if(unused.length)console.log(`note: ${unused.length} allowlisted address(es) are no longer used (may be removed): `+unused.slice(0,5).map(a=>'0x'+a).join(' ')+(unused.length>5?' ...':''));
  if(bad.length){console.log(`address check FAILED: ${bad.length} unknown address occurrence(s). Use a synthetic address in tests, or list a public contract in public-addresses.txt with a reason.`);process.exit(1);}
  console.log('address check OK');}
