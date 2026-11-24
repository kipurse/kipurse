// SPDX-License-Identifier: AGPL-3.0-only
// t1278 S3: an x402 (eip3009) request handed to pay() / payAny() used to skip the AI gate (new-payee Face ID, per-AI caps, allowances, anomaly,
// >= 500 USDC trust-list rule) and was recorded with tier null (never counted in the 24h sums). Signed orders skipped the per-AI cap amount check.
import test from 'node:test';import assert from 'node:assert/strict';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import {engineFor,USDC,ADAPTER} from './helpers/v5-fixture.mjs';
const T={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},{name:'adapter',type:'address'},{name:'payer',type:'address'}]};
let n=0;const idem=()=>'idem-t1278-s3-'+(++n);const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64');
const x402=(payTo,amount='50000',i=++n)=>{const url='https://api.example/r/'+i;return {status:402,url,headers:{'PAYMENT-REQUIRED':b64({x402Version:2,resource:{url},accepts:[{scheme:'exact',network:'eip155:84532',amount,asset:USDC,payTo,maxTimeoutSeconds:60,extra:{name:'USDC',version:'2',nonce:'n'+i}}]})}};};
const fresh=()=>'0x'+[...crypto.getRandomValues(new Uint8Array(20))].map(b=>b.toString(16).padStart(2,'0')).join('');
const tierOf=(e,k)=>e.engine.ledger.db.prepare(`SELECT tier FROM purchase_order WHERE purchase_key=?`).get(k)?.tier;

test('t1278 S3: pay() with an x402 request to a NEW payee -> the same owner Face ID ask as paidFetch; nothing prepared',async()=>{
  const e=engineFor();const w0=e.s.writes.length;const r=await e.engine.pay({agentId:'a1',request:x402(fresh()),idempotencyKey:idem()});
  assert.equal(r.state,'rejected',JSON.stringify(r));assert.equal(r.reason,'NEW_PAYEE_NEEDS_OWNER');assert.equal(r.nothingPaid,true);assert.equal(e.s.writes.length,w0,'no prepareAuthorization');});

test('t1278 S3: pay() with an x402 request to an owner-established payee is prepared and recorded with its tier (counts in the 24h sums)',async()=>{
  const e=engineFor();const P=fresh();e.engine.mandates.remember(P,'API');const r=await e.engine.pay({agentId:'a1',request:x402(P),idempotencyKey:idem()});
  assert.equal(r.state,'prepared',JSON.stringify(r));assert.ok(e.s.writes.some(w=>w.fn==='prepareAuthorization'));assert.equal(tierOf(e,r.purchaseKey),'trust_list','not null');});

test('t1278 S3: per-AI caps apply to x402 via pay() and to signed orders with their amount',async()=>{
  const e=engineFor();const M=e.engine.mandates;M.propose({items:[{kind:'agent_limits',agentId:'a1',single:'0.01',daily:'1',monthly:'10'}]});for(const p of M.proposals())M.approve(p.id,()=>true);
  const P=fresh();M.remember(P,'API');const w0=e.s.writes.length;
  const r=await e.engine.pay({agentId:'a1',request:x402(P,'50000'),idempotencyKey:idem()});assert.equal(r.reason,'AGENT_SINGLE_CAP',JSON.stringify(r));assert.equal(e.s.writes.length,w0);
  const acct=privateKeyToAccount(generatePrivateKey());const msg={payee:P,amount:50000n,orderId:'0x'+'12'.repeat(32),deadline:BigInt(Math.floor(Date.now()/1000)+3600),chainId:84532n,adapter:ADAPTER,payer:e.cfg.permission.account};
  const signature=await acct.signTypedData({domain:{name:'AgentWalletPaymentOrder',version:'5',chainId:84532,verifyingContract:ADAPTER},types:T,primaryType:'PaymentOrder',message:msg});
  const so={signedOrder:{version:'kipurse.signed-order.v1',payee:P,amount:'50000',orderId:msg.orderId,deadline:String(msg.deadline),chainId:'84532',adapter:ADAPTER,signer:acct.address,signature,payer:msg.payer}};
  const s=await e.engine.pay({agentId:'a1',request:so,idempotencyKey:idem()});assert.equal(s.reason,'AGENT_SINGLE_CAP',JSON.stringify(s));assert.equal(e.s.writes.length,w0);});
