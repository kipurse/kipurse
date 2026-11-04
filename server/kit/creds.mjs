// SPDX-License-Identifier: AGPL-3.0-only
// Zero-config credential pickup: MCP clients put an API key in many different places. We accept every plausible one so an
// ordinary user (or the AI client acting for them) never has to answer "which header?". Each candidate is checked against the
// hashed agent keys / OAuth access tokens; a wrong value is simply ignored (401 if nothing matches).
export const QUERY_KEYS=['key','api_key','apikey','api-key','token','access_token','auth','kipurse_key'];
const SKIP=new Set(['host','content-type','content-length','accept','accept-encoding','accept-language','user-agent','connection','origin','referer','cookie','mcp-session-id','mcp-protocol-version','last-event-id','cache-control','pragma','x-forwarded-for','x-forwarded-proto','x-real-ip']);
/** Ordered, de-duplicated candidate secrets from a request. pathToken = the segment after /mcp/ (key-in-path). */
export function credentialCandidates(headers,url,pathToken=''){
  const out=[];const add=v=>{v=String(v??'').trim().replace(/^["']|["']$/g,'');if(v&&v.length>=8&&v.length<=512&&!/\s/.test(v)&&!out.includes(v))out.push(v);};
  if(pathToken)add(decodeURIComponent(pathToken.split('/')[0]));
  const auth=headers.authorization;
  if(auth){const m=/^\s*(Bearer|Token|Api-Key|ApiKey|Key|Basic)?\s*(\S+)\s*$/i.exec(auth);
    if(m){if(m[1]&&/^basic$/i.test(m[1])){try{const d=Buffer.from(m[2],'base64').toString('utf8');const i=d.indexOf(':');if(i>=0){add(d.slice(i+1));add(d.slice(0,i));}else add(d);}catch{}}
      else add(m[2]);}}
  for(const h of ['x-api-key','api-key','apikey','kipurse-api-key','x-kipurse-key','x-auth-token','x-access-token','x-mcp-key','x-mcp-token'])if(headers[h])add(headers[h]);
  for(const [h,v] of Object.entries(headers))if(!SKIP.has(h)&&/(key|token|secret|auth)/i.test(h))add(Array.isArray(v)?v[0]:v);
  if(url)for(const q of QUERY_KEYS){const v=url.searchParams.get(q);if(v)add(v);}
  return out;}
/** URL safe for logs: query credentials removed. */
export const redactUrl=u=>{const x=new URL(u);for(const q of QUERY_KEYS)if(x.searchParams.has(q))x.searchParams.set(q,'***');return x.pathname+(x.search||'');};
