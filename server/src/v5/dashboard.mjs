// SPDX-License-Identifier: AGPL-3.0-only
// Owner dashboard (read-only, static HTML). No signing, no wallet connection, no secrets: it renders the JSON of
// scripts/v5-mainnet-status.mjs (+ optional January dry-run report) and tells the owner how to exit.
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const usdc=a=>a==null?'–':(Number(BigInt(a))/1e6).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6})+' USDC';
export function dashboardModel(st,dry=null){
  const pm=st.permission??{},bt=st.exampleshopTrust??{},og=st.outgoing??{};const alerts=[];
  if(!pm.valid)alerts.push('V5 permission is NOT valid — agents cannot spend.');else if(pm.daysLeft<35)alerts.push(`Permission ends in ${pm.daysLeft} days — run the January renewal dry run.`);
  if(st.paused)alerts.push('Wallet is PAUSED on the trust registry.');if(!bt.active)alerts.push('ExampleShop trust is not active.');
  if(og.scan&&!og.scan.ok)alerts.push('Outgoing-transfer scan incomplete: '+og.scan.error);if(og.unexpected>0)alerts.push(`${og.unexpected} UNEXPECTED outgoing transfer(s) — review now; use Exit if not yours.`);
  if(st.pimlico?.error||st.pimlico?.gasPriceOk===false)alerts.push('Pimlico bundler unreachable — payments would fail (funds are safe).');
  if(st.circlePaymaster?.error||!st.circlePaymaster?.codeBytes)alerts.push('Circle paymaster not reachable.');
  return {checkedAt:st.checkedAt,alerts,
    balances:Object.entries(st.balances??{}).map(([k,v])=>[k,usdc(v)]),
    caps:[['term spent / total',`${usdc(pm.termSpent)} / ${usdc(pm.term)}`],['spent today',usdc(pm.todaySpent)],['stranger spend today',usdc(pm.strangerToday)],
      ['permission',`${pm.valid?'valid':'INVALID'} · ${esc(pm.start)} → ${esc(pm.end)} (${pm.daysLeft} days left)`],
      ['ExampleShop trust',`${bt.active?'active':'INACTIVE'} · ${usdc(bt.single)}/payment, ${usdc(bt.daily)}/day · until ${esc(bt.expiry)}`]],
    outgoing:(og.transfers??[]).map(x=>[x.time,x.from,x.to,usdc(x.value),x.expected,x.tx]),
    renewal:dry?{validation:dry.validation,prerequisites:dry.prerequisites,steps:dry.steps,earliest:dry.live?.earliestRenewal}:null};
}
export function renderDashboard(st,dry=null){const m=dashboardModel(st,dry);const tr=r=>'<tr>'+r.map(c=>`<td>${esc(c)}</td>`).join('')+'</tr>';
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kipurse owner dashboard</title>
<style>body{font:15px system-ui;max-width:900px;margin:2em auto;padding:0 1em}td{padding:.25em .6em;border-bottom:1px solid #ddd;word-break:break-all}.a{background:#fee;padding:.6em;border-left:4px solid #c00}.ok{background:#efe;padding:.6em}.x{border:2px solid #c00;padding:1em}</style>
<h1>Kipurse wallet — owner view</h1><p>Read-only snapshot · checked ${esc(m.checkedAt)}. This page cannot sign or move funds.</p>
${m.alerts.length?m.alerts.map(a=>`<p class="a">⚠ ${esc(a)}</p>`).join(''):'<p class="ok">✓ No alerts.</p>'}
<h2>Balances</h2><table>${m.balances.map(tr).join('')}</table><h2>Caps &amp; permission</h2><table>${m.caps.map(r=>`<tr><td>${esc(r[0])}</td><td>${r[1]}</td></tr>`).join('')}</table>
<h2>Outgoing USDC since ${esc(st.outgoing?.since)}</h2><table>${m.outgoing.length?m.outgoing.map(tr).join(''):'<tr><td>none</td></tr>'}</table>
${m.renewal?`<h2>January renewal (dry run)</h2><p>Earliest renewal: ${esc(m.renewal.earliest)} · plan ${m.renewal.validation?.ok?'valid':'INVALID: '+esc((m.renewal.validation?.errors??[]).join('; '))}</p>
<ol>${(m.renewal.steps??[]).map(s=>`<li>${esc(s.replace(/^\d+\.\s*/,''))}</li>`).join('')}</ol>${(m.renewal.prerequisites??[]).length?'<p>Before signing: '+m.renewal.prerequisites.map(esc).join('; ')+'</p>':''}`:''}
${ownerRulesHtml(st.ownerRules,tr)}
<div class="x"><h2>Exit button — how to stop everything</h2><ol>
<li>Open your owner Base Account (the same passkey you used to approve Kipurse). Only you can do this; no agent, ExampleShop or Kipurse operator can.</li>
<li>Use the Kipurse owner page's <b>Exit</b> action (or revoke the spend permission for spender ${esc(st.permission?.spender??'the Kipurse adapter')} in your wallet's spend-permission settings).</li>
<li>One signature: pause → revoke permission → sweep the vault gas buffer back to you. Afterwards no agent can spend; your USDC stays in your wallet.</li>
<li>If you see an unexpected transfer above, exit first and investigate after. Never sign on a page that someone sent you.</li></ol></div>`;}

// Gateway-enforced owner rules (read-only): limits, joint trust list, deposits / quarantine, pending owner approvals.
export function ownerRulesSnapshot({ownerGuard:g,jointTrust:jt}={}){if(!g&&!jt)return null;
  return {limits:g?.limits()??null,trust:jt?.list()??null,auditOk:jt?jt.auditVerify():null,deposits:g?.deposits?.()??[],quarantined:g?String(g.quarantined()):'0',pending:g?.pending()??null};}
export function ownerRulesHtml(o,tr){if(!o)return '';const L=o.limits;const t=o.trust??{trusted:[],pending:[]};const p=o.pending??{changes:[],withdrawals:[]};
  return `<h2>Owner limits (gateway-enforced)</h2>${L?`<table>${[['Unrecognized payee',usdc(L.unrecognizedPerPayment)+' / payment, '+usdc(L.unrecognizedPerDay)+' / day'],['Daily deposit limit',usdc(L.depositDailyLimit)],['Withdrawal address',L.withdrawalAddress]].map(tr).join('')}</table>`:'<p class="a">⚠ Not active: the signed permission is not valid on chain yet.</p>'}
<h2>Trust list</h2><p>Audit log ${o.auditOk===false?'<b>BROKEN</b>':'intact'}.</p><table>${t.trusted.length?t.trusted.map(x=>tr([x.key,usdc(x.single)+' / '+usdc(x.daily),x.active?'active':'expired'])).join(''):'<tr><td>none</td></tr>'}</table>
${t.pending.length?'<p>Pending agent proposals (owner tap needed): '+t.pending.length+'</p>':''}
<h2>Deposits</h2><p>Quarantined (not spendable by agents): ${usdc(o.quarantined)}</p><table>${o.deposits.length?o.deposits.slice(-20).map(d=>tr([d.time?new Date(d.time*1000).toISOString():'',d.from,usdc(d.value),d.status,d.txHash])).join(''):'<tr><td>none</td></tr>'}</table>
<h2>Pending owner approvals</h2><p>${p.changes.length} limit change(s), ${p.withdrawals.length} withdrawal(s).</p>`;}
