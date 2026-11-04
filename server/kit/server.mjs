// SPDX-License-Identifier: AGPL-3.0-only
// Kipurse Start: ONE local page for ordinary owners (Sepolia TEST MODE by default) + a remote-style MCP endpoint with a per-agent token
// embedded in the URL. Holds no owner key: the owner signs in his own Base Account popup. Listens on 127.0.0.1 only.
//   node kit/server.mjs [--port 8680] [--dir ~/.kipurse-kit]          (test mode, Base Sepolia)
//   KIPURSE_MAINNET=I_UNDERSTAND node kit/server.mjs --mainnet        (explicit switch; see README)
import http from 'node:http';import fs from 'node:fs';import {join} from 'node:path';import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';import {homedir} from 'node:os';
import {createPublicClient,http as vhttp,parseAbi,getAddress,isAddress,encodeAbiParameters,parseAbiParameters,keccak256,toHex,encodeFunctionData} from 'viem';import {baseSepolia,base} from 'viem/chains';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';import {credentialCandidates,redactUrl} from './creds.mjs';import {oauthPack} from './client-packs.mjs';import {localize,langOf} from './i18n.mjs';
import {createEngineV5} from '../src/v5/engine.mjs';import {createV5Mcp} from '../src/v5/mcp.mjs';import {v5Abi,spendPermissionHash,permissionToJson} from '../src/v5/abi.mjs';
import {buildMigrationPlanV5} from '../src/v5/plan.mjs';import {loadOrCreateSessionKey} from '../src/v5/userop.mjs';import {QUESTIONS,validateAnswers,disclosure,RISK_NOTICE_ZH,RISK_NOTICE_EN} from '../src/v5/owner-setup.mjs';
import {applyOwnerRulesConfig} from '../src/v5/owner-wiring.mjs';import {ownerMac,approvalMessage,revokeMessage} from '../src/v5/joint-trust.mjs';
import {CATALOG,findBin,applyLocal,removeLocal,remoteInfo,kindOf} from './agents.mjs';
import {createOAuth} from './oauth.mjs';import {pausedEngine,liveAgentEngine} from './pause.mjs';import {encryptedStore} from '../src/v5/at-rest.mjs';import {createCardRail,createMockCardProvider} from '../src/v5/cards.mjs';
import {openVault,assertBoundary,defaultKeyFile} from './vault.mjs';import {scrubAgentBackups} from './agents.mjs';import {loadKitConfig} from './config.mjs';
import {changeMessage,withdrawalMessage,releaseMessage,depositInfo} from '../src/v5/owner-guard.mjs';
import {checkLimitChangeZh,usdcErrorZh,parseUsdc} from '../src/v5/answer-rules.mjs';
import {loadOperatorConfig,operatorRuntime} from './operator.mjs';
import {createCoinbaseOnramp,createMockOnramp,loadCdpKey,mockPage,PRESETS as ONRAMP_PRESETS} from '../src/v5/onramp.mjs';
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>0?process.argv[i+1]:d;};
const MAINNET=process.argv.includes('--mainnet');if(MAINNET&&process.env.KIPURSE_MAINNET!=='I_UNDERSTAND')throw Error('mainnet needs the explicit switch: KIPURSE_MAINNET=I_UNDERSTAND');
if(MAINNET)throw Error('Mainnet onboarding of NEW wallets is not enabled in this build. The existing mainnet wallet uses the one-signature page package (kipurse-v5-one-signature).');
const OPERATOR=loadOperatorConfig(),OP=operatorRuntime(OPERATOR);
const PORT=Number(arg('port',process.env.PORT||8680)),PUB=OP.publicUrl,BASE=PUB||`http://localhost:${Number(arg('port',process.env.PORT||8680))}`,SEC=PUB.startsWith('https://')?'; Secure':'',DIR=arg('dir',process.env.KIPURSE_DATA_DIR||join(homedir(),'.kipurse-kit'));assertBoundary(DIR,defaultKeyFile());fs.mkdirSync(DIR,{recursive:true,mode:0o700});const LOG=process.env.KIPURSE_LOG_FILE||null;
const NET={...loadKitConfig(DIR),chain:baseSepolia};
const pub=createPublicClient({chain:NET.chain,transport:vhttp(NET.rpc,{timeout:60000,retryCount:3})});
const ERC=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)','function getAddress(bytes[] owners,uint256 nonce) view returns (address)','function createAccount(bytes[] owners,uint256 nonce) payable returns (address)','event Transfer(address indexed from,address indexed to,uint256 value)']);
const SP='(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
const SPMR=parseAbi([`function isValid(${SP} p) view returns (bool)`,`function revoke(${SP} p)`]);const WEX=parseAbi(['function execute(address target,uint256 value,bytes data) payable']);const bal=a=>pub.readContract({address:NET.usdc,abi:ERC,functionName:'balanceOf',args:[a]});
const rdA=(fn,args=[],address=NET.adapter)=>pub.readContract({address,abi:v5Abi,functionName:fn,args});
const VAULT=openVault(DIR);const save=()=>VAULT.save(S);
const S=VAULT.load()??{agents:{},sessions:{}};
// migrate: give pre-gallery keys an agent type so gallery cards and the authorized list share one source of truth
for(const x of Object.values(S.agents||{}))if(!x.kind){const k=kindOf(x.name);if(k)x.kind=k;}
let session=loadOrCreateSessionKey(join(DIR,'session-key.json'));const sha=x=>createHash('sha256').update(x).digest('hex');
// one-time owner login link (0600 file); the page then holds an HttpOnly cookie
const newLoginLink=()=>{const code=randomBytes(24).toString('hex');S.loginHash=sha(code);save();const url=`${BASE}/login?code=${code}`;fs.writeFileSync(join(DIR,'owner-link.txt'),url+'\n',{mode:0o600});return url;};
let engine=null,cfg=null;
async function boot(){if(!S.setup?.active)return;cfg={chainId:NET.chainId,rpc:NET.rpc,adapter:NET.adapter,manager:NET.spm,token:NET.usdc,permission:S.setup.permission,trust:S.setup.trust,gasMode:'userop',session,
  bundler:{label:'pimlico-public'},userOp:{pollMs:2500},prepareConfirmations:2,retryDelayMs:4000,gasPricing:{oracle:true,marginBps:0},ownerRulesDir:join(DIR,'owner-rules'),atRest:encryptedStore(fs.readFileSync(VAULT.keyFile,'utf8')),
  // the paying wallet's owner #0 is the owner's Base Account: trust requests are signed as the nested wallet message, then wrapped
  ownerSigner:{wallet:S.setup.wallet,ownerIndex:0}};
  // TEST MODE real-world spending: mock card issuer whose 'funding account' is the owner's own address, so test money comes back to them.
  cfg.cards=createCardRail({provider:createMockCardProvider({fundingAddress:()=>S.setup.owner}),store:cfg.atRest,file:join(DIR,'owner-rules','cards.json')});
  await applyOwnerRulesConfig(cfg);if(!cfg.ownerGuard.limits()){cfg.ownerGuard.stageFromPlan({permissionHash:S.setup.permissionHash,offchain:S.setup.offchain});cfg.ownerGuard.activateIfSigned();}
  engine=createEngineV5(cfg,{ledgerFile:join(DIR,'ledger.sqlite')});}
const J=x=>JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v);
const send=(res,code,body,h={})=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store',...h});res.end(typeof body==='string'?body:J(localize(body,res.__lang)));};
const readBody=async req=>{let b='';for await(const c of req){b+=c;if(b.length>200000)throw Error('too big');}if(!b)return {};
  if(/application\/x-www-form-urlencoded/.test(req.headers['content-type']??''))return Object.fromEntries(new URLSearchParams(b));return JSON.parse(b);};
const cookieOf=req=>/(?:^|; )kp=([0-9a-f]{64})/.exec(req.headers.cookie??'')?.[1];
const isOwner=req=>{const c=cookieOf(req);const s=c&&S.sessions[sha(c)];return s&&req.headers['x-kp-csrf']===s.csrf?s:null;};
const usd=x=>(Number(BigInt(x))/1e6).toString();const atomic=s=>{const e=usdcErrorZh('withdraw',s);if(e)throw Error(e.replace('withdraw','取回金额'));return parseUsdc(s).toString();};
// ---- deposits: scan USDC Transfer logs into the wallet (idempotent by tx:logIndex) ----
async function scanDeposits(){if(!engine)return;const W=S.setup.wallet;const latest=await pub.getBlockNumber();let from=BigInt(S.scanFrom??S.setup.block);
  while(from<=latest){const to=from+199n>latest?latest:from+199n;const logs=await pub.getLogs({address:NET.usdc,event:ERC[4],args:{to:W},fromBlock:from,toBlock:to});
    const rows=[];for(const l of logs){if(getAddress(l.args.from)===getAddress(S.setup.vault)||getAddress(l.args.from)===getAddress(NET.adapter))continue;const b=await pub.getBlock({blockNumber:l.blockNumber});
      rows.push({txHash:l.transactionHash,logIndex:l.logIndex,from:l.args.from,token:NET.usdc,value:l.args.value.toString(),time:Number(b.timestamp)});}
    if(rows.length)cfg.ownerGuard.ingestDeposits(rows);from=to+1n;S.scanFrom=from.toString();save();}}
// ---- MCP (Streamable HTTP, stateless): /mcp/<agentToken> ----
const agentByKey=token=>token?Object.values(S.agents).find(x=>{const h=Buffer.from(x.tokenHash,'hex'),t=Buffer.from(sha(token),'hex');return h.length===t.length&&timingSafeEqual(h,t)&&!x.revoked;}):null;
// ---- MCP authorization (OAuth 2.1 + PKCE, dynamic registration) for /mcp; legacy /mcp/<key> and Bearer <agent key> still work ----
const OA=createOAuth({S,save,base:()=>BASE,caps:()=>S.setup?.human??null,ownerSession:req=>{const c=cookieOf(req);return c&&S.sessions[sha(c)]||null;},
  isAgentLive:id=>!!S.agents[id]&&!S.agents[id].revoked,
  createAgentKey:(name,kind,clientId)=>{for(const x of Object.values(S.agents))if(x.kind===kind&&x.via==='oauth'&&x.clientName===name&&!x.revoked){x.revoked=true;OA.revokeAgent(x.id);delete S.agents[x.id];}
    const id='agent-'+randomBytes(4).toString('hex');S.agents[id]={id,name,kind,via:'oauth',clientId,clientName:name,tokenHash:sha(randomBytes(32).toString('hex')),created:new Date().toISOString()};save();return id;}});
const agentFromRequest=(req,u,token)=>{for(const c of credentialCandidates(req.headers,u,token)){const id=OA.agentForAccess(c);const a=id?S.agents[id]:agentByKey(c);if(a&&!a.revoked)return a;}return null;};
const SSE=new Map();// legacy HTTP+SSE transport sessions: sessionId -> {t,agentId}
async function mcp(req,res,token,u){const a=agentFromRequest(req,u,token);
  if(!a)return send(res,401,{error:'invalid_token',error_description:'connect with OAuth (see WWW-Authenticate) or use an agent key'},{'www-authenticate':OA.challenge()+(req.headers.authorization?', error="invalid_token"':''),'access-control-allow-origin':'*','access-control-expose-headers':'WWW-Authenticate, Mcp-Session-Id'});
  {const n=Date.now(),prev=a.lastUsed?Date.parse(a.lastUsed):0;a.lastUsed=new Date(n).toISOString();if(n-prev>30000)save();}// last MCP activity (persisted at most every 30 s)
  if(!engine)return send(res,503,{error:'wallet not set up yet: the owner finishes setup on the Kipurse page first'});
  const body=req.method==='POST'?await readBody(req):undefined;const {server}=createV5Mcp(liveAgentEngine(engine,()=>S.agents[a.id]),{agentId:a.id});
  const t=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});res.on('close',()=>{t.close();server.close();});
  await server.connect(t);await t.handleRequest(req,res,body);}
async function mcpSse(req,res,token,u){const a=agentFromRequest(req,u,token);
  if(!a)return send(res,401,{error:'invalid_token'},{'www-authenticate':OA.challenge(),'access-control-allow-origin':'*','access-control-expose-headers':'WWW-Authenticate'});
  if(!engine)return send(res,503,{error:'wallet not set up yet'});
  const {server}=createV5Mcp(liveAgentEngine(engine,()=>S.agents[a.id]),{agentId:a.id});const t=new SSEServerTransport('/messages',res);
  SSE.set(t.sessionId,{t,agentId:a.id});res.on('close',()=>{SSE.delete(t.sessionId);server.close();});await server.connect(t);}
async function mcpSseMessage(req,res,u){const s=SSE.get(u.searchParams.get('sessionId')??'');if(!s||S.agents[s.agentId]?.revoked)return send(res,404,{error:'unknown or expired SSE session'});
  await s.t.handlePostMessage(req,res,await readBody(req));}
// ---- per-agent pause: a paused agent can still READ (status, limits, history) but every spending / changing call is refused ----
// receipts: who was paid, in plain words, with a trust badge (trusted by you / registered merchant / new shop)
const MERCHANT_BOOK=()=>{try{return JSON.parse(fs.readFileSync(join(DIR,'merchants.json'),'utf8'));}catch{return {};}};
function enrichPurchases(list){const tl=(()=>{try{return cfg.jointTrust?.list()?.trusted??[];}catch{return [];}})().filter(t=>t.active!==false).map(t=>JSON.stringify(t).toLowerCase());const trusted={has:k=>!!k&&tl.some(x=>x.includes(k))};const book=MERCHANT_BOOK();
  return list.map(p=>{const k=String(p.payee??'').toLowerCase(),b=book[k]??{};const badge=trusted.has(k)?'trusted':(p.tier==='registered'||p.tier==='signed'||b.verified)?'verified':'new';
    return {...p,merchantName:b.name??p.merchant??p.label??null,merchantContact:b.contact??null,merchantWebsite:b.website??null,badge};});}
// ---- owner API ----
const ownersBytes=o=>[encodeAbiParameters(parseAbiParameters('address'),[getAddress(o)]),encodeAbiParameters(parseAbiParameters('address'),[NET.spm])];
// TEST MODE helper: if nothing arrived on Base Sepolia, look for test USDC on other testnets / the owner's own address (cached 30 s).
const OTHER=[['Ethereum Sepolia','https://ethereum-sepolia-rpc.publicnode.com','0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'],['Arbitrum Sepolia','https://sepolia-rollup.arbitrum.io/rpc','0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'],['OP Sepolia','https://sepolia.optimism.io','0x5fd84259d66Cd46123540766Be93DFE6D43130D7'],['Avalanche Fuji','https://api.avax-test.network/ext/bc/C/rpc','0x5425890298aed601595a70AB815c96711a31Bc65'],['Polygon Amoy','https://polygon-amoy.drpc.org','0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'],['Unichain Sepolia','https://sepolia.unichain.org','0x31d0220469e10c4E71834a79b1f276d740d3768F']];
let wrongCache={at:0,v:[]};
async function wrongChain(wallet,owner){if(NET.chainId!==84532)return [];if(Date.now()-wrongCache.at<30000)return wrongCache.v;const out=[];
  await Promise.all(OTHER.map(async([n,r,u])=>{const c=createPublicClient({transport:vhttp(r,{timeout:4000})});for(const [who,a] of [['wallet',wallet],['owner',owner]]){try{const b=await c.readContract({address:u,abi:ERC,functionName:'balanceOf',args:[a]});if(b>0n)out.push({chain:n,who,amount:usd(b)});}catch{}}}));
  try{const b=await bal(owner);if(b>0n)out.push({chain:'Base Sepolia',who:'owner',amount:usd(b)});}catch{}
  wrongCache={at:Date.now(),v:out};return out;}
const WEB=new Map();// sha(code) -> {exp,next}; in memory, 120 s, single use
const safeNext=n=>{const x=String(n??'/');return /^\/(?!\/)[\w\-./?=&%#]*$/.test(x)&&x.length<=4000?x:'/';};

const CDPKEY=loadCdpKey(OP.cdpKeyFile);
const DELETE_PHRASE='删除我的账户',phraseOK=c=>{const t=String(c??'').trim();return t===DELETE_PHRASE||t.toLowerCase().replace(/\s+/g,' ')==='delete my account';},DELETE_MIN_WAIT=Number(process.env.KIPURSE_DELETE_WAIT_MS??5000),DEL=new Map();
const DELETE_MEANING=['所有 AI 的连接钥匙和授权（含 OAuth）立刻失效，AI 再也不能用这个钱包付款','服务器上的设置、账本、AI 列表和执行密钥全部删除，无法恢复（删除前可以下载账本）',
  '你会被登出，这台服务器不再保存任何你的数据','钱不会被删除：USDC 一直在链上你自己的智能钱包里，只有你的 Base Account 能控制',
  '建议先「全部取回」并在链上撤销授权；跳过也可以，之后随时可以按「如何取回你的钱」自己操作'];
const baseRecovery=()=>({chainId:NET.chainId,network:'Base Sepolia (test)',explorer:NET.explorer,wallet:S.setup.wallet,owner:S.setup.owner,withdrawalAddress:S.setup.offchain?.withdrawalAddress??S.setup.owner,
  usdc:NET.usdc,spendPermissionManager:NET.spm,adapter:NET.adapter,payerVault:S.setup.vault??null,permission:S.setup.permission??null,ownerIndexOfSpm:1});
async function recoveryCalls(){const ex=await engine.exitPlan();return {calls:[{to:S.setup.wallet,value:'0x0',data:ex.walletExecuteBatch.data}],labels:ex.calls.map(c=>c.label)};}
async function recoveryInfo(){const r=baseRecovery();try{r.floatVault=await rdA('floatAddress',[S.setup.wallet]);}catch{}
  r.permissionValid=await pub.readContract({address:NET.spm,abi:SPMR,functionName:'isValid',args:[permObj()]}).catch(()=>null);
  if(engine){const x=await recoveryCalls();r.revoke={to:x.calls[0].to,data:x.calls[0].data,labels:x.labels};}
  else{const inner=encodeFunctionData({abi:SPMR,functionName:'revoke',args:[permObj()]});r.revoke={to:S.setup.wallet,data:encodeFunctionData({abi:WEX,functionName:'execute',args:[NET.spm,0n,inner]}),labels:['revoke the V5 spend permission']};}
  const [w,v]=await Promise.all([bal(S.setup.wallet),S.setup.vault?bal(S.setup.vault):0n]);r.balances={wallet:w.toString(),vault:v.toString()};r.rescueUrl=rescueUrl();return r;}
// ---- plain-word deposit / withdraw (TEST MODE) ----
const FEE_PPM=1000n,GAS_MAX=50000n;// 0.1% Kipurse fee; network fee is paid in USDC from the wallet (Circle Paymaster), owner-signed max 0.05 USDC
const fmt=x=>{const v=BigInt(x),w=v/1000000n,f=(v%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
const DEC=parseAbi(['function decimals() view returns (uint8)']);
/** Validate a withdrawal destination in plain Chinese. Throws a human message; returns {to, kind, warnings}. */
async function checkDest(raw){const s=String(raw??'').trim().replace(/^ethereum:/i,'').replace(/@\d+$/,'');
  if(!s)throw Error('请填收款地址');
  if(/^(bc1|[13][a-km-zA-HJ-NP-Z1-9]{25,34}$)|^T[1-9A-HJ-NP-Za-km-z]{33}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)&&!s.startsWith('0x'))throw Error('这不是 Base 地址（看起来是比特币 / 波场 / Solana 地址）。请在 Coinbase 或 Base App 里选「USDC · Base 网络」再复制地址');
  if(!/^0x[0-9a-fA-F]{40}$/.test(s))throw Error('地址格式不对：Base 地址以 0x 开头，一共 42 位。请直接复制粘贴或扫码，不要手打');
  if(/[a-f]/.test(s.slice(2))&&/[A-F]/.test(s.slice(2))&&!isAddress(s,{strict:true}))throw Error('地址校验没通过（可能少了或抄错了一位），请重新复制');
  const to=getAddress(s.toLowerCase());if(/^0x0{40}$/i.test(to))throw Error('这个地址不能收款');
  const own=[S.setup?.wallet,S.setup?.vault,NET.adapter,NET.spm,NET.factory,S.setup?.trust].filter(Boolean).map(a=>getAddress(a));
  if(own.includes(to))throw Error('这是 Kipurse 钱包自己的地址，钱转过去等于没动。请填你在 Coinbase 或 Base App 里的地址');
  const warnings=[];const code=await pub.getCode({address:to}).catch(()=>null);
  if(code&&code.length>2){let token=getAddress(to)===NET.usdc;if(!token)try{await pub.readContract({address:to,abi:DEC,functionName:'decimals'});token=true;}catch{}
    if(token)throw Error('这是一个代币合约地址，不是钱包，转过去的钱会丢。请填你自己钱包的地址');
    warnings.push('这是智能钱包地址（Base App 的钱包就是这种），可以正常收款');}
  const kind=S.setup&&to===getAddress(S.setup.owner)?'base':(S.setup?.offchain?.coinbaseAddress&&to===getAddress(S.setup.offchain.coinbaseAddress))?'coinbase':'other';
  if(kind==='other')warnings.push('请再核对一遍：转错地址钱拿不回来。地址必须是 Base 网络上的（Coinbase 里选 USDC → Base）');
  return {to,kind,warnings};}
async function withdrawQuote({to,amount}){if(!engine)throw Error('钱包还没设置好');const d=await checkDest(to??S.setup.offchain?.withdrawalAddress??S.setup.owner);
  const bal0=await bal(S.setup.wallet);const g=cfg.ownerGuard;const spendable=g.spendable?g.spendable(bal0):bal0;
  const caps=g.capsForTrust?.();const single=caps?BigInt(caps.mainSingle):null;
  const all=spendable>GAS_MAX?((spendable-GAS_MAX)*1000000n)/(1000000n+FEE_PPM):0n;let maxAll=single!==null&&all>single?single:all;
  let a;if(String(amount??'').trim()==='all'||String(amount??'').trim()==='全部')a=maxAll;else a=BigInt(atomic(amount));
  const fee=(a*FEE_PPM+999999n)/1000000n;const total=a+fee+GAS_MAX;const out={to:d.to,kind:d.kind,warnings:d.warnings,amount:a.toString(),fee:fee.toString(),gasMax:GAS_MAX.toString(),totalMax:total.toString(),
    balance:bal0.toString(),spendable:spendable.toString(),maxAll:maxAll.toString(),everything:all.toString(),perPaymentCap:single?.toString()??null,needsEth:false};
  out.problem=a<=0n?'余额不够付手续费':total>spendable?`余额不够：取 ${fmt(a)} 加手续费最多要 ${fmt(total)}，可用 ${fmt(spendable)} USDC`:single!==null&&a>single?`一次最多取 ${fmt(single)} USDC（你设的每笔上限）。要一次全部取回，用「全部取回并停止」`:null;
  out.plain=`对方收到 ${fmt(a)} USDC。手续费 ${fmt(fee)}（0.1%）+ 网络费最多 ${fmt(GAS_MAX)}，都从钱包里的 USDC 扣，不需要 ETH。`;return out;}
const API={
  async webLink({next}){const code=randomBytes(24).toString('hex');WEB.set(sha(code),{exp:Date.now()+120000,next:safeNext(next)});return {url:`${BASE}/login?code=${code}`,expiresInSec:120};},
  async state(){const st={mode:'TEST',chainId:NET.chainId,explorer:NET.explorer,questions:QUESTIONS,disclosure:disclosure({feeRecipient:OP.feeRecipientLabel}),operator:OP.publicInfo,riskZh:RISK_NOTICE_ZH,riskEn:RISK_NOTICE_EN,setup:S.setup?{wallet:S.setup.wallet,owner:S.setup.owner,active:!!S.setup.active,start:S.setup.permission.start,human:S.setup.human}:null,
    serverTime:new Date().toISOString(),oauthPending:OA.pendingList(),mcpUrl:PUB?PUB+'/mcp':null,agents:Object.values(S.agents).filter(a=>!a.revoked).map(a=>({id:a.id,name:a.name,kind:a.kind??null,paused:!!a.paused,revoked:!!a.revoked,created:a.created,lastUsed:a.lastUsed??null}))};
    if(S.setup){if(!S.setup.active)st.setup.calls=S.setup.calls;st.deposit=await depositInfo({wallet:S.setup.wallet,chainId:NET.chainId});st.balance=(await bal(S.setup.wallet)).toString();st.walletDeployed=((await pub.getCode({address:S.setup.wallet}))??'0x').length>2;st.checkedAt=new Date().toISOString();
      if(!S.setup.active&&BigInt(st.balance)<200000n)st.elsewhere=await wrongChain(S.setup.wallet,S.setup.owner);
      if(!S.setup.active&&st.walletDeployed&&Number((await pub.getBlock()).timestamp)>=Number(S.setup.permission.start)+5&&await pub.readContract({address:NET.spm,abi:SPMR,functionName:'isValid',args:[S.setup.permObj()]}).catch(()=>false)){S.setup.active=true;save();await boot();st.setup.active=true;}}
    if(engine){await scanDeposits().catch(()=>{});const g=cfg.ownerGuard;st.limits=g.limits();{const c=g.capsForTrust();if(c)st.main={single:c.mainSingle.toString(),daily:c.mainDaily.toString()};}st.trust=cfg.jointTrust.list();{const o=cfg.__trustRequestsOwner;if(o)st.trustRequests=o.api.list(o.cap);}st.deposits=g.deposits().slice(-20);st.quarantined=g.quarantined().toString();if(S.setup?.vault){try{st.reserve=(await bal(S.setup.vault)).toString();}catch{}}st.pending=g.pending();
      try{st.purchases=enrichPurchases(engine.listPurchases({limit:20}));}catch{st.purchases=[];}
      try{cfg.disputes?.matchRefunds(g.deposits().map(d=>({from:d.from,amount:d.amount,txHash:d.txHash??d.id,at:d.time})));st.disputes=engine?.disputes?.()??cfg.disputes?.list()??[];}catch{st.disputes=[];}}
    return st;},
  async prepare({owner,answers}){if(S.setup?.active)throw Error('already set up');const o=getAddress(owner);const nonce=BigInt(keccak256(toHex('kipurse-kit:'+o+':'+Date.now())));
    const wallet=getAddress(await pub.readContract({address:NET.factory,abi:ERC,functionName:'getAddress',args:[ownersBytes(o),nonce]}));
    const v=validateAnswers({...answers,withdrawalAddress:answers.withdrawalAddress??o},{wallet});
    const trust=getAddress(await rdA('trust'));const vault=getAddress(await rdA('vaultAddress',[wallet]));const start=Number((await pub.getBlock()).timestamp)+180;
    const plan=buildMigrationPlanV5({chainId:NET.chainId,wallet,adapter:NET.adapter,trust,token:NET.usdc,manager:NET.spm,executor:session.address,maxNetworkFee:'50000',headroom:false,
      stated:{single:v.perPayment.toString(),daily:v.perDay.toString(),term:v.termTotal.toString(),openSingle:v.perPayment.toString(),openDaily:v.perDay.toString(),verifiedSingle:'0',verifiedDaily:'0'},
      fee:{ppm:'1000'},start,end:start+v.termDays*86400,salt:String(Date.now()),zeroReserve:{vault,buffer:'200000'},trusts:[]});
    const calls=[{to:NET.factory,value:'0x0',data:encodeFunctionData({abi:ERC,functionName:'createAccount',args:[ownersBytes(o),nonce]})},
      {to:wallet,value:'0x0',data:encodeFunctionData({abi:v5Abi,functionName:'executeBatch',args:[plan.calls.map(c=>({target:c.to,value:0n,data:c.data}))]})}];
    const perm=permissionToJson?permissionToJson(plan.permission):plan.permission;
    S.setup={owner:o,wallet,vault,trust,nonce:nonce.toString(),permission:JSON.parse(J(perm)),permissionHash:spendPermissionHash(plan.permission,{chainId:NET.chainId,manager:NET.spm}),
      offchain:{unrecognizedPerPayment:v.unrecognizedPerPayment.toString(),unrecognizedPerDay:v.unrecognizedPerDay.toString(),depositDailyLimit:v.depositDailyLimit.toString(),withdrawalAddress:getAddress(v.withdrawalAddress)},
      block:(await pub.getBlockNumber()).toString(),calls,active:false,human:{termDays:v.termDays,perPayment:usd(v.perPayment),perDay:usd(v.perDay),termTotal:usd(v.termTotal),unrecognizedPerPayment:usd(v.unrecognizedPerPayment),unrecognizedPerDay:usd(v.unrecognizedPerDay),depositDailyLimit:usd(v.depositDailyLimit)}};
    save();const d=await depositInfo({wallet,chainId:NET.chainId});return {wallet,calls,needUsdc:'0.2',deposit:d,human:S.setup.human};},
  async newAgent({name}){const token=randomBytes(24).toString('base64url');const id='agent-'+randomBytes(4).toString('hex');S.agents[id]={id,name:String(name||'My AI').slice(0,40),tokenHash:sha(token),created:new Date().toISOString()};save();
    const url=`${BASE}/mcp/${token}`;const b64=Buffer.from(JSON.stringify({url})).toString('base64');
    return {id,url,cursor:`cursor://anysphere.cursor-deeplink/mcp/install?name=kipurse&config=${encodeURIComponent(b64)}`,claudeCode:`claude mcp add --transport http kipurse ${url}`,codex:`codex mcp add kipurse --url ${url}`,
      generic:JSON.stringify({mcpServers:{kipurse:{url}}})};},
  async oauthPending(){return {pending:OA.pendingList()};},
  async oauthDecide({req,approve}){OA.decide(String(req),!!approve);return {ok:true};},
  async agentCatalog(){return {agents:CATALOG.map(a=>({...a,installed:a.kind==='local'?!!findBin(a.bin):null,...(oauthPack(a.id,PUB||null)??{})})),publicUrl:!!PUB};},
  async connectAgent({agentId,__lang}){const a=CATALOG.find(x=>x.id===agentId);if(!a)throw Error('unknown agent');
    if(a.kind==='native')return {id:agentId,kind:'native',how:a.how};
    for(const x of Object.values(S.agents))if(x.kind===agentId&&!x.revoked)x.revoked=true;// one live key per agent type
    const token=randomBytes(24).toString('base64url');const id='agent-'+randomBytes(4).toString('hex');
    S.agents[id]={id,name:a.name,kind:agentId,tokenHash:sha(token),created:new Date().toISOString()};save();
    const localUrl=`http://localhost:${PORT}/mcp/${token}`,publicUrl=PUB?`${PUB}/mcp/${token}`:null;
    const info=remoteInfo(agentId,{localUrl,publicUrl,token,baseUrl:PUB||null,lang:__lang});
    if(a.kind==='local')info.local=await applyLocal(agentId,localUrl);
    return {keyId:id,name:a.name,...info};},
  async deleteAgent({id,removeConfig=true}){const x=S.agents[id];if(!x)return {ok:true,deleted:false};x.revoked=true;OA.revokeAgent(id);const kind=x.kind;delete S.agents[id];save();
    const local=removeConfig&&kind&&!Object.values(S.agents).some(y=>y.kind===kind&&!y.revoked)?await removeLocal(kind):null;return {ok:true,deleted:true,local};},
  async reportProblem({purchaseKey,reason,note}){if(!engine)throw Error('钱包还没设置好');const r=engine.requestRefund({purchaseKey,reason,note});if(r.state!=='opened')throw Error(r.detail);
    const pr=enrichPurchases(engine.listPurchases({limit:100000})).find(x=>x.purchaseKey===r.case.purchaseKey);return {...r,merchant:{name:pr?.merchantName??null,contact:pr?.merchantContact??null,website:pr?.merchantWebsite??null,address:r.case.payee}};},
  async disputes(){return {cases:engine?engine.disputes():[]};},
  async closeDispute({id,status}){if(!cfg?.disputes)throw Error('钱包还没设置好');return cfg.disputes.close(id,status);},
  async exportCsv(){if(!engine)throw Error('钱包还没设置好');const r=await engine.exportCsv();return {csv:r.csv??r,rows:r.rows??null};},
  async agentPause({id,paused}){const x=S.agents[id];if(!x||x.revoked)throw Error('没有这个 AI');x.paused=!!paused;x.pausedAt=paused?new Date().toISOString():null;save();return {ok:true,id,paused:x.paused};},
  async revokeAgent({id}){if(S.agents[id]){S.agents[id].revoked=true;save();}return {ok:true};},
  // agent-requested trust: owner-only (this API is behind the owner cookie + CSRF; agent keys never reach /api). approve -> typed data the owner
  // signs in his own Base Account; sign -> the kit relays trustBySig. Same flow for every agent.
  async trustRequests(){const o=cfg?.__trustRequestsOwner;if(!o)throw Error('钱包还没设置好');return o.api.list(o.cap);},
  async trustRequestApprove({id}){const o=cfg.__trustRequestsOwner;return o.api.approve(o.cap,id);},
  async trustRequestSign({id,signature}){const o=cfg.__trustRequestsOwner;return o.api.submitSignature(o.cap,id,signature);},
  async trustRequestReject({id}){const o=cfg.__trustRequestsOwner;return o.api.reject(o.cap,id);},
  async trust({action,id,key}){const jt=cfg.jointTrust,sec=cfg.__ownerSecret;const p=jt.list().pending.find(x=>x.id===id);
    if(action==='approve')return jt.approve(id,ownerMac(sec,approvalMessage(p)));if(action==='reject')return jt.reject(id,ownerMac(sec,'kipurse-trust-reject|'+id));
    if(action==='revoke'){const n=randomBytes(8).toString('hex');return jt.revoke(key,n,ownerMac(sec,revokeMessage(key,n)));}},
  async limits({changes,approveId}){const g=cfg.ownerGuard;if(approveId){const c=g.pending().changes.find(x=>x.id===approveId);return g.approveChange(approveId,ownerMac(cfg.__ownerSecret,changeMessage(c)));}
    const {withdrawalAddress:wa,...nums}=changes??{};const c0=g.capsForTrust();const chk=checkLimitChangeZh(nums,{current:g.limits(),main:c0&&{single:c0.mainSingle,daily:c0.mainDaily}});if(!chk.ok)throw Error(chk.errors.map(e=>e.zh).join('；'));
    const ch=Object.fromEntries(Object.entries(chk.values).map(([k,v])=>[k,v.toString()]));if(wa)ch.withdrawalAddress=wa;return g.setLimits(ch,{agentId:'owner'});},
  async withdrawQuote(o){return withdrawQuote(o);},
  async withdraw({amount,approveId,to}){const g=cfg.ownerGuard;let id=approveId;
    if(!id){const q=await withdrawQuote({to,amount});if(q.problem)throw Error(q.problem);
      // a new destination chosen by the owner on his Face-ID-gated device becomes the registered withdrawal address (owner-approved change)
      if(getAddress(q.to)!==getAddress(g.limits().withdrawalAddress)){const r=g.setLimits({withdrawalAddress:q.to},{agentId:'owner'});const c=r?.pendingOwnerApproval??g.pending().changes.filter(x=>x.state==='pending'&&x.withdrawalAddress===q.to).pop();
        if(c)g.approveChange(c.id,ownerMac(cfg.__ownerSecret,changeMessage(c)));S.setup.offchain.withdrawalAddress=q.to;save();}
      id=g.requestWithdrawal({amount:q.amount,agentId:'owner'}).id;}
    const w=g.pending().withdrawals.find(x=>x.id===id);if(w)g.approveWithdrawal(id,ownerMac(cfg.__ownerSecret,withdrawalMessage(w)));const r=await engine.executeWithdrawal({withdrawalId:id,agentId:'owner'});
    if(r.state!=='paid'&&r.state!=='submitted')throw Error(r.reason==='gas_spike'?'网络现在太忙，网络费超过 0.05 USDC，过一分钟再试':`没有取成功（${r.reason??r.state}），钱还在你的钱包里`);return r;},
  async setCoinbaseAddress({to}){const d=await checkDest(to);S.setup.offchain.coinbaseAddress=d.to;save();return {ok:true,to:d.to,warnings:d.warnings};},
  async depositOptions(){if(!S.setup)throw Error('钱包还没设置好');const w=S.setup.wallet;const test=NET.chainId===84532;
    return {address:w,network:test?'Base Sepolia（测试网）':'Base',warning:'只能转「Base 网络上的 USDC」。其他网络或其他币转进来会丢。Cash App 和 Venmo 不支持 Base，不要直接转——请用 Apple Pay 或它们的借记卡充值。',
      coinbase:test?{available:false,stub:true,plain:'测试模式：Coinbase 不能买测试币。正式版这里会直接打开 Coinbase（可用 Coinbase 余额或 Apple Pay），金额和地址都自动填好。',faucet:'https://faucet.circle.com/'}
        :{available:false,plain:'打开 Coinbase App → 发送 → USDC → 网络选 Base → 粘贴地址（已复制）',app:'https://go.cb-w.com/'},
      steps:['在 Coinbase 或 Base App 里点「发送」','选 USDC，网络选 Base','粘贴这个地址（或扫二维码），确认'],
      onramp:{available:true,practice:!CDPKEY||test,presets:ONRAMP_PRESETS,applePay:!test}};},
  async onrampSession({amount,applePay}={},req){if(!S.setup)throw Error('钱包还没设置好');const a=Number(amount);if(!(a>=1&&a<=10000))throw Error('金额要在 1 到 10000 美元之间');
    const test=NET.chainId===84532;const p=CDPKEY&&!test?createCoinbaseOnramp({key:CDPKEY}):createMockOnramp({base:()=>BASE});
    return p.session({address:S.setup.wallet,amount:a,applePay:!!applePay,redirectUrl:'kipurse://deposit-done'});},
  async rescueLink(){if(!S.setup)throw Error('钱包还没设置好');return {url:rescueUrl()};},
  async release({id}){return cfg.ownerGuard.releaseQuarantine(id,ownerMac(cfg.__ownerSecret,releaseMessage(id)));},
  async pause(){return engine.pause();},
  // ---- account deletion (multi-step; the phone adds Face ID + a countdown; the server enforces phrase + ticket + delay) ----
  async deletePreview(){const st={owner:S.setup?.owner??null,wallet:S.setup?.wallet??null,setupActive:!!S.setup?.active,agents:Object.values(S.agents).filter(a=>!a.revoked).length,
      oauthClients:OA.clientCount(),chainId:NET.chainId,explorer:NET.explorer,confirmPhrase:DELETE_PHRASE,minWaitSec:DELETE_MIN_WAIT/1000};
    if(S.setup){const W=S.setup.wallet;const [w,v]=await Promise.all([bal(W),S.setup.vault?bal(S.setup.vault):0n]);let fl=0n,flOpen=false;
      try{const fa=await rdA('floatAddress',[W]);fl=await bal(fa);flOpen=(await rdA('floats',[W]))[4];}catch{}
      st.balances={wallet:w.toString(),vault:v.toString(),float:fl.toString(),total:(w+v+fl).toString()};st.withdrawalAddress=S.setup.offchain?.withdrawalAddress??S.setup.owner;
      st.permissionValid=S.setup.permission?await pub.readContract({address:NET.spm,abi:SPMR,functionName:'isValid',args:[permObj()]}).catch(()=>null):null;st.permissionEnd=S.setup.permission?.end??null;st.floatOpen=flOpen;}
    st.meaning=DELETE_MEANING;return st;},
  async exportLedger(){const out={kind:'kipurse-ledger-export',version:1,exportedAt:new Date().toISOString(),chainId:NET.chainId,wallet:S.setup?.wallet??null,owner:S.setup?.owner??null,
      limits:S.setup?.human??null,agents:Object.values(S.agents).map(a=>({name:a.name,kind:a.kind??null,created:a.created,lastUsed:a.lastUsed??null,revoked:!!a.revoked}))};
    if(engine){try{out.purchases=engine.listPurchases({limit:100000});}catch{out.purchases=[];}try{out.deposits=cfg.ownerGuard.deposits();}catch{out.deposits=[];}}else{out.purchases=[];out.deposits=[];}
    S.exportedAt=out.exportedAt;save();return out;},
  async revokeCalls(){if(!S.setup)throw Error('还没有设置钱包，没有链上授权要撤销');return recoveryCalls();},
  async deleteStart({confirm}){if(!phraseOK(confirm))throw Error(`请完整输入「${DELETE_PHRASE}」`);
    const t=randomBytes(16).toString('hex');DEL.set(sha(t),{nb:Date.now()+DELETE_MIN_WAIT,exp:Date.now()+300000});return {ticket:t,notBeforeSec:DELETE_MIN_WAIT/1000,expiresInSec:300};},
  async deleteAccount({ticket,confirm,skippedRevoke}){if(!phraseOK(confirm))throw Error(`请完整输入「${DELETE_PHRASE}」`);
    const d=DEL.get(sha(String(ticket??'')));if(!d)throw Error('确认已过期，请重新开始删除流程');if(Date.now()<d.nb)throw Error('倒计时还没结束');if(Date.now()>d.exp){DEL.delete(sha(String(ticket)));throw Error('确认已过期，请重新开始删除流程');}
    DEL.clear();const report={deletedAt:new Date().toISOString(),steps:[]};const step=(k,ok,info)=>report.steps.push({step:k,ok,...(info?{info}:{})});
    // 1. every agent key + OAuth client/token (and local agent configs)
    let n=0;for(const x of Object.values(S.agents)){x.revoked=true;OA.revokeAgent(x.id);n++;if(x.kind)await removeLocal(x.kind).catch(()=>null);}OA.revokeAll();step('revokeAgents',true,{count:n});
    // 2. stop payments: on-chain executor pause (24 h) when the wallet is live; the executor key is destroyed in step 4 anyway
    let recovery=null;if(S.setup){const live=await pub.readContract({address:NET.spm,abi:SPMR,functionName:'isValid',args:[permObj()]}).catch(()=>null);
      if(live===false)step('pause',true,{info:'permission already revoked on chain: nothing left to pause'});
      else if(engine){try{const r=await engine.pause();step('pause',true,{txHash:r.txHash});}catch(e){step('pause',false,{error:String(e.shortMessage??e.message).slice(0,200)});}}else step('pause',true,{info:'wallet was not active'});
      // 3. on-chain revocation package for the owner (also needed if he skips signing it now)
      try{recovery=await recoveryInfo();}catch(e){recovery=baseRecovery();recovery.revokeError=String(e.shortMessage??e.message).slice(0,200);}
      recovery.revokeSkipped=!!skippedRevoke;step('prepareRevocation',!!recovery.revoke,{permissionValid:recovery.permissionValid});}
    // 4. delete every server-side file (state, ledger, owner rules, executor session key, OAuth) and end all sessions
    engine=null;cfg=null;let removed=0;for(const f of fs.readdirSync(DIR)){if(f==='config.json')continue;fs.rmSync(join(DIR,f),{recursive:true,force:true});removed++;}
    for(const k of Object.keys(S))delete S[k];S.agents={};S.sessions={};S.oauth={clients:{},pending:{},codes:{},tokens:{}};OA.rebind(S.oauth);
    WEB.clear();DEL.clear();wrongCache={at:0,v:[]};VAULT.rotate();// crypto-shred: old ciphertext/backups unreadable
    session=loadOrCreateSessionKey(join(DIR,'session-key.json'));save();step('deleteData',true,{entries:removed,keyRotated:true});
    if(LOG){try{fs.truncateSync(LOG,0);step('deleteLogs',true);}catch{step('deleteLogs',false);}}
    try{step('scrubAgentConfigBackups',true,{removed:scrubAgentBackups()});}catch{step('scrubAgentConfigBackups',false);}
    newLoginLink();step('logout',true);
    return {deleted:true,report,recovery};},

  async exitCalls(){const ex=await engine.exitPlan();const W=S.setup.wallet;let fb=0n;if(ex.calls.some(c=>/float/.test(c.label))){try{fb=await bal(await rdA('floatAddress',[W]));}catch{}}const total=(await bal(W))+(await bal(S.setup.vault))+fb;
    const inner=[...ex.calls.map(c=>({target:c.to,value:0n,data:c.data})),{target:NET.usdc,value:0n,data:encodeFunctionData({abi:ERC,functionName:'transfer',args:[S.setup.owner,total]})}];
    return {calls:[{to:W,value:'0x0',data:encodeFunctionData({abi:v5Abi,functionName:'executeBatch',args:[inner]})}],returns:usd(total)};},
};
const rescueUrl=()=>{const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const base=OP.rescueUrl||`${BASE}/rescue/`;
  return base+'#c='+b({v:1,chainId:NET.chainId,wallet:S.setup.wallet,owner:S.setup.owner,usdc:NET.usdc,spm:NET.spm,adapter:NET.adapter,vault:S.setup.vault??null,permission:S.setup.permission??null,to:S.setup.offchain?.withdrawalAddress??S.setup.owner});};
const permObj=()=>{const p=S.setup.permission;return {...p,allowance:BigInt(p.allowance),salt:BigInt(p.salt),period:Number(p.period),start:Number(p.start),end:Number(p.end)};};
const STATIC=new URL('./static/',import.meta.url).pathname,RESCUE=new URL('./rescue/',import.meta.url).pathname;
http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');res.__lang=langOf(req);
  if(S.setup)S.setup.permObj=permObj;
  if(u.pathname==='/onramp/mock'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'"});res.end(mockPage(u.searchParams.get('amount')));return;}
  if(await OA.handle(req,res,u,{readBody,ip:req.headers['cf-connecting-ip']??req.socket.remoteAddress}))return;
  if(req.method==='GET'&&(u.pathname==='/sse'||u.pathname==='/mcp/sse'))return await mcpSse(req,res,'',u);
  if(u.pathname==='/messages'&&req.method==='POST')return await mcpSseMessage(req,res,u);
  if(req.method==='GET'&&/^\/mcp\/[^/]+\/sse$/.test(u.pathname))return await mcpSse(req,res,u.pathname.split('/')[2],u);
  if(u.pathname==='/mcp')return await mcp(req,res,'',u);
  if(u.pathname.startsWith('/mcp/.well-known/')){res.writeHead(307,{location:u.pathname.slice(4)});return res.end();}
  if(u.pathname.startsWith('/mcp/'))return await mcp(req,res,u.pathname.slice(5),u);
  if(u.pathname==='/login'){const c=u.searchParams.get('code')??'';const w=WEB.get(sha(c));let next='/';if(w){WEB.delete(sha(c));if(w.exp>Date.now()){next=w.next;const ck=randomBytes(32).toString('hex');S.sessions[sha(ck)]={csrf:randomBytes(16).toString('hex'),at:Date.now(),via:'webLink'};save();
      res.writeHead(303,{location:next,'set-cookie':`kp=${ck}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${SEC}`});return res.end();}}
    if(!S.loginHash||sha(c)!==S.loginHash){res.writeHead(403,{'content-type':'text/html; charset=utf-8'});return res.end('链接已用过或无效 / link used or invalid. 重新运行启动命令 / run the start command again.');}
    delete S.loginHash;const ck=randomBytes(32).toString('hex');S.sessions[sha(ck)]={csrf:randomBytes(16).toString('hex'),at:Date.now()};save();
    res.writeHead(303,{location:'/','set-cookie':`kp=${ck}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${SEC}`});return res.end();}
  if(u.pathname==='/api/logout'&&req.method==='POST'){const c=cookieOf(req);const s0=isOwner(req);if(!s0)return send(res,401,{error:'login'});delete S.sessions[sha(c)];save();
    return send(res,200,{ok:true,loggedOut:true},{'set-cookie':`kp=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SEC}`});}
  if(u.pathname==='/api/csrf'){const c=cookieOf(req);const s=c&&S.sessions[sha(c)];return s?send(res,200,{csrf:s.csrf}):send(res,401,{error:'login'});}
  if(u.pathname.startsWith('/api/')){if(req.headers.origin&&req.headers.origin!==`http://localhost:${PORT}`&&req.headers.origin!==`http://127.0.0.1:${PORT}`&&!(PUB&&req.headers.origin===PUB))return send(res,403,{error:'origin'});
    if(!isOwner(req))return send(res,401,{error:'login'});const fn=API[u.pathname.slice(5)];if(!fn)return send(res,404,{error:'no'});
    if(!['state','prepare','newAgent','revokeAgent','webLink','agentCatalog','connectAgent','deleteAgent','oauthPending','oauthDecide','deletePreview','exportLedger','deleteStart','deleteAccount','depositOptions','onrampSession','rescueLink','agentPause','disputes'].includes(u.pathname.slice(5))&&!engine)return send(res,409,{error:'not set up'});
    try{const b=req.method==='POST'?await readBody(req):{};if(b&&typeof b==='object'&&!Array.isArray(b))Object.defineProperty(b,'__lang',{value:res.__lang,enumerable:false});return send(res,200,await fn(b));}catch(e){return send(res,400,{error:e.errors?e.errors.join('; '):(e.shortMessage??e.message)});}}
  if(u.pathname==='/rescue'){res.writeHead(301,{location:'/rescue/'});return res.end();}
  if(u.pathname.startsWith('/rescue/')){const rf=u.pathname==='/rescue/'?'index.html':u.pathname.slice(8);if(!['index.html','rescue.js','rescue-config.json'].includes(rf)){res.writeHead(404);return res.end();}
    res.writeHead(200,{'content-type':rf.endsWith('.js')?'text/javascript; charset=utf-8':rf.endsWith('.json')?'application/json':'text/html; charset=utf-8','cache-control':'no-store','cross-origin-opener-policy':'same-origin-allow-popups','referrer-policy':'no-referrer',
      'content-security-policy':"default-src 'self'; connect-src https:; frame-src https://*.coinbase.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'"});return res.end(fs.readFileSync(join(RESCUE,rf)));}
  const f=u.pathname==='/'?'index.html':u.pathname.slice(1);if(!['index.html','app.js'].includes(f)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'content-type':f.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store','cross-origin-opener-policy':'same-origin-allow-popups',...(SEC?{'strict-transport-security':'max-age=86400','referrer-policy':'no-referrer'}:{}),
    'content-security-policy':"default-src 'self'; connect-src 'self' https://*.coinbase.com wss://*.coinbase.com https://*.base.org https://*.cbwallet.com; frame-src https://*.coinbase.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'"});
  res.end(fs.readFileSync(join(STATIC,f)));
}catch(e){if(!res.headersSent)send(res,500,{error:'server error'});}}).listen(PORT,process.env.KIPURSE_HOST||'127.0.0.1',async()=>{await boot();const link=newLoginLink();
  console.log(`\n  Kipurse (TEST MODE · Base Sepolia) is running.\n  Your private link was saved to ${join(DIR,'owner-link.txt')} (one-time).\n`);if(process.env.KIPURSE_PRINT_LINK==='1')console.log('  Open: '+link+'\n');});
