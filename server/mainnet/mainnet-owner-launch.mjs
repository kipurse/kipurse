// OPERATOR LAYER: mainnet runtime for the universal trust flow + the owner signing page. Used by the real launch (launch.sh)
// and by the fork e2e (overrides). Reads NO key itself: the engine loads the session key file by path in userop mode.
import {checkVerifiedMulti} from '../src/v5/cb-verified.mjs';
import fs from 'node:fs';import {join} from 'node:path';import {createPublicClient,http,getAddress,parseAbi} from 'viem';import {base} from 'viem/chains';
// KIPURSE_GATEWAY / KIPURSE_MAIN_CONFIG_DIR / KIPURSE_MAIN_DATA_DIR let a server install keep code, config and state apart (defaults = this folder, as on the box)
const G=process.env.KIPURSE_GATEWAY??'./state';const HERE=new URL('.',import.meta.url).pathname;const CONF=process.env.KIPURSE_MAIN_CONFIG_DIR??HERE,DATA=process.env.KIPURSE_MAIN_DATA_DIR??HERE;
// PRINCIPLES (src/v5/principles.mjs): refuse to boot if env/config contradicts an owner principle. Changes need an owner decision in OWNER_HANDBOOK.md.
await (await import(G+"src/v5/principles.mjs")).assertPrinciples({env:process.env});
const {createEngineV5}=await import(G+'src/v5/engine.mjs');const {createV5HttpServer}=await import(G+'src/v5/http.mjs');
const {createOwnerSignSurface}=await import(G+'src/v5/owner-sign-surface.mjs');const {v5Abi,permissionFromJson,decodePolicyV5}=await import(G+'src/v5/abi.mjs');
const {buildMigrationPlanV5}=await import(G+'src/v5/plan.mjs');const {createV5Mcp}=await import(G+'src/v5/mcp.mjs');const {resolveAgent}=await import(G+'src/v4/agents.mjs');
const {StreamableHTTPServerTransport}=await import('@modelcontextprotocol/sdk/server/streamableHttp.js');const httpMod=await import('node:http');const {createOAuth}=await import(G+'kit/oauth.mjs');const {createPublicTrustApproval}=await import(G+'src/v5/trust-approve-public.mjs');const {createPhoneEnrollment,WALLET_ABI,p256VerifyDigest}=await import(G+'src/v5/phone-signer.mjs');const {createPhoneSession}=await import(G+'src/v5/phone-session.mjs');const {createPublicLimits}=await import(G+'src/v5/limits-public.mjs');
const {createRegistry,createIndex,resolveTenant,sha256}=await import(G+'src/v5/tenancy.mjs');const {createOnboarding,onboardFee}=await import(G+'src/v5/onboard.mjs');
const {createNewWalletOnboarding}=await import(G+'src/v5/onboard-new.mjs');const {NO_CEILING}=await import(G+'src/v5/phone-signer.mjs');const {createTenantCache,createMcpPool,createAgentRouter,readRaw}=await import(G+'src/v5/router.mjs');
const {createAnomalyGuard,guardEngine,pauseMsOf}=await import(G+'src/v5/anomaly.mjs');const {createPush,apnsConfigFromEnv}=await import(G+'src/v5/push.mjs');const {createOwnerWithdraw}=await import(G+'src/v5/owner-withdraw.mjs');const {createExecutorKeyring}=await import(G+'src/v5/executor-keys.mjs');const {plainStore,tenantStore,loadDataKey}=await import(G+'src/v5/at-rest.mjs');const {createRateLimiter,kvKey}=await import(G+'src/v5/store.mjs');
const rawBody=req=>readRaw(req);
// MULTI-USER: one process serves many wallets. Global parts (RPC, KV, logs, registry, indexes, router, rate limits) + one runtime per tenant,
// built lazily from that tenant's own files (state, ledger DB, rules, agents) and kept in a bounded LRU. Workers are stateless between requests
// except for that cache; route a tenant to the same worker (tenant affinity, SCALING.md) or run one worker. The server never holds a user key.
export async function startMainnet({overrides={},stateFile=join(DATA,'runtime-state.json'),agentPort=8651,ownerPort=8671,fork=false}={}){
  const SPONSOR_HOLDER={v:null};const SPONSOR_REF=()=>SPONSOR_HOLDER.v;
  /* t635u: purchases (Apple Pay / Onramp) need the wallet OWNER's Coinbase Verified Account attestation. Fail closed. */
  const {createPurchaseGate}=await import(G+'src/v5/purchase-gate.mjs');const CBV_PUBS=String(process.env.KIPURSE_CBV_RPCS??'https://mainnet.base.org,https://base-rpc.publicnode.com').split(',').filter(Boolean).map(u=>createPublicClient({transport:http(u,{timeout:8000})}));
  const PGATE=overrides.purchaseGate??createPurchaseGate({check:o=>checkVerifiedMulti(CBV_PUBS,o,{log:x=>console.log(JSON.stringify({t:'cbv_buy',...x}))}),log:(k,v)=>OBS.log(k,v)});
  const X=JSON.parse(fs.readFileSync(join(CONF,'mainnet-trustflow.config.json')));
  const {rpcTransport,rpcUrls}=await import(G+'src/v5/rpc.mjs');const {createSqliteKV,createMemoryKV}=await import(G+'src/v5/store.mjs');const {createObs}=await import(G+'src/v5/obs.mjs');
  const rpc=overrides.rpc??(process.env.KIPURSE_RPC_URLS?rpcUrls(process.env.KIPURSE_RPC_URLS):X.engine.rpcUrls??X.engine.rpc);const pub=createPublicClient({chain:base,transport:rpcTransport(rpc)});
  const KV=overrides.kv??(fork?createMemoryKV():createSqliteKV({file:overrides.kvFile??join(DATA,'kv.sqlite')}));const OBS=createObs({release:(()=>{try{return fs.readFileSync(new URL('../../RELEASE',import.meta.url),'utf8').trim();}catch{return '';}})()});
  if(await pub.getChainId()!==8453)throw Error('not Base mainnet');
  // key isolation: the session key file must be private to the service user (checked by mode only; the file is never read here or logged)
  if(!fork&&!overrides.session&&X.engine?.sessionKeyFile){const st=fs.statSync(X.engine.sessionKeyFile);if(st.mode&0o077)throw Error('session key file must be mode 0600 (no group/other access)');}
  const PUBLIC0=overrides.publicBase??X.publicBase??'https://pay.kipurse.com';const ENV=process.env;
  const ONBOARD_ON=(overrides.onboard??ENV.KIPURSE_ONBOARD)==='1'||overrides.onboard===true;
  const REG=createRegistry({file:overrides.registryFile??join(DATA,'registry.json')});const IDX=createIndex(KV);
  const TROOT=overrides.tenantsDir??join(DATA,'tenants');const TDIR=w=>join(TROOT,String(w).toLowerCase());
  // LOSSLESS MIGRATION of the single-wallet deployment: register it as an ordinary tenant whose files stay exactly where they are.
  if(!REG.get(X.wallet)&&fs.existsSync(stateFile)){fs.mkdirSync(TDIR(X.wallet),{recursive:true,mode:0o700});
    const ag=overrides.agents??(fs.existsSync(join(CONF,'agents.json'))?JSON.parse(fs.readFileSync(join(CONF,'agents.json'))):[]);
    if(!fs.existsSync(join(TDIR(X.wallet),'agents.json')))fs.writeFileSync(join(TDIR(X.wallet),'agents.json'),JSON.stringify(ag,null,1),{mode:0o600});
    REG.add({wallet:X.wallet,owner:X.ownerBaseAccount,vault:X.vault,ownerIndex:Number(X.engine?.ownerSigner?.ownerIndex??0),fromBlock:52884600,targetSingle:String(X.newCaps?.single??''),
      publicPath:'',console:true,files:{state:stateFile,ledgerCache:join(DATA,'ledger.json'),engine:{}},migratedAt:new Date().toISOString()});OBS.log('tenant_migrated',{count:1});}
  const legacy=()=>REG._legacy??=(REG._all().find(r=>r.publicPath==='')?.wallet??null);
  const recFiles=r=>{const d=TDIR(r.wallet);fs.mkdirSync(d,{recursive:true,mode:0o700});const f=r.files;
    return {state:f?.state??join(d,'state.json'),ledgerCache:f?.ledgerCache??join(d,'ledger.json'),agents:join(d,'agents.json'),
      engine:f?{...(f.engine??{})}:{ledgerFile:join(d,'ledger.sqlite'),ownerRulesDir:join(d,'rules'),trustRequestsFile:join(d,'rules','trust-requests.json')}};};
  const DATA_KEY=overrides.dataKey??loadDataKey(ENV.KIPURSE_DATA_KEY_FILE);const storeFor=w=>DATA_KEY?tenantStore(DATA_KEY,w):plainStore;
  const SAFE=createAnomalyGuard({kv:KV,maxPays:Number(ENV.KIPURSE_SAFE_MAX_PAYS_10MIN??30),maxDaily:Number(ENV.KIPURSE_SAFE_MAX_PAYS_DAY??200),maxNewPayees:Number(ENV.KIPURSE_SAFE_MAX_PAYEES_10MIN??8),onPause:(w,reason)=>OBS.log('safety_pause',{reason})});
  // Migration switch: when on, the next limits change the OWNER signs (Base Account) names this wallet's own executor key. Off by default.
  const PER_USER_EXEC=(overrides.perUserExecutor??ENV.KIPURSE_PER_USER_EXECUTOR)==='1'||overrides.perUserExecutor===true;
  const KR=createExecutorKeyring({dir:overrides.executorDir??join(DATA,'executors'),dataKey:DATA_KEY,allowPlain:!!fork||!!overrides.allowPlainExecutorKeys});
  const PUSH=createPush({config:apnsConfigFromEnv(ENV),log:(n,d)=>OBS.log(n,d)});
  const pushTokens=w=>{const k=kvKey('push',String(w).toLowerCase(),'tokens');return {list:()=>KV.get(k)??[],add:(t,lang)=>{const l=(KV.get(k)??[]).filter(x=>x.token!==t);l.push({token:t,lang:lang==='en'?'en':'zh',at:Date.now()});KV.put(k,l.slice(-5));},remove:t=>KV.put(k,(KV.get(k)??[]).filter(x=>x.token!==t)),setEnv:(t,env)=>KV.put(k,(KV.get(k)??[]).map(x=>x.token===t?{...x,env}:x))};};
  const CACHE=createTenantCache({reg:REG,load:rec=>buildTenant(rec),max:Number(ENV.KIPURSE_MAX_TENANTS_IN_MEMORY??500)});const TEN={values:()=>CACHE.values(),get size(){return CACHE.size();}};
  const getTenant=w=>CACHE.get(w);
  async function buildTenant(rec){const F=recFiles(rec);const ST=storeFor(rec.wallet);const st=ST.readJson(F.state,{});
    const R={...rec,state:st,save:()=>ST.writeJson(F.state,st),
      agents:ST.readJson(F.agents,[]),engineFiles:F.engine,ledgerCacheFile:F.ledgerCache,fromBlock:rec.fromBlock??0};
    if(!R.state.permission)R.state.permission=rec.permission??(rec.publicPath===''?X.currentPermission:undefined);if(!R.state.permission)throw Error('tenant has no permission');
    const TPUBLIC=PUBLIC0+(rec.publicPath??('/t/'+String(rec.wallet).toLowerCase()));
    const {createLedger}=await import(G+'src/v5/ledger.mjs');const LED=createLedger({pub,token:X.token,wallet:R.wallet,vault:R.vault,paymasters:['0xc0de9762a5f06d7f98293b77d74230c750cba078'],names:{[String(R.owner).toLowerCase()]:'你的 Base Account'}/* zh ledger text; the app shows its own English */,owner:R.owner,ownerPaymasters:['0x28Da22dcc90c4d9f4caeE6D0BFe11aEC413Ef609'],fromBlock:R.fromBlock,file:R.ledgerCacheFile});
  const S=R.state;const save=R.save;
  const valid=p=>pub.readContract({address:X.manager,abi:v5Abi,functionName:'isValid',args:[permissionFromJson(p)]});
  if(!await valid(S.permission))throw Error('stored permission is not valid on chain for tenant');
  const agents=R.agents;
  
  {const {applyAgentRevocations}=await import(G+'src/v5/user-data.mjs');applyAgentRevocations(S,agents);}
  const {reloadRevocations}=await import(G+'src/v5/user-data.mjs');reloadRevocations(KV,agents);
  // multi-instance: an erase on another worker reaches this one within KIPURSE_REVOKE_POLL_MS (default 10 s)
  const revokeTimer=null&&setInterval(()=>{try{const n=reloadRevocations(KV,agents);if(n)OBS.log('agent_revocations_reloaded',{count:n});}catch{}},Number(process.env.KIPURSE_REVOKE_POLL_MS??10000)); // tokens revoked by a past erase stay revoked
  const cfg={...X.engine,...overrides,...R.engineFiles,rpc,atRest:DATA_KEY?ST:undefined,permission:S.permission,ownerSigner:{wallet:R.wallet,ownerIndex:R.ownerIndex??0}};delete cfg.agents;
  // t766u: Kipurse dues (fronted onboarding gas etc.) are collected from AI payments too, to the ops account via the vault's owner-set fee slot
  cfg.dues={to:'0xf14ef5dc4723245866c22c749a0a84afceba0dd9',get:()=>SPONSOR_REF()?.dues?.(R.wallet)??0n,paid:n=>{SPONSOR_REF()?.payDue?.(R.wallet,BigInt(n));},blocked:why=>{try{console.log(JSON.stringify({event:'dues_not_collected',reason:why}));}catch{}}};cfg.trustApprovalBase=TPUBLIC+'/approve/trust';if(overrides.session)delete cfg.sessionKeyFile;fs.mkdirSync(cfg.ownerRulesDir,{recursive:true,mode:0o700});
  cfg.onAnomaly=reason=>{try{SAFE.pause(R.wallet,reason,null);}catch{}PUSH.notify(pushTokens(R.wallet),{kind:'anomaly',reason}).catch(()=>{});};
  cfg.onAgentPause=reason=>{try{SAFE.pause(R.wallet,reason,null);}catch{}PUSH.notify(pushTokens(R.wallet),{kind:'anomaly',reason}).catch(()=>{});};
  cfg.onHold=h=>{PUSH.notify(pushTokens(R.wallet),{kind:'hold',id:h.id,name:h.name??'收款方 / payee',amount:h.amountText}).catch(()=>{});};
  cfg.onMandateProposal=v=>{const hs=(v.items??[]).map(i=>i.human??{});const more=hs.length>1?` (+${hs.length-1})`:'';/* RT-6: the push shows every item's text, never just the first */PUSH.notify(pushTokens(R.wallet),{kind:'mandate',id:v.id,zh:('AI 请求：'+hs.map(h=>h.zh??'').join('；')).slice(0,180)+more,en:('AI asks: '+hs.map(h=>h.en??'').join('; ')).slice(0,180)+more}).catch(()=>{});};
  cfg.onPayeeConfirm=ev=>{PUSH.notify(pushTokens(R.wallet),{kind:'payee_confirm',...ev}).catch(()=>{});};
cfg.isPaused=()=>!!SAFE.paused(R.wallet);cfg.blacklistFile=join(DATA,'scam-blacklist.json');
  let engine=null;const boot=()=>{cfg.permission=S.permission;
    // per-user executor: use this wallet's own key when its permission names it; otherwise the legacy shared session key (migration pending)
    if(!overrides.session){try{cfg.session=KR.accountFor(R.wallet,S.permission);cfg.executorMode='per_user';}catch{delete cfg.session;cfg.executorMode='shared_legacy';}}
    engine=createEngineV5(cfg,{ledgerFile:R.engineFiles.ledgerFile??overrides.ledgerFile??cfg.ledgerFile});};boot();
  const E0=new Proxy({},{get:(_,k)=>engine[k]});const E=guardEngine(E0,{guard:SAFE,wallet:R.wallet});const O=()=>cfg.__trustRequestsOwner;
  const pol=()=>decodePolicyV5(permissionFromJson(S.permission).extraData);const target=BigInt(R.targetSingle??decodePolicyV5(permissionFromJson(S.permission).extraData).single);
  const {createEverydayLimits,changeCost,EVERYDAY_WHY,consentSpend}=await import(G+'src/v5/everyday-limits.mjs');const {kvKey}=await import(G+'src/v5/store.mjs');
  const everyKV={get:k=>KV.get(k),set:(k,v)=>KV.put(k,v),del:k=>KV.del(k)};const everyKey=kvKey('everyday',null,String(R.wallet).toLowerCase());
  const EVD=createEverydayLimits({kv:everyKV,wallet:R.wallet,floor:()=>{const p=pol();return {single:p.single,daily:p.daily,term:p.term};}});cfg.everydayCheck=a=>EVD.check(a);cfg.everydayGet=()=>EVD.get();
  const chainNow=async()=>Number((await pub.getBlock()).timestamp);
  async function planCapChange(choice){const {limitsWindow}=await import(G+'src/v5/limits-public.mjs');const cur=S.permission,cp=pol();const mn=(a,b)=>(BigInt(a)<BigInt(b)?BigInt(a):BigInt(b)).toString();const fc=await pub.readContract({address:X.adapter,abi:v5Abi,functionName:'fees'});
    const ppm=await pub.readContract({address:fc,abi:v5Abi,functionName:'feePpm'});
    return buildMigrationPlanV5({chainId:8453,wallet:R.wallet,owner:R.owner,adapter:X.adapter,trust:X.trust,token:X.token,manager:X.manager,
      executor:overrides.capExecutor??(PER_USER_EXEC?KR.ensure(R.wallet):cp.executor),guardian:cp.guardian,registry:cp.registry,headroom:false,maxFeePpm:cp.maxFeePpm,maxNetworkFee:cp.maxNetworkFee,fee:{ppm:String(ppm)},
      stated:choice?{single:choice.single.toString(),daily:choice.daily.toString(),term:choice.term.toString(),openSingle:mn(cp.openSingle,choice.single),openDaily:mn(cp.openDaily,choice.daily),verifiedSingle:mn(cp.verifiedSingle,choice.single),verifiedDaily:mn(cp.verifiedDaily,choice.daily)}
        :{single:target.toString(),daily:cp.daily,term:cp.term,openSingle:cp.openSingle,openDaily:cp.openDaily,verifiedSingle:cp.verifiedSingle,verifiedDaily:cp.verifiedDaily},
      ...limitsWindow(await chainNow(),choice?.days,cur.end),salt:BigInt(cur.salt)+1n,revoke:[cur],zeroReserve:{vault:R.vault,buffer:0}});}
  async function confirmCapChange(plan){if(!await valid(plan.permission))return {valid:false};S.permission=plan.permission;S.capChangedAt=new Date().toISOString();save();boot();return {valid:true,permissionHash:plan.permissionHash};}
  const status=async()=>{const p=pol();return {single:p.single,daily:p.daily,term:p.term,targetSingle:target.toString(),capOk:BigInt(p.single)>=target,executor:p.executor};};
  const trustRequests={cap:true,api:{list:()=>O().api.list(O().cap),approve:(_,id)=>O().api.approve(O().cap,id),submitSignature:(_,id,s)=>O().api.submitSignature(O().cap,id,s),reject:(_,id)=>O().api.reject(O().cap,id)}};
  const ownerSurface=R.console?createOwnerSignSurface({owner:R.owner,wallet:R.wallet,chainId:8453,trustRequests,planCapChange,confirmCapChange,status,
    staticDir:G+'owner-sign/static',loginFile:overrides.loginFile??join(DATA,'owner-login-url.txt'),port:ownerPort}):null;
  const v1=createV5HttpServer(E,{agents});const MCP=createMcpPool({create:id=>createV5Mcp(E,{agentId:id}).server,maxIdle:Number(ENV.KIPURSE_MCP_POOL_IDLE??4)});
  // MCP OAuth 2.1 (URL-only connect). The OWNER approves each connection by signing a message with his Base Account (verified on chain);
  // an OAuth grant is an ordinary agent identity: same tools as a Bearer agent, trust stays request-only (owner trustBySig).
  const PUBLIC=TPUBLIC;S.oauthAgents??={};
  const knownIds=new Set((agents??[]).map(a=>a.id));
  const OA=createOAuth({S,save,base:()=>PUBLIC,network:'main',wallet:R.wallet,ownerAddress:R.owner,
    consentScript:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/consent.js');})(),
    // t1073: the approval page shows only an explicit AI-limit save. Chain policy (including a 10/50/200 floor) is not spend authorization.
    spendAuthorization:()=>{try{return consentSpend(EVD.get());}catch{return {authorized:false};}},
    commitSpend:(amounts)=>{const prior=everyKV.get(everyKey);const r=EVD.set({single:amounts.single,daily:amounts.daily,term:amounts.total});if(!r.ok)return r;const view=consentSpend(EVD.get());
      return {ok:true,limits:{perPayment:view.perPayment,perDay:view.perDay,termTotal:view.termTotal,at:view.at??null},undo(){if(prior===undefined)EVD.forget();else everyKV.set(everyKey,prior);}};},
    onConnected:name=>{if(name==='Siri'){S.siriAgent={since:new Date().toISOString()};save();}},
    ownerSession:()=>null,
    // Face ID approval by the ENROLLED phone key (KipursePhoneApprover), re-checked on chain at every decision. Base Account stays as the alternative.
    phoneApprover:{active:()=>PH.active(),verify:(a,d,r,s)=>p256VerifyDigest(a,d,r,s),
      onChain:overrides.phoneOnChain??(async a=>!!await pub.readContract({address:R.wallet,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[a.approver]}))},
    verifyOwner:overrides.verifyOwner??((message,signature)=>pub.verifyMessage({address:R.owner,message,signature})),
    isAgentLive:id=>!!S.oauthAgents[id]&&!S.oauthAgents[id].revoked,
    createAgentKey:(name,kind,clientId)=>{const id=name==='Siri'?'siri':(knownIds.has(kind)||['grok-bot','claude-code','codex','gemini-cli','gemini-spark'].includes(kind)?kind:'oauth-'+kind);for(const [k,x] of Object.entries(S.oauthAgents))if(k===id&&x.clientId!==clientId)OA.revokeAgent(k);
      S.oauthAgents[id]={id,name,kind,clientId,created:new Date().toISOString()};save();return id;}});
  // public, signature-gated trust approval page (the link kipurse_request_trust hands to the agent for the owner)
  // phone signer (scoped second owner): enrollment + revoke pages, Base Account signs the on-chain batch; server only verifies
  // Operator flags (env, outside the open-source core). Both default OFF on mainnet: V1 approver, no owner payments.
  const OWNER_PAY=(overrides.ownerPay??process.env.KIPURSE_OWNER_PAY)==='1'||overrides.ownerPay===true;const APPROVER_VERSION=overrides.approverVersion??process.env.KIPURSE_PHONE_APPROVER??'v1';
  const PH=createPhoneEnrollment({S,save,pub,wallet:R.wallet,trust:X.trust,owner:R.owner,chainId:8453,base:()=>PUBLIC,approverVersion:APPROVER_VERSION,
    caps:()=>{const p=pol();return {single:BigInt(p.single),daily:BigInt(p.daily)};},script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/phone-enroll.js');})(),
    // t906: enrollment fee from the Kipurse wallet (sponsor fronts gas, same caps; repaid in the same batch to the fixed fee address)
    feeTo:(v=>v==='off'?null:/^0x[0-9a-fA-F]{40}$/.test(v)?v:'0xf14ef5dc4723245866c22c749a0a84afceba0dd9')(process.env.KIPURSE_WITHDRAW_FEE_TO??''),
    sponsor:{available:()=>!!SPONSOR_REF()?.withdrawAvailable?.(),register:async(id,a)=>{const sp=SPONSOR_REF();const sid=sp?.registerEnroll?.(id,a);return sid?`${PUBLIC0}/onboard/new/paymaster?id=${sid}`:null;}}});
  const TA=createPublicTrustApproval({addressCheck:p=>engine?.verifyPayee?.({address:p}),phone:{active:()=>PH.active(),verifyWrapped:async(digest,w)=>String(await pub.readContract({address:R.wallet,abi:WALLET_ABI,functionName:'isValidSignature',args:[digest,w]})).toLowerCase()==='0x1626ba7e'},owner:R.owner,wallet:R.wallet,base:()=>PUBLIC,
    ownerApi:{list:()=>O().api.list(O().cap),approve:id=>O().api.approve(O().cap,id),submitSignature:(id,s,o)=>O().api.submitSignature(O().cap,id,s,o),reject:id=>O().api.reject(O().cap,id)},
    verifyTypedData:overrides.verifyTypedData??(a=>pub.verifyTypedData(a)),verifyMessage:overrides.verifyMessage??(a=>pub.verifyMessage(a)),
    script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/approve-trust.js');})()});
  // READ-ONLY phone session (app main view on mainnet): proves the active phone signer key, then reads state. No writes.
  S.agentLastSeen??={};let seenSaved=0;let SIRI=null;let ONRAMP=null;let APAY=null;let ONRLIM=null;const seen=id=>{S.agentLastSeen[id]=new Date().toISOString();if(Date.now()-seenSaved>60000){seenSaved=Date.now();save();}};
  const readState=async()=>{const st=await E.status();const p=pol();const tr=O().api.list(O().cap);
    const ag=new Map();for(const a of agents??[])if(!a.disabled)ag.set(a.id,{id:a.id,name:a.name??a.id,kind:a.id,via:'token'});
    const nowS=Date.now()/1000,liveTok=id=>Object.values(S.oauth?.tokens??{}).some(t=>t.agentId===id&&t.exp>nowS);
    for(const [id,a] of Object.entries(S.oauthAgents??{}))if(!a.revoked)ag.set(id,{id,name:a.name??id,kind:a.kind??id,via:'oauth',connectedAt:a.created,connected:liveTok(id)||ag.has(id)});
    // t915: Siri is authorized by the enrolled phone (Face ID signer active on the server), not by a token. Stopped via its agent cap.
    if(!ag.has('siri')){let stopped=false;try{stopped=!!E0.mandates?.agents?.().find(x=>x.agentId==='siri')?.stopped;}catch{}
      if(S.phone?.active||S.siriAgent){let spendOk=false;try{spendOk=EVD.get().authorized===true;}catch{spendOk=false;}ag.set('siri',{id:'siri',name:'Siri',kind:'siri',via:'phone',connected:!!S.phone?.active&&spendOk,paused:stopped,connectedAt:S.siriAgent?.since??null});}}
    // lastUsed = last REAL authenticated call from that agent (MCP request / Siri API), kept in memory, saved at most once a minute.
    const list=[...ag.values()].map(a=>({connected:true,...a,lastUsed:S.agentLastSeen[a.id]??null}));
    const purchases=E.listPurchases({limit:50}).map(r=>({purchaseKey:r.purchaseKey,state:r.state,amount:r.amount,payee:r.payee,agent:r.agent,merchant:r.label??r.merchant??null,txHash:r.txHash,createdAt:r.createdAt}));
    return {mode:'MAIN',chainId:8453,explorer:'https://basescan.org',balance:String(st.usdc),reserve:String(st.vault?.balance??0),vault:{address:st.vault?.address,balance:String(st.vault?.balance??0)},
      paused:!!st.paused,safetyPause:SAFE.paused(R.wallet),pausedUntil:String(st.pausedUntil??0),main:{single:String(p.single),daily:String(p.daily)},everyday:(()=>{try{return EVD.get();}catch{return null;}})(),caps:{single:String(p.single),daily:String(p.daily),term:String(p.term),start:String(S.permission.start),end:String(S.permission.end)},limitsPending:(()=>{try{return LIM.pending();}catch{return null;}})(),holds:(()=>{try{return engine?.listHolds?.()??[];}catch{return [];}})(),ledger:(()=>{try{LED.refresh().catch(()=>{});return LED.view({wallet:String(st.usdc),vault:String(st.vault?.balance??0)}).rows.map(r=>{if(r.kind!=='payment')return r;let o=null;try{o=engine?.orderForTx?.(r.tx)??null;}catch{}return o?{...r,order:o}:r;});}catch{return [];}})(),
      spent:{today:String(st.todaySpent),term:String(st.termSpent)},setup:{active:true,wallet:R.wallet,owner:R.owner,human:{perPayment:(Number(p.single)/1e6).toString(),perDay:(Number(p.daily)/1e6).toString(),termTotal:(Number(p.term)/1e6).toString()}},
      agents:list,purchases,trustRequests:{pending:tr.pending.map(r=>({...r,chainId:8453,chain:'base'}))},connectRequests:OA.pendingList(),phone:{fingerprint:PH.active()?.fingerprint??null}};};
  const PS=createPhoneSession({phone:{active:()=>PH.active()},wallet:R.wallet,store:(S.phoneSession??={}),save,readState,kv:KV});
  const {createOwnerPay}=await import(G+'src/v5/owner-pay.mjs');
  const knownPayees=async()=>{const seen=new Map();for(const r of E.listPurchases({limit:200}))if(r.payee&&r.state==='paid'&&!seen.has(String(r.payee).toLowerCase()))seen.set(String(r.payee).toLowerCase(),{address:r.payee,name:r.label??r.merchant??null});return [...seen.values()];};
  // One tenant per phone session (this deployment serves one wallet; the module itself keys everything by wallet).
  const OPAY=createOwnerPay({enabled:OWNER_PAY,store:S,save,resolveTenant:async req=>PS.check(req)?{wallet:R.wallet,chainId:8453,token:X.token,pub,phone:PH,engine:E,knownPayees}:null});
  const WD=createOwnerWithdraw({pub,wallet:R.wallet,owner:R.owner,vault:R.vault??null,token:X.token,feed:(await import(G+'src/v5/phone-signer.mjs')).ETH_USD_FEED,chainId:8453,
    script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/withdraw.js');})(),
    // t752u: fee paid from the wallet's own USDC. OFF until the owner sets KIPURSE_WITHDRAW_FEE_TO (fixed fee address). Uses the existing sponsor + its day caps.
    // t757u: default = Kipurse mainnet ops account (gas reserve; on-chain treasury() = 0x2222…, locked). Env overrides; 'off' disables.
    feeTo:(v=>v==='off'?null:/^0x[0-9a-fA-F]{40}$/.test(v)?v:'0xf14ef5dc4723245866c22c749a0a84afceba0dd9')(process.env.KIPURSE_WITHDRAW_FEE_TO??''),
    walletPays:{dues:()=>{const sp=SPONSOR_REF();let d=sp?.dues?.(R.wallet)??0n;try{d+=BigInt(engine?.gasBook?.outstanding?.(R.wallet)??0n);}catch{}return d;},
      paid:n=>{const sp=SPONSOR_REF();const t=sp?.payDue?.(R.wallet,n)??0n;const rest=n-t;if(rest>0n)try{engine?.gasBook?.applyRecovery?.(R.wallet,rest,null);}catch{}},
      available:()=>!!SPONSOR_REF()?.withdrawAvailable(),register:async(id,a)=>{const sp=SPONSOR_REF();const sid=sp?.registerWithdraw(id,a);return sid?`${PUBLIC0}/onboard/new/paymaster?id=${sid}`:null;}}});
  // EMERGENCY without a bound phone (reinstall / new phone): Base Account signature only, verified here before acting. Pause + cancel holds.
  const {createOwnerEmergency}=await import(G+'src/v5/owner-emergency.mjs');
  const EM=createOwnerEmergency({wallet:R.wallet,owner:R.owner,obs:OBS,verifyOwner:overrides.verifyOwner??((message,signature)=>pub.verifyMessage({address:R.owner,message,signature})),
    pendingHolds:()=>{try{return (E0.listHolds?.()??[]).length;}catch{return 0;}},
    pause:async()=>{const p=SAFE.pause(R.wallet,'owner_stop',null);let chain=null;try{const r=await E0.pause();chain={paused:true,txHash:r.txHash};}catch(e){chain={paused:false,error:String(e?.code??'chain_pause_failed')};}return {server:p,chain};},
    cancelHolds:async()=>{let n=0;for(const h of E0.listHolds?.()??[]){try{if(E0.cancelHold(h.id)?.ok)n++;}catch{}}return {cancelled:n,left:(E0.listHolds?.()??[]).length};},
    script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/emergency.js');})()});
  // Owner pause longer than the on-chain executor pause (24 h max): while the owner's pause lasts, re-arm the on-chain pause when it
  // has lapsed. In-process check (no cron); gas for the pause comes from the owner's own vault like every owner action.
  const rearm=async()=>{try{const p=SAFE.paused(R.wallet);if(!p||p.reason!=='owner_stop')return;const st=await E0.status?.().catch(()=>null);
      const until=Number(st?.pausedUntil??0);if(until>Math.floor(Date.now()/1000)+3600)return;await E0.pause();OBS.log('safety_rearm',{});}catch{}};
  const rearmTimer=setInterval(rearm,Number(ENV.KIPURSE_SAFE_REARM_MS??30*60e3));rearmTimer.unref?.();
  const {createUserDataEraser,mainnetEraseParts,createTombstones,applyTombstone}=await import(G+'src/v5/user-data.mjs');
  const TOMB=createTombstones({fs,file:overrides.tombstoneFile??ENV.KIPURSE_TOMBSTONE_FILE??join(DATA,'..','tombstones','erased.jsonl')});
  const ERASE=createUserDataEraser({kv:KV,tomb:TOMB,onErased:(w,t)=>{S.erasedAt=t;save();},enabled:(overrides.userErase??process.env.KIPURSE_USER_ERASE)==='1'||overrides.userErase===true,resolveTenant:async req=>PS.check(req)?{wallet:R.wallet,phone:PH}:null,
    parts:[{name:'tenant-index',forget:()=>{unindex();return {ok:true};}},{name:'safety',forget:()=>SAFE.forget(R.wallet)},{name:'executor-key',forget:()=>KR.forget(R.wallet)},{name:'withdraw',forget:()=>WD.forget()},...mainnetEraseParts({S,save,ownerPay:OPAY,phone:PH,ledgerCache:LED,limits:{forget:()=>{try{EVD.forget();}catch{}return LIM.forget();}},trustOwner:()=>O(),getDb:()=>E.ledger.db,agents,kv:KV})]});
  const LFEE=await import(G+'src/v5/limits-fee.mjs');
  const LIM=createPublicLimits({base:()=>PUBLIC,current:async()=>{const p=pol();return {single:p.single,daily:p.daily,term:p.term,end:S.permission.end};},
    plan:async c=>{const pl=await planCapChange(c);return {owner:R.owner,chainId:8453,human:pl.human,labels:pl.calls.map(x=>x.label),calls:[{to:R.wallet,value:'0x0',data:pl.walletExecuteBatch.data}],raw:pl};},
    confirm:pl=>confirmCapChange(pl),script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/limits.js');})(),
    // t603u/t604u: first limits authorization free (onboarding sponsorship, once per owner); later changes paid in USDC by the Base Account. Never ETH.
    // t763u (locked): first limits authorization is paid from the wallet like every later change (firstLimitsFree=false). Never sponsored.
    sponsor:async()=>null,
    _sponsorFirstLimitsRetired:async(id,pl)=>{const sp=SPONSOR_REF();if(!sp)return null;const sid=sp.registerFirstLimits(id,{owner:R.owner,wallet:R.wallet,calls:pl.calls});return sid?`${PUBLIC0}/onboard/new/paymaster?id=${sid}`:null;},
    fee:async pl=>limitsFeeQuote({data:pl.calls[0].data,walletPays:true}),
    refund:fee=>LFEE.feeRefundCall({wallet:R.wallet,token:X.token,owner:R.owner,fee}),
    feeQuote:async()=>{const q=await limitsFeeQuote({});const sp=SPONSOR_REF();void sp;return {...q,firstFree:false};},
    onConfirmed:({sponsored})=>{if(sponsored)SPONSOR_REF()?.markFirstLimitsDone(R.owner);}});
  async function limitsFeeQuote({data,walletPays=false}){const {limitsChangeFee}=await import(G+'src/v5/limits-fee.mjs');const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');
    const [gp,rd,bal,eg]=await Promise.all([pub.getGasPrice(),pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}),
      pub.readContract({address:X.token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[R.owner]}).catch(()=>null),
      data?pub.estimateGas({account:R.owner,to:R.wallet,data}).catch(()=>null):Promise.resolve(null)]);
    const wb=walletPays?await pub.readContract({address:X.token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[R.wallet]}).catch(()=>null):undefined;
    return limitsChangeFee({callGas:eg,gasPriceWei:gp,ethUsd8:rd[1],payerUSDC:bal,walletUSDC:wb});}
  const readJson=async req=>{const b=await rawBody(req);const t=String(req.headers['content-type']??'');
    if(t.includes('application/x-www-form-urlencoded'))return Object.fromEntries(new URLSearchParams(b));try{return b?JSON.parse(b):{};}catch{return {};}};
  // public agent surface: /mcp (Streamable HTTP, Bearer / X-API-Key agent token) + /v1/* only; anything else 404
  const ONB=createOnboarding({enabled:ONBOARD_ON,S,save,pub,wallet:R.wallet,owner:R.owner,trust:X.trust,token:X.token,chainId:8453,base:()=>PUBLIC,phone:PH,approverVersion:APPROVER_VERSION==='v3'?'v3':'v2',
    plan:c=>planCapChange(c),confirmPlan:pl=>confirmCapChange(pl),ownerPay:()=>OWNER_PAY,script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/onboard.js');})()});
  // per-tenant credential indexes (point lookups by hash; never a scan on a request path)
  const indexed=new Set();const ix=(kind,key)=>{if(!key)return;IDX.set(kind,key,R.wallet);indexed.add(kind+'\u0000'+key);};
  const reindex=()=>{for(const a of agents??[])if(!a.disabled&&a.tokenSha256)ix('agent',a.tokenSha256);const o=S.oauth??{};
    for(const m of [o.tokens,o.codes,o.pending,o.clients,o.refresh])for(const k of Object.keys(m??{}))ix('oauth',k);const a=PH.active();if(a?.x)ix('phone',a.x);};
  const unindex=()=>{for(const e of indexed){const [kind,key]=e.split('\u0000');if(IDX.get(kind,key)===String(R.wallet).toLowerCase())IDX.del(kind,key);}indexed.clear();};reindex();
  async function handle(req,res,u,j){
    try{if(u.pathname.startsWith('/onboard')){if(await ONB.handle(req,res,u,{readBody:readJson,ip:String(req.headers['cf-connecting-ip']??req.socket.remoteAddress??'')}))return;}
      if(u.pathname.startsWith('/.well-known/oauth-')||u.pathname.startsWith('/oauth/')||(req.method==='OPTIONS'&&u.pathname==='/mcp')){
        const ip=String(req.headers['cf-connecting-ip']??req.socket.remoteAddress??'');if(await OA.handle(req,res,u,{readBody:readJson,ip}))return;return j(404,{error:'not_found'});}
      if(u.pathname.startsWith('/phone/session')){const ip=String(req.headers['cf-connecting-ip']??req.socket.remoteAddress??'');if(await PS.handle(req,res,u,{readBody:readJson,ip}))return;}
      if(u.pathname.startsWith('/user/erase')){if(await ERASE.handle(req,res,u,{readBody:readJson}))return;}
      if(u.pathname.startsWith('/owner/pay')){const ip=String(req.headers['cf-connecting-ip']??req.socket.remoteAddress??'');if(await OPAY.handle(req,res,u,{readBody:readJson,ip}))return;}
      if(u.pathname.startsWith('/owner/emergency')){const ip=String(req.headers['cf-connecting-ip']??req.socket.remoteAddress??'');if(await EM.handle(req,res,u,{readBody:readJson,ip}))return;}
      if(u.pathname.startsWith('/owner/withdraw')){const ip=String(req.headers['cf-connecting-ip']??req.socket.remoteAddress??'');if(await WD.handle(req,res,u,{readBody:readJson,ip}))return;}
      if(u.pathname.startsWith('/owner/limits')){const ip=String(req.headers['cf-connecting-ip']??req.socket.remoteAddress??'');if(await LIM.handle(req,res,u,{readBody:readJson,ip}))return;}
      if(u.pathname.startsWith('/phone/onramp/applepay')&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});APAY??=(await import(G+'src/v5/onramp.mjs')).createApplePay({kv:KV,log:(e,d)=>{try{console.log(JSON.stringify({t:new Date().toISOString(),event:e,...d}));}catch{}}});const b=await readJson(req).catch(()=>({}));const ip=String(req.headers['cf-connecting-ip']??'');const w=R.wallet;const p=u.pathname.slice('/phone/onramp/applepay'.length);
        try{if(p===''||p==='/info')return j(200,APAY.info(w));if(p==='/verify/start'||p==='/order'){const g=await PGATE(R.owner,b?.lang==='zh'?'zh':String(req.headers['x-kp-lang']??'')==='zh'?'zh':'en');if(g)return j(g[0],g[1]);}if(p==='/verify/start'){const [st,o]=await APAY.verifyStart(w,b);return j(st,o);}if(p==='/verify/submit'){const [st,o]=await APAY.verifySubmit(w,b);return j(st,o);}if(p==='/order'){const [st,o]=await APAY.order(w,{amount:b?.amount,agreedAt:b?.agreedAt,clientIp:ip});return j(st,o);}if(p==='/status'){const [st,o]=await APAY.status(w,String(b?.ref??''));return j(st,o);}}catch{return j(502,{ok:false,error:'applepay_unavailable'});}return j(404,{error:'not_found'});}
      if(u.pathname==='/phone/onramp/status'&&req.method==='POST'){if(!(PS.checkRead?PS.checkRead(req):PS.check(req)))return j(401,{error:'phone_session_required'});// t864: read grant ok (status of a deposit to this wallet only)
      ONRAMP??=(await import(G+'src/v5/onramp.mjs')).createOnramp({kv:KV,log:(e,d)=>{try{console.log(JSON.stringify({t:new Date().toISOString(),event:e,...d}));}catch{}},balanceOf:a=>pub.readContract({address:X.token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[a]})});const b=await readJson(req).catch(()=>({}));const [st,out]=await ONRAMP.check(R.wallet,String(b?.ref??''));return j(st,out);}
      if(u.pathname==='/phone/onramp/session'&&req.method==='POST'){if(!(PS.checkRead?PS.checkRead(req):PS.check(req)))return j(401,{error:'phone_session_required'});// t864: any signed-in phone of this wallet; money only flows IN to R.wallet
      ONRLIM??=(await import(G+'src/v5/onramp.mjs')).sessionLimiter();if(!ONRLIM(R.wallet))return j(429,{ok:false,error:'slow_down'});
      ONRAMP??=(await import(G+'src/v5/onramp.mjs')).createOnramp({kv:KV,log:(e,d)=>{try{console.log(JSON.stringify({t:new Date().toISOString(),event:e,...d}));}catch{}},balanceOf:a=>pub.readContract({address:X.token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[a]})});const b=await readJson(req).catch(()=>({}));{const g=await PGATE(R.owner,String(req.headers['x-kp-lang']??'')==='zh'?'zh':'en');if(g)return j(g[0],g[1]);}const [st,out]=await ONRAMP.session(R.wallet,{amount:b?.amount,redirectUrl:b?.redirectUrl,clientIp:String(req.headers['cf-connecting-ip']??''),experience:b?.experience==='send'?'send':undefined});return j(st,out);}
      if(u.pathname==='/phone/push/register'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const b=await readJson(req).catch(()=>({}));const t=String(b?.token??'');if(!/^[0-9a-f]{32,200}$/i.test(t))return j(400,{error:'bad_token'});pushTokens(R.wallet).add(t,b?.lang);OBS.log('push_register',{enabled:PUSH.enabled});return j(200,{ok:true,pushEnabled:PUSH.enabled});}
      if(u.pathname.startsWith('/phone/')){if(await PH.handle(req,res,u,{readBody:readJson}))return;}
      if(u.pathname==='/approve/trust'||u.pathname.startsWith('/approve/trust/')||u.pathname==='/approve/trust.js'){const ip=String(req.headers['cf-connecting-ip']??req.socket.remoteAddress??'');if(await TA.handle(req,res,u,{readBody:readJson,ip}))return;}
      if(u.pathname==='/mcp'){const tok=String(req.headers.authorization??'').replace(/^Bearer\s+/i,'')||String(req.headers['x-api-key']??'');
        let a=agents?.length?resolveAgent(agents,tok):(fork&&req.headers['x-agent-id']?{id:String(req.headers['x-agent-id'])}:null);
        if(!a&&tok){const id=OA.agentForAccess(tok);if(id)a={id};}if(a)seen(a.id);
        if(!a)return j(401,{error:'invalid_token',error_description:'connect with OAuth (see WWW-Authenticate) or send your Kipurse agent token as Authorization: Bearer <token>'},{'www-authenticate':OA.challenge()+(tok?', error="invalid_token"':''),'access-control-expose-headers':'WWW-Authenticate, Mcp-Session-Id'});
        let body;if(req.method==='POST'){let b='';for await(const c of req){b+=c;if(b.length>1e6)return j(413,{error:'too_large'});}body=b?JSON.parse(b):undefined;}
        OBS.log('mcp',{});const server=MCP.acquire(a.id);const t=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});res.on('close',()=>{try{t.close();}catch{}MCP.release(a.id,server);});
        await server.connect(t);return await t.handleRequest(req,res,body);}
      if(u.pathname==='/everyday'&&req.method==='GET'){if(!PS.check(req))return j(401,{error:'phone_session_required'});return j(200,{...EVD.get(),why:EVERYDAY_WHY});}
      if(u.pathname==='/everyday/preview'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const b=await readJson(req).catch(()=>({}));const f=EVD.get().floor;try{return j(200,{...changeCost({next:{single:b?.single,daily:b?.daily},floor:f,firstFloorDone:true}),floor:f,why:EVERYDAY_WHY});}catch{return j(400,{error:'bad_amount'});}}
      if(u.pathname==='/everyday'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const b=await readJson(req).catch(()=>({}));let r;try{r=EVD.set({single:b?.single,daily:b?.daily,term:b?.term});}catch{r={ok:false,error:'bad_amount'};}OBS.log('everyday_set',{ok:!!r.ok,error:r.error??null});return j(r.ok?200:400,r);}
      if(u.pathname==='/safety/status'&&req.method==='GET'){if(!PS.check(req))return j(401,{error:'phone_session_required'});return j(200,{paused:SAFE.paused(R.wallet),choices:['24h','48h','7d','until_resume']});}
      if(u.pathname==='/safety/withdraw/quote'&&req.method==='GET'){if(!PS.check(req))return j(401,{error:'phone_session_required'});try{return j(200,await WD.quote());}catch(e){return j(503,{error:String(e?.code??'quote_failed')});}}
      if(u.pathname==='/safety/stop'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const b=await readJson(req).catch(()=>({}));const ms=pauseMsOf(b?.duration);if(ms===undefined)return j(400,{error:'bad_duration',choices:['24h','48h','7d','until_resume']});const p=SAFE.pause(R.wallet,'owner_stop',ms);OBS.log('safety_stop',{duration:String(b?.duration??'24h')});
        let chain=null;try{const r=await E0.pause();chain={paused:true,txHash:r.txHash,expiresAt:r.expiresAt};}catch(e){chain={paused:false,error:String(e?.code??'chain_pause_failed')};}
        return j(200,{ok:true,server:p,chain,note:p.until===null?'AI payments are stopped until you resume them. On chain the pause is renewed every day while it lasts.':'AI payments are stopped until '+new Date(p.until).toISOString()+'. On chain the pause is renewed while it lasts. You can resume early.'});}
      if(u.pathname==='/safety/holds'&&req.method==='GET'){if(!PS.check(req))return j(401,{error:'phone_session_required'});return j(200,{holds:E0.listHolds?.({all:u.searchParams.get('all')==='1'})??[]});}
      if(u.pathname==='/safety/holds/cancel'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const b=await readJson(req).catch(()=>({}));const r=E0.cancelHold?.(String(b?.id??''))??{ok:false};OBS.log('hold_cancel',{ok:!!r.ok});return j(r.ok?200:409,r);}
      if(u.pathname.startsWith('/siri/')&&req.method==='POST'){SIRI??=(await import(G+'src/v5/siri.mjs')).createSiriAgent(E);const b=await readJson(req).catch(()=>({}));const [st,out]=await SIRI.handle(u.pathname,b,{authed:PS.check(req),seen:id=>{seen(id);if(!S.siriAgent){S.siriAgent={since:new Date().toISOString()};save();}}});OBS.log('siri',{path:u.pathname,decision:out?.decision??null});return j(st,out);}
      if(u.pathname.startsWith('/safety/mandates')||u.pathname==='/safety/agents/stop'||u.pathname==='/safety/report'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const M=E0.mandates;
        if(u.pathname==='/safety/mandates'&&req.method==='GET'){const {BEGINNER_DEFAULTS,PURPOSES}=await import(G+'src/v5/mandates.mjs');const caps=new Map(M.agents().map(a=>[a.agentId,a]));
          const ags=[...(agents??[]).filter(a=>!a.disabled).map(a=>({id:a.id,name:a.name??a.id})),...Object.entries(S.oauthAgents??{}).filter(([,a])=>!a.revoked).map(([id,a])=>({id,name:a.name??id})),...(S.siriAgent?[{id:'siri',name:'Siri'}]:[])];
          const {CATEGORIES,purposeName}=await import(G+'src/v5/mandates.mjs');/* ONE LIMIT (t592u): no per-category setup; the wallet limit is the only limit */
          return j(200,{allowances:M.list(),overall:M.overall(),categories:CATEGORIES.map(k=>({key:k,zh:purposeName(k,true),en:purposeName(k,false)})),proposals:M.proposals(),agents:ags.map(a=>({...a,...(caps.get(a.id)??{stopped:false})})),defaults:[],purposes:Object.fromEntries(Object.entries(PURPOSES).map(([k,v])=>[k,{zh:v.zh,en:v.en}]))});}
        if(u.pathname==='/safety/mandates/draft'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));try{const p=M.propose({items:Array.isArray(b?.items)?b.items:[],by:'owner',reason:'owner app'});OBS.log('mandate_draft',{n:p.items.length});return j(200,p);}catch(e){return j(400,{error:e.code??'bad_items',detail:String(e.message).slice(0,200)});}}
        if(u.pathname==='/safety/mandates/approve'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));const a=PH.active();if(!a)return j(409,{error:'no_phone_signer'});
          const r=M.approve(String(b?.id??''),d=>{try{return p256VerifyDigest(a,d,String(b?.r??''),String(b?.s??''));}catch{return false;}});OBS.log('mandate_approve',{ok:!!r.ok,error:r.error??null});return j(r.ok?200:r.error==='not_owner'?403:409,r);}
        if(u.pathname==='/safety/mandates/reject'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));return j(200,M.reject(String(b?.id??'')));}
        if(u.pathname==='/safety/mandates/revoke'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));OBS.log('mandate_revoke',{});return j(200,M.revoke(String(b?.id??'')));}
        if(u.pathname==='/safety/agents/stop'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));const id=String(b?.agentId??'').slice(0,80);if(!id)return j(400,{error:'agent_required'});OBS.log('agent_stop',{});return j(200,M.agentStop(id,true));}
        if(u.pathname==='/safety/report'&&req.method==='GET'){const {spendingReport}=await import(G+'src/v5/buy.mjs');const q=Object.fromEntries(u.searchParams);return j(200,spendingReport(E0,{period:q.period,from:q.from,to:q.to,purpose:q.purpose,agent:q.agent,format:q.format}));}
        return j(404,{error:'not_found'});}
      if(u.pathname==='/safety/resume'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});
        /* NO-AI-TRUST: resuming AI payments needs a FRESH Face ID signature (phone signer) over a one-time server challenge */
        const b=await readJson(req).catch(()=>({}));const RC=(globalThis.__kpResumeCh??=new Map());const tnow=Date.now();for(const [k,v] of RC)if(tnow-v>300000)RC.delete(k);
        const {createHash:ch,randomBytes:rb}=await import('node:crypto');const txt=n=>`Kipurse resume v1\nwallet:${String(R.wallet).toLowerCase()}\nnonce:${n}`;const dg=n=>'0x'+ch('sha256').update(txt(n)).digest('hex');
        if(!b?.nonce||!b?.r||!b?.s){const n=rb(16).toString('hex');RC.set(n,tnow);return j(428,{error:'face_id_required',nonce:n,signText:txt(n),digest:dg(n)});}
        const n=String(b.nonce);if(!RC.has(n))return j(409,{error:'challenge_expired'});RC.delete(n);const a=PH.active();if(!a)return j(409,{error:'no_phone_signer'});
        let ok=false;try{ok=p256VerifyDigest(a,dg(n),String(b.r),String(b.s));}catch{}if(!ok){OBS.log('safety_resume',{ok:false});return j(403,{error:'not_owner'});}
        OBS.log('safety_resume',{ok:true});return j(200,SAFE.resume(R.wallet));}
      if(u.pathname.startsWith('/v1/'))return v1.emit('request',req,res);return j(404,{error:'not_found'});}catch(e){try{j(500,{error:'error'});}catch{}}
  }
  if(ownerSurface)await ownerSurface.listen();
  // t784: restored-from-backup data must not bring an erased user back (tombstones live outside data/, see user-data.mjs)
  try{const r=await applyTombstone({tomb:TOMB,wallet:R.wallet,erasedAt:S.erasedAt,erase:w=>ERASE.erase(w),mark:t=>{S.erasedAt=t;save();}});OBS.log('tombstone_check',{reason:r,count:TOMB.count()});}
  catch(e){OBS.log('tombstone_check',{reason:'error'});if(!fork&&ENV.KIPURSE_TOMBSTONE_STRICT!=='0')throw e;}
  return {wallet:R.wallet,rec,handle,saveState:()=>save(),reindex,unindex,PH,PS,OA,ONB,ERASE,OPAY,LIM,S,agents,engine:()=>engine,cfg,readState,ownerSurface,
    revocations:()=>reloadRevocations(KV,agents),close:()=>{try{ownerSurface?.close();}catch{}try{engine?.ledger?.db?.close?.();}catch{}}};}
  // ---- global (tenant-less) surface: wallet discovery + new-user onboarding ----
  const {p256VerifyDigest:pv}=await import(G+'src/v5/phone-signer.mjs');const {hashMessage}=await import('viem');
  const FIND_MSG=n=>'Kipurse find wallet v1\nnonce:'+n;
  const {createOnboardSponsor,sponsorConfig}=await import(G+'src/v5/onboard-sponsor.mjs');
  // sponsored first onboarding: ON only if the operator's env file set the paymaster URL (never logged); the URL is removed from the environment after reading
  const SPC=sponsorConfig(process.env);delete process.env.KIPURSE_ONBOARD_PAYMASTER_URL;
  const SPONSOR=ONBOARD_ON&&SPC.url?createOnboardSponsor({cfg:SPC,kv:KV,reg:REG,obs:OBS,chainId:8453,lookup:id=>KV.get(kvKey('onbnew',null,id)),
    ethUsd8:async()=>{const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');return (await pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}))[1];},gasPrice:()=>pub.getGasPrice()}):null;
  SPONSOR_HOLDER.v=SPONSOR;
  console.log(JSON.stringify({event:'onboard_sponsor_config',enabled:!!SPONSOR,maxPerDay:SPC.maxPerDay,maxUsdPerDay:SPC.maxUsdPerDay,maxUsdPerOp:SPC.maxUsdPerOp}));
  const V3NEW=(overrides.approverVersion??process.env.KIPURSE_PHONE_APPROVER)==='v3';
  const {verifyAttestation}=await import(G+'src/v5/app-attest.mjs');const AA_ID=process.env.KIPURSE_APP_ID??'YOUR_TEAM_ID.com.blessbridge.kipurse.app';
  // t796 M4: default 'sponsor' (free first setup only with a genuine-app attestation). The Debug/TestFlight bundle (.test) of the same team is accepted too.
  const AA_IDS=[AA_ID,AA_ID+'.test'];const APP_ATTEST={mode:process.env.KIPURSE_APP_ATTEST??'sponsor',verify:a=>{let r={ok:false,reason:'none'};for(const id of AA_IDS){r=verifyAttestation({...a,appId:id});if(r.ok)return r;}return r;},log:(k,v)=>OBS.log(k,v)};
  const NEW=createNewWalletOnboarding({appAttest:APP_ATTEST,verified:process.env.KIPURSE_REQUIRE_CBV==='0'?null:(o=>checkVerifiedMulti([pub,...String(process.env.KIPURSE_CBV_RPCS??'https://mainnet.base.org,https://base-rpc.publicnode.com').split(',').filter(Boolean).map(u=>createPublicClient({transport:http(u,{timeout:8000})}))],o,{log:x=>console.log(JSON.stringify({t:'cbv',...x}))})),enabled:ONBOARD_ON,sponsor:SPONSOR,executorFor:w=>KR.ensure(w),kv:KV,pub,cfg:{adapter:X.adapter,trust:X.trust,token:X.token,manager:X.manager,approverVersion:overrides.approverVersion??process.env.KIPURSE_PHONE_APPROVER},reg:REG,base:()=>PUBLIC0,chainId:8453,
    policy:()=>decodePolicyV5(permissionFromJson(X.currentPermission).extraData),quote:async(owner0)=>{const {ONBOARD_GAS,onboardFee}=await import(G+'src/v5/onboard.mjs');const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');
      const [gp,rd]=await Promise.all([pub.getGasPrice(),pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'})]);
      const f=onboardFee({gasPriceWei:gp,ethUsd8:rd[1]});const u=f.usdc>0n?f.usdc:1n;const w=u/1000000n,fr=(u%1000000n).toString().padStart(6,'0').replace(/0+$/,'');
      const base0={gas:String(ONBOARD_GAS),gasPriceWei:String(gp),feeWei:String(f.wei),feeUSDC:fr?`${w}.${fr}`:`${w}`,sponsoredByKipurse:false,signatures:1,transactions:1,
        limitsChangeUSDC:await (async()=>{try{const {limitsChangeFee}=await import(G+'src/v5/limits-fee.mjs');const {fmtUsdc}=await import(G+'src/v5/limits-public.mjs');return fmtUsdc(limitsChangeFee({callGas:null,gasPriceWei:gp,ethUsd8:rd[1]}).usdc);}catch{return null;}})(),gasToken:'USDC'};
      // fee-quote fix: always a string payer (the app requires it); balances only for a valid owner. Read failures (new/undeployed Base Account, RPC) never break the quote.
      let o=null;try{if(/^0x[0-9a-fA-F]{40}$/.test(String(owner0??'')))o=getAddress(owner0);}catch{}
      if(!o)return {...base0,payer:'',payerEthWei:null,payerUSDC:null,payerCanPayEth:false,payerCanPayUSDC:null};
      const [eth,bal]=await Promise.all([pub.getBalance({address:o}).catch(()=>null),pub.readContract({address:X.token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[o]}).catch(()=>null)]);
      return {...base0,payer:o,payerEthWei:eth===null?null:String(eth),payerUSDC:bal===null?null:String(bal),payerCanPayEth:eth!==null&&eth>=f.wei,payerCanPayUSDC:bal===null?null:bal>=u+(u/2n)};},
    script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/onboard-new.js');})(),
    tenantStart:async(w,b)=>(await getTenant(w)).ONB.start(b),tenantConfirm:async(w,id)=>{const t=await getTenant(w);const r=await t.ONB.confirm(id);t.reindex();return r;},
    register:async o=>{const rec=REG.add({wallet:o.wallet,owner:o.owner,vault:o.vault,ownerIndex:0,fromBlock:o.fromBlock,publicPath:'/t/'+String(o.wallet).toLowerCase(),permission:o.permission,createdAt:new Date().toISOString()});
      const F=recFiles(rec);const {fingerprint}=await import(G+'src/v5/phone-signer.mjs');
      const st={permission:o.permission,phone:{active:{approver:o.approver,x:o.x,y:o.y,...(V3NEW?{maxSingle:NO_CEILING,maxDaily:NO_CEILING,version:'v3'}:{maxSingle:o.choice.single,maxDaily:o.choice.daily,version:'v2'}),fingerprint:fingerprint(o.x,o.y),enrolledAt:new Date().toISOString()}}};
      {const ST=storeFor(o.wallet);ST.writeJson(F.state,st);ST.writeJson(F.agents,[]);}IDX.set('phone',o.x,o.wallet);OBS.log('tenant_created',{count:1});}});
  const {createSignin}=await import(G+'src/v5/signin.mjs');
  const SIGNIN=createSignin({kv:KV,pub,reg:REG,obs:OBS,onboard:NEW,base:()=>PUBLIC0,chainId:8453,phoneOf:async w=>(await CACHE.get(w))?.PH?.active()??null,
    script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/signin.js');})()});
  const GLOBAL_RL=Number(ENV.KIPURSE_RL_GLOBAL??100000);const RL_IP=createRateLimiter(KV,{perKey:Number(ENV.KIPURSE_RL_PER_IP??600),global:GLOBAL_RL});
  const RL_T=createRateLimiter(KV,{perKey:Number(ENV.KIPURSE_RL_PER_TENANT??1200),global:GLOBAL_RL});
  const revokeTimer=setInterval(async()=>{for(const t of TEN.values()){try{const n=(await t).revocations();if(n)OBS.log('agent_revocations_reloaded',{count:n});}catch{}}},Number(ENV.KIPURSE_REVOKE_POLL_MS??10000));revokeTimer.unref();
  const {createDeposit}=await import(G+'src/v5/deposit.mjs');
  const ONRAMP=await (async()=>{if(ENV.KIPURSE_ONRAMP!=='on')return null;const {loadCdpKey,createCoinbaseOnramp}=await import(G+'src/v5/onramp.mjs');const k=loadCdpKey(ENV.KIPURSE_CDP_KEY_FILE);if(!k){OBS.log('onramp_config',{enabled:false,reason:'no_key'});return null;}OBS.log('onramp_config',{enabled:true});return createCoinbaseOnramp({key:k});})();
  const DEPOSIT=createDeposit({purchaseGate:PGATE,reg:REG,token:X.token,chainId:8453,strayOf:async w=>{const {STRAY}=await import(G+'src/v5/deposit.mjs');const B=[{type:'function',name:'balanceOf',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}];const v=await Promise.all(STRAY.map(x=>x.addr?pub.readContract({address:x.addr,abi:B,functionName:'balanceOf',args:[w]}).catch(()=>0n):pub.getBalance({address:w}).catch(()=>0n)));return Object.fromEntries(STRAY.map((x,i)=>[x.sym,v[i]]));},onramp:ONRAMP,base:()=>PUBLIC0,usdcOf:a=>pub.readContract({address:X.token,abi:[{type:'function',name:'balanceOf',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'uint256'}]}],functionName:'balanceOf',args:[a]}),script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/deposit.js');})()});
  const {withLang}=await import(G+'src/v5/i18n.mjs');const {withSignCors}=await import(G+'src/v5/cors.mjs');const agentSrv=httpMod.createServer(withSignCors(withLang(OBS.wrap(createAgentRouter({reg:REG,index:IDX,kv:KV,obs:OBS,tenants:CACHE,legacy,env:ENV,verifyP256:pv,onboardNew:NEW,signin:SIGNIN,deposit:DEPOSIT,rl:{ip:RL_IP,tenant:RL_T}})))));
  if(legacy())await getTenant(legacy());
  // one-shot at startup (no cron): load every tenant so pending 10-minute holds are re-armed and due ones run without waiting for a request
  setTimeout(async()=>{let n=0;for(const rec of (REG.all?.()??[])){try{const t=await getTenant(rec.wallet);const due=t?.engine?.()?.pendingHoldsDue?.()??0;n+=due;}catch{}}OBS.log('holds_rearmed',{pending:n});},3000).unref?.();
  await new Promise(r=>agentSrv.listen(agentPort,'127.0.0.1',r));
  const T0=async()=>legacy()?await getTenant(legacy()):null;const t0=await T0();
  return {signin:SIGNIN,registry:REG,index:IDX,tenant:getTenant,newOnboard:NEW,phone:t0?.PH,phoneSession:t0?.PS,ownerPay:t0?.OPAY,limits:t0?.LIM,readState:t0?.readState,oauth:t0?.OA,state:t0?.S,engine:()=>t0?.engine(),cfg:t0?.cfg,
    ownerSurface:t0?.ownerSurface,agentSrv,ownerUrl:`http://localhost:${ownerPort}`,agentUrl:`http://127.0.0.1:${agentPort}`,kv:KV,obs:OBS,
    close:async()=>{clearInterval(revokeTimer);for(const t of TEN.values())try{(await t).close();}catch{}agentSrv.close();try{KV.close();}catch{}}};}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(new URL(import.meta.url).pathname)){
  const GO=process.env.KIPURSE_MAINNET_GO??(()=>{try{return JSON.parse(fs.readFileSync(join(CONF,'mainnet-trustflow.config.json'))).ownerDecision?.go}catch{return null}})();
  if(GO!=='owner-confirmed')throw Error('Owner has not said go. Refusing to start on Base mainnet.');
  const r=await startMainnet();console.log(JSON.stringify({mainnet:true,ownerPage:r.ownerUrl,loginLinkFile:join(DATA,'owner-login-url.txt'),agentApi:r.agentUrl}));}
