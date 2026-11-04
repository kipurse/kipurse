// SPDX-License-Identifier: AGPL-3.0-only
// OWNER-ONLY approval surface (one tap; NOT a wallet signature; NOT reachable with agent tokens). Separate port on 127.0.0.1.
// Login: a one-time code written to a 0600 file for the owner (never logged); it becomes an HttpOnly SameSite=Strict session cookie.
// Every action is a plain HTML form POST with a per-session CSRF token and an Origin check; the server computes the owner HMAC
// with the owner secret (which agents never see) and calls the guarded approve/revoke functions.
import http from 'node:http';import fs from 'node:fs';import {randomBytes,timingSafeEqual} from 'node:crypto';
import {ownerMac,approvalMessage,revokeMessage} from './joint-trust.mjs';import {changeMessage,withdrawalMessage,releaseMessage} from './owner-guard.mjs';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const usd=a=>(Number(BigInt(a??0))/1e6).toString()+' USDC';
const same=(a,b)=>{const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));return x.length===y.length&&timingSafeEqual(x,y);};
export function createOwnerSurface({ownerSecret,jointTrust,ownerGuard,engine,loginFile,port=8670,host='127.0.0.1'}){
  let login=randomBytes(24).toString('hex');const sessions=new Map();
  if(loginFile)fs.writeFileSync(loginFile,`http://localhost:${port}/login?code=${login}\n`,{mode:0o600});
  const cookie=req=>Object.fromEntries(String(req.headers.cookie??'').split(';').map(x=>x.trim().split('=')).filter(x=>x.length===2));
  const sess=req=>{const id=cookie(req).kp_owner;return id&&sessions.get(id);};
  const page=(s,msg='')=>{const t=jointTrust?.list()??{trusted:[],pending:[]},g=ownerGuard?.pending()??{changes:[],withdrawals:[]},q=(ownerGuard?.deposits()??[]).filter(d=>BigInt(d.quarantined??0)>0n);
    const f=(kind,id,label)=>`<form method="post" action="/act"><input type="hidden" name="csrf" value="${s.csrf}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="id" value="${esc(id)}"><button>${esc(label)}</button></form>`;
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Kipurse owner approvals</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'">
<style>body{font:15px system-ui;max-width:760px;margin:1em auto;padding:0 1em}section{border:1px solid #ccc;border-radius:8px;padding:.6em;margin:.8em 0}button{padding:.5em 1em;margin:.2em}</style>
<h2>Kipurse · 主人审批（仅你本人）</h2><p>${esc(msg)}</p><p>这里的批准不是钱包确认，只控制网关规则；链上上限不会被这里改变。</p>
<section><h3>待批准的信任申请</h3>${t.pending.map(p=>`<p><b>${esc(p.subject.kind)}: ${esc(p.subject.id)}</b> · ${usd(p.single)}/笔，${usd(p.daily)}/天 · 理由：${esc(p.reason)} · 申请方：${esc(p.agentId)}</p>${f('trust_approve',p.id,'批准')}${f('trust_reject',p.id,'拒绝')}`).join('')||'无'}</section>
<section><h3>已信任</h3>${t.trusted.map(x=>`<p>${esc(x.key)} · ${usd(x.single)}/笔，${usd(x.daily)}/天</p>${f('trust_revoke',x.key,'撤销信任')}`).join('')||'无'}</section>
<section><h3>放宽限额申请</h3>${g.changes.map(c=>`<p>${esc(JSON.stringify(c.to))}${c.withdrawalAddress?' · 新提现地址 '+esc(c.withdrawalAddress):''}</p>${f('limits_approve',c.id,'批准放宽')}`).join('')||'无'}</section>
<section><h3>提现申请</h3>${g.withdrawals.map(w=>`<p>${usd(w.amount)} → ${esc(w.to)}（${esc(w.state)}；0.1% + gas，计入链上上限）</p>${w.state==='pending'?f('withdrawal_approve',w.id,'批准提现'):''}`).join('')||'无'}</section>
<section><h3>隔离中的充值</h3>${q.map(d=>`<p>${usd(d.quarantined)} 来自 ${esc(d.from)} · tx ${esc(d.txHash)}</p>${f('quarantine_release',d.id,'放行到可用余额')}`).join('')||'无'}</section>
<section><h3>紧急退出</h3><p>任何时候都可以在你的 Base Account 里直接撤销授权或把钱转走（只付 gas，不受上限限制），不需要本页面。</p></section>`;};
  const body=async req=>{let b='';for await(const c of req){b+=c;if(b.length>4096)throw Error('too big');}return Object.fromEntries(new URLSearchParams(b));};
  const act=async(kind,id)=>{const m=x=>ownerMac(ownerSecret,x);
    if(kind==='trust_approve'){const p=jointTrust.list().pending.find(x=>x.id===id);if(!p)throw Error('not found');jointTrust.approve(id,m(approvalMessage(p)));return '已批准信任';}
    if(kind==='trust_reject'){jointTrust.reject(id,m('kipurse-trust-reject|'+id));return '已拒绝';}
    if(kind==='trust_revoke'){const n=randomBytes(8).toString('hex');jointTrust.revoke(id,n,m(revokeMessage(id,n)));return '已撤销信任（立即生效）';}
    if(kind==='limits_approve'){const c=ownerGuard.pending().changes.find(x=>x.id===id);if(!c)throw Error('not found');ownerGuard.approveChange(id,m(changeMessage(c)));return '已放宽（不超过链上上限）';}
    if(kind==='withdrawal_approve'){const w=ownerGuard.pending().withdrawals.find(x=>x.id===id);if(!w)throw Error('not found');ownerGuard.approveWithdrawal(id,m(withdrawalMessage(w)));
      const r=engine?await engine.executeWithdrawal({withdrawalId:id,agentId:'owner'}):null;return '已批准提现'+(r?`：${r.state}${r.txHash?' '+r.txHash:''}${r.reason?' '+r.reason:''}`:'');}
    if(kind==='quarantine_release'){ownerGuard.releaseQuarantine(id,m(releaseMessage(id)));return '已放行';}
    throw Error('unknown action');};
  const server=http.createServer(async(req,res)=>{const send=(c,h,b)=>{res.writeHead(c,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer',...h});res.end(b);};
    try{const u=new URL(req.url,`http://${host}:${port}`);
      if(req.method==='GET'&&u.pathname==='/login'){if(!login||!same(u.searchParams.get('code'),login))return send(403,{},'登录码无效或已用过');login=null; // one-time
        const id=randomBytes(24).toString('hex');sessions.set(id,{csrf:randomBytes(16).toString('hex'),created:Date.now()});return send(303,{'set-cookie':`kp_owner=${id}; HttpOnly; SameSite=Strict; Path=/`,location:'/'},'');}
      const s=sess(req);if(!s)return send(401,{},'仅限主人：请用登录文件里的一次性链接登录');
      if(req.method==='GET'&&u.pathname==='/')return send(200,{},page(s));
      if(req.method==='POST'&&u.pathname==='/act'){const o=req.headers.origin;if(o&&o!==`http://localhost:${port}`&&o!==`http://127.0.0.1:${port}`)return send(403,{},'bad origin');
        const b=await body(req);if(!same(b.csrf,s.csrf))return send(403,{},'bad csrf');let msg;try{msg=await act(b.kind,b.id);}catch(e){msg='失败：'+e.message;}return send(200,{},page(s,msg));}
      return send(404,{},'not found');}catch(e){send(500,{},'error');}});
  return {server,listen:()=>new Promise(r=>server.listen(port,host,()=>r(server))),close:()=>server.close(),_newLoginForTests:()=>{login=randomBytes(24).toString('hex');return login;}};}
