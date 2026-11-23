import test from 'node:test';import assert from 'node:assert/strict';
import {getAddress} from 'viem';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {engineFor,direct,TRUSTED,USDC} from './helpers/v5-fixture.mjs';
import {createMandates,purposeKey,normalizeItem,proposalDigest,BEGINNER_DEFAULTS} from '../src/v5/mandates.mjs';
import {createBuy,decide,readMerchantStatus,spendingReport} from '../src/v5/buy.mjs';
import {INSTRUCTIONS,TOOL_NAMES_V5,createV5Mcp} from '../src/v5/mcp.mjs';
import {createPush} from '../src/v5/push.mjs';
const P=i=>getAddress('0x'+String(i).padStart(4,'0')+'b'.repeat(32)+String(i).padStart(4,'0'));
const SCAM=getAddress('0x101ce0cedd142f199c9ef61739ae59b6611a0fc0');
const mk=(over={})=>{const paused=[],props=[];const e=engineFor({onAnomaly:r=>paused.push(r),isPaused:()=>paused.length>0,onMandateProposal:v=>props.push(v),ownerRulesDir:mkdtempSync(join(tmpdir(),'md-')),...over},{bal:over.__bal??1000000000n},{openSingle:'500000000',openDaily:'900000000',single:'500000000',daily:'900000000',term:'900000000'});
  const ok=()=>true;const approveAll=()=>{for(const p of e.engine.mandates.proposals())assert.equal(e.engine.mandates.approve(p.id,ok).ok,true);};
  const buy=createBuy(e.engine,{sleep:async()=>{},waitMs:0});return {...e,paused,props,approveAll,buy};};
const defaults=E=>E.mandates.propose({items:BEGINNER_DEFAULTS.filter(d=>d.on),by:'owner'});
const x402=(amount,payTo)=>{const req=i=>({x402Version:2,resource:{url:`https://api.example/r/${i}`},accepts:[{scheme:'exact',network:'eip155:84532',amount:String(amount),asset:USDC,payTo,maxTimeoutSeconds:60,extra:{name:'USDC',version:'2',nonce:'n'+i}}]});
  return async(url,init)=>{const i=url.split('/').pop();if(!Object.keys(init?.headers??{}).some(h=>/payment/i.test(h)))return new Response('',{status:402,headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify(req(i))).toString('base64')}});return new Response('translated ok',{status:200});};};
test('purpose keys, item validation, digest binds the items',()=>{
  assert.equal(purposeKey('宣传'),'promo');assert.equal(purposeKey('竞价'),'promo');assert.equal(purposeKey('学习'),'study');assert.equal(purposeKey('API'),'dev');assert.equal(purposeKey(''),null);
  assert.throws(()=>normalizeItem({purpose:'daily',single:'5',daily:'2'}),/single <= daily/);assert.throws(()=>normalizeItem({purpose:'daily'}),/single/);
  const a=normalizeItem({purpose:'study',single:'2',daily:'5',monthly:'30'});assert.equal(a.single,'2000000');assert.equal(a.monthly,'30000000');
  assert.notEqual(proposalDigest('0x1',{id:'a',items:[a]}),proposalDigest('0x1',{id:'a',items:[{...a,single:'3000000'}]}));});
test('approval needs the phone signature over the exact digest; reject/revoke tighten without one',async()=>{const {engine}=mk();const M=engine.mandates;
  const p=defaults(engine);assert.equal(p.items.length,1);assert.equal(p.items[0].purpose,'all');let seen=null;assert.equal(M.approve(p.id,d=>{seen=d;return false;}).error,'not_owner');assert.equal(seen,p.digest);
  assert.equal(M.list().length,0);assert.equal(M.approve(p.id,()=>true).ok,true);assert.equal(M.list().length,1);assert.equal(M.approve(p.id,()=>true).error,'not_pending');
  const st=M.list().find(m=>m.purpose==='all');assert.equal(M.revoke(st.id).ok,true);assert.equal(M.list().length,0);
  const q=M.propose({items:[{purpose:'dev',single:'1'}],by:'agent:x'});assert.equal(M.reject(q.id).ok,true);assert.equal(M.approve(q.id,()=>true).error,'not_pending');});
test('STUDENT DAY: first payment to a new merchant = ONE Face ID (remembered), then zero-friction inside the study allowance; friend transfer asks once; summary',async()=>{const {engine,approveAll,buy,props}=mk();defaults(engine);approveAll();
  const r0=await buy.buy({purpose:'学习',item:'paper download',merchant:'PaperHub',user_request:'帮我下载这篇论文',to:P(1),amount:'0.2',idempotencyKey:'idem-st-0001'},'claude');
  assert.equal(r0.decision,'ask_owner',JSON.stringify(r0));assert.equal(r0.nothingPaid,true);assert.equal(props.length,1);assert.match(props[0].items[0].human.zh,/新收款方.*AI 可能被骗/);assert.match(props[0].items[0].human.zh,/PaperHub.*未核实/);
  approveAll();const r=await buy.buy({purpose:'学习',item:'paper download',merchant:'PaperHub',user_request:'帮我下载这篇论文',to:P(1),amount:'0.2',idempotencyKey:'idem-st-0001'},'claude');
  assert.equal(r.state,'paid',JSON.stringify(r));assert.match(r.say_to_user,/PaperHub/);assert.doesNotMatch(r.say_to_user,/0x/);
  const r2=await buy.buy({purpose:'study',item:'plagiarism check',merchant:'PaperHub',to:P(1),amount:'1.5',idempotencyKey:'idem-st-0002'},'claude');assert.equal(r2.state,'paid','remembered: no second Face ID');assert.equal(props.length,1);
  const r3=await buy.buy({purpose:'study',item:'textbook',merchant:'PaperHub',to:P(1),amount:'6',idempotencyKey:'idem-st-0003'},'claude');assert.equal(r3.decision,'ask_owner','above the ONE overall per-payment limit asks');
  const f=await buy.buy({purpose:'transfer',item:'AA takeout',merchant:'小李',user_request:'给小李转 8 U',to:P(4),amount:'8',addressSource:'owner_chat',idempotencyKey:'idem-st-0005'},'claude');
  assert.equal(f.decision,'ask_owner');assert.equal(f.nothingPaid,true);assert.ok(f.approvalId);
  const s=engine.spendingSummary({period:'today'});assert.equal(s.total,'1.7');assert.equal(spendingReport(engine,{period:'today'}).byPurpose[0].purposeName,'学习');});

test('WHITE-COLLAR DAY: x402 translation provider approved once then automatic; payTo swap asks; invoice to new payee asks; csv export',async()=>{
  let payTo=P(11);const f=x402(500000,null);const {engine,approveAll,buy}=mk({fetch:async(u,i)=>{const r=await x402(500000,payTo)(u,i);return r;}});const M=engine.mandates;M.propose({items:[...BEGINNER_DEFAULTS.map(d=>({...d})),{purpose:'promo',single:'20',daily:'50',monthly:'200'}]});approveAll();
  const t0=await buy.buy({purpose:'work',item:'translate meeting notes',merchant:'TransAPI',url:'https://api.example/r/1',idempotencyKey:'idem-wc-0001'},'grok');assert.equal(t0.decision,'ask_owner',JSON.stringify(t0));approveAll();
  const t=await buy.buy({purpose:'work',item:'translate meeting notes',merchant:'TransAPI',url:'https://api.example/r/1',idempotencyKey:'idem-wc-0001'},'grok');assert.equal(t.fulfillment,'fulfilled',JSON.stringify(t));assert.match(t.body,/translated/);
  const t2=await buy.buy({purpose:'work',item:'translate again',merchant:'TransAPI',url:'https://api.example/r/2',idempotencyKey:'idem-wc-0002'},'grok');assert.equal(t2.state,'paid','same provider: automatic');
  payTo=P(19);const sw=await buy.buy({purpose:'work',item:'translate 3',merchant:'TransAPI',url:'https://api.example/r/3',idempotencyKey:'idem-wc-0003'},'grok');assert.equal(sw.decision,'ask_owner','payTo swapped -> ask');assert.equal(sw.nothingPaid,true);
  const inv=await buy.buy({purpose:'work',item:'invoice #88',merchant:'Design Studio',to:P(13),amount:'300',idempotencyKey:'idem-wc-0004'},'grok');assert.equal(inv.decision,'ask_owner');assert.equal(inv.nothingPaid,true);
  const rep=spendingReport(engine,{period:'month',format:'csv'});assert.match(rep.csv,/^date,purpose,item,user_request,payee,amount_usdc,agent,receipt_purchase_key,tx,fulfillment/);assert.equal(rep.byAgent[0].agent,'grok');});

test('GEEK DAY: approve an API provider once, then many x402 micro-payments in dev; subscription renew once per month, price up / payee change asks, per-agent caps + stop, runaway loop auto-pauses',async()=>{
  const {engine,approveAll,buy,paused,props}=mk({fetch:x402(10000,P(21)),tierLimits:{newPayees1h:5}});const M=engine.mandates;defaults(engine);approveAll();
  const a0=await buy.buy({purpose:'dev',item:'model call',url:'https://api.example/r/100',idempotencyKey:'idem-gk-0000'},'cursor');assert.equal(a0.decision,'ask_owner');approveAll();const np=props.length;
  for(let i=0;i<=12;i++){const r=await buy.buy({purpose:'dev',item:'model call',url:'https://api.example/r/'+(100+i),idempotencyKey:'idem-gk-'+String(i).padStart(4,'0')},'cursor');assert.equal(r.state,'paid',JSON.stringify(r));}
  assert.equal(props.length,np,'no more approvals after the first');
  const sp=buy.propose({purpose:'subscription',per_payment:'5',recurring:{payee:P(22),amount:'5',every:'month',name:'Cloud server'},user_request:'服务器每月续上'},'cursor');assert.equal(sp.decision,'ask_owner');approveAll();
  const s1=await buy.buy({purpose:'subscription',item:'server month 1',merchant:'Cloud server',to:P(22),amount:'5',idempotencyKey:'idem-sub-0001'},'cursor');assert.equal(s1.state,'paid',JSON.stringify(s1));
  const s2=await buy.buy({purpose:'subscription',item:'server again',merchant:'Cloud server',to:P(22),amount:'5',idempotencyKey:'idem-sub-0002'},'cursor');assert.equal(s2.decision,'ask_owner');assert.equal(s2.reason,'MANDATE_RECURRING_ALREADY_PAID');
  const s3=await buy.buy({purpose:'subscription',item:'server price up',merchant:'Cloud server',to:P(22),amount:'7',idempotencyKey:'idem-sub-0003'},'cursor');assert.equal(s3.reason,'MANDATE_RECURRING_PRICE_UP');
  const s4=await buy.buy({purpose:'subscription',item:'server new address',merchant:'Cloud server',to:P(23),amount:'5',idempotencyKey:'idem-sub-0004'},'cursor');assert.equal(s4.decision,'ask_owner');assert.equal(s4.nothingPaid,true);
  M.propose({items:[{kind:'agent_limits',agentId:'codex',daily:'1',monthly:'10'}]});approveAll();M.remember(P(24),'Shop');M.remember(P(25),'Loop');
  const c1=await buy.buy({purpose:'daily',item:'snack',merchant:'Shop',to:P(24),amount:'0.8',idempotencyKey:'idem-ag-0001'},'codex');assert.equal(c1.state,'paid',JSON.stringify(c1));
  const c2=await buy.buy({purpose:'daily',item:'snack 2',merchant:'Shop',to:P(24),amount:'0.8',idempotencyKey:'idem-ag-0002'},'codex');assert.equal(c2.decision,'ask_owner');
  M.agentStop('codex');const c3=await buy.buy({purpose:'daily',item:'snack 3',merchant:'Shop',to:P(24),amount:'0.1',idempotencyKey:'idem-ag-0003'},'codex');assert.equal(c3.reason,'AGENT_STOPPED');
  const other=await buy.buy({purpose:'daily',item:'tea',merchant:'Shop',to:P(24),amount:'0.5',idempotencyKey:'idem-ag-0004'},'claude');assert.equal(other.state,'paid');
  let last;for(let i=1;i<=9;i++)last=await buy.buy({purpose:'daily',item:'loop',merchant:'Loop',to:P(25),amount:'4',idempotencyKey:'idem-lp-'+String(i).padStart(4,'0')},'claude');
  assert.deepEqual(paused,['repeated_cap_hits']);assert.equal(last.decision,'refuse');});

test('ONE-SENTENCE PROMOTION: merchant order -> paid -> follows status until fulfilled -> "done, rank 2"; failed order -> refund requested',async()=>{
  const {engine,approveAll}=mk();defaults(engine);approveAll();engine.mandates.remember(P(31),'ExampleShop');/* approved once before */let n=0;
  const fakeE=new Proxy(engine,{get(t,k){if(k==='payMerchantOrder')return async o=>({...(await t.payAny({agentId:o.agentId,payment:{to:P(31),amount:'3'},merchant:'ExampleShop',orderRef:o.merchantPurchaseId,order:o.order,purpose:o.purpose,idempotencyKey:o.idempotencyKey})),statusUrl:'https://merchant.example/status/1'});
    if(k==='merchantStatus')return async()=>({ok:true,body:++n<3?{status:'processing'}:{status:'fulfilled',rank:2}});return t[k];}});
  const B=createBuy(fakeE,{sleep:async()=>{},waitMs:60000});
  const r=await B.buy({purpose:'推广',item:'bid for promotion of my new game',merchant:'ExampleShop',user_request:'把我的新游戏拿去竞价宣传',origin:'https://merchant.example',orderParams:{},budget:'5',idempotencyKey:'idem-pr-0001'},'grok');
  assert.equal(r.decision,'can_pay',JSON.stringify(r));assert.equal(r.fulfillment,'fulfilled');assert.match(r.say_to_user,/已办成：排名 2/);assert.match(r.say_to_user,/3 USDC/);assert.equal(r.next_step,'done');
  assert.equal(engine.orderFor(r.purchaseKey).fulfillment,'fulfilled');
  let refunds=[];const failE=new Proxy(fakeE,{get(t,k){if(k==='merchantStatus')return async()=>({ok:true,body:{status:'failed'}});if(k==='requestRefund')return async(a)=>{refunds.push(a);return {caseId:'c1'};};return t[k];}});
  const B2=createBuy(failE,{sleep:async()=>{},waitMs:0});const f=await B2.buy({purpose:'promo',item:'bid 2',merchant:'ExampleShop',origin:'https://merchant.example',orderParams:{},idempotencyKey:'idem-pr-0002'},'grok');
  assert.equal(f.fulfillment,'failed');assert.equal(refunds.length,1);assert.match(f.say_to_user,/自动申请退款/);assert.equal(f.next_step,'tell_user_refund_requested');
  assert.deepEqual(readMerchantStatus({order:{state:'expired'}}).status,'failed');assert.equal(readMerchantStatus({status:'pending'}).status,'pending');});
test('SCAM ATTEMPTS: blacklist / lookalike refused even inside an allowance; big payment outside allowance is held and cancelable; plain-language errors',async()=>{
  const {engine,approveAll,buy}=mk({tierLimits:{newPayees1h:99,holdMs:60000,unattendedDaily:5000000000n,unattendedMonthly:9000000000n,balanceOutPct:100}});defaults(engine);approveAll();
  const b=await buy.buy({purpose:'daily',item:'gift card',merchant:'Promo',to:SCAM,amount:'1',idempotencyKey:'idem-sc-0001'},'grok');assert.equal(b.decision,'refuse');assert.equal(b.reason,'SCAM_BLACKLIST');assert.equal(b.next_step,'stop_do_not_try_other_addresses');
  // a payee that was paid before + an attacker address with the same first/last 4 hex
  const real=getAddress('0x1234'+'c'.repeat(32)+'abcd'),fake=getAddress('0x1234'+'d'.repeat(32)+'abcd');
  await engine.pay({request:direct('100000','lk-0',real),idempotencyKey:'idem-lk-0000',agentId:'owner'});
  const l=await buy.buy({purpose:'daily',item:'x',merchant:'Real Shop',to:fake,amount:'1',idempotencyKey:'idem-sc-0002'},'grok');assert.equal(l.decision,'refuse',JSON.stringify(l));
  // verified payee, above the ONE limit: Face ID, then >=500 to a non-trust-list payee is held 10 min, owner/AI can cancel
  await engine.pay({request:direct('5000000','v-1',P(41)),idempotencyKey:'idem-v-0001',agentId:'owner'});/* paid by the owner before = verified (AI-only history keeps AI limits, RT-1) */
  // ONE LIMIT: over the overall limit -> one Face ID first; after approval the 500 hold for non-trusted payees still applies
  const h0=await buy.buy({item:'tv',merchant:'TV Shop',to:P(41),amount:'500',idempotencyKey:'idem-sc-0003'},'grok');assert.equal(h0.decision,'ask_owner',JSON.stringify(h0));assert.equal(h0.nothingPaid,true);approveAll();
  const h1=await buy.buy({item:'tv',merchant:'TV Shop',to:P(41),amount:'500',idempotencyKey:'idem-sc-0003'},'grok');assert.equal(h1.state,'paid','the owner approved exactly this payment with Face ID');
  // owner raises the ONE limit to 600 per payment: a 500 payment to a verified but NOT trust-listed payee is still held 10 min
  engine.mandates.propose({items:[{single:'600',daily:'900',monthly:'900'}],by:'owner'});approveAll();assert.equal(engine.mandates.list().filter(m=>m.purpose==='all').length,1,'one overall limit replaces the old one');
  await engine.pay({request:direct('5000000','v-2',P(42)),idempotencyKey:'idem-v-0002',agentId:'owner'});
  const h=await buy.buy({item:'sofa',merchant:'Sofa Shop',to:P(42),amount:'500',idempotencyKey:'idem-sc-0004'},'grok');assert.equal(h.state,'held',JSON.stringify(h));assert.equal(h.decision,'can_pay');assert.equal(engine.cancelHold(h.holdId).ok,true);
  assert.equal(decide({state:'rejected',reason:'funds_quarantined_or_insufficient'}).next_step,'show_deposit_kipurse_deposit_info');
  assert.equal(decide({state:'rejected',reason:'order_expired'}).next_step,'create_new_order_new_idempotencyKey');
  assert.equal(decide({state:'retry_later',reason:'gas_spike'}).next_step,'retry_later_same_idempotencyKey');});
test('MCP: kipurse_buy is the recommended entry; old tools still listed; push payload for approvals',async()=>{
  for(const t of ['kipurse_buy','kipurse_allowances','kipurse_propose_allowance','kipurse_approval_status','kipurse_order_status','kipurse_spending_report','kipurse_pay','kipurse_paid_fetch'])assert.ok(TOOL_NAMES_V5.includes(t),t);
  assert.match(INSTRUCTIONS,/^START HERE: for ANY purchase or payment call kipurse_buy/);assert.match(INSTRUCTIONS,/ONE LIMIT/);assert.match(INSTRUCTIONS,/purpose is OPTIONAL/);
  const {engine}=mk();const {server}=createV5Mcp(engine,{agentId:'a1'});const names=Object.keys(server._registeredTools??{});for(const n of TOOL_NAMES_V5)assert.ok(names.includes(n),'registered '+n);
  const pl=createPush({config:null}).payloadFor({kind:'mandate',id:'apr_1',zh:'只这一次：学习'},'zh');assert.equal(pl.aps.category,'KP_MANDATE');assert.equal(pl.kp.approvalId,'apr_1');});
test('DEAD-END SWEEP: every ask_owner has a working way forward (trial -> one-off approve -> paid; x402 above trial -> approve -> paid; held -> released result; no purpose -> old rules)',async()=>{
  const {engine,approveAll,buy}=mk({__bal:5000000000n,fetch:x402(3000000,P(51)),tierLimits:{newPayees1h:99,holdMs:150}});
  // no allowances at all: new shop, 3 USDC -> trial limit -> ONE approval -> same call pays
  const a=await buy.buy({item:'mug',merchant:'Mug Shop',to:P(52),amount:'3',idempotencyKey:'idem-de-0001'},'grok');assert.equal(a.decision,'ask_owner',JSON.stringify(a));assert.ok(a.approvalId);
  approveAll();const a2=await buy.buy({item:'mug',merchant:'Mug Shop',to:P(52),amount:'3',idempotencyKey:'idem-de-0001'},'grok');assert.equal(a2.state,'paid',JSON.stringify(a2));assert.equal(a2.next_step,'done');
  // x402 web API costing 3 USDC (above trial) -> approve -> same call pays and returns the content
  const x=await buy.buy({item:'report',url:'https://api.example/r/7',idempotencyKey:'idem-de-0002'},'grok');assert.equal(x.decision,'ask_owner',JSON.stringify(x));
  approveAll();const x2=await buy.buy({item:'report',url:'https://api.example/r/7',idempotencyKey:'idem-de-0002'},'grok');assert.equal(x2.state,'paid',JSON.stringify(x2));assert.equal(x2.fulfillment,'fulfilled');
  // held large payment to a verified (not trust-list) payee: wait, then the same call returns the paid result
  await engine.pay({request:direct('5000000','dv-1',P(53)),idempotencyKey:'idem-dv-0001',agentId:'owner'});
  const h=await buy.buy({item:'tv',merchant:'TV',to:P(53),amount:'500',idempotencyKey:'idem-de-0003'},'grok');assert.equal(h.state,'held');assert.match(h.next_step,/wait/);
  await new Promise(z=>setTimeout(z,400));const h2=await buy.buy({item:'tv',merchant:'TV',to:P(53),amount:'500',idempotencyKey:'idem-de-0003'},'grok');assert.equal(h2.state,'paid',JSON.stringify(h2));
  // missing pieces always answer with a plain sentence + next step
  for(const bad of [{item:'x'},{to:P(54)},{amount:'abc',to:P(54)},{payee_name:'Nobody',amount:'1'}]){const r=await buy.buy({...bad,idempotencyKey:'idem-de-bad-'+Object.keys(bad).join('')},'grok');assert.ok(['refuse','ask_owner'].includes(r.decision),JSON.stringify(r));assert.ok(r.say_to_user&&r.next_step,JSON.stringify(r));}});
