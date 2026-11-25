// SPDX-License-Identifier: AGPL-3.0-only
// Observability without PII: JSON log lines with an allow-list of fields (no addresses, tokens, IPs, amounts tied to people),
// counters for /metrics (Prometheus text), and a backpressure gate (max in-flight requests -> 503 + Retry-After).
import {createHash} from 'node:crypto';
const ALLOW=new Set(['event','route','status','ms','part','count','instance','release','reason','kind','inflight',
  /* t1208 decision 94: push results (counts, production|sandbox, APNs HTTP status + reason word) - never a device token */'sent','failed','removed','env','apnsStatus','apnsReason','enabled']);
export function createObs({instance=process.env.KIPURSE_INSTANCE??'w1',release='',out=s=>process.stdout.write(s+'\n'),maxInflight=Number(process.env.KIPURSE_MAX_INFLIGHT??200)}={}){
  const c=new Map();let inflight=0;
  const inc=(name,labels='')=>{const k=name+(labels?`{${labels}}`:'');c.set(k,(c.get(k)??0)+1);};
  // t784: belt and braces: even an allowed field never carries a raw address/hash-sized hex; it is replaced by a short salted hash.
const scrub=v=>typeof v==='string'?v.replace(/0x[0-9a-fA-F]{40,64}/g,m=>'h:'+createHash('sha256').update('kipurse-log-v1:'+m.toLowerCase()).digest('hex').slice(0,12)):v;
  const log=(event,f={})=>{const o={t:new Date().toISOString(),event:scrub(event),instance};for(const [k,v] of Object.entries(f))if(ALLOW.has(k))o[k]=scrub(v);out(JSON.stringify(o));};
  const route=p=>p.startsWith('/phone/')?'/phone':p.startsWith('/owner/')?'/owner':p.startsWith('/oauth/')||p.startsWith('/.well-known/')?'/oauth':p.startsWith('/v1/')?'/v1':p.startsWith('/user/')?'/user':p.startsWith('/onboard')?'/onboard':p==='/mcp'?'/mcp':'other';
  /** wrap(handler): backpressure + request metrics. */
  const wrap=h=>async(req,res)=>{let r='other';try{r=route(new URL(req.url,'http://x').pathname);}catch{}   /* t1280 Q1 (decision 140): a malformed URL (e.g. '//') threw here, outside any try -> unhandled rejection -> process exit */
    if(inflight>=maxInflight){inc('kipurse_shed_total');res.writeHead(503,{'content-type':'application/json','retry-after':'2'});res.end('{"error":"busy"}');return;}
    /* t1278 S1: decrement exactly once, on 'close' (fires for finished AND aborted requests; 'finish' never fires on an abort, which leaked the
       counter until every request got 503); request metrics stay on 'finish' */
    /* t1279 R7 (decision 139): ...and only once the handler has ALSO settled: an abort must not free the slot while the work still runs */
    inflight++;let done=false,closed=false,settled=false;const dec=()=>{if(done||!closed||!settled)return;done=true;inflight--;};res.on('close',()=>{closed=true;dec();});
    res.on('finish',()=>{inc('kipurse_http_requests_total',`route="${r}",code="${String(res.statusCode)[0]}xx"`);});
    try{return await h(req,res);}catch(e){log('handler_error',{route:r});   /* t1280 Q1: answer 500 instead of re-throwing (a re-throw is an unhandled rejection that stops the whole gateway) */
      try{if(!res.headersSent){res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"internal_error"}');}else if(!res.writableEnded)res.destroy();}catch{}}finally{settled=true;dec();}};
  const metrics=()=>[...c.entries()].map(([k,v])=>`${k} ${v}`).concat([`kipurse_inflight ${inflight}`,`kipurse_up 1`]).join('\n')+'\n';
  return {log,inc,wrap,metrics,inflight:()=>inflight};}
/** t1278 S1: slow-client limits for a public http server (time to receive the whole request / its headers; responses are not limited).
 *  Node's defaults are 300 s / 60 s; a slowloris client holds a socket (and an inflight slot) far less long with these. */
export const SERVER_TIMEOUTS={requestTimeoutMs:30_000,headersTimeoutMs:20_000,keepAliveTimeoutMs:5_000};
export function applyServerTimeouts(srv,t=SERVER_TIMEOUTS){srv.requestTimeout=t.requestTimeoutMs;srv.headersTimeout=t.headersTimeoutMs;srv.keepAliveTimeout=t.keepAliveTimeoutMs;return srv;}
