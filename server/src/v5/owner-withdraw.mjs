// SPDX-License-Identifier: AGPL-3.0-only
// ONE-TAP "WITHDRAW ALL" (mainnet). Moves the wallet's whole USDC balance to ONE fixed place: the wallet's own owner, i.e. the
// Base Account registered for this wallet (re-checked on chain with isOwnerAddress before every quote). No request field can
// change the destination: every input is ignored except the plan id. The owner signs with HIS Base Account, so it works whether
// AI payments are paused, expired or revoked (it never uses the AI spend permission). Network fee: paid by the owner's own Base
// Account and shown first; Kipurse pays nothing. This server holds no key that can do this.
import {createSanctions} from './sanctions.mjs';
import {langOf,X} from './i18n.mjs';import {randomBytes} from 'node:crypto';
import {encodeFunctionData,decodeFunctionData,getAddress,parseAbi} from 'viem';
const J=x=>JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=a=>{const n=BigInt(a),w=n/1000000n,f=(n%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
const short=a=>a.slice(0,6)+'…'+a.slice(-4);
export const WITHDRAW_WALLET_ABI=parseAbi(['function execute(address target, uint256 value, bytes data)','function isOwnerAddress(address account) view returns (bool)']);
export const WITHDRAW_VAULT_ABI=parseAbi(['function sweep() returns (uint256)','function unreserved() view returns (uint256)']);
export const WITHDRAW_ERC20_ABI=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address to, uint256 amount) returns (bool)']);
const FEED_ABI=parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
export const WITHDRAW_OVERHEAD_GAS=150_000n;
export const WITHDRAW_SWEEP_GAS=80_000n; // vault.sweep() inside the same batch // Base Account user operation overhead on top of the inner call
/** The ONE call the owner's Base Account sends: wallet.execute(USDC, 0, transfer(owner, amount)). */
// With a fee reserve (the wallet's own gas vault): first wallet.execute(vault, 0, sweep()) brings the reserve back into the wallet
// (msg.sender == wallet, so nothing is kept back), then the transfer moves wallet + reserve. Both in ONE atomic batch.
export function withdrawCalls({wallet,owner,token,amount,vault=null}){const a=BigInt(amount);if(a<=0n)throw Object.assign(Error('nothing to withdraw'),{code:'empty'});
  const ex=(t,d)=>({to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:WITHDRAW_WALLET_ABI,functionName:'execute',args:[getAddress(t),0n,d]})});
  const inner=encodeFunctionData({abi:WITHDRAW_ERC20_ABI,functionName:'transfer',args:[getAddress(owner),a]});
  return [...(vault?[ex(vault,encodeFunctionData({abi:WITHDRAW_VAULT_ABI,functionName:'sweep'}))]:[]),ex(token,inner)];}
/** t752 wallet-pays shape: [sweep?] + wallet pays `fee` USDC to the fixed fee address + the rest to the owner. */
export const WITHDRAW_FEE_TRANSFER_GAS=40_000n;export const WITHDRAW_MAX_WALLET_FEE=250_000n; // 0.25 USDC hard ceiling = sponsor per-op cap (same constant in the page script)
/** t763u: fee >= real cost. Realistic gas of this op (measured 248,864) x1.2 = 300k, charged with 1.4x price headroom; the sponsor re-checks at 1.1x. */
export const WITHDRAW_REAL_GAS=300_000n;export const WITHDRAW_PRICE_HEADROOM_PCT=140n;
export function withdrawCallsWalletPays({wallet,owner,token,amount,fee,feeTo,vault=null}){const a=BigInt(amount),f=BigInt(fee);if(f<=0n||f>WITHDRAW_MAX_WALLET_FEE||a<=f)throw Object.assign(Error('fee'),{code:'fee'});
  const ex=(t,d)=>({to:getAddress(wallet),value:'0x0',data:encodeFunctionData({abi:WITHDRAW_WALLET_ABI,functionName:'execute',args:[getAddress(t),0n,d]})});
  const tr=(to,n)=>ex(token,encodeFunctionData({abi:WITHDRAW_ERC20_ABI,functionName:'transfer',args:[getAddress(to),n]}));
  return [...(vault?[ex(vault,encodeFunctionData({abi:WITHDRAW_VAULT_ABI,functionName:'sweep'}))]:[]),tr(feeTo,f),tr(owner,a-f)];}
/** Independent check for the wallet-pays shape: only the owner and the fixed fee address, fee <= ceiling. -> null | reason */
export function checkWalletPaysCalls(calls,{wallet,owner,token,feeTo,vault=null}){if(!feeTo)return 'no_fee_address';
  if(!Array.isArray(calls)||calls.length!==(vault?3:2))return 'shape';const dec=c=>{if(getAddress(c.to)!==getAddress(wallet)||BigInt(c.value??0)!==0n)return null;try{const o=decodeFunctionData({abi:WITHDRAW_WALLET_ABI,data:c.data});return o.functionName==='execute'&&o.args[1]===0n?o:null;}catch{return null;}};
  const xs=calls.map(dec);if(xs.some(x=>!x))return 'wrong_target';const off=vault?1:0;
  if(vault){if(getAddress(xs[0].args[0])!==getAddress(vault))return 'not_sweep';try{if(decodeFunctionData({abi:WITHDRAW_VAULT_ABI,data:xs[0].args[2]}).functionName!=='sweep')return 'not_sweep';}catch{return 'not_sweep';}}
  const tx=x=>{if(getAddress(x.args[0])!==getAddress(token))return null;try{const t=decodeFunctionData({abi:WITHDRAW_ERC20_ABI,data:x.args[2]});return t.functionName==='transfer'?t.args:null;}catch{return null;}};
  const f=tx(xs[off]),o=tx(xs[off+1]);if(!f||!o)return 'not_transfer';if(getAddress(f[0])!==getAddress(feeTo))return 'fee_not_to_fee_address';if(f[1]<=0n||f[1]>WITHDRAW_MAX_WALLET_FEE)return 'fee_too_high';
  if(getAddress(o[0])!==getAddress(owner))return 'destination_not_owner';return null;}
/** Independent check (server before answering, tests, and the same rule in the app): the batch may ONLY pay the owner. */
export function checkWithdrawCalls(calls,{wallet,owner,token,vault=null}){
  if(!Array.isArray(calls)||calls.length<1||calls.length>2||(calls.length===2&&!vault))return 'one_call_only';
  if(calls.length===2){const s=calls[0];if(getAddress(s.to)!==getAddress(wallet)||BigInt(s.value??0)!==0n)return 'wrong_target';let o;try{o=decodeFunctionData({abi:WITHDRAW_WALLET_ABI,data:s.data});}catch{return 'not_execute';}
    if(o.functionName!=='execute'||getAddress(o.args[0])!==getAddress(vault)||o.args[1]!==0n)return 'not_sweep';try{if(decodeFunctionData({abi:WITHDRAW_VAULT_ABI,data:o.args[2]}).functionName!=='sweep')return 'not_sweep';}catch{return 'not_sweep';}}
  const c=calls[calls.length-1];
  if(getAddress(c.to)!==getAddress(wallet)||BigInt(c.value??0)!==0n)return 'wrong_target';
  let o,i;try{o=decodeFunctionData({abi:WITHDRAW_WALLET_ABI,data:c.data});}catch{return 'not_execute';}if(o.functionName!=='execute')return 'not_execute';
  const [target,value,data]=o.args;if(getAddress(target)!==getAddress(token)||value!==0n)return 'not_usdc';
  try{i=decodeFunctionData({abi:WITHDRAW_ERC20_ABI,data});}catch{return 'not_transfer';}if(i.functionName!=='transfer')return 'not_transfer';
  if(getAddress(i.args[0])!==getAddress(owner))return 'destination_not_owner';return null;}
export function createOwnerWithdraw({pub,wallet,owner,token,feed,vault=null,chainId=8453,script,now=()=>Date.now(),pollMs=3000,pollTries=60,sanctions,feeTo=null,walletPays=null}){
  // walletPays: {available:()=>bool, register:async(planId,{owner,wallet,calls,reimburse})=>paymasterUrl|null}; feeTo: fixed fee address. Both or nothing.
  const WP=feeTo&&walletPays?{to:getAddress(feeTo),...walletPays}:null;
  // Withdrawal ALWAYS goes to the owner's own Base Account; refused only if that exact address is on the OFAC SDN list.
  const SC=sanctions??createSanctions({pub:chainId===8453?pub:null,chainId});
  const W=getAddress(wallet),O=getAddress(owner),T=getAddress(token);const prepared=new Map(),hits=new Map(),done=new Map();let pend=null;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const bal=a=>pub.readContract({address:T,abi:WITHDRAW_ERC20_ABI,functionName:'balanceOf',args:[a]});
  async function quote(){
    if(!await pub.readContract({address:W,abi:WITHDRAW_WALLET_ABI,functionName:'isOwnerAddress',args:[O]}))throw Object.assign(Error('the registered Base Account is not an owner of this wallet on chain'),{code:'owner_mismatch'});
    const inWallet=await bal(W);let reserve=0n,V=null;
    if(vault){try{if(await pub.getCode({address:getAddress(vault)}).then(c=>c&&c!=='0x')){reserve=await pub.readContract({address:getAddress(vault),abi:WITHDRAW_VAULT_ABI,functionName:'unreserved'});if(reserve>0n)V=getAddress(vault);}}catch{reserve=0n;V=null;}}
    const amount=inWallet+reserve;let feeUsdc=null,gas=null;
    if(amount>0n){const calls=withdrawCalls({wallet:W,owner:O,token:T,amount:inWallet>0n?inWallet:amount});
      try{gas=(inWallet>0n?await pub.estimateGas({account:O,to:W,data:calls[calls.length-1].data}):60_000n)+WITHDRAW_OVERHEAD_GAS+(V?WITHDRAW_SWEEP_GAS:0n);const [gp,rd]=await Promise.all([pub.getGasPrice(),pub.readContract({address:feed,abi:FEED_ABI,functionName:'latestRoundData'})]);
        const wei=gas*gp*3n/2n+1_000_000_000_000n;feeUsdc=wei*BigInt(rd[1])/10n**20n;if(feeUsdc<1000n)feeUsdc=1000n;}catch{feeUsdc=null;}}
    const ob=await bal(O).catch(()=>null);const canFront=feeUsdc!==null&&ob!==null&&ob>=feeUsdc;
    // t606u: exit is NEVER blocked; if the Base Account can't front the fee in USDC we say so plainly (and never ask for ETH).
    const gasNote=canFront||feeUsdc===null?null:{zh:`提醒：取回的手续费约 ${usd(feeUsdc)} USDC，要由你的 Base Account 先用 USDC 付。现在你的 Base Account 里没有这点 USDC，Coinbase 可能付不了。请先从 Coinbase App 往你的 Base Account（Base 网络）转一点 USDC（比如 0.05），再点取回。你的钱一直安全地在钱包里。不要为此购买 ETH。`,en:`Heads-up: the withdrawal network fee (about ${usd(feeUsdc)} USDC) is paid in USDC by your Base Account first. It has no USDC right now, so Coinbase may not be able to pay it. Send a little USDC (e.g. 0.05, Base network) to your Base Account from the Coinbase app, then tap withdraw. Your money stays safe in the wallet. Don’t buy ETH for this.`};
    let wp=null;if(WP&&feeUsdc!==null&&gas!==null&&gas>0n){let g=feeUsdc*(gas+WITHDRAW_FEE_TRANSFER_GAS)/gas+1n;const sane=(feeUsdc*WITHDRAW_REAL_GAS*WITHDRAW_PRICE_HEADROOM_PCT+gas*100n-1n)/(gas*100n);if(sane>g)g=sane;if(g<1000n)g=1000n;
      // t763u: anything Kipurse fronted for this wallet (onboarding gas, failed-op gas debt) is collected in the same batch
      let due=0n;try{due=BigInt(WP.dues?.()??0n);}catch{due=0n;}if(due<0n)due=0n;let f=g+due;if(f>WITHDRAW_MAX_WALLET_FEE)f=WITHDRAW_MAX_WALLET_FEE;const dueTaken=f-g>0n?f-g:0n;
      if(g<=WITHDRAW_MAX_WALLET_FEE&&amount>f&&(()=>{try{return !!WP.available();}catch{return false;}})())wp={available:true,fee:f.toString(),gasFee:g.toString(),dues:dueTaken.toString(),receive:(amount-f).toString(),feeTo:WP.to};}
    return {wallet:W,to:O,token:T,amount:amount.toString(),inWallet:inWallet.toString(),reserve:reserve.toString(),vault:V,feeUsdc:feeUsdc===null?null:feeUsdc.toString(),gas:gas===null?null:gas.toString(),feePaidBy:wp?'wallet':'owner_base_account',ownerUSDC:ob===null?null:ob.toString(),ownerCanPayUSDC:canFront,gasNote:wp?null:gasNote,walletPays:wp,neverBlocked:true};}
  async function prepare(opts={}){{const h=await SC.check(owner);if(h)throw Object.assign(Error('你的收款账户地址在美国财政部 OFAC 制裁名单上，不能取回到这个地址。钱没有动。 / Your receiving address is on the US Treasury OFAC sanctions list; withdrawal to it is not allowed. No money moved.'),{code:'SANCTIONED_ADDRESS'});}const q=await quote();if(BigInt(q.amount)===0n)throw Object.assign(Error('余额是 0，没有可取回的 USDC'),{code:'empty'});
    if(prepared.size>20)prepared.clear();const id=randomBytes(16).toString('hex');
    // t752: wallet-pays only when the page asks for it (new page script) AND the sponsor registers this exact batch; else the old shape.
    if(opts.feeFrom==='wallet'&&q.walletPays){const f=BigInt(q.walletPays.fee);const calls=withdrawCallsWalletPays({wallet:W,owner:O,token:T,amount:q.amount,fee:f,feeTo:WP.to,vault:q.vault});
      const bad=checkWalletPaysCalls(calls,{wallet:W,owner:O,token:T,feeTo:WP.to,vault:q.vault});if(bad)throw Object.assign(Error(bad),{code:bad});
      let paymaster=null;try{paymaster=await WP.register(id,{owner:O,wallet:W,calls,reimburse:BigInt(q.walletPays.gasFee)});}catch{paymaster=null;}
      if(paymaster){const plan={id,owner:O,wallet:W,token:T,vault:q.vault,chainId,amount:q.amount,inWallet:q.inWallet,reserve:q.reserve,feeUsdc:q.feeUsdc,feeFrom:'wallet',fee:f.toString(),gasFee:q.walletPays.gasFee,dues:q.walletPays.dues,receive:(BigInt(q.amount)-f).toString(),feeTo:WP.to,paymaster,calls};
        prepared.set(id,{at:now(),amount:BigInt(q.amount),receive:BigInt(q.amount)-f,ownerBefore:await bal(O),plan});return plan;}}
    const calls=withdrawCalls({wallet:W,owner:O,token:T,amount:q.amount,vault:q.vault});const bad=checkWithdrawCalls(calls,{wallet:W,owner:O,token:T,vault:q.vault});if(bad)throw Object.assign(Error(bad),{code:bad});
    const plan={id,owner:O,wallet:W,token:T,vault:q.vault,chainId,amount:q.amount,inWallet:q.inWallet,reserve:q.reserve,feeUsdc:q.feeUsdc,feeFrom:'owner',calls};
    prepared.set(id,{at:now(),amount:BigInt(q.amount),ownerBefore:await bal(O),plan});return plan;}
  /** The exact plan the app already checked on the phone (by id; nothing in it can be changed by the caller). */
  function plan(id){const e=prepared.get(String(id??''));return e&&now()-e.at<30*60e3?e.plan:null;}
  /** Done when the wallet's USDC dropped by >= the planned amount and the owner received it. */
  async function confirm(id){if(done.has(id))return done.get(id);const e=prepared.get(id);if(!e)return {ok:false,error:'unknown_plan'};const [w,o]=await Promise.all([bal(W),bal(O)]);
    const vr=e.plan?.vault&&BigInt(e.plan.reserve??0)>0n?await pub.readContract({address:e.plan.vault,abi:WITHDRAW_VAULT_ABI,functionName:'unreserved'}).catch(()=>null):0n;
    // the owner may pay the network fee in USDC from the same account, so judge by the wallet side: wallet emptied and the reserve swept
    if(o-e.ownerBefore>=(e.receive??e.amount)||(w===0n&&vr!==null&&(vr===0n||vr<BigInt(e.plan.reserve)))){prepared.delete(id);if(pend?.id===id)pend=null;if(e.plan?.feeFrom==='wallet'&&BigInt(e.plan.dues??0)>0n){try{WP?.paid?.(BigInt(e.plan.dues));}catch{}}const r={ok:true,amount:e.amount.toString(),received:(e.receive??e.amount).toString(),fee:e.plan?.fee??null,feeFrom:e.plan?.feeFrom??'owner',to:O,walletLeft:w.toString()};if(done.size>50)done.clear();done.set(id,r);return r;}return {ok:false};}
  const limited=ip=>{const n=now(),h=hits.get(ip)??[0,n];if(n-h[1]>60000){h[0]=0;h[1]=n;}h[0]++;hits.set(ip,h);return h[0]>20;};
  const shell=(inner,nonce,lang='zh')=>`<!doctype html><html lang=${lang}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${X(lang)('全部取回','Withdraw everything')}</title>
<style>:root{--a:#5B4CF0;--bg:#F2F2F7;--card:#fff;--t:#111;--s:#6b6b78;color-scheme:light dark}@media(prefers-color-scheme:dark){:root{--a:#8B7CFF;--bg:#000;--card:#1c1c1e;--t:#f5f5f7;--s:#9a9aa5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:17px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.w{max-width:460px;margin:0 auto;padding:24px 20px 40px}
.t{font-size:26px;font-weight:700;margin:6px 0 4px}.s{color:var(--s);margin:0 0 12px}.c{background:var(--card);border-radius:18px;padding:6px 16px;margin:12px 0}.row{display:flex;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid rgba(128,128,128,.2)}.row:last-child{border:0}
.n{font-weight:600;text-align:right}button,a.b{display:block;width:100%;border:0;border-radius:14px;padding:15px;font-size:18px;font-weight:600;margin-top:12px;cursor:pointer;text-align:center;text-decoration:none}
.p{background:var(--a);color:#fff}.g{background:rgba(91,76,240,.12);color:var(--a)}.m{color:var(--s);font-size:14px}.e{color:#9a5b00;font-weight:600}
.kc{border-radius:16px;padding:14px 16px;margin:12px 0;background:var(--card)}.kc.warn{background:rgba(255,159,10,.14)}.kc.ok{background:rgba(52,199,89,.16)}.kt{font-weight:700;margin-bottom:4px}.kc p{margin:6px 0}.safe{color:#0B6E4F;font-weight:600}.addr{font:15px ui-monospace,Menlo,monospace;word-break:break-all;background:rgba(128,128,128,.12);border-radius:10px;padding:10px;margin:8px 0}.kc button{margin-top:8px;padding:12px;font-size:16px}</style>
<div style="background:#0B6E4F;color:#fff;text-align:center;font-weight:600;padding:8px;font-size:14px">${X(lang)('Base 主网','Base Mainnet')}</div><div class=w>${inner}</div>${nonce?`<script nonce="${nonce}" src="/owner/withdraw.js"></script>`:''}</html>`;
  async function handle(req,res,u,{readBody,ip}){const p=u.pathname;if(p!=='/owner/withdraw'&&!p.startsWith('/owner/withdraw/')&&p!=='/owner/withdraw.js')return false;
    const json=(c,o)=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(J(o));};
    if(limited(ip??'')){json(429,{error:'slow_down'});return true;}
    if(p==='/owner/withdraw.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(script());return true;}
    if(p==='/owner/withdraw'&&req.method==='GET'){const lang=langOf(req,u),t=X(lang);const nonce=randomBytes(12).toString('base64url');
      const H={'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer','x-content-type-options':'nosniff',
        'content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; img-src data:; form-action 'none'; frame-ancestors 'none'`};
      let q;try{q=await quote();}catch(e){res.writeHead(503,H);res.end(shell(`<div class=t>${t('暂时不能取回','Can’t withdraw right now')}</div><p class=e>${esc(e.code==='owner_mismatch'?t('链上的钱包主人和登记的不一致，为了安全已停止。','The wallet owner on chain doesn’t match our records, so we stopped for safety.'):t('暂时读不到链上余额，请稍后再试。','Can’t read the on-chain balance right now. Please try again later.'))}</p><a class="b g" href="kipurse://done">${t('回到 Kipurse','Back to Kipurse')}</a>`,null,lang));return true;}
      res.writeHead(200,H);
      if(BigInt(q.amount)===0n){res.end(shell(`<div class=t>${t('没有可取回的钱','Nothing to withdraw')}</div><p class=s>${t('钱包里的 USDC 余额是 0。','The wallet’s USDC balance is 0.')}</p><a class="b g" href="kipurse://done">${t('回到 Kipurse','Back to Kipurse')}</a>`,null,lang));return true;}
      const row=(k,v)=>`<div class=row><span>${k}</span><span class=n>${esc(v)}</span></div>`;
      res.end(shell(`<div class=t>${t('取回到我的账户','Withdraw to my account')}</div><p class=s>${t('点下面的按钮，在弹出的 Coinbase 窗口里点确认，再刷一下 Face ID 就好。','Tap the button below, confirm in the Coinbase window, then use Face ID.')}</p>
<div class=c>${row(t('金额','Amount'),usd(q.amount)+' USDC')}${row(t('从','From'),t('你的启付钱包（'+short(q.wallet)+'）','Your Kipurse wallet ('+short(q.wallet)+')'))}${row(t('转到','To'),t('你的 Base 账户（'+short(q.to)+'）','Your Base Account ('+short(q.to)+')'))}${q.walletPays?row(t('你会收到','You receive'),usd(q.walletPays.receive)+' USDC')+row(t('手续费','Network fee'),t('约 '+usd(q.walletPays.fee)+' USDC，从钱包里扣','About '+usd(q.walletPays.fee)+' USDC, taken from the wallet')):row(t('预计手续费','Estimated network fee'),q.feeUsdc?t('约 '+usd(q.feeUsdc)+' 美元，用 USDC 付，你自己付，不需要 ETH','About $'+usd(q.feeUsdc)+', paid by you in USDC, no ETH needed'):t('确认时显示','Shown when you confirm'))}</div>
<p class=safe>${t('钱一直在你的钱包里，只有你自己能取回。','Your money stays in your wallet until you take it out yourself.')}</p>
<p class=m>${t('确认时请用这个钱包的主人账户 '+short(q.to)+' 登录 Coinbase。只能转到这个账户，别人改不了。Kipurse 不收也不垫手续费。','In the Coinbase window, sign in with this wallet’s owner account '+short(q.to)+'. It can only go to that account; nobody can change that. Kipurse neither charges nor pays the network fee.')}</p>
${!q.walletPays&&q.ownerCanPayUSDC===false&&q.feeUsdc?`<div class="kc warn" id=kpw-fee><div class=kt>${t('先准备一点手续费','First, add a little for the fee')}</div><p>${t('取回要付约 '+usd(q.feeUsdc)+' USDC 的手续费，由你的 Base 账户 '+short(q.to)+' 来付。它现在的 USDC 不够。','The network fee is about '+usd(q.feeUsdc)+' USDC, paid by your Base Account '+short(q.to)+'. It doesn’t have enough USDC right now.')}</p><p>${t('从 Coinbase App 往这个账户转 0.05 USDC（选 Base 网络）就够了。点确认取回时会显示完整地址，可以一键复制。','Send 0.05 USDC (Base network) to that account from the Coinbase app. Tap Confirm withdrawal to see the full address and copy it.')}</p></div>`:''}<div id=kpw-box></div>
<button class=p id=go data-plan="${esc(u.searchParams.get('plan')??'')}">${t('确认取回','Confirm withdrawal')}</button><a class="b g" href="kipurse://done?withdraw=cancel">${t('取消','Cancel')}</a><p class=m id=st></p>`,nonce,lang));return true;}
    if(req.method!=='POST'){json(405,{error:'method'});return true;}
    const b=await readBody(req);
    try{
      if(p==='/owner/withdraw/prepare'){json(200,await prepare({feeFrom:b?.feeFrom==='wallet'?'wallet':'owner'}));return true;}   // only feeFrom is read: destinations (owner, fixed fee address) are server-fixed
      if(p==='/owner/withdraw/quote'){json(200,await quote());return true;}   // public chain data only (balance, owner, fee)
      if(p==='/owner/withdraw/plan'){const pl=plan(b?.id);json(pl?200:404,pl??{error:'unknown_plan'});return true;}
      if(p==='/owner/withdraw/confirm'){json(200,await confirm(String(b?.id??'')));return true;}
      if(p==='/owner/withdraw/submitted'){const id=String(b?.id??'');if(!prepared.has(id)){json(200,{ok:false});return true;}pend={id,since:Math.floor(now()/1000),failed:false};
        (async()=>{for(let i=0;i<pollTries;i++){await sleep(pollMs);try{if((await confirm(id)).ok)return;}catch{}}if(pend?.id===id)pend.failed=true;})();json(200,{ok:true});return true;}
      json(404,{error:'not_found'});return true;
    }catch(e){json(400,e.code==='empty'?{error:'empty'}:{error:e.code??'failed',detail:String(e.message).replace(/\d[\d.,]*\s*(USDC|ETH|USD)/gi,'').slice(0,200)});return true;}}   // t796 M3: no server detail (no balance or chain state) in errors
  const pending=()=>pend&&(now()/1000-pend.since<1800)?{...pend}:null;
  return {handle,quote,prepare,plan,confirm,pending,forget:()=>{prepared.clear();done.clear();pend=null;hits.clear();}};}
