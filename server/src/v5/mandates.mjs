// SPDX-License-Identifier: AGPL-3.0-only
// PURPOSE ALLOWANCES ("AI pocket money", owner 2026-10-26). The owner sets once, with Face ID, how much the AI may spend per purpose
// (daily / study / promo / dev / work / custom): per payment, per day (rolling 24 h), per month (rolling 30 days), optionally only for
// certain payees / web hosts / agents. Inside an allowance the AI pays without asking, also the first time with a new merchant.
// Scam blacklist, lookalike and dust checks, the on-chain wallet caps, pauses and the 50%-of-balance rule ALWAYS still apply.
// Recurring allowance = same payee + purpose + fixed amount once per period; a higher price or another payee -> ask the owner.
// One-off approval = the owner approves exactly one payment (payee + max amount) from a push, with Face ID.
// Per-agent caps + per-agent stop when several AIs share one wallet.
// Loosening (new allowance, higher caps, agent resume) needs the phone signer (Face ID) signature over the exact proposal digest.
// Tightening (revoke allowance, stop agent, reject proposal) only needs the phone session.
// No timers, no jobs: everything is evaluated when a payment is attempted.
import {createHash,randomBytes} from 'node:crypto';
const U=1000000n;
const usd=a=>{const n=BigInt(a),w=n/U,f=(n%U).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
const atom=v=>{if(v===undefined||v===null||v==='')return undefined;if(typeof v==='bigint')return v;const m=/^\s*\$?\s*([0-9]{1,12})(?:\.([0-9]{1,6}))?\s*(?:usdc|usd|u)?\s*$/i.exec(String(v));if(!m)return null;return BigInt(m[1])*U+BigInt((m[2]??'').padEnd(6,'0')||'0');};
export const usdcAtomic=atom;export const fmtUsdc=usd;
/** Fixed purpose keys (plus custom ones). Aliases accept what an AI or a user naturally says. */
export const PURPOSES={
  daily:{zh:'日常',en:'Everyday',alias:['daily','everyday','日常','生活','life','food','外卖','shopping','购物']},
  study:{zh:'学习',en:'Study',alias:['study','learning','school','education','学习','论文','paper','research']},
  promo:{zh:'宣传推广',en:'Promotion',alias:['promo','promotion','marketing','ads','advertising','bid','bidding','宣传','推广','竞价','广告']},
  dev:{zh:'开发',en:'Development',alias:['dev','development','coding','api','apis','compute','hosting','server','开发','编程','服务器','接口']},
  work:{zh:'工作',en:'Work',alias:['work','business','office','工作','办公','报销']},
  subscription:{zh:'订阅续费',en:'Subscriptions',alias:['subscription','subscriptions','renewal','订阅','续费']},
  transfer:{zh:'转账给熟人',en:'Friends & family',alias:['transfer','friends','family','转账','朋友','家人','aa']},
  other:{zh:'其他',en:'Other',alias:['other','misc','其他','其它']},
  all:{zh:'总额度',en:'Overall limit',alias:['all','overall','total','limit','总额度','总限额','付款上限']}};
/** ONE LIMIT (owner 2026-10-27 t592u): the owner sets ONE overall limit (per payment / per day / total; no monthly cap, owner 2026-10-27 14:23). Categories are labels only,
 *  picked automatically for the spending summary; they never limit or allow a payment. */
export const OVERALL='all';
export const CATEGORIES=['daily','study','promo','dev','work','other'];
const CAT_MAP={subscription:'work',transfer:'daily'};
/** Pure: spending category label from what the AI/merchant says (purpose, item, merchant, host). Never affects limits. */
export function classifyCategory({purpose,item,merchant,host,note}={}){
  const k=purposeKey(purpose);if(k&&CATEGORIES.includes(k))return k;if(k&&CAT_MAP[k])return CAT_MAP[k];
  const txt=[purpose,item,merchant,host,note].filter(Boolean).join(' ').toLowerCase();if(!txt)return 'other';
  const extra={dev:['openai','anthropic','github','vercel','cloudflare','aws','gpu','llm','token','x402','domain','域名'],promo:['exampleshop','seo','campaign','投放'],study:['course','课程','book','书','arxiv','tutor'],daily:['coffee','咖啡','grocery','超市','餐','uber','taxi','打车'],work:['invoice','发票','saas','zoom','notion','slack','会议']};
  for(const c of ['dev','promo','study','work','daily']){const words=[...PURPOSES[c].alias,...(extra[c]??[])];
    for(const w of words){if(/^[a-z0-9 ]+$/.test(w)?new RegExp('(^|[^a-z0-9])'+w+'($|[^a-z0-9])').test(txt):txt.includes(w))return c;}}
  return 'other';}
export function purposeKey(p){const s=String(p??'').trim().toLowerCase().slice(0,40);if(!s)return null;for(const [k,v] of Object.entries(PURPOSES))if(k===s||v.alias.includes(s))return k;
  return /^[a-z0-9_\-\u3400-\u9fff ]{1,40}$/.test(s)?s:null;}
export const purposeName=(k,zh=true)=>PURPOSES[k]?(zh?PURPOSES[k].zh:PURPOSES[k].en):k;
/** Beginner defaults offered at onboarding (USDC). The owner picks which ones and approves them all with ONE Face ID. */
export const BEGINNER_DEFAULTS=[{purpose:'all',single:'5',daily:'20',monthly:'100',on:true}]; // ONE overall limit (t592u)
const AI_MAX={single:20000000n,daily:50000000n,monthly:300000000n};
const short=a=>{const s=String(a);return s.slice(0,6)+'…'+s.slice(-4);};
const PERIOD_MS={day:86400e3,week:7*86400e3,month:30*86400e3,year:365*86400e3};
const ADDR=/^0x[0-9a-fA-F]{40}$/;const lc=s=>String(s??'').toLowerCase();
const cleanTxt=(s,n)=>String(s??'').replace(/[\u0000-\u001f<>]/g,' ').trim().slice(0,n);
/** Validate + normalize one allowance item from the owner app or an agent proposal. Throws {code} on bad input. */
export function normalizeItem(x={}){const kind=x.kind??(x.agentId&&!x.purpose?'agent_limits':x.oneOff?'one_off':'allowance');
  const bad=(c,d)=>{throw Object.assign(Error(d??c),{code:c});};
  if(kind==='agent_limits'){const id=cleanTxt(x.agentId,80);if(!id)bad('agent_required');const d=atom(x.daily),m=atom(x.monthly),sg=atom(x.single);if(d===null||m===null||sg===null)bad('bad_amount');
    if(sg!==undefined&&d!==undefined&&sg>d)bad('caps_order','need single <= daily');
    // t899: optional per-payment cap (Siri / any AI); only added to the item when set, so older signed texts stay byte-identical
    return {kind,agentId:id,daily:d===undefined?null:d.toString(),monthly:m===undefined?null:m.toString(),...(sg!==undefined?{single:sg.toString()}:{}),resume:!!x.resume};}
  // ONE LIMIT: a plain allowance is always the overall limit; recurring / one-off keep their purpose only as a label
  const purpose=(!x.recurring&&!x.oneOff)?OVERALL:(purposeKey(x.purpose)&&purposeKey(x.purpose)!==OVERALL?classifyCategory({purpose:x.purpose}):'other');
  const single=atom(x.single),daily=atom(x.daily),monthly=atom(x.monthly);
  for(const v of [single,daily,monthly])if(v===null)bad('bad_amount','amounts are decimal USDC like "5" or "0.5"');
  if(single===undefined||single<=0n)bad('single_required','single = max USDC per payment');
  const d=daily??single,mo=monthly??(d*30n);if(d<single||mo<d)bad('caps_order','need single <= daily <= monthly');
  const payees=[...new Set((x.payees??[]).map(String).filter(a=>ADDR.test(a)).map(lc))].slice(0,16);
  const hosts=[...new Set((x.hosts??[]).map(h=>lc(h).replace(/^https?:\/\//,'').replace(/\/.*$/,'')).filter(h=>/^[a-z0-9.-]{3,253}$/.test(h)))].slice(0,16);
  const agents=[...new Set((x.agents??[]).map(a=>cleanTxt(a,80)).filter(Boolean))].slice(0,8);
  let recurring=null;if(x.recurring){const r=x.recurring;const p=ADDR.test(String(r.payee??''))?lc(r.payee):bad('recurring_payee_required');const a=atom(r.amount);if(!a)bad('recurring_amount_required');
    const every=['day','week','month','year'].includes(r.every)?r.every:'month';recurring={payee:p,amount:a.toString(),every,name:cleanTxt(r.name,60)||null};}
  let oneOff=null;if(x.oneOff){const o=x.oneOff;const p=ADDR.test(String(o.payee??''))?lc(o.payee):(o.host?null:bad('one_off_payee_required'));
    oneOff={payee:p,host:o.host?lc(o.host):null,amount:single.toString(),idem:cleanTxt(o.idem,128)||null,remember:o.remember!==false,aiName:cleanTxt(o.aiName,60)||null};}
  const ttlDays=Number(x.expiresInDays??(oneOff?1:365));
  return {kind:oneOff?'one_off':recurring?'recurring':'allowance',purpose,label:cleanTxt(x.label,60)||null,single:single.toString(),daily:(recurring?BigInt(recurring.amount):d).toString(),monthly:(recurring?BigInt(recurring.amount)*(recurring.every==='day'?31n:recurring.every==='week'?5n:1n):mo).toString(),
    payees:recurring?[recurring.payee]:oneOff?.payee?[oneOff.payee]:payees,hosts:oneOff?.host?[oneOff.host]:hosts,agents,recurring,oneOff,expiresInDays:Math.max(1/24,Math.min(366,ttlDays||365)),replaces:x.replaces?cleanTxt(x.replaces,40):null};}
/** Domain-separated digest the phone signer signs (SHA-256 of text; never an EIP-712 / wallet hash). The app shows the same items. */
export const proposalText=(wallet,p)=>`Kipurse allowance approval v1\nwallet:${lc(wallet)}\nid:${p.id}\nitems:${JSON.stringify(p.items)}`;
export const proposalDigest=(wallet,p)=>'0x'+createHash('sha256').update(proposalText(wallet,p)).digest('hex');
export function createMandates({db,wallet='',now=()=>Date.now(),nameOf=()=>null,onProposal=()=>{},walletCaps=null}){
  db.exec(`CREATE TABLE IF NOT EXISTS mandate(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, approved_at INTEGER, expires_at INTEGER, state TEXT NOT NULL, kind TEXT NOT NULL, purpose TEXT, json TEXT NOT NULL, proposal_id TEXT, uses INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS mandate_proposal(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL, by TEXT, reason TEXT, user_request TEXT, items_json TEXT NOT NULL, dedupe TEXT, decided_at INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS owner_payee(address TEXT PRIMARY KEY, name TEXT, host TEXT, purpose TEXT, approved_at INTEGER NOT NULL, proposal_id TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_cap(agent_id TEXT PRIMARY KEY, daily TEXT, monthly TEXT, stopped INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
  // t899 per-payment cap lives in a SIDE table so agent_cap keeps its 5 columns (older releases stay rollback-safe).
  db.exec(`CREATE TABLE IF NOT EXISTS agent_cap_single(agent_id TEXT PRIMARY KEY, single TEXT)`);
  try{if(db.prepare(`PRAGMA table_info(agent_cap)`).all().some(c=>c.name==='single')){db.exec(`INSERT OR REPLACE INTO agent_cap_single SELECT agent_id,single FROM agent_cap WHERE single IS NOT NULL`);db.exec(`ALTER TABLE agent_cap DROP COLUMN single`);}}catch{}
  const id=p=>p+'_'+randomBytes(6).toString('hex');
  migrateToOneLimit();
  /** ONE LIMIT migration (t592u): old per-purpose allowances are ignored (read-only, no ledger writes). The ONE overall limit is the
   *  wallet's existing on-chain limit (per payment / per day / term), so no cap is raised; the AI-unattended day/month totals still apply. */
  // read-only migration: nothing is written to any ledger; old per-purpose rows stay as they are but are ignored (never match, never listed)
  function migrateToOneLimit(){}
  const remembered=()=>{try{return db.prepare(`SELECT * FROM owner_payee`).all();}catch{return [];}};
  const isRemembered=a=>{try{return !!db.prepare(`SELECT 1 FROM owner_payee WHERE address=?`).get(lc(a));}catch{return false;}};
  const rememberedByName=n=>{const k=String(n??'').trim().toLowerCase();if(!k)return [];return remembered().filter(r=>String(r.name??'').trim().toLowerCase()===k).map(r=>r.address);};
  /** owner-only (Face ID route / tests): remember an exact payee as owner-established */
  const remember=(a,name=null,purpose=null,host=null)=>{if(!ADDR.test(String(a??'')))return {ok:false};db.prepare(`INSERT INTO owner_payee VALUES(?,?,?,?,?,NULL) ON CONFLICT(address) DO UPDATE SET name=COALESCE(excluded.name,owner_payee.name),approved_at=excluded.approved_at`).run(lc(a),name?cleanTxt(name,60):null,host,purpose,now());return {ok:true};};
  const forget=a=>({ok:db.prepare(`DELETE FROM owner_payee WHERE address=?`).run(lc(a)).changes>0});
  const row2m=r=>{const j=JSON.parse(r.json);return {id:r.id,state:r.state,kind:r.kind,purpose:r.purpose,purposeName:{zh:purposeName(r.purpose,true),en:purposeName(r.purpose,false)},...j,createdAt:r.created_at,approvedAt:r.approved_at,expiresAt:r.expires_at,uses:r.uses};};
  const active=()=>{const t=now();return db.prepare(`SELECT * FROM mandate WHERE state='active'`).all().filter(r=>!r.expires_at||r.expires_at>t).filter(r=>!(r.kind==='allowance'&&r.purpose!=='all')).map(row2m);}; // ONE LIMIT: old per-purpose allowances are retired
  /** atomic spend inside one mandate in the window (paid / in-flight rows only). */
  const spent=(mid,ms)=>{try{return db.prepare(`SELECT o.amount,o.order_json FROM purchase_order o JOIN purchases p ON p.purchase_key=o.purchase_key WHERE o.created_at>=? AND p.state IN ('claimed','submitted','prepared','paid') AND o.order_json LIKE ?`).all(now()-ms,'%"mandateId":"'+mid+'"%').reduce((a,x)=>a+BigInt(x.amount??0),0n);}catch{return 0n;}};
  const countIn=(mid,ms)=>{try{return db.prepare(`SELECT count(*) AS n FROM purchase_order o JOIN purchases p ON p.purchase_key=o.purchase_key WHERE o.created_at>=? AND p.state IN ('claimed','submitted','prepared','paid') AND o.order_json LIKE ?`).get(now()-ms,'%"mandateId":"'+mid+'"%').n;}catch{return 0;}};
  const usage=m=>({today:usd(spent(m.id,86400e3)),month:usd(spent(m.id,30*86400e3)),leftToday:usd(maxZ(BigInt(m.daily)-spent(m.id,86400e3))),leftMonth:usd(maxZ(BigInt(m.monthly)-spent(m.id,30*86400e3)))});
  const maxZ=x=>x<0n?0n:x;
  /** The ONE overall limit: an explicit owner-approved 'all' item (if any) clamped to the wallet's on-chain caps, else the wallet caps. */
  const minB=(a,b)=>a===null?b:b===null?a:(a<b?a:b);
  function overallList(){const ex=active().filter(m=>m.kind==='allowance'&&m.purpose===OVERALL&&!m.payees.length&&!m.hosts.length);let w=null;try{w=walletCaps?.()??null;}catch{w=null;}
    const ws=w&&BigInt(w.single??0)>0n?BigInt(w.single):null,wd=w&&BigInt(w.daily??0)>0n?BigInt(w.daily):null,wm=w&&BigInt(w.monthly??w.term??0)>0n?BigInt(w.monthly??w.term):null;
    if(ex.length)return ex.map(m=>({...m,single:minB(BigInt(m.single),ws).toString(),daily:minB(BigInt(m.daily),wd).toString(),monthly:minB(BigInt(m.monthly),wm).toString()}));
    if(ws===null)return [];const d=wd??ws,mo=wm??d*30n;
    return [{id:'wallet-limit',state:'active',kind:'allowance',purpose:OVERALL,purposeName:{zh:purposeName(OVERALL,true),en:purposeName(OVERALL,false)},label:null,single:ws.toString(),daily:(d<ws?ws:d).toString(),monthly:(mo<d?d:mo).toString(),payees:[],hosts:[],agents:[],recurring:null,oneOff:null,uses:0,virtual:true}];}
  /** Is this payment inside an owner allowance? Returns {ok:true, mandate} | {ok:false, why, mandate?, detail} | {ok:false, why:'no_mandate'}. */
  function match({purpose,payee,host,amount,agentId,idem}){const pk=purposeKey(purpose);const ms=active();
    const forAgent=m=>!m.agents?.length||m.agents.includes(agentId);
    // 1) owner one-off approvals for exactly this payee / host (any purpose)
    for(const m of ms.filter(m=>m.kind==='one_off'&&forAgent(m)))if((payee&&m.payees.includes(lc(payee)))||(host&&m.hosts.includes(lc(host))))
      {if(m.uses<1&&amount!==undefined&&amount<=BigInt(m.single))return {ok:true,mandate:m};}
    // ONE LIMIT: payee-bound recurring items first, then the single overall limit. The purpose never selects a limit.
    const hitP=m=>(payee&&m.payees.includes(lc(payee)))||(host&&m.hosts.includes(lc(host)));
    const cands=[...ms.filter(m=>m.kind==='recurring'&&forAgent(m)&&hitP(m)),...overallList().filter(m=>!m.virtual&&forAgent(m))]; // the wallet limit itself is enforced by the normal tier rules + chainif(!cands.length)return {ok:false,why:'no_mandate',purpose:pk};
    let best=null;
    for(const m of cands){const scoped=m.payees.length||m.hosts.length;const hit=(payee&&m.payees.includes(lc(payee)))||(host&&m.hosts.includes(lc(host)));
      if(scoped&&!hit){best??={ok:false,why:m.kind==='recurring'?'recurring_payee_changed':'payee_not_in_mandate',mandate:m};continue;}
      if(amount===undefined)return {ok:true,mandate:m};
      // a renewal that is above the agreed price or already paid this period never falls through to the overall limit
      if(m.kind==='recurring'){const per=PERIOD_MS[m.recurring.every];if(amount>BigInt(m.recurring.amount))return {ok:false,why:'recurring_price_up',mandate:m,detail:`${usd(amount)} > agreed ${usd(m.recurring.amount)}`};
        if(countIn(m.id,per*0.9)>=1)return {ok:false,why:'recurring_already_paid',mandate:m};return {ok:true,mandate:m};}
      if(amount>BigInt(m.single)){best={ok:false,why:'over_single',mandate:m,detail:`${usd(amount)} > ${usd(m.single)} per payment`};continue;}
      const d=spent(m.id,86400e3);if(d+amount>BigInt(m.daily)){best={ok:false,why:'over_daily',mandate:m,detail:`today ${usd(d)} + ${usd(amount)} > ${usd(m.daily)}`};continue;}
      const mo=spent(m.id,30*86400e3);if(mo+amount>BigInt(m.monthly)){best={ok:false,why:'over_monthly',mandate:m,detail:`30 days ${usd(mo)} + ${usd(amount)} > ${usd(m.monthly)}`};continue;}
      return {ok:true,mandate:m};}
    return best??{ok:false,why:'no_mandate',purpose:pk};}
  const used=mid=>{try{db.prepare(`UPDATE mandate SET uses=uses+1 WHERE id=?`).run(mid);const r=db.prepare(`SELECT * FROM mandate WHERE id=?`).get(mid);if(r?.kind==='one_off')db.prepare(`UPDATE mandate SET state='used' WHERE id=?`).run(mid);}catch{}};
  // ---- per-agent caps ----
  const agentRow=a=>{try{return db.prepare(`SELECT c.*,s.single AS single FROM agent_cap c LEFT JOIN agent_cap_single s ON s.agent_id=c.agent_id WHERE c.agent_id=?`).get(String(a));}catch{return null;}};
  const agentSpent=(a,ms)=>{try{return db.prepare(`SELECT o.amount FROM purchase_order o JOIN purchases p ON p.purchase_key=o.purchase_key WHERE o.agent_id=? AND o.created_at>=? AND p.state IN ('claimed','submitted','prepared','paid')`).all(String(a),now()-ms).reduce((s,x)=>s+BigInt(x.amount??0),0n);}catch{return 0n;}};
  function agentCheck(agentId,amount){if(!agentId||agentId==='owner')return null;const r=agentRow(agentId);if(!r)return null;
    if(r.stopped)return {state:'rejected',reason:'AGENT_STOPPED',nothingPaid:true,decision:'refuse',fix:'The owner stopped payments for this AI in the Kipurse app. Do not retry; tell the user.',say_to_user:'没有付款：你已在 Kipurse 里停用了这个 AI 的付款权限。/ Not paid: you turned off payments for this AI in Kipurse.'};
    if(amount===undefined)return null;
    if(r.single&&amount>BigInt(r.single))return {state:'rejected',reason:'AGENT_SINGLE_CAP',nothingPaid:true,capHit:true,detail:`this AI: ${usd(amount)} > ${usd(r.single)} per payment`,say_to_user:`没有付款：这笔超过了这个 AI 的每笔额度（${usd(r.single)} USDC）。/ Not paid: over this AI's per-payment limit (${usd(r.single)} USDC).`};
    if(r.daily&&agentSpent(agentId,86400e3)+amount>BigInt(r.daily))return {state:'rejected',reason:'AGENT_DAILY_CAP',nothingPaid:true,capHit:true,detail:`this AI: today ${usd(agentSpent(agentId,86400e3))} + ${usd(amount)} > ${usd(r.daily)}`,say_to_user:`没有付款：这个 AI 今天的额度（${usd(r.daily)} USDC）用完了。/ Not paid: this AI's daily limit (${usd(r.daily)} USDC) is used up.`};
    if(r.monthly&&agentSpent(agentId,30*86400e3)+amount>BigInt(r.monthly))return {state:'rejected',reason:'AGENT_MONTHLY_CAP',nothingPaid:true,capHit:true,detail:`this AI: 30 days over ${usd(r.monthly)}`,say_to_user:`没有付款：这个 AI 本月的额度（${usd(r.monthly)} USDC）用完了。/ Not paid: this AI's monthly limit is used up.`};
    return null;}
  const agentStop=(a,stop=true)=>{const r=agentRow(a);if(stop)db.prepare(`INSERT INTO agent_cap(agent_id,daily,monthly,stopped,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(agent_id) DO UPDATE SET stopped=1,updated_at=excluded.updated_at`).run(String(a),r?.daily??null,r?.monthly??null,now());return {ok:true,agentId:a,stopped:!!stop};};
  const agents=()=>{try{return db.prepare(`SELECT c.*,s.single AS single FROM agent_cap c LEFT JOIN agent_cap_single s ON s.agent_id=c.agent_id`).all().map(r=>({agentId:r.agent_id,single:r.single?usd(r.single):null,daily:r.daily?usd(r.daily):null,monthly:r.monthly?usd(r.monthly):null,stopped:!!r.stopped,spentToday:usd(agentSpent(r.agent_id,86400e3)),spentMonth:usd(agentSpent(r.agent_id,30*86400e3))}));}catch{return [];}};
  // ---- proposals (owner app draft or AI request) -> phone signer approval ----
  function propose({items,by='owner',reason='',user_request='',dedupe=null}){const its=items.map(normalizeItem);if(!its.length||its.length>12)throw Object.assign(Error('1..12 items'),{code:'bad_items'});
    if(by!=='owner'){const recent=db.prepare(`SELECT count(*) AS n FROM mandate_proposal WHERE by<>'owner' AND state='pending' AND created_at>?`).get(now()-3600e3).n;if(recent>=10&&!(dedupe&&db.prepare(`SELECT 1 FROM mandate_proposal WHERE dedupe=? AND state='pending'`).get(dedupe)))throw Object.assign(Error('too many open AI requests; ask the owner to look at the app'),{code:'too_many_requests'});
      if(its.length>1)throw Object.assign(Error('an AI may ask for one item at a time'),{code:'one_item_per_ai_request'});
      for(const i of its){if(i.kind==='agent_limits'){if((i.single&&BigInt(i.single)>AI_MAX.single)||(i.daily&&BigInt(i.daily)>AI_MAX.daily)||(i.monthly&&BigInt(i.monthly)>AI_MAX.monthly)||!i.daily||!i.monthly)throw Object.assign(Error('AI limit requests need daily <= 50 and monthly <= 300 USDC'),{code:'ai_request_too_large'});continue;}
        if(i.kind!=='one_off'&&(BigInt(i.single)>AI_MAX.single||BigInt(i.daily)>AI_MAX.daily||BigInt(i.monthly)>AI_MAX.monthly))throw Object.assign(Error('an AI may ask for at most 20 per payment, 50 a day, 300 a month; larger allowances are set by the owner in the app'),{code:'ai_request_too_large'});
        if(i.kind!=='one_off')i.expiresInDays=Math.min(i.expiresInDays,90);}}
    if(dedupe){const ex=db.prepare(`SELECT * FROM mandate_proposal WHERE dedupe=? AND state='pending'`).get(dedupe);if(ex)return {...view(ex),idempotent:true};}
    const p={id:id('apr'),items:its};db.prepare(`INSERT INTO mandate_proposal VALUES(?,?,?,?,?,?,?,?,NULL)`).run(p.id,now(),'pending',String(by).slice(0,80),cleanTxt(reason,300),cleanTxt(user_request,500),JSON.stringify(its),dedupe);
    const v=view(db.prepare(`SELECT * FROM mandate_proposal WHERE id=?`).get(p.id));if(by!=='owner')try{onProposal(v);}catch{}return v;}
  function view(r){if(!r)return null;const items=JSON.parse(r.items_json);return {id:r.id,state:r.state,by:r.by,reason:r.reason,user_request:r.user_request,createdAt:r.created_at,decidedAt:r.decided_at,
    items:items.map(i=>({...i,purposeName:i.purpose?{zh:purposeName(i.purpose,true),en:purposeName(i.purpose,false)}:null,payeeNames:(i.payees??[]).map(a=>nameOf(a)),human:human(i)})),digest:proposalDigest(wallet,{id:r.id,items}),signText:proposalText(wallet,{id:r.id,items})};}
  function human(i){if(i.kind==='agent_limits')return {zh:`${i.agentId}：${i.single?`每笔最多 ${usd(i.single)}，`:''}每天最多 ${i.daily?usd(i.daily):'不限'}，每月最多 ${i.monthly?usd(i.monthly):'不限'} USDC${i.resume?'，并恢复付款':''}`,en:`${i.agentId}: ${i.single?`up to ${usd(i.single)} per payment, `:''}up to ${i.daily?usd(i.daily):'no limit'} a day, ${i.monthly?usd(i.monthly):'no limit'} a month${i.resume?', payments back on':''}`};
    const pn=purposeName(i.purpose,true),pe=purposeName(i.purpose,false);const who=(i.payees??[]).map(a=>nameOf(a)??'未核实的新收款方').join('、');
    if(i.kind==='recurring'){const known=nameOf(i.recurring.payee);const nm=known??(i.recurring.name?`“${i.recurring.name}”（AI 给的名字，收款方未核实）`:'未核实的新收款方');return {zh:`${pn}：每${({day:'天',week:'周',month:'月',year:'年'})[i.recurring.every]}自动付 ${nm}，最多 ${usd(i.recurring.amount)} USDC；涨价或换收款方会再问你`,en:`${pe}: pay ${i.recurring.name??'this payee'} up to ${usd(i.recurring.amount)} USDC every ${i.recurring.every}${known?'':' (name given by the AI, payee not verified)'}; a higher price or another payee asks you again`};}
    if(i.kind==='one_off'){const pa=i.payees?.[0];const rr=pa?remembered().find(x=>x.address===lc(pa)):null;const known=rr?(rr.name??short(pa)):null;/* only owner-approved names, never AI labels */const sh=pa?short(pa):(i.hosts?.[0]??'');const ai=i.oneOff?.aiName;
      const swap=ai&&pa?rememberedByName(ai).filter(x=>x!==lc(pa)):[];
      const zh=known?`付 ${usd(i.single)} USDC 给「${known}」${sh}（${pn}）`:`⚠️ 新收款方 ${sh}，付 ${usd(i.single)} USDC（${pn}）。AI 可能被骗，确认是你要付的人再批准`+(ai?`。AI 说它是“${ai}”，未核实`:'')+(swap.length?`。注意：你以前批准的「${ai}」不是这个地址，可能是冒充`:'')+(i.oneOff?.remember!==false?'。批准后记住这个收款方':'');
      const en=known?`Pay ${usd(i.single)} USDC to "${known}" ${sh} (${pe})`:`⚠️ NEW payee ${sh}, ${usd(i.single)} USDC (${pe}). The AI could be tricked: approve only if you mean to pay them`+(ai?`. The AI calls it "${ai}" (not verified)`:'')+(swap.length?`. Warning: the "${ai}" you approved before has a DIFFERENT address, this may be an impostor`:'')+(i.oneOff?.remember!==false?'. Approving remembers this payee':'');
      return {zh,en,newPayee:!known,payeeSwap:swap.length>0};}
    if(i.purpose===OVERALL)return {zh:`AI 付款上限：每笔最多 ${usd(i.single)}，每天 ${usd(i.daily)}，总额 ${usd(i.monthly)} USDC`,en:`AI payment limit: up to ${usd(i.single)} per payment, ${usd(i.daily)} a day, ${usd(i.monthly)} total (USDC)`};
    return {zh:`${pn}：每笔最多 ${usd(i.single)}，每天 ${usd(i.daily)}，每月 ${usd(i.monthly)} USDC${who?'，只限 '+who:''}${i.hosts?.length?'，只限 '+i.hosts.join('、'):''}`,en:`${pe}: up to ${usd(i.single)} per payment, ${usd(i.daily)} a day, ${usd(i.monthly)} a month USDC${i.hosts?.length?', only '+i.hosts.join(', '):''}`};}
  const getProposal=pid=>view(db.prepare(`SELECT * FROM mandate_proposal WHERE id=?`).get(String(pid)));
  const proposals=(all=false)=>db.prepare(all?`SELECT * FROM mandate_proposal ORDER BY created_at DESC LIMIT 50`:`SELECT * FROM mandate_proposal WHERE state='pending' AND created_at>? ORDER BY created_at DESC`).all(...(all?[]:[now()-7*86400e3])).map(view);
  /** verify(digest) -> bool (phone signer P-256 over the digest). */
  function approve(pid,verify){const r=db.prepare(`SELECT * FROM mandate_proposal WHERE id=?`).get(String(pid));if(!r)return {ok:false,error:'unknown_proposal'};if(r.state!=='pending')return {ok:false,error:'not_pending',state:r.state};
    if(now()-r.created_at>7*86400e3){db.prepare(`UPDATE mandate_proposal SET state='expired' WHERE id=?`).run(r.id);return {ok:false,error:'expired'};}
    const items=JSON.parse(r.items_json);if(!verify(proposalDigest(wallet,{id:r.id,items})))return {ok:false,error:'not_owner'};
    const made=[];const t=now();
    db.exec('BEGIN');try{for(const i of items){
      if(i.kind==='agent_limits'){db.prepare(`INSERT INTO agent_cap(agent_id,daily,monthly,stopped,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET daily=excluded.daily,monthly=excluded.monthly,stopped=CASE WHEN ? THEN 0 ELSE agent_cap.stopped END,updated_at=excluded.updated_at`).run(i.agentId,i.daily,i.monthly,0,t,i.resume?1:0);
        db.prepare(`INSERT INTO agent_cap_single VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET single=excluded.single`).run(i.agentId,i.single??null);made.push({agentId:i.agentId});continue;}
      if(i.replaces)db.prepare(`UPDATE mandate SET state='replaced' WHERE id=? AND state='active'`).run(i.replaces);
      // ONE LIMIT: a new owner-approved overall limit (no scope) replaces the old one
      if(i.kind==='allowance'&&!i.payees.length&&!i.hosts.length&&!i.agents.length)for(const m of active())if(m.kind==='allowance'&&m.purpose===i.purpose&&!m.payees.length&&!m.hosts.length&&!m.agents.length)db.prepare(`UPDATE mandate SET state='replaced' WHERE id=?`).run(m.id);
      if(i.kind==='one_off'&&i.oneOff?.payee&&i.oneOff.remember!==false)db.prepare(`INSERT INTO owner_payee VALUES(?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET host=COALESCE(excluded.host,owner_payee.host),approved_at=excluded.approved_at,proposal_id=excluded.proposal_id`).run(lc(i.oneOff.payee),nameOf(i.oneOff.payee)??i.oneOff.aiName??null,i.oneOff.host??i.hosts?.[0]??null,i.purpose,t,r.id);
      if(i.kind==='recurring'&&i.recurring?.payee)db.prepare(`INSERT OR IGNORE INTO owner_payee VALUES(?,?,?,?,?,?)`).run(lc(i.recurring.payee),i.recurring.name??null,null,i.purpose,t,r.id);
      for(const pa of (i.kind==='allowance'?i.payees:[]))db.prepare(`INSERT OR IGNORE INTO owner_payee VALUES(?,?,?,?,?,?)`).run(lc(pa),nameOf(pa),null,i.purpose,t,r.id);
      const mid=id('mnd');const {kind,purpose,expiresInDays,replaces,...j}=i;db.prepare(`INSERT INTO mandate VALUES(?,?,?,?,?,?,?,?,?,0)`).run(mid,t,t,t+Math.round(expiresInDays*86400e3),'active',kind,purpose,JSON.stringify(j),r.id);made.push({mandateId:mid,kind,purpose});}
      db.prepare(`UPDATE mandate_proposal SET state='approved',decided_at=? WHERE id=?`).run(t,r.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    return {ok:true,state:'approved',made};}
  const reject=pid=>{const x=db.prepare(`UPDATE mandate_proposal SET state='rejected',decided_at=? WHERE id=? AND state='pending'`).run(now(),String(pid));return {ok:x.changes>0};};
  const revoke=mid=>{const x=db.prepare(`UPDATE mandate SET state='revoked' WHERE id=? AND state='active'`).run(String(mid));return {ok:x.changes>0};};
  const list=()=>active().filter(m=>m.kind!=='one_off'||m.uses<1).map(m=>({...m,payeeNames:m.payees.map(a=>nameOf(a)),usage:usage(m),human:human({...m,expiresInDays:0})}));
  return {OVERALL,CATEGORIES,classifyCategory,overall:()=>{const o=overallList()[0]??null;return o?{...o,total:o.monthly,usage:usage(o)}:null;},remember,remembered,isRemembered,rememberedByName,forget,match,used,agentCheck,agentStop,agents,propose,getProposal,proposals,approve,reject,revoke,list,usage,human,BEGINNER_DEFAULTS,PURPOSES};}
