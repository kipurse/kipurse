// SPDX-License-Identifier: AGPL-3.0-only
// SIGN IN WITH COINBASE (identity = the user's Base Account, nothing else). Free: one off-chain signature (EIP-4361 / SIWE text),
// verified on chain-state with ERC-1271 / ERC-6492 (smart-wallet Base Accounts), never a transaction. Answers ONE question for the app:
//   reconnect - this Base Account owns a Kipurse wallet AND the phone key the app sent is that wallet's active phone approver on chain;
//   bind      - this Base Account owns a Kipurse wallet, but this phone key is not its owner (add this phone; user-paid batch);
//   new       - this Base Account has no Kipurse wallet (new-user onboarding; the app must create a fresh phone key).
// A Base Account maps to at most one wallet (registry byOwner + deterministic factory address), so sign-in can never create a 2nd wallet.
// Privacy: no addresses, signatures or messages are logged; per-request state lives in the KV with a short TTL.
import {langOf,X} from './i18n.mjs';import {randomBytes,createHash,randomInt,timingSafeEqual} from 'node:crypto';import {getAddress,isAddress,parseAbi,toHex} from 'viem';import {parseSiweMessage} from 'viem/siwe';import {kvKey} from './store.mjs';import {p256VerifyDigest,approverHint,fingerprint} from './phone-signer.mjs';import {publicError} from './onboard.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const SIGNIN_JS_V=Date.now().toString(36);
export const signinSri=b=>'sha384-'+createHash('sha384').update(b).digest('base64');
const W_ABI=parseAbi(['function isOwnerAddress(address account) view returns (bool)']);
const HEX32=/^0x[0-9a-fA-F]{1,64}$/,ID=/^[0-9a-f]{32}$/;
/** t1265: what the app's phone key (Secure Enclave P-256) signs to prove it holds the key it sent to /signin/start. Domain-separated text, SHA-256. */
export const signinKeyDigest=id=>'0x'+createHash('sha256').update(`Kipurse sign-in key v1\nid:${id}`).digest('hex');
export const SIWE_STATEMENT='Sign in to Kipurse. This only proves this account is yours. It costs nothing and sends no transaction.';
/** t1275: the SIWE statement names the phone key that started the sign-in (same fingerprint format as everywhere: phone-signer fingerprint of the
    32-byte x, y). The owner's signature then covers exactly which iPhone may read the wallet; the read grant is written only for that key.
    ONE formula: the iOS app rebuilds this text itself (KipurseCore SigninSiwe.statement) and refuses any other (fixture t1275-signin-siwe.json.txt). */
export const signinKeyFp=(x,y)=>fingerprint(toHex(BigInt(String(x)),{size:32}),toHex(BigInt(String(y)),{size:32}));
export const signinStatement=fp=>`Sign in to Kipurse and allow the iPhone with key ${fp} to read this wallet. Free: no transaction.`;
export const signinStatementFor=(x,y)=>x&&y?signinStatement(signinKeyFp(x,y)):SIWE_STATEMENT;
/** EIP-4361 message. domain = host of the page origin (what the Base Account popup shows). */
export function siweMessage({domain,uri,address,chainId,nonce,issuedAt,statement=SIWE_STATEMENT}){
  return `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n${statement}\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${issuedAt}`;}
/** Minimal EIP-4361 parser for the fields we check. */
export function parseSiwe(m){const t=String(m??'').replace(/\r\n?/g,'\n');let v={};try{v=parseSiweMessage(t)??{};}catch{v={};}
  const L=t.split('\n');const f=k=>{const l=L.find(x=>x.trim().startsWith(k+':'));return l?l.slice(l.indexOf(':')+1).trim():null;};
  const h=/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(\S+) wants you to sign in with your Ethereum account:\s*$/.exec(L[0]??'');
  const ver=String(v.version??f('Version')??'').trim().replace(/^["']|["']$/g,'');
  const st=v.statement??(L[2]===''&&L[3]&&L[4]===''&&!/^[A-Za-z ]{1,20}:/.test(L[3])?L[3]:null);   // t1275
  return {domain:v.domain??h?.[1]??null,address:String(v.address??L[1]??'').trim(),statement:st,uri:v.uri??f('URI'),version:ver,chainId:Number(v.chainId??f('Chain ID')),nonce:v.nonce??f('Nonce'),
    issuedAt:v.issuedAt instanceof Date?v.issuedAt.toISOString():(v.issuedAt??f('Issued At')),expirationTime:v.expirationTime instanceof Date?v.expirationTime.toISOString():(v.expirationTime??f('Expiration Time')),
    notBefore:v.notBefore instanceof Date?v.notBefore.toISOString():(v.notBefore??f('Not Before'))};}
/** Shape of a field for diagnostics only (no PII): length + char classes. */
const shape=x=>{const s=String(x??'');return s.length>12?`len${s.length}`:JSON.stringify(s.replace(/[^0-9a-zA-Z. ]/g,'?'));};
export function createSignin({kv,pub,reg,phoneOf,base,script,obs,onboard=null,chainId=8453,ttlMs=10*60e3,maxAgeMs=10*60e3,grantTtlMs=30*24*3600e3,now=()=>Date.now()}){
  const K=id=>kvKey('signin',null,id);const host=()=>new URL(base()).host;
  /* t1278 S9: the owner's SIWE message + signature live in their own short-lived key (ttlMs) and are handed out only to the starter, never in the
     long-lived (30-day) unproven-bind record; sign-in ids are indexed by wallet (signin-w) so the user-data erase finds and deletes them */
  const KP=id=>kvKey('signin-p',null,id);const KW=w=>kvKey('signin-w',String(w).toLowerCase(),'ids');
  const indexId=(wallet,id,ttl)=>{try{const k=KW(wallet);const l=(kv.get(k)??[]).filter(x=>ID.test(String(x))&&x!==id&&kv.get(K(x)));l.push(id);kv.put(k,l.slice(-50),Math.max(Number(ttl)||0,31*86400e3));}catch{}};/* t1279 R5 (decision 139): the index outlives every record it lists (longest 30 d), so a later short sign-in never hides an older record from erase */
  const erasedSince=(wallet,o)=>{try{const rec=reg?.get?.(wallet);return !!rec?.erasedAt&&Number(rec.erasedAt)>=Number(o?.at??0);}catch{return true;}};
  // t789: the sign-in page pins its bundle with SRI; the app checks the same sha384 (SigninCheck.swift) before showing the page.
  let SRI=null;const sri=()=>SRI??=signinSri(script());
  // setup (optional): the app's fresh phone key + default AI limits. A NEW account then opens its wallet on this SAME page
  // (one page: sign in, then one free setup confirmation); returning accounts just sign in and the pending setup expires unused.
  /* t1265: a phone key sent here earns the read grant (bind) or the one-page setup ONLY after the starter proves it holds that key: a P-256
     signature by x / y over signinKeyDigest(id). Either in start itself (the app picks the 32-hex id and signs it: {id, r, s}) or afterwards
     with POST /signin/prove {id, poll, r, s}. Without the proof the sign-in still answers reconnect / bind / new, but leaves no grant and opens
     no setup, so a phisher cannot attach THEIR key to a victim's sign-in. */
  const keyOk=(x,y,id,r,s)=>{try{return HEX32.test(String(r??''))&&HEX32.test(String(s??''))&&p256VerifyDigest({x:String(x),y:String(y)},signinKeyDigest(id),String(r),String(s));}catch{return false;}};
  // t1275: the grant goes ONLY to the key the owner's signed SIWE statement names (o.fp set by verify from the checked statement)
  const writeGrant=(wallet,o,owner)=>{if(!o.x||!o.y||!o.fp||o.fp!==signinKeyFp(o.x,o.y))return false;if(erasedSince(wallet,o))return false;/* t1278 S9: never after the wallet's data was erased */kv.put(kvKey('readgrant',wallet,'phone'),{x:o.x,y:o.y,owner,exp:now()+grantTtlMs},grantTtlMs);return true;};
  function start({x,y,setup,id:cid,r,s}={}){const hasKey=HEX32.test(String(x??''))&&HEX32.test(String(y??''));
    const wantSetup=!!(hasKey&&setup&&typeof setup==='object'&&onboard);
    const own=hasKey&&ID.test(String(cid??''))&&!kv.get(K(String(cid)));
    const id=own?String(cid):randomBytes(16).toString('hex'),nonce=randomBytes(12).toString('hex'),poll=randomBytes(16).toString('hex'),pair=String(randomInt(1000,10000));
    const proven=own&&keyOk(x,y,id,r,s);
    const lim=wantSetup?{single:String(setup.single),daily:String(setup.daily),term:String(setup.term),days:String(setup.days??90)}:null;
    // t796 H2: the poll secret goes ONLY to the starter (never in the page URL); the pairing code is shown in the app AND on the page
    const statement=signinStatementFor(hasKey&&x,hasKey&&y);   // t1275
    const put=onb=>{kv.put(K(id),{pollH:createHash('sha256').update(poll).digest('hex'),pair,x:hasKey?String(x):null,y:hasKey?String(y):null,nonce,state:'start',onb,proven,wantSetup,lim,statement,at:now()},ttlMs);
      return {id,url:`${base()}/signin?id=${id}`,nonce,setup:!!onb,poll,pair,proven,statement,...(hasKey&&!proven?{prove:{digest:signinKeyDigest(id)}}:{})};};
    if(!(wantSetup&&proven))return put(null);
    return onboard.start({x:String(x),y:String(y),single:setup.single,daily:setup.daily,term:setup.term,days:setup.days,owner:null}).then(r0=>put(r0.id));}
  /** t1265: proof of the phone key after start (poll secret = the starter). Opens the pending setup / writes the bind grant if sign-in already finished. */
  async function prove(id,{poll,r,s}={}){const o=ID.test(id)&&kv.get(K(id));if(!o||!o.pollH||!pollOk(o,poll))throw Object.assign(Error('unknown or expired'),{code:'unknown'});
    if(!o.x||!o.y)throw Object.assign(Error('no phone key in this sign-in'),{code:'bad_request'});
    if(!keyOk(o.x,o.y,id,r,s))throw Object.assign(Error('phone key signature not valid'),{code:'bad_key_signature'});
    let onb=o.onb??null;if(!onb&&o.wantSetup&&o.state==='start'&&onboard&&o.lim)onb=(await onboard.start({x:o.x,y:o.y,single:o.lim.single,daily:o.lim.daily,term:o.lim.term,days:o.lim.days,owner:null})).id;
    if(o.state==='done'&&o.result==='bind'&&o.wallet&&o.owner)writeGrant(o.wallet,o,o.owner);
    kv.put(K(id),{...o,proven:true,onb},ttlMs);return {ok:true,setup:!!onb};}
  /** Two-step fallback (wallets without the signInWithEthereum capability): the server writes the message for the connected account. */
  function message(id,address){const o=ID.test(id)&&kv.get(K(id));if(!o||o.state!=='start')throw Object.assign(Error('unknown or expired'),{code:'unknown'});
    if(!isAddress(String(address)))throw Object.assign(Error('bad address'),{code:'bad_request'});
    return {message:siweMessage({domain:host(),uri:base(),address:getAddress(address),chainId,nonce:o.nonce,issuedAt:new Date(now()).toISOString(),statement:signinStatementFor(o.x,o.y)})};}
  async function resolve(owner,o){const rec=reg.byOwner(owner)[0];if(!rec)return {result:'new',wallet:null};
    let phone=false,hint={};try{hint=approverHint(await phoneOf(rec.wallet));}catch{hint={};}   // t1268: seat / approver for the app's on-chain WalletVerify
    if(o.x&&o.y){try{const a=await phoneOf(rec.wallet);
      phone=!!a&&BigInt(a.x)===BigInt(o.x)&&BigInt(a.y)===BigInt(o.y)&&await pub.readContract({address:getAddress(rec.wallet),abi:W_ABI,functionName:'isOwnerAddress',args:[getAddress(a.approver)]});}catch{phone=false;}}
    return {result:phone?'reconnect':'bind',wallet:getAddress(rec.wallet),path:rec.publicPath??'/t/'+String(rec.wallet).toLowerCase(),...hint};}
  async function verify(id,{address,message:m,signature,poll}){const o=ID.test(id)&&kv.get(K(id));if(!o)throw Object.assign(Error('unknown or expired'),{code:'unknown'});
    // t1265: a finished sign-in is re-read only with the starter's poll secret (the page URL / id alone never reveals the owner or the wallet)
    if(o.state==='done'){if(!o.pollH||!pollOk(o,poll))throw Object.assign(Error('unknown or expired'),{code:'unknown'});return {ok:true,result:o.result,wallet:o.wallet,owner:o.owner,path:o.path,...hintOf(o),...proofOf(o,id)};}
    if(!isAddress(String(address))||typeof m!=='string'||m.length>2000||!/^0x[0-9a-fA-F]+$/.test(String(signature))||String(signature).length>20000)throw Object.assign(Error('bad request'),{code:'bad_request'});
    const p=parseSiwe(m),A=getAddress(address);const t=Date.parse(p.issuedAt??'');
    // t1275: a sign-in started with a phone key must be signed over the statement naming exactly that key (never the generic text, never another key)
    const wantSt=o.x&&o.y?signinStatement(signinKeyFp(o.x,o.y)):null;
    const bad=p.domain!==host()?'domain':(wantSt&&p.statement!==wantSt)?'statement':p.address.toLowerCase()!==A.toLowerCase()?'address':p.nonce!==o.nonce?'nonce':p.chainId!==chainId?'chain':(p.version!==''&&p.version!=='1'&&p.version!=='1.0')?'version':
      (p.issuedAt&&!(t>now()-maxAgeMs&&t<now()+120e3))?'time':(p.expirationTime&&Date.parse(p.expirationTime)<now())?'expired':(p.notBefore&&Date.parse(p.notBefore)>now()+120e3)?'not_yet':null;
    if(bad){const L=String(m).split(/\r?\n/);const keys=L.map(l=>(/^([A-Za-z][A-Za-z ]{0,20}):/.exec(l)||[])[1]).filter(Boolean);
      const diag={field:bad,version:shape(p.version),domainOk:p.domain===host(),lines:L.length,crlf:/\r/.test(m),keys:keys.join('|'),hex:/^0x[0-9a-f]+$/i.test(String(m).trim()),line0:shape(L[0]?.replace(/0x[0-9a-fA-F]{40}/g,'ADDR'))};
      obs?.log?.('signin_bad_message',diag);console.log(JSON.stringify({event:'signin_bad_message_diag',...diag}));
      throw Object.assign(Error('message mismatch: '+bad+' ['+diag.version+'|'+diag.keys.slice(0,80)+']'),{code:'bad_message'});}
    let ok=false;try{ok=await pub.verifyMessage({address:A,message:m,signature});}catch{ok=false;}
    if(!ok){obs?.log?.('signin',{result:'bad_signature'});throw Object.assign(Error('signature not valid for this account'),{code:'bad_signature'});}
    const r=await resolve(A,o);let setup=null;o.fp=wantSt?signinKeyFp(o.x,o.y):null;   // t1275: the key the owner's signature names
    if(r.result==='new'&&o.onb&&o.proven&&onboard&&onboard.bindOwner(o.onb,A))setup={id:o.onb,free:onboard.sponsorable(o.onb)};
    // t849: verified owner on a phone that isn't the approver -> read-only grant for THIS phone key (30 days, one per wallet, replaced next sign-in)
    // t1265: only once the starter proved it holds that key (else prove() writes it later)
    if(r.result==='bind'&&o.x&&o.y&&r.wallet&&o.proven)writeGrant(r.wallet,o,A);
    else if(r.result==='reconnect'&&r.wallet)kv.del?.(kvKey('readgrant',r.wallet,'phone'));
    /* t1268 (decision 133, 0A #2): no Face ID at sign-in -> an unproven "bind" stays provable for the read-grant lifetime; the app proves with the Face ID of the first action that needs it (turning on Face ID approvals) */
    {const ttl=r.result==='bind'&&!o.proven&&o.x&&o.y?grantTtlMs:ttlMs;const {siweMessage:_m,siweSignature:_s,...rest}=o;
      kv.put(K(id),{...rest,state:'done',owner:A,...r},ttl);kv.put(KP(id),{siweMessage:m,siweSignature:String(signature)},ttlMs);if(r.wallet)indexId(r.wallet,id,ttl);}   /* t1278 S9 */
    obs?.log?.('signin',{result:r.result,setup:!!setup});return {ok:true,owner:A,...r,setup};}
  /** t1275: the owner's own SIWE message + signature, so the app checks the owner itself (domain, chain, nonce, its own key in the statement, ERC-6492 on chain) */
  /* t1278 S9: only by the starter (callers check the poll secret first); kept in its own key for ttlMs (10 min), never in the 30-day record.
     Re-readable inside that window so a lost status reply never breaks sign-in (executor review). */
  const proofOf=(o,id)=>{let p=null;try{p=id?kv.get(KP(id)):null;}catch{p=null;}
    return p?.siweMessage&&p?.siweSignature?{siweMessage:p.siweMessage,siweSignature:p.siweSignature}:{};};
  const hintOf=o=>({...(o.approver?{approver:o.approver}:{}),...(o.seat?{seat:o.seat}:{})});
  const pollOk=(o,poll)=>{if(!o?.pollH)return true;const a=Buffer.from(o.pollH,'hex'),b=createHash('sha256').update(String(poll??'')).digest();return a.length===b.length&&timingSafeEqual(a,b);};
  function status(id,poll){const o=ID.test(id)&&kv.get(K(id));if(!o||!pollOk(o,poll))return {state:'expired'};if(o.state!=='done')return {state:o.state};const s=o.result==='new'&&o.onb&&onboard?onboard.status(o.onb):null;
    return {state:'done',result:o.result,wallet:o.wallet,owner:o.owner,path:o.path,...hintOf(o),...proofOf(o,id),setup:s?{state:s.state,wallet:s.wallet}:null};}
  function page(id,o,nonce,lang){const t=X(lang);return `<!doctype html><html lang=${lang}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${t('用 Coinbase 登录 Kipurse','Sign in to Kipurse with Coinbase')}</title>
<style>body{margin:0;background:#F2F2F7;color:#111;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}.w{max-width:480px;margin:0 auto;padding:28px 18px 40px}.c{background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0}.t{font-size:24px;font-weight:700;margin:10px 0}.m{color:#666;font-size:14px}button{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px;background:#0052FF;color:#fff}</style>
<div class=w><div class=t>${t('用 Coinbase 登录','Sign in with Coinbase')}</div>
<div class=c id=pair style="text-align:center"><div class=m>${t('配对码','Pairing code')}</div><div style="font-size:34px;font-weight:700;letter-spacing:6px">${esc(o.pair??'')}</div><div class=m>${t('只有当你这台手机上的启付 App 显示同样的配对码时才继续。不是你刚在 App 里点的登录？关掉这个页面。','Only continue if the Kipurse app on this phone shows the same code. Didn’t just tap Sign in in the app? Close this page.')}</div></div>
<div class=c>${t('你的 Coinbase 账户（Base Account）就是你在启付的身份。启付不存密码，也不做实名。','Your Coinbase account (Base Account) is your Kipurse identity. Kipurse stores no password and does no ID check.')}</div>
${o.onb?`<div class=c><b>${t('(1) 登录：签一个名，不花钱','(1) Sign in: one signature, no charge')}</b><div class=m>${t('不发生交易，只确认这个账户是你的。','No transaction; it only proves the account is yours.')}</div></div>
<div class=c id=setupcard><b>${t('(2) 新用户：同一页里再点一次「开通」','(2) New here: tap “Open wallet” once more on this page')}</b><div class=m>${t(`创建你的启付钱包，并设好 AI 默认上限（每笔 ${esc(o.lim?.single??'')} · 每天 ${esc(o.lim?.daily??'')} · 总额 ${esc(o.lim?.term??'')} USDC · ${esc(o.lim?.days??'')} 天，可以随时在 App 里自己改）。首次开通的网络手续费以 USDC 从钱包余额中扣除，Kipurse 不另收费；扣费前会先告诉你。老用户只需第 (1) 步。`,`Creates your Kipurse wallet with default AI limits (${esc(o.lim?.single??'')} per payment · ${esc(o.lim?.daily??'')} per day · ${esc(o.lim?.term??'')} USDC total · ${esc(o.lim?.days??'')} days; change them in the app any time). The first-setup network fee is paid in USDC from your wallet balance; Kipurse adds no charge, and you are told before anything is deducted. Returning users only do step (1).`)}</div></div>`
:`<div class=c><b>${t('只签一个名，不花钱','One signature, no charge')}</b><div class=m>${t('不发生任何交易，不花钱。只用来确认这个账户是你的。','No transaction, no fee. It only proves the account is yours.')}</div></div>`}
<button id=go>${t('用 Coinbase 登录','Sign in with Coinbase')}</button><p class=m id=st></p></div>
<script type="application/json" id=kp-data>${JSON.stringify({id,nonce:o.nonce,chainId,statement:signinStatementFor(o.x,o.y)}).replace(/</g,'\\u003c')}</script><script nonce="${nonce}" src="/signin.js?v=${SIGNIN_JS_V}" integrity="${sri()}"></script></html>`;}
  async function handle(req,res,u,{readBody}){const p=u.pathname;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(o));};
    try{if(p==='/signin.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(script());return true;}
      if(p==='/signin/start'&&req.method==='POST'){const b=await readBody(req);json(200,await start({x:b.x,y:b.y,setup:b.setup,id:b.id,r:b.r,s:b.s}));return true;}
      if(p==='/signin/message'&&req.method==='POST'){const b=await readBody(req);json(200,message(String(b.id??''),String(b.address??'')));return true;}
      if(p==='/signin/verify'&&req.method==='POST'){const b=await readBody(req);json(200,await verify(String(b.id??''),{address:b.address,message:b.message,signature:b.signature,poll:b.poll}));return true;}
      if(p==='/signin/prove'&&req.method==='POST'){const b=await readBody(req);json(200,await prove(String(b.id??''),{poll:b.poll,r:b.r,s:b.s}));return true;}
      if(p==='/signin/status'&&req.method==='GET'){json(200,status(String(u.searchParams.get('id')??''),String(u.searchParams.get('poll')??'')));return true;}
      if(p==='/signin'&&req.method==='GET'){const id=String(u.searchParams.get('id')??'');const o=ID.test(id)&&kv.get(K(id));const nonce=randomBytes(12).toString('base64url');
        res.writeHead(o?200:404,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer',
          'content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; form-action 'none'; frame-ancestors 'none'`});
        {const lang=langOf(req,u);res.end(o?page(id,o,nonce,lang):`<!doctype html><html lang=${lang}><meta charset=utf-8><p>${X(lang)('已过期，请回 App 重新开始。','Expired. Go back to the app and start again.')}</p></html>`);}return true;}
      return false;}catch(e){if(e?.status===413){json(413,{error:'too_large'});return true;}json(e.code==='bad_signature'?401:400,publicError(e));return true;}}   // t1265: own error codes only
  return {handle,start,prove,message,verify,status};}
