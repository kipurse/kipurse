// SPDX-License-Identifier: AGPL-3.0-only
// Small in-memory rate limiter for public, unauthenticated read endpoints. Clients are a salted SHA-256 of the IP; raw IPs are never stored.
import {randomBytes,createHash} from 'node:crypto';
const SALT=randomBytes(16);
/** Salted hash of the caller's IP (cloudflared sets cf-connecting-ip). */
export function clientOf(req){const h=req?.headers??{};const ip=String(h['cf-connecting-ip']??String(h['x-forwarded-for']??'').split(',')[0]??'').trim()||req?.socket?.remoteAddress||'';
  return ip?createHash('sha256').update(SALT).update(ip).digest('hex').slice(0,24):null;}
/** limiter({max, windowMs}) -> hit(client) => true when allowed. Unknown clients share one bucket. */
export function limiter({max,windowMs,now=()=>Date.now()}){const m=new Map();
  return client=>{const k=client??'anon',t=now();let b=m.get(k);if(!b||t-b.t>=windowMs){b={t,n:0};m.set(k,b);}
    if(m.size>50000)for(const [kk,v] of m)if(t-v.t>=windowMs)m.delete(kk);
    b.n++;return b.n<=max;};}
/** ttlCache(ms) -> {get(k), set(k,v)} */
export function ttlCache(ms,now=()=>Date.now()){const m=new Map();return {get:k=>{const e=m.get(k);if(!e)return undefined;if(now()-e.t>ms){m.delete(k);return undefined;}return e.v;},
  set:(k,v)=>{if(m.size>20000)m.clear();m.set(k,{t:now(),v});}};}
