// SPDX-License-Identifier: Apache-2.0
// Kipurse MCP (stdio) over the V4 engine (M1). Every paying tool requires idempotencyKey. No tool takes raw calldata,
// keys, or changes caps/term/trust; payee and amount come only from the parsed merchant data.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
const txt=o=>({content:[{type:'text',text:JSON.stringify(o,(k,v)=>typeof v==='bigint'?v.toString():v)}]});
const http=z.object({status:z.number(),headers:z.record(z.string(),z.string()).optional(),body:z.any().optional(),url:z.string().optional()});
const direct=z.object({chainId:z.number(),token:z.string(),payee:z.string(),amount:z.string(),merchantOrderId:z.string()});
export const requestSchema={http:http.optional(),uri:z.string().optional(),direct:direct.optional(),signedOrder:z.record(z.string(),z.any()).optional(),
  coinbaseCheckout:z.record(z.string(),z.any()).optional(),stripePaymentIntent:z.record(z.string(),z.any()).optional()};
export const toRequest=a=>a.http?{...a.http,headers:a.http.headers??{}}:a.uri?{uri:a.uri}:a.direct?{direct:a.direct}:a.signedOrder?{signedOrder:a.signedOrder}:a.coinbaseCheckout?{coinbaseCheckout:a.coinbaseCheckout}:a.stripePaymentIntent?{stripePaymentIntent:a.stripePaymentIntent}:null;
const idem=z.string().min(8).max(128),opt={intentId:z.string().max(128).optional(),repeatKey:z.string().max(128).optional()};
export const TOOL_NAMES=['kipurse_claim_purchase','kipurse_get_purchase','kipurse_limits','kipurse_list_purchases','kipurse_merchant_info','kipurse_paid_fetch','kipurse_parse_payment','kipurse_pay','kipurse_preflight','kipurse_reclaim_expired','kipurse_wallet_status'];
export function createV4Mcp(engine,{agentId}){
  const s=new McpServer({name:'kipurse-wallet',version:'0.5.0-m1'});
  s.tool('kipurse_wallet_status','Shared wallet: balance, caps, spent, expiry and expiry reminders (read-only).',{},async()=>txt(await engine.status()));
  s.tool('kipurse_limits','Remaining amounts per tier (single/daily/term/stranger), gateway test limit and THIS agent\'s sub-budget (read-only).',{},async()=>txt(await engine.limits({agentId})));
  s.tool('kipurse_parse_payment','Parse a merchant payment requirement WITHOUT paying: x402 402 response, EIP-681 URI, direct {payee,amount,merchantOrderId}, merchant-signed order (ExampleShop v4 / Kipurse v1), Coinbase Business checkout, Stripe crypto PaymentIntent. Returns parsedId, payee, amount, merchant, trust tier.',
    {...requestSchema,...opt},async a=>{const r=toRequest(a);return txt(r?await engine.parse(r,a):{ok:false,code:'no_request'});});
  s.tool('kipurse_preflight','Can this be paid, and why/why not? Checks caps, tier, balance, expiry, sub-budget, duplicates and simulates the exact on-chain call. Never pays. Use it to compare offers.',
    {parsedId:z.string().optional(),...requestSchema,...opt},async a=>txt(await engine.preflight(a.parsedId?{parsedId:a.parsedId}:toRequest(a),{agentId,...a})));
  s.tool('kipurse_pay','Pay a parsed request (parsedId) or a request object exactly once for the whole agent team. For HTTP 402 resources use kipurse_paid_fetch.',
    {parsedId:z.string().optional(),...requestSchema,...opt,maxAmount:z.string().regex(/^[0-9]+$/).optional(),idempotencyKey:idem},
    async a=>txt(await engine.pay({agentId,intentId:a.intentId,repeatKey:a.repeatKey,idempotencyKey:a.idempotencyKey,maxAmount:a.maxAmount,parsedId:a.parsedId,request:a.parsedId?undefined:toRequest(a)})));
  s.tool('kipurse_paid_fetch','Fetch a URL; if it answers 402 with a supported standard (x402 v1/v2, MPP evm charge) pay it exactly once for the whole agent team and return the content. Same URL = same purchase unless repeatKey differs.',
    {url:z.string().url(),method:z.enum(['GET','POST']).default('GET'),body:z.string().optional(),...opt,maxAmount:z.string().regex(/^[0-9]+$/).optional(),idempotencyKey:idem},
    async a=>txt(await engine.paidFetch({agentId,...a})));
  s.tool('kipurse_claim_purchase','Claim a line item of a team goal before buying ("I take this"); other agents see the owner and stop.',
    {intentId:z.string().min(1).max(128),lineKey:z.string().min(1).max(256),ttlSec:z.number().int().min(10).max(86400).default(600),note:z.string().max(200).optional()},
    async a=>txt(engine.claimPurchase({agentId,...a})));
  s.tool('kipurse_merchant_info','What the wallet knows about a merchant: registry entry, trust tier, revoked signer, ledger history.',
    {payee:z.string().optional(),domain:z.string().optional(),merchantId:z.string().optional(),signer:z.string().optional()},async a=>txt(engine.merchantInfo(a)));
  s.tool('kipurse_get_purchase','Read one purchase from the shared ledger.',{purchaseKey:z.string().length(64)},async a=>txt(engine.ledger.get(a.purchaseKey)??{error:'not_found'}));
  s.tool('kipurse_list_purchases','List recent purchases in the shared ledger.',{since:z.number().optional(),state:z.string().optional(),mine:z.boolean().default(false),limit:z.number().int().min(1).max(200).default(50)},
    async a=>txt(engine.listPurchases({since:a.since,state:a.state,agentId:a.mine?agentId:undefined,limit:a.limit})));
  s.tool('kipurse_reclaim_expired','Maintenance: return expired, unsettled x402 pre-authorizations to the wallet (anyone may do this).',{},async()=>txt(await engine.reclaimExpired(agentId)));
  return {server:s,start:()=>s.connect(new StdioServerTransport())};
}
