# @kipurse/sdk 0.1 (unpublished, M1)

Zero-dependency client for a Kipurse gateway. The SDK holds **no wallet keys**; the gateway enforces the owner's on-chain caps, fixed term, trust tiers and exactly-once payment.

```js
import {KipurseClient, wrapFetch} from '@kipurse/sdk';
const kp = new KipurseClient({baseUrl: 'http://127.0.0.1:8650', token: process.env.KIPURSE_AGENT_TOKEN});
const p = await kp.parse({uri: 'ethereum:0x8335…2913@8453/transfer?address=0x…&uint256=10000'}, {intentId: 'team-goal-1'});
const f = await kp.preflight({parsedId: p.parsedId});        // canPay, reasons[], tier, remainingAfter, simulation
if (f.canPay) await kp.pay({parsedId: p.parsedId, intentId: 'team-goal-1'});
const paidFetch = wrapFetch(kp, {maxAmount: '50000'});         // x402 resources: pay once per URL (+repeatKey)
```

Purchase identity: same merchant reference (signed order id, merchant order id, Stripe PI, Coinbase checkout id, MPP challenge, x402 resource URL) ⇒ same purchase, whichever agent and intentId. Use `repeatKey` to buy the same thing again on purpose. Requests without any merchant reference need `intentId` or `repeatKey`.

MCP equivalent: `src/v5/mcp-main.mjs` exposes the same operations as `kipurse_*` tools. Full guide for third-party agents: ../docs/THIRD_PARTY_AGENTS.md

## Pay anything (merchants need no integration)

```js
// plain address + amount from the merchant's checkout page; merchant + orderRef = exactly-once key
await client.payAny({payment:{to:'0xPayeeAddress', amount:'12.50'}, merchant:'exampleshop.example', orderRef:'BG-10023'});
await client.payAny({payment:'ethereum:0x8335…2913@8453/transfer?address=0x…&uint256=12500000', merchant:'shop', orderRef:'A-7'});
await client.payAny({payment:'https://api.example.com/paid-resource'});            // x402 / MPP
await client.payAny({payment:stripePaymentIntent});                                 // deposit mode, id = pi_…
await client.parseAny({payment:{to:'0x…', amount:'1.00'}, merchant:'m', orderRef:'1'}); // route + tier + key, never pays
```
Signed EIP-712 orders are optional. Solana Pay links return `solana_not_supported_yet`. See ../MERCHANTS.md.
