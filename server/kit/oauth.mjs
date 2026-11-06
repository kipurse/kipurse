// SPDX-License-Identifier: AGPL-3.0-only
// MCP authorization (spec 2025-06-18): OAuth 2.1 + PKCE(S256), RFC 9728 protected-resource metadata, RFC 8414 AS metadata,
// RFC 7591 dynamic client registration, RFC 7009 revocation. Public clients only (no secrets). Owner consent is required:
// in the browser (owner cookie + CSRF) or in the iOS app (Face ID) via kipurse://oauth?req=<id>.
// Tokens/codes are stored only as SHA-256 hashes and never logged.
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';

const sha=x=>createHash('sha256').update(x).digest('hex');
const b64url=b=>Buffer.from(b).toString('base64url');
const rnd=(n=32)=>randomBytes(n).toString('base64url');
export const ACCESS_TTL=3600,REFRESH_TTL=30*86400,CODE_TTL=600,REQ_TTL=600;

/** https anywhere, or http only on loopback; no fragments, no userinfo. */
/** Exact custom-scheme callbacks of agents we list (Grok Bot registers this one next to its https + loopback callbacks). */
export const CUSTOM_REDIRECTS=new Set(['cursor://anysphere.cursor-mcp/oauth/callback']);
/** Grok Bot's DCR callbacks identify it even when its client_name is generic. */
/** Gemini Spark (Gemini app custom connected apps) registers Google's OAuth redirector as its callback. */
export const isGeminiSparkRegistration=uris=>Array.isArray(uris)&&uris.some(u=>{try{const x=new URL(u);return x.protocol==='https:'&&/^oauth-redirect(-sandbox|-test)?\.googleusercontent\.com$/.test(x.hostname);}catch{return false;}});
export const isGrokBotRegistration=uris=>Array.isArray(uris)&&uris.some(u=>u==='https://www.cursor.com/agents/mcp/oauth/callback'||CUSTOM_REDIRECTS.has(u));
/** Exact match, except loopback http callbacks match on any port (RFC 8252 §7.3; Claude Code / Codex use ephemeral ports). */
export function redirectMatches(registered,actual){if(registered===actual)return true;try{const a=new URL(registered),b=new URL(actual);
  const lo=h=>['127.0.0.1','localhost','[::1]'].includes(h);return a.protocol==='http:'&&b.protocol==='http:'&&lo(a.hostname)&&a.hostname===b.hostname&&a.pathname===b.pathname&&a.search===b.search;}catch{return false;}}
export function validRedirect(u){if(CUSTOM_REDIRECTS.has(u))return true;try{const x=new URL(u);if(x.hash||x.username||x.password)return false;
  if(x.protocol==='https:')return true;if(x.protocol==='http:')return ['127.0.0.1','localhost','[::1]'].includes(x.hostname);
  return false;}catch{return false;}}
export function pkceOk(verifier,challenge){if(!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier||''))return false;
  const a=Buffer.from(b64url(createHash('sha256').update(verifier).digest())),b=Buffer.from(String(challenge));return a.length===b.length&&timingSafeEqual(a,b);}
/** Client name -> gallery agent type. */
export function mapClient(name){const n=String(name||'').toLowerCase();
  const rules=[['grok bot','grok-bot'],['grok-bot','grok-bot'],['muse','muse'],['chatgpt','chatgpt'],['openai','chatgpt'],['claude code','claude-code'],['claude','claude-desktop'],['anthropic','claude-desktop'],['grok','grok'],['xai','grok'],['cursor','cursor'],['antigravity','antigravity'],['gemini spark','gemini-spark'],['google gemini','gemini-spark'],['gemini cli','gemini-cli'],['gemini','gemini-cli'],['codex','codex']];
  for(const [k,v] of rules)if(n.includes(k))return v;return 'custom';}

/** network 'test' (kit, Sepolia) or 'main' (Base mainnet). On main there is no app/browser owner session on the public host, so the owner
 *  approves by signing ownerMessage() with HIS Base Account (passkey / Face ID); verifyOwner checks it on chain (ERC-1271/6492). */
/** What the enrolled phone key (Secure Enclave P-256, Face ID) signs to approve / reject ONE connection request. Domain-separated text,
 *  SHA-256 (never an EIP-712 / wallet hash). Bound to wallet, request id, client id, agent name, exact redirect, expiry and the action.
 *  The app recomputes it from the fields it shows. */
export const connectText=({wallet,req,clientId,name,redirect,exp,action})=>`Kipurse approve connection v1\nwallet:${String(wallet).toLowerCase()}\nreq:${req}\nclient:${clientId}\nname:${name}\nredirect:${redirect}\nexp:${Math.floor(exp)}\naction:${action}`;
export const connectDigest=f=>'0x'+createHash('sha256').update(connectText(f)).digest('hex');
/** phoneApprover (mainnet): {active:()=>{approver,x,y,fingerprint}|null, onChain:async a=>bool (still an owner of the wallet), verify:(a,digestHex,r,s)=>bool} */
export function createOAuth({S,save,base,createAgentKey,isAgentLive,caps,spendAuthorization=null,ownerSession,network='test',verifyOwner=null,wallet=null,ownerAddress=null,consentScript=null,phoneApprover=null}){
  S.oauth??={clients:{},pending:{},codes:{},tokens:{}};let O=S.oauth;
  const RES=()=>base()+'/mcp';
  const hits=new Map();// ip -> [count, windowStart]
  function limited(ip,max=40){const n=Date.now(),h=hits.get(ip)??[0,n];if(n-h[1]>60000){h[0]=0;h[1]=n;}h[0]++;hits.set(ip,h);return h[0]>max;}
  function gc(){const n=Date.now()/1000;for(const t of ['pending','codes','tokens'])for(const [k,v] of Object.entries(O[t]))if(v.exp<n)delete O[t][k];}

  const prm=()=>({resource:RES(),authorization_servers:[base()],bearer_methods_supported:['header'],scopes_supported:['wallet'],resource_name:'Kipurse AI 钱包'});
  const asm=()=>({issuer:base(),authorization_endpoint:base()+'/oauth/authorize',token_endpoint:base()+'/oauth/token',registration_endpoint:base()+'/oauth/register',
    revocation_endpoint:base()+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
    code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:['wallet']});
  const MAIN=network==='main';
  function ownerMessage(reqId){const p=O.pending[reqId];if(!p)return null;const c=O.clients[p.client_id];let h='';try{h=new URL(p.redirect_uri).host;}catch{}
    return `Kipurse: allow "${c?.name??'AI'}" to connect to my Kipurse wallet ${wallet??''} on Base (chain 8453).\nIt may only use the permissions I already set; new payees still need my signature.\nReturns to: ${h}\nRequest: ${reqId}\nExpires: ${new Date(p.exp*1000).toISOString()}`;}
  const challenge=()=>`Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource", scope="wallet"`;

  function register(body){const uris=body.redirect_uris;
    if(!Array.isArray(uris)||!uris.length||uris.length>10||!uris.every(validRedirect))return [400,{error:'invalid_redirect_uri',error_description:'redirect_uris must be https or loopback http, no fragments'}];
    let name=String(body.client_name||'AI agent').slice(0,60);if(isGrokBotRegistration(uris)&&!/grok bot/i.test(name))name='Grok Bot';else if(isGeminiSparkRegistration(uris))name='Gemini Spark';else if(uris.some(x=>{try{const h=new URL(x).hostname;return h==='muse.ai'||h.endsWith('.muse.ai');}catch{return false;}})&&!/muse/i.test(name))name='Muse';const id='kpc_'+rnd(16);
    O.clients[id]={name,redirect_uris:uris,created:Date.now()};save();
    return [201,{client_id:id,client_id_issued_at:Math.floor(Date.now()/1000),client_name:name,redirect_uris:uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']}];}

  /** Validate an authorize request. Returns {err} (render, never redirect) or {req}. */
  const ERR_EN={'未知的客户端（client_id）':'This AI app isn’t registered with your wallet (unknown client).','回调地址不匹配（redirect_uri 必须和注册时完全一致）':'The AI app sent a return address that doesn’t match its registration.'};const errEn=e=>ERR_EN[e]??'The connection request was not valid.';
  function startAuthorize(q){const c=O.clients[q.get('client_id')||''];if(!c)return {err:'未知的客户端（client_id）'};
    const ru=q.get('redirect_uri')||(c.redirect_uris.length===1?c.redirect_uris[0]:'');if(!c.redirect_uris.some(r=>redirectMatches(r,ru)))return {err:'回调地址不匹配（redirect_uri 必须和注册时完全一致）'};
    const back=(e)=>{const u=new URL(ru);u.searchParams.set('error',e);if(q.get('state'))u.searchParams.set('state',q.get('state'));u.searchParams.set('iss',base());return {redirect:u.toString()};};
    if(q.get('response_type')!=='code')return back('unsupported_response_type');
    if(q.get('code_challenge_method')!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge')||''))return back('invalid_request');
    const r=q.get('resource');if(r&&r.replace(/\/$/,'')!==RES())return back('invalid_target');
    gc();// same request reopened after the owner approved (in-app browser didn't follow the redirect): hand back the unused code link
    for(const [pid,x] of Object.entries(O.pending))if(x.status==='approved'&&x.redirect&&x.codeHash&&O.codes[x.codeHash]&&x.client_id===q.get('client_id')&&x.redirect_uri===ru&&x.challenge===q.get('code_challenge')&&x.state===(q.get('state')??null))return {done:x.redirect,req:pid,client:c};
    for(const x of Object.values(O.pending))if(MAIN&&x.status==='approved'&&x.codeHash&&!O.codes[x.codeHash]&&x.codeExp>=Date.now()/1000&&x.client_id===q.get('client_id')&&x.redirect_uri===ru&&x.challenge===q.get('code_challenge')&&x.state===(q.get('state')??null))return {used:true,client:c};
    const id=rnd(18);O.pending[id]={client_id:q.get('client_id'),redirect_uri:ru,challenge:q.get('code_challenge'),state:q.get('state')??null,exp:Date.now()/1000+REQ_TTL,status:'pending'};save();
    return {req:id,client:c};}

  /** Owner decision (browser with CSRF, or app after Face ID). Returns the redirect URL for the agent. */
  function decide(reqId,approve){const p=O.pending[reqId];if(!p||p.exp<Date.now()/1000||p.status!=='pending')throw Error('请求已过期或已处理，请回到 AI 重新连接');
    const c=O.clients[p.client_id];const u=new URL(p.redirect_uri);if(p.state!=null)u.searchParams.set('state',p.state);u.searchParams.set('iss',base());
    if(!approve){p.status='denied';u.searchParams.set('error','access_denied');p.redirect=u.toString();save();return p.redirect;}
    assertSpend(p); // t1073: Face ID / Base Account approval does not grant spend unless the shown AI limits are still the confirmed ones
    const agentId=createAgentKey(c.name,mapClient(c.name),p.client_id);const code=rnd(32);
    O.codes[sha(code)]={client_id:p.client_id,redirect_uri:p.redirect_uri,challenge:p.challenge,agentId,exp:Date.now()/1000+CODE_TTL};
    u.searchParams.set('code',code);p.codeHash=sha(code);p.codeExp=Date.now()/1000+CODE_TTL;p.status='approved';p.redirect=u.toString();save();return p.redirect;}

  function issue(client_id,agentId){const at=rnd(32),rt=rnd(32),n=Date.now()/1000;
    O.tokens[sha(at)]={type:'access',client_id,agentId,exp:n+ACCESS_TTL};O.tokens[sha(rt)]={type:'refresh',client_id,agentId,exp:n+REFRESH_TTL};save();
    return {access_token:at,token_type:'Bearer',expires_in:ACCESS_TTL,refresh_token:rt,scope:'wallet'};}

  function token(b){const bad=(e,d)=>[400,{error:e,error_description:d}];gc();
    if(b.grant_type==='authorization_code'){const k=sha(String(b.code||''));const c=O.codes[k];delete O.codes[k];save();// single use, even on failure
      if(!c||c.exp<Date.now()/1000)return bad('invalid_grant','code expired or used');
      if(b.client_id!==c.client_id||b.redirect_uri!==c.redirect_uri)return bad('invalid_grant','client_id / redirect_uri mismatch');
      if(!pkceOk(b.code_verifier,c.challenge))return bad('invalid_grant','PKCE verification failed');
      if(!isAgentLive(c.agentId))return bad('invalid_grant','agent key revoked');
      return [200,issue(c.client_id,c.agentId)];}
    if(b.grant_type==='refresh_token'){const k=sha(String(b.refresh_token||''));const t=O.tokens[k];
      if(!t||t.type!=='refresh'||t.exp<Date.now()/1000||t.client_id!==b.client_id||!isAgentLive(t.agentId))return bad('invalid_grant','refresh token invalid');
      delete O.tokens[k];return [200,issue(t.client_id,t.agentId)];}// rotation
    return bad('unsupported_grant_type','use authorization_code or refresh_token');}

  function revoke(b){delete O.tokens[sha(String(b.token||''))];save();return [200,{}];}
  /** Access token -> agentId (live) or null. */
  function agentForAccess(tok){const t=O.tokens[sha(tok)];return t&&t.type==='access'&&t.exp>=Date.now()/1000&&isAgentLive(t.agentId)?t.agentId:null;}
  function revokeAgent(agentId){for(const [k,t] of Object.entries(O.tokens))if(t.agentId===agentId)delete O.tokens[k];for(const [k,c] of Object.entries(O.codes))if(c.agentId===agentId)delete O.codes[k];save();}
  function pendingList(){gc();return Object.entries(O.pending).filter(([,p])=>p.status==='pending').map(([id,p])=>({id,client:O.clients[p.client_id]?.name??'AI',kind:mapClient(O.clients[p.client_id]?.name),exp:Math.floor(p.exp),host:(()=>{try{return new URL(p.redirect_uri).host;}catch{return '';}})()}));}

  // ---- t1073 spend authorization (independent of the page and of any client-sent amounts) ----
  const canon=s=>{const t=String(s??'').trim();if(!/^\d+(\.\d{1,6})?$/.test(t))return null;const [a,b='']=t.split('.');const whole=a.replace(/^0+(?=\d)/,'')||'0';const frac=b.replace(/0+$/,'');if(whole==='0'&&!frac)return null;return frac?`${whole}.${frac}`:whole;};
  const cmpDec=(x,y)=>{const [ax,fx='']=x.split('.'),[ay,fy='']=y.split('.');const n=Math.max(fx.length,fy.length);const bx=BigInt(ax+fx.padEnd(n,'0')),by=BigInt(ay+fy.padEnd(n,'0'));return bx<by?-1:bx>by?1:0;};
  function currentSpend(){if(typeof spendAuthorization!=='function')return MAIN?{mode:'enforced',authorized:false}:{mode:'legacy'};
    try{const v=spendAuthorization();if(!v||v.authorized!==true)return {mode:'enforced',authorized:false};
      const per=canon(v.perPayment),day=canon(v.perDay),term=canon(v.termTotal);if(!per||!day||!term||cmpDec(per,day)>0||cmpDec(day,term)>0)return {mode:'enforced',authorized:false};
      return {mode:'enforced',authorized:true,perPayment:per,perDay:day,termTotal:term,at:v.at??null};}catch{return {mode:'enforced',authorized:false};}}
  const sameSpend=(a,b)=>!!a&&!!b&&a.perPayment===b.perPayment&&a.perDay===b.perDay&&(a.termTotal??null)===(b.termTotal??null)&&(a.at??null)===(b.at??null);
  function bindSpend(p){const s=currentSpend();if(s.mode!=='enforced')return s;p.aiLimits=s.authorized?{perPayment:s.perPayment,perDay:s.perDay,termTotal:s.termTotal,at:s.at??null}:null;save();return s;}
  function assertSpend(p){const s=currentSpend();if(s.mode!=='enforced')return;
    if(s.authorized&&sameSpend(p.aiLimits,s))return;
    const stale=!!s.authorized;const e=Error(stale?'额度已经变了，这次页面上的数字不能用。请重新打开连接页再确认。/ The limits changed, so the amounts on this page cannot be used. Open the connection again.':'AI 总限额还没有确认，不能授权花钱。请先在启付里设置，再重新打开这个连接。/ AI spending limits are not confirmed, so this does not authorize spending. Set them in Kipurse, then open this connection again.');e.code=stale?'ai_limits_stale':'ai_limits_unconfirmed';throw e;}
  const spendError=e=>e&&(e.code==='ai_limits_unconfirmed'||e.code==='ai_limits_stale');

  // ---- consent page ----
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function page(title,inner,nonce,script=''){const zh=/[\u3400-\u9fff]/.test(String(title));return `<!doctype html><html lang=${zh?'zh':'en'}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--a:#5B4CF0;--bg:#F2F2F7;--card:#fff;--t:#111;--s:#6b6b78;color-scheme:light dark}@media(prefers-color-scheme:dark){:root{--a:#8B7CFF;--bg:#000;--card:#1c1c1e;--t:#f5f5f7;--s:#9a9aa5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:17px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.w{max-width:460px;margin:0 auto;padding:28px 20px 40px}
.mk{width:56px;height:56px;border-radius:15px;background:var(--a);color:#fff;display:grid;place-items:center;font:700 30px ui-rounded,-apple-system}.t{font-size:26px;font-weight:700;margin:16px 0 4px}.s{color:var(--s);margin:0 0 20px}
.c{background:var(--card);border-radius:18px;padding:16px 18px;margin:12px 0}.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(128,128,128,.2)}.row:last-child{border:0}
.n{font:600 17px ui-rounded,-apple-system;font-variant-numeric:tabular-nums}ul{margin:6px 0;padding-left:20px}li{margin:4px 0}.warn{background:rgba(220,38,38,.1);color:#c81e1e;border-radius:14px;padding:12px 14px;font-weight:600}
.test{background:#FFD666;color:#3D2A00;text-align:center;font-size:13px;font-weight:600;padding:6px}button,.btn{display:block;width:100%;border:0;border-radius:14px;padding:15px;font:600 17px -apple-system;margin-top:10px;text-align:center;text-decoration:none;cursor:pointer}
.p{background:var(--a);color:#fff}.g{background:rgba(91,76,240,.12);color:var(--a)}.muted{color:var(--s);font-size:14px}</style>
${MAIN?`<div class=test style="background:#c00;color:#fff">${zh?'Base 主网':'Base Mainnet'}</div>`:`<div class=test>${zh?'测试模式 · Base Sepolia · 测试币，不是真钱':'Test mode · Base Sepolia · test money, not real'}</div>`}<div class=w>${inner}</div>${script?`<script nonce="${nonce}">${script}</script>`:''}</html>`;}
  const phoneOn=()=>!!(MAIN&&phoneApprover&&phoneApprover.active());
  function phoneFields(id,action){const p=O.pending[id];const c=O.clients[p.client_id];return {wallet,req:id,clientId:p.client_id,name:c?.name??'AI',redirect:p.redirect_uri,exp:p.exp,action};}
  function phonePrepare(id){gc();const p=O.pending[id];if(!p||p.status!=='pending'||p.exp<Date.now()/1000)return [400,{error:'expired',error_description:'请求已过期或已处理，请回到 AI 重新连接'}];
    const a=phoneApprover?.active();if(!a)return [409,{error:'no_phone_signer'}];p.phase='signing';p.phaseAt=Date.now();save();const f=phoneFields(id,'approve');
    let host='';try{host=new URL(p.redirect_uri).host;}catch{}
    return [200,{req:id,clientId:f.clientId,name:f.name,kind:mapClient(f.name),redirect:f.redirect,returnsTo:host,origin:p.origin??'computer',exp:Math.floor(f.exp),wallet,fingerprint:a.fingerprint,digest:connectDigest(f),rejectDigest:connectDigest({...f,action:'reject'}),access:'request-only'}];}
  async function phoneDecide(b){const id=String(b.req||''),approve=b.approve===true;gc();const p=O.pending[id];
    if(!p||p.status!=='pending'||p.exp<Date.now()/1000)return [400,{error:'expired',error_description:'请求已过期或已处理，请回到 AI 重新连接'}];// replay of a used signature lands here
    const a=phoneApprover?.active();if(!a)return [409,{error:'no_phone_signer',error_description:'这台手机不是确认人'}];
    let live=false;try{live=await phoneApprover.onChain(a);}catch{live=false;}
    if(!live)return [403,{error:'phone_revoked',error_description:'手机确认人已不在钱包里（已撤销）'}];
    const d=connectDigest(phoneFields(id,approve?'approve':'reject'));let ok=false;try{ok=!!phoneApprover.verify(a,d,String(b.r??''),String(b.s??''));}catch{ok=false;}
    if(!ok)return [403,{error:'bad_signature',error_description:'确认不是这台已登记手机的'}];
    if(O.pending[id]?.status!=='pending')return [400,{error:'expired',error_description:'请求已处理'}];// raced with another decision
    let redirect;try{redirect=decide(id,approve);}catch(e){if(spendError(e))return [403,{error:e.code,error_description:e.message}];throw e;}
    O.pending[id].by='phone:'+a.fingerprint;save();return [200,{status:approve?'approved':'denied',redirect}];}
  function consentHtml(reqId,client,{owner,csrf,nonce,en}){const p=O.pending[reqId];const spend=bindSpend(p);const kind=mapClient(client.name);const X=(zh,e)=>en?e:zh;
    const what=`<div class=c><b>${X('它能做什么','What it can do')}</b><ul><li>${X('查看余额和付款记录','See your balance and payments')}</li><li>${X('在你设的上限内自动付款','Pay on its own, within your limits')}</li><li>${X('提议信任新的收款方、申请提现到你的钱包——都要你批准','Suggest new shops or withdrawals — you approve each one')}</li></ul><div class=muted>${X('它不能改上限，不能把钱转到别处。随时可以在 Kipurse App 里断开。','It can’t change your limits or send money anywhere else. Disconnect anytime in the Kipurse app.')}</div></div>`;
    const money=v=>en?'$'+esc(v):esc(v)+' USDC';
    let lim;if(spend.mode==='legacy'){let cp=null;try{cp=typeof caps==='function'?caps():null;}catch{cp=null;}
      lim=cp?`<div class=c><b>${X('上限','Your limits')}</b>${[[X('每笔','Per payment'),cp.perPayment],[X('每天','Per day'),cp.perDay],[X('整个期间','In total'),cp.termTotal]].map(([k,v])=>`<div class=row><span>${k}</span><span class=n>${v!=null&&v!==''?money(v):''}</span></div>`).join('')}</div>`:'';}
    else{const vals=spend.authorized?[spend.perPayment,spend.perDay,spend.termTotal??'']:['','',''];
      lim=`<div class=c><b>${X('上限','Your limits')}</b>${[[X('每笔','Per payment'),vals[0]],[X('每天','Per day'),vals[1]],[X('整个期间','In total'),vals[2]]].map(([k,v])=>`<div class=row><span>${k}</span><span class=n>${v?money(v):''}</span></div>`).join('')}</div>`;}
    const head=`<div class=mk>K</div><div class=t>${esc(client.name)} ${X('想连接你的 Kipurse 钱包','wants to connect to your Kipurse wallet')}</div><p class=s>${X('类型','Type')}: ${esc(kind)} · ${X('回调','Returns to')}: ${esc(new URL(p.redirect_uri).host)}</p>`;
    const warn=`<div class=warn>${X('⚠️ 这个钱包完全由 AI 控制，请只放少量资金。','Your AI can spend this money on its own — keep only a small amount here.')}</div>`;
    if(!owner&&MAIN&&verifyOwner&&phoneOn()){const data=JSON.stringify({req:reqId,client:client.name,owner:ownerAddress,message:ownerMessage(reqId),en}).replace(/</g,'\\u003c');
      const T=JSON.stringify({signing:X('授权中…请在 Kipurse 里用 Face ID 批准','Approving… confirm with Face ID in Kipurse'),done:X('授权完成，正在返回 ','Approved — returning to ')+client.name+'…',back:X('返回 ','Return to ')+client.name,
        denied:X('已拒绝','Declined'),expired:X('已过期，请回到 AI 重新连接','Expired — go back to your AI and connect again')}).replace(/</g,'\\u003c');
      return page(X('批准连接','Approve connection'),`${head}${what}${lim}${warn}<a class="btn p" id=fid href="kipurse://approve-connect?id=${reqId}">${X('在 Kipurse 里用 Face ID 批准','Approve with Face ID in Kipurse')}</a>
<p class=muted id=pst>${X('打开 Kipurse App，用已登记的这台 iPhone 批准。批准后这里会自动返回。','Opens the Kipurse app on your enrolled iPhone. This page continues by itself.')}</p><div id=back></div>
<button class=g id=ok>${X('或用 Base Account 批准','Or approve with Base Account')}</button><button class=g id=no>${X('拒绝','Decline')}</button><p class=muted id=st></p>
<script type="application/json" id=kp-data>${data}</script><script nonce="${nonce}" src="/oauth/consent.js"></script>`,nonce,
`(()=>{const T=${T},st=document.getElementById('pst'),bk=document.getElementById('back');let fin=false;const go=r=>{if(fin)return;fin=true;st.textContent=T.done;st.style.color='#0E9F6E';st.style.fontWeight='600';
for(const i of ['fid','ok','no'])document.getElementById(i)?.remove();const a=document.createElement('a');a.className='btn p';a.href=r;a.textContent=T.back;bk.replaceChildren(a);setTimeout(()=>{location.href=r;},600);};
const tick=async()=>{if(fin)return;try{const j=await(await fetch('/oauth/status?req=${reqId}',{cache:'no-store'})).json();if(j.redirect)go(j.redirect);else if(j.status==='denied'){st.textContent=T.denied;fin=true;}
else if(j.status==='expired'||j.status==='used'){st.textContent=T.expired;fin=true;}else if(j.phase==='signing'){st.textContent=T.signing;st.style.fontWeight='600';}}catch{}};setInterval(tick,1500);tick();document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick();});addEventListener('pageshow',tick);addEventListener('focus',tick);})();`);}
    if(!owner&&MAIN&&verifyOwner){const data=JSON.stringify({req:reqId,client:client.name,owner:ownerAddress,message:ownerMessage(reqId),en}).replace(/</g,'\\u003c');
      return page(X('批准连接','Approve connection'),`${head}${what}${lim}${warn}<button class=p id=ok>${X('用我的 Base Account 批准（Face ID）','Approve with my Base Account (Face ID)')}</button><button class=g id=no>${X('拒绝','Decline')}</button>
<p class=muted id=st>${X('只有钱包主人的 Base Account 确认才能批准。确认不花钱，不发交易。','Only the wallet owner’s Base Account signature can approve. Signing is free and sends no transaction.')}</p><div id=back></div><script type="application/json" id=kp-data>${data}</script><script nonce="${nonce}" src="/oauth/consent.js"></script>`,nonce);}
    if(owner)return page(X('批准连接','Approve connection'),`${head}${what}${lim}${warn}<form method=post action="/oauth/decision"><input type=hidden name=req value="${reqId}"><input type=hidden name=csrf value="${csrf}">
<button class=p name=d value=approve>${X('批准连接','Approve')}</button><button class=g name=d value=deny>${X('拒绝','Decline')}</button></form>`,nonce);
    return page(X('批准连接','Approve connection'),`${head}${what}${lim}${warn}<a class="btn p" href="kipurse://oauth?req=${reqId}">${X('在 iPhone 上用 Kipurse App 批准（Face ID）','Approve in the Kipurse app (Face ID)')}</a>
<p class=muted>${X('或者在已登录 Kipurse 的电脑浏览器里打开本页。批准后这里会自动继续。','We also sent a notification to your iPhone. This page continues by itself once you approve.')}</p><p class=muted id=st>${X('等待你批准…','Waiting for your approval…')}</p>`,nonce,
`setInterval(async()=>{try{const r=await fetch('/oauth/status?req=${reqId}');const j=await r.json();if(j.redirect)location.href=j.redirect;else if(j.status==='expired')document.getElementById('st').textContent=${JSON.stringify(en?'Expired — go back to your AI and connect again':'已过期，请回到 AI 重新连接')};}catch{}},2000);`);}

  /** HTTP router. Returns true if handled. */
  async function handle(req,res,u,{readBody,ip}){const p=u.pathname;
    const json=(code,b,h={})=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store','access-control-allow-origin':'*',...h});res.end(JSON.stringify(b));};
    if(req.method==='OPTIONS'&&(p.startsWith('/.well-known/')||p.startsWith('/oauth/')||p==='/mcp'||p==='/sse'||p==='/messages'||p.startsWith('/mcp/'))){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'authorization,content-type,mcp-protocol-version,mcp-session-id,x-api-key,kipurse-api-key,accept','access-control-expose-headers':'WWW-Authenticate, Mcp-Session-Id','access-control-max-age':'600'});res.end();return true;}
    if(p==='/.well-known/oauth-protected-resource'||p==='/.well-known/oauth-protected-resource/mcp'){json(200,prm());return true;}
    if(p==='/.well-known/oauth-authorization-server'||p==='/.well-known/oauth-authorization-server/mcp'||p==='/.well-known/openid-configuration'){json(200,asm());return true;}
    if(!p.startsWith('/oauth/'))return false;
    if(limited(ip)){json(429,{error:'slow_down'},{'retry-after':'60'});return true;}
    if(p==='/oauth/register'&&req.method==='POST'){const [c,b]=register(await readBody(req));json(c,b);return true;}
    if(p==='/oauth/token'&&req.method==='POST'){const body={...(await readBody(req))};// client_secret_basic clients (e.g. Gemini): client_id in the Basic header; there is no secret to check (public clients)
      const ba=/^Basic\s+(.+)$/i.exec(String(req.headers.authorization??''));if(ba&&!body.client_id){try{body.client_id=decodeURIComponent(Buffer.from(ba[1],'base64').toString().split(':')[0]);}catch{}}
      const [c,b]=token(body);json(c,b);return true;}
    if(p==='/oauth/revoke'&&req.method==='POST'){const [c,b]=revoke(await readBody(req));json(c,b);return true;}
    if(MAIN&&p==='/oauth/consent.js'&&req.method==='GET'&&consentScript){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(consentScript());return true;}
    if(MAIN&&verifyOwner&&p==='/oauth/owner-decide'&&req.method==='POST'){const b=await readBody(req);const id=String(b.req||'');const pd=O.pending[id];
      if(!pd||pd.status!=='pending'||pd.exp<Date.now()/1000){json(400,{error:'expired',error_description:'请求已过期或已处理，请回到 AI 重新连接'});return true;}
      if(b.approve!==true){json(200,{redirect:decide(id,false)});return true;}
      let ok=false;try{ok=await verifyOwner(ownerMessage(id),String(b.signature||''));}catch{ok=false;}
      if(!ok){json(403,{error:'not_owner',error_description:'确认不是钱包主人的 Base Account'});return true;}
      try{json(200,{redirect:decide(id,true)});}catch(e){if(spendError(e)){json(403,{error:e.code,error_description:e.message});return true;}throw e;}return true;}
    if(MAIN&&phoneApprover&&p==='/oauth/phone-prepare'&&req.method==='POST'){const [c,b]=phonePrepare(String((await readBody(req)).req||''));json(c,b);return true;}
    if(MAIN&&phoneApprover&&p==='/oauth/phone-decide'&&req.method==='POST'){const [c,b]=await phoneDecide(await readBody(req));json(c,b);return true;}
    if(p==='/oauth/status'){const r=O.pending[u.searchParams.get('req')||''];
      json(200,!r||r.exp<Date.now()/1000?{status:'expired'}:MAIN&&r.status==='approved'&&r.codeHash&&!O.codes[r.codeHash]?{status:r.codeExp<Date.now()/1000?'expired':'used',redirect:null}:{status:r.status,redirect:r.redirect??null,...(r.status==='pending'&&r.phase?{phase:r.phase}:{})});
      if(r?.redirect&&!MAIN)delete O.pending[u.searchParams.get('req')];return true;}
    const nonce=rnd(12);const html=(code,body)=>{res.writeHead(code,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer',
      'content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'${MAIN?" https:; frame-src https://keys.coinbase.com":''}; form-action 'self' https: http://127.0.0.1:* http://localhost:*; frame-ancestors 'none'`});res.end(body);};
    if(p==='/oauth/authorize'&&req.method==='GET'){const r=startAuthorize(u.searchParams);
      if(r.err){const en=(()=>{const q=new URL(req.url,'http://x').searchParams.get('lang');return q==='zh'||q==='en'?q==='en':!/^\s*zh/i.test(String(req.headers['accept-language']??''));})();const tt=en?'Can’t connect':'无法连接';html(400,page(tt,`<div class=mk>K</div><div class=t>${tt}</div><p class=s>${esc(en?errEn(r.err):r.err)}</p><p class=muted>${en?'Go back to your AI app and start the connection again.':'请回到 AI 应用重新连接。'}</p>`,nonce));return true;}
      if(r.redirect){res.writeHead(302,{location:r.redirect});res.end();return true;}
      if(r.used){const en=(()=>{const q=new URL(req.url,'http://x').searchParams.get('lang');return q==='zh'||q==='en'?q==='en':!/^\s*zh/i.test(String(req.headers['accept-language']??''));})();html(200,page(en?'Already connected':'已经连接',`<div class=mk>K</div><div class=t>${en?'Already connected':'这个连接已经完成'}</div><p class=s>${en?'Go back to '+esc(r.client.name)+'. To connect again, start over in your AI.':'请回到 '+esc(r.client.name)+'。如需重新连接，请在 AI 里重新开始。'}</p>`,nonce));return true;}
      if(r.done){const en=(()=>{const q=new URL(req.url,'http://x').searchParams.get('lang');return q==='zh'||q==='en'?q==='en':!/^\s*zh/i.test(String(req.headers['accept-language']??''));})();html(200,page(en?'Approved':'已批准',`<div class=mk>K</div><div class=t>${en?'Approved':'已批准'}</div><p class=s>${en?'Tap the button to finish connecting.':'点下面的按钮回到 AI 完成连接。'}</p><a class="btn p" id=back href="${esc(r.done)}">${en?'Return to '+esc(r.client.name)+' to finish':'返回 '+esc(r.client.name)+' 完成连接'}</a>`,nonce));return true;}
      if(O.pending[r.req]){O.pending[r.req].origin=/iPhone|iPad|iPod|Android/i.test(String(req.headers['user-agent']??''))?'phone':'computer';save();}
      const own=ownerSession(req);const en=(()=>{const q=new URL(req.url,'http://x').searchParams.get('lang');return q==='zh'||q==='en'?q==='en':!/^\s*zh/i.test(String(req.headers['accept-language']??''));})();html(200,consentHtml(r.req,r.client,{owner:!!own,csrf:own?.csrf,nonce,en}));return true;}
    if(p==='/oauth/decision'&&req.method==='POST'){const b=await readBody(req);const own=ownerSession(req);
      const en=(()=>{const q=new URL(req.url,'http://x').searchParams.get('lang');return q==='zh'||q==='en'?q==='en':!/^\s*zh/i.test(String(req.headers['accept-language']??''));})();if(!own||!b.csrf||b.csrf!==own.csrf){html(403,page(en?'Sign-in needed':'需要登录',en?`<div class=t>The wallet owner must sign in</div><p class=s>Use a browser signed in to Kipurse, or approve in the Kipurse app.</p>`:`<div class=t>需要主人登录</div><p class=s>请在已登录 Kipurse 的浏览器里操作，或用 Kipurse App 批准。</p>`,nonce));return true;}
      try{const to=decide(String(b.req||''),b.d==='approve');res.writeHead(303,{location:to});res.end();}catch(e){if(spendError(e)){html(403,page(en?'Not confirmed':'还不能批准',`<div class=t>${esc(e.message)}</div>`,nonce));return true;}html(400,page(en?'Expired':'已过期',`<div class=t>${esc(en?'The request has expired or was already handled. Go back to your AI and connect again.':e.message)}</div>`,nonce));}return true;}
    json(404,{error:'not_found'});return true;}

  // account deletion: drop every client registration, pending request, code and token
  function revokeAll(){for(const t of ['clients','pending','codes','tokens'])for(const k of Object.keys(O[t]))delete O[t][k];save();}
  function rebind(o){O=o;}
  const clientCount=()=>Object.keys(O.clients).length;
  return {phonePrepare,phoneDecide,ownerMessage,revokeAll,rebind,clientCount,handle,challenge,agentForAccess,revokeAgent,decide,pendingList,mapClient,prm,asm};
}
