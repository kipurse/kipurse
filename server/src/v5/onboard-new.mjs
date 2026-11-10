// SPDX-License-Identifier: AGPL-3.0-only
// NEW USER "开通" (find-or-create): the app starts with only its phone key + chosen limits. On the page the user connects HIS Base Account;
// the server then builds ONE atomic batch for exactly that owner:
//   - he already has a Kipurse wallet here  -> that wallet's re-setup batch (tenant onboarding);
//   - he has none -> create his wallet (Coinbase Smart Wallet factory, deterministic, owner = his Base Account) + spend permission/caps +
//     phone approver V2 (Face ID + Siri) in the same batch. Gas: his Base Account. Registration happens only after everything is ON CHAIN.
import {langOf,X} from './i18n.mjs';import {randomBytes,createHash} from 'node:crypto';import {getAddress,encodeAbiParameters,encodeFunctionData,parseAbi,decodeAbiParameters} from 'viem';
import {approverInit,DETERMINISTIC_DEPLOYER,WALLET_ABI,APPROVER_ABI,fingerprint,p256Key} from './phone-signer.mjs';import {checkLimits,limitsWindow} from './limits-public.mjs';
import {buildMigrationPlanV5} from './plan.mjs';import {v5Abi,permissionFromJson} from './abi.mjs';import {kvKey} from './store.mjs';import {callsHash} from './onboard-sponsor.mjs';import {CBV,CBV_GUIDE} from './cb-verified.mjs';
/** t767u: new wallets set the vault's fee slot to Kipurse's ops account so fronted onboarding gas (and any debt) is repaid from AI payments
 *  without another signature. Cap per operation = 0.05 USDC (= the onboarding worst case the sponsor counts, and the network-fee cap). Only
 *  for apps that say they can check it (features:['dues_slot']); older apps get the batch they already know. */
export const DUES_SLOT={to:'0xf14ef5dc4723245866c22c749a0a84afceba0dd9',maxPerOp:50_000n};
export const DUES_SLOT_NOTE={zh:'开户费 0.05 USDC 由启付先垫付，你第一次用 AI 付款时自动扣一次，以后不再扣。',en:'Kipurse fronts the 0.05 USDC account-opening fee. It is taken once, automatically, with your first AI payment, and never again.'};import {clientOf,limiter,ttlCache} from './ratelimit.mjs';
export const CB_FACTORY='0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';
const FACT=parseAbi(['function createAccount(bytes[] owners,uint256 nonce) payable returns (address)','function getAddress(bytes[] owners,uint256 nonce) view returns (address)']);
const AD=parseAbi(['function vaultAddress(address) view returns (address)','function fees() view returns (address)']);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const J=x=>JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v).replace(/</g,'\\u003c');
const usd=a=>{const n=BigInt(a),w=n/1000000n,f=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
export {clientOf};
export function createNewWalletOnboarding({executorFor,enabled,kv,pub,cfg,policy,reg,tenantStart,tenantConfirm,register,base,script,quote,sponsor=null,verified=null,appAttest=null,chainId=8453,ttlMs=30*60e3}){
  // t624u: NEW wallets only — the Base Account must carry Coinbase's on-chain "Verified Account" attestation (Coinbase did the KYC; Kipurse stores nothing).
  // Existing wallets (re-setup, withdraw, stop) are never gated. RPC failure fails closed for new onboarding only.
  // public check endpoint: 20 reads/min per network, answers cached 60 s (verified answers are re-checked at prepare anyway)
  const vLimit=limiter({max:Number(cfg?.rate?.verifiedPerMin??20),windowMs:60e3}),vCache=ttlCache(60e3);
  async function cbv(owner){if(!verified)return {verified:true,reason:'off'};try{return await verified(owner);}catch{return {verified:false,reason:'unavailable'};}}
  const cbvErr=r=>Object.assign(Error(r.reason==='unavailable'?'Coinbase verification check is unavailable; nothing was charged. Try again.':'This Base Account has no Coinbase Verified Account attestation yet.'),{code:r.reason==='unavailable'?'verify_unavailable':'not_verified'});
  const K=id=>kvKey('onbnew',null,id);
  // t621 #7: per-client rate limits for the free (sponsored) setup, on top of once-per-Base-Account and the daily caps (never raised).
  // The client is a salted hash of the IP (raw IPs are not stored). Over the limit: no sponsorship (the Base Account pays in USDC as before).
  const RL={startsPerHour:Number(cfg?.rate?.startsPerHour??10),sponsoredPerDay:Number(cfg?.rate?.sponsoredPerDay??3)};
  const day=()=>new Date().toISOString().slice(0,10),hour=()=>new Date().toISOString().slice(0,13);
  const rlGet=k=>Number(kv.get(k)?.n??0),rlInc=(k,ms)=>kv.put(k,{n:rlGet(k)+1},ms);
  const ipOk=c=>!c||rlGet('rl:spons:'+c+':'+day())<RL.sponsoredPerDay;
  async function start({x,y,single,daily,term,days,owner,client}){p256Key(x,y);
    if(client){const k='rl:start:'+client+':'+hour();if(rlGet(k)>=RL.startsPerHour)throw Object.assign(Error('too many setup attempts from this network; try again in an hour'),{code:'rate_limited'});rlInc(k,2*3600e3);}const expect=owner&&/^0x[0-9a-fA-F]{40}$/.test(String(owner))?getAddress(owner):null;const c=checkLimits({single,daily,term,days:days??90});if(c.error)throw Object.assign(Error(c.detail),{code:c.error});
    const id=randomBytes(12).toString('hex');kv.put(K(id),{x,y,expect,choice:{single:c.single.toString(),daily:c.daily.toString(),term:c.term.toString(),days:c.days},state:'start'},ttlMs);
    return {id,url:`${base()}/onboard/new?id=${id}`,fingerprint:fingerprint(x,y),quote:await quote(expect??'')};}
  async function prepare(id,owner,client,features=[]){const duesSlot=Array.isArray(features)&&features.includes('dues_slot');const o=kv.get(K(id));if(!o)throw Object.assign(Error('unknown or expired'),{code:'unknown'});owner=getAddress(owner);if(o.expect&&o.expect!==owner)throw Object.assign(Error('请用刚才登录的那个 Coinbase 账户'),{code:'owner_mismatch'});
    // t621 #1: idempotent. The APP prepares first, decodes + checks the batch and commits to it (#vh); the page then gets the SAME calls.
    if(o.state==='prepared'&&o.owner===owner&&Array.isArray(o.calls)){const paymaster=o.kind==='new'&&sponsor?.enabled&&o.expect===owner&&sponsor.available(owner)?`${base()}/onboard/new/paymaster?id=${id}`:null;
      return o.kind==='tenant'?{calls:o.calls,wallet:o.wallet,existing:true,owner,chainId,summary:'找到你已有的启付钱包'}:{calls:o.calls,wallet:o.wallet,existing:false,owner,chainId,paymaster,summary:'创建你的启付钱包',vault:o.vault,...(o.duesSlot?{duesSlot:{to:DUES_SLOT.to,maxPerOp:DUES_SLOT.maxPerOp.toString(),note:DUES_SLOT_NOTE}}:{})};}
    // t1086: one user-USDC quote covers opening plus the first phone key. Short balance -> no calls, no charge. Unknown balance does not block here.
    {let funds=null;try{funds=await quote(owner);}catch{funds=null;}
      if(funds&&funds.payerCanPayUSDC===false)throw Object.assign(Error('USDC 不够付开户和这台手机钥匙这一笔，已停止，没有扣钱。'),{code:'needs_usdc'});}
    // t763u (locked): the Coinbase Verified Account attestation is required for EVERY opening, including re-opening an existing wallet. Deposit history never counts.
    const v0=await cbv(owner);if(!v0.verified)throw cbvErr(v0);
    const mine=reg.byOwner(owner)[0];const ch=o.choice;
    if(mine){const t=await tenantStart(mine.wallet,{x:o.x,y:o.y,single:usd(ch.single),daily:usd(ch.daily),term:usd(ch.term),days:ch.days});
      kv.put(K(id),{...o,state:'prepared',kind:'tenant',wallet:mine.wallet,owner,tid:t.id,calls:t.calls??[]},ttlMs);return {calls:t.calls??[],wallet:mine.wallet,existing:true,owner,chainId,summary:'找到你已有的启付钱包'};}
    {const v=v0;
      // anti-renting: one Coinbase attestation opens at most ONE new Kipurse wallet (Coinbase allows 3 addresses per verified person -> max 3)
      if(v.uid){const uk='cbvuid:'+createHash('sha256').update(String(v.uid).toLowerCase()).digest('hex').slice(0,32),oh=createHash('sha256').update(owner.toLowerCase()).digest('hex').slice(0,32);
        const prev=kv.get(uk);if(prev&&prev.o!==oh)throw Object.assign(Error('This Coinbase verification is already used by another Kipurse wallet.'),{code:'verification_in_use'});
        kv.put(uk,{o:oh},10*365*864e5);}}
    const owners=[encodeAbiParameters([{type:'address'}],[owner])];const W=getAddress(await pub.readContract({address:CB_FACTORY,abi:FACT,functionName:'getAddress',args:[owners,0n]}));
    const code=await pub.getCode({address:W});const exists=!!code&&code!=='0x';
    if(exists){const o0=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);if(o0!==owner)throw Object.assign(Error('wallet owner mismatch'),{code:'owner_mismatch'});}
    const vault=getAddress(await pub.readContract({address:cfg.adapter,abi:AD,functionName:'vaultAddress',args:[W]}));const p=policy();
    const ppm=await pub.readContract({address:await pub.readContract({address:cfg.adapter,abi:v5Abi,functionName:'fees'}),abi:v5Abi,functionName:'feePpm'});
    const mn=(a,b)=>(BigInt(a)<BigInt(b)?BigInt(a):BigInt(b)).toString();const now=Number((await pub.getBlock()).timestamp);
    const pl=buildMigrationPlanV5({chainId,wallet:W,owner,adapter:cfg.adapter,trust:cfg.trust,token:cfg.token,manager:cfg.manager,executor:executorFor?executorFor(W):p.executor,guardian:p.guardian,registry:p.registry,headroom:false,
      maxFeePpm:p.maxFeePpm,maxNetworkFee:p.maxNetworkFee,fee:{ppm:String(ppm)},stated:{single:ch.single,daily:ch.daily,term:ch.term,openSingle:mn(p.openSingle,ch.single),openDaily:mn(p.openDaily,ch.daily),verifiedSingle:mn(p.verifiedSingle,ch.single),verifiedDaily:mn(p.verifiedDaily,ch.daily)},
      ...limitsWindow(now,ch.days),salt:BigInt('0x'+randomBytes(8).toString('hex')),revoke:[],zeroReserve:{vault,buffer:0,...(duesSlot?{bundlerFee:DUES_SLOT}:{})}});
    // the SpendPermissionManager must be an OWNER of the wallet, or every spend reverts with Unauthorized() (new wallets start without it)
    const spmOwner=exists&&await pub.readContract({address:W,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[getAddress(cfg.manager)]});
    const a=approverInit({wallet:W,trust:cfg.trust,x:o.x,y:o.y,maxSingle:ch.single,maxDaily:ch.daily,version:cfg.approverVersion==='v3'?'v3':'v2'});
    const calls=[...(exists?[]:[{to:CB_FACTORY,value:'0x0',data:encodeFunctionData({abi:FACT,functionName:'createAccount',args:[owners,0n]})}]),
      {to:DETERMINISTIC_DEPLOYER,value:'0x0',data:a.deployData},...(spmOwner?[]:[{to:W,value:'0x0',data:encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[getAddress(cfg.manager)]})}]),{to:W,value:'0x0',data:pl.walletExecuteBatch.data},{to:W,value:'0x0',data:encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[a.address]})}];
    kv.put(K(id),{...o,state:'prepared',kind:'new',wallet:W,owner,vault,approver:a.address,permission:pl.permission,fromBlock:String(await pub.getBlockNumber()),
      callsHash:callsHash(calls),calls,allowed:[CB_FACTORY,DETERMINISTIC_DEPLOYER,W],duesSlot},ttlMs);
    // sponsored only for the signed-in owner's FIRST wallet, while caps allow (otherwise null: the Base Account pays, as before)
    const paymaster=sponsor?.enabled&&o.expect===owner&&sponsor.available(owner)&&ipOk(client)?`${base()}/onboard/new/paymaster?id=${id}`:null;
    if(paymaster&&client)rlInc('rl:spons:'+client+':'+day(),2*86400e3);
    return {calls,wallet:W,existing:false,owner,chainId,paymaster,summary:'创建你的启付钱包',vault,...(duesSlot?{duesSlot:{to:DUES_SLOT.to,maxPerOp:DUES_SLOT.maxPerOp.toString(),note:DUES_SLOT_NOTE}}:{})};}
  async function confirm(id){const o=kv.get(K(id));if(!o||o.state==='start')return {ok:false,detail:'not prepared'};
    if(o.state==='done')return {ok:true,wallet:o.wallet,owner:o.owner};
    if(o.kind==='tenant'){const r=await tenantConfirm(o.wallet,o.tid);if(r.ok)kv.put(K(id),{...o,state:'done'},ttlMs);return {...r,wallet:o.wallet,owner:o.owner};}
    const code=await pub.getCode({address:o.approver});if(!code||code==='0x')return {ok:false,detail:'not on chain yet'};
    const [x,y,w]=await Promise.all(['x','y','wallet'].map(f=>pub.readContract({address:o.approver,abi:APPROVER_ABI,functionName:f})));
    if(BigInt(x)!==BigInt(o.x)||BigInt(y)!==BigInt(o.y)||getAddress(w)!==getAddress(o.wallet))return {ok:false,detail:'approver mismatch'};
    if(!await pub.readContract({address:o.wallet,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[o.approver]}))return {ok:false,detail:'not an owner yet'};if(!await pub.readContract({address:o.wallet,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[getAddress(cfg.manager)]}))return {ok:false,detail:'spend permission manager is not an owner'};
    const o0=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:o.wallet,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);if(o0!==getAddress(o.owner))return {ok:false,detail:'owner mismatch'};
    if(!await pub.readContract({address:cfg.manager,abi:v5Abi,functionName:'isValid',args:[permissionFromJson(o.permission)]}))return {ok:false,detail:'permission not valid yet'};
    await register({wallet:o.wallet,owner:o.owner,vault:o.vault,approver:o.approver,x:o.x,y:o.y,choice:o.choice,permission:o.permission,fromBlock:Number(o.fromBlock)});try{sponsor?.markDone(id,o.owner,o.wallet);}catch{}
    kv.put(K(id),{...o,state:'done'},ttlMs);return {ok:true,wallet:o.wallet,owner:o.owner,siri:true};}
  const status=id=>{const o=kv.get(K(id));return o?{state:o.state,wallet:o.state==='done'?o.wallet:null}:{state:'expired'};};
  // the fee card must say who really pays: same condition prepare() uses to attach the paymaster
  // t796 M4: mode 'sponsor' = Kipurse pays the first setup ONLY for a genuine-app attestation; without one the user still opens the wallet (pays the fee), never locked out
  const attestOk=o=>!appAttest||!['sponsor','require'].includes(appAttest.mode)||o.attested===true;
  const willSponsor=o=>{try{return !!(sponsor?.enabled&&attestOk(o)&&o.expect&&!reg.byOwner(o.expect)[0]&&sponsor.available(o.expect));}catch{return false;}};
  const feeCard=(o,t)=>willSponsor(o)
    ?`<div class=c id=fee data-sponsored=1><b>${t('开通免费：这一笔手续费由 Kipurse 代付，你付 $0','Free setup: Kipurse pays this one-time network fee, you pay $0')}</b><div class=m>${t('你只需要签一次名（Face ID），不花一分钱。之后 AI 付款的手续费从你的钱包 USDC 里扣。','You only sign once (Face ID); no money leaves your account. Later AI payments pay their own network fee in USDC from your wallet.')}</div></div>`
    :`<div class=c id=fee data-sponsored=0><b>${t('手续费只有一笔，由你的 Base Account 用 USDC 支付，约 $0.03，不需要 ETH','One network fee (~$0.03), paid in USDC by your Base Account. No ETH needed.')}</b><div class=m>${t('Kipurse 不出钱、不代付。','Kipurse pays nothing.')}</div></div>`;
  function page(id,o,nonce,lang){const ch=o.choice,t=X(lang);return `<!doctype html><html lang=${lang}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${t('开通 Kipurse','Set up Kipurse')}</title>
<style>body{margin:0;background:#F2F2F7;color:#111;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}.w{max-width:480px;margin:0 auto;padding:22px 18px 40px}.c{background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0}.t{font-size:24px;font-weight:700;margin:10px 0}.fp{font:700 26px ui-monospace,monospace;text-align:center;padding:10px;background:#EEF;border-radius:12px}.m{color:#666;font-size:14px}button{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:10px;background:#5B4CF0;color:#fff}</style>
<div style="background:#c00;color:#fff;text-align:center;font-weight:700;padding:8px">${t('Base 主网','Base Mainnet')}</div><div class=w><div class=t>${t('开通 Kipurse：一次确认','Set up Kipurse: one signature')}</div>
<p>${t('核对：这串字符必须和 App 里显示的完全一样。','Check: this code must exactly match the one in the app.')}</p><div class=fp>${esc(fingerprint(o.x,o.y))}</div>
<div class=c><b>${t('一笔确认同时完成','One signature does all of this')}</b><ul><li>${t(`AI 上限：每笔 ${usd(ch.single)} · 每天 ${usd(ch.daily)} · 总额 ${usd(ch.term)} USDC · ${esc(ch.days)} 天`,`AI limits: ${usd(ch.single)} per payment · ${usd(ch.daily)} per day · ${usd(ch.term)} USDC total · ${esc(ch.days)} days`)}</li><li>${t('这台 iPhone：Face ID 批准、Siri 付款','This iPhone: Face ID approvals and Siri payments')}</li><li>${t('没有钱包就自动创建（钱包只属于你的 Base Account）','Creates your wallet if you have none (owned only by your Base Account)')}</li></ul><div class=m id=sum></div></div>
${feeCard(o,t)}
<button id=go>${t('连接 Base Account 并确认','Connect Base Account and sign')}</button><p class=m id=st></p></div>
<script type="application/json" id=kp-data>${J({mode:'enroll',id,owner:null,chainId,calls:[]})}</script><script nonce="${nonce}" src="/onboard/new.js"></script></html>`;}
  async function handle(req,res,u,{readBody}){const p=u.pathname;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store'});res.end(J(o));};
    if(!enabled){json(404,{error:'onboard_disabled'});return true;}const nonce=randomBytes(12).toString('base64url');
    try{if(p==='/onboard/new.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(script());return true;}
      if(p==='/onboard/new/start'&&req.method==='POST'){const b=await readBody(req);
        /* App Attest (t629): mode 'off' | 'log' (verify + record, never block) | 'require' (no valid attestation -> refused) */
        let att=null;if(appAttest&&appAttest.mode!=='off'){const r=b?.attest?appAttest.verify({keyId:b.attest.keyId,attestation:b.attest.attestation,x:String(b.x),y:String(b.y)}):{ok:false,reason:'missing'};
          att=r;try{appAttest.log?.('app_attest',{ok:r.ok,reason:r.reason??null,env:r.env??null,mode:appAttest.mode});}catch{}
          if(!r.ok&&appAttest.mode==='require'){json(403,{error:'app_attest_required',detail:'Please use the official Kipurse app from the App Store on an iPhone. 请用 App Store 上的正版启付 App（iPhone）开通。'});return true;}}
        const out=await start({x:String(b.x),y:String(b.y),single:b.single,daily:b.daily,term:b.term,days:b.days,owner:b.owner,client:clientOf(req)});
        if(out?.id){const o=kv.get(K(out.id));if(o)kv.put(K(out.id),{...o,attested:!!att?.ok},ttlMs);}json(200,out);return true;}
      if(p==='/onboard/new/prepare'&&req.method==='POST'){const b=await readBody(req);json(200,await prepare(String(b.id??''),String(b.owner??''),clientOf(req),Array.isArray(b.features)?b.features.map(String).slice(0,8):[]));return true;}
      if(p==='/onboard/new/verified'&&req.method==='GET'){const ow=String(u.searchParams.get('owner')??'');if(!/^0x[0-9a-fA-F]{40}$/.test(ow)){json(400,{error:'bad_owner'});return true;}
        if(!vLimit(clientOf(req))){json(429,{error:'rate_limited',verified:false,reason:'rate_limited',guide:CBV_GUIDE});return true;}
        const key=getAddress(ow);let r=vCache.get(key);if(!r){r=await cbv(key);if(r.reason!=='unavailable')vCache.set(key,r);}json(200,{verified:!!r.verified,reason:r.reason,schema:CBV.schema,attester:CBV.attester,verifyUrl:CBV.verifyUrl,guide:CBV_GUIDE});return true;}
      if(p==='/onboard/new/quote'&&req.method==='GET'){const ow=String(u.searchParams.get('owner')??'');const q=await quote(ow);
        if(sponsor?.enabled&&ow&&sponsor.available(ow))Object.assign(q,{sponsoredByKipurse:true,sponsored:true});else q.sponsored=false;json(200,q);return true;}
      if(p==='/onboard/new/paymaster'){const cors={'access-control-allow-origin':'*','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','cache-control':'no-store'};
        if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return true;}
        if(req.method!=='POST'||!sponsor?.enabled){res.writeHead(404,{...cors,'content-type':'application/json'});res.end(J({error:'not_found'}));return true;}
        const b=await readBody(req);const r=await sponsor.rpc(String(u.searchParams.get('id')??''),b,{lang:String(req.headers?.['accept-language']??'zh').split(',')[0]});res.writeHead(200,{...cors,'content-type':'application/json'});res.end(J(r));return true;}
      if(p==='/onboard/new/status'&&req.method==='GET'){json(200,status(String(u.searchParams.get('id')??'')));return true;}
      if((p==='/onboard/new/confirm'||p==='/onboard/confirm')&&req.method==='POST'){const b=await readBody(req);json(200,await confirm(String(b.id??'')));return true;}
      if(p==='/onboard/new'&&req.method==='GET'){const id=String(u.searchParams.get('id')??'');const o=kv.get(K(id));
        res.writeHead(o?200:404,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer',
          'content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; form-action 'none'; frame-ancestors 'none'`});
        {const lang=langOf(req,u);res.end(o?page(id,o,nonce,lang):`<!doctype html><html lang=${lang}><meta charset=utf-8><p>${X(lang)('已过期，请回 App 重新开始。','Expired. Go back to the app and start again.')}</p></html>`);}return true;}
      json(404,{error:'not_found'});return true;}catch(e){json(400,{error:e.code??'failed',detail:String(e.message).slice(0,200)});return true;}}
  /** Combined sign-in + setup page: after the SIWE signature proved the owner, bind this pending setup to him (only once, only while unprepared). */
  function bindOwner(id,owner){const o=kv.get(K(id));if(!o||o.state!=='start')return false;const A=getAddress(owner);if(o.expect&&o.expect!==A)return false;kv.put(K(id),{...o,expect:A},ttlMs);return true;}
  const sponsorable=id=>{const o=kv.get(K(id));return !!o&&willSponsor(o);};
  return {handle,start,prepare,confirm,status,bindOwner,sponsorable,has:id=>!!kv.get(K(id))};}
