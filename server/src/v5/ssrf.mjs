// SPDX-License-Identifier: AGPL-3.0-only
// t796 L3: SSRF guard for every merchant request the gateway makes on an agent's behalf. https only, the host must resolve to PUBLIC
// addresses only (no loopback / private / link-local / CGNAT / multicast / metadata), and redirects are refused (a merchant cannot bounce us inward).
import {lookup} from 'node:dns/promises';import {isIP} from 'node:net';
const v4priv=a=>{const p=a.split('.').map(Number);return p[0]===0||p[0]===10||p[0]===127||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===192&&p[1]===0&&p[2]===0)||(p[0]===198&&(p[1]===18||p[1]===19))||p[0]>=224;};
export function isPrivateIp(ip){const s=String(ip).toLowerCase().replace(/^\[|\]$/g,'');if(isIP(s)===4)return v4priv(s);
  if(isIP(s)===6){const m=/^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);if(m)return v4priv(m[1]);return s==='::'||s==='::1'||/^f[cd]/.test(s)||/^fe[89ab]/.test(s)||/^ff/.test(s)||/^64:ff9b:/.test(s);}return true;}
/** Throws {code:'ssrf_blocked'} unless url is https and every address of its host is public. */
export async function assertPublicUrl(url,{resolve=h=>lookup(h,{all:true,verbatim:true})}={}){let u;try{u=new URL(String(url));}catch{throw Object.assign(Error('bad url'),{code:'ssrf_blocked'});}
  if(u.protocol!=='https:'||u.username||u.password)throw Object.assign(Error('https only'),{code:'ssrf_blocked'});const h=u.hostname.replace(/^\[|\]$/g,'');
  if(/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(h))throw Object.assign(Error('internal host'),{code:'ssrf_blocked'});
  const addrs=isIP(h)?[{address:h}]:await resolve(h).catch(()=>[]);if(!addrs.length||addrs.some(a=>isPrivateIp(a.address)))throw Object.assign(Error('host not public'),{code:'ssrf_blocked'});return u;}
/** fetch wrapper: guard + no redirects. allowLocal: the test-only http://127.0.0.1 merchant (cfg.allowHttpMerchantForTests). */
export function guardFetch(f,{allowLocal=false,resolve}={}){return async(url,opts={})=>{const u=new URL(String(url));
  const local=['127.0.0.1','localhost'].includes(u.hostname)&&allowLocal;if(!local)await assertPublicUrl(u,{resolve});
  return f(u.toString(),{...opts,redirect:'error'});};}
