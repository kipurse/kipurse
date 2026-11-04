// SPDX-License-Identifier: AGPL-3.0-only
// Kipurse agent HTTP interface over the V5 engine. Idempotency-Key REQUIRED on paying POSTs. Auth as in V4.
import {createServer} from 'node:http';import {resolveAgent} from '../v4/agents.mjs';
const send=(res,code,obj)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(obj,(k,v)=>typeof v==='bigint'?v.toString():v));};
export function createV5HttpServer(engine,{agentTokens,agents}={}){
  return createServer(async(req,res)=>{
    try{
      let agentId=String(req.headers['x-agent-id']??'');const bearer=String(req.headers.authorization??'').replace(/^Bearer /,'');
      if(agents){const a=resolveAgent(agents,bearer);if(!a)return send(res,401,{error:'unauthorized'});agentId=a.id;}
      else if(agentTokens){agentId=agentTokens[bearer];if(!agentId)return send(res,401,{error:'unauthorized'});}
      if(!/^[A-Za-z0-9._-]{1,64}$/.test(agentId))return send(res,400,{error:'X-Agent-Id required'});
      const url=new URL(req.url,'http://x');const q=Object.fromEntries(url.searchParams);
      if(req.method==='GET'){
        if(url.pathname==='/v1/status')return send(res,200,await engine.status());
        if(url.pathname==='/v1/limits')return send(res,200,await engine.limits({agentId}));
        if(url.pathname==='/v1/merchants')return send(res,200,await engine.merchantInfo(q));
        if(url.pathname==='/v1/purchases')return send(res,200,engine.listPurchases({since:q.since?Number(q.since):0,state:q.state,agentId:q.mine==='1'?agentId:undefined,limit:q.limit?Number(q.limit):50}));
        if(url.pathname.startsWith('/v1/purchases/')){const r=engine.ledger.get(url.pathname.split('/').pop());return r?send(res,200,r):send(res,404,{error:'not_found'});}
        return send(res,404,{error:'not_found'});
      }
      if(req.method!=='POST')return send(res,404,{error:'not_found'});
      let raw='';for await(const ch of req){raw+=ch;if(raw.length>1e6)return send(res,413,{error:'too_large'});}
      let b;try{b=JSON.parse(raw||'{}');}catch{return send(res,400,{error:'bad_json'});}
      const idempotencyKey=req.headers['idempotency-key'];let out;
      switch(url.pathname){
        case '/v1/fetch':out=await engine.paidFetch({agentId,order:b.order,intentId:b.intentId,repeatKey:b.repeatKey,url:b.url,method:b.method,headers:b.headers,body:b.body,maxAmount:b.maxAmount,idempotencyKey});break;
        case '/v1/merchant-order/pay':out=await engine.payMerchantOrder({agentId,origin:b.origin,orderParams:b.orderParams,merchantPurchaseId:b.merchantPurchaseId,signedOrder:b.signedOrder===true,intentId:b.intentId,repeatKey:b.repeatKey,maxAmount:b.maxAmount,idempotencyKey});break;
        case '/v1/merchant-order/discover':{const d=await engine.discoverMerchant(b.origin).catch(e=>({error:e.code??'discovery_failed',detail:e.detail}));out=JSON.parse(JSON.stringify(d,(k,v)=>typeof v==='bigint'?v.toString():v));break;}
        case '/v1/setup':out=await engine.setup({answers:b.answers});break;
        case '/v1/limits/set':out=await engine.setLimits({agentId,changes:b.changes});break;
        case '/v1/trust/propose':out=b.payee?await engine.requestTrustFromOwner({agentId,merchantName:b.merchantName??b.domain??'payee '+String(b.payee).slice(0,10),payee:b.payee,chain:b.chain,single:b.single,total:b.daily??b.total,expiresInDays:b.expiresInDays,reason:b.reason}):{state:'rejected',reason:'payee_required'};break;
        case '/v1/trust/request-owner':out=await engine.requestTrustFromOwner({agentId,merchantName:b.merchantName,payee:b.payee,chain:b.chain,single:b.single,total:b.total,expiresInDays:b.expiresInDays,reason:b.reason});break;
        case '/v1/trust/request-status':out=await engine.trustRequestStatus({id:b.id});break;
        case '/v1/trust/list':out=await engine.trustList();break;
        case '/v1/deposit/info':out=await engine.depositInfo();break;
        case '/v1/deposits':out=await engine.deposits();break;
        case '/v1/withdraw/request':out=await engine.requestWithdrawal({agentId,amount:b.amount});break;
        case '/v1/withdraw/execute':out=await engine.executeWithdrawal({agentId,withdrawalId:b.withdrawalId});break;
        case '/v1/pay-any':out=await engine.payAny({agentId,order:b.order,payment:b.payment,merchant:b.merchant,orderRef:b.orderRef,expiresAt:b.expiresAt,allowSameAmount:b.allowSameAmount===true,signedOrderUrl:b.signedOrderUrl,intentId:b.intentId,repeatKey:b.repeatKey,maxAmount:b.maxAmount,ownerApproval:b.ownerApproval,idempotencyKey});break;
        case '/v1/parse-any':return send(res,200,await engine.parseAny({payment:b.payment,merchant:b.merchant,orderRef:b.orderRef,expiresAt:b.expiresAt,intentId:b.intentId,repeatKey:b.repeatKey}));
        case '/v1/pay':out=await engine.pay({agentId,order:b.order,intentId:b.intentId,repeatKey:b.repeatKey,request:b.request,parsedId:b.parsedId,maxAmount:b.maxAmount,ownerApproval:b.ownerApproval,idempotencyKey});break;
        case '/v1/parse':return send(res,200,await engine.parse(b.request,{intentId:b.intentId,repeatKey:b.repeatKey}));
        case '/v1/preflight':return send(res,200,await engine.preflight(b.parsedId?{parsedId:b.parsedId}:b.request,{agentId,intentId:b.intentId,repeatKey:b.repeatKey,ownerApproval:b.ownerApproval}));
        case '/v1/claims':return send(res,200,engine.claimPurchase({agentId,intentId:b.intentId,lineKey:b.lineKey,ttlSec:b.ttlSec,note:b.note}));
        case '/v1/approval/request':return send(res,200,await engine.approvalRequest(b.parsedId?{parsedId:b.parsedId}:b.request,{intentId:b.intentId,repeatKey:b.repeatKey}));
        case '/v1/trust/request':return send(res,200,await engine.trustRequest(b));
        case '/v1/trust/submit':return send(res,403,{error:'owner_only',detail:'trust is added only by the owner on the owner app/page (kipurse_request_trust)'});
        case '/v1/untrust/request':return send(res,200,await engine.untrustRequest(b));
        case '/v1/deny-signer/request':return send(res,200,await engine.denySignerRequest({signer:b.signer}));
        case '/v1/deny-signer/submit':return send(res,200,await engine.denySignerSubmit({signer:b.signer,nonce:b.nonce,deadline:b.deadline,signature:b.signature}));
        case '/v1/untrust/submit':return send(res,200,await engine.untrustSubmit(b));
        case '/v1/pause':return send(res,200,await engine.pause());
        case '/v1/maintenance/settle':return send(res,200,await engine.settleRoutine());
        case '/v1/reports/csv':{const r=engine.exportCsv({from:b.from,to:b.to,tz:b.tz});res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="kipurse-'+(b.from??'all').slice(0,10)+'.csv"','x-kipurse-rows':String(r.rows)});return res.end(r.csv);}
        case '/v1/reports/annual':return send(res,200,engine.annualSummary(b.year,{tz:b.tz}));
        case '/v1/receipt':return send(res,200,engine.receipt(b.purchaseKey,{tz:b.tz}));
        case '/v1/exit/plan':return send(res,200,await engine.exitPlan());
        case '/v1/exit/gas-settled':return send(res,200,await engine.recordGasSettlement(b.txHash));
        case '/v1/float/status':return send(res,200,await engine.floatStatus());
        case '/v1/float/fund':return send(res,200,await engine.floatFund({amount:b.amount,hours:b.hours}));
        case '/v1/float/reconcile':return send(res,200,await engine.floatReconcile());
        case '/v1/maintenance/collect-fees':return send(res,200,await engine.collectFees());
        default:return send(res,404,{error:'not_found'});
      }
      send(res,out.state==='rejected'?(out.reason?.startsWith('idempotency')?409:422):200,out);
    }catch(e){send(res,500,{error:String(e.shortMessage??e.message).slice(0,200)});}
  });
}
