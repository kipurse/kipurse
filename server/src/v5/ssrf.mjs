// SPDX-License-Identifier: AGPL-3.0-only
// t796 L3: SSRF guard for every merchant request the gateway makes on an agent's behalf. https only, the host must resolve to PUBLIC
// addresses only (no loopback / private / link-local / CGNAT / multicast / metadata), and redirects are refused (a merchant cannot bounce us inward).
// t1275: IPv6 is expanded to 8 groups first; v4-mapped / v4-compatible / SIIT / NAT64 / 6to4 / Teredo carry an IPv4 that is checked as IPv4; only
// 2000::/3 can be public; anything unparsable is private. The host is resolved ONCE and the real connection is pinned to the vetted address
// (https.request lookup override; SNI + certificate are still checked against the original hostname), so DNS rebinding cannot swap it.
import {lookup} from 'node:dns/promises';import {isIP} from 'node:net';import https from 'node:https';import http from 'node:http';import zlib from 'node:zlib';import {Readable} from 'node:stream';
const v4priv=a=>{const p=a.split('.').map(Number);return p[0]===0||p[0]===10||p[0]===127||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===192&&p[1]===0&&(p[2]===0||p[2]===2))||(p[0]===198&&(p[1]===18||p[1]===19))||(p[0]===198&&p[1]===51&&p[2]===100)||(p[0]===203&&p[1]===0&&p[2]===113)||p[0]>=224;};
/* t1275: '1:2::a.b.c.d' -> [8 x uint16] or null */
export function expand6(s){s=String(s).toLowerCase().replace(/^\[|\]$/g,'').replace(/%.*$/,'');const m=/^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if(m){if(isIP(m[2])!==4)return null;const q=m[2].split('.').map(Number);s=m[1]+((q[0]<<8)|q[1]).toString(16)+':'+((q[2]<<8)|q[3]).toString(16);}
  if(!/^[0-9a-f:]+$/.test(s)||(s.match(/::/g)??[]).length>1)return null;const [a,b]=s.includes('::')?s.split('::'):[s,null];
  const hs=x=>x===''?[]:x.split(':');const L=hs(a),R=b===null?[]:hs(b);if(b===null&&L.length!==8)return null;if(b!==null&&L.length+R.length>7)return null;
  const g=[...L,...Array(8-L.length-R.length).fill('0'),...R];if(g.some(x=>!/^[0-9a-f]{1,4}$/.test(x)))return null;return g.map(x=>parseInt(x,16));}
const v4of=(hi,lo)=>[hi>>8,hi&255,lo>>8,lo&255].join('.');
export function isPrivateIp(ip){const s=String(ip).toLowerCase().replace(/^\[|\]$/g,'');if(isIP(s)===4)return v4priv(s);
  const g=expand6(s);if(!g)return true;/* t1275: unparsable = private */const z=n=>g.slice(0,n).every(x=>x===0);
  if(z(5)&&g[5]===0xffff)return v4priv(v4of(g[6],g[7]));/* ::ffff:a.b.c.d mapped */
  if(z(4)&&g[4]===0xffff&&g[5]===0)return v4priv(v4of(g[6],g[7]));/* ::ffff:0:a.b.c.d SIIT */
  if(z(6))return true;/* ::, ::1, ::a.b.c.d (deprecated v4-compatible, never routable) */
  if(g[0]===0x64&&g[1]===0xff9b){if(g.slice(2,6).every(x=>x===0))return v4priv(v4of(g[6],g[7]));return true;}/* NAT64 well-known; 64:ff9b:1::/48 local-use */
  if(g[0]===0x2002)return v4priv(v4of(g[1],g[2]));/* 6to4 */
  if(g[0]===0x2001&&g[1]===0)return v4priv(v4of(g[2],g[3]))||v4priv(v4of(g[6]^0xffff,g[7]^0xffff));/* Teredo: server + obfuscated client */
  if((g[0]&0xe000)!==0x2000)return true;/* only 2000::/3 is global unicast (fc00::/7, fe80::/10, ff00::/8, 100::/64 ... all private) */
  if(g[0]===0x2001&&(g[1]===0xdb8||(g[1]&0xfff0)===0x10||(g[1]&0xfff0)===0x20||g[1]<0x200))return true;/* doc, ORCHID, IETF-special 2001::/23 */
  return false;}
const bad=m=>Object.assign(Error(m),{code:'ssrf_blocked'});
/* t1275: resolve once, every address must be public; returns the vetted addresses (with family) to pin the connection to */
export async function vetUrl(url,{resolve=h=>lookup(h,{all:true,verbatim:true})}={}){let u;try{u=new URL(String(url));}catch{throw bad('bad url');}
  if(u.protocol!=='https:'||u.username||u.password)throw bad('https only');const h=u.hostname.replace(/^\[|\]$/g,'');
  if(/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(h))throw bad('internal host');
  const addrs=isIP(h)?[{address:h}]:await Promise.resolve().then(()=>resolve(h)).catch(()=>[]);if(!Array.isArray(addrs)||!addrs.length||addrs.some(a=>isPrivateIp(a?.address)))throw bad('host not public');
  return {u,addrs:addrs.map(a=>({address:String(a.address).replace(/^\[|\]$/g,''),family:isIP(String(a.address).replace(/^\[|\]$/g,''))}))};}
/** Throws {code:'ssrf_blocked'} unless url is https and every address of its host is public. */
export async function assertPublicUrl(url,opts={}){return (await vetUrl(url,opts)).u;}
/* t1275: fetch-compatible request whose TCP connection goes ONLY to `pin` ({address,family}); TLS servername / cert check stay on u.hostname. */
const NULL_BODY=new Set([101,103,204,205,304]);
export function pinnedFetch(pin){return (url,opts={})=>new Promise((ok,fail)=>{const u=new URL(String(url));const mod=u.protocol==='https:'?https:u.protocol==='http:'?http:null;if(!mod)return fail(new TypeError('unsupported protocol'));
  const hdr={};const h0=opts.headers;if(h0&&typeof h0.forEach==='function'&&!Array.isArray(h0))h0.forEach((v,k)=>{hdr[k]=v;});else if(Array.isArray(h0))for(const [k,v] of h0)hdr[k]=v;else Object.assign(hdr,h0??{});
  for(const k of Object.keys(hdr))if(/^(accept-encoding|host|connection|transfer-encoding|keep-alive|upgrade)$/i.test(k))delete hdr[k];hdr['accept-encoding']='gzip, deflate, br';
  let body=opts.body;if(body!=null&&!(typeof body==='string'||body instanceof Uint8Array))body=String(body);if(body!=null)hdr['content-length']=Buffer.byteLength(body);
  const host=u.hostname.replace(/^\[|\]$/g,'');const lk=(_h,o,cb)=>{if(typeof o==='function')cb=o;if(o?.all)cb(null,[{address:pin.address,family:pin.family}]);else cb(null,pin.address,pin.family);};
  const req=mod.request({protocol:u.protocol,hostname:host,port:u.port||undefined,path:u.pathname+u.search,method:String(opts.method??'GET').toUpperCase(),headers:hdr,lookup:lk,agent:false,
    ...(u.protocol==='https:'&&!isIP(host)?{servername:host}:{}),signal:opts.signal},res=>{const st=res.statusCode;
    if(st>=300&&st<400&&res.headers.location&&opts.redirect!=='manual'){res.resume();return fail(new TypeError('fetch failed: redirect refused'));}
    const H=new Headers();for(let i=0;i<res.rawHeaders.length;i+=2){try{H.append(res.rawHeaders[i],res.rawHeaders[i+1]);}catch{}}
    const enc=String(res.headers['content-encoding']??'').toLowerCase().trim();let s=res;const dz=enc==='gzip'||enc==='x-gzip'?zlib.createGunzip():enc==='deflate'?zlib.createInflate():enc==='br'?zlib.createBrotliDecompress():null;
    if(dz){s=res.pipe(dz);res.on('error',e=>dz.destroy(e));H.delete('content-encoding');H.delete('content-length');}
    const nb=NULL_BODY.has(st)||String(opts.method??'GET').toUpperCase()==='HEAD';if(nb)res.resume();
    try{ok(new Response(nb?null:Readable.toWeb(s),{status:st<200||st>599?502:st,statusText:res.statusMessage??'',headers:H}));}catch(e){fail(e);}});
  req.on('error',fail);if(body!=null)req.write(body);req.end();});}
const NATIVE_FETCH=globalThis.fetch;
/** fetch wrapper: guard + no redirects. allowLocal: the test-only http://127.0.0.1 merchant (cfg.allowHttpMerchantForTests).
 *  t1275: with the platform fetch (production), the request is sent by pinnedFetch to the address just vetted (pin overrides for tests). */
export function guardFetch(f,{allowLocal=false,resolve,pin}={}){const pinOn=pin??(f===NATIVE_FETCH?pinnedFetch:null);return async(url,opts={})=>{const u=new URL(String(url));
  const local=['127.0.0.1','localhost'].includes(u.hostname)&&allowLocal;if(local)return f(u.toString(),{...opts,redirect:'error'});
  const v=await vetUrl(u,{resolve});if(pinOn)return pinOn(v.addrs[0])(v.u.toString(),{...opts,redirect:'error'});
  return f(v.u.toString(),{...opts,redirect:'error'});};}
