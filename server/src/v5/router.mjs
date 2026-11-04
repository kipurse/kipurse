// SPDX-License-Identifier: AGPL-3.0-only
// MULTI-USER ROUTER (open core). Every public request is pinned to exactly ONE wallet before any handler runs, and a credential
// that belongs to another wallet is refused (resolveTenant). Global, wallet-less endpoints: wallet discovery (/phone/find) and new-user
// setup (/onboard/new). Operator code only passes parameters (rate limits, cache size); it cannot change these rules.
import {randomBytes} from 'node:crypto';import {resolveTenant,sha256} from './tenancy.mjs';import {kvKey} from './store.mjs';
export const FIND_MSG=n=>'Kipurse find wallet v1\nnonce:'+n;
const HEX=/^(0x)?[0-9a-fA-F]{1,64}$/,NONCE=/^[0-9a-f]{48}$/;
/** t796 M2: write limits per client (salted IP hash) + global caps; every counter lives in the KV with a TTL = its window. */
export const WRITE_LIMITS=[
  {name:'signin-start',re:/^\/signin\/start$/,per:6,global:300,windowMs:600e3},
  {name:'signin-step',re:/^\/signin\/(verify|message)$/,per:40,global:3000,windowMs:600e3},
  {name:'session-challenge',re:/\/phone\/session\/challenge$/,per:20,global:2000,windowMs:60e3},
  {name:'owner-anon',re:/\/(owner\/withdraw\/(prepare|quote|plan|confirm|submitted)|phone\/revoke(\/plan|\/confirm)?|owner\/limits\/(prepare|confirm|fee|submitted))$/,per:10,global:600,windowMs:600e3},
  {name:'find',re:/^\/phone\/find(\/challenge)?$/,per:20,global:2000,windowMs:60e3},
  {name:'any-write',re:/./,per:120,global:20000,windowMs:60e3}];
/** t796: IPv6 clients are bucketed by /64 (one subscriber); IPv4 by address. The global cap is the backstop against address rotation. */
export const ipBucket=ip=>{const s=String(ip).toLowerCase().replace(/^::ffff:/,'');if(!s.includes(':'))return s;const [h,t='']=s.split('::');const hg=h?h.split(':'):[],tg=t?t.split(':'):[];const g=[...hg,...Array(Math.max(0,8-hg.length-tg.length)).fill('0'),...tg];return g.slice(0,4).map(x=>x.replace(/^0+(?=.)/,'')).join(':')+'::/64';};
const ipKey=ip=>sha256('kp-rl:'+ipBucket(ip)).slice(0,24);
export function writeLimited(kv,path,ip){for(const L of WRITE_LIMITS){if(!L.re.test(path))continue;const n=kv.incr(kvKey('rl',null,'w:'+L.name+':'+ipKey(ip)),L.windowMs),g=kv.incr(kvKey('rl',null,'w*:'+L.name),L.windowMs);if(n>L.per||g>L.global)return L.name;}return null;}
const bodyOrEmpty=async r=>{let raw;try{raw=await readRaw(r);}catch(e){if(e?.status===413)throw e;return {};}try{return JSON.parse(raw||'{}');}catch{return {};}};
export const readRaw=async(req,max=65536)=>{if(req.__raw!==undefined)return req.__raw;let b='';for await(const c of req){b+=c;if(b.length>max)throw Object.assign(Error('too_large'),{status:413});}req.__raw=b;return b;};
/** Bounded LRU of per-wallet runtimes. load(rec) builds one; close() is called on eviction. Concurrent first loads share one promise. */
export function createTenantCache({reg,load,max=500}){const T=new Map();
  async function get(w){const k=String(w).toLowerCase();let t=T.get(k);if(t){T.delete(k);T.set(k,t);return t;}
    const rec=reg.get(w);if(!rec)return null;t=load(rec);T.set(k,t);try{t=await t;T.set(k,t);}catch(e){T.delete(k);throw e;}
    while(T.size>max){const [ok,ov]=T.entries().next().value;T.delete(ok);try{(await ov).close();}catch{}}return t;}
  return {get,size:()=>T.size,values:()=>T.values(),drop:async w=>{const k=String(w).toLowerCase(),t=T.get(k);T.delete(k);try{(await t)?.close();}catch{}}};}
/** Per-wallet pool of ready MCP servers (one per agent identity). Building the tool set is the expensive part of an MCP request.
 *  A server object is used by ONE request at a time and is bound to one wallet + one agent id, so pooling cannot mix users. */
export function createMcpPool({create,maxIdle=4}){const idle=new Map();let made=0,reused=0;
  return {acquire(agentId){const s=idle.get(agentId)?.pop();if(s){reused++;return s;}made++;return create(agentId);},
    async release(agentId,s){try{await s.close();}catch{return;}const q=idle.get(agentId)??[];if(q.length<maxIdle){q.push(s);idle.set(agentId,q);}},
    stats:()=>({made,reused,idle:[...idle.values()].reduce((a,l)=>a+l.length,0)}),clear:()=>idle.clear()};}
/** The public request handler. deps: reg, index, kv, obs, tenants (createTenantCache), legacy(), env, verifyP256, onboardNew, rl:{ip,tenant}. */
export function createAgentRouter({reg,index,kv,obs,tenants,legacy=()=>null,env={},verifyP256,onboardNew,signin,deposit=null,rl}){
  const j=(res,c,o,h={})=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store',...h});res.end(JSON.stringify(o));};
  return async function route(req,res){let u;try{u=new URL(req.url,'http://x');}catch{return j(res,400,{error:'bad_url'});}
    // RFC 8414 / RFC 9728 path-inserted discovery for per-wallet issuers (Claude, Grok Bot, Muse...):
    // /.well-known/<kind>/t/<wallet>[/mcp] -> /t/<wallet>/.well-known/oauth-*; openid-configuration answers with the OAuth AS metadata.
    {const m=/^\/\.well-known\/(oauth-authorization-server|oauth-protected-resource|openid-configuration)(\/t\/0x[0-9a-fA-F]{40})(\/.*)?$/.exec(u.pathname);

      let kind=null,pre=null;if(m){kind=m[1];pre=m[2];}else{const n=/^(\/t\/0x[0-9a-fA-F]{40})\/\.well-known\/openid-configuration$/.exec(u.pathname);if(n){kind='openid-configuration';pre=n[1];}}
      if(kind&&req.method==='GET'){const k=kind==='openid-configuration'?'oauth-authorization-server':kind;u=new URL(pre+'/.well-known/'+k+u.search,'http://x');req.url=u.pathname+u.search;}}
    const J=(c,o,h)=>j(res,c,o,h);
    if(u.pathname==='/healthz'&&req.method==='GET'&&!req.headers['cf-connecting-ip'])return J(200,{ok:true,tenants:reg.count(),loaded:tenants.size()});
    if(u.pathname==='/metrics'&&req.method==='GET'&&!req.headers['cf-connecting-ip']){res.writeHead(200,{'content-type':'text/plain; version=0.0.4'});return res.end(obs.metrics()+`kipurse_tenants ${reg.count()}\nkipurse_tenants_loaded ${tenants.size()}\n`);}
    if(u.pathname.length>512||String(req.headers.authorization??'').length>4096)return J(414,{error:'too_long'});
    const ip=String(req.headers['cf-connecting-ip']??req.socket?.remoteAddress??'');
    if(rl.ip.hit('ip',ip))return J(429,{error:'rate_limited'},{'retry-after':'30'});
    if(req.method==='POST'){if(Number(req.headers['content-length']??0)>65536)return J(413,{error:'too_large'});
      const local=!req.headers['cf-connecting-ip']&&/^(127\.|::1$|::ffff:127\.)/.test(String(req.socket?.remoteAddress??''));const lim=local?null:writeLimited(kv,u.pathname,ip);   // local ops/tests bypass; public traffic always arrives via the tunnel with cf-connecting-ip
      if(lim){obs?.log?.('write_limited',{name:lim});return J(429,{error:'rate_limited'},{'retry-after':'60'});}}
    try{
      if(u.pathname==='/phone/find/challenge'&&req.method==='POST'){const n=randomBytes(24).toString('hex');kv.put(kvKey('find',null,n),1,120000);return J(200,{nonce:n,message:FIND_MSG(n),digest:'0x'+sha256(FIND_MSG(n))});}
      if(u.pathname==='/phone/find'&&req.method==='POST'){let b;try{b=JSON.parse(await readRaw(req)||'{}');}catch{return J(400,{error:'bad_json'});}
        const n=String(b?.nonce??'');if(!NONCE.test(n)||!['x','y','r','s'].every(k=>HEX.test(String(b[k]??''))))return J(400,{error:'bad_request'});
        if(!kv.take(kvKey('find',null,n)))return J(400,{error:'bad_nonce'});
        let ok=false;try{ok=await verifyP256({x:String(b.x),y:String(b.y)},'0x'+sha256(FIND_MSG(n)),String(b.r),String(b.s));}catch{}if(!ok)return J(401,{error:'bad_signature'});
        const w=index.get('phone',String(b.x));const t=w&&await tenants.get(w);const a=t?.PH.active();
        if(!a||BigInt(a.x)!==BigInt(b.x)||BigInt(a.y)!==BigInt(b.y))return J(404,{error:'no_wallet'});return J(200,{wallet:t.wallet,owner:t.rec.owner,path:t.rec.publicPath??''});}
      if(deposit&&(u.pathname==='/deposit'||u.pathname==='/deposit.js')){if(await deposit.handle(req,res,u))return;}
      if(signin&&(u.pathname==='/signin'||u.pathname==='/signin.js'||u.pathname.startsWith('/signin/'))){if(await signin.handle(req,res,u,{readBody:bodyOrEmpty}))return;}
      if(onboardNew&&u.pathname.startsWith('/onboard/new')){if(await onboardNew.handle(req,res,u,{readBody:bodyOrEmpty}))return;}
      if(onboardNew&&u.pathname==='/onboard/confirm'&&req.method==='POST'){let b={};try{b=JSON.parse(await readRaw(req)||'{}');}catch{}if(onboardNew.has(String(b.id??'')))return J(200,await onboardNew.confirm(String(b.id)));}
      // OAuth token exchange / revoke (RFC 7009) carry no bearer: find the wallet by the (hashed) code / refresh token.
      let hdr=req.headers;if((u.pathname==='/oauth/token'||u.pathname==='/oauth/revoke')&&req.method==='POST'){const raw=await readRaw(req);let o={};try{o=raw.trim().startsWith('{')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw));}catch{}
        const k=u.pathname==='/oauth/revoke'?o?.token:(o?.code??o?.refresh_token);const w=k&&index.get('oauth',sha256(String(k)));if(w&&!/^\/t\//.test(u.pathname))hdr={...req.headers,'x-kipurse-wallet':w};}
      // root /oauth/status|decision?req=… (consent page polls with a root-relative URL): the wallet that holds that pending request
      if(/^\/oauth\/(status|decision|phone-prepare|phone-decide|owner-decide)$/.test(u.pathname)&&!hdr['x-kipurse-wallet']){const q=String(u.searchParams.get('req')??u.searchParams.get('id')??'');const w=q&&index.get('oauth',q);if(w)hdr={...hdr,'x-kipurse-wallet':w};}
      if(u.pathname==='/oauth/authorize'){const rm=/\/t\/(0x[0-9a-fA-F]{40})(\/|$)/.exec(String(u.searchParams.get('resource')??''));
        if(rm){u.searchParams.set('resource',String(u.searchParams.get('resource')).replace(rm[1],rm[1].toLowerCase()));req.url=u.pathname+u.search;}
        const w=rm?rm[1]:index.get('oauth',String(u.searchParams.get('client_id')??''));if(w)hdr={...hdr,'x-kipurse-wallet':w};}
      const r=resolveTenant({url:u,headers:hdr,reg,index,allowSingleDefault:env.KIPURSE_SINGLE_DEFAULT!=='0',defaultWallet:legacy()});
      if(r.error)return J(r.status,{error:r.error});if(rl.tenant.hit('tenant',String(r.wallet).toLowerCase()))return J(429,{error:'rate_limited'},{'retry-after':'30'});
      const t=await tenants.get(r.wallet);if(!t)return J(404,{error:'unknown_wallet'});
      // DCR done on another URL (root /oauth/register lands in the legacy wallet): copy that client registration into this wallet.
      if(/^\/oauth\/authorize$/.test(r.path)&&req.method==='GET'){const cid=String(u.searchParams.get('client_id')??'');const C=t.S?.oauth?.clients;
        if(cid&&C&&!C[cid]){const ow=index.get('oauth',cid);if(ow&&String(ow).toLowerCase()!==String(r.wallet).toLowerCase()){const src=await tenants.get(ow);const c=src?.S?.oauth?.clients?.[cid];
          if(c){C[cid]={...c};try{t.saveState?.();}catch{}try{t.reindex();}catch{}obs?.log?.('oauth_client_adopted',{});}}}}const u2=new URL(r.path+u.search,'http://x');
      if(r.via==='prefix'&&req.method==='GET'&&!/^\/(mcp|v1\/)/.test(r.path))res.setHeader('set-cookie',`kpt=${String(r.wallet).toLowerCase()}; Path=/; Max-Age=3600; SameSite=Lax; Secure; HttpOnly`);
      res.on('finish',()=>{if((/^\/(oauth|phone\/enroll|onboard|\.well-known)/.test(r.path)&&req.method==='POST')||r.path==='/oauth/authorize')try{t.reindex();}catch{}});
      await t.handle(req,res,u2,J);
    }catch(e){obs?.log?.('route_error',{code:e?.status??500});try{if(!res.headersSent)J(e?.status??500,{error:e?.status===413?'too_large':'error'});}catch{}}};}
