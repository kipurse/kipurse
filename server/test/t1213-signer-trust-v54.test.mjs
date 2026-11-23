// t1213 (handbook §6#100): V5.4 signed-merchant decision. Valid signed order from the published + owner-granted signer -> auto; every
// mismatch -> today's card. Flag off / non-V5.4 wallet -> card (the owner's V5.2 wallet is never affected).
import test from 'node:test';import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';import {keccak256,toHex} from 'viem';
import {decide,normalizeSignedOrder,orderDomain,publishedSigner,merchantId,createGrantStore,encodePaySignedTrusted,enabled} from '../src/v5/signer-trust-v54.mjs';

const shop=privateKeyToAccount('0x'+'51'.repeat(32)), evil=privateKeyToAccount('0x'+'e5'.repeat(32));
const WALLET='0xE05a5Ae6C938C2BD72Da539D971e34e586c6Cc03', ADAPTER='0x13Ab618eDBeC2F1A22763ADC2135251a28Bf034e', CHAIN=84532;
const ORIGIN='https://shop.example', NOW=1_800_000_000;
const caps={merchant:{name:'ExampleShop',origin:'https://shop.example',expectedSigner:shop.address}};
const T={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},{name:'adapter',type:'address'},{name:'payer',type:'address'}]};
let n=0;const fresh=()=>('0x'+keccak256(toHex('dep'+(++n))).slice(26));
async function mk({signer=shop,amount=5_000_000n,payer=WALLET,adapter=ADAPTER,chainId=CHAIN,deadline=NOW+1800,payee=fresh(),tamper}={}){
  const order={payee,amount,orderId:keccak256(toHex('pi_'+(++n))),deadline:BigInt(deadline),chainId:BigInt(chainId),adapter,payer};
  const signature=await signer.signTypedData({domain:orderDomain({adapter,chainId}),types:T,primaryType:'PaymentOrder',message:order});
  const so={available:true,dtoVersion:'exampleshop.usdc-deposit-order.v1',signer:signer.address,payee,token:'0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amountAtomic:String(amount),orderId:order.orderId,orderDeadline:deadline,chainId,adapter,signature,payer};
  const pr={depositAddress:payee,amountAtomic:String(amount),expiresAt:deadline,chainId};
  tamper?.(so,pr);return {so,pr};}
const G={wallet:WALLET,merchant:merchantId('shop.example'),name:'shop.example',signers:[shop.address],single:'6000000',daily:'12000000',expiry:NOW+30*86400,grant:'0xabcd'};
const base=async(o={},x={})=>{const {so,pr}=await mk(o);return decide({env:{KIPURSE_V54_SIGNER_TRUST:'1'},suite:'v5.4',wallet:WALLET,adapter:ADAPTER,chainId:CHAIN,nowS:NOW,
  origin:ORIGIN,caps,paymentRequest:pr,signedOrder:so,grant:G,everyday:{single:'6000000',leftToday:'20000000'},...x});};

test('valid signed order from the published, owner-granted signer -> auto (fresh deposit address, no binding)',async()=>{
  const r=await base();assert.equal(r.route,'auto');assert.equal(r.signer,shop.address);assert.equal(r.name,'shop.example');
  const r2=await base();assert.equal(r2.route,'auto');assert.notEqual(r2.order.payee,r.order.payee,'every order its own address');});
test('flag off or non-V5.4 wallet (the owner\'s V5.2 wallet today) -> card, never auto',async()=>{
  assert.equal(enabled({}),false);
  assert.equal((await base({},{env:{}})).reason,'flag_off');
  assert.equal((await base({},{suite:'v5.2'})).reason,'suite_not_v54');});
test('tampered amount / payee in the DTO -> card with impersonation warning (signature no longer from the signer)',async()=>{
  let r=await base({tamper:(so,pr)=>{so.amountAtomic='6000000';pr.amountAtomic='6000000';}});assert.equal(r.route,'card');assert.equal(r.reason,'signer_mismatch');assert.equal(r.warn,true);
  r=await base({tamper:(so,pr)=>{so.payee=pr.depositAddress='0x0000000000000000000000000000000000000bad';}});assert.equal(r.reason,'signer_mismatch');});
test('order differs from the merchant payment request -> card',async()=>{
  assert.equal((await base({tamper:(so,pr)=>{pr.amountAtomic='4000000';}})).reason,'order_mismatch_payment_request');
  assert.equal((await base({tamper:(so,pr)=>{pr.depositAddress=fresh();}})).reason,'order_mismatch_payment_request');
  assert.equal((await base({tamper:(so,pr)=>{pr.expiresAt=NOW+600;}})).reason,'order_mismatch_payment_request');});
test('wrong signer (validly signed by someone not published) -> card + warning',async()=>{
  const r=await base({signer:evil});assert.equal(r.reason,'signer_not_published');assert.equal(r.warn,true);});
test('signer published on another origin / http -> card',async()=>{
  assert.equal((await base({},{origin:'https://shop.example.evil.example'})).reason,'signer_unpublished');
  assert.equal((await base({},{caps:{merchant:{...caps.merchant,origin:'http://shop.example'}}})).reason,'signer_unpublished');
  assert.equal(publishedSigner({merchant:{origin:'https://shop.example',expectedSigner:'nope'}},ORIGIN),null);});
test('expired / about to expire -> card',async()=>{
  assert.equal((await base({deadline:NOW+30})).reason,'order_expired');});
test('unbound payer (0x0) or another wallet -> card',async()=>{
  assert.equal((await base({payer:'0x0000000000000000000000000000000000000000'})).reason,'order_payer_unbound');
  assert.equal((await base({payer:evil.address})).reason,'order_for_other_payer');});
test('other chain / other adapter (e.g. the V5.2 adapter) -> card',async()=>{
  assert.equal((await base({chainId:8453})).reason,'order_domain_mismatch');
  assert.equal((await base({adapter:'0x05320bed08309f66316f7d73e2d0be110400fbb2'})).reason,'order_domain_mismatch');});
test('merchant not trusted yet (no grant / grant for another signer / other merchant / expired) -> card',async()=>{
  assert.equal((await base({},{grant:null})).reason,'signer_not_trusted');
  assert.equal((await base({},{grant:{...G,signers:[evil.address]}})).reason,'signer_not_trusted');
  assert.equal((await base({},{grant:{...G,merchant:merchantId('other.example')}})).reason,'signer_not_trusted');
  assert.equal((await base({},{grant:{...G,wallet:evil.address}})).reason,'signer_not_trusted');
  assert.equal((await base({},{grant:{...G,expiry:NOW+10}})).reason,'grant_expired');});
test('over the trust cap or the owner everyday limits -> card',async()=>{
  assert.equal((await base({amount:7_000_000n})).reason,'over_trust_single');
  assert.equal((await base({},{everyday:{single:'4000000',leftToday:'20000000'}})).reason,'over_everyday_single');
  assert.equal((await base({},{everyday:{single:'6000000',leftToday:'5000000'}})).reason,'over_everyday_today');});
test('replay: an order already paid on chain -> card (chain + ledger refuse it too)',async()=>{
  assert.equal((await base({},{orderUsed:async()=>true})).reason,'order_already_paid');});
test('merchant says not signed (available:false) -> card, standard order unchanged',async()=>{
  const r=await decide({env:{KIPURSE_V54_SIGNER_TRUST:'1'},suite:'v5.4',wallet:WALLET,adapter:ADAPTER,chainId:CHAIN,nowS:NOW,origin:ORIGIN,caps,
    paymentRequest:{},signedOrder:{available:false,reason:'SIGNED_ORDER_NOT_CONFIGURED'},grant:G});
  assert.equal(r.route,'card');assert.match(r.reason,/^signed_order_unavailable/);
  assert.equal(normalizeSignedOrder(null).code,'signed_order_missing');});
test('grant store keeps one grant per wallet + merchant; calldata encodes',async()=>{
  const m=new Map();const s=createGrantStore({get:k=>m.get(k),set:(k,v)=>m.set(k,v),delete:k=>m.delete(k)});
  s.put(G);assert.equal(s.get(WALLET,G.merchant).signers[0],shop.address);s.drop(WALLET,G.merchant);assert.equal(s.get(WALLET,G.merchant),null);
  const r=await base();const cd=encodePaySignedTrusted({permission:{account:WALLET,spender:ADAPTER,token:WALLET,allowance:1n,period:1,start:1,end:2,salt:1n,extraData:'0x'},
    order:r.order,signature:r.signature,grant:'0x00',txDeadline:NOW+200});assert.match(cd,/^0x[0-9a-f]+$/);});
