// SPDX-License-Identifier: Apache-2.0
// The open-source core never depends on the closed "Pro" add-ons: no import of a pro/ path and no reference to the Pro package
// scope. Pro code lives in a separate private repository that only ADDS code on top of this one.
import {ROOT,listFiles,readText,lineOf} from './guard-files.mjs';
const SCOPE=['@kipurse','pro'].join('-'), NAME=['kipurse','pro'].join('-');   // built from parts so this file does not match itself
const RULES=[
  [new RegExp(SCOPE.replace(/[-@]/g,'\\$&'),'i'),'Pro package scope'],
  [/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"](?:[^'"]*\/)?pro\/[^'"]*['"]/m,'import of a pro/ path'],
  [/(?:^|\n)\s*import\s+KipursePro\b/,'Swift import of the Pro module'],
  [new RegExp('\\.package\\([^)]*'+NAME,'i'),'Swift package dependency on the Pro repository'],
];
export function checkNoPro(root=ROOT){const bad=[];for(const f of listFiles(root)){if(f==='scripts/check-no-pro.mjs')continue;const t=readText(f,root);if(t==null)continue;
    for(const [rx,why] of RULES){const g=new RegExp(rx.source,rx.flags.includes('g')?rx.flags:rx.flags+'g');for(const m of t.matchAll(g))bad.push({file:f,line:lineOf(t,m.index),why});}}
  return bad;}
if(import.meta.url===`file://${process.argv[1]}`){const bad=checkNoPro();for(const b of bad)console.log(`PRO REFERENCE ${b.file}:${b.line} ${b.why}`);
  if(bad.length){console.log('no-Pro check FAILED');process.exit(1);}console.log('no-Pro check OK');}
