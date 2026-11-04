// SPDX-License-Identifier: AGPL-3.0-only
// Generic merchant discovery for USDC deposit orders, from PUBLIC merchant docs only (llms.txt -> capabilities JSON -> openapi.json).
// No merchant-specific constants: create/status endpoints, auth placement, chain, token, payable statuses, TTL, amount cap and the
// optional signed-order offer are read from the merchant's own descriptions. The pay-to address, amount and expiry are taken ONLY
// from each order's API response and are re-checked here (same origin, chain, token contract, exact atomic amount, short expiry).
import {getAddress,isAddress} from 'viem';
const lc=s=>String(s??'').toLowerCase();
const ORDER_FIELDS=['depositAddress','amountAtomic','expiresAt'];
export class DiscoveryError extends Error{constructor(code,detail){super(code+(detail?': '+detail:''));this.code=code;this.detail=detail;}}
function originOf(o,{allowHttp=false}={}){let u;try{u=new URL(String(o));}catch{throw new DiscoveryError('bad_merchant_origin');}
  const local=['127.0.0.1','localhost'].includes(u.hostname);if(u.protocol!=='https:'&&!(allowHttp&&local))throw new DiscoveryError('merchant_origin_not_https');return u.origin;}
const sameOrigin=(origin,ref)=>{try{const u=new URL(ref,origin);return u.origin===origin?u.pathname:null;}catch{return null;}};
async function get(f,url,kind,timeoutMs){const r=await f(url,{headers:{accept:kind==='json'?'application/json':'text/plain'},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
  if(!r.ok)throw new DiscoveryError('doc_unavailable',`${new URL(url).pathname} HTTP ${r.status}`);return kind==='json'?r.json():r.text();}
const fieldName=s=>String(s).trim().split(/[\s(]/)[0];
const deref=(oa,s)=>{let x=s,i=0;while(x?.$ref&&i++<10)x=x.$ref.replace(/^#\//,'').split('/').reduce((a,k)=>a?.[k],oa);return x;};
const hasOrderFields=a=>ORDER_FIELDS.every(k=>a.includes(k));
/** capabilities: any section with method POST + path + response listing depositAddress/amountAtomic/expiresAt (+ statusEndpoint). */
function fromCapabilities(cap,{chainId}){const out=[];
  for(const [key,s] of Object.entries(cap??{})){if(!s||typeof s!=='object'||Array.isArray(s))continue;
    if(String(s.method).toUpperCase()!=='POST'||typeof s.path!=='string'||!Array.isArray(s.response)||!hasOrderFields(s.response.map(fieldName)))continue;
    if(s.status&&lc(s.status)!=='live')continue;if(s.chainId!==undefined&&Number(s.chainId)!==chainId)continue;
    const required=(s.request?.required??[]).map(fieldName),optional=(s.request?.optional??[]).map(fieldName);
    const bodyAuth=/in the json body/i.test(String(s.auth))?required.find(k=>lc(String(s.auth)).startsWith(lc(k)))??required.find(k=>/token/i.test(k)):null;
    const st=s.statusEndpoint??{};
    out.push({section:key,dtoVersion:s.dtoVersion??null,create:{method:'POST',path:s.path,contentType:s.contentType??'application/json',required,optional,bodyAuth,idempotencyField:required.find(k=>/idempot/i.test(String(s.request?.required?.find(x=>fieldName(x)===k))))??null},
      status:st.path?{method:String(st.method??'GET').toUpperCase(),path:st.path,bearer:/bearer/i.test(String(st.auth)),pollIntervalSeconds:Number(st.pollIntervalSeconds??10)}:null,
      chainId:s.chainId!==undefined?Number(s.chainId):null,tokenContract:s.tokenContract??null,token:s.token??null,decimals:s.decimals??null,amountRule:s.amountRule??null,
      ttlMax:Number(s.orderTtlSecondsMax??1800),maxAmountAtomic:s.maxAmountCents!=null?BigInt(s.maxAmountCents)*10000n:null,
      statuses:st.statuses??s.statuses??null,terminalStatuses:s.terminalStatuses??null,
      signedOrder:s.signedOrder?{available:!!s.signedOrder.available,optIn:optional.includes('signedOrder')?'signedOrder':null,verifyingContract:s.signedOrder.verifyingContract??null,
        domainVersion:s.signedOrder.paymentOrderDomainVersion??null,payer:s.signedOrder.paymentOrderPayer??null,type:s.signedOrder.paymentOrder??null,
        v51:(s.kipurseV51??s.signedOrder.kipurseV51)?.available?{via:(s.kipurseV51??s.signedOrder.kipurseV51).via??null,dtoVersion:(s.kipurseV51??s.signedOrder.kipurseV51).dtoVersion??null,chains:((s.kipurseV51??s.signedOrder.kipurseV51).chains??[]).map(c=>({chainId:Number(c.chainId),verifier:getAddress(lc(c.verifier))}))}:null}:null});}
  return out;}
/** openapi: POST path whose 200/201 JSON schema requires the order fields; GET <path>/{id} as status. Also cross-checks capabilities. */
function fromOpenapi(oa){const out=[];for(const [path,item] of Object.entries(oa?.paths??{})){const op=item?.post;if(!op)continue;
  const sch=deref(oa,(op.responses?.['200']??op.responses?.['201'])?.content?.['application/json']?.schema);if(!sch?.properties||!ORDER_FIELDS.every(k=>sch.properties[k]))continue;
  const statusPath=Object.keys(oa.paths).find(p=>p.startsWith(path+'/{')&&oa.paths[p].get);
  const st=sch.properties.status;const payable=(st?.enum??[]).filter(v=>new RegExp(`'${v}'\\s*=\\s*pay now`,'i').test(String(st?.description??'')));
  out.push({path,statusPath:statusPath??null,schema:sch,payable,chainIds:sch.properties.chainId?.enum??null,expiresAtType:sch.properties.expiresAt?.type??null});}
  return out;}
/** Discover how to buy from `origin` using public docs only. fetch is injectable (recorded fixtures in tests). */
export async function discoverMerchant(origin0,{fetch:f=globalThis.fetch,chainId=8453,usdc,allowHttp=false,timeoutMs=15000}={}){
  const origin=originOf(origin0,{allowHttp});const sources={};let llms='';
  try{llms=await get(f,origin+'/llms.txt','text',timeoutMs);sources.llms=origin+'/llms.txt';}catch{}
  const links=[...String(llms).matchAll(/\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g)].map(m=>m[1]??m[2]);
  const pick=(re,dflt)=>{for(const l of links){const p=sameOrigin(origin,l);if(p&&re.test(p))return p;}return dflt;};
  // no merchant-specific defaults: capabilities is found via llms.txt links or an openapi GET path; openapi via llms.txt or the conventional /openapi.json
  const oaPath=pick(/openapi(\.json)?$/i,'/openapi.json');let cap=null,oa=null;
  try{oa=await get(f,origin+oaPath,'json',timeoutMs);sources.openapi=origin+oaPath;}catch{}
  const capPath=pick(/capabilit/i,null)??Object.keys(oa?.paths??{}).find(p=>/capabilit/i.test(p)&&oa.paths[p].get&&!p.includes('{'));
  if(capPath){try{cap=await get(f,origin+capPath,'json',timeoutMs);sources.capabilities=origin+capPath;}catch{}}
  if(!cap&&!oa)throw new DiscoveryError('no_merchant_docs','neither capabilities nor openapi.json readable');
  const C=fromCapabilities(cap,{chainId}),O=fromOpenapi(oa);let d=null;
  for(const c of C){const o=O.find(x=>x.path===c.create.path);if(oa&&!o)continue;d={...c,openapi:o??null};break;}  // capabilities + openapi must agree when both exist
  if(!d&&O.length){const o=O[0];d={section:null,create:{method:'POST',path:o.path,contentType:'application/json',required:o.schema?.required??[],optional:[],bodyAuth:null},status:o.statusPath?{method:'GET',path:o.statusPath,bearer:true,pollIntervalSeconds:10}:null,
    chainId:null,tokenContract:null,ttlMax:1800,maxAmountAtomic:null,statuses:null,terminalStatuses:null,signedOrder:null,openapi:o};}
  if(!d)throw new DiscoveryError('no_usdc_order_api','merchant docs describe no USDC deposit-order endpoint');
  for(const p of [d.create.path,d.status?.path].filter(Boolean))if(!p.startsWith('/')||p.includes('//'))throw new DiscoveryError('cross_origin_endpoint',p);
  if(d.tokenContract&&usdc&&lc(d.tokenContract)!==lc(usdc))throw new DiscoveryError('unsupported_asset',d.tokenContract);
  if(d.openapi?.chainIds&&!d.openapi.chainIds.includes(chainId))throw new DiscoveryError('unsupported_network');
  const payable=d.openapi?.payable?.length?d.openapi.payable:(d.statuses?[d.statuses[0]]:['open']);
  return {origin,host:new URL(origin).hostname,sources,...d,payableStatuses:payable,openapi:d.openapi?{path:d.openapi.path,statusPath:d.openapi.statusPath,expiresAtType:d.openapi.expiresAtType}:null,discoveredAt:Math.floor(Date.now()/1000)};}
const toUnix=v=>{if(typeof v==='number'&&Number.isFinite(v))return v>1e12?Math.floor(v/1000):Math.floor(v);const s=String(v??'');if(/^\d+$/.test(s))return toUnix(Number(s));const t=Date.parse(s);return Number.isFinite(t)?Math.floor(t/1000):undefined;};
/** Turn ONE order API response into a payment, or refuse. Nothing here trusts a pre-shared address. */
export function orderToPayment(order,d,{chainId=8453,usdc,nowS=Math.floor(Date.now()/1000),minRemaining=60}={}){
  const rej=(code,detail)=>({ok:false,code,detail});if(!order||typeof order!=='object')return rej('bad_order_response');
  if(!d.payableStatuses.includes(String(order.status)))return rej('order_not_payable',String(order.status));
  if(order.chainId!==undefined&&Number(order.chainId)!==chainId)return rej('unsupported_network',String(order.chainId));
  const tc=order.tokenContract??d.tokenContract;if(!tc||!usdc||lc(tc)!==lc(usdc))return rej('unsupported_asset',String(tc));
  if(!isAddress(String(order.depositAddress),{strict:false})||/^0x0{40}$/i.test(String(order.depositAddress)))return rej('bad_payee');
  const a=String(order.amountAtomic??'');if(!/^[1-9][0-9]{0,30}$/.test(a))return rej('bad_amount');const amt=BigInt(a);
  if(order.amountUsdc!==undefined){const m=/^(\d+)(?:\.(\d{1,6}))?$/.exec(String(order.amountUsdc));if(!m||BigInt(m[1])*1000000n+BigInt((m[2]??'').padEnd(6,'0')||'0')!==amt)return rej('amount_inconsistent','amountUsdc != amountAtomic');}
  if(order.amountCents!==undefined&&BigInt(order.amountCents)*10000n!==amt)return rej('amount_inconsistent','amountCents != amountAtomic');
  if(d.maxAmountAtomic!=null&&amt>d.maxAmountAtomic)return rej('amount_above_merchant_cap');
  const exp=toUnix(order.expiresAt);if(exp===undefined)return rej('bad_expiry');if(exp<nowS+minRemaining)return rej('order_expired_or_too_close');
  if(exp>nowS+d.ttlMax+120)return rej('expiry_beyond_merchant_ttl');
  let statusUrl=null;if(order.statusUrl!==undefined){const p=sameOrigin(d.origin,order.statusUrl);if(!p)return rej('cross_origin_status_url');statusUrl=d.origin+p;}
  const ref=order.paymentIntentId??order.purchaseId??order.orderId??order.id;if(ref==null||!String(ref).trim())return rej('order_ref_missing');
  return {ok:true,payment:{to:getAddress(lc(order.depositAddress)),amountAtomic:a,chainId,tokenContract:getAddress(lc(tc)),expiresAt:exp,id:String(ref)},merchant:d.host,statusUrl,
    purchaseId:order.purchaseId??null,signedOrderOffered:!!(d.signedOrder?.available&&order.signedOrder&&order.signedOrder.available!==false)};}
/** Build (not send) the create-order request. The credential is placed where the docs say; callers redact it from any output. */
export function buildCreateOrder(d,params,{credential,purchaseId,signedOrder=false}={}){
  const body={...params};if(d.create.idempotencyField&&body[d.create.idempotencyField]===undefined){if(!purchaseId)throw new DiscoveryError('idempotency_key_required',d.create.idempotencyField);body[d.create.idempotencyField]=purchaseId;}
  const headers={'content-type':d.create.contentType,accept:'application/json'};
  if(d.create.bodyAuth){if(!credential)throw new DiscoveryError('merchant_credential_unavailable');body[d.create.bodyAuth]=credential;}else if(credential)headers.authorization='Bearer '+credential;
  if(signedOrder&&d.signedOrder?.optIn)body[d.signedOrder.optIn]=true;
  const missing=d.create.required.filter(k=>body[k]===undefined);if(missing.length)throw new DiscoveryError('missing_order_fields',missing.join(','));
  return {url:d.origin+d.create.path,init:{method:'POST',headers,body:JSON.stringify(body),redirect:'error'}};}
/** V5.1 signed-order URL for one order: only for a (chainId, verifier) pair the merchant publicly allow-lists; payer = our wallet. */
export function buildSignedOrderRequest(d,order,{payer,chainId,verifier,credential}){const v=d.signedOrder?.v51;if(!v)throw new DiscoveryError('signed_order_v51_not_offered');
  if(!v.chains.some(c=>c.chainId===Number(chainId)&&lc(c.verifier)===lc(verifier)))throw new DiscoveryError('verifier_not_allowlisted',`${chainId}/${verifier}`);
  const raw=order?.[v.via??'signedOrderUrl'];if(!raw)throw new DiscoveryError('no_signed_order_url');const p=sameOrigin(d.origin,raw);if(!p)throw new DiscoveryError('cross_origin_signed_order_url');
  const u=new URL(raw,d.origin);if(!isAddress(String(payer),{strict:false})||/^0x0{40}$/i.test(String(payer)))throw new DiscoveryError('bad_payer');
  u.searchParams.set('signedOrder','1');u.searchParams.set('payer',getAddress(lc(payer)));u.searchParams.set('chainId',String(chainId));u.searchParams.set('verifier',getAddress(lc(verifier)));
  return {url:u.toString(),init:{method:'GET',headers:{accept:'application/json',...(credential?{authorization:'Bearer '+credential}:{})},redirect:'error'}};}
export function buildStatusRequest(d,id,{credential}={}){if(!d.status)throw new DiscoveryError('no_status_endpoint');const path=d.status.path.replace(/\{[^}]+\}/,encodeURIComponent(String(id)));
  return {url:d.origin+path,init:{method:'GET',headers:{accept:'application/json',...(d.status.bearer&&credential?{authorization:'Bearer '+credential}:{})},redirect:'error'}};}
