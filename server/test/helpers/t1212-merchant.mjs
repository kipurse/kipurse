// t1212 decision 97: in-memory merchant with the recorded ExampleShop PUBLIC docs shape (t1204 fixture), adapted to the test chain. Never the real merchant.
import fs from 'node:fs';import {USDC} from './v5-fixture.mjs';
const F=JSON.parse(fs.readFileSync(new URL('../fixtures/t1204-example-shop-shape.json',import.meta.url)));
const MAIN_USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const swap=o=>JSON.parse(JSON.stringify(o).split(MAIN_USDC).join(USDC).split('"chainId": 8453').join('"chainId": 84532').split('"chainId":8453').join('"chainId":84532'));
export function merchantMock({payee,amountAtomic='5000000',origin='https://shop-example.mock'}={}){const orders=new Map();const calls=[];const M={amountAtomic,payee};
  const caps=swap(F.capabilities),api=swap(F.openapi);
  const res=(status,b)=>({ok:status<300,status,headers:new Map([['content-type','application/json']]),json:async()=>b,text:async()=>JSON.stringify(b)});
  const fetch=async(u,init={})=>{const url=new URL(u);const p=url.pathname;calls.push({method:init.method??'GET',path:p});
    if(p==='/openapi.json')return res(200,api);if(p==='/api/v1/agent/capabilities')return res(200,caps);
    if(p==='/api/v1/agent/usdc-orders'&&init.method==='POST'){const b=JSON.parse(init.body);const id=b.purchaseId;
      if(!orders.has(id))orders.set(id,{purchaseId:id,paymentIntentId:'pi_'+id,status:'open',chainId:84532,tokenContract:USDC,depositAddress:M.payee,amountAtomic:M.amountAtomic,
        amountUsdc:(Number(M.amountAtomic)/1e6).toString(),expiresAt:new Date(Date.now()+1500e3).toISOString(),statusUrl:'/api/v1/agent/usdc-orders/'+id});
      return res(201,orders.get(id));}
    if(p.startsWith('/api/v1/agent/usdc-orders/'))return res(200,{...orders.get(p.split('/').pop()),status:'processing'});
    return res(404,{error:'NOT_FOUND'});};
  return Object.assign(M,{fetch,orders,calls,origin});}
