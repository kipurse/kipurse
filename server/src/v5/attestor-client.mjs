// SPDX-License-Identifier: AGPL-3.0-only
// t1241 (decision 111 (5)): the gateway's client for the separate attestor service (mainnet/attestor-server.mjs). Same API as the in-process
// createAttestor(): address(domain), attest(request), pause(domain, reason), resume(domain), paused(domain). Unix socket (default) or a
// 127.0.0.1 URL. The gateway never holds an attestor key: without the service's signature the V5.4 signed route cannot pay.
import http from 'node:http';
export function createAttestorClient({socketPath,url,timeoutMs=20000}={}){
  if(!socketPath&&!url)throw Error('ATTESTOR_CLIENT: socketPath or url required');
  const u=url?new URL(url):null;if(u&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('ATTESTOR_CLIENT: loopback only');
  const call=(path,body)=>new Promise((resolve)=>{const data=JSON.stringify(body??{});
    const req=http.request({...(socketPath?{socketPath}:{host:u.hostname.replace(/^\[|\]$/g,''),port:u.port}),path,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)},timeout:timeoutMs},res=>{let raw='';res.setEncoding('utf8');
      res.on('data',c=>{raw+=c;if(raw.length>1e6)req.destroy();});res.on('end',()=>{try{resolve(JSON.parse(raw));}catch{resolve({ok:false,code:'attestor_bad_response'});}});});
    req.on('timeout',()=>req.destroy(Object.assign(Error('timeout'),{code:'attestor_timeout'})));req.on('error',e=>resolve({ok:false,code:e?.code==='attestor_timeout'?'attestor_timeout':'attestor_unavailable'}));req.end(data);});
  const cache=new Map();
  return {
    async address(domain){const d=String(domain);if(cache.has(d))return cache.get(d);const r=await call('/address',{domain:d});if(!r?.ok||!/^0x[0-9a-fA-F]{40}$/.test(String(r.address??'')))throw Object.assign(Error('attestor address unavailable'),{code:r?.code??'attestor_unavailable'});cache.set(d,r.address);return r.address;},
    attest:q=>call('/attest',q),
    pause:(domain,reason)=>call('/pause',{domain,reason}),
    resume:domain=>call('/resume',{domain}),
    async paused(domain){const r=await call('/paused',{domain});return r?.paused??null;},
    list:()=>call('/list',{})};}
