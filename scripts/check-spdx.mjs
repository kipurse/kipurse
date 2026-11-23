// SPDX-License-Identifier: Apache-2.0
// License headers: every source file needs an "SPDX-License-Identifier:" line in its first 10 lines. Files that predate this check
// are listed in scripts/spdx-baseline.txt and only produce a warning; a NEW file without a header fails. Remove a file from the
// baseline once it has a header. See LICENSING.md for which license a directory uses.
import fs from 'node:fs';import path from 'node:path';import {ROOT,CONFIG,listFiles,readText,matchesAny} from './guard-files.mjs';
export function checkSpdx(root=ROOT){const base=new Set(fs.readFileSync(path.join(root,'scripts/spdx-baseline.txt'),'utf8').split('\n').map(s=>s.replace(/#.*/,'').trim()).filter(Boolean));
  const missing=[],warn=[];
  for(const f of listFiles(root)){if(!CONFIG.spdxExtensions.includes(path.extname(f))||matchesAny(f,CONFIG.spdxExempt))continue;const t=readText(f,root);if(t==null)continue;
    if(/SPDX-License-Identifier:\s*\S+/.test(t.split('\n').slice(0,10).join('\n')))continue;(base.has(f)?warn:missing).push(f);}
  return {missing,warn};}
if(import.meta.url===`file://${process.argv[1]}`){const {missing,warn}=checkSpdx();
  if(warn.length)console.log(`warning: ${warn.length} older file(s) without an SPDX header (scripts/spdx-baseline.txt)`);
  for(const f of missing)console.log('MISSING SPDX HEADER '+f);
  if(missing.length){console.log('SPDX check FAILED: add e.g. "// SPDX-License-Identifier: Apache-2.0" (or AGPL-3.0-only under server/, see LICENSING.md)');process.exit(1);}
  console.log('SPDX check OK');}
