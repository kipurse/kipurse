// SPDX-License-Identifier: AGPL-3.0-only
// Encryption at rest for the payment ledger (SQLite) and the owner-rules files (owner guard, trust list, audit logs).
// AES-256-GCM, subkeys derived (HKDF) from one 32-byte data key that lives OUTSIDE the data dir and the code tree.
// Without a key (plainStore) behaviour is byte-for-byte the old plaintext format, so library users and old tests are unchanged.
// Migration is automatic and one-way: a plaintext file found on open is re-written encrypted, after an ENCRYPTED backup copy
// (<file>.pre-encrypt.bak) is made; the plaintext (and SQLite -wal/-shm) is then removed.
import fs from 'node:fs';import {randomBytes,createCipheriv,createDecipheriv,hkdfSync} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
const MAGIC=Buffer.from('KPE1');
function aead(key){
  const seal=(buf,aad)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(aad));const ct=Buffer.concat([c.update(buf),c.final()]);return Buffer.concat([MAGIC,iv,c.getAuthTag(),ct]);};
  const open=(buf,aad)=>{if(!buf.subarray(0,4).equals(MAGIC))throw Error('not an encrypted Kipurse file');const d=createDecipheriv('aes-256-gcm',key,buf.subarray(4,16));d.setAAD(Buffer.from(aad));d.setAuthTag(buf.subarray(16,32));return Buffer.concat([d.update(buf.subarray(32)),d.final()]);};
  return {seal,open};}
const isEnc=buf=>buf.length>=32&&buf.subarray(0,4).equals(MAGIC);
const atomic=(file,data)=>{const t=file+'.tmp';fs.writeFileSync(t,data,{mode:0o600});fs.renameSync(t,file);};
export const plainStore={encrypted:false,
  readJson:(f,def)=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):def,
  writeJson:(f,o)=>atomic(f,JSON.stringify(o,null,1)),
  readLines:f=>fs.existsSync(f)?fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean):[],
  appendLine:(f,l)=>fs.appendFileSync(f,l+'\n',{mode:0o600}),
  openDb:(f,opts)=>new DatabaseSync(f,opts)};
/** key: 32-byte Buffer (or hex). Returns a store with the same interface as plainStore. */
export function encryptedStore(key){
  key=Buffer.isBuffer(key)?key:Buffer.from(String(key).trim(),'hex');if(key.length!==32)throw Error('at-rest key must be 32 bytes');
  const sub=label=>Buffer.from(hkdfSync('sha256',key,Buffer.alloc(0),'kipurse-at-rest-'+label,32));
  const J=aead(sub('json')),L=aead(sub('line')),D=aead(sub('db'));
  const backup=(f,enc)=>{const b=f+'.pre-encrypt.bak';if(!fs.existsSync(b))atomic(b,enc);};
  const readJson=(f,def)=>{if(!fs.existsSync(f))return def;const buf=fs.readFileSync(f);
    if(isEnc(buf))return JSON.parse(J.open(buf,'json:'+f.split('/').pop()).toString());
    const o=JSON.parse(buf.toString('utf8'));const enc=J.seal(Buffer.from(JSON.stringify(o)),'json:'+f.split('/').pop());backup(f,enc);atomic(f,enc);return o;};// migrate
  const writeJson=(f,o)=>atomic(f,J.seal(Buffer.from(JSON.stringify(o)),'json:'+f.split('/').pop()));
  const encLine=l=>'E1:'+L.seal(Buffer.from(l),'line').toString('base64');
  const decLine=l=>l.startsWith('E1:')?L.open(Buffer.from(l.slice(3),'base64'),'line').toString():l;
  const readLines=f=>{if(!fs.existsSync(f))return [];const raw=fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean);
    if(raw.some(l=>!l.startsWith('E1:'))){const enc=raw.map(l=>l.startsWith('E1:')?l:encLine(l)).join('\n')+'\n';backup(f,enc);atomic(f,enc);}// migrate, chain hashes unchanged
    return raw.map(decLine);};
  const appendLine=(f,l)=>fs.appendFileSync(f,encLine(l)+'\n',{mode:0o600});
  /** SQLite kept in memory; every committed write is serialized, encrypted and atomically renamed into place (fsync'd). */
  const unwal=img=>{img=Buffer.from(img);if(img.length>19){img[18]=1;img[19]=1;}return img;};// in-memory DBs cannot use WAL: rewrite the header to rollback-journal mode
  const openDb=(f,opts)=>{const enc=f+'.enc';const db=new DatabaseSync(':memory:',opts);
    if(fs.existsSync(enc))db.deserialize(unwal(D.open(fs.readFileSync(enc),'db')));
    else if(fs.existsSync(f)){const src=new DatabaseSync(f);try{src.exec('PRAGMA wal_checkpoint(TRUNCATE)');}catch{}const img=unwal(src.serialize());src.close();db.deserialize(img);
      const e=D.seal(Buffer.from(img),'db');backup(f,e);atomic(enc,e);for(const x of [f,f+'-wal',f+'-shm'])fs.rmSync(x,{force:true});}
    const persist=()=>{if(db.isTransaction)return;const e=D.seal(Buffer.from(db.serialize()),'db');const t=enc+'.tmp';const fd=fs.openSync(t,'w',0o600);fs.writeSync(fd,e);fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(t,enc);};
    const exec=db.exec.bind(db),prepare=db.prepare.bind(db);
    db.exec=sql=>{const r=exec(sql.replace(/PRAGMA\s+journal_mode\s*=\s*WAL\s*;?/ig,''));persist();return r;};
    db.prepare=sql=>{const st=prepare(sql);if(/^\s*(select|pragma|with\s[\s\S]*select)/i.test(sql))return st;const run=st.run.bind(st);st.run=(...a)=>{const r=run(...a);persist();return r;};return st;};
    db.__encryptedFile=enc;return db;};
  return {encrypted:true,readJson,writeJson,readLines,appendLine,openDb};}
/** Per-user encryption at rest: each wallet gets its own AES key, derived (HKDF) from the operator's data key and the wallet address.
 *  The data key lives OUTSIDE the code tree and the data dir (KIPURSE_DATA_KEY_FILE), readable only by the service user. */
export function tenantStore(dataKey,wallet){const k=Buffer.isBuffer(dataKey)?dataKey:Buffer.from(String(dataKey).trim(),'hex');if(k.length!==32)throw Error('data key must be 32 bytes');
  return encryptedStore(Buffer.from(hkdfSync('sha256',k,Buffer.from(String(wallet).toLowerCase()),'kipurse-tenant-v1',32)));}
export function loadDataKey(file){if(!file)return null;const st=fs.statSync(file);if(st.mode&0o077)throw Error('data key file must be mode 0400/0600 (no group/other access)');
  const k=Buffer.from(fs.readFileSync(file,'utf8').trim(),'hex');if(k.length!==32)throw Error('data key must be 64 hex chars');return k;}
