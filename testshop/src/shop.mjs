// Kipurse Test Shop core: catalog, ExampleShop-shaped USDC order API, payment detection on Base, test switches, sweep scheduling.
// It is an ORDINARY merchant: no wallet-specific logic. All order state is in one JSON file (no secrets in it).
import fs from 'node:fs';import {randomBytes} from 'node:crypto';
import {keccak256,toBytes,getAddress} from 'viem';
import {CATALOG,ORDER_TTL_S,usdcStr,llmsTxt,capabilities,openapi,homePage} from './docs.mjs';
import {sweepOne,CIRCLE_PAYMASTER_V08} from './sweep.mjs';
export const USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ZERO='0x0000000000000000000000000000000000000000';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AW={PaymentOrder:[{name:'payee',type:'address'},{name:'amount',type:'uint256'},{name:'orderId',type:'bytes32'},{name:'deadline',type:'uint256'},{name:'chainId',type:'uint256'},{name:'adapter',type:'address'},{name:'payer',type:'address'}]};
export const DEFAULT_SWITCHES=Object.freeze({mode:'signed',swapAddress:false,neverConfirm:false,badSignature:false,noSignature:false});
const SWITCH_KEYS=Object.keys(DEFAULT_SWITCHES);
/** JSON state file with atomic replace (0600) */
export function jsonStore(file){let st=null;
  const load=()=>{if(st)return st;try{st=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;st={v:1,nextIndex:0,switches:{...DEFAULT_SWITCHES},orders:{},sweeps:[],lastAutoSweepAt:0};}
    st.switches={...DEFAULT_SWITCHES,...(st.switches??{})};st.orders??={};st.sweeps??=[];return st;};
  const save=()=>{const tmp=file+'.tmp-'+randomBytes(4).toString('hex');fs.writeFileSync(tmp,JSON.stringify(st),{mode:0o600});fs.renameSync(tmp,file);};
  return {get:load,save};}
/** pure: status from what arrived on chain. inTime / late = atomic sums of transfers before / after expiry. */
export function deriveStatus({amountAtomic,expiresAt,inTime=0n,late=0n,nowS}){const a=BigInt(amountAtomic),i=BigInt(inTime),l=BigInt(late);
  if(i===0n&&l===0n)return nowS<expiresAt?'open':'expired';if(l>0n)return 'review';return i===a?'paid':'review';}
/** simple fixed-window rate limiter */
function limiter(){const m=new Map();let sweepAt=Date.now();
  return (key,max,windowMs=60000)=>{const t=Date.now();if(t-sweepAt>windowMs*2){for(const [k,v] of m)if(t-v.t>windowMs)m.delete(k);sweepAt=t;}
    const v=m.get(key);if(!v||t-v.t>=windowMs){m.set(key,{t,n:1});return 0;}if(v.n>=max)return Math.ceil((v.t+windowMs-t)/1000);v.n++;return 0;};}
export function createShop({stateFile,keys,origin,chain,chainId=8453,nowS=()=>Math.floor(Date.now()/1000),refreshMinMs=4000,lateWatchS=3*86400,
  maxOpenOrders=200,limits={create:10,status:60,createGlobal:60},sweep={},log=()=>{}}){
  // Sweep destination: unset = sweeping off; anything set must be a real 20-byte address and never the zero address (would burn the USDC).
  if(sweep.to!==undefined&&sweep.to!==null&&sweep.to!==''&&(!/^0x[0-9a-fA-F]{40}$/.test(String(sweep.to))||/^0x0{40}$/i.test(String(sweep.to))))throw Error('SHOP_SWEEP_TO must be your own non-zero wallet address');
  const S=jsonStore(stateFile);S.get();
  const signer=keys.signer();const verifyingContract=signer.address;   // no contract involved: the domain's verifyingContract is the shop signer's address
  const rl=limiter();const inflight=new Map();const refreshing=new Map();
  const sw=()=>S.get().switches;
  const NOT_PAYMENT=new Set([CIRCLE_PAYMASTER_V08,...(sweep.notPaymentFrom??[])].map(a=>a.toLowerCase()));
  function orderView(o){const view={dtoVersion:'testshop.usdc-order.v1',purchaseId:o.purchaseId,orderId:o.orderId,status:publicStatus(o),network:'base',chainId,token:'USDC',tokenContract:USDC,
      depositAddress:o.depositAddress,amountAtomic:o.amountAtomic,amountUsdc:usdcStr(o.amountAtomic),amountCents:Number(BigInt(o.amountAtomic)/10000n),expiresAt:o.expiresAt,
      statusUrl:'/api/v1/agent/usdc-orders/'+o.purchaseId,item:o.item};return view;}
  /** status as shown to the public, with the test switches captured when the order was created */
  function publicStatus(o){const st=o.status??'open';if(o.flags?.neverConfirm&&st==='paid')return nowS()<o.expiresAt?'open':'expired';return st;}
  function statusView(o){const st=publicStatus(o);const dep=o.flags?.swapAddress?keys.swapAddress(o.index):o.depositAddress;
    return {dtoVersion:'testshop.usdc-order-status.v1',purchaseId:o.purchaseId,orderId:o.orderId,status:st,network:'base',chainId,token:'USDC',tokenContract:USDC,
      depositAddress:st==='open'||st==='paid'?dep:null,amountAtomic:o.amountAtomic,amountUsdc:usdcStr(o.amountAtomic),amountCents:Number(BigInt(o.amountAtomic)/10000n),expiresAt:o.expiresAt,
      receivedAtomic:(BigInt(o.chain?.inTime??0)+BigInt(o.chain?.late??0)).toString(),paidAt:st==='paid'?o.paidAt??null:null,txHashes:(o.chain?.txs??[]).map(t=>t.txHash),item:o.item};}
  async function signOrder(o,acct){const orderId=keccak256(toBytes('kipurse-testshop:'+o.purchaseId));
    const msg={payee:getAddress(o.depositAddress),amount:BigInt(o.amountAtomic),orderId,deadline:BigInt(o.expiresAt),chainId:BigInt(chainId),adapter:getAddress(verifyingContract),payer:ZERO};
    const signature=await acct.signTypedData({domain:{name:'AgentWalletPaymentOrder',version:'5',chainId,verifyingContract:getAddress(verifyingContract)},types:AW,primaryType:'PaymentOrder',message:msg});
    return {available:true,dtoVersion:'testshop.signed-order.v1',signer:acct.address,payee:msg.payee,token:USDC,amountAtomic:o.amountAtomic,orderId,orderDeadline:o.expiresAt,chainId,
      adapter:getAddress(verifyingContract),payer:ZERO,paymentOrderDomainVersion:'5',signature};}
  /** create (or replay) an order. body already validated. */
  async function createOrder({purchaseId,item,signedOrder}){const st=S.get();const pid=purchaseId.toLowerCase();
    const existing=st.orders[pid];
    if(existing){if(existing.item!==item)return {code:409,body:{error:'This purchaseId was already used for another item',code:'ORDER_TERMS_MISMATCH'}};
      const v=orderView(existing);if(signedOrder)v.signedOrder=existing.signedOrder??{available:false,reason:existing.flags?.mode==='signed'?'PURCHASE_CREATED_UNSIGNED':'SIGNED_ORDER_NOT_CONFIGURED'};return {code:200,body:v,replay:true};}
    if(inflight.has(pid))return inflight.get(pid);
    const p=(async()=>{const open=Object.values(st.orders).filter(o=>(o.status??'open')==='open'&&o.expiresAt>nowS()).length;
      if(open>=maxOpenOrders)return {code:503,body:{error:'Too many open orders, try again later',code:'TEMPORARILY_UNAVAILABLE',retryAfterSeconds:60}};
      const index=st.nextIndex;st.nextIndex=index+1;S.save();   // an index is never reused, even if this request fails below
      const c=CATALOG[item];const t=nowS();let createdBlock=null;try{createdBlock=Number(await chain.blockNumber());}catch{}
      const flags={...sw()};
      const o={purchaseId:pid,index,orderId:'ord_'+index,item,amountAtomic:c.amountAtomic.toString(),depositAddress:keys.deposit(index).address,createdAt:t,expiresAt:t+ORDER_TTL_S,
        createdBlock,flags,status:'open',chain:{inTime:'0',late:'0',txs:[],checkedBlock:createdBlock!=null?createdBlock-1:null,checkedAt:0},swept:'0'};
      if(signedOrder&&flags.mode==='signed'&&!flags.noSignature)o.signedOrder=await signOrder(o,flags.badSignature?keys.unpublished():signer);
      st.orders[pid]=o;S.save();log('order_created',{orderId:o.orderId,item,signed:!!o.signedOrder,flags:Object.entries(flags).filter(([k,v])=>k!=='mode'&&v).map(([k])=>k).join(',')||'-',mode:flags.mode});
      const v=orderView(o);if(signedOrder)v.signedOrder=o.signedOrder??{available:false,reason:'SIGNED_ORDER_NOT_CONFIGURED'};return {code:200,body:v};})();
    inflight.set(pid,p);try{return await p;}finally{inflight.delete(pid);}}
  /** look at the chain for one order (incremental log scan from the last checked block) */
  async function refresh(o,{force=false}={}){if(!force&&Date.now()-(o.chain?.checkedAt??0)<refreshMinMs)return o;
    if(refreshing.has(o.purchaseId))return refreshing.get(o.purchaseId);
    const p=(async()=>{try{const latest=Number(await chain.blockNumber());const c=o.chain;
        let from=c.checkedBlock!=null?c.checkedBlock+1:(o.createdBlock??latest-600);if(from<0)from=0;
        if(from<=latest){const tx=await chain.transfersTo(o.depositAddress,from,latest);let inT=BigInt(c.inTime),late=BigInt(c.late);
          for(const x of tx){if(NOT_PAYMENT.has(x.from.toLowerCase()))continue;/* paymaster gas refunds after a sweep are not customer payments */if(c.txs.some(y=>y.txHash===x.txHash&&y.logIndex===x.logIndex))continue;const ok=x.ts<=o.expiresAt;if(ok)inT+=x.value;else late+=x.value;
            c.txs.push({txHash:x.txHash,logIndex:x.logIndex,value:x.value.toString(),ts:x.ts,inTime:ok});if(c.txs.length>50)c.txs.splice(0,c.txs.length-50);}
          c.inTime=inT.toString();c.late=late.toString();c.checkedBlock=latest;}
        c.checkedAt=Date.now();const prev=o.status;o.status=deriveStatus({amountAtomic:o.amountAtomic,expiresAt:o.expiresAt,inTime:c.inTime,late:c.late,nowS:nowS()});
        if(o.status==='paid'&&!o.paidAt)o.paidAt=Math.max(...c.txs.filter(t=>t.inTime).map(t=>t.ts));
        if(prev!==o.status)log('order_status',{orderId:o.orderId,from:prev,to:o.status});S.save();}
      catch(e){log('chain_check_failed',{orderId:o.orderId,error:String(e?.shortMessage??e?.message??e).slice(0,120)});}
      return o;})();
    refreshing.set(o.purchaseId,p);try{return await p;}finally{refreshing.delete(o.purchaseId);}}
  async function getStatus(purchaseId){const o=S.get().orders[String(purchaseId).toLowerCase()];if(!o)return null;
    if(nowS()<o.expiresAt+lateWatchS)await refresh(o);else if((o.status??'open')==='open')o.status=deriveStatus({amountAtomic:o.amountAtomic,expiresAt:o.expiresAt,inTime:o.chain.inTime,late:o.chain.late,nowS:nowS()});
    return statusView(o);}
  /** background: watch open orders closely, finished ones for late money (every 10 min) for lateWatchS */
  async function tick(){const t=nowS();for(const o of Object.values(S.get().orders)){
      if(t<o.expiresAt+60)await refresh(o);else if(t<o.expiresAt+lateWatchS&&Date.now()-(o.chain?.checkedAt??0)>600e3)await refresh(o,{force:true});
      else if((o.status??'open')==='open'){o.status=deriveStatus({amountAtomic:o.amountAtomic,expiresAt:o.expiresAt,inTime:o.chain.inTime,late:o.chain.late,nowS:t});S.save();}}}
  function setSwitches(p){const st=S.get();const next={...st.switches};
    for(const [k,v] of Object.entries(p??{})){if(!SWITCH_KEYS.includes(k))throw Object.assign(Error('unknown switch '+k),{code:'UNKNOWN_SWITCH'});
      if(k==='mode'){if(!['signed','unsigned'].includes(v))throw Object.assign(Error('mode must be signed or unsigned'),{code:'BAD_SWITCH'});next.mode=v;}
      else{if(typeof v!=='boolean')throw Object.assign(Error(k+' must be true or false'),{code:'BAD_SWITCH'});next[k]=v;}}
    st.switches=next;S.save();log('switches_changed',next);return next;}
  // ---- sweep
  const SW={to:sweep.to||null,enabled:!!sweep.to&&!!sweep.rpc,autoMinAtomic:BigInt(sweep.autoMinAtomic??300000n),auto:sweep.auto!==false,minSendAtomic:BigInt(sweep.minSendAtomic??10000n),maxGasAtomic:BigInt(sweep.maxGasAtomic??50000n)};
  let sweeping=null;
  /** candidates: orders that received money (paid / review) and are not known to be empty; all=true: every order address */
  function candidates({all=false}={}){return Object.values(S.get().orders).filter(o=>all||(BigInt(o.chain?.inTime??0)+BigInt(o.chain?.late??0)>0n&&!o.drained));}
  async function balances({all=false}={}){/* bring every not-yet-drained order up to date first (the background tick may not have seen a payment yet) */
    for(const o of Object.values(S.get().orders))if(!o.drained&&nowS()<o.expiresAt+lateWatchS)await refresh(o,{force:true});
    const out=[];for(const o of candidates({all})){let b=null;try{b=await chain.balanceOf(o.depositAddress);}catch{}out.push({orderId:o.orderId,address:o.depositAddress,status:o.status,balance:b});}return out;}
  async function sweepAll({dryRun=false,all=false,reason='manual'}={}){if(!SW.enabled)return {ok:false,code:'SWEEP_NOT_CONFIGURED'};if(sweeping)return {ok:false,code:'SWEEP_BUSY'};
    sweeping=(async()=>{const st=S.get();const list=await balances({all});const results=[];
      for(const b of list){if(b.balance==null){results.push({orderId:b.orderId,state:'error',error:'balance_unreadable'});continue;}
        if(b.balance<=SW.minSendAtomic){results.push({orderId:b.orderId,address:b.address,state:'skipped',reason:'balance_too_small',balance:b.balance.toString()});continue;}
        if(dryRun){results.push({orderId:b.orderId,address:b.address,state:'would_sweep',balance:b.balance.toString()});continue;}
        const o=Object.values(st.orders).find(x=>x.orderId===b.orderId);
        try{const r=await sweepOne({pub:sweep.pub,rpc:sweep.rpc,owner:keys.deposit(o.index),to:SW.to,token:USDC,chainId,maxGasAtomic:SW.maxGasAtomic,minSendAtomic:SW.minSendAtomic,price:sweep.price,pollMs:sweep.pollMs,log});
          if(r.state==='swept'){o.swept=(BigInt(o.swept??0)+BigInt(r.sent)).toString();o.drained=true;}
          results.push({orderId:b.orderId,...r});}
        catch(e){results.push({orderId:b.orderId,address:b.address,state:'error',error:String(e?.shortMessage??e?.message??e).slice(0,240)});}}
      const rec={at:nowS(),reason,dryRun,all,to:SW.to,results};if(!dryRun){st.sweeps.push(rec);if(st.sweeps.length>200)st.sweeps.splice(0,st.sweeps.length-200);S.save();}
      log('sweep_done',{reason,dryRun,swept:results.filter(r=>r.state==='swept').length,errors:results.filter(r=>r.state==='error').length});return {ok:true,...rec};})();
    try{return await sweeping;}finally{sweeping=null;}}
  /** at most once a day, only when the sweepable balance is above autoMinAtomic */
  async function autoSweepCheck(){if(!SW.enabled||!SW.auto)return {ran:false,reason:'off'};const st=S.get();if(nowS()-(st.lastAutoSweepAt??0)<86400)return {ran:false,reason:'once_a_day'};
    const list=await balances();const total=list.reduce((a,b)=>a+(b.balance??0n),0n);if(total<=SW.autoMinAtomic)return {ran:false,reason:'below_threshold',total:total.toString()};
    st.lastAutoSweepAt=nowS();S.save();const r=await sweepAll({reason:'auto'});return {ran:true,total:total.toString(),result:r};}
  // ---- HTTP
  const J=(res,code,body,h={})=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...h});res.end(JSON.stringify(body,(k,v)=>typeof v==='bigint'?v.toString():v));};
  const T=(res,code,body,type)=>{res.writeHead(code,{'content-type':type,'cache-control':'public, max-age=60','x-content-type-options':'nosniff',
    ...(type.startsWith('text/html')?{'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",'referrer-policy':'no-referrer'}:{})});res.end(body);};
  const clientOf=req=>{const cf=req.headers['cf-connecting-ip'];return typeof cf==='string'&&cf.length<64?cf:(req.socket.remoteAddress??'?');};
  function readBody(req,max=2048){return new Promise((ok,no)=>{if(Number(req.headers['content-length']??0)>max){req.resume();return no(Object.assign(Error('too large'),{code:413}));}
    let n=0,over=false;const parts=[];req.on('data',c=>{n+=c.length;if(n>max)over=true;else parts.push(c);});   // keep draining an oversized body so the 413 reaches the client
    req.on('end',()=>over?no(Object.assign(Error('too large'),{code:413})):ok(Buffer.concat(parts).toString('utf8')));req.on('error',no);});}
  async function publicHandler(req,res){try{const u=new URL(req.url,'http://x');const p=u.pathname;const m=req.method;
      if(m==='GET'||m==='HEAD'){
        if(p==='/')return T(res,200,homePage({origin,mode:sw().mode,signer:signer.address}),'text/html; charset=utf-8');
        if(p==='/llms.txt')return T(res,200,llmsTxt(origin),'text/plain; charset=utf-8');
        if(p==='/api/v1/agent/capabilities')return J(res,200,capabilities({origin,signer:signer.address,mode:sw().mode,verifyingContract}));
        if(p==='/openapi.json')return J(res,200,openapi({origin}));
        if(p==='/healthz')return J(res,200,{ok:true});
        const mm=/^\/api\/v1\/agent\/usdc-orders\/([^/]+)$/.exec(p);
        if(mm){const ra=rl('s:'+clientOf(req),limits.status);if(ra)return J(res,429,{error:'Too many requests',code:'RATE_LIMITED',retryAfterSeconds:ra},{'retry-after':String(ra)});
          const id=decodeURIComponent(mm[1]);if(!UUID.test(id))return J(res,400,{error:'purchaseId must be a UUID',code:'INVALID_PURCHASE_ID'});
          const v=await getStatus(id);return v?J(res,200,v):J(res,404,{error:'Order not found',code:'ORDER_NOT_FOUND'});}
        return J(res,404,{error:'Not found',code:'NOT_FOUND'});}
      if(m==='POST'&&p==='/api/v1/agent/usdc-orders'){
        const ra=rl('c:'+clientOf(req),limits.create)||rl('c:*',limits.createGlobal);if(ra)return J(res,429,{error:'Too many requests',code:'RATE_LIMITED',retryAfterSeconds:ra},{'retry-after':String(ra)});
        if(!/^application\/json\b/i.test(String(req.headers['content-type']??'')))return J(res,415,{error:'Send application/json',code:'UNSUPPORTED_MEDIA_TYPE'});
        let raw;try{raw=await readBody(req);}catch(e){return J(res,413,{error:'Body too large (max 2048 bytes)',code:'BODY_TOO_LARGE'},{connection:'close'});}
        let b;try{b=JSON.parse(raw);}catch{return J(res,400,{error:'Body is not JSON',code:'INVALID_JSON'});}
        if(!b||typeof b!=='object'||Array.isArray(b))return J(res,400,{error:'Body must be a JSON object',code:'INVALID_JSON'});
        const unknown=Object.keys(b).filter(k=>!['purchaseId','item','signedOrder'].includes(k));if(unknown.length)return J(res,400,{error:'Unknown field(s)',code:'UNKNOWN_FIELD',fields:unknown.slice(0,10).map(x=>String(x).slice(0,40))});
        if(typeof b.purchaseId!=='string'||!UUID.test(b.purchaseId))return J(res,400,{error:'purchaseId must be a UUID',code:'INVALID_PURCHASE_ID'});
        if(typeof b.item!=='string'||!Object.hasOwn(CATALOG,b.item))return J(res,400,{error:'item must be one of '+Object.keys(CATALOG).join(', '),code:'INVALID_ITEM'});
        if(b.signedOrder!==undefined&&typeof b.signedOrder!=='boolean')return J(res,400,{error:'signedOrder must be true or false',code:'INVALID_SIGNED_ORDER'});
        const q=u.searchParams.get('signedOrder');const so=b.signedOrder===true||q==='1'||q==='true';
        const r=await createOrder({purchaseId:b.purchaseId,item:b.item,signedOrder:so});return J(res,r.code,r.body);}
      if(['GET','HEAD','POST'].includes(m))return J(res,404,{error:'Not found',code:'NOT_FOUND'});
      return J(res,405,{error:'Method not allowed',code:'METHOD_NOT_ALLOWED'},{allow:'GET, POST'});}
    catch(e){log('http_error',{error:String(e?.message??e).slice(0,120)});try{J(res,503,{error:'Temporarily unavailable',code:'TEMPORARILY_UNAVAILABLE'});}catch{}}}
  /** admin API (unix socket only; never exposed on the public listener) */
  async function adminHandler(req,res){try{const u=new URL(req.url,'http://x');const p=u.pathname;const m=req.method;const st=S.get();
      const body=async()=>{const r=await readBody(req,4096);return r?JSON.parse(r):{};};
      if(m==='GET'&&p==='/admin/status'){const os=Object.values(st.orders);const by={};for(const o of os)by[o.status??'open']=(by[o.status??'open']??0)+1;
        return J(res,200,{origin,switches:st.switches,signer:signer.address,orders:os.length,byStatus:by,nextIndex:st.nextIndex,
          sweep:{enabled:SW.enabled,auto:SW.auto,to:SW.to??null,autoMinAtomic:SW.autoMinAtomic.toString(),lastAutoSweepAt:st.lastAutoSweepAt??0,lastSweep:st.sweeps.at(-1)??null}});}
      if(m==='POST'&&p==='/admin/switches'){try{return J(res,200,{ok:true,switches:setSwitches(await body())});}catch(e){return J(res,400,{ok:false,code:e.code??'BAD_REQUEST',error:String(e.message)});}}
      if(m==='GET'&&p==='/admin/orders'){const n=Math.min(200,Number(u.searchParams.get('limit')??20)||20);
        return J(res,200,Object.values(st.orders).sort((a,b)=>b.index-a.index).slice(0,n).map(o=>({orderId:o.orderId,purchaseId:o.purchaseId,item:o.item,amountAtomic:o.amountAtomic,status:o.status,shown:publicStatus(o),
          depositAddress:o.depositAddress,createdAt:o.createdAt,expiresAt:o.expiresAt,flags:o.flags,signed:!!o.signedOrder,received:{inTime:o.chain?.inTime,late:o.chain?.late},swept:o.swept,drained:!!o.drained})));}
      if(m==='GET'&&p==='/admin/balances')return J(res,200,await balances({all:u.searchParams.get('all')==='1'}));
      if(m==='POST'&&p==='/admin/sweep'){const b=await body();return J(res,200,await sweepAll({dryRun:b.dryRun===true,all:b.all===true,reason:'manual'}));}
      if(m==='POST'&&p==='/admin/recheck'){const b=await body();const o=st.orders[String(b.purchaseId??'').toLowerCase()];if(!o)return J(res,404,{error:'not found'});await refresh(o,{force:true});return J(res,200,statusView(o));}
      return J(res,404,{error:'not found'});}
    catch(e){try{J(res,500,{error:String(e?.message??e).slice(0,200)});}catch{}}}
  return {publicHandler,adminHandler,createOrder,getStatus,refresh,tick,setSwitches,sweepAll,autoSweepCheck,balances,state:()=>S.get(),signer:signer.address,verifyingContract};}
