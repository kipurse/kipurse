// Public documents of the TEST shop: llms.txt, capabilities, openapi.json and a small bilingual human page.
// The shop is an ordinary merchant: it describes its own order API in the same public shape as other USDC deposit-order merchants
// (e.g. ExampleShop) and knows nothing about any particular wallet.
export const CATALOG=Object.freeze({
  sticker:{item:'sticker',name:'Test sticker / 测试贴纸',amountAtomic:100000n},
  badge:{item:'badge',name:'Test badge / 测试徽章',amountAtomic:200000n},
  poster:{item:'poster',name:'Test poster / 测试海报',amountAtomic:500000n}});
export const ORDER_TTL_S=900;
export const STATUSES=['open','paid','expired','review'];
export const usdcStr=a=>{const n=BigInt(a);return (n/1000000n).toString()+'.'+(n%1000000n).toString().padStart(6,'0').slice(0,2);};
const ORDERS='/api/v1/agent/usdc-orders',CAPS='/api/v1/agent/capabilities';
export function llmsTxt(origin){return `# Kipurse Test Shop (TEST ONLY)

A tiny TEST shop. It sells pretend items for 0.10-0.50 USDC on Base mainnet so payment software can be tested end to end.
Nothing is shipped. Money paid here is collected back to the shop owner's own wallet.

Official origin: ${origin}/
Live capabilities: ${origin}${CAPS}
OpenAPI: ${origin}/openapi.json

## Order and pay

POST ${origin}${ORDERS} with JSON {"purchaseId": "<client UUID>", "item": "sticker" | "badge" | "poster"}.
Optional: "signedOrder": true returns an EIP-712 signed copy of the order terms (see capabilities).
The response gives depositAddress, amountAtomic (USDC, 6 decimals), expiresAt (unix seconds, 15 minutes) and statusUrl.
Each order has its OWN new deposit address. Pay EXACTLY amountAtomic USDC on Base (chain 8453) to depositAddress before expiresAt,
in one transfer. Retrying with the same purchaseId never creates a second order.

## Status

GET ${origin}${ORDERS}/{purchaseId} (no authentication). open = pay now; paid = exact amount received in time;
expired = nothing received in time; review = wrong amount or late payment (no automatic refund).
`;}
export function capabilities({origin,signer,mode,verifyingContract}){const signed=mode==='signed';
  return {version:'2026-11-21',site:'Kipurse Test Shop',test:true,currency:'usd',
    notice:'TEST shop: pretend items, tiny prices (0.10-0.50 USDC). Nothing is shipped; money paid here is collected back to the shop owner.',
    merchant:signed?{name:'Kipurse Test Shop',origin,expectedSigner:signer}:{name:'Kipurse Test Shop',origin},
    catalog:Object.values(CATALOG).map(c=>({item:c.item,name:c.name,amountAtomic:c.amountAtomic.toString(),amountUsdc:usdcStr(c.amountAtomic)})),
    usdcPayments:{dtoVersion:'testshop.usdc-order.v1',status:'live',method:'POST',path:ORDERS,contentType:'application/json',auth:'none',
      walletNeutral:true,unattended:true,humanConfirmationRequired:false,network:'base',token:'USDC',decimals:6,
      request:{required:['purchaseId (client UUID, idempotency key)',"item ('sticker'|'badge'|'poster')"],optional:['signedOrder (boolean)']},
      response:['purchaseId','orderId','status','network','chainId','token','tokenContract','depositAddress','amountAtomic','amountUsdc','amountCents','expiresAt','statusUrl','item'],
      amountRule:'exact',
      rules:['Pay the EXACT amountAtomic of USDC on Base to depositAddress, in one transfer, before expiresAt (unix seconds; 15 minutes after creation).',
        'depositAddress is new for every order. Use it only for this order and only before expiresAt.',
        'Wrong amounts and late payments go to review. There are no automatic refunds; this is a test shop and its owner collects all funds.',
        'Retry the same request with the same purchaseId after network errors; it never creates a second order.'],
      rateLimits:{create:'10 requests/minute per client',status:'60 requests/minute per client'},
      orderTtlSecondsMax:ORDER_TTL_S,statuses:STATUSES,terminalStatuses:['paid','expired','review'],
      errors:{'400':'INVALID_JSON / UNKNOWN_FIELD / INVALID_PURCHASE_ID / INVALID_ITEM / INVALID_SIGNED_ORDER','404':'ORDER_NOT_FOUND','409':'ORDER_TERMS_MISMATCH','413':'BODY_TOO_LARGE','415':'UNSUPPORTED_MEDIA_TYPE','429':'RATE_LIMITED','503':'TEMPORARILY_UNAVAILABLE'},
      refunds:'No automatic refunds.',
      statusEndpoint:{method:'GET',path:ORDERS+'/{purchaseId}',auth:'none',pollIntervalSeconds:10,statuses:STATUSES},
      docs:{openapi:'/openapi.json',llms:'/llms.txt'},chainId:8453,tokenContract:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',maxAmountCents:50,
      signedOrder:signed?{optional:true,available:true,request:'Opt in with ?signedOrder=1 or JSON {"signedOrder":true}. Never needed to pay.',
        paymentOrder:'EIP-712 AgentWalletPaymentOrder v5',paymentOrderDomainVersion:'5',verifyingContract,paymentOrderPayer:'0x0000000000000000000000000000000000000000',
        signer:signer,note:'The signature is evidence of the order terms (payee = depositAddress, amount = amountAtomic, deadline = expiresAt); verify it against merchant.expectedSigner.'}
        :{optional:true,available:false,reason:'SIGNED_ORDER_NOT_CONFIGURED'}}};}
const err={type:'object',required:['error','code'],properties:{error:{type:'string'},code:{type:'string'},retryAfterSeconds:{type:'integer'}}};
const R=(d,ref)=>({description:d,content:{'application/json':{schema:{$ref:'#/components/schemas/'+ref}}}});
export function openapi({origin}){return {openapi:'3.1.0',info:{title:'Kipurse Test Shop agent API (TEST ONLY)',version:'1.0.0',description:'Pretend items for 0.10-0.50 USDC on Base. Each order has a new deposit address.'},
  servers:[{url:origin}],
  paths:{[ORDERS]:{post:{operationId:'createUsdcOrder',summary:'Create a USDC order (Base); pay the exact amount to depositAddress',
      description:'Returns depositAddress (new for every order), the exact amountAtomic and expiresAt (15 minutes). Retrying with the same purchaseId and body is safe and never creates a second order. Optional signed EIP-712 order terms on opt-in.',
      parameters:[{name:'signedOrder',in:'query',required:false,schema:{type:'string',enum:['1','true','0','false']},description:'Same as body signedOrder:true.'}],
      requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,required:['purchaseId','item'],properties:{
        purchaseId:{type:'string',format:'uuid',description:'Client-generated UUID; idempotency key for this purchase.'},
        item:{type:'string',enum:Object.keys(CATALOG),description:'sticker = 0.10 USDC, badge = 0.20 USDC, poster = 0.50 USDC'},
        signedOrder:{type:'boolean',description:'Optional. true = also return the EIP-712 signed order terms when configured.'}}}}}},
      responses:{'200':R('Order (new or replayed). Pay exactly amountAtomic USDC on Base to depositAddress before expiresAt.','UsdcOrder'),
        '400':R('INVALID_JSON, UNKNOWN_FIELD, INVALID_PURCHASE_ID, INVALID_ITEM, INVALID_SIGNED_ORDER','UsdcError'),'409':R('ORDER_TERMS_MISMATCH (same purchaseId, different item)','UsdcError'),
        '413':R('BODY_TOO_LARGE','UsdcError'),'415':R('UNSUPPORTED_MEDIA_TYPE','UsdcError'),'429':R('RATE_LIMITED','UsdcError'),'503':R('TEMPORARILY_UNAVAILABLE','UsdcError')}}},
    [ORDERS+'/{purchaseId}']:{get:{operationId:'getUsdcOrder',summary:'Order status (read-only, no authentication)',
      parameters:[{name:'purchaseId',in:'path',required:true,schema:{type:'string',format:'uuid'}}],
      responses:{'200':R('Order status','UsdcOrderStatus'),'400':R('INVALID_PURCHASE_ID','UsdcError'),'404':R('ORDER_NOT_FOUND','UsdcError'),'429':R('RATE_LIMITED','UsdcError')}}},
    [CAPS]:{get:{operationId:'getCapabilities',responses:{'200':{description:'capabilities'}}}}},
  components:{schemas:{
    UsdcOrder:{type:'object',required:['dtoVersion','purchaseId','orderId','status','network','chainId','token','tokenContract','depositAddress','amountAtomic','amountUsdc','amountCents','expiresAt','statusUrl','item'],properties:{
      dtoVersion:{const:'testshop.usdc-order.v1'},purchaseId:{type:'string',format:'uuid'},orderId:{type:'string',pattern:'^ord_[0-9]+$'},
      status:{type:'string',enum:STATUSES,description:"'open' = pay now. 'paid' = exact amount received before expiresAt. 'expired' = nothing received in time (do not pay). 'review' = wrong amount or late payment."},
      network:{const:'base'},chainId:{type:'integer',enum:[8453]},token:{const:'USDC'},tokenContract:{type:'string',pattern:'^0x[0-9a-fA-F]{40}$'},
      depositAddress:{type:'string',pattern:'^0x[0-9a-fA-F]{40}$',description:'New for THIS order. Use it only for this order and only before expiresAt.'},
      amountAtomic:{type:'string',pattern:'^[1-9][0-9]*$'},amountUsdc:{type:'string',pattern:'^[0-9]+\\.[0-9]{2}$'},amountCents:{type:'integer'},
      expiresAt:{type:'integer',description:'Unix seconds (15 minutes after creation).'},statusUrl:{type:'string'},item:{type:'string',enum:Object.keys(CATALOG)},
      signedOrder:{$ref:'#/components/schemas/UsdcSignedOrder'}}},
    UsdcSignedOrder:{description:'Present only on opt-in. available=false is not an error.',oneOf:[
      {type:'object',required:['available','reason'],properties:{available:{const:false},reason:{type:'string',enum:['SIGNED_ORDER_NOT_CONFIGURED','PURCHASE_CREATED_UNSIGNED']}}},
      {type:'object',required:['available','dtoVersion','signer','payee','amountAtomic','orderId','orderDeadline','chainId','adapter','payer','signature'],
        description:'EIP-712 PaymentOrder(address payee,uint256 amount,bytes32 orderId,uint256 deadline,uint256 chainId,address adapter,address payer); domain name AgentWalletPaymentOrder, version 5, verifyingContract = capabilities signedOrder.verifyingContract; payer is always 0.',
        properties:{available:{const:true},dtoVersion:{const:'testshop.signed-order.v1'},signer:{type:'string'},payee:{type:'string'},token:{type:'string'},amountAtomic:{type:'string'},
          orderId:{type:'string',pattern:'^0x[0-9a-f]{64}$'},orderDeadline:{type:'integer'},chainId:{type:'integer'},adapter:{type:'string'},payer:{type:'string'},signature:{type:'string'},paymentOrderDomainVersion:{type:'string'}}}]},
    UsdcOrderStatus:{type:'object',required:['dtoVersion','purchaseId','status'],properties:{dtoVersion:{const:'testshop.usdc-order-status.v1'},purchaseId:{type:'string'},orderId:{type:'string'},
      status:{type:'string',enum:STATUSES},depositAddress:{type:['string','null']},amountAtomic:{type:'string'},amountUsdc:{type:'string'},expiresAt:{type:'integer'},
      chainId:{type:'integer'},tokenContract:{type:'string'},receivedAtomic:{type:'string'},paidAt:{type:['integer','null']},txHashes:{type:'array',items:{type:'string'}}}},
    UsdcError:err}}};}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function homePage({origin,mode,signer}){const items=Object.values(CATALOG).map(c=>`<li><b>${esc(c.name)}</b> — ${usdcStr(c.amountAtomic)} USDC (<code>${c.item}</code>)</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kipurse Test Shop</title>
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;max-width:720px;margin:0 auto;padding:24px 16px;background:Canvas;color:CanvasText}
.warn{border:2px solid #d97706;border-radius:10px;padding:12px 16px;background:color-mix(in srgb,#f59e0b 12%,Canvas)}code{font-size:.9em;word-break:break-all}h1{font-size:1.5em}</style></head><body>
<h1>Kipurse 测试商店 / Kipurse Test Shop</h1>
<div class="warn"><p><b>这是测试商店。</b>东西都是假的，不会发货。每件只卖 0.10–0.50 USDC（Base 主网），付到这里的钱都会被取回到店主自己的钱包。</p>
<p><b>This is a TEST shop.</b> Items are pretend and nothing is shipped. Each item costs 0.10–0.50 USDC (Base mainnet); money paid here is collected back to the shop owner's own wallet.</p></div>
<h2>商品 / Items</h2><ul>${items}</ul>
<h2>给 AI 和开发者 / For AI agents and developers</h2>
<p>每个订单都有一个新的收款地址，15 分钟内有效。Every order gets a new deposit address, valid for 15 minutes.</p>
<ul><li><a href="/llms.txt">llms.txt</a></li><li><a href="/api/v1/agent/capabilities">capabilities</a></li><li><a href="/openapi.json">openapi.json</a></li></ul>
<p>订单签名 / Order signature: ${mode==='signed'?`已开启 / on — signer <code>${esc(signer)}</code>`:'未开启 / off'}</p>
<p><small>${esc(origin)}</small></p></body></html>`;}
