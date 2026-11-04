// SPDX-License-Identifier: AGPL-3.0-only
// ONE ENTRY FOR AI PAYMENTS (kipurse_buy). The AI says what it pays for and why; the wallet checks, pays inside the owner's allowance,
// follows the merchant order until it is really done, and ALWAYS answers with
//   decision: can_pay | ask_owner | refuse,  state, say_to_user (one plain sentence, zh / en), next_step (what the AI does next).
// "done" only when the merchant confirmed (order status fulfilled, or an x402 resource was delivered). A failed order after payment
// opens a refund request automatically. No timers / jobs: status is followed inside the call (bounded) or by kipurse_order_status.
import {purposeKey,purposeName,PURPOSES,BEGINNER_DEFAULTS,usdcAtomic,fmtUsdc,classifyCategory,CATEGORIES} from './mandates.mjs';
const FULFILLED=/^(fulfilled|complete|completed|done|success|succeeded|delivered|active|live|confirmed|placed|won|ranked)$/i;
const FAILED=/^(failed|failure|canceled|cancelled|expired|rejected|refunded|declined|error|lost)$/i;
const PAIDLIKE=/^(paid|payment_received|processing|pending|in_progress|queued|created|awaiting_fulfillment|open|submitted)$/i;
/** merchant status JSON -> fulfilled | failed | pending (+ a short merchant detail, never raw secrets) */
export function readMerchantStatus(body){if(!body||typeof body!=='object')return {status:'pending'};const o=body.order??body.data??body;
  const st=String(o.fulfillment_status??o.fulfillmentStatus??o.status??o.state??'').trim();
  const detail={};for(const k of ['rank','position','placement','result','message','note','eta','url','tracking'])if(o[k]!==undefined&&o[k]!==null&&typeof o[k]!=='object')detail[k]=String(o[k]).slice(0,200);
  if(o.fulfilled===true||FULFILLED.test(st))return {status:'fulfilled',merchantStatus:st||'fulfilled',detail};
  if(FAILED.test(st))return {status:'failed',merchantStatus:st,detail};return {status:'pending',merchantStatus:st||null,detail};}
const say=(zh,en)=>({zh,en,text:zh+' / '+en});
/** Map any engine payment result to {decision, say_to_user, next_step}. */
export function decide(r,{amount,name,purpose,lang}={}){const who=name??'收款方',whoEn=name??'the payee';const pz=purpose?purposeName(purpose,true):null;
  const st=r?.state,rs=String(r?.reason??r?.code??'');let d,s,n;
  if(r?.paused||r?.anomaly){d='refuse';s=r.say_to_user?{text:r.say_to_user}:say('为了安全，AI 付款已自动暂停。请在 Kipurse 里用 Face ID 恢复。','AI payments were paused for safety. Resume them in Kipurse with Face ID.');n='stop_tell_user_paused';}
  else if(['paid','paid_by_other_agent','already_paid'].includes(st)){d='can_pay';s=say(`已付 ${amount??r.amount??''} USDC 给 ${who}${pz?'（'+pz+'）':''}。`,`Paid ${amount??''} USDC to ${whoEn}.`);n='done';}
  else if(st==='no_payment_needed'){d='can_pay';s=say('不用付款，已经拿到了。','No payment was needed.');n='done';}
  else if(st==='held'){d='can_pay';s=say(`这笔达到 500 USDC，10 分钟后付给 ${who}；不想付可以在 Kipurse 里取消。`,`It pays ${whoEn} in 10 minutes; you can cancel in Kipurse.`);n='wait_then_retry_same_idempotencyKey';}
  else if(['awaiting_owner_approval','awaiting_owner_confirm'].includes(st)){d='ask_owner';s=r.say_to_user?{text:r.say_to_user}:say('还没付款：已发到你手机，请用 Face ID 同意。','Not paid yet: approve on your phone with Face ID.');n=st==='awaiting_owner_confirm'?'tell_user_then_poll_kipurse_approval_status_with_trustRequestId_then_retry_same_idempotencyKey':'tell_user_then_poll_kipurse_approval_status_then_retry_same_idempotencyKey';}
  else if(st==='retry_later'||rs==='retry_later'||rs==='gas_spike'){d='can_pay';s=say('网络有点忙，没扣钱，我稍后再试。','The network is busy; nothing was charged. I will retry shortly.');n='retry_later_same_idempotencyKey';}
  else if(/wallet_paused/.test(rs)){d='refuse';s=r.say_to_user?{text:r.say_to_user}:say('没有付款：AI 付款已暂停，只有你能在 Kipurse 里用 Face ID 恢复。','Not paid: AI payments are paused; only you can resume them in Kipurse with Face ID.');n='stop_tell_user_paused';}
  else if(/insufficient|funds_quarantined/.test(rs)){d='refuse';s=say('没有付款：钱包余额不够。打开 Kipurse 点「充值」，扫码转入 USDC 就行。','Not paid: not enough balance. Open Kipurse, tap Deposit and scan the QR code.');n='show_deposit_kipurse_deposit_info';}
  else if(/^(SCAM_BLACKLIST|LOOKALIKE|DUST|blocked)/i.test(rs)||rs==='UNVERIFIED_FROM_HISTORY'){d='refuse';s=r.say_to_user?{text:r.say_to_user}:say('没有付款：这个地址可能是骗子的。','Not paid: this address looks like a scam.');n='stop_do_not_try_other_addresses';}
  else if(/expired/.test(rs)){d='refuse';s=say('没有付款：订单已过期，我重新下一单。','Not paid: the order expired; I will create a new one.');n='create_new_order_new_idempotencyKey';}
  else if(rs==='AGENT_STOPPED'){d='refuse';s={text:r.say_to_user};n='stop_tell_user_agent_stopped';}
  else if(rs==='OVER_USER_BUDGET'){d='ask_owner';s={text:r.say_to_user};n='ask_user_for_higher_budget';}
  else if(st==='payment_not_accepted'){d='refuse';s=say('商家没有收下这笔付款，钱没有被扣走，会自动退回额度。','The merchant did not accept the payment; it is returned automatically.');n='retry_later_or_choose_other_merchant';}
  else {d='refuse';s=r?.say_to_user?{text:r.say_to_user}:say('没有付款：'+(rs||'出了点问题')+'。','Not paid: '+(rs||'something went wrong')+'.');n=r?.fix?'read_fix':'tell_user';}
  return {decision:d,say_to_user:lang==='en'?(s.en??s.text):lang==='zh'?(s.zh??s.text):s.text,next_step:n};}
/** reasons that the owner can approve as ONE payment (push + Face ID) */
const ASKABLE=/^(NEW_PAYEE_NEEDS_OWNER|AI_UNATTENDED_|STRANGER_TRIAL|AI_VERIFIED|X402_OVER_HOLD_LIMIT|over_unrecognized_cap|AGENT_SINGLE_CAP|AGENT_DAILY_CAP|AGENT_MONTHLY_CAP|over_stranger|MANDATE_)/;
export function createBuy(E,{now=()=>Date.now(),sleep=ms=>new Promise(z=>setTimeout(z,ms)),waitMs=20000,pollMs=2000}={}){
  const MD=E.mandates;
  async function follow(purchaseKey,statusUrl,{wait=waitMs,agentId,lang}={}){const t0=now();let last={status:'pending'};
    while(true){const m=await E.merchantStatus(statusUrl);if(m.ok)last=readMerchantStatus(m.body);
      if(last.status!=='pending'||now()-t0>=wait)break;await sleep(pollMs);}
    E.setOrderExtra?.(purchaseKey,{fulfillment:last.status,merchantStatus:last.merchantStatus??null,checkedAt:now()});
    if(last.status==='failed'){let refund=null;try{refund=await E.requestRefund({purchaseKey,reason:'not_received',note:'merchant order status: '+(last.merchantStatus??'failed')},agentId);}catch(e){refund={error:String(e?.message??e).slice(0,120)};}
      return {...last,refund:refund?.error?null:refund,say:say('付款成功了，但商家没办成（'+(last.merchantStatus??'失败')+'）。'+(refund?.error?'请你联系商家退款。':'我已自动申请退款。'),'Paid, but the merchant did not complete it ('+(last.merchantStatus??'failed')+'). '+(refund?.error?'Please ask the merchant for a refund.':'I asked for a refund automatically.'))};}
    if(last.status==='fulfilled'){const dt=Object.entries(last.detail??{}).filter(([k])=>['rank','position','placement','result'].includes(k)).map(([k,v])=>({rank:'排名',position:'排名',placement:'名次',result:'结果'}[k]+' '+v)).join('，');
      return {...last,say:say('已办成'+(dt?'：'+dt:'')+'。','Done'+(dt?': '+Object.values(last.detail).slice(0,2).join(', '):'')+'.')};}
    return {...last,say:say('已付款，商家还在处理，我过一会儿再确认结果。','Paid; the merchant is still working on it. I will check the result again shortly.')};}
  async function buy(a,agentId){const lang=a.lang==='en'?'en':a.lang==='zh'?'zh':undefined;
    const purpose=classifyCategory({purpose:a.purpose,item:a.item??a.what,merchant:a.merchant??a.payee_name,host:a.url?(()=>{try{return new URL(a.url).host;}catch{return null;}})():null});/* label only (ONE LIMIT) */const amountAt=a.amount!==undefined?usdcAtomic(a.amount):undefined;if(amountAt===null)return {decision:'refuse',state:'rejected',reason:'bad_amount',next_step:'fix_amount',fix:'amount = decimal USDC like "3" or "0.5"',say_to_user:'金额格式不对。/ Bad amount.'};
    const order={item:a.item??a.what??'',merchant:a.merchant??a.payee_name??'',user_request:a.user_request??'',max_price:a.budget??a.max_price??undefined,purpose:purpose??undefined};
    const idem=a.idempotencyKey;let r,name=a.merchant??a.payee_name??null,route;
    if(a.url){route='x402';r=await E.paidFetch({agentId,url:a.url,method:a.method??'GET',body:a.body,order,purpose,addressSource:a.addressSource,maxAmount:a.budget?String(usdcAtomic(a.budget)):undefined,idempotencyKey:idem});
      try{name=name??new URL(a.url).hostname;}catch{}}
    else if(a.origin){route='merchant_order';r=await E.payMerchantOrder({agentId,origin:a.origin,orderParams:a.orderParams??{},merchantPurchaseId:a.merchantPurchaseId??idem,order,purpose,addressSource:a.addressSource,idempotencyKey:'mco-'+(a.merchantPurchaseId??idem)});
      try{name=name??new URL(a.origin).hostname;}catch{}}
    else{route='direct';let to=a.to;if(!to&&a.payee_name){const rn=E.resolvePayeeName(a.payee_name);if(!rn?.ok)return {decision:'ask_owner',state:'rejected',nothingPaid:true,...rn,next_step:'ask_user_who_to_pay',say_to_user:'我没找到叫「'+a.payee_name+'」的已核实收款方，你能告诉我付给谁吗？/ I could not find a verified payee called "'+a.payee_name+'". Who should I pay?'};to=rn.address;name=rn.name;}
      if(!to&&!a.payment)return {decision:'refuse',state:'rejected',reason:'payee_required',next_step:'give_to_or_url_or_origin',fix:'Pass one of: url (x402 / paid web API), origin + orderParams (merchant with a USDC order API), to + amount, payee_name + amount, or payment (any payment request).',say_to_user:'还缺收款方。/ Missing the payee.'};
      if(to&&amountAt===undefined)return {decision:'refuse',state:'rejected',reason:'amount_required',next_step:'give_amount',say_to_user:'还缺金额。/ Missing the amount.'};
      const payment=a.payment??{to,amount:a.amount};r=await E.payAny({agentId,payment,merchant:a.merchant??'direct',orderRef:a.orderRef??idem,order,purpose,addressSource:a.addressSource??(a.payee_name?'from_trusted_list':undefined),idempotencyKey:idem,...(a.escrowFor!==undefined?{escrowFor:a.escrowFor}:{})});}
    if(r&&r.state==='rejected'&&ASKABLE.test(String(r.reason??''))&&!/^MANDATE_/.test(String(r.reason))){
      // outside every allowance and above the tier limits: ONE owner approval for exactly this payment
      const amt=r.amountAtomic??r.amount??(amountAt!==undefined?amountAt.toString():null);const payee=r.payee??a.to??null;let host=null;try{host=a.url?new URL(a.url).hostname:null;}catch{}
      if(amt&&(payee||host)){try{const pr=MD.propose({items:[{purpose:purpose??'daily',single:fmtUsdc(BigInt(amt)),oneOff:{payee:payee??null,host,remember:true,aiName:a.merchant&&a.merchant!=='direct'?String(a.merchant):null}}],by:'agent:'+agentId,reason:String(r.reason)+': '+(a.user_request??a.item??'').slice(0,200),user_request:a.user_request,dedupe:['buy',String(payee??host).toLowerCase(),amt,purpose].join('|')});
        r={...r,state:'awaiting_owner_approval',approvalId:pr.id,say_to_user:`还没付款：${fmtUsdc(BigInt(amt))} USDC 给 ${name??'收款方'} 超出了你给 AI 的额度。我已发到你手机，用 Face ID 同意后就付。/ Not paid yet: ${fmtUsdc(BigInt(amt))} USDC to ${name??'the payee'} is outside the AI allowance. Approve on your phone with Face ID and I will pay.`};}catch{}}}
    const amtTxt=r?.amount?fmtUsdc(BigInt(r.amount)):a.amount!==undefined?fmtUsdc(amountAt):undefined;
    const dz=decide(r,{amount:amtTxt,name:r?.payee_name??name,purpose,lang});let out={...r,route,purpose:purpose??null,...dz};
    if(dz.next_step==='done'&&r.purchaseKey){
      if(route==='merchant_order'&&r.statusUrl){E.setOrderExtra?.(r.purchaseKey,{statusUrl:r.statusUrl});const f=await follow(r.purchaseKey,r.statusUrl,{wait:a.waitSeconds!==undefined?Math.min(60,a.waitSeconds)*1000:waitMs,agentId,lang});
        out={...out,fulfillment:f.status,merchantStatus:f.merchantStatus,merchantDetail:f.detail,refund:f.refund??undefined,
          say_to_user:(dz.say_to_user+' '+(lang==='en'?f.say.en:lang==='zh'?f.say.zh:f.say.text)).trim(),next_step:f.status==='fulfilled'?'done':f.status==='failed'?'tell_user_refund_requested':'poll_kipurse_order_status'};}
      else if(route==='x402'){out={...out,fulfillment:'fulfilled'};E.setOrderExtra?.(r.purchaseKey,{fulfillment:'fulfilled'});}
      else {out={...out,fulfillment:'paid_no_merchant_status',note:'this merchant gives no order status; paid = done'};}}
    if(r.trustRequestId&&!out.approvalId)out.approvalId=r.trustRequestId;
    if(dz.decision==='ask_owner'&&r.approvalId)out.next_step='tell_user_then_poll_kipurse_approval_status_then_retry_same_idempotencyKey';
    if(dz.next_step==='show_deposit_kipurse_deposit_info'){try{const di=await E.depositInfo();out.deposit={uri:di.uri??di.eip681??null,note:'show the QR / open the Kipurse app Deposit screen; never read the address aloud'};}catch{}}
    return out;}
  async function orderStatus({purchaseKey,lang},agentId){const o=E.orderFor(purchaseKey);if(!o)return {error:'not_found',fix:'use purchaseKey from kipurse_buy'};
    if(!o.statusUrl)return {purchaseKey,fulfillment:o.fulfillment??'paid_no_merchant_status',say_to_user:o.fulfillment==='fulfilled'?'已办成。/ Done.':'已付款；这个商家不提供订单状态。/ Paid; this merchant has no order status.'};
    if(o.fulfillment==='fulfilled'||o.fulfillment==='failed')return {purchaseKey,fulfillment:o.fulfillment,merchantStatus:o.merchantStatus,say_to_user:o.fulfillment==='fulfilled'?'已办成。/ Done.':'商家没办成，已申请退款。/ Not completed; refund requested.'};
    const f=await follow(purchaseKey,o.statusUrl,{wait:0,agentId});return {purchaseKey,fulfillment:f.status,merchantStatus:f.merchantStatus,merchantDetail:f.detail,refund:f.refund??undefined,say_to_user:lang==='en'?f.say.en:lang==='zh'?f.say.zh:f.say.text,next_step:f.status==='pending'?'poll_again_later':'done'};}
  const approvalStatus=async({approvalId})=>{const p=MD.getProposal(approvalId);
    if(!p){let t=null;try{t=await E.trustRequestStatus({id:approvalId});}catch{}if(!t||t.error||t.state==='rejected'&&!t.status)return {error:'not_found',fix:'use approvalId or trustRequestId from kipurse_buy'};
      const s=t.status??t.state;return {approvalId,state:s==='trusted'?'approved':s,kind:'new_payee',next_step:s==='trusted'?'retry_the_payment_with_the_same_idempotencyKey':['awaiting_owner','awaiting_signature'].includes(s)?'wait_owner_face_id':'tell_user_not_approved',
        say_to_user:s==='trusted'?'你已确认这个收款方，我现在去付。/ Confirmed; paying now.':['awaiting_owner','awaiting_signature'].includes(s)?'还在等你在手机上用 Face ID 确认。/ Waiting for your Face ID confirmation.':'你没有确认，这笔不付了。/ Not confirmed; not paying.'};}
    return {approvalId:p.id,state:p.state,items:p.items.map(i=>i.human),next_step:p.state==='approved'?'retry_the_payment_with_the_same_idempotencyKey':p.state==='pending'?'wait_owner_face_id':'tell_user_not_approved',
      say_to_user:p.state==='approved'?'你已同意，我现在去付。/ Approved; paying now.':p.state==='pending'?'还在等你在手机上用 Face ID 同意。/ Waiting for your Face ID approval.':'你没有同意，这笔不付了。/ You declined; not paying.'};};
  const allowances=(agentId)=>({overall:(()=>{const o=MD.overall?.();return o?{single:fmtUsdc(BigInt(o.single)),daily:fmtUsdc(BigInt(o.daily)),total:fmtUsdc(BigInt(o.monthly)),leftToday:o.usage?.leftToday,source:o.virtual?'wallet_limit':'owner_overall'}:null;})(),allowances:MD.list().map(m=>({id:m.id,kind:m.kind,purpose:m.purpose,name:m.purposeName,single:fmtUsdc(BigInt(m.single)),daily:fmtUsdc(BigInt(m.daily)),monthly:fmtUsdc(BigInt(m.monthly)),payees:m.payeeNames,hosts:m.hosts,agents:m.agents,recurring:m.recurring?{name:m.recurring.name,amount:fmtUsdc(BigInt(m.recurring.amount)),every:m.recurring.every}:null,usage:m.usage,expiresAt:m.expiresAt})),
    categories:CATEGORIES.map(k=>({key:k,zh:purposeName(k,true),en:purposeName(k,false)})),purposes:Object.fromEntries(Object.entries(PURPOSES).map(([k,v])=>[k,{zh:v.zh,en:v.en}])),beginnerDefaults:BEGINNER_DEFAULTS,pendingApprovals:MD.proposals().map(p=>({id:p.id,items:p.items.map(i=>i.human)})),myAgent:MD.agents().find(x=>x.agentId===agentId)??null,
    hint:'ONE overall limit (per payment / per day / total; no monthly cap) set by the owner: inside it you pay without asking (new payees still need the owner once). Categories are automatic labels for the spending summary, never limits; purpose is optional.'});
  function propose(a,agentId){const items=(a.items??[a]).map(x=>({purpose:x.purpose,single:x.per_payment??x.single,daily:x.per_day??x.daily,monthly:x.total??x.per_total??x.per_month??x.monthly,payees:x.payees,hosts:x.hosts,
    recurring:x.recurring?{payee:x.recurring.payee??x.recurring.to,amount:x.recurring.amount,every:x.recurring.every,name:x.recurring.name}:undefined,expiresInDays:x.expiresInDays}));
    try{const p=MD.propose({items,by:'agent:'+agentId,reason:a.reason??'',user_request:a.user_request??''});return {approvalId:p.id,state:p.state,items:p.items.map(i=>i.human),decision:'ask_owner',next_step:'tell_user_then_poll_kipurse_approval_status',
      say_to_user:'我已把额度申请发到你手机：'+p.items.map(i=>i.human.zh).join('；')+'。用 Face ID 同意就生效。/ I sent the allowance request to your phone; approve with Face ID.'};}
    catch(e){return {state:'rejected',reason:e.code??'bad_request',detail:String(e.message).slice(0,200),fix:'per_payment (+ per_day, total) in decimal USDC; recurring {payee (0x), amount, every: week|month|year, name}'};}}
  return {buy,orderStatus,approvalStatus,allowances,propose,follow};}
/** Spending report: per period / purpose / agent, with receipts (purchaseKey, tx, item, user words). CSV optional. */
export function spendingReport(E,{period='month',from,to,purpose,agent,format='summary',tz='America/Chicago'}={},now=Date.now()){
  let since,until=now;if(from){since=Date.parse(from);if(to)until=Date.parse(to)+(String(to).length<=10?86400e3:0);}
  else if(period==='today'){const d=new Date(new Date(now).toLocaleString('en-US',{timeZone:tz}));const off=now-d.getTime();d.setHours(0,0,0,0);since=d.getTime()+off;}
  else if(period==='7d')since=now-7*86400e3;else if(period==='30d')since=now-30*86400e3;else if(period==='year')since=now-365*86400e3;
  else {const d=new Date(new Date(now).toLocaleString('en-US',{timeZone:tz}));const off=now-d.getTime();d.setHours(0,0,0,0);d.setDate(1);since=d.getTime()+off;}
  if(!Number.isFinite(since))since=now-30*86400e3;if(!Number.isFinite(until))until=now;
  const pk=purpose?purposeKey(purpose):null;
  const rows=E.ledger.listFiltered({since,state:'paid',limit:5000}).filter(r=>Number(r.created_at??r.createdAt??0)<=until).map(r=>{const o=E.orderFor(r.purchase_key)??{};
    const cat=o.purpose&&CATEGORIES.includes(o.purpose)?o.purpose:classifyCategory({purpose:o.purpose,item:o.item,merchant:o.merchant});return {date:new Date(Number(r.created_at??r.createdAt??now)).toISOString(),purpose:cat,purposeName:purposeName(cat,true),purposeNameEn:purposeName(cat,false),item:o.item??null,user_request:o.user_request??null,payee:o.payeeName??r.label??null,
      amount:fmtUsdc(BigInt(r.amount??0)),agent:o.agent??r.origin_agent??null,purchaseKey:r.purchase_key,tx:r.tx_hash??null,fulfillment:o.fulfillment??null};})
    .filter(x=>(!pk||x.purpose===pk)&&(!agent||x.agent===agent));
  const sum=(arr)=>fmtUsdc(arr.reduce((a,x)=>a+usdcAtomic(x.amount),0n));const group=k=>{const m=new Map();for(const x of rows){const g=x[k]??'—';m.set(g,[...(m.get(g)??[]),x]);}return [...m].map(([g,l])=>({[k]:g,count:l.length,amount:sum(l)})).sort((a,b)=>Number(b.amount)-Number(a.amount));};
  const byPurpose=group('purposeName'),byCategory=group('purpose'),byAgent=group('agent'),byPayee=group('payee');
  const out={period:from?{from,to:to??null}:period,since:new Date(since).toISOString(),total:sum(rows),count:rows.length,byPurpose,byCategory,byAgent,byPayee,rows:rows.slice(0,200),
    say_to_user:`${rows.length} 笔，共 ${sum(rows)} USDC`+(byPurpose.length?`；最多的是「${byPurpose[0].purposeName}」${byPurpose[0].amount}`:'')+'。'};
  if(format==='csv'){const esc=v=>{const s=String(v??'');return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
    out.csv=['date,purpose,item,user_request,payee,amount_usdc,agent,receipt_purchase_key,tx,fulfillment',...rows.map(x=>[x.date,x.purposeName,x.item,x.user_request,x.payee,x.amount,x.agent,x.purchaseKey,x.tx,x.fulfillment].map(esc).join(','))].join('\n');}
  return out;}
