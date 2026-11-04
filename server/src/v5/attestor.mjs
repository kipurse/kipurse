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
