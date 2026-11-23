// t1241 (handbook §6#111): a ExampleShop-shaped merchant for unit tests (no network). It changes NOTHING for Kipurse: it publishes its own signer
// (optional), signs "EIP-712 AgentWalletPaymentOrder v5" for an OLD Kipurse adapter with payer 0 when asked (signedOrder:true), and issues a
// NEW deposit address per order. Knobs: signed, badSig (sign with an unpublished key), noSig, statusAddress (status returns another
// address), status (status string), confirm (status after payment).
import {readFileSync} from 'node:fs';import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import {keccak256,toHex} from 'viem';
export const MUSDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',OLD_ADAPTER='0x05320bed08309f66316f7d73e2d0be110400fbb2';
const F=JSON.parse(readFileSync(new URL('../fixtures/t1204-example-shop-shape.json',import.meta.url),'utf8'));
const AW={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},{name:'adapter',type:'address'},{name:'payer',type:'address'}]};
export function mockMerchant({host='shop.example',signed=true,now=()=>Math.floor(Date.now()/1000)}={}){
  const origin='https://'+host;const key=privateKeyToAccount(generatePrivateKey()),evil=privateKeyToAccount(generatePrivateKey());
  const M={host,origin,signer:key.address,signed,badSig:false,noSig:false,statusAddress:null,statusOverride:null,orders:new Map(),paid:new Set(),seen:[],token:'tok-'+Math.random().toString(36).slice(2)};
  const caps=()=>{const c=JSON.parse(JSON.stringify(F.capabilities));if(M.signed)c.merchant={name:'Shop',origin,expectedSigner:key.address};return c;};
  const res=(code,body)=>new Response(JSON.stringify(body),{status:code,headers:{'content-type':'application/json'}});
  M.fetch=async(url,opts={})=>{const u=new URL(String(url));if(u.host!==host)return res(404,{error:'other host'});
    if(u.pathname==='/openapi.json')return res(200,F.openapi);if(u.pathname==='/api/v1/agent/capabilities')return res(200,caps());
    if(opts.method==='POST'&&u.pathname==='/api/v1/agent/usdc-orders'){const b=JSON.parse(opts.body??'{}');M.seen.push(b);if(b.ownerToken!==M.token)return res(403,{error:'NOT_LISTING_OWNER'});
      if(!M.orders.has(b.purchaseId)){const t=now();const dep=privateKeyToAccount(generatePrivateKey()).address;const cents=Number(b.targetBid)*100;
        const o={purchaseId:b.purchaseId,paymentIntentId:'pi_'+b.purchaseId.slice(0,12),status:'open',network:'base',chainId:8453,token:'USDC',tokenContract:MUSDC,depositAddress:dep,amountAtomic:String(cents*10000),amountUsdc:(cents/100).toFixed(2),amountCents:cents,expiresAt:t+900,statusUrl:'/api/v1/agent/usdc-orders/'+b.purchaseId};
        if(b.signedOrder===true&&M.signed&&!M.noSig){const s=M.badSig?evil:key;const orderId=keccak256(toHex('exampleshop:'+o.paymentIntentId));const msg={payee:dep,amount:BigInt(o.amountAtomic),orderId,deadline:BigInt(t+900),chainId:8453n,adapter:OLD_ADAPTER,payer:'0x0000000000000000000000000000000000000000'};
          o.signedOrder={available:true,signer:s.address,payee:dep,amountAtomic:o.amountAtomic,orderId,orderDeadline:t+900,chainId:8453,adapter:OLD_ADAPTER,payer:msg.payer,
            signature:await s.signTypedData({domain:{name:'AgentWalletPaymentOrder',version:'5',chainId:8453,verifyingContract:OLD_ADAPTER},types:AW,primaryType:'PaymentOrder',message:msg})};}
        M.orders.set(b.purchaseId,o);}
      return res(200,{...M.orders.get(b.purchaseId),listingId:b.listingId,board:b.board,targetBid:b.targetBid});}
    if(u.pathname.startsWith('/api/v1/agent/usdc-orders/')){const pid=decodeURIComponent(u.pathname.split('/').pop());const o=M.orders.get(pid);if(!o)return res(404,{error:'ORDER_NOT_FOUND'});
      const st=M.statusOverride??(M.paid.has(pid)?(M.confirm??'fulfilled'):'open');return res(200,{purchaseId:pid,paymentIntentId:o.paymentIntentId,status:st,depositAddress:M.statusAddress??o.depositAddress,amountAtomic:o.amountAtomic,expiresAt:o.expiresAt,chainId:8453,tokenContract:MUSDC});}
    return res(404,{error:'not_found'});};
  M.last=()=>[...M.orders.values()].at(-1);
  return M;}
