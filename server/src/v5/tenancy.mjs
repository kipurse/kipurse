// SPDX-License-Identifier: AGPL-3.0-only
// MULTI-USER TENANCY (operator layer seam). One tenant = one Kipurse wallet (key = lowercase wallet address) owned by one Base Account.
// Every request is resolved to exactly ONE tenant before any handler runs; credentials are checked by that tenant's own modules,
// and a credential that belongs to another tenant is refused (cross-tenant guard). Nothing here can move funds.
//  - Registry: wallet -> {owner, paths, publicPath}; owner -> wallets. File now (registry.json), Postgres later (same methods).
//  - Indexes (KV, global, point lookups only): agent token hash, OAuth token/code/client/request key, phone public key -> wallet.
import fs from 'node:fs';import {createHash} from 'node:crypto';import {getAddress} from 'viem';import {kvKey,tenantKey} from './store.mjs';
const ADDR=/^0x[0-9a-fA-F]{40}$/;const sha256=s=>createHash('sha256').update(String(s)).digest('hex');
export function createRegistry({file}){
  let doc=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{v:1,tenants:{},byOwner:{}};
  const write=()=>{const t=file+'.tmp';fs.writeFileSync(t,JSON.stringify(doc,null,1),{mode:0o600});fs.renameSync(t,file);};
  return {get:w=>ADDR.test(String(w))?doc.tenants[tenantKey(w)]??null:null,count:()=>Object.keys(doc.tenants).length,all:()=>Object.values(doc.tenants),
    only:()=>{const k=Object.keys(doc.tenants);return k.length===1?doc.tenants[k[0]]:null;},
    byOwner:o=>{const l=(doc.byOwner[tenantKey(o)]??[]).map(w=>doc.tenants[w]).filter(Boolean);return [...l.filter(r=>!r.retired),...l.filter(r=>r.retired)];},   // t1238 §6#109: a moved-away wallet is retired, the new one comes first
    add(rec){const w=tenantKey(rec.wallet),o=tenantKey(rec.owner);doc.tenants[w]={...doc.tenants[w],...rec,wallet:getAddress(rec.wallet),owner:getAddress(rec.owner)};
      const l=new Set(doc.byOwner[o]??[]);l.add(w);doc.byOwner[o]=[...l];write();return doc.tenants[w];},
    update(w,patch){const r=doc.tenants[tenantKey(w)];if(!r)return null;Object.assign(r,patch);write();return r;},
    /** test / staging only: all records (never used on a request path) */
    _all:()=>Object.values(doc.tenants)};}
/** Index helpers. kind: agent | oauth | phone. */
export function createIndex(kv){const k=(kind,key)=>kvKey('idx',null,kind+':'+String(key).toLowerCase());
  // t1265: ttlMs (optional) = the lifetime of the object the entry points at (OAuth token / code / request), so the index cannot outlive it
  return {set:(kind,key,w,ttlMs)=>kv.put(k(kind,key),tenantKey(w),ttlMs>0?ttlMs:undefined),get:(kind,key)=>kv.get(k(kind,key))??null,del:(kind,key)=>kv.del(k(kind,key)),
    /** t1265: set only when the key is free or already this wallet's (an OAuth client id adopted by another wallet never takes the entry over) */
    claim:(kind,key,w,ttlMs)=>{const cur=kv.get(k(kind,key));if(cur&&cur!==tenantKey(w))return false;kv.put(k(kind,key),tenantKey(w),ttlMs>0?ttlMs:undefined);return true;}};}
/** Pure resolver. Returns {wallet, path, via} or {error, status}. hints: the request's prefix / header / query / cookie; creds: wallet from a bearer credential. */
export function resolveTenant({url,headers,reg,index,allowSingleDefault=true,defaultWallet=null}){
  let path=url.pathname,hint=null,via=null;
  const m=/^\/t\/(0x[0-9a-fA-F]{40})(\/.*)?$/.exec(path);if(m){hint=m[1];path=m[2]??'/';via='prefix';}
  if(!hint&&ADDR.test(String(headers['x-kipurse-wallet']??''))){hint=headers['x-kipurse-wallet'];via='header';}
  if(!hint&&ADDR.test(String(url.searchParams.get('wallet')??''))){hint=url.searchParams.get('wallet');via='query';}
  // credential -> tenant (point lookup). kpa_ = agent bearer token (sha256 like agents.json); anything else = OAuth access token.
  const tok=String(headers.authorization??'').replace(/^Bearer\s+/i,'')||String(headers['x-api-key']??'');let cred=null;
  if(tok&&!tok.startsWith('kps_')){cred=index.get('agent',sha256(tok))??index.get('oauth',sha256(tok));}
  // t1251 (§6#120): a credential of a wallet the owner moved away from (retired) is not honoured: the request is routed as if it had none,
  // so the current wallet answers with its own 401 and the agent re-authorises there (a retired wallet is never served, never builds a runtime).
  if(cred&&reg.get(cred)?.retired)cred=null;
  const ck=/(?:^|;\s*)kpt=(0x[0-9a-fA-F]{40})/.exec(String(headers.cookie??''))?.[1]??null;
  if(!hint&&ck&&!m){hint=ck;via='cookie';}
  // t1251 (§6#120): a wallet named in the URL / header / cookie that the owner moved away from routes to the wallet it moved to (retired wallets
  // are never served); that wallet then checks the credential itself.
  if(hint&&reg.get(hint)?.retired)hint=followMoved(hint,a=>reg.get(a));
  if(hint&&cred&&tenantKey(hint)!==cred)return {error:'wrong_wallet',status:403};
  if(!hint&&cred){hint=cred;via='credential';}

  if(!hint&&allowSingleDefault){const o=reg.only();if(o){hint=o.wallet;via='single';}}
  // unprefixed legacy URL space (links/MCP URL already handed out) belongs to the tenant whose record says publicPath:'' (data, not code)
  if(!hint&&defaultWallet){hint=defaultWallet;via='legacy';}
  if(!hint)return {error:'wallet_required',status:400};
  const rec=reg.get(hint);if(!rec)return {error:'unknown_wallet',status:404};
  return {wallet:rec.wallet,rec,path,via};}
export {sha256};

/** t1251 (handbook §6#120): the wallet a request for `wallet` should reach after owner-signed moves. Follows registry movedTo of retired
 *  records (0x5150 -> V5.4 -> V5.5 ...) up to `max` hops; stops at the first record that is not retired, has no movedTo, is unknown, or
 *  would loop. Returns the input unchanged when there was no move. */
export function followMoved(wallet, get, max = 8) {
  if (!wallet) return wallet;
  let w = wallet; const seen = new Set([String(w).toLowerCase()]);
  for (let i = 0; i < max; i++) {
    const r = get(w); if (!r?.retired || !r.movedTo) return w;
    const n = getAddress(r.movedTo); const k = n.toLowerCase(); if (seen.has(k)) return w;
    seen.add(k); w = n;
  }
  return w;
}
