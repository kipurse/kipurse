// SPDX-License-Identifier: AGPL-3.0-only
// User data at rest: the kit state (agents, OAuth clients/tokens, sessions, setup answers, rescue data) is stored ONLY as
// AES-256-GCM ciphertext (state.enc) in the user data dir. The key lives in a separate 0600 file OUTSIDE the data dir and
// OUTSIDE the code tree (default ~/.config/kipurse/kit-data.key, or KIPURSE_KEY_FILE). Account deletion rotates the key
// (crypto-shredding: any copy/backup of the old ciphertext becomes unreadable).
import fs from 'node:fs';import {dirname,join,resolve,relative,isAbsolute} from 'node:path';import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';import {homedir} from 'node:os';
export const CODE_ROOT=resolve(dirname(new URL(import.meta.url).pathname),'..');
export const inside=(child,parent)=>{const r=relative(resolve(parent),resolve(child));return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
/** Structural boundary: user data never inside the code tree (open-source part) and the key never inside the data dir. */
export function assertBoundary(dataDir,keyFile,codeRoot=CODE_ROOT){
  if(inside(dataDir,codeRoot))throw Error(`BOUNDARY: the user data dir ${dataDir} is inside the code tree ${codeRoot}. Use a dir outside it (default ~/.kipurse-kit).`);
  if(inside(keyFile,codeRoot))throw Error('BOUNDARY: the data key file is inside the code tree');
  if(inside(keyFile,dataDir))throw Error('BOUNDARY: the data key file must not live inside the data dir');}
export const defaultKeyFile=()=>process.env.KIPURSE_KEY_FILE||join(homedir(),'.config','kipurse','kit-data.key');
export function openVault(dir,keyFile=defaultKeyFile()){
  fs.mkdirSync(dirname(keyFile),{recursive:true,mode:0o700});
  const loadKey=()=>{if(!fs.existsSync(keyFile))fs.writeFileSync(keyFile,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});const k=Buffer.from(fs.readFileSync(keyFile,'utf8').trim(),'hex');if(k.length!==32)throw Error('bad data key');return k;};
  let key=loadKey();const ENC=join(dir,'state.enc'),PLAIN=join(dir,'state.json');
  const seal=obj=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from('kipurse-kit-state-v1'));const ct=Buffer.concat([c.update(JSON.stringify(obj)),c.final()]);return Buffer.concat([Buffer.from('KPV1'),iv,c.getAuthTag(),ct]);};
  const open=buf=>{if(buf.subarray(0,4).toString()!=='KPV1')throw Error('not a Kipurse vault file');const d=createDecipheriv('aes-256-gcm',key,buf.subarray(4,16));d.setAAD(Buffer.from('kipurse-kit-state-v1'));d.setAuthTag(buf.subarray(16,32));return JSON.parse(Buffer.concat([d.update(buf.subarray(32)),d.final()]).toString());};
  return {
    load(){if(fs.existsSync(ENC))return open(fs.readFileSync(ENC));
      if(fs.existsSync(PLAIN)){const s=JSON.parse(fs.readFileSync(PLAIN,'utf8'));this.save(s);fs.rmSync(PLAIN);return s;}// one-time migration from plaintext
      return null;},
    save(obj){const t=ENC+'.tmp';fs.writeFileSync(t,seal(obj),{mode:0o600});fs.renameSync(t,ENC);},
    /** crypto-shred: new key; the caller then saves the fresh state with it */
    rotate(){fs.rmSync(keyFile,{force:true});key=loadKey();},
    keyFile,file:ENC};}
