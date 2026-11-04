// Merchant payment-standard detector registry (V4). FIXED order; the first detector that claims the input wins;
// nothing claims it -> reject. Payee and amount come ONLY from protocol data, never from agent free text.
import {getAddress,isAddress,keccak256,toBytes} from 'viem';

export const USDC={8453:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',84532:'0x036CbD53842c5426634e7929541eC2318f3dCF7e'};
export const DETECTOR_ORDER=['x402-v2','x402-v1','mpp','l402','eip681','direct','signed-order','coinbase-business','stripe-pi'];
const reject=(code,detail)=>({ok:false,code,detail});
/** Expiry as unix seconds from unix seconds / ms (number or digit string) or an ISO-8601 string. null = absent, undefined = unparseable. */
export const toUnixSeconds=v=>{if(v===undefined||v===null||v==='')return null;if(typeof v==='number'||/^[0-9]+$/.test(String(v))){const n=Number(v);if(!Number.isSafeInteger(n))return undefined;return n>1e12?Math.floor(n/1000):n;}
  const t=Date.parse(String(v));return Number.isFinite(t)?Math.floor(t/1000):undefined;};
/** V5.1 ExampleShop orderId = keccak256(utf8(paymentIntentId)); V3-V5 used keccak256(utf8("stripe:" + pi)). Never mixed. */
export const orderIdV51=pi=>keccak256(toBytes(String(pi)));export const orderIdLegacyStripe=pi=>keccak256(toBytes('stripe:'+String(pi)));
const lc=s=>String(s??'').toLowerCase();
const header=(h,name)=>{if(!h)return undefined;if(typeof h.get==='function')return h.get(name)??undefined;const k=Object.keys(h).find(k=>lc(k)===lc(name));return k===undefined?undefined:h[k];};
const b64json=s=>{try{return JSON.parse(Buffer.from(String(s),'base64').toString('utf8'));}catch{return undefined;}};
const atomic=v=>{const s=String(v??'');if(!/^[0-9]{1,30}$/.test(s))return undefined;const n=BigInt(s);return n>0n?n:undefined;};
const caip=n=>{const m=/^eip155:([0-9]+)$/.exec(String(n??''));return m?Number(m[1]):undefined;};
const V1NET={'base':8453,'base-sepolia':84532};

/** Validate one x402 "exact" EVM requirement; returns a normalized request or a reject reason. */
function exactEvm(req,chainId,amount,version,resource,allowedChains){
  if(req?.scheme!=='exact')return reject('unsupported_scheme',req?.scheme);
  if(!allowedChains.includes(chainId))return reject('unsupported_network',String(chainId));
  if(!isAddress(String(req.asset??''),{strict:false})||lc(req.asset)!==lc(USDC[chainId]))return reject('unsupported_asset',req.asset);
  if(!isAddress(String(req.payTo??''),{strict:false}))return reject('bad_payee');
  const method=req.extra?.assetTransferMethod??'eip3009';if(method!=='eip3009')return reject('unsupported_transfer_method',method);
  if(amount===undefined)return reject('bad_amount');
  const timeout=Number(req.maxTimeoutSeconds??60);if(!Number.isInteger(timeout)||timeout<10||timeout>3600)return reject('bad_timeout');
  return {ok:true,standard:version===2?'x402-v2':'x402-v1',mode:'eip3009',chainId,token:getAddress(USDC[chainId]),payee:getAddress(lc(req.payTo)),amount,
    resource:resource??null,maxTimeoutSeconds:timeout,raw:req,eip712:{name:req.extra?.name,version:req.extra?.version}};
}
const pickFirst=(accepts,fn)=>{const errs=[];for(const a of accepts??[]){const r=fn(a);if(r.ok)return r;errs.push(r.code);}return reject('no_acceptable_requirement',errs.join(','));};

function signedV2(s,o){const exampleshop=s.dtoVersion==='exampleshop.usdc-deposit-order.v2';
  const f={payee:s.payee,amount:exampleshop?s.amountAtomic:s.amount,orderId:s.orderId,deadline:exampleshop?s.orderDeadline:s.deadline,payer:s.payer??ZERO_ADDR,chainId:s.chainId,verifier:s.verifier,
    signer:s.signer,signature:s.signature,merchantId:exampleshop?'exampleshop.example':s.merchant?.id,merchantRef:exampleshop?(s.paymentIntentId??s.purchaseId):s.merchant?.ref};
  const chainId=Number(f.chainId);if(!o.chains.includes(chainId))return reject('unsupported_network',String(f.chainId));
  if(s.testnetOnly===true&&[1,8453,10,42161,137].includes(chainId))return reject('testnet_only_order','testnetOnly order must never be paid on mainnet');
  if(exampleshop){if(!['open','awaiting_payment'].includes(String(s.status)))return reject('order_not_payable',String(s.status));
    if(s.token===undefined&&s.tokenContract===undefined)return reject('unsupported_asset','token missing');
    if(atomic(s.amountAtomic)===undefined||!Number.isSafeInteger(s.amountCents)||BigInt(s.amountCents)*10000n!==BigInt(s.amountAtomic))return reject('bad_amount','amountCents x 10^4 must equal amountAtomic');}
  if(s.depositAddress!==undefined&&lc(s.depositAddress)!==lc(f.payee))return reject('payee_mismatch','signed payee must equal the order depositAddress');
  // token: a contract address (signed DTO) or a symbol with the address in tokenContract (unsigned DTO style); each field is checked
  // against USDC on its own, the two fields are never compared to each other
  if(s.token!==undefined){const t=String(s.token);if(isAddress(t,{strict:false})?lc(t)!==lc(USDC[chainId]):lc(t)!=='usdc')return reject('unsupported_asset',t);}
  if(s.tokenContract!==undefined&&lc(s.tokenContract)!==lc(USDC[chainId]))return reject('unsupported_asset',String(s.tokenContract));
  if(exampleshop&&s.paymentIntentId!==undefined){const oid=lc(f.orderId);
    if(oid===lc(orderIdLegacyStripe(s.paymentIntentId)))return reject('legacy_order_id','V5.1 orderId is keccak256(pi), not the V3-V5 keccak256("stripe:"+pi)');
    if(oid!==lc(orderIdV51(s.paymentIntentId)))return reject('order_id_mismatch','orderId must be keccak256(paymentIntentId)');}
  const expS=toUnixSeconds(s.expiresAt);if(expS===undefined)return reject('bad_expiry',String(s.expiresAt));
  if(expS!==null&&Number(f.deadline)>expS)return reject('deadline_after_expiry','signed deadline is later than the order expiresAt');
  for(const [k,v] of [['bad_payee',f.payee],['bad_verifier',f.verifier],['bad_signer',f.signer],['bad_payer',f.payer]])if(!isAddress(String(v??''),{strict:false}))return reject(k);
  const amount=atomic(f.amount);if(amount===undefined||amount===0n)return reject('bad_amount');
  if(!/^0x[0-9a-fA-F]{64}$/.test(String(f.orderId))||/^0x0{64}$/.test(f.orderId))return reject('bad_order_id');
  if(!/^[0-9]{1,12}$/.test(String(f.deadline)))return reject('bad_deadline');
  if(!/^0x[0-9a-fA-F]{130}$/.test(String(f.signature)))return reject('bad_signature_format');
  const payee=getAddress(lc(f.payee));
  return {ok:true,standard:'signed-order',mode:'signed',chainId,token:getAddress(USDC[chainId]),payee,amount,resource:null,
    merchantHint:f.merchantId??null,merchantRef:f.merchantRef??null,expiresAt:Number(f.deadline),paymentIntentId:exampleshop?(s.paymentIntentId??null):null,
    signedOrder:{v:2,payee,amount,orderId:lc(f.orderId),deadline:BigInt(f.deadline),payer:getAddress(lc(f.payer)),chainId:BigInt(chainId),verifier:getAddress(lc(f.verifier)),
      claimedSigner:getAddress(lc(f.signer)),signature:f.signature}};}
const ZERO_ADDR='0x0000000000000000000000000000000000000000';

export const detectors={
  'x402-v2':(i,o)=>{const h=header(i.headers,'PAYMENT-REQUIRED');if(i.status!==402||!h)return null;
    const pr=b64json(h);if(!pr||pr.x402Version!==2||!Array.isArray(pr.accepts))return reject('malformed_x402_v2');
    return pickFirst(pr.accepts,a=>exactEvm(a,caip(a.network),atomic(a.amount),2,pr.resource,o.chains));},
  'x402-v1':(i,o)=>{if(i.status!==402)return null;const b=typeof i.body==='string'?(()=>{try{return JSON.parse(i.body);}catch{return undefined;}})():i.body;
    if(!b||b.x402Version!==1||!Array.isArray(b.accepts))return null;
    return pickFirst(b.accepts,a=>exactEvm(a,V1NET[a.network],atomic(a.maxAmountRequired),1,{url:a.resource,description:a.description},o.chains));},
  'mpp':(i,o)=>{const w=header(i.headers,'WWW-Authenticate');if(i.status!==402||!w||!/^\s*Payment\b/i.test(w))return null;
    // MPP challenge: Payment id="..", method="evm", intent="charge", request="<base64url JSON>"
    const params=Object.fromEntries([...w.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)].map(m=>[m[1],m[2]]));
    if(lc(params.method)!=='evm'||lc(params.intent)!=='charge')return reject('unsupported_mpp_method',`${params.method}/${params.intent}`);
    let r;try{r=JSON.parse(Buffer.from(params.request.replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8'));}catch{return reject('malformed_mpp');}
    const chainId=Number(r.methodDetails?.chainId??r.chainId);
    const out=exactEvm({scheme:'exact',asset:r.currency??r.asset,payTo:r.recipient,extra:{assetTransferMethod:'eip3009'},maxTimeoutSeconds:60},chainId,atomic(r.amount),2,{url:i.url},o.chains);
    return out.ok?{...out,standard:'mpp',challengeId:params.id}:out;},
  'l402':i=>{const w=header(i.headers,'WWW-Authenticate');if(i.status===402&&w&&/^\s*(L402|LSAT)\b/i.test(w))return reject('lightning_not_supported','L402 settles in BTC over Lightning; this wallet pays USDC only');return null;},
  'eip681':(i,o)=>{const u=String(i.uri??'');if(!u.startsWith('ethereum:'))return null;
    // ethereum:<token>@<chainId>/transfer?address=<payee>&uint256=<amount>
    const m=/^ethereum:(0x[0-9a-fA-F]{40})@([0-9]+)\/transfer\?(.*)$/.exec(u);if(!m)return reject('unsupported_eip681','only ERC-20 transfer URIs with explicit chain id');
    const q=new URLSearchParams(m[3]);const chainId=Number(m[2]);
    if(!o.chains.includes(chainId))return reject('unsupported_network',String(chainId));
    if(lc(m[1])!==lc(USDC[chainId]))return reject('unsupported_asset',m[1]);
    const to=q.get('address'),amt=q.get('uint256');if(!isAddress(String(to),{strict:false}))return reject('bad_payee');
    if(!/^[0-9]+$/.test(String(amt)))return reject('bad_amount','EIP-681 amount must be integer atomic units (no exponent forms)');
    const amount=atomic(amt);if(amount===undefined)return reject('bad_amount');
    return {ok:true,standard:'eip681',mode:'direct',chainId,token:getAddress(USDC[chainId]),payee:getAddress(lc(to)),amount,resource:null};},
  'direct':(i,o)=>{const d=i.direct;if(!d)return null;
    const chainId=Number(d.chainId);if(!o.chains.includes(chainId))return reject('unsupported_network',String(chainId));
    if(lc(d.token)!==lc(USDC[chainId]))return reject('unsupported_asset',d.token);
    if(!isAddress(String(d.payee),{strict:false}))return reject('bad_payee');const amount=atomic(d.amount);if(amount===undefined)return reject('bad_amount');
    if(typeof d.merchantOrderId!=='string'||!d.merchantOrderId)return reject('missing_order_id','direct payments need a merchant order id for exactly-once');
    const exp=d.expiresAt===undefined?null:Number(d.expiresAt);if(exp!==null&&!Number.isSafeInteger(exp))return reject('bad_expiry');if(exp!==null&&exp*1000<=Date.now())return reject('order_expired');
    return {ok:true,standard:'direct',mode:'direct',chainId,token:getAddress(USDC[chainId]),payee:getAddress(lc(d.payee)),amount,merchantOrderId:d.merchantOrderId,resource:null,...(exp!==null?{expiresAt:exp}:{})};},
  // Merchant-signed EIP-712 PaymentOrder (Kipurse generic v1, or ExampleShop exampleshop.usdc-deposit-order.v1 which is the same order).
  // Pure: the signature is recovered later (async) by the engine; payee/amount/orderId come only from the signed fields.
  'signed-order':(i,o)=>{const s=i.signedOrder;if(!s)return null;
    // v2 (Kipurse V5.1, 2026-10-18): stable domain "Kipurse PaymentOrder" v1 at the KipurseOrderVerifier; payee may be a fresh
    // per-order deposit address (the merchant's signer attests it); `payer` optionally binds the order to one wallet.
    if(s.version==='kipurse.signed-order.v2'||s.dtoVersion==='exampleshop.usdc-deposit-order.v2')return signedV2(s,o);
    const exampleshop=s.dtoVersion==='exampleshop.usdc-deposit-order.v1',generic=s.version==='kipurse.signed-order.v1';
    if(!exampleshop&&!generic)return reject('unsupported_signed_order',String(s.dtoVersion??s.version));
    const f=exampleshop?{payee:s.payee,amount:s.amountAtomic,orderId:s.orderId,deadline:s.orderDeadline,chainId:s.chainId,adapter:s.adapter,signer:s.signer,signature:s.signature,merchantId:'exampleshop.example',merchantRef:s.paymentIntentId}
      :{payee:s.payee,amount:s.amount,orderId:s.orderId,deadline:s.deadline,chainId:s.chainId,adapter:s.adapter,signer:s.signer,signature:s.signature,merchantId:s.merchant?.id,merchantRef:s.merchant?.ref};
    const chainId=Number(f.chainId);if(!o.chains.includes(chainId))return reject('unsupported_network',String(f.chainId));
    if(exampleshop){if(!['open','awaiting_payment'].includes(String(s.status)))return reject('order_not_payable',String(s.status));
      if(lc(s.token)!==lc(USDC[chainId]))return reject('unsupported_asset',s.token);
      if(atomic(s.amountAtomic)===undefined||!Number.isSafeInteger(s.amountCents)||BigInt(s.amountCents)*10000n!==BigInt(s.amountAtomic))return reject('bad_amount','amountCents x 10^4 must equal amountAtomic');}
    if(!isAddress(String(f.payee??''),{strict:false}))return reject('bad_payee');
    if(!isAddress(String(f.adapter??''),{strict:false}))return reject('bad_adapter');
    if(!isAddress(String(f.signer??''),{strict:false}))return reject('bad_signer');
    const amount=atomic(f.amount);if(amount===undefined)return reject('bad_amount');
    if(!/^0x[0-9a-fA-F]{64}$/.test(String(f.orderId))||/^0x0{64}$/.test(f.orderId))return reject('bad_order_id');
    if(!Number.isSafeInteger(Number(f.deadline)))return reject('bad_deadline');
    if(!/^0x[0-9a-fA-F]{130}$/.test(String(f.signature)))return reject('bad_signature_format');
    return {ok:true,standard:'signed-order',mode:'signed',chainId,token:getAddress(USDC[chainId]),payee:getAddress(lc(f.payee)),amount,resource:null,
      merchantHint:f.merchantId??null,merchantRef:f.merchantRef??null,expiresAt:Number(f.deadline),
      signedOrder:{payee:getAddress(lc(f.payee)),amount,orderId:lc(f.orderId),deadline:BigInt(f.deadline),chainId:BigInt(chainId),adapter:getAddress(lc(f.adapter)),claimedSigner:getAddress(lc(f.signer)),signature:f.signature}};},
  // Coinbase Business Checkouts API object (successor of Coinbase Commerce). Prefer the hosted x402 URL; else exact transfer to `address`.
  // Field names per docs.cdp.coinbase.com/api-reference/business-api (not yet tested against a live checkout).
  'coinbase-business':(i,o)=>{const c=i.coinbaseCheckout;if(!c)return null;
    if(typeof c.id!=='string'||!c.id)return reject('missing_order_id','checkout id');
    if(c.status!==undefined&&String(c.status).toUpperCase()!=='ACTIVE')return reject('order_not_payable',String(c.status));
    if(c.expiresAt&&Date.parse(c.expiresAt)<=Date.now())return reject('order_expired',String(c.expiresAt));
    const chainId=c.network==='base'?8453:c.network==='base-sepolia'?84532:undefined;if(!chainId||!o.chains.includes(chainId))return reject('unsupported_network',String(c.network));
    if(c.currency!==undefined&&String(c.currency).toUpperCase()!=='USDC')return reject('unsupported_asset',String(c.currency));
    const amount=decimalUsdc(c.amount);if(amount===undefined)return reject('bad_amount','decimal USDC with at most 6 places');
    if(typeof c.x402_url==='string'&&/^https:\/\//.test(c.x402_url))return {ok:true,standard:'coinbase-business',mode:'x402_redirect',chainId,token:getAddress(USDC[chainId]),payee:isAddress(String(c.address??''),{strict:false})?getAddress(lc(c.address)):null,amount,
      merchantOrderId:'cb-checkout:'+c.id,resource:{url:c.x402_url},redirectUrl:c.x402_url,expiresAt:c.expiresAt?Math.floor(Date.parse(c.expiresAt)/1000):null};
    if(!isAddress(String(c.address??''),{strict:false}))return reject('bad_payee');
    if(c.tokenAddress!==undefined&&lc(c.tokenAddress)!==lc(USDC[chainId]))return reject('unsupported_asset',c.tokenAddress);
    return {ok:true,standard:'coinbase-business',mode:'direct',chainId,token:getAddress(USDC[chainId]),payee:getAddress(lc(c.address)),amount,merchantOrderId:'cb-checkout:'+c.id,resource:null,
      expiresAt:c.expiresAt?Math.floor(Date.parse(c.expiresAt)/1000):null,warnings:['exact_amount_required']};},
  // Stripe crypto PaymentIntent in deposit mode (merchant relays it): exact USDC transfer to the Base deposit address.
  'stripe-pi':(i,o)=>{const pi=i.stripePaymentIntent;if(!pi)return null;
    if(typeof pi.id!=='string'||!/^pi_[A-Za-z0-9_]+$/.test(pi.id))return reject('missing_order_id','PaymentIntent id');
    if(pi.status!=='requires_action'||pi.next_action?.type!=='crypto_display_details')return reject('order_not_payable',String(pi.status));
    if(pi.currency!=='usd'||!Number.isSafeInteger(pi.amount)||pi.amount<=0)return reject('bad_amount','usd cents');
    const chainId=o.chains[0];const base=pi.next_action.crypto_display_details?.deposit_addresses?.base;
    if(!base||!isAddress(String(base.address??''),{strict:false}))return reject('bad_payee');
    if(!Array.isArray(base.supported_tokens)||!base.supported_tokens.some(t=>t.token_currency==='usdc'&&lc(t.token_contract_address)===lc(USDC[chainId])))return reject('unsupported_asset');
    const exp=pi.next_action.crypto_display_details.expires_at;if(Number.isSafeInteger(exp)&&exp*1000<=Date.now())return reject('order_expired');
    return {ok:true,standard:'stripe-pi',mode:'direct',chainId,token:getAddress(USDC[chainId]),payee:getAddress(lc(base.address)),amount:BigInt(pi.amount)*10000n,merchantOrderId:'stripe:'+pi.id,resource:null,
      expiresAt:Number.isSafeInteger(exp)?exp:null,warnings:['exact_amount_required','deposit_address_may_be_shared']};},
};

const decimalUsdc=v=>{const s=String(v??'');const m=/^([0-9]{1,15})(?:\.([0-9]{1,6}))?$/.exec(s);if(!m)return undefined;const n=BigInt(m[1])*1000000n+BigInt((m[2]??'').padEnd(6,'0')||'0');return n>0n?n:undefined;};

/** input: {status, headers, body, url} for HTTP challenges, {uri} for EIP-681, {direct}, {signedOrder}, {coinbaseCheckout} or {stripePaymentIntent}. */
export function detect(input,{chains=[84532]}={}){
  if(!input||typeof input!=='object')return reject('unknown_payment_request');
  for(const name of DETECTOR_ORDER){const r=detectors[name](input,{chains});if(r)return {...r,detector:name};}
  return reject('unknown_payment_request','no registered standard matched; refusing to guess');
}
