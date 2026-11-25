// SPDX-License-Identifier: AGPL-3.0-only
// Wallet-side ATTESTOR (V5.1, no contract change): the owner trusts a merchant DOMAIN whose only order signer is OUR attestor key
// (anyPayee, per-merchant caps). The gateway reads the order over https from that exact domain (public discovery), checks it, and
// the attestor signs PaymentOrder(payee=depositAddress, amount, orderId=keccak256(domain:orderRef), deadline=expiresAt, payer=wallet).
// The merchant does nothing special. Risk is bounded by the merchant caps; the owner revokes the key instantly (deny signer / untrust).
import fs from 'node:fs';import {keccak256,toBytes,getAddress} from 'viem';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
export const attestorOrderId=(domain,ref)=>keccak256(toBytes(`${String(domain).trim().toLowerCase()}:${String(ref).trim()}`));
/** Create (once) or load the attestor key file (0600). Returns {address, sign} - never the key. */
export function loadOrCreateAttestor(file){
  if(!fs.existsSync(file)){fs.writeFileSync(file,JSON.stringify({kind:'kipurse-attestor',createdAt:new Date().toISOString(),privateKey:generatePrivateKey()}),{mode:0o600,flag:'wx'});}
  if((fs.statSync(file).mode&0o077)!==0)throw Error('attestor key file must be 0600');
  const acct=privateKeyToAccount(JSON.parse(fs.readFileSync(file,'utf8')).privateKey);
  return {address:acct.address,signTypedData:a=>acct.signTypedData(a)};}
/** Sign a checked order (output of discovery.orderToPayment) as a kipurse.signed-order.v2 object. */
export async function attestOrder(att,{payment,merchant},{payer,chainId,verifier,types,domain}){
  if(Number(payment.chainId)!==Number(chainId))throw Error('ATTEST: chain mismatch');
  const o={payee:getAddress(payment.to),amount:BigInt(payment.amountAtomic),orderId:attestorOrderId(merchant,payment.id),deadline:BigInt(payment.expiresAt),payer:getAddress(payer)};
  const signature=await att.signTypedData({domain:domain({chainId,verifier}),types,primaryType:'PaymentOrder',message:o});
  return {version:'kipurse.signed-order.v2',payee:o.payee,amount:o.amount.toString(),orderId:o.orderId,deadline:o.deadline.toString(),payer:o.payer,chainId:Number(chainId),verifier:getAddress(verifier),
    signer:att.address,signature,merchant:{id:merchant,ref:String(payment.id)},expiresAt:Number(payment.expiresAt)};}
/** One key per merchant domain: <dir>/attestor-<domain>.json. A shared key would let any site spend under another merchant's caps. */
export function attestorsFor(dir,domains){const o={};for(const d of domains){const k=String(d).trim().toLowerCase();if(!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(k))throw Error('bad domain '+d);
  o[k]=loadOrCreateAttestor(`${dir}/attestor-${k}.json`);}return o;}

/* ===================================================================================================================================
 * t1241 (decision 111 (5), layered merchant trust): the per-domain ATTESTOR ("[zh]") for the V5.4 signed route.
 * Runs as its OWN service (mainnet/attestor-server.mjs, own system user, keys only it can read); tests / fork run it in-process with the
 * same API. The owner's Face ID trust names <domain> + attestor.address(<domain>) as that merchant's ONE order signer (V5.4 grant).
 * The gateway can NOT pay a merchant order on that route unless this service agrees (2-of-2):
 *   - the domain is not paused here (paused after a payment the merchant did not confirm),
 *   - chain / V5.4 adapter are the configured ones, payer = a real wallet, amount within the hard ceiling, per-domain rate limit,
 *   - it INDEPENDENTLY re-reads the order from the merchant (GET the order status URL on https://<domain> itself, through the SSRF
 *     guard): same deposit address, same exact atomic amount, payable status, not expired, same expiry (± 5 s) and order reference,
 *   - it independently reads the merchant's public docs on that origin: if the merchant publishes an order signer, the order MUST carry
 *     a valid signature from that signer over the same payee / amount (any declared EIP-712 form, merchant-sig.mjs),
 * then signs the V5.4 EIP-712 PaymentOrder (domain AgentWalletPaymentOrder / 5 / chainId / V5.4 adapter) with
 *   orderId = keccak256(domain + ':' + merchant order ref), deadline = min(order expiry, now + 15 min), payer = the wallet.
 * One key per domain: a key can only ever spend under the caps the owner gave THAT domain on chain.
 * =================================================================================================================================== */
import {join as joinPath} from 'node:path';import {encryptedStore,plainStore} from './at-rest.mjs';import {guardFetch} from './ssrf.mjs';
import {verifyMerchantSignature} from './merchant-sig.mjs';import {discoverMerchant} from './discovery.mjs';import {isAddress} from 'viem';
export const ATTEST_MAX_TTL_SEC=900;
const ATT_TYPES={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},{name:'adapter',type:'address'},{name:'payer',type:'address'}]};
export const attestDomain54=({chainId,adapter})=>({name:'AgentWalletPaymentOrder',version:'5',chainId:Number(chainId),verifyingContract:getAddress(adapter)});
const PAYABLE=/^(open|requires_payment|awaiting_payment|unpaid|pending_payment|created)$/i;
const ZERO_A='0x0000000000000000000000000000000000000000';
const lcA=s=>String(s??'').toLowerCase();
const toUnixA=v=>{if(typeof v==='number'&&Number.isFinite(v))return v>1e12?Math.floor(v/1000):Math.floor(v);const s=String(v??'');if(/^\d+$/.test(s))return toUnixA(Number(s));const t=Date.parse(s);return Number.isFinite(t)?Math.floor(t/1000):undefined;};
/** a plain lowercase host name ("shop.example"); IP literals only for local tests */
export function validDomain(d,{allowLocal=false}={}){const s=String(d??'');if(s!==s.toLowerCase()||s.length<3||s.length>80)return false;
  if(allowLocal&&/^(127\.0\.0\.1|localhost)$/.test(s))return true;return /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*\.[a-z]{2,63}$/.test(s);}
export class AttestError extends Error{constructor(code,detail){super(code+(detail?': '+detail:''));this.code=code;this.detail=detail;}}
/**
 * opts: keyDir (0700, one encrypted file per domain), dataKey (32-byte at-rest key; required unless allowPlain), chainId, adapters (V5.4
 * adapter addresses it may sign for), fetch, resolveHost (tests), allowHttpLocal (tests: http://127.0.0.1 merchant), now (unix s),
 * maxAmountAtomic (hard ceiling per order, default 1000 USDC), maxPerHour (attests per domain), maxKeys, usdc, log.
 */
export function createAttestor({keyDir,dataKey=null,allowPlain=false,chainId,adapters=[],fetch:f0=globalThis.fetch,resolveHost,allowHttpLocal=false,
  now=()=>Math.floor(Date.now()/1000),maxAmountAtomic=1_000_000_000n,maxPerHour=60,maxKeys=5000,usdc=null,log=()=>{},timeoutMs=10000}={}){
  if(!keyDir)throw Error('ATTESTOR: keyDir required');if(!dataKey&&!allowPlain)throw Error('ATTESTOR: a data key is required (keys are encrypted at rest)');
  fs.mkdirSync(keyDir,{recursive:true,mode:0o700});if((fs.statSync(keyDir).mode&0o077)!==0)throw Error('ATTESTOR: key dir must be 0700');
  const ST=dataKey?encryptedStore(dataKey):plainStore;const AD=new Set(adapters.map(a=>lcA(getAddress(a))));
  const F=guardFetch(f0,{allowLocal:allowHttpLocal,resolve:resolveHost});
  const keyFile=d=>joinPath(keyDir,'attestor54-'+d+'.json'),pauseFile=joinPath(keyDir,'paused.json');
  const accts=new Map();const recent=new Map();const docs=new Map();
  function acct(domain,{create=true}={}){const d=String(domain);if(!validDomain(d,{allowLocal:allowHttpLocal}))throw new AttestError('bad_domain');
    if(accts.has(d))return accts.get(d);const file=keyFile(d);
    if(!fs.existsSync(file)){if(!create)return null;if(fs.readdirSync(keyDir).filter(x=>x.startsWith('attestor54-')).length>=maxKeys)throw new AttestError('too_many_domains');
      ST.writeJson(file,{kind:'kipurse-attestor-v54',domain:d,createdAt:new Date().toISOString(),privateKey:generatePrivateKey()});log('attestor_key_created',{domain:d});}
    if((fs.statSync(file).mode&0o077)!==0)throw new AttestError('key_file_mode','must be 0600');
    const k=ST.readJson(file,null);if(!k||k.domain!==d)throw new AttestError('key_file_bad');const a=privateKeyToAccount(k.privateKey);accts.set(d,a);return a;}
  const pausedAll=()=>ST.readJson(pauseFile,{})??{};
  const paused=d=>pausedAll()[String(d)]??null;
  function pause(domain,reason){const d=String(domain);if(!validDomain(d,{allowLocal:allowHttpLocal}))throw new AttestError('bad_domain');const p=pausedAll();
    if(!p[d]){p[d]={reason:String(reason??'paused').slice(0,80),at:now()};ST.writeJson(pauseFile,p);log('attestor_domain_paused',{domain:d,reason:p[d].reason});}return {ok:true,domain:d,paused:p[d]};}
  function resume(domain){const d=String(domain);const p=pausedAll();if(p[d]){delete p[d];ST.writeJson(pauseFile,p);log('attestor_domain_resumed',{domain:d});}return {ok:true,domain:d,paused:null};}
  async function merchantDocs(origin){const c=docs.get(origin);if(c&&c.t>Date.now()-10*60e3)return c.d;
    const d=await discoverMerchant(origin,{fetch:F,chainId:Number(chainId),usdc,allowHttp:allowHttpLocal,timeoutMs});docs.set(origin,{t:Date.now(),d});return d;}
  /** request: {domain, ref, purchaseId?, statusUrl, payee, amountAtomic, expiresAt, payer, chainId, adapter, credential?, merchantSignedOrder?} */
  async function attest(q){const fail=(code,detail)=>{log('attestor_refused',{domain:String(q?.domain??'').slice(0,80),code});return {ok:false,code,...(detail?{detail:String(detail).slice(0,160)}:{})};};
    try{const d=String(q?.domain??'');if(!validDomain(d,{allowLocal:allowHttpLocal}))return fail('bad_domain');
      {const p=paused(d);if(p)return fail('domain_paused',p.reason);}
      if(Number(q.chainId)!==Number(chainId))return fail('wrong_chain');
      if(!isAddress(String(q.adapter??''),{strict:false})||!AD.has(lcA(q.adapter)))return fail('adapter_not_allowed');
      for(const k of ['payee','payer'])if(!isAddress(String(q[k]??''),{strict:false})||lcA(q[k])===ZERO_A)return fail('bad_'+k);
      const amt=String(q.amountAtomic??'');if(!/^[1-9][0-9]{0,30}$/.test(amt))return fail('bad_amount');if(BigInt(amt)>BigInt(maxAmountAtomic))return fail('over_attestor_ceiling');
      const ref=String(q.ref??'').trim();if(!ref||ref.length>200)return fail('bad_ref');
      let su;try{su=new URL(String(q.statusUrl??''));}catch{return fail('status_url_required');}
      const local=allowHttpLocal&&['127.0.0.1','localhost'].includes(su.hostname);
      if(su.hostname.toLowerCase()!==d||su.username||su.password||(su.protocol!=='https:'&&!(local&&su.protocol==='http:'))||(!local&&su.port&&su.port!=='443'))return fail('status_url_not_merchant');
      {const t=now();const l=(recent.get(d)??[]).filter(x=>t-x<3600);if(l.length>=maxPerHour){recent.set(d,l);return fail('rate_limited');}l.push(t);recent.set(d,l);}
      // 1) independent re-read of the order on the merchant's own origin
      let body;try{const r=await F(su.toString(),{headers:{accept:'application/json',...(q.credential?{authorization:'Bearer '+String(q.credential)}:{})},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
        if(!r.ok)return fail('merchant_status_http_'+r.status);body=await r.json();}catch(e){return fail('merchant_status_unreachable');}
      const o=body?.order??body?.data??body;if(!o||typeof o!=='object')return fail('merchant_status_bad');
      const dep=o.depositAddress??o.payTo??o.payee??o.to;if(!isAddress(String(dep??''),{strict:false})||lcA(dep)!==lcA(q.payee))return fail('deposit_address_mismatch');
      if(String(o.amountAtomic??'')!==amt)return fail('amount_mismatch');
      const st=String(o.status??o.state??'');if(!PAYABLE.test(st))return fail('order_not_payable',st);
      const exp=toUnixA(o.expiresAt);const nowS=now();if(exp===undefined)return fail('expiry_missing');if(exp<=nowS+60)return fail('order_expired');
      if(q.expiresAt!=null&&Math.abs(Number(q.expiresAt)-exp)>5)return fail('expiry_mismatch');
      const refs=[o.paymentIntentId,o.purchaseId,o.orderId,o.id].filter(x=>x!=null).map(String);
      if(refs.length&&!refs.includes(ref)&&!(q.purchaseId!=null&&refs.includes(String(q.purchaseId))))return fail('order_ref_mismatch');
      // 2) independent evidence: the merchant's published signer (its own docs on its own origin) -> a valid signature is required
      let docsD;try{docsD=await merchantDocs(su.origin);}catch(e){return fail('merchant_docs_unavailable');}
      let merchantSigned=false;
      if(docsD.expectedSigner){const routes=docsD.routes??[docsD];const decl=routes.map(x=>x.signedOrder).find(Boolean)??null;
        const v=await verifyMerchantSignature({so:q.merchantSignedOrder,expectedSigner:docsD.expectedSigner,payee:q.payee,amountAtomic:amt,chainId,declared:decl,nowS,wallet:q.payer});
        if(!v.ok)return fail(v.code);merchantSigned=true;}
      // 3) sign the V5.4 order for exactly this payee / amount / wallet
      const a=acct(d);const deadline=BigInt(Math.min(exp,nowS+ATTEST_MAX_TTL_SEC));const orderId=attestorOrderId(d,ref);
      const message={payee:getAddress(lcA(q.payee)),amount:BigInt(amt),orderId,deadline,chainId:BigInt(chainId),adapter:getAddress(lcA(q.adapter)),payer:getAddress(lcA(q.payer))};
      const signature=await a.signTypedData({domain:attestDomain54({chainId,adapter:message.adapter}),types:ATT_TYPES,primaryType:'PaymentOrder',message});
      log('attestor_signed',{domain:d,merchantSigned});
      return {ok:true,merchantSigned,signedOrder:{version:'kipurse.signed-order.v1',payee:message.payee,amount:amt,orderId,deadline:Number(deadline),chainId:Number(chainId),adapter:message.adapter,
        signer:a.address,signature,payer:message.payer,merchant:{id:d,ref}}};
    }catch(e){return fail(e?.code??'attest_failed');}}
  return {address:async domain=>acct(domain).address,attest,pause:async(d,r)=>pause(d,r),resume:async d=>resume(d),paused:async d=>paused(d),
    list:async()=>({paused:pausedAll()})};}
