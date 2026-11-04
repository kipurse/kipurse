// SPDX-License-Identifier: AGPL-3.0-only
// Observability without PII: JSON log lines with an allow-list of fields (no addresses, tokens, IPs, amounts tied to people),
// counters for /metrics (Prometheus text), and a backpressure gate (max in-flight requests -> 503 + Retry-After).
import {createHash} from 'node:crypto';
const ALLOW=new Set(['event','route','status','ms','part','count','instance','release','reason','kind','inflight']);
export function createObs({instance=process.env.KIPURSE_INSTANCE??'w1',release='',out=s=>process.stdout.write(s+'\n'),maxInflight=Number(process.env.KIPURSE_MAX_INFLIGHT??200)}={}){
  const c=new Map();let inflight=0;
  const inc=(name,labels='')=>{const k=name+(labels?`{${labels}}`:'');c.set(k,(c.get(k)??0)+1);};
  // t784: belt and braces: even an allowed field never carries a raw address/hash-sized hex; it is replaced by a short salted hash.
const scrub=v=>typeof v==='string'?v.replace(/0x[0-9a-fA-F]{40,64}/g,m=>'h:'+createHash('sha256').update('kipurse-log-v1:'+m.toLowerCase()).digest('hex').slice(0,12)):v;
  const log=(event,f={})=>{const o={t:new Date().toISOString(),event:scrub(event),instance};for(const [k,v] of Object.entries(f))if(ALLOW.has(k))o[k]=scrub(v);out(JSON.stringify(o));};
  const route=p=>p.startsWith('/phone/')?'/phone':p.startsWith('/owner/')?'/owner':p.startsWith('/oauth/')||p.startsWith('/.well-known/')?'/oauth':p.startsWith('/v1/')?'/v1':p.startsWith('/user/')?'/user':p.startsWith('/onboard')?'/onboard':p==='/mcp'?'/mcp':'other';
  /** wrap(handler): backpressure + request metrics. */
  const wrap=h=>async(req,res)=>{const r=route(new URL(req.url,'http://x').pathname);
    if(inflight>=maxInflight){inc('kipurse_shed_total');res.writeHead(503,{'content-type':'application/json','retry-after':'2'});res.end('{"error":"busy"}');return;}
    inflight++;const t0=Date.now();res.on('finish',()=>{inflight--;inc('kipurse_http_requests_total',`route="${r}",code="${String(res.statusCode)[0]}xx"`);});
    try{return await h(req,res);}catch(e){log('handler_error',{route:r});throw e;}};
  const metrics=()=>[...c.entries()].map(([k,v])=>`${k} ${v}`).concat([`kipurse_inflight ${inflight}`,`kipurse_up 1`]).join('\n')+'\n';
  return {log,inc,wrap,metrics,inflight:()=>inflight};}
