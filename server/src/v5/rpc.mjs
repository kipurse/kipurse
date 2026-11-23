// SPDX-License-Identifier: AGPL-3.0-only
// RPC provider list with fallback + a small read cache. Config: an array, or a comma-separated string (KIPURSE_RPC_URLS).
import {http,fallback} from 'viem';
export function rpcUrls(v){return (Array.isArray(v)?v:String(v??'').split(',')).map(s=>String(s).trim()).filter(Boolean);}
export function rpcTransport(v,{timeout=60000,retryCount=3}={}){const u=rpcUrls(v);if(!u.length)throw Error('no RPC URL configured');
  return u.length===1?http(u[0],{timeout,retryCount}):fallback(u.map(x=>http(x,{timeout,retryCount:1})),{rank:false,retryCount});}
/** TTL cache for chain reads that are safe to be a few seconds stale (balances for display, block time). Never for signing decisions. */
export function createReadCache({ttlMs=5000,max=10000,now=()=>Date.now()}={}){const m=new Map();
  return async(key,fn)=>{const h=m.get(key);if(h&&h.exp>now())return h.v;const v=await fn();if(m.size>=max)m.delete(m.keys().next().value);m.set(key,{v,exp:now()+ttlMs});return v;};}
