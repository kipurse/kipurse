#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Rollback helper: turn one wallet's encrypted files back into plaintext (for an older release that cannot read them).
//   KIPURSE_DATA_KEY_FILE=/path/key node scripts/at-rest-decrypt.mjs <wallet> <state.json> [agents.json] [ledger.sqlite(.enc)] [rules dir]
// Never prints contents. Writes <file> in plaintext (mode 0600) and keeps the encrypted copy as <file>.enc.keep.
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {tenantStore,loadDataKey} from '../src/v5/at-rest.mjs';
const [w,...files]=process.argv.slice(2);if(!/^0x[0-9a-fA-F]{40}$/.test(w??''))throw Error('usage: <wallet> <files...>');const S=tenantStore(loadDataKey(process.env.KIPURSE_DATA_KEY_FILE),w);
const isEnc=f=>fs.existsSync(f)&&fs.readFileSync(f).subarray(0,4).toString()==='KPE1';let n=0;
const json=f=>{if(!isEnc(f))return;const o=S.readJson(f);fs.copyFileSync(f,f+'.enc.keep');fs.writeFileSync(f+'.tmp',JSON.stringify(o,null,1),{mode:0o600});fs.renameSync(f+'.tmp',f);n++;};
const lines=f=>{const raw=fs.readFileSync(f,'utf8');if(!raw.includes('E1:'))return;const l=S.readLines(f);fs.copyFileSync(f,f+'.enc.keep');fs.writeFileSync(f,l.join('\n')+'\n',{mode:0o600});n++;};
for(const f0 of files){const f=f0.replace(/\.enc$/,'');
  if(fs.existsSync(f0)&&fs.statSync(f0).isDirectory()){for(const e of fs.readdirSync(f0)){const p=path.join(f0,e);if(!fs.statSync(p).isFile()||/\.(keep|bak)$/.test(e))continue;if(isEnc(p))json(p);else if(/\.jsonl?$/.test(e))lines(p);}continue;}
  if(fs.existsSync(f+'.enc')&&/\.sqlite$/.test(f)){const db=S.openDb(f,{});const img=db.serialize();db.close?.();fs.renameSync(f+'.enc',f+'.enc.keep');fs.writeFileSync(f,Buffer.from(img),{mode:0o600});new DatabaseSync(f).close();n++;continue;}
  json(f);}
console.log(JSON.stringify({decrypted:n}));
