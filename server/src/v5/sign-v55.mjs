// SPDX-License-Identifier: AGPL-3.0-only
// t1250 (decision 119): the owner's V5.5 signing flows, the same proven way as V5.4 (createDeployV54 / createMigrateV54): a one-time page
// in Safari, the owner's own Base Account confirms ONE fixed batch in Coinbase, Kipurse's paymaster fronts the gas for exactly that batch
// (callsHash gate in onboard-sponsor) and the batch repays it in USDC (never ETH). The page lists EVERY call in plain Chinese and English;
// the KPVH guard (link #vh=) refuses any batch that differs by one byte from what was checked. OFF unless KIPURSE_V55=1.
//   mode=deploy : the NEXT V5.5 deploy batch (1: vault factory + registry V2, 2: adapter), fee 0.15 USDC from the Base Account each
//   mode=move   : open the new V5.5 wallet [Base Account, seat V2, SPM] and exit the V5.4 wallet into it (fee = actual cost, from the old wallet)
// Routes: GET /v55?mode=…  GET /v55.js  GET /v55/plan?mode=…  POST /v55/prepare  GET /v55/status?mode=…  POST /v55/paymaster?id=v55-…
import {randomBytes} from 'node:crypto';
import {getAddress,parseAbi,decodeFunctionData,encodeFunctionData,encodeAbiParameters,toHex} from 'viem';
import {V55,V54} from './suite-v55.mjs';import {commitment} from './batch-commit.mjs';
import {deployV55Batches,deployV55State,DEPLOY_V55_FEE_USDC} from './deploy-v55.mjs';
import {readExitStateV54,moveToV55Calls,moveFeeV55,precheckExit,perm,MOVE_V55_REAL_GAS,MOVE_V55_FEE_CAP} from './wallet-v55.mjs';
export const V55_PREFIX='v55-';
export const V55_MAX_USD_PER_OP=1;   // worst case Kipurse may front for ONE of these ops (all limits x maxFeePerGas); each batch repays the real cost
const lc=a=>String(a??'').toLowerCase();const short=a=>{const s=getAddress(a);return s.slice(0,6)+'…'+s.slice(-4);};
const usd=a=>{a=BigInt(a);const i=a/1_000_000n,f=(a%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');return String(i)+(f?'.'+(f.length<2?f.padEnd(2,'0'):f):'');};
const DEC=parseAbi(['function execute(address target,uint256 value,bytes data)','function transfer(address to,uint256 amount) returns (bool)','function createAccount(bytes[] owners,uint256 nonce)',
  'function approve((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData))',
  'function revoke((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData))',
  'function registerPermission((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData))',
  'function cancelReservation(bytes32)','function reconcileFloat(address)','function withdraw(address,address,uint256)','function setKey(uint256,uint256)','function setPaused(bool)',
  'function setTrust((bytes32 merchant,string name,address[] payees,address[] signers,uint160 single,uint160 daily,uint64 expiry))','function setFloatCap(uint160)','function setDeniedPayee(address,bool)',
  'function setDeniedSigner(address,bool)','function setRegistryOptOut(bool)','function setRecovery(address)','function setOpsPerDay(uint32)']);
/** One call -> {zh, en}: what it does, decoded from the bytes themselves (never from a label). Unknown shapes say so. */
export function describeCall(c,{owner,names={}}){const nm=a=>names[lc(a)]??short(a);const to=getAddress(c.to);
  if(lc(to)===lc(V55.deployer)){const a=c.address??null;const what={[lc(V55.factory)]:['启付 V5.5 备用金工厂','the Kipurse V5.5 vault factory'],[lc(V55.adapter)]:['启付 V5.5 付款合约（会自动建好信任合约和备用金模板）','the Kipurse V5.5 payment contract (it creates its trust contract and vault templates)'],[lc(V55.registryV2)]:['启付 V5.5 商家名录 V2','the Kipurse merchant registry V2']}[lc(a)]??['你的 Face ID 钥匙座 V2（只认你手机的 Face ID）','your Face ID key seat V2 (accepts only your phone\'s Face ID)'];
    return {zh:`在 Base 上放一份公开合约：${what[0]}${a?'（'+short(a)+'）':''}。不动任何钱。`,en:`Place a public contract on Base: ${what[1]}${a?' ('+short(a)+')':''}. Moves no money.`};}
  let d;try{d=decodeFunctionData({abi:DEC,data:c.data});}catch{return {zh:'无法识别的调用（页面会停下）',en:'Unrecognised call (the page stops)',unknown:true};}
  if(lc(to)===lc(V55.usdc)&&d.functionName==='transfer')return {zh:`从你的 Base 账户付 ${usd(d.args[1])} USDC 手续费给启付手续费地址（${short(d.args[0])}）。不用 ETH。`,en:`Pay a ${usd(d.args[1])} USDC fee from your Base Account to the Kipurse fee address (${short(d.args[0])}). No ETH.`};
  if(lc(to)===lc(V55.cbswFactory)&&d.functionName==='createAccount')return {zh:'开一个新的启付钱包。它只有三个主人：你的 Base 账户、你的 Face ID 钥匙座、Coinbase 付款授权管理器；以后不会再增减主人。',en:'Open a new Kipurse wallet. It has exactly three owners: your Base Account, your Face ID key seat and Coinbase\'s Spend Permission Manager; owners are never added or removed later.'};
  if(d.functionName!=='execute')return {zh:'无法识别的调用（页面会停下）',en:'Unrecognised call (the page stops)',unknown:true};
  const W=nm(to),[tg,,inner]=d.args;let e;try{e=decodeFunctionData({abi:DEC,data:inner});}catch{return {zh:`${W}：无法识别的操作（页面会停下）`,en:`${W}: unrecognised action (the page stops)`,unknown:true};}
  const f=e.functionName,A=e.args;const T=lc(tg);
  if(f==='transfer'&&T===lc(V55.usdc))return {zh:`${W} 转出 ${usd(A[1])} USDC 到 ${nm(A[0])}`,en:`${W} sends ${usd(A[1])} USDC to ${nm(A[0])}`};
  if(f==='approve')return {zh:`${W} 批准 V5.5 付款授权：总额 ${usd(A[0].allowance)} USDC，到 ${new Date(Number(A[0].end)*1000).toISOString().slice(0,10)} 为止，限额和现在一样`,en:`${W} approves its V5.5 spend permission: ${usd(A[0].allowance)} USDC in total, until ${new Date(Number(A[0].end)*1000).toISOString().slice(0,10)}, same limits as today`};
  if(f==='revoke')return {zh:`${W} 撤销旧的 V5.4 付款授权（之后 AI 不能再从旧钱包付款）`,en:`${W} revokes its old V5.4 spend permission (no AI can pay from the old wallet after this)`};
  if(f==='registerPermission')return {zh:`${W} 启用 V5.5 备用金（只给这一个授权用）`,en:`${W} opens its V5.5 vault (bound to this one permission)`};
  if(f==='cancelReservation')return {zh:`${W} 取消一笔还没结算的 x402 付款，钱退回`,en:`${W} cancels an unsettled x402 payment; the money comes back`};
  if(f==='reconcileFloat')return {zh:`${W} 关闭小额备用金，余额退回`,en:`${W} closes its micro-payment float; the rest comes back`};
  if(f==='withdraw')return {zh:`${W} 把旧备用金（${short(tg)}）里的 ${usd(A[2])} USDC 取回到 ${nm(A[1])}`,en:`${W} takes ${usd(A[2])} USDC out of its old vault (${short(tg)}) back to ${nm(A[1])}`};
  if(f==='setKey')return {zh:`${W} 在钥匙座里登记你这台手机的 Face ID 钥匙（和现在同一把）`,en:`${W} registers your phone's Face ID key in the key seat (the same key as today)`};
  if(f==='setPaused')return {zh:`${W} ${A[0]?'暂停':'恢复'}${T===lc(V54.trust)?'旧钱包上的 AI 付款':'AI 付款'}`,en:`${W} ${A[0]?'pauses':'resumes'} AI payments${T===lc(V54.trust)?' on the old wallet':''}`};
  if(f==='setTrust')return {zh:`${W} 重新记住你信任的商家「${A[0].name}」`,en:`${W} re-applies your trusted merchant "${A[0].name}"`};
  if(f==='setOpsPerDay')return {zh:`${W} 设每天最多 ${A[0]} 次链上操作`,en:`${W} sets at most ${A[0]} on-chain operations per day`};
  const m={setFloatCap:['小额备用金上限','micro-payment float cap'],setDeniedPayee:['拒付收款方','blocked payee'],setDeniedSigner:['拒绝的商家下单身份','blocked merchant order signer'],setRegistryOptOut:['不用商家名录','registry opt-out'],setRecovery:['退款备用地址','recovery address']}[f];
  return m?{zh:`${W} 重新设置你的${m[0]}`,en:`${W} re-applies your ${m[1]}`}:{zh:`${W}：无法识别的操作（页面会停下）`,en:`${W}: unrecognised action (the page stops)`,unknown:true};}

const EP06='0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';const EXB=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']);
const NONCE=parseAbi(['function getNonce(address sender,uint192 key) view returns (uint256)']);
const STUB_SIG=encodeAbiParameters([{type:'tuple',components:[{name:'ownerIndex',type:'uint8'},{name:'signatureData',type:'bytes'}]}],[{ownerIndex:0,signatureData:'0x'+'ff'.repeat(65)}]);
const MODE=m=>m==='move'?'move':'deploy';
/** deps: owner (Base Account), pub, sponsor ({rpc, registerV55}), plan (loadV55Plan), store {get(),put(v)}, ethUsd8, gasPrice?, base, readRaw, script,
 *  move: {oldWallet, known: async()=>({oldPermission,trusts,deniedPayees,deniedSigners,openReservations,serverInFlight}), executorFor(newWallet), onMoved(record)} (null = no move mode). */
export function createSignV55({owner,pub,sponsor,plan,store,ethUsd8,gasPrice=null,base=()=>'https://pay.kipurse.com',readRaw,script=()=>'',maxBody=196608,move=null,now=()=>Date.now()}){
  const OWNER=getAddress(owner);const B=deployV55Batches(plan);const rec=()=>store.get()??{};const put=v=>store.put({...rec(),...v});
  const names=()=>({[lc(OWNER)]:'你的 Base 账户 / your Base Account',...(move?{[lc(move.oldWallet)]:'旧钱包 V5.4 / old wallet V5.4'}:{}),...(rec().move?.newWallet?{[lc(rec().move.newWallet)]:'新钱包 V5.5 / new wallet V5.5',[lc(rec().move.vault)]:'新备用金 / new vault'}:{}),[lc(V55.feeTo)]:'启付手续费地址 / Kipurse fee address'});
  const PLAN_TTL=15*60e3;
  async function build(mode,{feeFixed=null}={}){
    if(mode==='deploy'){const st=await deployV55State(pub);if(st.done)throw Object.assign(Error('done'),{code:'done'});const b=B[st.next-1];
      const calls=b.calls.map((c,i)=>({...c,address:i<b.creates.length&&lc(c.to)===lc(V55.deployer)?(b.n===1?[V55.factory,V55.registryV2][i]:V55.adapter):undefined}));
      return {mode,n:b.n,calls,fee:DEPLOY_V55_FEE_USDC,realGas:BigInt(plan.gas?.ownerBatches?.[b.n===1?'batch1_factory_registry_fee':'batch2_adapter_fee']??(b.n===1?5_000_000:11_000_000)),allowed:[V55.deployer,V55.usdc],wallet:null};}
    if(!move)throw Object.assign(Error('move off'),{code:'unavailable'});
    const st=await deployV55State(pub);if(!st.done)throw Object.assign(Error('deploy first'),{code:'v55_not_deployed'});
    const k=await move.known();const S=await readExitStateV54(pub,{wallet:move.oldWallet,owner:OWNER,known:k});const pc=precheckExit(S);if(!pc.ok)throw Object.assign(Error('precheck'),{code:'precheck',block:pc.block});
    let fee=feeFixed;if(fee==null){const [gp,px]=await Promise.all([gasPrice?gasPrice():pub.getGasPrice(),ethUsd8()]);const q=moveFeeV55({gasPriceWei:gp,ethUsd8:px});if(q.overCap)throw Object.assign(Error('fee'),{code:'fee_above_cap'});fee=q.usdc;}
    if(BigInt(fee)>MOVE_V55_FEE_CAP)throw Object.assign(Error('fee'),{code:'fee_above_cap'});
    const m=moveToV55Calls(S,{owner:OWNER,newWallet:S.newWallet,vault:S.vaultV55,fee:BigInt(fee),executor:getAddress(await move.executorFor(S.newWallet)),seatDeployed:S.seatV2Deployed,salt:rec().move?.salt??null});
    return {mode,calls:m.calls,fee:BigInt(fee),realGas:MOVE_V55_REAL_GAS,allowed:[S.wallet,S.newWallet,V55.cbswFactory,V55.deployer],wallet:S.wallet,
      extra:{oldWallet:S.wallet,newWallet:S.newWallet,vault:S.vaultV55,seat:m.seat,newPermission:JSON.parse(JSON.stringify(m.newPermission,(kk,v)=>typeof v==='bigint'?v.toString():v)),oldPermission:k.oldPermission,move:m.move,x:String(S.phone?.x??''),y:String(S.phone?.y??''),salt:String(m.newPermission.salt)}};}
  const pubCalls=b=>b.calls.map(c=>({to:getAddress(c.to),value:c.value??'0x0',data:c.data}));
  async function plan_(mode){const b=await build(mode);const calls=pubCalls(b);if(mode==='move')put({planFee:{fee:String(b.fee),at:now()},move:b.extra});
    const vh=commitment({chainId:8453,from:OWNER,calls});
    return {mode,batch:b.n??null,owner:OWNER,fee:String(b.fee),calls,describe:b.calls.map(c=>describeCall(c,{owner:OWNER,names:names()})),commitment:vh,link:`${base()}/v55?mode=${mode}#vh=${vh}`,extra:b.extra??null};}
  async function preflight(id,calls){if(!sponsor?.rpc)return false;let nonce;try{nonce=await pub.readContract({address:EP06,abi:NONCE,functionName:'getNonce',args:[OWNER,0n]});}catch{return false;}
    const gp=await pub.getGasPrice().catch(()=>6_000_000n);
    const op={sender:OWNER,nonce:toHex(nonce),initCode:'0x',callData:encodeFunctionData({abi:EXB,functionName:'executeBatch',args:[calls.map(c=>({target:c.to,value:0n,data:c.data}))]}),
      callGasLimit:'0x0',verificationGasLimit:'0x0',preVerificationGas:'0x0',maxFeePerGas:toHex(BigInt(gp)*2n),maxPriorityFeePerGas:toHex(BigInt(gp)/10n||1n),paymasterAndData:'0x',signature:STUB_SIG};
    try{const r=await sponsor.rpc(id,{jsonrpc:'2.0',id:1,method:'pm_getPaymasterStubData',params:[op,EP06,'0x2105',{}]},{lang:'en'});return !!r?.result&&!r.error;}catch{return false;}}
  async function prepare(body){let from;try{from=getAddress(String(body?.from??''));}catch{return [400,{error:'not_owner'}];}if(from!==OWNER)return [400,{error:'not_owner'}];
    const mode=MODE(body?.mode);let feeFixed=null;if(mode==='move'){const pf=rec().planFee;if(!pf||now()-pf.at>PLAN_TTL)return [409,{error:'plan_expired'}];feeFixed=BigInt(pf.fee);}
    let b;try{b=await build(mode,{feeFixed});}catch(e){return [409,{error:e.code??'unavailable',block:e.block}];}
    const calls=pubCalls(b);if(b.calls.some(c=>describeCall(c,{owner:OWNER,names:names()}).unknown))return [409,{error:'unrecognised_call'}];
    const id=sponsor?.registerV55?.(randomBytes(12).toString('hex'),{owner:OWNER,wallet:b.wallet,calls,reimburse:b.fee,realGas:b.realGas,mode,step:b.n??null,allowed:b.allowed});if(!id)return [503,{error:'unavailable'}];
    if(!(await preflight(id,calls)))return [503,{error:'unavailable'}];
    if(mode==='move')put({move:b.extra,preparedAt:now()});
    return [200,{id,chainId:8453,from:OWNER,mode,calls,fee:String(b.fee),paymaster:`${base()}/v55/paymaster?id=${id}`}];}
  const isValid=p=>pub.readContract({address:V55.spm,abi:parseAbi(['function isValid((address,address,address,uint160,uint48,uint48,uint48,uint256,bytes)) view returns (bool)']),functionName:'isValid',args:[Object.values(perm(p))]}).catch(()=>false);
  let moved=false;
  async function status(mode,n){if(mode==='deploy'){const st=await deployV55State(pub);const k=Number(n||st.next||2);return {...st,migrated:k===1?st.factory&&st.registry:st.adapter};}
    const r=rec();const done=!!r.move?.newPermission&&await isValid(r.move.newPermission)&&!(await isValid(r.move.oldPermission));
    if(done&&!moved&&move?.onMoved){moved=true;try{await move.onMoved(r.move);put({movedAt:now()});}catch{moved=false;}}
    return {migrated:done,moved:done,...(done?{newWallet:r.move.newWallet}:{})};}
  /** Sponsor gate (o = the sponsor record): deploy only while the chain is at that record's batch; move only while the old permission is valid and the new wallet does not exist. */
  async function open(o){if(!o||lc(o.owner)!==lc(OWNER))return false;const st=await deployV55State(pub);
    if(o.mode==='deploy')return !st.done&&Number(o.step)===st.next;
    if(!move||!st.done)return false;const r=rec();if(!r.move)return false;const c=await pub.getCode({address:getAddress(r.move.newWallet)});return (!c||c==='0x')&&await isValid(r.move.oldPermission);}
  const J=(res,c,o,h={})=>{res.writeHead(c,{'content-type':'application/json','cache-control':'no-store',...h});res.end(JSON.stringify(o));};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function page(mode,zh,nonce){const t=(a,b)=>zh?a:b;let p=null,err=null;try{p=await plan_(mode);}catch(e){err=e.code??'unavailable';}
    const css='body{margin:0;background:#F2F2F7;color:#111;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}.w{max-width:520px;margin:0 auto;padding:24px 18px 40px}.c{background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0}.m{color:#666;font-size:14px}code{font-size:12px;word-break:break-all}ol{padding-left:20px}li{margin:8px 0}button{display:block;width:100%;padding:16px;border:0;border-radius:14px;background:#0052FF;color:#fff;font-size:18px;font-weight:600}';
    const title=mode==='deploy'?t('部署启付 V5.5 合约（第 '+(p?.batch??'-')+' 步，共 2 步）','Deploy the Kipurse V5.5 contracts (step '+(p?.batch??'-')+' of 2)'):t('开新的 V5.5 钱包，把钱从 V5.4 钱包搬过去','Open your new V5.5 wallet and move your money from the V5.4 wallet');
    const head=`<!doctype html><html lang=${zh?'zh':'en'}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=referrer content=no-referrer><title>${esc(title)}</title><style>${css}</style><div class=w><h2>${esc(title)}</h2>`;
    if(err==='done')return head+`<div class=c><b>✅ ${t('V5.5 合约已经都在 Base 上了，不需要再做什么。','The V5.5 contracts are already on Base. Nothing else to do.')}</b></div></div></html>`;
    if(!p)return head+`<div class=c>${esc(t('现在不能继续（'+err+'）。什么都没有发生。','Not possible right now ('+err+'). Nothing has happened.'))}</div></div></html>`;
    const items=p.calls.map((c,i)=>`<li>${esc(zh?p.describe[i].zh:p.describe[i].en)}<div class=m>${t('调用','call')} → <code>${esc(c.to)}</code> · ${(c.data.length-2)/2} ${t('字节','bytes')}</div></li>`).join('');
    const data=JSON.stringify({owner:OWNER,mode,prepare:'/v55/prepare',status:'/v55/status?mode='+mode+(p.batch?'&n='+p.batch:'')}).replace(/</g,'\\u003c');
    return head+`<div class=c><b>${t('你要在 Coinbase 里确认的就是下面这 '+p.calls.length+' 个调用，一个都不多：','In Coinbase you confirm exactly these '+p.calls.length+' calls, nothing else:')}</b><ol>${items}</ol>
<div class=m>${mode==='deploy'?t('手续费 '+usd(p.fee)+' USDC，从你的 Base 账户付，不用 ETH。','Fee '+usd(p.fee)+' USDC from your Base Account. No ETH.'):t('手续费 '+usd(p.fee)+' USDC（网络实际成本），从旧钱包付，不用 ETH。搬到新钱包的金额：'+usd(p.extra.move)+' USDC，其中 0.15 USDC 放进新备用金（还是你的钱）。','Fee '+usd(p.fee)+' USDC (the actual network cost) from the old wallet. No ETH. Moved to the new wallet: '+usd(p.extra.move)+' USDC, of which 0.15 USDC goes into the new vault (still your money).')}</div>
<div class=m>${t('批次指纹','Batch fingerprint')} <code>${p.commitment}</code></div></div>
<div class=c><div class=m>${t('内容和启付 App 检查过的不一致、或 Coinbase 现在不能用 USDC 付手续费时，页面会停下，不会提交，也不会让你用 ETH 付。','If anything differs from what your Kipurse app checked, or Coinbase cannot take the fee in USDC right now, this page stops and submits nothing, and never asks for ETH.')}</div></div>
<button id=go>${t('在 Coinbase 里确认','Confirm in Coinbase')}</button><p class=m id=st></p>
<script type="application/json" id=kp-data>${data}</script><script nonce="${nonce}" src="/v55.js"></script></div></html>`;}
  async function handle(req,res,u){const p=u.pathname;
    if(p==='/v55'&&(req.method==='GET'||req.method==='HEAD')){const nonce=randomBytes(16).toString('base64');const zh=!/^en/i.test(String(u.searchParams.get('lang')??req.headers?.['accept-language']??'zh'));
      let html;try{html=await page(MODE(u.searchParams.get('mode')),zh,nonce);}catch{return J(res,503,{error:'rpc'}),true;}
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self' https://*.coinbase.com https://mainnet.base.org https://mainnet-preconf.base.org; frame-src https://keys.coinbase.com; form-action 'none'; frame-ancestors 'none'`});res.end(req.method==='HEAD'?undefined:html);return true;}
    if(p==='/v55.js'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(script());return true;}
    if(p==='/v55/plan'&&req.method==='GET'){try{return J(res,200,await plan_(MODE(u.searchParams.get('mode')))),true;}catch(e){return J(res,409,{error:e.code??'unavailable',block:e.block}),true;}}
    if(p==='/v55/status'&&req.method==='GET'){try{return J(res,200,await status(MODE(u.searchParams.get('mode')),u.searchParams.get('n'))),true;}catch{return J(res,503,{error:'rpc'}),true;}}
    if(p==='/v55/prepare'&&req.method==='POST'){let b={};try{b=JSON.parse(await readRaw(req)||'{}');}catch{}try{const [c,o]=await prepare(b);return J(res,c,o),true;}catch{return J(res,503,{error:'rpc'}),true;}}
    if(p==='/v55/paymaster'){const cors={'access-control-allow-origin':'*','access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','cache-control':'no-store'};
      if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return true;}if(req.method!=='POST'||!sponsor?.enabled)return J(res,404,{error:'not_found'},cors),true;
      const id=String(u.searchParams.get('id')??'');if(!id.startsWith(V55_PREFIX))return J(res,404,{error:'not_found'},cors),true;
      let b;try{b=JSON.parse(await readRaw(req,maxBody)||'{}');}catch(e){return J(res,e?.status===413?413:400,{error:e?.status===413?'too_large':'bad_json'},cors),true;}
      return J(res,200,await sponsor.rpc(id,b,{lang:'en'}),cors),true;}
    return false;}
  return {handle,plan:plan_,prepare,status,open,build};}
/** Paths the public tunnel must pass while the V5.5 pages are on (operator runbook; production tunnel config is changed by hand only). */
export const V55_TUNNEL_PATH_REGEX='v55(\\.js|/(plan|status|prepare|paymaster))?';
