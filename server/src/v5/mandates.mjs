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
import {makeScope,scopeCheck} from './limit-scope.mjs';
import {costOf,incomingCost,missingOk} from './spend-cost.mjs';
const DEFAULT_MAX_NF=50_000n;   // t1281: the network fee cap every wallet signs (maxNetworkFee 0.05 USDC)
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
/** ONE LIMIT (owner 2026-10-27 t592): the owner sets ONE overall limit (per payment / per day / total; no monthly cap, owner 2026-10-27 14:23). Categories are labels only,
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
export const BEGINNER_DEFAULTS=[{purpose:'all',single:'5',daily:'20',monthly:'100',on:true}]; // ONE overall limit (t592)
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
  /* t1281 review: limits now count amount + fee (+ network fee at claim), so an omitted daily defaults to the per-payment cap PLUS the
     highest fee the owner signed (0.1%) and the max network fee - one payment of exactly `single` still fits its own day */
  const d=daily??(single+(single*1000n+999999n)/1000000n+DEFAULT_MAX_NF),mo=monthly??(d*30n);if(d<single||mo<d)bad('caps_order','need single <= daily <= monthly');
  const payees=[...new Set((x.payees??[]).map(String).filter(a=>ADDR.test(a)).map(lc))].slice(0,16);
  const hosts=[...new Set((x.hosts??[]).map(h=>lc(h).replace(/^https?:\/\//,'').replace(/\/.*$/,'')).filter(h=>/^[a-z0-9.-]{3,253}$/.test(h)))].slice(0,16);
  const agents=[...new Set((x.agents??[]).map(a=>cleanTxt(a,80)).filter(Boolean))].slice(0,8);
  let recurring=null;if(x.recurring){const r=x.recurring;const p=ADDR.test(String(r.payee??''))?lc(r.payee):bad('recurring_payee_required');const a=atom(r.amount);if(!a)bad('recurring_amount_required');
    const every=['day','week','month','year'].includes(r.every)?r.every:'month';recurring={payee:p,amount:a.toString(),every,name:cleanTxt(r.name,60)||null};}
  let oneOff=null;if(x.oneOff){const o=x.oneOff;const p=ADDR.test(String(o.payee??''))?lc(o.payee):(o.host?null:bad('one_off_payee_required'));
    oneOff={payee:p,host:o.host?lc(o.host):null,amount:single.toString(),idem:cleanTxt(o.idem,128)||null,remember:o.remember!==false,aiName:cleanTxt(o.aiName,60)||null,...(o.ask===true?{ask:true,note:cleanTxt(o.note,80)||null,...(o.dup===true?{dup:true}:{})}:{})};}/* t1280: dup = suspected duplicate purchase (part of what Face ID signs) *//* t1170: ask = 'do you know this payee?' card (trust | once | reject) */
  const ttlDays=Number(x.expiresInDays??(oneOff?1:365));
  return {kind:oneOff?'one_off':recurring?'recurring':'allowance',purpose,label:cleanTxt(x.label,60)||null,single:single.toString(),daily:(recurring?BigInt(recurring.amount):d).toString(),monthly:(recurring?BigInt(recurring.amount)*(recurring.every==='day'?31n:recurring.every==='week'?5n:1n):mo).toString(),
    payees:recurring?[recurring.payee]:oneOff?.payee?[oneOff.payee]:payees,hosts:oneOff?.host?[oneOff.host]:hosts,agents,recurring,oneOff,expiresInDays:Math.max(1/24,Math.min(366,ttlDays||365)),replaces:x.replaces?cleanTxt(x.replaces,40):null};}
/** Domain-separated digest the phone signer signs (SHA-256 of text; never an EIP-712 / wallet hash). The app shows the same items. */
/** t1181 (decision 84): with a scope the signed text also names the network + token (appended after items, so the phone's prefix check (build 71) still holds). */
export const proposalText=(wallet,p)=>`Kipurse allowance approval v1\nwallet:${lc(wallet)}\nid:${p.id}\nitems:${JSON.stringify(p.items)}`+(p.scope?`\nchain:${p.scope.chainId}\ntoken:${p.scope.token}`:'');
export const proposalDigest=(wallet,p)=>'0x'+createHash('sha256').update(proposalText(wallet,p)).digest('hex');
/** t1170: the owner's choice (trust | once) is part of what Face ID signs, so a 'once' signature can never be replayed as 'trust'. */
export const ASK_MODES=['trust','once'];
export const askText=(wallet,p,mode)=>proposalText(wallet,p)+`\nmode:${mode}`;
export const askDigest=(wallet,p,mode)=>'0x'+createHash('sha256').update(askText(wallet,p,mode)).digest('hex');
/** t1280 (decision 140): a suspected-duplicate card offers only 'once' (the payee is already known; trusting it means nothing) */
export const askModesFor=items=>items?.[0]?.oneOff?.dup===true?['once']:ASK_MODES;
export const isAskItems=items=>Array.isArray(items)&&items.length===1&&items[0]?.kind==='one_off'&&items[0]?.oneOff?.ask===true&&!!items[0]?.oneOff?.payee;
/** one-payment cards (one_off only) live 24 h (t1170 decision 3); other proposals keep 7 days */
const proposalTtl=items=>Array.isArray(items)&&items.length&&items.every(i=>i?.kind==='one_off')?86400e3:7*86400e3;
/** t1181 (decision 84): `scope` = {chainId, token} of the engine. Every mandate (json) and per-AI cap (side table limit_scope, so
 *  agent_cap keeps its 5 columns and older releases stay rollback-safe) is pinned to it; rows from before t1181 are migrated
 *  to it once (same limits, same behaviour). A record of another network / token never covers a payment. */
/* t1281 (decision 141): costParams() = {ppm, maxNetworkFee}: allowance / per-AI daily + monthly spend counts amount + protocol fee + network fee
   (spend-cost.mjs), and so does the payment being checked; per-payment (single) caps compare the amount only. */
export function createMandates({db,wallet='',now=()=>Date.now(),nameOf=()=>null,onProposal=()=>{},walletCaps=null,scope=null,costParams=()=>({ppm:0n,maxNetworkFee:0n})}){
  const cp=()=>{try{return costParams()??{ppm:0n,maxNetworkFee:0n};}catch{return {ppm:0n,maxNetworkFee:0n};}};
  const costIn=(amount,networkFee=0n)=>incomingCost(amount,{ppm:cp().ppm,networkFee});
  const SC=scope?makeScope(scope.chainId,scope.token):null;
  db.exec(`CREATE TABLE IF NOT EXISTS mandate(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, approved_at INTEGER, expires_at INTEGER, state TEXT NOT NULL, kind TEXT NOT NULL, purpose TEXT, json TEXT NOT NULL, proposal_id TEXT, uses INTEGER NOT NULL DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS mandate_proposal(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL, by TEXT, reason TEXT, user_request TEXT, items_json TEXT NOT NULL, dedupe TEXT, decided_at INTEGER)`);
  /* t1210 decision 95: when a pending AI request is pushed again (repeat or remind), at most once per 5 min per request */
  db.exec(`CREATE TABLE IF NOT EXISTS mandate_repush(id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS owner_payee(address TEXT PRIMARY KEY, name TEXT, host TEXT, purpose TEXT, approved_at INTEGER NOT NULL, proposal_id TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_cap(agent_id TEXT PRIMARY KEY, daily TEXT, monthly TEXT, stopped INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
  // t899 per-payment cap lives in a SIDE table so agent_cap keeps its 5 columns (older releases stay rollback-safe).
  db.exec(`CREATE TABLE IF NOT EXISTS agent_cap_single(agent_id TEXT PRIMARY KEY, single TEXT)`);
  try{if(db.prepare(`PRAGMA table_info(agent_cap)`).all().some(c=>c.name==='single')){db.exec(`INSERT OR REPLACE INTO agent_cap_single SELECT agent_id,single FROM agent_cap WHERE single IS NOT NULL`);db.exec(`ALTER TABLE agent_cap DROP COLUMN single`);}}catch{}
  db.exec(`CREATE TABLE IF NOT EXISTS limit_scope(kind TEXT NOT NULL, id TEXT NOT NULL, chain_id INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY(kind,id))`);
  if(SC){try{db.exec('BEGIN');
    for(const r of db.prepare(`SELECT id,json FROM mandate`).all()){let j;try{j=JSON.parse(r.json);}catch{continue;}if(j&&typeof j==='object'&&(j.chainId==null||j.token==null))db.prepare(`UPDATE mandate SET json=? WHERE id=?`).run(JSON.stringify({...j,chainId:SC.chainId,token:SC.token}),r.id);}
    db.prepare(`INSERT OR IGNORE INTO limit_scope SELECT 'agent',agent_id,?,? FROM agent_cap`).run(SC.chainId,SC.token);
    db.exec('COMMIT');}catch{try{db.exec('ROLLBACK');}catch{}}}
  const scopeAgent=a=>{if(SC)try{db.prepare(`INSERT OR IGNORE INTO limit_scope VALUES('agent',?,?,?)`).run(String(a),SC.chainId,SC.token);}catch{}};
  const agentScopeRow=a=>{try{const r=db.prepare(`SELECT chain_id,token FROM limit_scope WHERE kind='agent' AND id=?`).get(String(a));return r?{chainId:r.chain_id,token:r.token}:{};}catch{return {};}};
  /** the payment scope argument of match / agentCheck: undefined = unscoped caller (unchanged behaviour). */
  const payScope=x=>x&&(x.chainId!==undefined||x.token!==undefined)?{chainId:x.chainId,token:x.token}:null;
  const id=p=>p+'_'+randomBytes(6).toString('hex');
  migrateToOneLimit();
  /** ONE LIMIT migration (t592): old per-purpose allowances are ignored (read-only, no ledger writes). The ONE overall limit is the
   *  wallet's existing on-chain limit (per payment / per day / term), so no cap is raised; the AI-unattended day/month totals still apply. */
  // read-only migration: nothing is written to any ledger; old per-purpose rows stay as they are but are ignored (never match, never listed)
  function migrateToOneLimit(){}
  const remembered=()=>{try{return db.prepare(`SELECT * FROM owner_payee`).all();}catch{return [];}};
  const isRemembered=a=>{try{return !!db.prepare(`SELECT 1 FROM owner_payee WHERE address=?`).get(lc(a));}catch{return false;}};
  const rememberedByName=n=>{const k=String(n??'').trim().toLowerCase();if(!k)return [];return remembered().filter(r=>String(r.name??'').trim().toLowerCase()===k).map(r=>r.address);};
  /** owner-only (Face ID route / tests): remember an exact payee as owner-established */
  const remember=(a,name=null,purpose=null,host=null,proposalId=null)=>{if(!ADDR.test(String(a??'')))return {ok:false};db.prepare(`INSERT INTO owner_payee VALUES(?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET name=COALESCE(excluded.name,owner_payee.name),approved_at=excluded.approved_at,proposal_id=COALESCE(excluded.proposal_id,owner_payee.proposal_id)`).run(lc(a),name?cleanTxt(name,60):null,host,purpose,now(),proposalId);return {ok:true};};
  const forget=a=>({ok:db.prepare(`DELETE FROM owner_payee WHERE address=?`).run(lc(a)).changes>0});
  const row2m=r=>{const j=JSON.parse(r.json);return {id:r.id,state:r.state,kind:r.kind,purpose:r.purpose,purposeName:{zh:purposeName(r.purpose,true),en:purposeName(r.purpose,false)},...j,createdAt:r.created_at,approvedAt:r.approved_at,expiresAt:r.expires_at,uses:r.uses};};
  const active=()=>{const t=now();return db.prepare(`SELECT * FROM mandate WHERE state='active'`).all().filter(r=>!r.expires_at||r.expires_at>t).filter(r=>!(r.kind==='allowance'&&r.purpose!=='all')).map(row2m);}; // ONE LIMIT: old per-purpose allowances are retired
  /** atomic spend inside one mandate in the window (paid / in-flight rows only). */
  const spent=(mid,ms)=>{try{const c=cp();return db.prepare(`SELECT o.amount,o.order_json,p.result,p.state FROM purchase_order o JOIN purchases p ON p.purchase_key=o.purchase_key WHERE o.created_at>=? AND p.state IN ('claimed','submitted','prepared','paid') AND o.order_json LIKE ?`).all(now()-ms,'%"mandateId":"'+mid+'"%').reduce((a,x)=>a+costOf(x,c),0n);}catch(e){return missingOk(e);}};/* t1281: amount + fees */
  const countIn=(mid,ms)=>{try{return db.prepare(`SELECT count(*) AS n FROM purchase_order o JOIN purchases p ON p.purchase_key=o.purchase_key WHERE o.created_at>=? AND p.state IN ('claimed','submitted','prepared','paid') AND o.order_json LIKE ?`).get(now()-ms,'%"mandateId":"'+mid+'"%').n;}catch(e){return Number(missingOk(e,0n));}};
  const usage=m=>{const d=spent(m.id,86400e3),mo=spent(m.id,30*86400e3),lt=maxZ(BigInt(m.daily)-d),lm=maxZ(BigInt(m.monthly)-mo);/* t1166: decimal USDC + base units side by side */return {today:usd(d),month:usd(mo),leftToday:usd(lt),leftMonth:usd(lm),todayAtomic:String(d),monthAtomic:String(mo),leftTodayAtomic:String(lt),leftMonthAtomic:String(lm)};};
  const maxZ=x=>x<0n?0n:x;
  /** The ONE overall limit: an explicit owner-approved 'all' item (if any) clamped to the wallet's on-chain caps, else the wallet caps. */
  const minB=(a,b)=>a===null?b:b===null?a:(a<b?a:b);
  function overallList(){const ex=active().filter(m=>m.kind==='allowance'&&m.purpose===OVERALL&&!m.payees.length&&!m.hosts.length);let w=null;try{w=walletCaps?.()??null;}catch{w=null;}
    const ws=w&&BigInt(w.single??0)>0n?BigInt(w.single):null,wd=w&&BigInt(w.daily??0)>0n?BigInt(w.daily):null,wm=w&&BigInt(w.monthly??w.term??0)>0n?BigInt(w.monthly??w.term):null;
    if(ex.length)return ex.map(m=>({...m,single:minB(BigInt(m.single),ws).toString(),daily:minB(BigInt(m.daily),wd).toString(),monthly:minB(BigInt(m.monthly),wm).toString()}));
    if(ws===null)return [];const d=wd??ws,mo=wm??d*30n;
    return [{id:'wallet-limit',state:'active',kind:'allowance',purpose:OVERALL,purposeName:{zh:purposeName(OVERALL,true),en:purposeName(OVERALL,false)},label:null,single:ws.toString(),daily:(d<ws?ws:d).toString(),monthly:(mo<d?d:mo).toString(),payees:[],hosts:[],agents:[],recurring:null,oneOff:null,uses:0,virtual:true}];}
  /** Is this payment inside an owner allowance? Returns {ok:true, mandate} | {ok:false, why, mandate?, detail} | {ok:false, why:'no_mandate'}. */
  function match({purpose,payee,host,amount,agentId,idem,chainId,token,networkFee=0n}){const pk=purposeKey(purpose);
    /* t1181: mandates of another network / token never cover this payment */const ps=payScope({chainId,token});let dropped=false;
    const inScope=m=>{if(!ps)return true;const bad=scopeCheck('AI allowance',m,ps,SC);if(bad)dropped=true;return !bad;};
    const ms=active().filter(inScope);
    const forAgent=m=>!m.agents?.length||m.agents.includes(agentId);
    // 1) owner one-off approvals for exactly this payee / host (any purpose)
    for(const m of ms.filter(m=>m.kind==='one_off'&&forAgent(m)))if((payee&&m.payees.includes(lc(payee)))||(host&&m.hosts.includes(lc(host))))
      {if(m.uses<1&&amount!==undefined&&amount<=BigInt(m.single))return {ok:true,mandate:m};}
    // ONE LIMIT: payee-bound recurring items first, then the single overall limit. The purpose never selects a limit.
    const hitP=m=>(payee&&m.payees.includes(lc(payee)))||(host&&m.hosts.includes(lc(host)));
    const cands=[...ms.filter(m=>m.kind==='recurring'&&forAgent(m)&&hitP(m)),...overallList().filter(m=>!m.virtual&&forAgent(m)&&inScope(m))]; // the wallet limit itself is enforced by the normal tier rules + chainif(!cands.length)return {ok:false,why:'no_mandate',purpose:pk};
    let best=null;
    for(const m of cands){const scoped=m.payees.length||m.hosts.length;const hit=(payee&&m.payees.includes(lc(payee)))||(host&&m.hosts.includes(lc(host)));
      if(scoped&&!hit){best??={ok:false,why:m.kind==='recurring'?'recurring_payee_changed':'payee_not_in_mandate',mandate:m};continue;}
      if(amount===undefined)return {ok:true,mandate:m};
      // a renewal that is above the agreed price or already paid this period never falls through to the overall limit
      if(m.kind==='recurring'){const per=PERIOD_MS[m.recurring.every];if(amount>BigInt(m.recurring.amount))return {ok:false,why:'recurring_price_up',mandate:m,detail:`${usd(amount)} > agreed ${usd(m.recurring.amount)}`};
        if(countIn(m.id,per*0.9)>=1)return {ok:false,why:'recurring_already_paid',mandate:m};return {ok:true,mandate:m};}
      if(amount>BigInt(m.single)){best={ok:false,why:'over_single',mandate:m,detail:`${usd(amount)} > ${usd(m.single)} per payment`};continue;}
      const cost=costIn(amount,networkFee);/* t1281: day / month count amount + fee (+ the quoted network fee at claim time) */
      const d=spent(m.id,86400e3);if(d+cost>BigInt(m.daily)){best={ok:false,why:'over_daily',mandate:m,detail:`today ${usd(d)} + ${usd(cost)} > ${usd(m.daily)} (fees included)`};continue;}
      const mo=spent(m.id,30*86400e3);if(mo+cost>BigInt(m.monthly)){best={ok:false,why:'over_monthly',mandate:m,detail:`30 days ${usd(mo)} + ${usd(cost)} > ${usd(m.monthly)} (fees included)`};continue;}
      return {ok:true,mandate:m};}
    return best??{ok:false,why:dropped?'scope_mismatch':'no_mandate',purpose:pk};}
  /* t1278 S4: a one-off approval is consumed when the payment CLAIMS it (engine, inside the claim transaction: consume), so two concurrent
     payments cannot both use it; release() gives it back after a definite failure; used(id,{consumed:true}) then only closes it. */
  const consume=mid=>{try{return db.prepare(`UPDATE mandate SET uses=uses+1 WHERE id=? AND kind='one_off' AND uses<1 AND state='active'`).run(mid).changes>0;}catch{return false;}};
  const release=mid=>{try{db.prepare(`UPDATE mandate SET uses=uses-1 WHERE id=? AND kind='one_off' AND uses>0 AND state='active'`).run(mid);}catch{}};
  const used=(mid,{consumed=false}={})=>{try{if(!consumed)db.prepare(`UPDATE mandate SET uses=uses+1 WHERE id=?`).run(mid);const r=db.prepare(`SELECT * FROM mandate WHERE id=?`).get(mid);if(r?.kind==='one_off')db.prepare(`UPDATE mandate SET state='used' WHERE id=?`).run(mid);}catch{}};
  // ---- per-agent caps ----
  const agentRow=a=>{try{return db.prepare(`SELECT c.*,s.single AS single FROM agent_cap c LEFT JOIN agent_cap_single s ON s.agent_id=c.agent_id WHERE c.agent_id=?`).get(String(a));}catch{return null;}};
  /* t1264: per-AI caps count only the AI's own payments: not owner-approved asks, owner or withdrawal rows (purchase_origin, same rule as the AI total) */
  try{db.exec(`CREATE TABLE IF NOT EXISTS purchase_origin(purchase_key TEXT PRIMARY KEY, origin TEXT NOT NULL)`);}catch{}
  const agentSpent=(a,ms)=>{try{const c=cp();return db.prepare(`SELECT o.amount,p.result,p.state FROM purchase_order o JOIN purchases p ON p.purchase_key=o.purchase_key LEFT JOIN purchase_origin g ON g.purchase_key=o.purchase_key WHERE o.agent_id=? AND o.created_at>=? AND p.state IN ('claimed','submitted','prepared','paid') AND (g.origin IS NULL OR g.origin='ai')`).all(String(a),now()-ms).reduce((s,x)=>s+costOf(x,c),0n);}catch(e){return missingOk(e);}};/* t1281: amount + fees */
  /* t1278 S4: extra = atomic USDC of this AI not yet in purchase_order (its pending 10-minute holds), added to today's / this month's spend */
  function agentCheck(agentId,amount,scope,extra=0n,{networkFee=0n}={}){if(!agentId||agentId==='owner')return null;const r=agentRow(agentId);if(!r)return null;
    {const ps=payScope(scope);if(ps&&!r.stopped){const bad=scopeCheck('per-AI limit',agentScopeRow(agentId),ps,SC);if(bad)return bad;}}/* t1181 */
    if(r.stopped)return {state:'rejected',reason:'AGENT_STOPPED',nothingPaid:true,decision:'refuse',fix:'The owner stopped payments for this AI in the Kipurse app. Do not retry; tell the user.',say_to_user:'没有付款：你已在 Kipurse 里停用了这个 AI 的付款权限。/ Not paid: you turned off payments for this AI in Kipurse.'};
    if(amount===undefined)return null;
    if(r.single&&amount>BigInt(r.single))return {state:'rejected',reason:'AGENT_SINGLE_CAP',nothingPaid:true,capHit:true,detail:`this AI: ${usd(amount)} > ${usd(r.single)} per payment`,say_to_user:`没有付款：这笔超过了这个 AI 的每笔额度（${usd(r.single)} USDC）。/ Not paid: over this AI's per-payment limit (${usd(r.single)} USDC).`};
    const cost=costIn(amount,networkFee);/* t1281: day / month count amount + fee (+ the quoted network fee at claim time); single: the amount */
    if(r.daily&&agentSpent(agentId,86400e3)+BigInt(extra)+cost>BigInt(r.daily))return {state:'rejected',reason:'AGENT_DAILY_CAP',nothingPaid:true,capHit:true,detail:`this AI: today ${usd(agentSpent(agentId,86400e3)+BigInt(extra))} + ${usd(cost)} > ${usd(r.daily)} (fees included)`,say_to_user:`没有付款：这个 AI 今天的额度（${usd(r.daily)} USDC）用完了。/ Not paid: this AI's daily limit (${usd(r.daily)} USDC) is used up.`};
    if(r.monthly&&agentSpent(agentId,30*86400e3)+BigInt(extra)+cost>BigInt(r.monthly))return {state:'rejected',reason:'AGENT_MONTHLY_CAP',nothingPaid:true,capHit:true,detail:`this AI: 30 days over ${usd(r.monthly)}`,say_to_user:`没有付款：这个 AI 本月的额度（${usd(r.monthly)} USDC）用完了。/ Not paid: this AI's monthly limit is used up.`};
    return null;}
  const agentStop=(a,stop=true)=>{const r=agentRow(a);if(stop)scopeAgent(a);if(stop)db.prepare(`INSERT INTO agent_cap(agent_id,daily,monthly,stopped,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(agent_id) DO UPDATE SET stopped=1,updated_at=excluded.updated_at`).run(String(a),r?.daily??null,r?.monthly??null,now());return {ok:true,agentId:a,stopped:!!stop};};
  const agents=()=>{try{return db.prepare(`SELECT c.*,s.single AS single FROM agent_cap c LEFT JOIN agent_cap_single s ON s.agent_id=c.agent_id`).all().map(r=>{const st=agentSpent(r.agent_id,86400e3),sm=agentSpent(r.agent_id,30*86400e3);return {agentId:r.agent_id,single:r.single?usd(r.single):null,daily:r.daily?usd(r.daily):null,monthly:r.monthly?usd(r.monthly):null,stopped:!!r.stopped,spentToday:usd(st),spentMonth:usd(sm),
    /* t1166 */singleAtomic:r.single?String(r.single):null,dailyAtomic:r.daily?String(r.daily):null,monthlyAtomic:r.monthly?String(r.monthly):null,spentTodayAtomic:String(st),spentMonthAtomic:String(sm)};});}catch{return [];}};
  // ---- proposals (owner app draft or AI request) -> phone signer approval ----
  function propose({items,by='owner',reason='',user_request='',dedupe=null}){const its=items.map(normalizeItem);if(!its.length||its.length>12)throw Object.assign(Error('1..12 items'),{code:'bad_items'});
    if(by!=='owner'){const recent=db.prepare(`SELECT count(*) AS n FROM mandate_proposal WHERE by<>'owner' AND state='pending' AND created_at>?`).get(now()-3600e3).n;if(recent>=10&&!(dedupe&&db.prepare(`SELECT 1 FROM mandate_proposal WHERE dedupe=? AND state='pending'`).get(dedupe)))throw Object.assign(Error('too many open AI requests; ask the owner to look at the app'),{code:'too_many_requests'});
      if(its.length>1)throw Object.assign(Error('an AI may ask for one item at a time'),{code:'one_item_per_ai_request'});
      for(const i of its){if(i.kind==='agent_limits'){if((i.single&&BigInt(i.single)>AI_MAX.single)||(i.daily&&BigInt(i.daily)>AI_MAX.daily)||(i.monthly&&BigInt(i.monthly)>AI_MAX.monthly)||!i.daily||!i.monthly)throw Object.assign(Error('AI limit requests need daily <= 50 and monthly <= 300 USDC'),{code:'ai_request_too_large'});continue;}
        if(i.kind!=='one_off'&&(BigInt(i.single)>AI_MAX.single||BigInt(i.daily)>AI_MAX.daily||BigInt(i.monthly)>AI_MAX.monthly))throw Object.assign(Error('an AI may ask for at most 20 per payment, 50 a day, 300 a month; larger allowances are set by the owner in the app'),{code:'ai_request_too_large'});
        if(i.kind!=='one_off')i.expiresInDays=Math.min(i.expiresInDays,90);}}
    /* t1264: a pending request past its lifetime (24 h one-off / 7 d) is closed first, so dedupe never hands back a dead card: a new one is made */
    if(dedupe){for(const r of db.prepare(`SELECT id,created_at,items_json FROM mandate_proposal WHERE dedupe=? AND state='pending'`).all(dedupe)){let its=null;try{its=JSON.parse(r.items_json);}catch{}
        if(now()-r.created_at>proposalTtl(its))db.prepare(`UPDATE mandate_proposal SET state='expired',decided_at=? WHERE id=? AND state='pending'`).run(now(),r.id);}}
    if(dedupe){const ex=db.prepare(`SELECT * FROM mandate_proposal WHERE dedupe=? AND state='pending' ORDER BY created_at DESC`).get(dedupe);if(ex){const v={...view(ex),idempotent:true};/* t1210 decision 95: same card again (no new request, no money path); only the phone is reminded, max once per 5 min */if(by!=='owner')v.repushed=repush(ex).pushed;return v;}}
    const p={id:id('apr'),items:its};db.prepare(`INSERT INTO mandate_proposal VALUES(?,?,?,?,?,?,?,?,NULL)`).run(p.id,now(),'pending',String(by).slice(0,80),cleanTxt(reason,300),cleanTxt(user_request,500),JSON.stringify(its),dedupe);
    const v=view(db.prepare(`SELECT * FROM mandate_proposal WHERE id=?`).get(p.id));if(by!=='owner')try{onProposal(v);}catch{}return v;}
  function view(r){if(!r)return null;const items=JSON.parse(r.items_json);return {id:r.id,state:r.state,by:r.by,reason:r.reason,user_request:r.user_request,createdAt:r.created_at,decidedAt:r.decided_at,
    items:items.map(i=>({...i,purposeName:i.purpose?{zh:purposeName(i.purpose,true),en:purposeName(i.purpose,false)}:null,payeeNames:(i.payees??[]).map(a=>nameOf(a)),human:human(i)})),digest:proposalDigest(wallet,{id:r.id,items,scope:SC}),signText:proposalText(wallet,{id:r.id,items,scope:SC}),...(isAskItems(items)?{ask:{payee:items[0].oneOff.payee,amount:items[0].single,expiresAt:r.created_at+proposalTtl(items),modes:Object.fromEntries(askModesFor(items).map(m=>[m,{digest:askDigest(wallet,{id:r.id,items,scope:SC},m),signText:askText(wallet,{id:r.id,items,scope:SC},m)}]))}}:{})};}
  function human(i){if(i.kind==='agent_limits')return {zh:`${i.agentId}：${i.single?`每笔最多 ${usd(i.single)}，`:''}每天最多 ${i.daily?usd(i.daily):'不限'}，每月最多 ${i.monthly?usd(i.monthly):'不限'} USDC${i.resume?'，并恢复付款':''}`,en:`${i.agentId}: ${i.single?`up to ${usd(i.single)} per payment, `:''}up to ${i.daily?usd(i.daily):'no limit'} a day, ${i.monthly?usd(i.monthly):'no limit'} a month${i.resume?', payments back on':''}`};
    const pn=purposeName(i.purpose,true),pe=purposeName(i.purpose,false);const who=(i.payees??[]).map(a=>nameOf(a)??'未核实的新收款方').join('、');
    if(i.kind==='recurring'){const known=nameOf(i.recurring.payee);const nm=known??(i.recurring.name?`“${i.recurring.name}”（AI 给的名字，收款方未核实）`:'未核实的新收款方');return {zh:`${pn}：每${({day:'天',week:'周',month:'月',year:'年'})[i.recurring.every]}自动付 ${nm}，最多 ${usd(i.recurring.amount)} USDC；涨价或换收款方会再问你`,en:`${pe}: pay ${i.recurring.name??'this payee'} up to ${usd(i.recurring.amount)} USDC every ${i.recurring.every}${known?'':' (name given by the AI, payee not verified)'}; a higher price or another payee asks you again`};}
    if(i.kind==='one_off'&&i.oneOff?.ask&&i.oneOff?.dup===true){const pa=i.payees?.[0];const sh=pa?short(pa):'';const note=i.oneOff?.note;/* t1280: suspected duplicate card */
      const zh=`⚠️ 疑似重复购买：10 分钟内已经给 ${sh} 付过同样的 ${usd(i.single)} USDC（用途：${note??pn}）。这次还没付。确实要再买一次才点「再付一次」，不需要就点「拒绝」`;
      const en=`⚠️ Possible duplicate: ${usd(i.single)} USDC already went to ${sh} in the last 10 minutes (for: ${note??pe}). Nothing has been paid for this one. Tap "Pay again" only if you really want a second one; otherwise tap "Decline"`;
      return {zh,en,newPayee:false,payeeSwap:false,ask:true,dup:true};}
    if(i.kind==='one_off'&&i.oneOff?.ask){const pa=i.payees?.[0];const sh=pa?short(pa):'';const ai=i.oneOff?.aiName;const note=i.oneOff?.note;const swap=ai&&pa?rememberedByName(ai).filter(x=>x!==lc(pa)):[];
      const who=ai?`“${ai}”`:'这个收款方',whoEn=ai?`"${ai}"`:'this payee';/* t1212 decision 97: say what ONE Face ID does */
      const zh=`⚠️ 新收款方 ${sh}，付 ${usd(i.single)} USDC（用途：${note??pn}）。认识这个收款方吗？超过了 AI 自动付款上限，AI 可能被骗，确认是你要付的人再批准。「认识并信任」：一次 Face ID 就信任${who}并付这笔 ${usd(i.single)} USDC；「只付这一次」：只付这笔，不加入信任`+(ai?`。AI 说它是“${ai}”，未核实`:'')+(swap.length?`。注意：你以前批准的「${ai}」不是这个地址，可能是冒充`:'');
      const en=`⚠️ NEW payee ${sh}, ${usd(i.single)} USDC (for: ${note??pe}). Do you know this payee? It is above the AI auto-pay limit and the AI could be tricked: approve only if you mean to pay them. "Trust this payee": ONE Face ID trusts ${whoEn} and pays this ${usd(i.single)} USDC; "Pay just this once": pays only this one, no trust`+(ai?`. The AI calls it "${ai}" (not verified)`:'')+(swap.length?`. Warning: the "${ai}" you approved before has a DIFFERENT address, this may be an impostor`:'');
      return {zh,en,newPayee:true,payeeSwap:swap.length>0,ask:true};}
    if(i.kind==='one_off'){const pa=i.payees?.[0];const rr=pa?remembered().find(x=>x.address===lc(pa)):null;const known=rr?(rr.name??short(pa)):null;/* only owner-approved names, never AI labels */const sh=pa?short(pa):(i.hosts?.[0]??'');const ai=i.oneOff?.aiName;
      const swap=ai&&pa?rememberedByName(ai).filter(x=>x!==lc(pa)):[];
      const zh=known?`付 ${usd(i.single)} USDC 给「${known}」${sh}（${pn}）`:`⚠️ 新收款方 ${sh}，付 ${usd(i.single)} USDC（${pn}）。AI 可能被骗，确认是你要付的人再批准`+(ai?`。AI 说它是“${ai}”，未核实`:'')+(swap.length?`。注意：你以前批准的「${ai}」不是这个地址，可能是冒充`:'')+(i.oneOff?.remember!==false?'。批准后记住这个收款方':'');
      const en=known?`Pay ${usd(i.single)} USDC to "${known}" ${sh} (${pe})`:`⚠️ NEW payee ${sh}, ${usd(i.single)} USDC (${pe}). The AI could be tricked: approve only if you mean to pay them`+(ai?`. The AI calls it "${ai}" (not verified)`:'')+(swap.length?`. Warning: the "${ai}" you approved before has a DIFFERENT address, this may be an impostor`:'')+(i.oneOff?.remember!==false?'. Approving remembers this payee':'');
      return {zh,en,newPayee:!known,payeeSwap:swap.length>0};}
    if(i.purpose===OVERALL)return {zh:`AI 付款上限：每笔最多 ${usd(i.single)}，每天 ${usd(i.daily)}，总额 ${usd(i.monthly)} USDC`,en:`AI payment limit: up to ${usd(i.single)} per payment, ${usd(i.daily)} a day, ${usd(i.monthly)} total (USDC)`};
    return {zh:`${pn}：每笔最多 ${usd(i.single)}，每天 ${usd(i.daily)}，每月 ${usd(i.monthly)} USDC${who?'，只限 '+who:''}${i.hosts?.length?'，只限 '+i.hosts.join('、'):''}`,en:`${pe}: up to ${usd(i.single)} per payment, ${usd(i.daily)} a day, ${usd(i.monthly)} a month USDC${i.hosts?.length?', only '+i.hosts.join(', '):''}`};}
  /* t1210 decision 95: push a still-pending, unexpired request to the phone again. Never approves, never creates anything; gate shared by repeat + remind. */
  const REPUSH_GAP=300e3;
  function repush(r,{force=false}={}){if(!r||r.state!=='pending')return {pushed:false,error:'not_pending'};
    if(now()-r.created_at>proposalTtl(JSON.parse(r.items_json)))return {pushed:false,error:'expired'};
    const last=db.prepare(`SELECT at FROM mandate_repush WHERE id=?`).get(r.id)?.at;
    if(!force&&last!=null&&now()-last<REPUSH_GAP)return {pushed:false,error:'too_soon',retryAfterSec:Math.ceil((REPUSH_GAP-(now()-last))/1000)};
    db.prepare(`INSERT INTO mandate_repush(id,at) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at`).run(r.id,now());
    try{onProposal({...view(r),repush:true});}catch{}return {pushed:true};}
  /** AI asks the server to push its own pending request again (same AI only). */
  function remind(pid,by,{force=false}={}){const r=db.prepare(`SELECT * FROM mandate_proposal WHERE id=?`).get(String(pid));if(!r||r.by!==String(by))return {ok:false,error:'not_found'};
    const p=repush(r,{force});return p.pushed?{ok:true,proposal:view(r)}:{ok:false,error:p.error,...(p.retryAfterSec?{retryAfterSec:p.retryAfterSec}:{}),...(p.error==='not_pending'?{state:r.state}:{})};}
  const getProposal=pid=>view(db.prepare(`SELECT * FROM mandate_proposal WHERE id=?`).get(String(pid)));
  const proposals=(all=false)=>db.prepare(all?`SELECT * FROM mandate_proposal ORDER BY created_at DESC LIMIT 50`:`SELECT * FROM mandate_proposal WHERE state='pending' AND created_at>? ORDER BY created_at DESC`).all(...(all?[]:[now()-7*86400e3])).filter(r=>all||now()-r.created_at<=proposalTtl(JSON.parse(r.items_json))).map(view);
  /** verify(digest) -> bool (phone signer P-256 over the digest). */
  /** t1264: `also` (optional) runs inside the same transaction as an ask approval (the owner-ask claim): false -> nothing is approved. */
  function approve(pid,verify,{mode,also}={}){const r=db.prepare(`SELECT * FROM mandate_proposal WHERE id=?`).get(String(pid));if(!r)return {ok:false,error:'unknown_proposal'};if(r.state!=='pending')return {ok:false,error:'not_pending',state:r.state};
    const items=JSON.parse(r.items_json);
    if(now()-r.created_at>proposalTtl(items)){db.prepare(`UPDATE mandate_proposal SET state='expired' WHERE id=?`).run(r.id);return {ok:false,error:'expired'};}
    const ask=isAskItems(items);if(ask&&!askModesFor(items).includes(mode))return {ok:false,error:'mode_required',modes:askModesFor(items)};if(!ask&&mode!==undefined&&mode!==null)return {ok:false,error:'mode_not_allowed'};
    if(!verify(ask?askDigest(wallet,{id:r.id,items,scope:SC},mode):proposalDigest(wallet,{id:r.id,items,scope:SC})))return {ok:false,error:'not_owner'};
    if(ask){/* t1170: the server pays this exact request itself (no reusable one_off allowance).
      t1264: 'trust' no longer remembers the payee here (that was BEFORE any payment); the approval flow remembers it only after the payment
      succeeded AND the trust took effect (rememberAfterTrust). The proposal + the ask claim (`also`) commit together or not at all. */const i=items[0];const t=now();
      db.exec('BEGIN');try{const x=db.prepare(`UPDATE mandate_proposal SET state='approved',decided_at=? WHERE id=? AND state='pending'`).run(t,r.id);if(x.changes!==1){db.exec('ROLLBACK');return {ok:false,error:'not_pending'};}
        if(typeof also==='function'&&also()!==true){db.exec('ROLLBACK');return {ok:false,error:'not_pending',state:'already_handled'};}
        db.exec('COMMIT');}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}
      return {ok:true,state:'approved',mode,made:[],ask:{payee:i.oneOff.payee,amount:i.single,name:nameOf(i.oneOff.payee)??i.oneOff.aiName??null,purpose:i.purpose}};}
    const made=[];const t=now();
    db.exec('BEGIN');try{for(const i of items){
      if(i.kind==='agent_limits'){db.prepare(`INSERT INTO agent_cap(agent_id,daily,monthly,stopped,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET daily=excluded.daily,monthly=excluded.monthly,stopped=CASE WHEN ? THEN 0 ELSE agent_cap.stopped END,updated_at=excluded.updated_at`).run(i.agentId,i.daily,i.monthly,0,t,i.resume?1:0);
        db.prepare(`INSERT INTO agent_cap_single VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET single=excluded.single`).run(i.agentId,i.single??null);scopeAgent(i.agentId);made.push({agentId:i.agentId});continue;}
      if(i.replaces)db.prepare(`UPDATE mandate SET state='replaced' WHERE id=? AND state='active'`).run(i.replaces);
      // ONE LIMIT: a new owner-approved overall limit (no scope) replaces the old one
      if(i.kind==='allowance'&&!i.payees.length&&!i.hosts.length&&!i.agents.length)for(const m of active())if(m.kind==='allowance'&&m.purpose===i.purpose&&!m.payees.length&&!m.hosts.length&&!m.agents.length)db.prepare(`UPDATE mandate SET state='replaced' WHERE id=?`).run(m.id);
      if(i.kind==='one_off'&&i.oneOff?.payee&&i.oneOff.remember!==false)db.prepare(`INSERT INTO owner_payee VALUES(?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET host=COALESCE(excluded.host,owner_payee.host),approved_at=excluded.approved_at,proposal_id=excluded.proposal_id`).run(lc(i.oneOff.payee),nameOf(i.oneOff.payee)??i.oneOff.aiName??null,i.oneOff.host??i.hosts?.[0]??null,i.purpose,t,r.id);
      if(i.kind==='recurring'&&i.recurring?.payee)db.prepare(`INSERT OR IGNORE INTO owner_payee VALUES(?,?,?,?,?,?)`).run(lc(i.recurring.payee),i.recurring.name??null,null,i.purpose,t,r.id);
      for(const pa of (i.kind==='allowance'?i.payees:[]))db.prepare(`INSERT OR IGNORE INTO owner_payee VALUES(?,?,?,?,?,?)`).run(lc(pa),nameOf(pa),null,i.purpose,t,r.id);
      const mid=id('mnd');const {kind,purpose,expiresInDays,replaces,...j}=i;db.prepare(`INSERT INTO mandate VALUES(?,?,?,?,?,?,?,?,?,0)`).run(mid,t,t,t+Math.round(expiresInDays*86400e3),'active',kind,purpose,JSON.stringify(SC?{...j,chainId:SC.chainId,token:SC.token}:j),r.id);made.push({mandateId:mid,kind,purpose});}
      db.prepare(`UPDATE mandate_proposal SET state='approved',decided_at=? WHERE id=?`).run(t,r.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    return {ok:true,state:'approved',made};}
  const reject=pid=>{const x=db.prepare(`UPDATE mandate_proposal SET state='rejected',decided_at=? WHERE id=? AND state='pending'`).run(now(),String(pid));return {ok:x.changes>0};};
  /** t1259 (decision 129): the card's payment request can no longer be paid -> the card leaves the home screen (nothing was approved or paid) */
  const expire=pid=>{const x=db.prepare(`UPDATE mandate_proposal SET state='expired',decided_at=? WHERE id=? AND state='pending'`).run(now(),String(pid));return {ok:x.changes>0};};
  const revoke=mid=>{const x=db.prepare(`UPDATE mandate SET state='revoked' WHERE id=? AND state='active'`).run(String(mid));return {ok:x.changes>0};};
  const list=()=>active().filter(m=>m.kind!=='one_off'||m.uses<1).map(m=>({...m,payeeNames:m.payees.map(a=>nameOf(a)),usage:usage(m),human:human({...m,expiresInDays:0})}));
  return {OVERALL,CATEGORIES,classifyCategory,overall:()=>{const o=overallList()[0]??null;return o?{...o,total:o.monthly,usage:usage(o)}:null;},remember,remembered,isRemembered,rememberedByName,forget,match,used,consume,release,agentCheck,agentStop,agents,propose,getProposal,remind,proposals,approve,reject,expire,revoke,list,usage,human,BEGINNER_DEFAULTS,PURPOSES};}
