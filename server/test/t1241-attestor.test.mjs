// t1241 (handbook §6#111 ⑤): the per-domain attestor ("担保"). It signs a V5.4 PaymentOrder only after its OWN re-check with the merchant
// (same deposit address / amount / payable / not expired / same expiry), the merchant's published-signer evidence, the pause list and its
// chain / adapter / ceiling rules. Keys: one per domain, encrypted at rest, file mode 0600, dir 0700.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {recoverTypedDataAddress,getAddress,keccak256,toBytes} from 'viem';
import {createAttestor,attestorOrderId,validDomain,ATTEST_MAX_TTL_SEC} from '../src/v5/attestor.mjs';import {createAttestorClient} from '../src/v5/attestor-client.mjs';
import {startAttestorServer} from '../mainnet/attestor-server.mjs';import {verifyMerchantSignature,declaredDomain} from '../src/v5/merchant-sig.mjs';
import {mockMerchant,OLD_ADAPTER} from './helpers/t1241-merchant.mjs';
const A54='0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa',WALLET='0xc44Cf075a58Df30B7c63b114CdF6784376009E0b';
const TYPES={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},{name:'adapter',type:'address'},{name:'payer',type:'address'}]};
const mk=(M,o={})=>{const dir=join(mkdtempSync(join(tmpdir(),'t1241a-')),'keys');return {dir,A:createAttestor({keyDir:dir,dataKey:randomBytes(32),chainId:8453,adapters:[A54],fetch:M.fetch,resolveHost:async()=>[{address:'93.184.216.34'}],usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',...o})};};
const order=async(M,bid=1)=>{const pid='p-'+Math.random().toString(36).slice(2,12);await M.fetch(M.origin+'/api/v1/agent/usdc-orders',{method:'POST',body:JSON.stringify({purchaseId:pid,listingId:'l',ownerToken:M.token,targetBid:bid,board:'all',signedOrder:true})});return M.orders.get(pid);};
const req=(M,o,x={})=>({domain:M.host,ref:o.paymentIntentId,purchaseId:o.purchaseId,statusUrl:M.origin+o.statusUrl,payee:o.depositAddress,amountAtomic:o.amountAtomic,expiresAt:o.expiresAt,payer:WALLET,chainId:8453,adapter:A54,merchantSignedOrder:o.signedOrder,...x});

test('signs the exact V5.4 PaymentOrder digest: domain AgentWalletPaymentOrder/5/chain/V5.4 adapter, orderId = keccak(domain:ref), deadline = min(expiry, now+15min), payer = wallet',async()=>{
  const M=mockMerchant();const {A}=mk(M);const o=await order(M);const r=await A.attest(req(M,o));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.merchantSigned,true);
  const so=r.signedOrder;assert.equal(so.signer,await A.address(M.host));assert.equal(so.orderId,keccak256(toBytes(M.host+':'+o.paymentIntentId)));assert.equal(so.orderId,attestorOrderId(M.host,o.paymentIntentId));
  assert.ok(so.deadline<=o.expiresAt&&so.deadline<=Math.floor(Date.now()/1000)+ATTEST_MAX_TTL_SEC);assert.equal(getAddress(so.payer),getAddress(WALLET));assert.equal(getAddress(so.adapter),getAddress(A54));
  const rec=await recoverTypedDataAddress({domain:{name:'AgentWalletPaymentOrder',version:'5',chainId:8453,verifyingContract:A54},types:TYPES,primaryType:'PaymentOrder',
    message:{payee:so.payee,amount:BigInt(so.amount),orderId:so.orderId,deadline:BigInt(so.deadline),chainId:8453n,adapter:so.adapter,payer:so.payer},signature:so.signature});
  assert.equal(rec,so.signer);});
test('one key per domain, stable across restarts, encrypted at rest (0600 file in a 0700 dir; no plaintext key)',async()=>{
  const M=mockMerchant(),M2=mockMerchant({host:'other.example'});const dk=randomBytes(32);const dir=join(mkdtempSync(join(tmpdir(),'t1241k-')),'keys');
  const A=createAttestor({keyDir:dir,dataKey:dk,chainId:8453,adapters:[A54],fetch:M.fetch});const a1=await A.address(M.host),a2=await A.address(M2.host);assert.notEqual(a1,a2);
  const B=createAttestor({keyDir:dir,dataKey:dk,chainId:8453,adapters:[A54],fetch:M.fetch});assert.equal(await B.address(M.host),a1);
  assert.equal(fs.statSync(dir).mode&0o777,0o700);const f=join(dir,'attestor54-'+M.host+'.json');assert.equal(fs.statSync(f).mode&0o777,0o600);assert.doesNotMatch(fs.readFileSync(f).toString('latin1'),/privateKey|0x[0-9a-f]{64}/);
  assert.throws(()=>createAttestor({keyDir:dir,chainId:8453,adapters:[A54]}),/data key is required/);
  await assert.rejects(()=>A.address('Bad_Domain'),/bad_domain/);assert.equal(validDomain('127.0.0.1'),false);assert.equal(validDomain('shop.example'),true);});
test('refuses: different deposit address on the merchant re-check, amount mismatch, expired, not payable, expiry mismatch, other ref',async()=>{
  const M=mockMerchant();const {A}=mk(M);const o=await order(M);
  M.statusAddress='0x1111111111111111111111111111111111111111';assert.equal((await A.attest(req(M,o))).code,'deposit_address_mismatch');M.statusAddress=null;
  assert.equal((await A.attest(req(M,o,{amountAtomic:'2000000'}))).code,'amount_mismatch');
  assert.equal((await A.attest(req(M,o,{expiresAt:o.expiresAt+60}))).code,'expiry_mismatch');
  assert.equal((await A.attest(req(M,o,{ref:'pi_other',purchaseId:'other'}))).code,'order_ref_mismatch');
  M.statusOverride='fulfilled';assert.equal((await A.attest(req(M,o))).code,'order_not_payable');M.statusOverride=null;
  const o2=await order(M);o2.expiresAt=Math.floor(Date.now()/1000)+30;assert.equal((await A.attest(req(M,o2))).code,'order_expired');});
test('refuses: paused domain (until resumed), wrong chain, adapter not allowed, payer 0, status URL on another host / http, above the ceiling',async()=>{
  const M=mockMerchant();const {A}=mk(M,{maxAmountAtomic:5_000_000n});const o=await order(M);
  await A.pause(M.host,'merchant_did_not_confirm');assert.equal((await A.attest(req(M,o))).code,'domain_paused');assert.equal((await A.paused(M.host)).reason,'merchant_did_not_confirm');
  await A.resume(M.host);assert.equal((await A.attest(req(M,o))).ok,true);
  assert.equal((await A.attest(req(M,o,{chainId:84532}))).code,'wrong_chain');
  assert.equal((await A.attest(req(M,o,{adapter:OLD_ADAPTER}))).code,'adapter_not_allowed');
  assert.equal((await A.attest(req(M,o,{payer:'0x0000000000000000000000000000000000000000'}))).code,'bad_payer');
  assert.equal((await A.attest(req(M,o,{statusUrl:'https://evil.example'+o.statusUrl}))).code,'status_url_not_merchant');
  assert.equal((await A.attest(req(M,o,{statusUrl:'http://'+M.host+o.statusUrl}))).code,'status_url_not_merchant');
  const big=await order(M,6);assert.equal((await A.attest(req(M,big))).code,'over_attestor_ceiling');});
test('evidence: a merchant that publishes a signer must sign this order (missing / unpublished key -> refused); an unsigned merchant is attested as unsigned',async()=>{
  const M=mockMerchant();const {A}=mk(M);const o=await order(M);
  assert.equal((await A.attest(req(M,o,{merchantSignedOrder:undefined}))).code,'merchant_signature_missing');
  M.badSig=true;const ob=await order(M);M.badSig=false;assert.equal((await A.attest(req(M,ob))).code,'merchant_signer_not_published');
  const U=mockMerchant({host:'plain.example',signed:false});const {A:AU}=mk(U);const ou=await order(U);const r=await AU.attest(req(U,ou));assert.equal(r.ok,true);assert.equal(r.merchantSigned,false);});
test('merchant signature: ExampleShop form (other verifying contract, payer 0) verifies against the published signer, same payee / amount only; generic typed data too',async()=>{
  const M=mockMerchant();const o=await order(M);const decl={type:'EIP-712 AgentWalletPaymentOrder v5',domainVersion:'5',verifyingContract:OLD_ADAPTER};
  assert.deepEqual(declaredDomain(decl),{name:'AgentWalletPaymentOrder',version:'5'});
  const base={so:o.signedOrder,expectedSigner:M.signer,payee:o.depositAddress,amountAtomic:o.amountAtomic,chainId:8453,declared:decl,nowS:Math.floor(Date.now()/1000),wallet:WALLET};
  assert.equal((await verifyMerchantSignature(base)).ok,true);
  assert.equal((await verifyMerchantSignature({...base,payee:'0x2222222222222222222222222222222222222222'})).code,'merchant_signature_other_payee');
  assert.equal((await verifyMerchantSignature({...base,amountAtomic:'7'})).code,'merchant_signature_other_amount');
  assert.equal((await verifyMerchantSignature({...base,expectedSigner:'0x3333333333333333333333333333333333333333'})).code,'merchant_signer_not_published');
  assert.equal((await verifyMerchantSignature({...base,declared:{...decl,verifyingContract:A54}})).code,'merchant_signature_other_contract');
  assert.equal((await verifyMerchantSignature({...base,so:{...o.signedOrder,amountAtomic:'2000000'}})).ok,false,'tampered field breaks the signature');
  assert.equal((await verifyMerchantSignature({...base,so:null})).code,'merchant_signature_missing');
  const {privateKeyToAccount,generatePrivateKey}=await import('viem/accounts');const k=privateKeyToAccount(generatePrivateKey());
  const td={domain:{name:'Shop',version:'1',chainId:8453},types:{Order:[{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'deadline',type:'uint256'}]},primaryType:'Order',message:{to:o.depositAddress,value:o.amountAtomic,deadline:String(o.expiresAt)}};
  const sig=await k.signTypedData({...td,message:{to:o.depositAddress,value:BigInt(o.amountAtomic),deadline:BigInt(o.expiresAt)}});
  assert.equal((await verifyMerchantSignature({...base,expectedSigner:k.address,so:{typedData:td,signature:sig}})).ok,true);});
test('separate service: unix-socket server + client expose the same API (address / attest / pause / resume)',async()=>{
  const M=mockMerchant();const {A}=mk(M);const sock=join(mkdtempSync(join(tmpdir(),'t1241s-')),'a.sock');const S=await startAttestorServer({attestor:A,socket:sock});
  try{assert.equal(fs.statSync(sock).mode&0o777,0o660);const C=createAttestorClient({socketPath:sock});assert.equal(await C.address(M.host),await A.address(M.host));
    const o=await order(M);const r=await C.attest(req(M,o));assert.equal(r.ok,true);assert.equal(r.signedOrder.signer,await A.address(M.host));
    await C.pause(M.host,'x');assert.equal((await C.attest(req(M,o))).code,'domain_paused');await C.resume(M.host);assert.equal(await C.paused(M.host),null);
    assert.throws(()=>createAttestorClient({url:'http://10.0.0.1:1'}),/loopback only/);}
  finally{await S.close();}});
