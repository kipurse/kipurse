// SPDX-License-Identifier: AGPL-3.0-only
// PUBLIC trust-approval page (mainnet): /approve/trust?id=<request id>. No cookie, no login: the page is only a viewer until the
// OWNER signs with his own Base Account. Approve = he signs the trustBySig wallet message; the server checks that signature against
// the owner address (ERC-1271/6492 on chain) BEFORE relaying, so a forged or wrong signature never reaches the chain (or costs gas).
// Reject = he signs a short reject message (also verified). Agents can still only REQUEST; nothing here can be done by an agent key.
import {buildReceipt} from './receipt.mjs';
import {langOf} from './i18n.mjs';import {randomBytes,createHash} from 'node:crypto';import {getAddress} from 'viem';import {phoneTrustWrapper,p256VerifyDigest} from './phone-signer.mjs';
const J=x=>JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=a=>{try{const n=BigInt(a);return (Number(n)/1e6).toString();}catch{return '?';}};
export const rejectMessage=(id,payee)=>`Kipurse: I reject trust request ${id} for payee ${payee}. Nothing is trusted.`;
export const phoneRejectDigest=(id,payee)=>'0x'+createHash('sha256').update(rejectMessage(id,payee)).digest('hex');
/** phone: {active:()=>({index,x,y,maxSingle,maxDaily})|null, verifyWrapped:(digest,wrapper)=>Promise<bool> (wallet ERC-1271 on chain), adapter, chainId} */
export function createPublicTrustApproval({owner,wallet,ownerApi,verifyTypedData,verifyMessage,script,base,phone=null,addressCheck=null,feePpm=null}){
  const OWNER=getAddress(owner),WALLET=getAddress(wallet);const prepared=new Map();const busy=new Set();const hits=new Map();
  const limited=(ip,max=30)=>{const n=Date.now(),h=hits.get(ip)??[0,n];if(n-h[1]>60000){h[0]=0;h[1]=n;}h[0]++;hits.set(ip,h);return h[0]>max;};
  const find=id=>{const l=ownerApi.list();return [...l.pending,...l.recent].find(r=>r.id===id)??null;};
  const url=id=>`${base()}/approve/trust?id=${id}`;
  function pageHtml(r,nonce,en){const X=(zh,e)=>en?e:zh;const head=`<div class=mk>K</div>`;
    if(!r)return `${head}<div class=t>${X('找不到这个请求','Request not found')}</div><p class=s>${X('链接不对，或者请求已被删除。','The link is wrong or the request is gone.')}</p>`;
    const st={trusted:X('✅ 已信任（已上链）','✅ Trusted (on chain)'),rejected:X('已拒绝','Rejected'),expired:X('已过期，请让 AI 重新申请','Expired — ask your AI to request again')}[r.status];
    const rows=[[X('收款地址','Payee address'),`<span class=mono>${esc(r.payee)}</span>`],[X('网络','Network'),'Base'],[X('每笔最多','Max per payment'),esc(usd(r.single))+' USDC'],[X('每天最多','Max per day'),esc(usd(r.total))+' USDC'],[X('有效期','Valid for'),esc(r.expiresInDays)+X(' 天',' days')],[X('申请的 AI','Requested by'),esc((r.requestedBy??[r.agentId]).join(', '))]];
    const self=r.payee.toLowerCase()===OWNER.toLowerCase()?`<p class=ok>${X('这是你自己的 Base Account 地址。','This is your own Base Account address.')}</p>`:'';
    return `${head}<div class=t>${X('AI 请求信任一个收款方','Your AI asks to trust a payee')}</div>
<div class=c>${rows.map(([k,v])=>`<div class=row><span>${k}</span><span class=n>${v}</span></div>`).join('')}</div>${self}
<div class=c><b>${X('AI 写的说明（未核实）','What the AI wrote (not verified)')}</b><p>${esc(r.merchantName)} — ${esc(r.reason)}</p></div>
${st?`<p class=t2>${st}</p>${r.txHash?`<p class=mono>tx ${esc(r.txHash)}</p>`:''}`:`<div class=warn>${X('请逐字核对收款地址。批准后，AI 可以在上面的上限内向这个地址付款。','Check the payee address character by character. Once approved, your AI can pay this address within the limits above.')}</div>
${phone?.active?.()?`<a class=btn href="kipurse://approve-trust?id=${esc(r.id)}" id=app style="display:block;text-align:center;text-decoration:none;background:#111;color:#fff;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px">${X('在 Kipurse App 用 Face ID 批准','Approve in the Kipurse app (Face ID)')}</a>`:''}<button class=p id=ok>${X('批准并用 Base Account 确认（Face ID）','Approve & sign with Base Account (Face ID)')}</button><button class=g id=no>${X('拒绝（也需要确认）','Reject (also signed)')}</button>
<p class=muted id=st>${X('只有钱包主人的 Base Account 确认有效。信任上链的手续费约 0.01 USDC 以内，从你的金库扣。','Only the wallet owner’s Base Account signature works. The on-chain fee (under ~0.01 USDC) is paid from your vault.')}</p>
<script type="application/json" id=kp-data>${J({id:r.id,owner:OWNER,payee:r.payee,en,reject:rejectMessage(r.id,r.payee)}).replace(/</g,'\\u003c')}</script><script nonce="${nonce}" src="/approve/trust.js"></script>`}`;}
  const shell=(title,inner,en)=>`<!doctype html><html lang=${en?'en':'zh'}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--a:#5B4CF0;--bg:#F2F2F7;--card:#fff;--t:#111;--s:#6b6b78;color-scheme:light dark}@media(prefers-color-scheme:dark){:root{--a:#8B7CFF;--bg:#000;--card:#1c1c1e;--t:#f5f5f7;--s:#9a9aa5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:17px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.w{max-width:460px;margin:0 auto;padding:24px 20px 40px}
.mk{width:56px;height:56px;border-radius:15px;background:var(--a);color:#fff;display:grid;place-items:center;font:700 30px ui-rounded,-apple-system}.t{font-size:24px;font-weight:700;margin:14px 0 6px}.t2{font-size:20px;font-weight:700}.s{color:var(--s)}
.c{background:var(--card);border-radius:18px;padding:14px 16px;margin:12px 0}.row{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid rgba(128,128,128,.2)}.row:last-child{border:0}
.n{font-weight:600;text-align:right}.mono{font-family:ui-monospace,monospace;font-size:13px;word-break:break-all}.warn{background:rgba(220,38,38,.1);color:#c81e1e;border-radius:14px;padding:12px 14px;font-weight:600}.ok{color:#080;font-weight:700}
button{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px;cursor:pointer}.p{background:var(--a);color:#fff}.g{background:rgba(91,76,240,.12);color:var(--a)}.muted{color:var(--s);font-size:14px}</style>
<div style="background:#c00;color:#fff;text-align:center;font-weight:700;padding:8px">${en?'Base Mainnet':'Base 主网'}</div><div class=w>${inner}</div></html>`;
  async function handle(req,res,u,{readBody,ip}){const p=u.pathname;if(p!=='/approve/trust'&&!p.startsWith('/approve/trust/')&&p!=='/approve/trust.js')return false;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(J(o));};
    if(limited(ip)){json(429,{error:'slow_down'});return true;}
    if(p==='/approve/trust.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(script());return true;}
    if(p==='/approve/trust'&&req.method==='GET'){const id=String(u.searchParams.get('id')??'');const r=/^[0-9a-f-]{36}$/.test(id)?find(id):null;const nonce=randomBytes(12).toString('base64url');
      const en=langOf(req,u)!=='zh';
      res.writeHead(r?200:404,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
        'content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; img-src data:; form-action 'none'; frame-ancestors 'none'`});
      res.end(shell(en?'Approve payee':'批准收款方',pageHtml(r,nonce,en),en));return true;}
    if(req.method!=='POST'){json(405,{error:'method'});return true;}
    const b=await readBody(req);const id=String(b.id??'');const r=/^[0-9a-f-]{36}$/.test(id)?find(id):null;
    if(!r){json(404,{error:'unknown_trust_request'});return true;}
    if(!['awaiting_owner','awaiting_signature'].includes(r.status)){json(409,{error:'not_pending',status:r.status,txHash:r.txHash??null});return true;}
    if(busy.has(id)){json(409,{error:'in_progress'});return true;}busy.add(id);
    try{
      if(p==='/approve/trust/prepare'){const c=prepared.get(id);if(c&&r.status==='awaiting_signature'&&Date.now()-c.at<600000){json(200,{typedData:c.td});return true;}// stable: a second visitor can't rotate what the owner signs
        const out=await ownerApi.approve(id);prepared.set(id,{td:out.typedData,inner:out.innerTypedData,digest:out.digest,at:Date.now()});json(200,{typedData:out.typedData});return true;}
      if(p==='/approve/trust/phone-prepare'){const a=phone?.active?.();if(!a){json(409,{error:'no_phone_signer'});return true;}
        let c=prepared.get(id);if(!(c&&c.inner&&r.status==='awaiting_signature'&&Date.now()-c.at<600000)){const out=await ownerApi.approve(id);c={td:out.typedData,inner:out.innerTypedData,digest:out.digest,at:Date.now()};prepared.set(id,c);}
        if(!c.inner){json(409,{error:'not_supported'});return true;}
        const feePreview=await (async()=>{try{const ppm=await feePpm?.();return ppm==null||r.single==null?null:{...buildReceipt({amount:BigInt(r.single),ppm,networkFee:0n,payee:r.payee}),networkFeeAtPayment:true};}catch{return null;}})();
        json(200,{feePreview,request:{id:r.id,payee:r.payee,merchantName:r.merchantName,reason:r.reason,requestedBy:r.requestedBy,single:r.single,total:r.total},message:c.inner.message,domain:c.inner.domain,digest:c.digest,
          wallet:WALLET,chainId:c.inner.domain?.chainId,phone:{index:a.index,maxSingle:a.maxSingle,maxDaily:a.maxDaily},addressCheck:await (async()=>{try{const v=await addressCheck?.(r.payee);return v?.ok?{status:v.status,verified:v.verified,groups:v.groups,lookalikes:v.lookalikes??[],inbound:v.inbound}:null;}catch{return null;}})()});return true;}
      if(p==='/approve/trust/phone-sign'){const a=phone?.active?.();const c=prepared.get(id);if(!a){json(409,{error:'no_phone_signer'});return true;}if(!c?.inner){json(409,{error:'prepare_first'});return true;}
        if(BigInt(c.inner.message.single)>BigInt(a.maxSingle)||BigInt(c.inner.message.daily)>BigInt(a.maxDaily)){json(403,{error:'above_phone_ceiling',detail:'这次的上限超过手机确认允许的范围，请用 Base Account 批准'});return true;}
        let w;try{w=phoneTrustWrapper(a.index,c.inner.message,b.r,b.s);}catch{json(400,{error:'bad_signature'});return true;}
        let ok=false;try{ok=await phone.verifyWrapped(c.digest,w);}catch{ok=false;}
        if(!ok){json(403,{error:'not_owner',detail:'phone signature not accepted by the wallet on chain'});return true;}
        const v=await ownerApi.submitSignature(id,w,{prewrapped:true});prepared.delete(id);json(200,{status:v.status,txHash:v.txHash});return true;}
      if(p==='/approve/trust/phone-reject'){const a=phone?.active?.();if(!a){json(409,{error:'no_phone_signer'});return true;}
        if(!p256VerifyDigest(a,phoneRejectDigest(id,r.payee),b.r,b.s)){json(403,{error:'not_owner'});return true;}const v=ownerApi.reject(id);prepared.delete(id);json(200,{status:v.status});return true;}
      if(p==='/approve/trust/sign'){const td=prepared.get(id)?.td;if(!td){json(409,{error:'prepare_first'});return true;}const sig=String(b.signature??'');
        let ok=false;try{ok=await verifyTypedData({address:OWNER,...td,signature:sig});}catch{ok=false;}
        if(!ok){json(403,{error:'not_owner',detail:'signature is not from the wallet owner’s Base Account'});return true;}
        const v=await ownerApi.submitSignature(id,sig);prepared.delete(id);json(200,{status:v.status,txHash:v.txHash});return true;}
      if(p==='/approve/trust/reject'){let ok=false;try{ok=await verifyMessage({address:OWNER,message:rejectMessage(id,r.payee),signature:String(b.signature??'')});}catch{ok=false;}
        if(!ok){json(403,{error:'not_owner'});return true;}const v=ownerApi.reject(id);prepared.delete(id);json(200,{status:v.status});return true;}
      json(404,{error:'not_found'});return true;
    }catch(e){json(400,{error:e.code??'failed',detail:String(e.message).slice(0,300)});return true;}finally{busy.delete(id);}}
  return {handle,url};}
