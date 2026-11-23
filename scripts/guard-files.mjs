// SPDX-License-Identifier: Apache-2.0
// Shared helpers for the repository guards (scripts/guard.mjs). Node built-ins only, so the guards run before `npm ci`.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
export const ROOT=path.resolve(process.env.GUARD_ROOT??path.join(path.dirname(new URL(import.meta.url).pathname),'..'));
export const CONFIG=JSON.parse(fs.readFileSync(path.join(ROOT,'scripts/guard.config.json'),'utf8'));
const skip=rel=>CONFIG.skipDirs.some(d=>rel===d||rel.startsWith(d+'/')||rel.split('/').includes(d)&&!d.includes('/'));
const BIN=new Set(['.png','.jpg','.jpeg','.gif','.ico','.pdf','.woff','.woff2','.ttf','.otf','.car','.zip','.gz','.tgz','.mp4','.mov']);
/** Every file the guards look at: tracked + untracked-not-ignored when this is a git checkout, else a directory walk. */
export function listFiles(root=ROOT){let files;
  try{files=execFileSync('git',['-C',root,'ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:1<<28}).split('\0').filter(Boolean);}
  catch{files=[];const walk=d=>{for(const e of fs.readdirSync(path.join(root,d),{withFileTypes:true})){const r=d?d+'/'+e.name:e.name;if(skip(r))continue;
      if(e.isDirectory())walk(r);else if(e.isFile())files.push(r);}};walk('');}
  return files.filter(f=>!skip(f)&&fs.existsSync(path.join(root,f))&&fs.lstatSync(path.join(root,f)).isFile()).sort();}
/** UTF-8 text of a file, or null for binaries (by extension or a NUL byte). */
export function readText(rel,root=ROOT){if(BIN.has(path.extname(rel).toLowerCase()))return null;const b=fs.readFileSync(path.join(root,rel));
  if(b.includes(0))return null;return b.toString('utf8');}
export const matchesAny=(rel,list)=>list.some(rx=>new RegExp(rx).test(rel));
export function lineOf(text,idx){let n=1;for(let i=0;i<idx;i++)if(text.charCodeAt(i)===10)n++;return n;}
