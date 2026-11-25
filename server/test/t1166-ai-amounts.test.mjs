// t1166 (decision 80, PERMANENT LOCKED RULE + mandatory pre-deploy regression check): every AI-facing amount is human-ready USDC.
// Fails if any AI-facing response (MCP tools, /v1 agent API, /siri/*) has a raw base-unit integer as an amount field or lacks its "x.xx USDC" Display.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {getAddress} from 'viem';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {atomicToUsdc,displayUsdc,humanize,forAI,amountProblems,isAmountKey} from '../src/v5/usdc-out.mjs';
import {createV5Mcp,INSTRUCTIONS,TOOL_NAMES_V5,simplifyPayArgs,maxAtomic} from '../src/v5/mcp.mjs';import {createV5HttpServer} from '../src/v5/http.mjs';
import {createBuy} from '../src/v5/buy.mjs';import {normalizePaymentRequest,decimalUsdcToAtomic} from '../src/v5/request.mjs';
import {engineFor,direct,TRUSTED} from './helpers/v5-fixture.mjs';
const P=i=>getAddress('0x'+String(i).padStart(4,'0')+'b'.repeat(32)+String(i).padStart(4,'0'));

test('format: base units -> exact USDC + "x.xx USDC"; small fees keep their exact value',()=>{
  assert.equal(atomicToUsdc('13235320'),'13.23532');assert.equal(atomicToUsdc(1000000n),'1');assert.equal(atomicToUsdc('0'),'0');assert.equal(atomicToUsdc('-26730'),'-0.02673');
  assert.equal(displayUsdc('13.23532'),'13.24 USDC');assert.equal(displayUsdc('1'),'1.00 USDC');assert.equal(displayUsdc('0.003857'),'0.003857 USDC');assert.equal(displayUsdc('0'),'0.00 USDC');assert.equal(displayUsdc('0.005'),'0.005 USDC');assert.equal(displayUsdc('0.015'),'0.02 USDC');
  const h=forAI({balance:'13235320',fee:1000n,limit:'2000000',typedData:{message:{amount:'5000000'}},direct:{amount:'7'},chainId:8453,count:3});
  assert.equal(h.balance,'13.23532');assert.equal(h.balanceDisplay,'13.24 USDC');assert.equal(h.balanceAtomic,'13235320');assert.equal(h.summary,'余额 13.24 USDC / Balance 13.24 USDC');
  assert.equal(h.limit,'2');assert.equal(h.limitDisplay,'2.00 USDC');assert.equal(h.fee,'0.001');
  assert.equal(h.typedData.message.amount,'5000000','owner-signing data untouched');assert.equal(h.direct.amount,'7','request objects an AI sends back are untouched');
  assert.equal(h.chainId,8453);assert.equal(h.count,3);assert.match(h.amountsNote,/already in USDC/);assert.match(h.amountsNote,/不要换算/);
  assert.deepEqual(forAI(h),h,'idempotent: a second pass never divides again');
  const e=forAI({state:'paid',amount:'1000000',amountAtomic:'1000000',fee:'1000',feeAtomic:'1000',total:'1004857'});assert.equal(e.amount,'1');assert.equal(e.amountDisplay,'1.00 USDC');assert.equal(e.fee,'0.001');assert.equal(e.total,'1.004857');assert.equal(e.totalDisplay,'1.00 USDC');assert.deepEqual(forAI(e),e);assert.deepEqual(amountProblems(e),[]);
  assert.match(amountProblems({amount:'1000000',amountAtomic:'1000000',amountDisplay:'1000000.00 USDC'})[0],/not the USDC of amountAtomic/,'engine-native pair (both base units) is caught');assert.deepEqual(amountProblems(h),[]);});
test('regression check catches raw base units and missing Display',()=>{
  assert.match(amountProblems({balance:'13235320'})[0],/raw base-unit integer 13235320/);
  assert.match(amountProblems({x:[{total:1004857}]})[0],/\$\.x\[0\]\.total/);
  assert.match(amountProblems({amount:'1.5'})[0],/no amountDisplay/);
  assert.match(amountProblems({balance:'13235320',balanceDisplay:'13.24 USDC',balanceAtomic:'13235320'})[0],/not the USDC of balanceAtomic/);
  assert.deepEqual(amountProblems({balanceAtomic:'13235320',gasPriceWei:'6000000',chainId:8453,nonce:'7'}),[],'Atomic / non-USDC fields are not amounts');
  for(const k of ['balance','amount','fee','networkFee','total','limit','single','daily','term','spent','remaining','protocolFee','gasRecovery'])assert.ok(isAmountKey(k),k);
  for(const k of ['balanceAtomic','amountDisplay','chainId','nonce','deadline','period','gas','gasPriceWei','count','block','t'])assert.ok(!isAmountKey(k),k);});
test('INPUTS unchanged and unambiguous: 1.5 USDC is 1500000 base units, never 1.5e12 or 1.5e-6 USDC',()=>{
  assert.equal(decimalUsdcToAtomic('1.5'),1500000n);assert.equal(decimalUsdcToAtomic(String(1.5)),1500000n);assert.equal(decimalUsdcToAtomic('1.5000001'),undefined,'over 6 decimals refused');
  const to=P(9);const d=a=>normalizePaymentRequest({to,...a},{chainId:84532,merchant:'m',orderRef:'o'});const atomic=r=>String(JSON.stringify(r).match(/"amount(?:Atomic)?":"?([0-9]+)"?/)?.[1]);
  for(const a of [{amount:'1.5'},{amount:1.5},{amountAtomic:'1500000'}]){const r=d(a);assert.equal(r.ok,true,JSON.stringify(r));assert.ok(JSON.stringify(r).includes('1500000'),JSON.stringify(a)+' -> '+JSON.stringify(r));assert.ok(!JSON.stringify(r).includes('1500000000000'),JSON.stringify(r));}
  assert.equal(d({amountAtomic:'1.5'}).ok,false,'base units must be an integer');
  const s=simplifyPayArgs({to,amount:'1.5'});assert.equal(s.payment.amount,'1.5');assert.equal(s.payment.amountAtomic,undefined);
  assert.equal(simplifyPayArgs({to,amount:'1500000',unit:'atomic'}).payment.amountAtomic,'1500000');
  assert.equal(maxAtomic('1.5'),'1500000');assert.equal(maxAtomic(1.5),'1500000');assert.equal(maxAtomic('1.5','usdc'),'1500000');assert.equal(maxAtomic('1500000'),'1500000','integer string = base units (cap only: can only refuse, never overpay)');
  // an AI copying an output amount back as input now copies USDC: "2" (= limit 2 USDC) means 2 USDC, not 2,000,000 USDC
  const h=forAI({limit:'2000000'});assert.equal(decimalUsdcToAtomic(h.limit),2000000n);});
const mk=()=>{const e=engineFor({ownerRulesDir:fs.mkdtempSync('/tmp/t1166-')},{bal:13235320n});return e;};
test('MCP (real client over the MCP protocol): every read tool + a payment answer human-ready USDC; descriptions say no conversion',async()=>{
  const {engine}=mk();await engine.pay({request:direct('1000000','t1166-1',TRUSTED),idempotencyKey:'idem-t1166-0001',agentId:'owner'});
  const {server}=createV5Mcp(engine,{agentId:'a1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);
  const c=new Client({name:'t1166',version:'1'});await c.connect(ct);
  assert.match(c.getInstructions?.()??INSTRUCTIONS,/AMOUNTS: every amount in every result is already in USDC/);
  const tools=(await c.listTools()).tools;assert.ok(tools.length>=TOOL_NAMES_V5.length-1);for(const t of tools)assert.match(t.description,/already USDC.*no conversion/,t.name);
  const pk=engine.listPurchases({limit:1})?.purchases?.[0]?.purchaseKey??engine.listPurchases({limit:1})?.[0]?.purchaseKey;
  const calls=[['kipurse_wallet_status',{}],['kipurse_limits',{}],['kipurse_allowances',{}],['kipurse_list_purchases',{}],['kipurse_spending_summary',{period:'month'}],['kipurse_spending_report',{period:'month'}],
    ['kipurse_address_book',{}],['kipurse_trust_list',{}],['kipurse_deposit_info',{}],['kipurse_deposits',{}],['kipurse_pending_payments',{}],['kipurse_float_status',{}],['kipurse_disputes',{}],['kipurse_cards',{}],
    ['kipurse_verify_payee',{address:TRUSTED}],['kipurse_parse_payment',{to:TRUSTED,amount:'0.5'}],['kipurse_preflight',{to:TRUSTED,amount:'0.5'}],['kipurse_annual_summary',{year:new Date().getFullYear()}],
    ...(pk?[['kipurse_receipt',{purchaseKey:pk}],['kipurse_get_purchase',{purchaseKey:pk}]]:[]),['kipurse_pay',{to:TRUSTED,amount:'0.25',idempotencyKey:'idem-t1166-0002',order:{item:'t',merchant:'Shop',user_request:'pay the shop'}}]];
  let checked=0;for(const [n,a] of calls){const r=await c.callTool({name:n,arguments:a});const t=r.content?.[0]?.text;let o;try{o=JSON.parse(t);}catch{assert.fail(n+' did not answer JSON: '+String(t).slice(0,200));}
    assert.deepEqual(amountProblems(o),[],n+': '+t.slice(0,400));if(!Array.isArray(o))assert.equal(o.amountsUnit,'USDC',n);checked++;}
  assert.ok(checked>=18,'checked '+checked);
  const ws=JSON.parse((await c.callTool({name:'kipurse_wallet_status',arguments:{}})).content[0].text);
  const bd=JSON.stringify(ws).match(/"balanceDisplay":"([^"]+)"/)?.[1];assert.ok(bd&&/ USDC$/.test(bd),JSON.stringify(ws).slice(0,300));assert.doesNotMatch(JSON.stringify(ws),/"balance":"?13235320/,'no raw balance as the headline');
  await c.close();});
test('/v1 agent API answers human-ready USDC (GET + POST), CSV untouched',async()=>{const {engine}=mk();
  const srv=createV5HttpServer(engine,{agentTokens:{'tok-t1166-aaaaaaaa':'a1'}});await new Promise(r=>srv.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+srv.address().port;
  const H={authorization:'Bearer tok-t1166-aaaaaaaa','content-type':'application/json'};let n=0;
  try{for(const [m,p,b] of [['GET','/v1/status'],['GET','/v1/limits'],['GET','/v1/purchases'],['POST','/v1/trust/list',{}],['POST','/v1/deposit/info',{}],['POST','/v1/deposits',{}],['POST','/v1/float/status',{}],['POST','/v1/reports/annual',{year:new Date().getFullYear()}]]){
      const r=await fetch(base+p,{method:m,headers:H,body:b?JSON.stringify(b):undefined});const j=await r.json();assert.deepEqual(amountProblems(j),[],p+': '+JSON.stringify(j).slice(0,300));if(!Array.isArray(j))assert.equal(j.amountsUnit,'USDC',p);n++;}
    const s=await (await fetch(base+'/v1/status',{headers:H})).json();assert.ok(JSON.stringify(s).includes('Display'),'status has formatted amounts');}finally{srv.close();}
  assert.equal(n,8);});
test('/siri/* answers go through forAI (launcher) and the Siri allowances answer is human-ready',async()=>{
  const src=fs.readFileSync(new URL('../mainnet/mainnet-owner-launch.mjs',import.meta.url),'utf8');
  assert.match(src,/OBS\.log\('siri',\{path:u\.pathname[^;]*;return j\(st,\(await import\(G\+'src\/v5\/usdc-out\.mjs'\)\)\.forAI\(out\)\);\}/);
  const {engine}=mk();const b=createBuy(engine,{sleep:async()=>{},waitMs:0});const out=forAI(b.allowances('siri'));assert.deepEqual(amountProblems(out),[],JSON.stringify(out).slice(0,300));
  const buy=forAI(await b.buy({item:'coffee',merchant:'Shop',to:TRUSTED,amount:'0.3',idempotencyKey:'idem-t1166-siri-1'},'siri'));assert.deepEqual(amountProblems(buy),[],JSON.stringify(buy).slice(0,400));});
test('TRUTH: values that are already decimal USDC are never divided again (allowances, beginner defaults, trial limits, spending report)',async()=>{
  const {engine}=mk();await engine.pay({request:direct('1000000','t1166-r',TRUSTED),idempotencyKey:'idem-t1166-r001',agentId:'owner'});
  const {server}=createV5Mcp(engine,{agentId:'a1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);const c=new Client({name:'t',version:'1'});await c.connect(ct);
  const J=async(n,a={})=>JSON.parse((await c.callTool({name:n,arguments:a})).content[0].text);
  const al=await J('kipurse_allowances');assert.equal(al.overall.singleDisplay,'6.00 USDC',JSON.stringify(al.overall));assert.equal(al.overall.dailyDisplay,'12.00 USDC');assert.equal(al.overall.singleAtomic,'6000000');
  for(const d of al.beginnerDefaults){assert.ok(Number(d.single)>=1,'beginner single stays USDC: '+JSON.stringify(d));assert.equal(d.singleAtomic,String(BigInt(Math.round(Number(d.single)*1e6))));}
  const ws=await J('kipurse_wallet_status');assert.equal(ws.usdc,'13.23532');assert.equal(ws.usdcDisplay,'13.24 USDC');assert.equal(ws.usdcAtomic,'13235320');assert.match(ws.summary,/^余额 13\.24 USDC \/ Balance 13\.24 USDC$/);
  assert.equal(ws.caps.singleDisplay,'6.00 USDC');assert.equal(ws.caps.singleAtomic,'6000000');
  const sr=await J('kipurse_spending_report',{period:'month'});assert.deepEqual(amountProblems(sr),[]);if(sr.count>0){assert.ok(Number(sr.total)>=1&&Number(sr.total)<100,'report total is USDC: '+sr.total);}
  const tr=await J('kipurse_pay',{to:P(77),amount:'50',idempotencyKey:'idem-t1166-r002'});assert.deepEqual(amountProblems(tr),[],JSON.stringify(tr).slice(0,400));
  const trial=JSON.stringify(tr).match(/"trial":\{[^}]*\}/)?.[0];if(trial){const t=JSON.parse(trial.slice(8));assert.ok(Number(t.single)>=0.01,'trial single stays USDC: '+trial);}
  await c.close();});
