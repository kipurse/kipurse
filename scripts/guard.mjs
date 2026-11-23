// SPDX-License-Identifier: Apache-2.0
// Runs every repository guard (CI: .github/workflows/guard.yml; locally: scripts/install-pre-push.sh). Exit 1 if any guard fails.
//   node scripts/guard.mjs [--plain <private plain denylist>]     (or KIPURSE_PRIVATE_DENYLIST=<file>)
// gitleaks runs separately (CI step / pre-push hook) because it is not a Node package.
import {checkAddresses} from './check-addresses.mjs';import {scan,loadPlain} from './check-denylist.mjs';import {checkSpdx} from './check-spdx.mjs';import {checkNoPro} from './check-no-pro.mjs';
let fail=0;const say=(ok,name,detail='')=>{console.log(`${ok?'ok  ':'FAIL'} ${name}${detail?' - '+detail:''}`);if(!ok)fail=1;};
const run=(name,fn)=>{try{fn();}catch(e){say(false,name,'error: '+e.message);}};
run('addresses',()=>{const {bad}=checkAddresses();for(const b of bad.slice(0,50))console.log(`  unknown address ${b.file}:${b.line} ${b.addr}`);say(!bad.length,'addresses',bad.length?`${bad.length} unknown (see public-addresses.txt)`:'');});
run('denylist',()=>{const i=process.argv.indexOf('--plain');const pf=i>0?process.argv[i+1]:process.env.KIPURSE_PRIVATE_DENYLIST;const hits=scan({plain:pf?loadPlain(pf):null});
  for(const x of hits.slice(0,50))console.log(`  ${x.file}:${x.line} ${x.what}`);say(!hits.length,'denylist',(pf?'hashed + plain':'hashed')+(hits.length?`, ${hits.length} hit(s)`:''));});
run('spdx',()=>{const {missing,warn}=checkSpdx();for(const f of missing)console.log('  missing header '+f);say(!missing.length,'spdx',`${warn.length} older file(s) on the warn-only baseline`);});
run('no-pro',()=>{const bad=checkNoPro();for(const b of bad)console.log(`  ${b.file}:${b.line} ${b.why}`);say(!bad.length,'no-pro');});
process.exit(fail);
