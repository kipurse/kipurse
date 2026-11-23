// SPDX-License-Identifier: AGPL-3.0-only
// t1241 (handbook §6#111 ③, layered merchant trust): verify the merchant's OWN order signature, in whatever EIP-712 form its public
// capabilities declare, without asking the merchant to change anything for Kipurse. The signature is EVIDENCE only (never sent on chain):
// the signer must be the one the merchant publishes on its own https origin (capabilities.merchant.expectedSigner) and the signed
// payee / amount must be exactly the deposit address / amount of the order response. Any verifyingContract and payer 0 are fine here
// (e.g. ExampleShop signs "AgentWalletPaymentOrder v5" for an old Kipurse adapter with payer 0): Kipurse's own attestor signs what is paid.
// Used by the gateway (engine) AND, independently, by the attestor service.
import {recoverTypedDataAddress,getAddress,isAddress} from 'viem';
const lc=s=>String(s??'').toLowerCase();
const ZERO='0x0000000000000000000000000000000000000000';
export const AWPO_TYPES={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},{name:'adapter',type:'address'},{name:'payer',type:'address'}]};
/** "EIP-712 AgentWalletPaymentOrder v5" -> {name, version}; null when the text is not of that form */
export function declaredDomain(decl){const m=/EIP-?712\s+([A-Za-z][A-Za-z0-9_]{0,63})\s+v(\d{1,4})\b/i.exec(String(decl?.type??decl?.paymentOrder??''));
  const name=m?m[1]:null,version=decl?.domainVersion??decl?.paymentOrderDomainVersion??(m?m[2]:null);return name&&version!=null?{name,version:String(version)}:null;}
const PAYEE_KEYS=['payee','to','depositAddress','recipient','payTo'],AMOUNT_KEYS=['amount','amountAtomic','value'];
const pick=(o,ks)=>{for(const k of ks)if(o?.[k]!==undefined&&o[k]!==null)return o[k];return undefined;};
/**
 * so: the order response's signedOrder object. Two shapes are understood:
 *   (a) AgentWalletPaymentOrder DTO {signer,payee,amountAtomic,orderId,orderDeadline,chainId,adapter,payer,signature}, domain from `declared`
 *       (capabilities signedOrder: type "EIP-712 <Name> v<N>", verifyingContract) - verifyingContract must equal the declared one when declared;
 *   (b) generic {typedData:{domain,types,primaryType,message}, signature} whose message names the payee and the amount.
 * Returns {ok:true, signer, format, deadline?} or {ok:false, code}. Never throws.
 */
export async function verifyMerchantSignature({so,expectedSigner,payee,amountAtomic,chainId,declared,nowS,wallet}){
  try{
    if(!expectedSigner||!isAddress(String(expectedSigner),{strict:false}))return {ok:false,code:'no_published_signer'};
    if(!so||typeof so!=='object'||so.available===false)return {ok:false,code:'merchant_signature_missing'};
    const sig=String(so.signature??'');if(!/^0x[0-9a-fA-F]{130}$/.test(sig))return {ok:false,code:'merchant_signature_missing'};
    let rec,msgPayee,msgAmount,deadline=null,format,msgChain=null,payer=null;
    if(so.typedData&&typeof so.typedData==='object'){const t=so.typedData;format='typed_data';
      if(!t.domain||!t.types||!t.primaryType||!t.message)return {ok:false,code:'merchant_signature_malformed'};
      const types={...t.types};delete types.EIP712Domain;
      rec=await recoverTypedDataAddress({domain:t.domain,types,primaryType:t.primaryType,message:t.message,signature:sig});
      msgPayee=pick(t.message,PAYEE_KEYS);msgAmount=pick(t.message,AMOUNT_KEYS);msgChain=t.domain.chainId??t.message.chainId??null;
      const dl=t.message.deadline??t.message.expiresAt??t.message.orderDeadline;if(dl!=null&&/^\d+$/.test(String(dl)))deadline=Number(dl);payer=t.message.payer??null;}
    else{format='agent_wallet_payment_order';const dom=declaredDomain(declared)??{name:'AgentWalletPaymentOrder',version:'5'};
      for(const k of ['payee','adapter'])if(!isAddress(String(so[k]??''),{strict:false}))return {ok:false,code:'merchant_signature_malformed'};
      if(!/^0x[0-9a-fA-F]{64}$/.test(String(so.orderId??''))||!/^[0-9]+$/.test(String(so.amountAtomic??so.amount??''))||!/^\d+$/.test(String(so.orderDeadline??so.deadline??''))||!/^\d+$/.test(String(so.chainId??'')))return {ok:false,code:'merchant_signature_malformed'};
      if(declared?.verifyingContract&&lc(declared.verifyingContract)!==lc(so.adapter))return {ok:false,code:'merchant_signature_other_contract'};
      payer=so.payer&&isAddress(String(so.payer),{strict:false})?getAddress(lc(so.payer)):ZERO;
      const message={payee:getAddress(lc(so.payee)),amount:BigInt(so.amountAtomic??so.amount),orderId:so.orderId,deadline:BigInt(so.orderDeadline??so.deadline),chainId:BigInt(so.chainId),adapter:getAddress(lc(so.adapter)),payer};
      rec=await recoverTypedDataAddress({domain:{name:dom.name,version:dom.version,chainId:Number(so.chainId),verifyingContract:message.adapter},types:AWPO_TYPES,primaryType:'PaymentOrder',message,signature:sig});
      msgPayee=message.payee;msgAmount=message.amount;msgChain=so.chainId;deadline=Number(message.deadline);}
    rec=getAddress(rec);
    if(so.signer&&isAddress(String(so.signer),{strict:false})&&lc(so.signer)!==lc(rec))return {ok:false,code:'merchant_signature_invalid'};
    if(lc(rec)!==lc(expectedSigner))return {ok:false,code:'merchant_signer_not_published'};
    if(lc(msgPayee)!==lc(payee))return {ok:false,code:'merchant_signature_other_payee'};
    if(msgAmount===undefined||BigInt(String(msgAmount))!==BigInt(String(amountAtomic)))return {ok:false,code:'merchant_signature_other_amount'};
    if(msgChain!=null&&chainId!=null&&Number(msgChain)!==Number(chainId))return {ok:false,code:'merchant_signature_other_chain'};
    if(deadline!=null&&nowS!=null&&deadline<=Number(nowS))return {ok:false,code:'merchant_signature_expired'};
    if(payer&&lc(payer)!==lc(ZERO)&&wallet&&lc(payer)!==lc(wallet))return {ok:false,code:'merchant_signature_other_payer'};
    return {ok:true,signer:rec,format,deadline};
  }catch{return {ok:false,code:'merchant_signature_invalid'};}
}
