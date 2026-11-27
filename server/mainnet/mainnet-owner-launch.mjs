// OPERATOR LAYER: mainnet runtime for the universal trust flow + the owner signing page. Used by the real launch (launch.sh)
// and by the fork e2e (overrides). Reads NO key itself: the engine loads the session key file by path in userop mode.
import {checkVerifiedMulti} from '../src/v5/cb-verified.mjs';
import fs from 'node:fs';import {join} from 'node:path';import {createPublicClient,http,getAddress,parseAbi} from 'viem';import {base} from 'viem/chains';
// KIPURSE_GATEWAY / KIPURSE_MAIN_CONFIG_DIR / KIPURSE_MAIN_DATA_DIR let a server install keep code, config and state apart (defaults = this folder, as on the box)
const G=process.env.KIPURSE_GATEWAY??'./state';const HERE=new URL('.',import.meta.url).pathname;const CONF=process.env.KIPURSE_MAIN_CONFIG_DIR??HERE,DATA=process.env.KIPURSE_MAIN_DATA_DIR??HERE;
/* t1265: the defaults above put user data next to the code. A real start refuses unless BOTH dirs are set explicitly and lie outside the code
   tree (the gateway code root, kit/vault.mjs assertBoundary, and this launcher's folder); the at-rest key must not sit inside the data dir.
   The fork / test harness (startMainnet({fork:true}) or overrides.allowDataInCodeTree) is exempt. */
async function assertDataDirs(){const {assertBoundary,inside,CODE_ROOT}=await import(G+'kit/vault.mjs');const C=process.env.KIPURSE_MAIN_CONFIG_DIR,D=process.env.KIPURSE_MAIN_DATA_DIR;
  if(!C||!D)throw Error('BOUNDARY: set KIPURSE_MAIN_CONFIG_DIR and KIPURSE_MAIN_DATA_DIR (outside the code tree). Refusing to write user data into the code tree.');
  for(const d of [C,D])for(const root of [CODE_ROOT,HERE])if(inside(d,root))throw Error('BOUNDARY: '+(d===D?'KIPURSE_MAIN_DATA_DIR':'KIPURSE_MAIN_CONFIG_DIR')+' is inside the code tree');
  const kf=process.env.KIPURSE_DATA_KEY_FILE;if(kf)assertBoundary(D,kf,CODE_ROOT);const tk=process.env.KIPURSE_TOMBSTONE_KEY_FILE;if(tk)assertBoundary(D,tk,CODE_ROOT);}
// PRINCIPLES (src/v5/principles.mjs): refuse to boot if env/config contradicts an owner principle. Changes need an owner decision in the owner's decision log.
await (await import(G+"src/v5/principles.mjs")).assertPrinciples({env:process.env});
const {createEngineV5}=await import(G+'src/v5/engine.mjs');const {createV5HttpServer}=await import(G+'src/v5/http.mjs');
const {createOwnerSignSurface}=await import(G+'src/v5/owner-sign-surface.mjs');const {v5Abi,permissionFromJson,decodePolicyV5}=await import(G+'src/v5/abi.mjs');
const {buildMigrationPlanV5}=await import(G+'src/v5/plan.mjs');const {opsToday}=await import(G+'src/v5/userop.mjs');const {createV5Mcp}=await import(G+'src/v5/mcp.mjs');const {resolveAgent}=await import(G+'src/v4/agents.mjs');
const {StreamableHTTPServerTransport}=await import('@modelcontextprotocol/sdk/server/streamableHttp.js');const httpMod=await import('node:http');const {createOAuth,reserveOAuthAgent,replaceSiriAgent}=await import(G+'kit/oauth.mjs');const AGL=await import(G+'src/v5/agent-list.mjs');const {createPublicTrustApproval}=await import(G+'src/v5/trust-approve-public.mjs');const {createPhoneEnrollment,WALLET_ABI,p256VerifyDigest}=await import(G+'src/v5/phone-signer.mjs');const {createPhoneSession}=await import(G+'src/v5/phone-session.mjs');const {createPublicLimits}=await import(G+'src/v5/limits-public.mjs');
const {createRegistry,createIndex,resolveTenant,sha256,followMoved}=await import(G+'src/v5/tenancy.mjs');const {createOnboarding,onboardFee}=await import(G+'src/v5/onboard.mjs');
const {createNewWalletOnboarding}=await import(G+'src/v5/onboard-new.mjs');const {NO_CEILING}=await import(G+'src/v5/phone-signer.mjs');const {createTenantCache,createMcpPool,createAgentRouter,readRaw,readCapped}=await import(G+'src/v5/router.mjs');
const {createAnomalyGuard,guardEngine,pauseMsOf}=await import(G+'src/v5/anomaly.mjs');const {createPush,apnsConfigFromEnv}=await import(G+'src/v5/push.mjs');const {pushTokenList,registerPushToken}=await import(G+'src/v5/push-tokens.mjs');const {createOwnerWithdraw}=await import(G+'src/v5/owner-withdraw.mjs');const {createExecutorKeyring}=await import(G+'src/v5/executor-keys.mjs');const {plainStore,tenantStore,loadDataKey}=await import(G+'src/v5/at-rest.mjs');const {createRateLimiter,kvKey}=await import(G+'src/v5/store.mjs');
const rawBody=req=>readRaw(req);const MCP_MAX_BODY=65536;   // t1275: = router cap (src/v5/router.mjs)
const {operatorConstants,assertFeeToUsable}=await import(G+'src/v5/operator-constants.mjs');
// t1270: no built-in operator values in the open-source build: set "operatorConstants" {feeTo, paymasters, ownerPaymasters}
// in mainnet-trustflow.config.json (docs/ARCHITECTURE_LAYERS.md). Missing feeTo -> the launcher refuses to start.
const OPERATOR_DEFAULTS=Object.freeze({});
// MULTI-USER: one process serves many wallets. Global parts (RPC, KV, logs, registry, indexes, router, rate limits) + one runtime per tenant,
// built lazily from that tenant's own files (state, ledger DB, rules, agents) and kept in a bounded LRU. Workers are stateless between requests
// except for that cache; route a tenant to the same worker (tenant affinity, SCALING.md) or run one worker. The server never holds a user key.
export async function startMainnet({overrides={},stateFile=join(DATA,'runtime-state.json'),agentPort=8651,ownerPort=8671,fork=false}={}){
  if(!fork&&overrides.allowDataInCodeTree!==true)await assertDataDirs();
  const SPONSOR_HOLDER={v:null};const SPONSOR_REF=()=>SPONSOR_HOLDER.v;
  /* t635: purchases (Apple Pay / Onramp) need the wallet OWNER's Coinbase Verified Account attestation. Fail closed. */
  const {createPurchaseGate}=await import(G+'src/v5/purchase-gate.mjs');const CBV_PUBS=String(process.env.KIPURSE_CBV_RPCS??'https://mainnet.base.org,https://base-rpc.publicnode.com').split(',').filter(Boolean).map(u=>createPublicClient({transport:http(u,{timeout:8000})}));
  const PGATE=overrides.purchaseGate??createPurchaseGate({check:o=>checkVerifiedMulti(CBV_PUBS,o,{log:x=>console.log(JSON.stringify({t:'cbv_buy',...x}))}),log:(k,v)=>OBS.log(k,v)});
  const X=JSON.parse(fs.readFileSync(join(CONF,'mainnet-trustflow.config.json')));
  const OP=operatorConstants(X.operatorConstants,OPERATOR_DEFAULTS);
  assertFeeToUsable(process.env.KIPURSE_WITHDRAW_FEE_TO,'KIPURSE_WITHDRAW_FEE_TO');   // t1346: the old placeholder / ops account can never come back through env   // t1270: official fee address + ledger paymasters (operator config)
  /* t1197 (decision 92): NEW wallets open on the V5.3 suite (mainnet/v53-suite.json, checked on chain at start); the owner's wallet 0x5150 and every
     wallet registered before have no `suite` in their record and stay on V5.2 (X.adapter / X.trust) exactly as before. */
  const V53FILE=(()=>{try{return JSON.parse(fs.readFileSync(new URL('./v53-suite.json',import.meta.url)));}catch{return null;}})();
  /* t1214 (decision 102): after the owner-signed migration landed, the operator wallet runs on V5.4 ONLY when KIPURSE_V54_SUITE_WALLET names it
     (default unset = every wallet exactly as before). The V5.4 permission comes from the migration record and must be valid on chain. */
  const V54W=String(process.env.KIPURSE_V54_SUITE_WALLET??'').trim().toLowerCase();
  // t1238 decision 109: a wallet moved to a key seat records suite v5.4 (with its own adapter + trust)
  /* t1250 (decision 119): V5.5 wallets (record suite 'v5.5', opened by the owner-signed V5.4 -> V5.5 move) run on V5.5 ONLY when KIPURSE_V55=1; with the
     flag off a 'v5.5' record is treated exactly as any unknown suite was before (V5.2) and nothing V5.5 is imported. V54LIKE = the V5.4-style
     owner signer grants / trusted-merchant list, which V5.5 keeps (same ABI, V5.5 domain). */
  const V55ON=String(process.env.KIPURSE_V55??'').trim()==='1';const V54LIKE=n=>n==='v5.4'||(V55ON&&n==='v5.5');
  const suiteOf=rec=>(rec?.suite==='v5.3'||rec?.suite==='v5.4')&&rec.adapter&&rec.trust?{name:rec.suite,adapter:getAddress(rec.adapter),trust:getAddress(rec.trust)}:{name:'v5.2',adapter:X.adapter,trust:X.trust};
  const suiteOf55=rec=>V55ON&&rec?.suite==='v5.5'&&rec.adapter&&rec.trust?{name:'v5.5',adapter:getAddress(rec.adapter),trust:getAddress(rec.trust)}:suiteOf(rec);
  const suiteOf54=rec=>V54W&&rec&&String(rec.wallet).toLowerCase()===V54W?{name:'v5.4',adapter:getAddress('0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa'),trust:getAddress('0x22eF1633252653932076cB911b155F9D7f73A9E9')}:suiteOf55(rec);   // t1214 (t1250: suiteOf55 = suiteOf unless KIPURSE_V55=1)
  const {rpcTransport,rpcUrls}=await import(G+'src/v5/rpc.mjs');const {createSqliteKV,createMemoryKV}=await import(G+'src/v5/store.mjs');const {createObs}=await import(G+'src/v5/obs.mjs');
  const rpc=overrides.rpc??(process.env.KIPURSE_RPC_URLS?rpcUrls(process.env.KIPURSE_RPC_URLS):X.engine.rpcUrls??X.engine.rpc);const pub=createPublicClient({chain:base,transport:rpcTransport(rpc)});
  const {sealKV,scrubUrls}=await import(G+'src/v5/store.mjs');const DATA_KEY0=overrides.dataKey??loadDataKey(process.env.KIPURSE_DATA_KEY_FILE);
  /* t1265: personal-data KV values (push tokens, read grants, onramp email / phone, sign-in + setup records, signer grants) are sealed with a
     per-tenant subkey of the at-rest data key when one is configured (store.mjs sealKV); without a key the KV is unchanged. */
  const KV=sealKV(overrides.kv??(fork?createMemoryKV():createSqliteKV({file:overrides.kvFile??join(DATA,'kv.sqlite')})),DATA_KEY0);const OBS=createObs({release:(()=>{try{return fs.readFileSync(new URL('../../RELEASE',import.meta.url),'utf8').trim();}catch{return '';}})()});
  /* t1280 Q1 (decision 140): one stray rejected promise must not stop the gateway for every wallet (Node >= 15 exits on it); log a code only, keep serving */
  if(!globalThis.__kpUnhandled){globalThis.__kpUnhandled=true;process.on('unhandledRejection',e=>{try{OBS.log('unhandled_rejection',{reason:String(e?.code??'internal_error').slice(0,40)});}catch{}});}
  if(await pub.getChainId()!==8453)throw Error('not Base mainnet');
  // key isolation: the session key file must be private to the service user (checked by mode only; the file is never read here or logged)
  if(!fork&&!overrides.session&&X.engine?.sessionKeyFile){const st=fs.statSync(X.engine.sessionKeyFile);if(st.mode&0o077)throw Error('session key file must be mode 0600 (no group/other access)');}
  const PUBLIC0=overrides.publicBase??X.publicBase??'https://pay.kipurse.com';const ENV=process.env;
  // t1097: remember the onboarding paymaster URL only so the limits proxy can refuse to reuse it. Never logged.
  const ONBOARD_PM_URL=String(ENV.KIPURSE_ONBOARD_PAYMASTER_URL??'');
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
  // t1239 decision 109: requests without a wallet in the URL went to the legacy wallet; once it moved away (retired), they go to the wallet it moved to
  const legacyRoute=()=>followMoved(legacy(),a=>REG.get(a));   // t1251 (decision 120): follow every move (0x5150 -> V5.4 -> V5.5), not just one hop
  const recFiles=r=>{const d=TDIR(r.wallet);fs.mkdirSync(d,{recursive:true,mode:0o700});const f=r.files;
    return {state:f?.state??join(d,'state.json'),ledgerCache:f?.ledgerCache??join(d,'ledger.json'),agents:join(d,'agents.json'),
      engine:f?{...(f.engine??{})}:{ledgerFile:join(d,'ledger.sqlite'),ownerRulesDir:join(d,'rules'),trustRequestsFile:join(d,'rules','trust-requests.json')}};};
  const DATA_KEY=DATA_KEY0;const storeFor=w=>DATA_KEY?tenantStore(DATA_KEY,w):plainStore;
  const SAFE=createAnomalyGuard({kv:KV,maxPays:Number(ENV.KIPURSE_SAFE_MAX_PAYS_10MIN??30),maxDaily:Number(ENV.KIPURSE_SAFE_MAX_PAYS_DAY??200),maxNewPayees:Number(ENV.KIPURSE_SAFE_MAX_PAYEES_10MIN??8),onPause:(w,reason)=>OBS.log('safety_pause',{reason})});
  // Migration switch: when on, the next limits change the OWNER signs (Base Account) names this wallet's own executor key. Off by default.
  const PER_USER_EXEC=(overrides.perUserExecutor??ENV.KIPURSE_PER_USER_EXECUTOR)==='1'||overrides.perUserExecutor===true;
  const KR=createExecutorKeyring({dir:overrides.executorDir??join(DATA,'executors'),dataKey:DATA_KEY,allowPlain:!!fork||!!overrides.allowPlainExecutorKeys});
  const PUSH=createPush({config:apnsConfigFromEnv(ENV),log:(n,d)=>OBS.log(n,d)});
  /* t1265: ONE tombstone file for every wallet, HMAC-keyed (KIPURSE_TOMBSTONE_KEY_FILE, else a subkey of the data key; old v1 lines still match). */
  const UD=await import(G+'src/v5/user-data.mjs');const TOMB_KEY=overrides.tombstoneKey??await UD.tombstoneKey({file:ENV.KIPURSE_TOMBSTONE_KEY_FILE||null,dataKey:DATA_KEY});
  if(!TOMB_KEY)OBS.log('tombstone_key',{keyed:false});
  const TOMB_OLD=ENV.KIPURSE_TOMBSTONE_KEY_FILE&&DATA_KEY?[await UD.tombstoneKey({dataKey:DATA_KEY})]:[];   // tombstones written before a dedicated key file existed still match
  const TOMB_G=UD.createTombstones({fs,key:TOMB_KEY,oldKeys:TOMB_OLD,file:overrides.tombstoneFile??ENV.KIPURSE_TOMBSTONE_FILE??join(DATA,'..','tombstones','erased.jsonl')});
  /* t1265 (5.1.1(v)): erase of a wallet the owner moved away from (retired; never built, its permission is revoked on chain): file-level erase
     (user-data.mjs eraseRetiredWallet) + tombstone + registry record marked erased (the owner <-> wallet link itself is an on-chain fact). */
  async function eraseRetired(rec,{tombstone=true,at=null}={}){const F=recFiles(rec);
    const done=await UD.eraseRetiredWallet({wallet:rec.wallet,fs,store:storeFor(rec.wallet),files:F,kv:KV,index:IDX,parts:[{name:'safety',forget:w=>SAFE.forget(w)},{name:'executor-key',forget:w=>KR.forget(w)}]});
    let t=at??Date.now();if(tombstone){try{t=TOMB_G.add(rec.wallet).t;}catch{}}REG.update(rec.wallet,{erasedAt:t,createdAt:undefined,migratedAt:undefined});OBS.log('erase_retired_wallet',{parts:done.length});return done;}
  // t1239 decision 109: the phone's push registration follows a wallet move (the app only re-uploads when its token changes); never overwrites the new wallet's own list
  /* t1246 (decision 116 F11): copy the old wallet's push tokens to the moved wallet ONCE (flag on the new wallet). Startup used to re-copy whenever the
     new list was empty, bringing back tokens pruned after APNs 410 or removed on purpose. */
  /* t1265: MOVE, not copy: after the one-time copy the old wallet's list is deleted (a retired wallet is never served, so its copy was only
     personal data the erase could not reach). */
  const copyPush=(from,to)=>{try{const t=String(to).toLowerCase(),a=kvKey('push',String(from).toLowerCase(),'tokens'),b=kvKey('push',t,'tokens'),f=kvKey('push',t,'moved');if(KV.get(f)){try{KV.del(a);}catch{}return;}const o=KV.get(a)??[];if(o.length&&!(KV.get(b)??[]).length){KV.put(b,o);OBS.log('push_moved',{count:o.length});}KV.put(f,{from:String(from).toLowerCase(),at:Date.now()});try{KV.del(a);}catch{}}catch{}};
  const pushTokens=w=>pushTokenList(KV,kvKey('push',String(w).toLowerCase(),'tokens'));/* t1243 decision 113: src/v5/push-tokens.mjs (new token replaces this phone's previous one) */
  const CACHE=createTenantCache({reg:REG,load:rec=>buildTenant(rec),max:Number(ENV.KIPURSE_MAX_TENANTS_IN_MEMORY??500)});const TEN={values:()=>CACHE.values(),get size(){return CACHE.size();}};
  const getTenant=w=>CACHE.get(w);
  /* t1214: V5.4 owner signer grants (flag KIPURSE_V54_SIGNER_TRUST=1 AND suite v5.4; else nothing is wired and signed orders behave as before). */
  /* t1241 decision 111: the attestor ("[zh]") for layered merchant trust - a SEPARATE service (mainnet/attestor-server.mjs) on a unix socket; OFF unless
     KIPURSE_ATTESTOR_SOCKET is set (or a fork test passes overrides.attestor). Only V5.4 wallets with the signer-grant flag ever use it. */
  const ATTC=overrides.attestor??(ENV.KIPURSE_ATTESTOR_SOCKET?(await import(G+'src/v5/attestor-client.mjs')).createAttestorClient({socketPath:ENV.KIPURSE_ATTESTOR_SOCKET}):null);
  async function v54Grant(R){const ST=await import(G+'src/v5/signer-trust-v54.mjs');if(!ST.enabled(ENV))return {};
    const GS=ST.createGrantStore({get:k=>KV.get(k)??undefined,set:(k,v)=>KV.put(k,v)});
    return {signerGrant:async({account,signer,order,nowS})=>{if(String(account).toLowerCase()!==String(R.wallet).toLowerCase())return null;
      if(!order?.payer||String(order.payer).toLowerCase()!==String(account).toLowerCase())return null;   // V5.4 grant path only for orders bound to this wallet
      const g=GS.bySigner?.(account,signer);if(!g||Number(g.expiry)<=Number(nowS)+60||!g.signers.map(x=>String(x).toLowerCase()).includes(String(signer).toLowerCase()))return null;
      return {bytes:g.grant,merchant:g.merchant,single:g.single,daily:g.daily};}};}
  /* t1250 (V5.5 + flag only): engine hooks of a V5.5 wallet. priorPurchaseUsed = purchases its previous wallet(s) already paid on V5.4 (record
     movedFrom); afterX402Settled = markSettled right after each x402 settlement (R2-02) from an ORDINARY account: the keeper key in
     KIPURSE_V55_KEEPER_KEY_FILE (0600 JSON {key}, holds a little ETH, nothing else). No keeper -> settleRoutine only (logged). */
  async function v55Engine(R){const SV=await import(G+'src/v5/suite-v55.mjs');const out={};
    out.inlineTrustFor=async payee=>KV.get('v55inline:'+String(R.wallet).toLowerCase()+':'+String(payee).toLowerCase())??null;   // the owner's kind-6 KPTR trusts (owner-ask "trust")
    /* t1268: the engine found this cached inline trust stale (the merchant's on-chain epoch moved on: untrust / epoch bump): drop the KV copy, but only
       if it is still the entry the engine judged (same merchant + epoch), so a newer trust written meanwhile is never removed. */
    out.onStaleInlineTrust=({payee,merchant,epoch}={})=>{try{const k='v55inline:'+String(R.wallet).toLowerCase()+':'+String(payee).toLowerCase();const e=KV.get(k);if(e&&(merchant==null||String(e.merchant??'').toLowerCase()===String(merchant).toLowerCase())&&(epoch==null||String(e.epoch??0)===String(epoch))){KV.del(k);OBS.log('v55_inline_stale_dropped',{count:1});}}catch{}};
    const prior=[].concat(R.movedFrom?[{adapter:SV.V54.adapter,account:R.movedFrom}]:[]);if(prior.length)out.priorPurchaseUsed=SV.createPriorPurchaseCheck({pub,prior});
    const kf=String(process.env.KIPURSE_V55_KEEPER_KEY_FILE??'').trim();
    /* t1252 (decision 121, owner: no ETH, the wallet pays in USDC): the vault closes each settled x402 reservation itself (UserOp, USDC gas via Circle,
       paid from the allowance the cap-sized gas permits leave). The ETH keeper below is used ONLY if an operator configures it explicitly. */
    if(!kf){out.markSettledInline=true;out.permitAtCap=true;OBS.log('v55_settle_mode',{mode:'vault_usdc'});}
    else if(kf&&fs.existsSync(kf)&&(fs.statSync(kf).mode&0o777)===0o600){const {privateKeyToAccount}=await import('viem/accounts');const {createWalletClient}=await import('viem');
      const acct=privateKeyToAccount(JSON.parse(fs.readFileSync(kf,'utf8')).key);const wc=createWalletClient({chain:base,transport:rpcTransport(rpc),account:acct});
      const SY=SV.createSettleSyncV55({pub,adapter:R.adapter??SV.V55.adapter,send:async({to,data})=>({hash:await wc.sendTransaction({to,data})}),log:(k,v)=>OBS.log(k,v)});
      out.afterX402Settled=async a=>{const r=await SY.afterSettlement(a);OBS.log('v55_after_settle',{state:r.state});return r;};}
    else OBS.log('v55_keeper_unusable',{});
    return out;}
  async function buildTenant(rec){let SU=suiteOf54(rec);/* t1197 decision 92: this wallet's contract suite (V5.2 unless its record says V5.3) */const F=recFiles(rec);const ST=storeFor(rec.wallet);const st=ST.readJson(F.state,{});
    const R={...rec,state:st,save:()=>ST.writeJson(F.state,st),
      agents:ST.readJson(F.agents,[]),engineFiles:F.engine,ledgerCacheFile:F.ledgerCache,fromBlock:rec.fromBlock??0};
    if(!R.state.permission)R.state.permission=rec.permission??(rec.publicPath===''?X.currentPermission:undefined);if(!R.state.permission)throw Error('tenant has no permission');
    /* t1214 (decision 102): only if the owner-signed switch to V5.4 happened (migration record in KV, written by the flag-gated /migrate-v54 flow):
       suite v5.4 (KIPURSE_V54_SUITE_WALLET) -> the V5.4 permission + V5.4 vault, each checked on chain; after a rollback -> the re-approved
       V5.2 permission. No record (today, prod) -> nothing here runs and everything is exactly as before. */
    {const m=KV.get(kvKey('migrate54',String(R.wallet).toLowerCase(),'record'));if(m){const ok=async q=>{try{return !!q&&await pub.readContract({address:X.manager,abi:v5Abi,functionName:'isValid',args:[permissionFromJson(q)]});}catch{return false;}};
      if(SU.name==='v5.4'&&await ok(m.newPermission)){R.state.permission=m.newPermission;R.oldVault=R.vault;R.vault=getAddress(await pub.readContract({address:SU.adapter,abi:parseAbi(['function vaultAddress(address) view returns (address)']),functionName:'vaultAddress',args:[R.wallet]}));}
      else{if(SU.name==='v5.4'){OBS.log('v54_suite_skipped',{reason:'no_valid_v54_permission'});SU=suiteOf(null);}
        if(!await ok(R.state.permission)&&await ok(m.rollback?.v52Permission))R.state.permission=m.rollback.v52Permission;}}}
    const TPUBLIC=PUBLIC0+(rec.publicPath??('/t/'+String(rec.wallet).toLowerCase()));
    /* t1262 (decision 132): a failed history scan is logged (at most once a minute per wallet), never silently shown as "no records" */
    let ledFailAt=0;const ledFail=e=>{if(Date.now()-ledFailAt<60e3)return;ledFailAt=Date.now();OBS.log('ledger_scan_failed',{error:scrubUrls(e?.shortMessage??e?.message??e).slice(0,80)});};
    const {createLedger}=await import(G+'src/v5/ledger.mjs');const LED=createLedger({pub,token:X.token,wallet:R.wallet,vault:R.vault,paymasters:OP.paymasters,names:{[String(R.owner).toLowerCase()]:'你的 Base Account'}/* zh ledger text; the app shows its own English */,owner:R.owner,ownerPaymasters:OP.ownerPaymasters,feeTo:OP.feeTo/* t1129: official fee address (fixed); wallet-paid network fees show as fee rows */,fromBlock:R.fromBlock,file:R.ledgerCacheFile});
  const S=R.state;const save=R.save;
  const valid=p=>pub.readContract({address:X.manager,abi:v5Abi,functionName:'isValid',args:[permissionFromJson(p)]});
  if(!await valid(S.permission))throw Error('stored permission is not valid on chain for tenant');
  const agents=R.agents;
  
  {const {applyAgentRevocations}=await import(G+'src/v5/user-data.mjs');applyAgentRevocations(S,agents);}
  const {reloadRevocations}=await import(G+'src/v5/user-data.mjs');reloadRevocations(KV,agents);
  // multi-instance: an erase on another worker reaches this one within KIPURSE_REVOKE_POLL_MS (default 10 s)
  const revokeTimer=null&&setInterval(()=>{try{const n=reloadRevocations(KV,agents);if(n)OBS.log('agent_revocations_reloaded',{count:n});}catch{}},Number(process.env.KIPURSE_REVOKE_POLL_MS??10000)); // tokens revoked by a past erase stay revoked
  const cfg={...X.engine,...(SU.name==='v5.3'?{adapter:SU.adapter,trust:SU.trust}:{}),...overrides,...(SU.name==='v5.4'?{adapter:SU.adapter,trust:SU.trust,...await v54Grant(R)}:{}),...(V55ON&&SU.name==='v5.5'?{adapter:SU.adapter,trust:SU.trust,...await v54Grant(R),...await v55Engine(R)}:{}),...R.engineFiles,rpc,atRest:DATA_KEY?ST:undefined,permission:S.permission,ownerSigner:{wallet:R.wallet,ownerIndex:R.ownerIndex??0}};delete cfg.agents;
  delete cfg.attestor;if(V54LIKE(SU.name)&&typeof cfg.signerGrant==='function'&&ATTC)cfg.attestor=ATTC;/* t1241: layered trust only with V5.4 + grant hook + attestor */
  cfg.ownerNotify=ev=>{if(ev&&['auto_paid','merchant_paused'].includes(ev.kind))PUSH.notify(pushTokens(R.wallet),ev).catch(()=>{});};
  // t766: Kipurse dues (fronted onboarding gas etc.) are collected from AI payments too, to the ops account via the vault's owner-set fee slot
  cfg.dues={to:OP.feeTo,get:()=>SPONSOR_REF()?.dues?.(R.wallet)??0n,paid:n=>{SPONSOR_REF()?.payDue?.(R.wallet,BigInt(n));},blocked:why=>{try{console.log(JSON.stringify({event:'dues_not_collected',reason:why}));}catch{}}};cfg.trustApprovalBase=TPUBLIC+'/approve/trust';if(overrides.session)delete cfg.sessionKeyFile;fs.mkdirSync(cfg.ownerRulesDir,{recursive:true,mode:0o700});
  cfg.onAnomaly=reason=>{try{SAFE.pause(R.wallet,reason,null);}catch{}let open=0;try{open=engine?.openReservations?.()?.length??0;}catch{}OBS.log('anomaly_open_reservations',{count:open});/* t1278 C2: paused -> no open authorization is handed out; the app lists them via /safety/status */PUSH.notify(pushTokens(R.wallet),{kind:'anomaly',reason}).catch(()=>{});};
  cfg.onAgentPause=reason=>{try{SAFE.pause(R.wallet,reason,null);}catch{}PUSH.notify(pushTokens(R.wallet),{kind:'anomaly',reason}).catch(()=>{});};
  cfg.onHold=h=>{PUSH.notify(pushTokens(R.wallet),{kind:'hold',id:h.id,name:h.name??'收款方 / payee',amount:h.amountText}).catch(()=>{});};
  cfg.onMandateProposal=v=>{if(v?.ask){const h=v.items?.[0]?.human??{};PUSH.notify(pushTokens(R.wallet),{kind:'owner_ask',id:v.id,dup:h.dup===true,zh:String(h.zh??'').slice(0,220),en:String(h.en??'').slice(0,220)}).catch(()=>{});return;}/* t1170 decision 82: 'do you know this payee?' card */const hs=(v.items??[]).map(i=>i.human??{});const more=hs.length>1?` (+${hs.length-1})`:'';/* RT-6: the push shows every item's text, never just the first */PUSH.notify(pushTokens(R.wallet),{kind:'mandate',id:v.id,zh:('AI 请求：'+hs.map(h=>h.zh??'').join('；')).slice(0,180)+more,en:('AI asks: '+hs.map(h=>h.en??'').join('; ')).slice(0,180)+more}).catch(()=>{});};
  cfg.onPayeeConfirm=ev=>{PUSH.notify(pushTokens(R.wallet),{kind:'payee_confirm',...ev}).catch(()=>{});};
cfg.isPaused=()=>!!SAFE.paused(R.wallet);cfg.blacklistFile=join(DATA,'scam-blacklist.json');
  let engine=null;const boot=()=>{cfg.permission=S.permission;
    // per-user executor: use this wallet's own key when its permission names it; otherwise the legacy shared session key (migration pending)
    if(!overrides.session){try{cfg.session=KR.accountFor(R.wallet,S.permission);cfg.executorMode='per_user';}catch{delete cfg.session;cfg.executorMode='shared_legacy';}}
    engine=createEngineV5(cfg,{ledgerFile:R.engineFiles.ledgerFile??overrides.ledgerFile??cfg.ledgerFile});};boot();
  const E0=new Proxy({},{get:(_,k)=>engine[k]});const E=guardEngine(E0,{guard:SAFE,wallet:R.wallet});const O=()=>cfg.__trustRequestsOwner;
  const pol=()=>decodePolicyV5(permissionFromJson(S.permission).extraData);const target=BigInt(R.targetSingle??decodePolicyV5(permissionFromJson(S.permission).extraData).single);
  const {createEverydayLimits,changeCost,EVERYDAY_WHY,consentSpend,everydayDigest}=await import(G+'src/v5/everyday-limits.mjs');
  const everyKV={get:k=>KV.get(k),set:(k,v)=>KV.put(k,v),del:k=>KV.del(k)};const everyKey=kvKey('everyday',null,String(R.wallet).toLowerCase());
  const EVD=createEverydayLimits({kv:everyKV,wallet:R.wallet,scope:{chainId:8453,token:X.token},floor:()=>{const p=pol();return {single:p.single,daily:p.daily,term:p.term};}});cfg.everydayCheck=a=>EVD.check(a);cfg.everydayGet=()=>EVD.get();cfg.everydayScope=()=>EVD.scope();/* t1181 decision 84: limits pinned to Base + USDC */
  const chainNow=async()=>Number((await pub.getBlock()).timestamp);
  async function planCapChange(choice){const {limitsWindow,subCapsOrThrow}=await import(G+'src/v5/limits-public.mjs');const cur=S.permission,cp=pol();const mn=(a,b)=>(BigInt(a)<BigInt(b)?BigInt(a):BigInt(b)).toString();const fc=await pub.readContract({address:SU.adapter,abi:v5Abi,functionName:'fees'});
    const ppm=await pub.readContract({address:fc,abi:v5Abi,functionName:'feePpm'});
    return buildMigrationPlanV5({chainId:8453,wallet:R.wallet,owner:R.owner,adapter:SU.adapter,trust:SU.trust,token:X.token,manager:X.manager,
      executor:overrides.capExecutor??(PER_USER_EXEC?KR.ensure(R.wallet):cp.executor),guardian:cp.guardian,registry:cp.registry,headroom:false,maxFeePpm:cp.maxFeePpm,maxNetworkFee:cp.maxNetworkFee,fee:{ppm:String(ppm)},
      stated:choice?{single:choice.single.toString(),daily:choice.daily.toString(),term:choice.term.toString(),...subCapsOrThrow(choice,cp)/* t1281 (decision 141 (1)): the ONE stranger formula; explicit owner values replace the old ratchet-down min */}
        :{single:target.toString(),daily:cp.daily,term:cp.term,openSingle:cp.openSingle,openDaily:cp.openDaily,verifiedSingle:cp.verifiedSingle,verifiedDaily:cp.verifiedDaily},
      ...limitsWindow(await chainNow(),choice?.days,cur.end),salt:BigInt(cur.salt)+1n,revoke:[cur],zeroReserve:{vault:R.vault,buffer:0},
      ...(await opsChoice(choice))});}
  /* t1185 decision 85: the owner's daily on-chain operations ride in the same owner-signed batch (V5.3 vaults only) */
  async function opsChoice(choice){if(choice?.opsPerDay===undefined)return {};const t=await opsToday({pub,vault:R.vault});
    if(!t.supported)throw Object.assign(Error('OPS_CAP_UNSUPPORTED: this wallet\'s vault has no daily operations setting (it needs the V5.3 wallet migration)'),{code:'ops_cap_unsupported'});
    return {opsPerDay:choice.opsPerDay,opsVault:R.vault};}
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
  // t1158 (decision 77 C): Siri-scoped revocable credential (issued on the signed Siri approval; only POST /siri/buy accepts it)
  const {createSiriCred}=await import(G+'src/v5/siri-cred.mjs');const SC=createSiriCred({store:S,save,phoneFp:()=>PH.active()?.fingerprint??null,log:(k,v)=>OBS.log(k,v)});
  const OA=createOAuth({S,save,base:()=>PUBLIC,network:'main',log:(k,v)=>OBS.log(k,v),wallet:R.wallet,ownerAddress:R.owner,onForget:k=>forgetIdx('oauth',k),   // t1265: idx:oauth:* goes with its object
    consentScript:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/consent.js');})(),
    spendAuthorization:()=>{try{return consentSpend(EVD.get());}catch{return {authorized:false};}},
    everydayView:()=>EVD.get(),
    approveExtras:name=>name==='Siri'?{siriCredential:SC.issue()}:null,   // t1158: new Siri approval replaces any older credential   // t1157: phone-decide returns the saved AI limits so the app never keeps a stale 'not set' view
    commitSpend:(amounts)=>{const prior=everyKV.get(everyKey);const r=EVD.set({single:amounts.single,daily:amounts.daily,term:amounts.total});if(!r.ok)return r;const view=consentSpend(EVD.get());
      return {ok:true,limits:{perPayment:view.perPayment,perDay:view.perDay,termTotal:view.termTotal,at:view.at??null},undo(){if(prior===undefined)EVD.forget();else everyKV.set(everyKey,prior);}};},
    onConnected:name=>{if(name==='Siri'){S.siriAgent={since:new Date().toISOString()};save();}},
    ownerSession:()=>null,ownerAuth:req=>PS.check(req),   // t1275: /oauth/owner-decide deny needs the phone session (or a Base Account decline signature)
    // Face ID approval by the ENROLLED phone key (KipursePhoneApprover), re-checked on chain at every decision. Base Account stays as the alternative.
    phoneApprover:{active:()=>PH.active(),verify:(a,d,r,s)=>p256VerifyDigest(a,d,r,s),
      onChain:overrides.phoneOnChain??(async a=>!!await pub.readContract({address:R.wallet,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[a.approver]}))},
    verifyOwner:overrides.verifyOwner??((message,signature)=>pub.verifyMessage({address:R.owner,message,signature})),
    isAgentLive:id=>!!S.oauthAgents[id]&&!S.oauthAgents[id].revoked,
    createAgentKey:(name,kind,clientId)=>{
      if(name==='Siri'||kind==='siri'){const r=replaceSiriAgent(S.oauthAgents,{kind,clientId,knownIds,revoke:k=>OA.revokeAgent(k)});if(r.replaced)OBS.log('oauth_siri_replaced',{route:'/oauth',kind:'siri'});if(!r.ok){const e=Error(r.error);e.code=r.error;throw e;}save();return r.id;}
      const id=knownIds.has(kind)||['grok-bot','claude-code','codex','gemini-cli','gemini-spark'].includes(kind)?kind:'oauth-'+kind;for(const [k,x] of Object.entries(S.oauthAgents))if(k===id&&x.clientId!==clientId)OA.revokeAgent(k);
      S.oauthAgents[id]={id,name,kind,clientId,created:new Date().toISOString()};save();return id;}});
  // public, signature-gated trust approval page (the link kipurse_request_trust hands to the agent for the owner)
  // phone signer (scoped second owner): enrollment + revoke pages, Base Account signs the on-chain batch; server only verifies
  // Operator flags (env, outside the open-source core). Both default OFF on mainnet: V1 approver, no owner payments.
  const OWNER_PAY=(overrides.ownerPay??process.env.KIPURSE_OWNER_PAY)==='1'||overrides.ownerPay===true;const APPROVER_VERSION=overrides.approverVersion??process.env.KIPURSE_PHONE_APPROVER??'v1';
  const PH=createPhoneEnrollment({S,save,pub,wallet:R.wallet,trust:SU.trust,owner:R.owner,chainId:8453,base:()=>PUBLIC,approverVersion:APPROVER_VERSION,afterOpening:'wallet',   /* t1128 (owner "允许再扣"): post-opening Face ID = one wallet-pays actual-cost fee (<=0.05) or stop */
    caps:()=>{const p=pol();return {single:BigInt(p.single),daily:BigInt(p.daily)};},script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/phone-enroll.js');})(),
    // t906: enrollment fee from the Kipurse wallet (sponsor fronts gas, same caps; repaid in the same batch to the fixed fee address)
    feeTo:(v=>v==='off'?null:/^0x[0-9a-fA-F]{40}$/.test(v)?v:OP.feeTo)(process.env.KIPURSE_WITHDRAW_FEE_TO??''),
    sponsor:{available:()=>!!SPONSOR_REF()?.withdrawAvailable?.(),register:async(id,a)=>{const sp=SPONSOR_REF();const sid=sp?.registerEnroll?.(id,a);return sid?`${PUBLIC0}/onboard/new/paymaster?id=${sid}`:null;}}});
  const SGH=SU.name==='v5.4'&&cfg.signerGrant?await (async()=>{const ST=await import(G+'src/v5/signer-trust-v54.mjs');const {randomBytes}=await import('node:crypto');   // t1214: V5.4 + flag only
    return ST.createSignerGrantHook({pub,trust:SU.trust,wallet:R.wallet,store:ST.createGrantStore({get:k=>KV.get(k)??undefined,set:(k,v)=>KV.put(k,v)}),randomNonce:()=>'0x'+randomBytes(32).toString('hex')});})():(V55ON&&SU.name==='v5.5'&&cfg.signerGrant?await (async()=>{const ST=await import(G+'src/v5/signer-trust-v54.mjs');const {randomBytes}=await import('node:crypto');   // t1214: V5.4 + flag only
    return ST.createSignerGrantHook({pub,trust:SU.trust,wallet:R.wallet,store:ST.createGrantStore({get:k=>KV.get(k)??undefined,set:(k,v)=>KV.put(k,v)}),randomNonce:()=>'0x'+randomBytes(32).toString('hex')});})():null);   // t1250: V5.5 + flag only
  const TA=createPublicTrustApproval({signerGrant:SGH,...(V55ON&&SU.name==='v5.5'?{suite:'v5.5'}:{}),addressCheck:p=>engine?.verifyPayee?.({address:p}),phone:{active:()=>PH.active(),findIndex:x=>PH.findIndex(x),verifyWrapped:async(digest,w)=>String(await pub.readContract({address:R.wallet,abi:WALLET_ABI,functionName:'isValidSignature',args:[digest,w]})).toLowerCase()==='0x1626ba7e'},owner:R.owner,wallet:R.wallet,base:()=>PUBLIC,
    ownerApi:{list:()=>O().api.list(O().cap),approve:id=>O().api.approve(O().cap,id),submitSignature:(id,s,o)=>O().api.submitSignature(O().cap,id,s,o),reject:id=>O().api.reject(O().cap,id)},
    verifyTypedData:overrides.verifyTypedData??(a=>pub.verifyTypedData(a)),verifyMessage:overrides.verifyMessage??(a=>pub.verifyMessage(a)),
    script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/approve-trust.js');})()});
  // READ-ONLY phone session (app main view on mainnet): proves the active phone signer key, then reads state. No writes.
  S.agentLastSeen??={};let seenSaved=0;let SIRI=null;let ONRAMP=null;let APAY=null;let ONRLIM=null;const seen=id=>{S.agentLastSeen[id]=new Date().toISOString();if(Date.now()-seenSaved>60000){seenSaved=Date.now();save();}};
  const readState=async()=>{const st=await E.status();const p=pol();const tr=O().api.list(O().cap);
    // t1157: one Siri row (the phone 'siri' row); the empty oauth-siri first-connect record is not listed. Logic lives in src/v5/agent-list.mjs.
    const list=AGL.stateAgents({tokenAgents:agents,oauthAgents:S.oauthAgents,tokens:S.oauth?.tokens,nowS:Date.now()/1000,phoneActive:!!S.phone?.active,siriAgent:S.siriAgent,
      spendOk:()=>EVD.get().authorized===true,siriStopped:()=>E0.mandates?.agents?.().find(x=>x.agentId==='siri')?.stopped,lastSeen:S.agentLastSeen});
    const purchases=E.listPurchases({limit:50}).map(r=>({purchaseKey:r.purchaseKey,state:r.state,amount:r.amount,fee:r.fee??null,networkFee:r.networkFee??null,payee:r.payee,agent:r.agent,merchant:r.label??r.merchant??null,txHash:r.txHash,createdAt:r.createdAt}));   /* t1281: fees for the app's local fallback (SpendCost)*/
    /* t1185 decision 85: today's on-chain operations of the vault (V5.3 only; read-only; null if unknown) */
    let ops=null;try{const t=await opsToday({pub,vault:R.vault});ops=t.supported?{supported:true,perDayCount:String(t.cap),usedTodayCount:String(t.used),leftCount:String(t.left),resetsAt:t.resetsAt}:{supported:false};}catch{ops=null;}
    return {mode:'MAIN',chainId:8453,explorer:'https://basescan.org',balance:String(st.usdc),ops,reserve:String(st.vault?.balance??0),vault:{address:st.vault?.address,balance:String(st.vault?.balance??0)},
      paused:!!st.paused,safetyPause:SAFE.paused(R.wallet),pausedUntil:String(st.pausedUntil??0),main:{single:String(p.single),daily:String(p.daily)},everyday:(()=>{try{return EVD.get();}catch{return null;}})(),caps:{single:String(p.single),daily:String(p.daily),term:String(p.term),openSingle:String(p.openSingle)/* t1281: today's signed stranger limits, so the limits page keeps them */,openDaily:String(p.openDaily),start:String(S.permission.start),end:String(S.permission.end)},limitsPending:(()=>{try{return LIM.pending();}catch{return null;}})(),holds:(()=>{try{return engine?.listHolds?.()??[];}catch{return [];}})(),ledger:(()=>{try{LED.refresh().catch(ledFail);return LED.view({wallet:String(st.usdc),vault:String(st.vault?.balance??0)}).rows.map(r=>{if(r.kind!=='payment')return r;let o=null;try{o=engine?.orderForTx?.(r.tx)??null;}catch{}return o?{...r,order:o}:r;});}catch{return [];}})(),
      spent:{today:String(st.todaySpent),term:String(st.termSpent)},setup:{active:true,wallet:R.wallet,owner:R.owner,human:{perPayment:(Number(p.single)/1e6).toString(),perDay:(Number(p.daily)/1e6).toString(),termTotal:(Number(p.term)/1e6).toString()}},
      agents:list,purchases,trustRequests:{pending:tr.pending.filter(r=>!String(r.agentId??'').startsWith('owner-ask:')).map(r=>({...r,chainId:8453,chain:'base'}))},connectRequests:OA.pendingList(),payeeBook:(()=>{try{return (engine?.addressBook?.()??[]).filter(x=>x.status!=='new').slice(0,50).map(x=>({name:x.name,address:x.address,status:x.status}));}catch{return [];}})(),/* t1158: names Siri may say (server resolves them again) */phone:{fingerprint:PH.active()?.fingerprint??null},trustedMerchants:await trustedMerchants()};};
  /* t1241 decision 111: the owner's trusted merchant DOMAINS (V5.4 grants), read-only for the app: caps, expiry, who signs its orders, auto-pay paused */
  async function trustedMerchants(){if(!V54LIKE(SU.name)||!cfg.signerGrant)return [];try{const STm=await import(G+'src/v5/signer-trust-v54.mjs');const GS=STm.createGrantStore({get:k=>KV.get(k)??undefined,set:(k,v)=>KV.put(k,v)});
      const paused=new Map((E0.layeredTrust?.pausedDomains?.()??[]).map(x=>[x.domain,x]));const nowS=Math.floor(Date.now()/1000);const out=[];
      for(const g of GS.list(R.wallet)){const d=String(g.name??'').toLowerCase();let att=null;try{att=ATTC?String(await ATTC.address(d)).toLowerCase():null;}catch{att=null;}
        const last=(E0.layeredTrust?.payments?.(d)??[])[0];
        out.push({domain:d,single:String(g.single),daily:String(g.daily),expiry:Number(g.expiry),active:Number(g.expiry)>nowS,signedBy:att&&g.signers.map(x=>String(x).toLowerCase()).includes(att)?'kipurse':'merchant',
          merchantSigned:last?!!last.merchantSigned:null,paused:paused.has(d),pausedReason:paused.get(d)?.reason??null});}
      return out;}catch{return [];}}
  const PS=createPhoneSession({phone:{active:()=>PH.active()},wallet:R.wallet,store:(S.phoneSession??={}),save,readState,kv:KV});
  const {createOwnerPay}=await import(G+'src/v5/owner-pay.mjs');
  const knownPayees=async()=>{const seen=new Map();for(const r of E.listPurchases({limit:200}))if(r.payee&&r.state==='paid'&&!seen.has(String(r.payee).toLowerCase()))seen.set(String(r.payee).toLowerCase(),{address:r.payee,name:r.label??r.merchant??null});return [...seen.values()];};
  // One tenant per phone session (this deployment serves one wallet; the module itself keys everything by wallet).
  const {createOwnerAskApproval}=await import(G+'src/v5/owner-ask-approve.mjs');const {p256VerifyDigest:pvAsk}=await import(G+'src/v5/phone-signer.mjs');
  /* t1170 decision 82: the owner's answer to an owner ask (app card + Face ID only); the server then pays that exact request once */
  const OASK=createOwnerAskApproval({...(V55ON&&SU.name==='v5.5'?{inlineTrust:{epochOf:async m=>(await pub.readContract({address:SU.trust,abi:parseAbi(['function trustOf(address,bytes32) view returns (uint64,uint64,bool,uint160,uint160)']),functionName:'trustOf',args:[R.wallet,m]}))[0],nowS:async()=>Number((await pub.getBlock()).timestamp),feePpm:async()=>BigInt(await pub.readContract({address:'0x8F52D223DF89E388DcB5d39C53f154b9F8F9a67A',abi:parseAbi(['function feePpm() view returns (uint256)']),functionName:'feePpm'})),store:async e=>{KV.put('v55inline:'+String(R.wallet).toLowerCase()+':'+String(e.payee).toLowerCase(),e);}}}:{}),engine:E0,phone:PH,pub,wallet:R.wallet,everyday:()=>EVD.get(),walletCaps:()=>{const p=pol();return {single:p.single,daily:p.daily};},trustOwner:()=>O(),
    verifyWrapped:async(digest,w)=>String(await pub.readContract({address:R.wallet,abi:WALLET_ABI,functionName:'isValidSignature',args:[digest,w]})).toLowerCase()==='0x1626ba7e',
    p256Verify:(a,d,r,s)=>pvAsk(a,d,r,s),afterPaid:id=>{try{SC.take(id);}catch{}},log:(k,v)=>OBS.log(k,v),signerGrant:SGH/* t1240 decision 110: V5.4 + flag only, else null */,
    onGrantStored:async({merchant,attested})=>{if(attested&&merchant)await E0.layeredTrust?.resumeDomain?.(merchant);}/* t1241: the owner's fresh trust lifts an auto-pay pause */});
  const OPAY=createOwnerPay({enabled:OWNER_PAY,store:S,save,resolveTenant:async req=>PS.check(req)?{wallet:R.wallet,chainId:8453,token:X.token,pub,phone:PH,engine:E,knownPayees}:null});
  const WD=createOwnerWithdraw({pub,wallet:R.wallet,owner:R.owner,vault:R.vault??null,token:X.token,feed:(await import(G+'src/v5/phone-signer.mjs')).ETH_USD_FEED,chainId:8453,
    script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/withdraw.js');})(),
    // t752: fee paid from the wallet's own USDC. OFF until the owner sets KIPURSE_WITHDRAW_FEE_TO (fixed fee address). Uses the existing sponsor + its day caps.
    // t757: default = Kipurse mainnet ops account (gas reserve; on-chain treasury() = 0x2222…, locked). Env overrides; 'off' disables.
    feeTo:(v=>v==='off'?null:/^0x[0-9a-fA-F]{40}$/.test(v)?v:OP.feeTo)(process.env.KIPURSE_WITHDRAW_FEE_TO??''),
    walletPays:{dues:()=>{const sp=SPONSOR_REF();let d=sp?.dues?.(R.wallet)??0n;try{d+=BigInt(engine?.gasBook?.outstanding?.(R.wallet)??0n);}catch{}return d;},
      paid:n=>{const sp=SPONSOR_REF();const t=sp?.payDue?.(R.wallet,n)??0n;const rest=n-t;if(rest>0n)try{engine?.gasBook?.applyRecovery?.(R.wallet,rest,null);}catch{}},
      available:()=>!!SPONSOR_REF()?.withdrawAvailable(),usdcGas:()=>!!SPONSOR_REF()?.usdcGas,registerUsdcGas:async(id,a)=>{const sp=SPONSOR_REF();const sid=sp?.registerUsdcGas?.(id,{kind:'withdraw',...a});return sid?`${PUBLIC0}/onboard/new/paymaster?id=${sid}`:null;},register:async(id,a)=>{const sp=SPONSOR_REF();const sid=sp?.registerWithdraw(id,a);return sid?`${PUBLIC0}/onboard/new/paymaster?id=${sid}`:null;}}});
  // EMERGENCY without a bound phone (reinstall / new phone): Base Account signature only, verified here before acting. Pause + cancel holds.
  const {createOwnerEmergency}=await import(G+'src/v5/owner-emergency.mjs');
  const EM=createOwnerEmergency({wallet:R.wallet,owner:R.owner,obs:OBS,verifyOwner:overrides.verifyOwner??((message,signature)=>pub.verifyMessage({address:R.owner,message,signature})),
    pendingHolds:()=>{try{return (E0.listHolds?.()??[]).length;}catch{return 0;}},
    pause:async()=>{const p=SAFE.pause(R.wallet,'owner_stop',null);SC.revoke('owner_emergency');let chain=null;try{const r=await E0.pause();chain={paused:true,txHash:r.txHash};}catch(e){chain={paused:false,error:String(e?.code??'chain_pause_failed')};}let openReservations=[];try{openReservations=E0.openReservations?.()??[];}catch{}return {server:p,chain,openReservations};},   /* t1278 C2 */
    cancelHolds:async()=>{let n=0;for(const h of E0.listHolds?.()??[]){try{if(E0.cancelHold(h.id)?.ok)n++;}catch{}}return {cancelled:n,left:(E0.listHolds?.()??[]).length};},
    script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/emergency.js');})()});
  // Owner pause longer than the on-chain executor pause (24 h max): while the owner's pause lasts, re-arm the on-chain pause when it
  // has lapsed. In-process check (no cron); gas for the pause comes from the owner's own vault like every owner action.
  // t1139 (decision 71, owner decision t1139 option a): resume = Face ID + (only when the wallet is paused ON CHAIN) ONE Base Account batch
  // [wallet -> fee address F USDC, wallet.execute(trust, setPaused(false))], network fee F from the Kipurse wallet (live quote, < 0.01 USDC).
  // The server lifts its own pause and answers ok ONLY after it has read isPaused(wallet) == false on chain.
  const RSM=await import(G+'src/v5/resume-onchain.mjs');const RP=new Map();
  const rpLive=()=>{const t=Date.now();for(const [k,v] of RP)if(t-v.at>RSM.RESUME_PLAN_TTL_MS&&v.state!=='done'||t-v.at>2*RSM.RESUME_PLAN_TTL_MS)RP.delete(k);return [...RP.values()].filter(v=>v.state==='prepared');};
  const chainPaused=async()=>{try{return !!(await pub.readContract({address:SU.trust,abi:RSM.IS_PAUSED_ABI,functionName:'isPaused',args:[R.wallet]}));}catch{return null;}};
  const resumeFeeTo=()=>(v=>v==='off'?null:/^0x[0-9a-fA-F]{40}$/.test(v)?v:RSM.RESUME_FEE_TO)(process.env.KIPURSE_WITHDRAW_FEE_TO??'');
  /** On-chain unpause seen -> lift the server pause, mark the plan(s) done. Returns true when the wallet is no longer paused on chain. */
  const settleResume=async()=>{const live=rpLive();if(!live.length)return null;const cp=await chainPaused();if(cp!==false)return false;
    SAFE.resume(R.wallet);for(const v of live){v.state='done';v.doneAt=Date.now();}OBS.log('safety_resume',{ok:true,chain:'unpaused'});return true;};
  async function resumeQuote(){const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');const data=RSM.unpauseCall({wallet:R.wallet,trust:SU.trust}).data;
    const [gp,rd,wb,eg]=await Promise.all([pub.getGasPrice(),pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}),
      pub.readContract({address:X.token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[R.wallet]}).catch(()=>null),
      pub.estimateGas({account:R.owner,to:R.wallet,data}).catch(()=>null)]);
    return RSM.resumeFee({callGas:eg,gasPriceWei:gp,ethUsd8:rd[1],walletUSDC:wb,cap:LFEE.limitsWalletFeeCap()});}
  const usdcText=a=>{a=BigInt(a);const w=a/1000000n,f=(a%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?w+'.'+f:''+w;};
  const resumePage=(pl,lang)=>{const en=lang==='en',t=(z,e)=>en?e:z,esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const inner=pl?`<div class=t>${t('恢复 AI 付款','Resume AI payments')}</div><div class=c>${t('你已经用 Face ID 同意恢复。最后一步：在你的 Coinbase（Base Account）确认一笔，解除钱包在链上的暂停。','You approved with Face ID. Last step: confirm one transaction in your Coinbase (Base Account) to lift the wallet’s on-chain pause.')}
<div class=fee>${t('手续费 ','Network fee ')}${esc(usdcText(pl.fee))} USDC${t('，从启付钱包扣（实际成本，不加价）。你的 Coinbase 账户不用付 ETH。',', taken from your Kipurse wallet (actual cost, no markup). Your Coinbase account pays no ETH.')}</div>
<div class=m>${t('链上确认后，AI 才能在你设的上限内继续付款。','AI can pay again, within your limits, only after Base confirms it.')}</div></div><button id=go>${t('在 Coinbase 确认','Confirm in Coinbase')}</button><div id=st class=m></div>`
      :`<div class=t>${t('这一步已过期','This step expired')}</div><div class=c>${t('请回到启付 App，再点一次“恢复 AI 付款”。没有扣钱。','Go back to the Kipurse app and tap Resume AI payments again. Nothing was charged.')}</div>`;
    const data=pl?JSON.stringify({id:pl.id,owner:R.owner,chainId:8453,wallet:R.wallet,trust:SU.trust,feeTo:pl.feeTo,fee:{usdc:String(pl.fee)},pm:pl.pm,calls:pl.calls}).replace(/</g,'\\u003c'):null;
    return `<!doctype html><html lang=${en?'en':'zh'}><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${t('恢复 AI 付款','Resume AI payments')}</title>
<style>body{margin:0;background:#F2F2F7;color:#111;font:17px/1.45 -apple-system,"PingFang SC",sans-serif}.w{max-width:480px;margin:0 auto;padding:22px 18px 40px}.c{background:#fff;border-radius:16px;padding:14px 16px;margin:12px 0}.t{font-size:24px;font-weight:700;margin:10px 0}.m{color:#666;font-size:14px}.fee{font-weight:600;margin:12px 0 4px}button{display:block;width:100%;border:0;border-radius:14px;padding:17px;font-size:20px;font-weight:600;margin-top:10px;background:#5B4CF0;color:#fff}</style>
<div class=w>${inner}</div>${data?`<script type="application/json" id=kp-data>${data}</script><script src="/safety/resume.js"></script>`:''}</html>`;};
  const rearm=async()=>{try{if(rpLive().length){await settleResume();return;}const p=SAFE.paused(R.wallet);if(!p||p.reason!=='owner_stop')return;const st=await E0.status?.().catch(()=>null);
      const until=Number(st?.pausedUntil??0);if(until>Math.floor(Date.now()/1000)+3600)return;await E0.pause();OBS.log('safety_rearm',{});}catch{}};
  const rearmTimer=setInterval(rearm,Number(ENV.KIPURSE_SAFE_REARM_MS??30*60e3));rearmTimer.unref?.();
  const {createUserDataEraser,mainnetEraseParts,createTombstones,applyTombstone,kvUserParts}=await import(G+'src/v5/user-data.mjs');
  const TOMB=TOMB_G;   // t1265: shared, HMAC-keyed
  const ERASE=createUserDataEraser({kv:KV,tomb:TOMB,onErased:(w,t)=>{S.erasedAt=t;save();},enabled:(overrides.userErase??process.env.KIPURSE_USER_ERASE)==='1'||overrides.userErase===true,resolveTenant:async req=>PS.check(req)?{wallet:R.wallet,phone:PH}:null,
    parts:[{name:'tenant-index',forget:()=>{unindex();return {ok:true};}},...kvUserParts(KV),{name:'safety',forget:()=>SAFE.forget(R.wallet)},{name:'executor-key',forget:()=>KR.forget(R.wallet)},{name:'withdraw',forget:()=>WD.forget()},...mainnetEraseParts({S,save,ownerPay:OPAY,phone:PH,ledgerCache:LED,limits:{forget:()=>{try{EVD.forget();}catch{}return LIM.forget();}},trustOwner:()=>O(),getDb:()=>E.ledger.db,agents,kv:KV,siri:SC/* t1275 */}),
      /* t1265: what the parts above could not reach - the wallets this owner moved away from (each fully erased + tombstoned), the owner-keyed
         V5.5 move record, the at-rest migration backups, the registry record (marked erased), and deleted KV values folded out of the WAL */
      {name:'moved-from-wallets',forget:async()=>{for(const r of UD.movedFromChain(REG,R.wallet,followMoved))await eraseRetired(r);}},
      {name:'owner-move-record',forget:()=>{if(UD.forgetOwnerMoveRecord(KV,R.owner)==='kept_in_flight')OBS.log('erase_move_record_kept',{reason:'move_in_flight'});}},
      {name:'at-rest-backups',forget:()=>UD.removeBackups(fs,{files:[F.state,F.agents,F.ledgerCache,F.engine?.ledgerFile],dirs:[cfg.ownerRulesDir]})},
      {name:'registry-record',forget:()=>{REG.update(R.wallet,{erasedAt:Date.now(),createdAt:undefined,migratedAt:undefined});}},
      {name:'kv-scrub',forget:()=>{try{KV.scrub?.();}catch{}}}]});
  const LFEE=await import(G+'src/v5/limits-fee.mjs');
  const limitsDirect=()=>LFEE.limitsWalletFeeForAll(R.wallet);   // t1125 (decision 64): all wallets, not just the t1097 allowlist
  const LIM=createPublicLimits({base:()=>PUBLIC,current:async()=>{const p=pol();return {single:p.single,daily:p.daily,term:p.term,openSingle:p.openSingle,openDaily:p.openDaily/* t1281 */,end:S.permission.end};},
    plan:async c=>{const pl=await planCapChange(c);const direct=limitsDirect();const change={to:R.wallet,value:'0x0',data:pl.walletExecuteBatch.data};
      if(direct)return {owner:R.owner,wallet:R.wallet,chainId:8453,human:pl.human,labels:pl.calls.map(x=>x.label),calls:LFEE.limitsChangeCalls({direct:true,changeCall:change}),raw:pl,fromWallet:true};
      const ug=!!SPONSOR_REF()?.usdcGas;const {approveCall}=await import(G+'src/v5/usdc-gas.mjs');return {owner:R.owner,chainId:8453,human:pl.human,labels:pl.calls.map(x=>x.label),calls:LFEE.limitsChangeCalls({direct:false,approveCall:ug?approveCall():null,changeCall:change}),raw:pl,usdcGas:ug};},
    confirm:pl=>confirmCapChange(pl),script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/limits.js');})(),
    // t603/t604: first limits authorization free (onboarding sponsorship, once per owner); later changes paid in USDC by the Base Account. Never ETH.
    // t763 (locked): first limits authorization is paid from the wallet like every later change (firstLimitsFree=false). Never sponsored.
    // option A (t1020): limit changes are paid in USDC by the user via the CDP ERC-20 paymaster (approve rides in the batch); off = old Base-Account path
    // t1097 allowlist + /owner/limits/paymaster proxy: removed (t147, decision 147); every wallet uses the t1123 wallet-fee batch.
    sponsor:async(id,pl)=>{if(pl?.fromWallet)return null;const sp=SPONSOR_REF();if(!sp?.usdcGas)return null;const sid=sp.registerUsdcGas(id,{kind:'limits',owner:R.owner,wallet:R.wallet,calls:pl.calls});return sid?`${PUBLIC0}/onboard/new/paymaster?id=${sid}`:null;},
    _sponsorFirstLimitsRetired:async(id,pl)=>{const sp=SPONSOR_REF();if(!sp)return null;const sid=sp.registerFirstLimits(id,{owner:R.owner,wallet:R.wallet,calls:pl.calls});return sid?`${PUBLIC0}/onboard/new/paymaster?id=${sid}`:null;},
    fee:async pl=>pl?.fromWallet?limitsWalletFeeQuote({data:pl.calls[pl.calls.length-1]?.data}):limitsFeeQuote({data:pl.calls[pl.calls.length-1].data,walletPays:true}),
    refund:fee=>LFEE.feeRefundCall({wallet:R.wallet,token:X.token,owner:R.owner,fee}),
    feeQuote:async()=>{if(limitsDirect()){const q=await limitsWalletFeeQuote({});return {...q,firstFree:false,fromWallet:true};}const q=await limitsFeeQuote({});const sp=SPONSOR_REF();void sp;return {...q,firstFree:false};},
    // t1123 (decision 63) / t147 (decision 147): the wallet pays the fee in the same batch through the existing sponsor (t752 withdraw shape), fee to the
    // fixed fee address. The third-party ERC-20 paymaster (Pimlico) proxy is removed. KIPURSE_GAS_PAYMASTER usdcGas mode is not used here.
    walletFee:{feeTo:(v=>v==='off'?null:/^0x[0-9a-fA-F]{40}$/.test(v)?v:OP.feeTo)(process.env.KIPURSE_WITHDRAW_FEE_TO??''),
      available:()=>{const sp=SPONSOR_REF();return !!sp&&!sp.usdcGas&&!!sp.withdrawAvailable?.();},
      register:async(id,a)=>{const sp=SPONSOR_REF();if(!sp||sp.usdcGas)return null;const sid=sp.registerLimitsWallet?.(id,a);return sid?`${PUBLIC0}/onboard/new/paymaster?id=${sid}`:null;}},
    onConfirmed:({sponsored})=>{if(sponsored)SPONSOR_REF()?.markFirstLimitsDone(R.owner);}});
  /** t1123: fee for the wallet-pays limits batch (wallet -> fee address + cap change, sent from the owner's Base Account). Actual cost, 0% markup, cap 0.01. */
  async function limitsWalletFeeQuote({data}={}){const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');
    const [gp,rd,wb,eg]=await Promise.all([pub.getGasPrice(),pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}),
      pub.readContract({address:X.token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[R.wallet]}).catch(()=>null),
      data?pub.estimateGas({account:R.owner,to:R.wallet,data}).catch(()=>pub.estimateGas({account:R.wallet,to:R.wallet,data}).catch(()=>null)):Promise.resolve(null)]);
    return LFEE.limitsWalletFee({callGas:eg,gasPriceWei:gp,ethUsd8:rd[1],walletUSDC:wb,cap:LFEE.limitsWalletFeeCap()});}
  async function limitsFeeQuote({data,walletPays=false}){const {limitsChangeFee}=await import(G+'src/v5/limits-fee.mjs');const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');
    const [gp,rd,bal,eg]=await Promise.all([pub.getGasPrice(),pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}),
      pub.readContract({address:X.token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[R.owner]}).catch(()=>null),
      data?pub.estimateGas({account:R.owner,to:R.wallet,data}).catch(()=>null):Promise.resolve(null)]);
    const wb=walletPays?await pub.readContract({address:X.token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[R.wallet]}).catch(()=>null):undefined;
    return limitsChangeFee({callGas:eg,gasPriceWei:gp,ethUsd8:rd[1],payerUSDC:bal,walletUSDC:wb});}
  const readJson=async req=>{const b=await rawBody(req);const t=String(req.headers['content-type']??'');
    if(t.includes('application/x-www-form-urlencoded'))return Object.fromEntries(new URLSearchParams(b));try{return b?JSON.parse(b):{};}catch{return {};}};
  // public agent surface: /mcp (Streamable HTTP, Bearer / X-API-Key agent token) + /v1/* only; anything else 404
  /* t1265: owner proof for a phone key (same rule as /phone/enroll): the sign-in read grant of this wallet for exactly x / y, or a live phone session */
  const ownerKeyProof=(req,x,y)=>{const g=KV.get(kvKey('readgrant',R.wallet,'phone'));let ok=false;try{ok=!!g&&(!g.exp||g.exp>Date.now())&&BigInt(g.x)===BigInt(String(x))&&BigInt(g.y)===BigInt(String(y));}catch{ok=false;}return ok||!!PS.check(req);};
  const ONB=createOnboarding({verified:o=>checkVerifiedMulti([pub,...CBV_PUBS],o,{log:x=>console.log(JSON.stringify({t:'cbv_legacy',...x}))}),enabled:ONBOARD_ON,keyProof:(req,{x,y})=>ownerKeyProof(req,x,y),S,save,pub,wallet:R.wallet,owner:R.owner,trust:SU.trust,token:X.token,chainId:8453,base:()=>PUBLIC,phone:PH,approverVersion:APPROVER_VERSION==='v3'?'v3':'v2',
    plan:c=>planCapChange(c),confirmPlan:pl=>confirmCapChange(pl),ownerPay:()=>OWNER_PAY,script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/onboard.js');})()});
  // per-tenant credential indexes (point lookups by hash; never a scan on a request path)
  /* t1265: a retired (moved-away) wallet never writes an index entry (it can never win idx:phone); OAuth entries carry the TTL of their object
     (token / code / request); a client id entry is only CLAIMED (never taken from the wallet that registered it, see router adoption). */
  const indexed=new Set();const ix=(kind,key,ttlMs,claim=false)=>{if(!key||REG.get(R.wallet)?.retired)return;if(claim){if(!IDX.claim(kind,key,R.wallet,ttlMs))return;}else IDX.set(kind,key,R.wallet,ttlMs);indexed.add(kind+'\u0000'+key);};
  const reindex=()=>{for(const a of agents??[])if(!a.disabled&&a.tokenSha256)ix('agent',a.tokenSha256);const o=S.oauth??{};const nowS=Date.now()/1000;
    for(const m of [o.tokens,o.codes,o.pending,o.refresh])for(const [k,v] of Object.entries(m??{})){const ttl=Number.isFinite(Number(v?.exp))?Math.floor((Number(v.exp)-nowS)*1000):0;if(ttl>0)ix('oauth',k,ttl);}
    for(const k of Object.keys(o.clients??{}))ix('oauth',k,0,true);const a=PH.active();if(a?.x)ix('phone',a.x);};
  function forgetIdx(kind,key){try{if(IDX.get(kind,key)===String(R.wallet).toLowerCase())IDX.del(kind,key);indexed.delete(kind+'\u0000'+key);}catch{}}
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
      if(u.pathname==='/phone/push/register'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const b=await readJson(req).catch(()=>({}));const [pc,po]=registerPushToken(pushTokens(R.wallet),b);if(pc!==200)return j(pc,po);OBS.log('push_register',{enabled:PUSH.enabled,replaced:po.replaced});return j(200,{ok:true,pushEnabled:PUSH.enabled});}
      /* t1240 decision 110 F1 (security review): starting "add this phone" needs proof of the owner - a live phone session of this wallet (the current
         Face ID phone replacing / upgrading its key), OR this exact key was just signed in with the owner's Coinbase account (sign-in "bind" read
         grant for these x / y). Before, anyone could create a real-domain "add this phone" link with THEIR key for any wallet (phishing). */
      if(u.pathname==='/phone/enroll'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));
        const g=KV.get(kvKey('readgrant',R.wallet,'phone'));let grantOk=false;try{grantOk=!!g&&(!g.exp||g.exp>Date.now())&&BigInt(g.x)===BigInt(String(b?.x))&&BigInt(g.y)===BigInt(String(b?.y));}catch{grantOk=false;}
        if(!grantOk&&!PS.check(req)){OBS.log('phone_enroll_refused',{reason:'no_owner_proof'});return j(401,{error:'sign_in_first',detail:'先在这台手机上用 Coinbase 登录，再添加这台手机 / Sign in with Coinbase on this phone first, then add it.'});}
        if(await PH.handle(req,res,u,{readBody:async()=>b}))return;}
      if(u.pathname.startsWith('/phone/')){if(await PH.handle(req,res,u,{readBody:readJson}))return;}
      if(u.pathname==='/approve/trust'||u.pathname.startsWith('/approve/trust/')||u.pathname==='/approve/trust.js'){const ip=String(req.headers['cf-connecting-ip']??req.socket.remoteAddress??'');if(await TA.handle(req,res,u,{readBody:readJson,ip}))return;}
      if(u.pathname==='/mcp'){const tok=String(req.headers.authorization??'').replace(/^Bearer\s+/i,'')||String(req.headers['x-api-key']??'');
        let a=agents?.length?resolveAgent(agents,tok):(fork&&req.headers['x-agent-id']?{id:String(req.headers['x-agent-id'])}:null);
        if(a&&['owner','siri'].includes(String(a.id).toLowerCase()))a=null;/* t1278 S12: reserved ids are never an AI's (OAuth ids are oauth-* / known kinds, never these) */
        if(!a&&tok){const id=OA.agentForAccess(tok);if(id)a={id};}if(a)seen(a.id);
        if(!a){/* t1161 (decision 78): say WHY (reason + agent id only), so a broken AI connection is visible instead of silent 401s */
          const {hashToken}=await import(G+'src/v4/agents.mjs');const rf=AGL.mcpRefusal({tok,tokenAgentHit:t=>{const h=hashToken(t);return (agents??[]).find(x=>x.tokenSha256===h)??null;},accessStatus:t=>OA.accessStatus(t)});
          OBS.log('mcp_refused',{reason:rf.reason,kind:rf.agentId??'none',status:401});}
        if(!a)return j(401,{error:'invalid_token',error_description:'connect with OAuth (see WWW-Authenticate) or send your Kipurse agent token as Authorization: Bearer <token>'},{'www-authenticate':OA.challenge()+(tok?', error="invalid_token"':''),'access-control-expose-headers':'WWW-Authenticate, Mcp-Session-Id'});
        let body;if(req.method==='POST'){const b=await readCapped(req,MCP_MAX_BODY);if(b===null)return j(413,{error:'too_large'});body=b?JSON.parse(b):undefined;}   // t1275: same 64 KB cap as the router, also for a streamed body with no content-length
        OBS.log('mcp',{kind:a.id});const server=MCP.acquire(a.id);const t=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});res.on('close',()=>{try{t.close();}catch{}MCP.release(a.id,server);});
        await server.connect(t);return await t.handleRequest(req,res,body);}
      if(u.pathname==='/everyday'&&req.method==='GET'){if(!PS.check(req))return j(401,{error:'phone_session_required'});return j(200,{...EVD.get(),why:EVERYDAY_WHY});}
      if(u.pathname==='/everyday/preview'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const b=await readJson(req).catch(()=>({}));const f=EVD.get().floor;try{return j(200,{...changeCost({next:{single:b?.single,daily:b?.daily},floor:f,firstFloorDone:true}),floor:f,why:EVERYDAY_WHY});}catch{return j(400,{error:'bad_amount'});}}
      if(u.pathname==='/everyday/challenge'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const n=(await import('node:crypto')).randomBytes(24).toString('hex');KV.put(kvKey('evd-chal',R.wallet,n),1,120e3);return j(200,{nonce:n,wallet:String(R.wallet).toLowerCase(),format:'Kipurse everyday limits v1',expiresInSec:120});}   /* t1268: single-use challenge for the phone-signed everyday limits */
      if(u.pathname==='/everyday'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const b=await readJson(req).catch(()=>({}));/* t1268: a live phone session is not enough: the ACTIVE phone key (Secure Enclave, Face ID) must sign exactly these amounts (everydayText) over a fresh single-use challenge (atomic take) */{const n=String(b?.nonce??'');if(!/^[0-9a-f]{48}$/.test(n)||!KV.take(kvKey('evd-chal',R.wallet,n))){OBS.log('everyday_set',{ok:false,error:'bad_challenge'});return j(400,{error:'bad_challenge'});}const a=PH.active();let sig=false;try{sig=!!a&&p256VerifyDigest(a,everydayDigest({wallet:R.wallet,single:b?.single,daily:b?.daily,term:b?.term,nonce:n}),String(b?.r??''),String(b?.s??''));}catch{sig=false;}if(!sig){OBS.log('everyday_set',{ok:false,error:a?'bad_phone_signature':'no_phone_signer'});return j(a?401:409,{error:a?'bad_phone_signature':'no_phone_signer'});}}let r;try{r=EVD.set({single:b?.single,daily:b?.daily,term:b?.term});/* t1138 (decision 70): the app sends all three; term was dropped -> every AI-limit change failed with term_required */}catch{r={ok:false,error:'bad_amount'};}OBS.log('everyday_set',{ok:!!r.ok,error:r.error??null});return j(r.ok?200:400,r);}
      if(u.pathname==='/safety/status'&&req.method==='GET'){if(!PS.check(req))return j(401,{error:'phone_session_required'});await settleResume().catch(()=>null);let openReservations=[];try{openReservations=SAFE.paused(R.wallet)?(E0.openReservations?.()??[]):[];}catch{openReservations=[];}return j(200,{paused:SAFE.paused(R.wallet),resumePending:rpLive().length>0,choices:['24h','48h','7d','until_resume'],openReservations});}   /* t1278 C2 */
      if(u.pathname==='/safety/withdraw/quote'&&req.method==='GET'){if(!PS.check(req))return j(401,{error:'phone_session_required'});try{return j(200,await WD.quote());}catch(e){return j(503,{error:String(e?.code??'quote_failed')});}}
      if(u.pathname==='/safety/stop'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const b=await readJson(req).catch(()=>({}));const ms=pauseMsOf(b?.duration);if(ms===undefined)return j(400,{error:'bad_duration',choices:['24h','48h','7d','until_resume']});RP.clear();const p=SAFE.pause(R.wallet,'owner_stop',ms);SC.revoke('safety_stop');OBS.log('safety_stop',{duration:String(b?.duration??'24h')});
        let chain=null;try{const r=await E0.pause();chain={paused:true,txHash:r.txHash,expiresAt:r.expiresAt};}catch(e){chain={paused:false,error:String(e?.code??'chain_pause_failed')};}
        /* t1278 C2: the server stops handing out every open x402 authorization while paused (engine pausedHold); it cannot cancel them on chain
           without the owner's signature, so the app gets their digests to offer "cancel" (owner-signed) */
        let openReservations=[];try{openReservations=E0.openReservations?.()??[];}catch{openReservations=[];}
        return j(200,{ok:true,server:p,chain,openReservations,note:p.until===null?'AI payments are stopped until you resume them. On chain the pause is renewed every day while it lasts.':'AI payments are stopped until '+new Date(p.until).toISOString()+'. On chain the pause is renewed while it lasts. You can resume early.'});}
      if(u.pathname==='/safety/holds'&&req.method==='GET'){if(!PS.check(req))return j(401,{error:'phone_session_required'});return j(200,{holds:E0.listHolds?.({all:u.searchParams.get('all')==='1'})??[]});}
      if(u.pathname==='/safety/holds/cancel'&&req.method==='POST'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const b=await readJson(req).catch(()=>({}));const r=E0.cancelHold?.(String(b?.id??''))??{ok:false};OBS.log('hold_cancel',{ok:!!r.ok});return j(r.ok?200:409,r);}
      if(u.pathname.startsWith('/siri/')&&req.method==='POST'){SIRI??=(await import(G+'src/v5/siri.mjs')).createSiriAgent(E);const b=await readJson(req).catch(()=>({}));const viaCred=!PS.check(req)&&u.pathname==='/siri/buy'&&SC.check(req);const [st,out]=await SIRI.handle(u.pathname,b,{authed:!!PS.check(req)||viaCred,seen:id=>{seen(id);if(!S.siriAgent){S.siriAgent={since:new Date().toISOString()};save();}}});if(u.pathname==='/siri/buy'&&out?.decision==='ask_owner'&&out?.approvalId)SC.remember(out.approvalId,b);OBS.log('siri',{path:u.pathname,decision:out?.decision??null,via:viaCred?'credential':'session'});return j(st,(await import(G+'src/v5/usdc-out.mjs')).forAI(out));}   /* t1166 (decision 80): Siri answers are AI-facing too */
      if(u.pathname.startsWith('/safety/mandates')||u.pathname==='/safety/agents/stop'||u.pathname==='/safety/report'){if(!PS.check(req))return j(401,{error:'phone_session_required'});const M=E0.mandates;
        if(u.pathname==='/safety/mandates'&&req.method==='GET'){const {BEGINNER_DEFAULTS,PURPOSES}=await import(G+'src/v5/mandates.mjs');const caps=new Map(M.agents().map(a=>[a.agentId,a]));
          const ags=AGL.mandateAgents({tokenAgents:agents,oauthAgents:S.oauthAgents,siriAgent:S.siriAgent});/* t1157: Siri once */
          const {CATEGORIES,purposeName}=await import(G+'src/v5/mandates.mjs');/* ONE LIMIT (t592): no per-category setup; the wallet limit is the only limit */
          return j(200,{allowances:M.list(),overall:M.overall(),categories:CATEGORIES.map(k=>({key:k,zh:purposeName(k,true),en:purposeName(k,false)})),proposals:M.proposals().filter(p=>{if(!p?.ask)return true;let a=null;try{a=E0.ownerAsks?.get(p.id);}catch{}if(a?.state==='expired'){try{M.expire?.(p.id);}catch{}return false;}return true;}/* t1259 decision 129: a card whose payment request can no longer be paid leaves the home screen */).map(p=>{if(!p?.ask)return p;let sp=null;try{sp=E0.ownerAsks?.get(p.id)?.spec??null;}catch{sp=null;}/* t1241: the card shows 信任 <domain> and whether the merchant signs */return sp?.signerMerchant&&sp?.signer?{...p,ask:{...p.ask,trustDomain:String(sp.signerMerchant),merchantSigned:sp.attested===true?sp.merchantSigned===true:true}}:p;}),agents:ags.map(a=>({...a,...(caps.get(a.id)??{stopped:false})})),defaults:[],purposes:Object.fromEntries(Object.entries(PURPOSES).map(([k,v])=>[k,{zh:v.zh,en:v.en}])),askTrust:(()=>{try{return E0.ownerAsks?.recentTrust?.()??[];}catch{return [];}})()/* t1243 decision 113: the background trust result of recent "trust" answers */});}
        if(u.pathname==='/safety/mandates/draft'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));try{const p=M.propose({items:Array.isArray(b?.items)?b.items:[],by:'owner',reason:'owner app'});OBS.log('mandate_draft',{n:p.items.length});return j(200,p);}catch(e){return j(400,{error:e.code??'bad_items',detail:scrubUrls(e.message).slice(0,200)});}}
        if(u.pathname==='/safety/mandates/ask-prepare'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));const [st,o]=await OASK.prepare(b);return j(st,o);}
        if(u.pathname==='/safety/mandates/ask-cancel'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));const [st,o]=OASK.cancel(b);return j(st,o);}
        if(u.pathname==='/safety/mandates/approve'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));if(E0.ownerAsks?.get(String(b?.id??''))){const [st,o]=await OASK.approve(b);return j(st,o);}/* t1170: owner ask card */const a=PH.active();if(!a)return j(409,{error:'no_phone_signer'});
          const r=M.approve(String(b?.id??''),d=>{try{return p256VerifyDigest(a,d,String(b?.r??''),String(b?.s??''));}catch{return false;}});OBS.log('mandate_approve',{ok:!!r.ok,error:r.error??null});
          // t1158: a Siri payment waiting for this approval is completed once (Siri cannot retry; same limits / dedupe path)
          if(r.ok){const pa=SC.take(String(b?.id??''));if(pa){SIRI??=(await import(G+'src/v5/siri.mjs')).createSiriAgent(E);let o;try{o=await SIRI.complete(pa);}catch(e){o={decision:'refuse',state:'failed',reason:String(e?.code??'error').slice(0,60)};}
            OBS.log('siri',{path:'approve_complete',decision:o?.decision??null});return j(200,{...r,siri:{decision:o?.decision??null,state:o?.state??null,txHash:o?.txHash??null,purchaseKey:o?.purchaseKey??null,say_to_user:o?.say_to_user??null}});}}
          return j(r.ok?200:r.error==='not_owner'?403:409,r);}
        if(u.pathname==='/safety/mandates/reject'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));const rid=String(b?.id??'');try{if(E0.ownerAsks?.get(rid))OASK.reject(rid);}catch{}return j(200,M.reject(rid));}/* t1170: a declined ask is final for the AI */
        if(u.pathname==='/safety/mandates/revoke'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));OBS.log('mandate_revoke',{});return j(200,M.revoke(String(b?.id??'')));}
        if(u.pathname==='/safety/agents/stop'&&req.method==='POST'){const b=await readJson(req).catch(()=>({}));const id=String(b?.agentId??'').slice(0,80);if(!id)return j(400,{error:'agent_required'});OBS.log('agent_stop',{});if(id==='siri'||id==='oauth-siri')SC.revoke('agent_stop');return j(200,M.agentStop(id,true));}
        if(u.pathname==='/safety/report'&&req.method==='GET'){const {spendingReport}=await import(G+'src/v5/buy.mjs');const q=Object.fromEntries(u.searchParams);return j(200,spendingReport(E0,{period:q.period,from:q.from,to:q.to,purpose:q.purpose,agent:q.agent,format:q.format}));}
        return j(404,{error:'not_found'});}
      // t1139: the sign page (no session) loads the prepared plan and polls for the on-chain result on this same path (the public edge only
      // forwards known paths). ok only after isPaused(wallet) == false on chain.
      if(u.pathname==='/safety/resume'&&req.method==='GET'){const id=String(u.searchParams.get('plan')??'');rpLive();const pl=/^[0-9a-f]{24}$/.test(id)?RP.get(id):null;const live=pl&&pl.state==='prepared';
        res.writeHead(live?200:410,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','referrer-policy':'no-referrer'});return res.end(resumePage(live?pl:null,u.searchParams.get('lang')==='en'?'en':'zh'));}
      if(u.pathname==='/safety/resume'&&req.method==='POST'){
        const b=await readJson(req).catch(()=>({}));
        if(b?.confirm!==undefined){const id=String(b.confirm);rpLive();const pl=/^[0-9a-f]{24}$/.test(id)?RP.get(id):null;if(!pl)return j(200,{error:'expired'});if(pl.state==='done')return j(200,{ok:true,chain:{paused:false}});
          const done=await settleResume();return j(200,done?{ok:true,chain:{paused:false}}:{});}
        if(!PS.check(req))return j(401,{error:'phone_session_required'});
        /* NO-AI-TRUST: resuming AI payments needs a FRESH Face ID signature (phone signer) over a one-time server challenge */const RC=(globalThis.__kpResumeCh??=new Map());const tnow=Date.now();for(const [k,v] of RC)if(tnow-v>300000)RC.delete(k);
        const {createHash:ch,randomBytes:rb}=await import('node:crypto');const txt=n=>`Kipurse resume v1\nwallet:${String(R.wallet).toLowerCase()}\nnonce:${n}`;const dg=n=>'0x'+ch('sha256').update(txt(n)).digest('hex');
        if(!b?.nonce||!b?.r||!b?.s){const n=rb(16).toString('hex');RC.set(n,tnow);return j(428,{error:'face_id_required',nonce:n,signText:txt(n),digest:dg(n)});}
        const n=String(b.nonce);if(!RC.has(n))return j(409,{error:'challenge_expired'});RC.delete(n);const a=PH.active();if(!a)return j(409,{error:'no_phone_signer'});
        let ok=false;try{ok=p256VerifyDigest(a,dg(n),String(b.r),String(b.s));}catch{}if(!ok){OBS.log('safety_resume',{ok:false});return j(403,{error:'not_owner'});}
        // t1139: if the wallet is still paused on chain, the server pause stays until the owner's Base Account lifts the chain pause.
        const cp=await chainPaused();if(cp===null)return j(503,{error:'chain_unknown',detail:RSM.RESUME_TEXT.chain_unknown()});
        if(cp===false){RP.clear();OBS.log('safety_resume',{ok:true,chain:'not_paused'});return j(200,{...SAFE.resume(R.wallet),chain:{paused:false}});}
        let q;try{q=await resumeQuote();}catch{return j(503,{error:'wallet_fee_unavailable',detail:RSM.RESUME_TEXT.wallet_fee_unavailable()});}
        const ft=usdcText(q.usdc);if(q.reason==='fee_above_cap')return j(402,{error:'fee_above_cap',fee:{usdc:String(q.usdc),usdcText:ft},detail:RSM.RESUME_TEXT.fee_above_cap(ft)});
        if(q.reason)return j(402,{error:'wallet_needs_topup',fee:{usdc:String(q.usdc),usdcText:ft},walletUSDC:q.walletUSDC==null?null:String(q.walletUSDC),detail:RSM.RESUME_TEXT.wallet_needs_topup(ft)});
        const feeTo=resumeFeeTo();const sp=SPONSOR_REF();if(!feeTo||!sp||sp.usdcGas||!sp.withdrawAvailable?.())return j(503,{error:'wallet_fee_unavailable',detail:RSM.RESUME_TEXT.wallet_fee_unavailable()});
        const id=rb(12).toString('hex');let calls;try{calls=RSM.resumeCalls({wallet:R.wallet,trust:SU.trust,feeTo,fee:q.usdc});}catch(e){return j(503,{error:'wallet_fee_unavailable',detail:RSM.RESUME_TEXT.wallet_fee_unavailable()});}
        if(RSM.checkResumeCalls(calls,{wallet:R.wallet,trust:SU.trust,feeTo})!==q.usdc)return j(503,{error:'wallet_fee_unavailable',detail:RSM.RESUME_TEXT.wallet_fee_unavailable()});
        const sid=sp.registerResume?.(id,{owner:R.owner,wallet:R.wallet,calls,reimburse:q.usdc});if(!sid)return j(503,{error:'wallet_fee_unavailable',detail:RSM.RESUME_TEXT.wallet_fee_unavailable()});
        const pm=`${PUBLIC0}/onboard/new/paymaster?id=${sid}`;RP.clear();const pl={id,calls,fee:q.usdc,feeTo,pm,at:Date.now(),state:'prepared'};RP.set(id,pl);
        OBS.log('safety_resume',{ok:true,chain:'paused',plan:true,fee:String(q.usdc)});
        return j(202,{state:'confirm_on_chain',id,url:`${PUBLIC}/safety/resume?plan=${id}`,owner:R.owner,from:R.owner,wallet:R.wallet,chainId:8453,trust:SU.trust,calls,
          fee:{usdc:String(q.usdc),usdcText:ft,gas:String(q.gas),gasPriceWei:String(q.gasPriceWei)},feeTo,feeFrom:RSM.RESUME_FEE_FROM,pm,
          detail:{zh:`还差一步：在 Coinbase 确认一笔，解除链上暂停。手续费 ${ft} USDC，从启付钱包扣。`,en:`One more step: confirm one transaction in Coinbase to lift the on-chain pause. Network fee ${ft} USDC, from your Kipurse wallet.`}});}
      if(u.pathname.startsWith('/v1/')){/* t1161 (decision 78): an AI using the REST API with its agent key is "used" too */const va=resolveAgent(agents,String(req.headers.authorization??'').replace(/^Bearer /,''));if(va)seen(va.id);return v1.emit('request',req,res);}return j(404,{error:'not_found'});}catch(e){try{j(500,{error:'error'});}catch{}}
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
  const DV53H={v:null};   // t1187: one-time V5.3 deploy page (set below)
  const DV54H={v:null},MG54H={v:null},SG55H={v:null};   // t1214: V5.4 deploy page / owner wallet migration (both flag-gated, default OFF; set below)
  const SPC=sponsorConfig(process.env);delete process.env.KIPURSE_ONBOARD_PAYMASTER_URL;
  const SPONSOR=ONBOARD_ON&&SPC.url?createOnboardSponsor({cfg:SPC,kv:KV,reg:REG,obs:OBS,chainId:8453,lookup:id=>KV.get(kvKey('onbnew',null,id)),
    ethUsd8:async()=>{const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');return (await pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}))[1];},gasPrice:()=>pub.getGasPrice(),deployV53Open:async(step)=>DV53H.v?await DV53H.v.open(step):false,deployV54Open:async()=>DV54H.v?await DV54H.v.open():false,migrateV54Open:async(o)=>MG54H.v?await MG54H.v.open(o):false,...(V55ON?{v55Open:async(o)=>SG55H.v?await SG55H.v.open(o):false}:{})}):null;
  SPONSOR_HOLDER.v=SPONSOR;
  console.log(JSON.stringify({event:'onboard_sponsor_config',enabled:!!SPONSOR,maxPerDay:SPC.maxPerDay,maxUsdPerDay:SPC.maxUsdPerDay,maxUsdPerOp:SPC.maxUsdPerOp}));
  const V3NEW=(overrides.approverVersion??process.env.KIPURSE_PHONE_APPROVER)==='v3';
  /* t1238 decision 109: new wallets get ALL owners at creation [owner, key seat, SPM]; phone changes = seat.setKey via the wallet. Default OFF. */
  const KEY_SEAT=(overrides.keySeat??process.env.KIPURSE_KEY_SEAT)==='1'||overrides.keySeat===true;OBS.log('key_seat',{enabled:KEY_SEAT});
  const {verifyAttestation}=await import(G+'src/v5/app-attest.mjs');const AA_ID=process.env.KIPURSE_APP_ID??'YOUR_TEAM_ID.org.example.kipurse.app';
  // t796 M4: default 'sponsor' (free first setup only with a genuine-app attestation). The Debug/TestFlight bundle (.test) of the same team is accepted too.
  const AA_IDS=[AA_ID,AA_ID+'.test'];const APP_ATTEST={mode:process.env.KIPURSE_APP_ATTEST??'sponsor',verify:a=>{let r={ok:false,reason:'none'};for(const id of AA_IDS){r=verifyAttestation({...a,appId:id});if(r.ok)return r;}return r;},log:(k,v)=>OBS.log(k,v)};
  /* t1197 (decision 92): the suite new wallets open on. V5.3 only when its adapter is on chain and wired to the published trust + factory; else V5.2 (as before). */
  const NS=await (async()=>{const s=overrides.v53===null?null:(overrides.v53??V53FILE);if(!s)return suiteOf(null);
    try{const A=getAddress(s.adapter),T=getAddress(s.trust),Fa=getAddress(s.factory);const ab=parseAbi(['function trust() view returns (address)','function vaultFactory() view returns (address)']);
      const [c,t,f]=await Promise.all([pub.getCode({address:A}),pub.readContract({address:A,abi:ab,functionName:'trust'}),pub.readContract({address:A,abi:ab,functionName:'vaultFactory'})]);
      if(c&&c!=='0x'&&getAddress(t)===T&&getAddress(f)===Fa){OBS.log('new_wallet_suite',{suite:'v5.3'});return {name:'v5.3',adapter:A,trust:T};}}catch{}
    OBS.log('new_wallet_suite',{suite:'v5.2',reason:'v53_not_verified'});return suiteOf(null);})();
  /* t1250 (decision 119): with KIPURSE_V55=1 AND KIPURSE_KEY_SEAT=1, NEW wallets open directly on V5.5 (seat V2, owners [Base Account, seat V2, SPM]) once the
     V5.5 adapter is on chain and wired to the pinned trust + factory; otherwise exactly as before. */
  const NS55=V55ON&&KEY_SEAT?await (async()=>{try{const SV=await import(G+'src/v5/suite-v55.mjs');const ab=parseAbi(['function trust() view returns (address)','function vaultFactory() view returns (address)']);
    const A=getAddress(SV.V55.adapter);const [c,t,f]=await Promise.all([pub.getCode({address:A}),pub.readContract({address:A,abi:ab,functionName:'trust'}),pub.readContract({address:A,abi:ab,functionName:'vaultFactory'})]);
    if(c&&c!=='0x'&&getAddress(t)===getAddress(SV.V55.trust)&&getAddress(f)===getAddress(SV.V55.factory)){OBS.log('new_wallet_suite',{suite:'v5.5'});return {name:'v5.5',adapter:A,trust:getAddress(SV.V55.trust)};}}catch{}
    OBS.log('new_wallet_suite_v55',{enabled:false,reason:'v55_not_verified'});return null;})():null;
  const NEW=createNewWalletOnboarding({appAttest:APP_ATTEST,verified:(o=>checkVerifiedMulti([pub,...String(process.env.KIPURSE_CBV_RPCS??'https://mainnet.base.org,https://base-rpc.publicnode.com').split(',').filter(Boolean).map(u=>createPublicClient({transport:http(u,{timeout:8000})}))],o,{log:x=>console.log(JSON.stringify({t:'cbv',...x}))})),enabled:ONBOARD_ON,keyProof:async(w,{x,y},req)=>{if(!req)return false;try{const t=await getTenant(w);return !!t?.PS?.check(req);}catch{return false;}},sponsor:SPONSOR,executorFor:w=>KR.ensure(w),kv:KV,pub,cfg:{adapter:NS.adapter,trust:NS.trust,token:X.token,manager:X.manager,approverVersion:overrides.approverVersion??process.env.KIPURSE_PHONE_APPROVER,keySeat:KEY_SEAT,...(NS55?{adapter:NS55.adapter,trust:NS55.trust,seatV2:true}:{})},reg:REG,base:()=>PUBLIC0,chainId:8453,
    policy:()=>decodePolicyV5(permissionFromJson(X.currentPermission).extraData),noteFirstKey:({x,y,approver,seat,version})=>{try{if(!seat)PH.addPending({x,y,approver,maxSingle:'1',maxDaily:'1',version:APPROVER_VERSION==='v3'?'v3':'v2'});}catch{}},quote:async(owner0)=>{const {OPENING_WITH_FIRST_KEY_GAS,openingFeeUSDC,fmtOpeningFeeUSDC}=await import(G+'src/v5/usdc-gas.mjs');const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');
      const [gp,rd]=await Promise.all([pub.getGasPrice(),pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'})]);
      const of=openingFeeUSDC({gasPriceWei:gp,ethUsd8:rd[1],gas:OPENING_WITH_FIRST_KEY_GAS});const u=of.fee;const f={wei:of.wei,usdc:u};
      const base0={gas:String(OPENING_WITH_FIRST_KEY_GAS),gasPriceWei:String(gp),feeWei:String(f.wei),feeUSDC:fmtOpeningFeeUSDC(u),sponsoredByKipurse:false,includesPhoneApprover:true,signatures:1,transactions:1,
        limitsChangeUSDC:await (async()=>{try{const {limitsChangeFee}=await import(G+'src/v5/limits-fee.mjs');const {fmtUsdc}=await import(G+'src/v5/limits-public.mjs');return fmtUsdc(limitsChangeFee({callGas:null,gasPriceWei:gp,ethUsd8:rd[1]}).usdc);}catch{return null;}})(),gasToken:'USDC'};
      // fee-quote fix: always a string payer (the app requires it); balances only for a valid owner. Read failures (new/undeployed Base Account, RPC) never break the quote.
      let o=null;try{if(/^0x[0-9a-fA-F]{40}$/.test(String(owner0??'')))o=getAddress(owner0);}catch{}
      if(!o)return {...base0,payer:'',payerEthWei:null,payerUSDC:null,payerCanPayEth:false,payerCanPayUSDC:null};
      const [eth,bal]=await Promise.all([pub.getBalance({address:o}).catch(()=>null),pub.readContract({address:X.token,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[o]}).catch(()=>null)]);
      return {...base0,payer:o,payerEthWei:eth===null?null:String(eth),payerUSDC:bal===null?null:String(bal),payerCanPayEth:eth!==null&&eth>=f.wei,payerCanPayUSDC:bal===null?null:bal>=u+(u/2n)};},
    script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/onboard-new.js');})(),
    tenantStart:async(w,b)=>(await getTenant(w)).ONB.start(b),tenantConfirm:async(w,id)=>{const t=await getTenant(w);const r=await t.ONB.confirm(id);t.reindex();return r;},
    register:async o=>{const rec=REG.add({wallet:o.wallet,owner:o.owner,vault:o.vault,ownerIndex:0,fromBlock:o.fromBlock,publicPath:'/t/'+String(o.wallet).toLowerCase(),permission:o.permission,createdAt:new Date().toISOString(),...(NS.name==='v5.3'?{suite:'v5.3',adapter:NS.adapter,trust:NS.trust}:{}),...(NS55?{suite:'v5.5',adapter:NS55.adapter,trust:NS55.trust,seatVersion:'seat2'}:{})});
      const F=recFiles(rec);const {fingerprint}=await import(G+'src/v5/phone-signer.mjs');
      const st={permission:o.permission,phone:o.seat?{seat:o.seat,active:{approver:o.seat,x:o.x,y:o.y,maxSingle:NO_CEILING,maxDaily:NO_CEILING,version:NS55?'seat2':'seat1',fingerprint:fingerprint(o.x,o.y),enrolledAt:new Date().toISOString()}}
        :{active:{approver:o.approver,x:o.x,y:o.y,...(V3NEW?{maxSingle:NO_CEILING,maxDaily:NO_CEILING,version:'v3'}:{maxSingle:o.choice.single,maxDaily:o.choice.daily,version:'v2'}),fingerprint:fingerprint(o.x,o.y),enrolledAt:new Date().toISOString()}}};
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
  // t1187 (decision 87): one-time V5.3 deploy page for the owner's Base Account. Fixed batch only; inert once both contracts have code.
  const DV53=await (async()=>{try{if(!SPONSOR||!X.ownerBaseAccount)return null;const {createDeployV53,loadV53Plan}=await import(G+'src/v5/deploy-v53.mjs');const {readRaw}=await import(G+'src/v5/router.mjs');const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');
    const d=createDeployV53({plan:loadV53Plan(G+'mainnet/v53-deploy-plan.json'),owner:X.ownerBaseAccount,pub,sponsor:SPONSOR,base:()=>PUBLIC0,readRaw,script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/deploy-v53.js');})(),
      ethUsd8:async()=>(await pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}))[1]});
    DV53H.v=d;OBS.log('deploy_v53_page',{enabled:true});return d;}catch(e){OBS.log('deploy_v53_page',{enabled:false,reason:scrubUrls(e?.message??e).slice(0,80)});return null;}})();
  // t1214 (decision 102): one-time V5.4 adapter deploy page (owner's Base Account; same way as V5.3). OFF unless KIPURSE_DEPLOY_V54=1.
  const DV54=await (async()=>{try{const {createDeployV54,loadV54Plan,deployV54On}=await import(G+'src/v5/deploy-v54.mjs');if(!deployV54On(ENV))return null;if(!SPONSOR||!X.ownerBaseAccount)return null;
    const {readRaw}=await import(G+'src/v5/router.mjs');const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');
    const d=createDeployV54({plan:loadV54Plan(G+'mainnet/v54-deploy-plan.json'),owner:X.ownerBaseAccount,pub,sponsor:SPONSOR,base:()=>PUBLIC0,readRaw,script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/deploy-v54.js');})(),
      ethUsd8:async()=>(await pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}))[1]});
    DV54H.v=d;OBS.log('deploy_v54_page',{enabled:true});return d;}catch(e){OBS.log('deploy_v54_page',{enabled:false,reason:scrubUrls(e?.message??e).slice(0,80)});return null;}})();
  // t1214 (decision 102 / decision 101): the operator wallet's switch to V5.4, opened only from the developer/test App. OFF unless KIPURSE_MIGRATE_V54=1.
  const MG54=await (async()=>{try{const M=await import(G+'src/v5/migrate-v54.mjs');if(!M.migrateV54On(ENV))return null;if(!SPONSOR||!X.ownerBaseAccount||!legacy())return null;
    const {readRaw}=await import(G+'src/v5/router.mjs');const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');const W0=legacy();const MK=kvKey('migrate54',String(W0).toLowerCase(),'record');
    const KN=(()=>{try{return JSON.parse(fs.readFileSync(G+'mainnet/v54-migrate-known.json','utf8'));}catch{return {};}})();   // stored trusts as the owner set them on V5.2 (re-checked on chain below)
    const m=M.createMigrateV54({owner:X.ownerBaseAccount,wallet:W0,pub,sponsor:SPONSOR,base:()=>PUBLIC0,readRaw,store:{get:()=>KV.get(MK)??null,put:v=>KV.put(MK,v)},
      script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/migrate-v54.js');})(),
      gasPrice:fork&&overrides.migrateGasPrice?async()=>BigInt(overrides.migrateGasPrice):null,   // fork rehearsal only (anvil's gas price is not Base's)
      ethUsd8:async()=>(await pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}))[1],
      known:async()=>{const t=await getTenant(W0);const st=t?.S??{};const TA=parseAbi(['function trustOf(address,bytes32) view returns (uint64,uint64,bool,uint160,uint160)']);
        const trusts=[];for(const k of (KN.trusts??[])){try{const r=await pub.readContract({address:X.trust,abi:TA,functionName:'trustOf',args:[W0,k.merchant]});if(r[2]&&BigInt(r[1])===BigInt(k.expiry)&&BigInt(r[3])===BigInt(k.single)&&BigInt(r[4])===BigInt(k.daily))trusts.push(k);}catch{}}
        return {oldPermission:st.permission,oldAdapter:X.adapter,oldTrust:X.trust,trusts,deniedPayees:KN.deniedPayees??[],deniedSigners:KN.deniedSigners??[],openReservations:[],serverInFlight:!!t?.engine?.()?.inFlight?.()};},
      onMigrated:async r=>{OBS.log('migrate_v54_landed',{});/* the switch of this wallet's suite to V5.4 is a separate, owner-confirmed server step (env KIPURSE_V54_SUITE_WALLET); nothing changes here */},
      /* t1238 decision 109 (owner chose (1)): mode=seat moves the money to a NEW key-seat wallet on V5.4 with its OWN executor key. After the chain shows it,
         register the new wallet for this owner (first in byOwner) and retire the old one (kept, never deleted). The AIs are reconnected by the owner. */
      executorFor:w=>KR.ensure(w),
      onMoved:async r=>{const m=r.seatMove;const NW=getAddress(m.newWallet);if(REG.get(NW))return;const PS=await import(G+'src/v5/phone-signer.mjs');
        const h=v=>'0x'+BigInt(v).toString(16).padStart(64,'0');const xh=h(m.x),yh=h(m.y);
        const rec=REG.add({wallet:NW,owner:X.ownerBaseAccount,vault:m.vaultNew,ownerIndex:0,fromBlock:Math.max(0,Number(await pub.getBlockNumber())-5000),publicPath:'/t/'+NW.toLowerCase(),
          permission:m.newPermission,createdAt:new Date().toISOString(),suite:'v5.4',adapter:'0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa',trust:'0x22eF1633252653932076cB911b155F9D7f73A9E9',seat:m.seat,movedFrom:getAddress(W0)});
        const F=recFiles(rec);const ST=storeFor(NW);ST.writeJson(F.state,{permission:m.newPermission,phone:{seat:m.seat,active:{approver:m.seat,x:xh,y:yh,maxSingle:PS.NO_CEILING,maxDaily:PS.NO_CEILING,version:'seat1',fingerprint:PS.fingerprint(xh,yh),enrolledAt:new Date().toISOString()}}});
        ST.writeJson(F.agents,[]);IDX.set('phone',xh,NW);copyPush(W0,NW);REG.update(W0,{retired:true,movedTo:NW});OBS.log('tenant_moved',{count:1});}});
    MG54H.v=m;OBS.log('migrate_v54',{enabled:true});return m;}catch(e){OBS.log('migrate_v54',{enabled:false,reason:scrubUrls(e?.message??e).slice(0,80)});return null;}})();
  /* t1250 (decision 119): the owner's V5.5 signing pages (deploy batches + V5.4 -> V5.5 move). OFF unless KIPURSE_V55=1 (and the sponsor + owner Base Account
     exist). The move starts from the owner's current V5.4 wallet (registry: suite v5.4, not retired); after the chain shows it, the new wallet is
     registered (suite v5.5, movedFrom = the old one, same phone key in its seat V2) and the old one is retired (kept, never deleted). */
  const SG55=await (async()=>{if(!V55ON||!SPONSOR||!X.ownerBaseAccount)return null;try{const SV=await import(G+'src/v5/sign-v55.mjs');const DV=await import(G+'src/v5/deploy-v55.mjs');const WV=await import(G+'src/v5/wallet-v55.mjs');
    const {readRaw}=await import(G+'src/v5/router.mjs');const {ETH_USD_FEED}=await import(G+'src/v5/phone-signer.mjs');const MK=kvKey('v55',String(X.ownerBaseAccount).toLowerCase(),'record');
    const old=REG.byOwner(X.ownerBaseAccount).find(r=>r.suite==='v5.4'&&!r.retired)??null;
    const s=SV.createSignV55({owner:X.ownerBaseAccount,pub,sponsor:SPONSOR,plan:DV.loadV55Plan(G+'mainnet/v55-deploy-plan.json'),base:()=>PUBLIC0,readRaw,store:{get:()=>KV.get(MK)??null,put:v=>KV.put(MK,v)},
      script:(()=>{let c;return()=>c??=fs.readFileSync(G+'owner-sign/static/v55.js');})(),gasPrice:fork&&overrides.migrateGasPrice?async()=>BigInt(overrides.migrateGasPrice):null,
      ethUsd8:async()=>(await pub.readContract({address:ETH_USD_FEED,abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}))[1],
      move:old?{oldWallet:getAddress(old.wallet),executorFor:w=>KR.ensure(w),
        known:async()=>{let t=null;try{t=await getTenant(old.wallet);}catch{}return {oldPermission:t?.S?.permission??old.permission,trusts:[],deniedPayees:[],deniedSigners:[],openReservations:[],serverInFlight:!!t?.engine?.()?.inFlight?.()};},
        onMoved:async m=>{const NW=getAddress(m.newWallet);if(REG.get(NW))return;const PS=await import(G+'src/v5/phone-signer.mjs');const h=v=>'0x'+BigInt(v).toString(16).padStart(64,'0');
          const rec=REG.add(WV.newWalletRecordV55({move:{newWallet:NW,newPermission:m.newPermission,seat:m.seat},owner:X.ownerBaseAccount,oldWallet:old.wallet,vault:m.vault,fromBlock:Math.max(0,Number(await pub.getBlockNumber())-5000)}));
          const F=recFiles(rec);const ST=storeFor(NW);const ph=m.x?{seat:m.seat,active:{approver:m.seat,x:h(m.x),y:h(m.y),maxSingle:PS.NO_CEILING,maxDaily:PS.NO_CEILING,version:'seat2',fingerprint:PS.fingerprint(h(m.x),h(m.y)),enrolledAt:new Date().toISOString()}}:{seat:m.seat,active:null};
          ST.writeJson(F.state,{permission:m.newPermission,phone:ph});ST.writeJson(F.agents,[]);if(m.x)IDX.set('phone',h(m.x),NW);copyPush(old.wallet,NW);REG.update(old.wallet,{retired:true,movedTo:NW});OBS.log('tenant_moved_v55',{count:1});}}:null});
    SG55H.v=s;OBS.log('v55_pages',{enabled:true,move:!!old});return s;}catch(e){OBS.log('v55_pages',{enabled:false,reason:scrubUrls(e?.message??e).slice(0,80)});return null;}})();
  const {withLang}=await import(G+'src/v5/i18n.mjs');const {withSignCors}=await import(G+'src/v5/cors.mjs');const agentSrv=httpMod.createServer(withSignCors(withLang(OBS.wrap(createAgentRouter({reg:REG,index:IDX,kv:KV,obs:OBS,tenants:CACHE,legacy:legacyRoute,env:ENV,verifyP256:pv,onboardNew:NEW,signin:SIGNIN,deposit:DEPOSIT,deployV53:DV53,deployV54:DV54,migrateV54:MG54,...(SG55?{signV55:SG55}:{}),rl:{ip:RL_IP,tenant:RL_T}})))));
  // t1238: a wallet that moved away (retired; its permission was revoked on chain) must not stop the server from starting
  if(legacy()){if(REG.get(legacy())?.retired)OBS.log('legacy_retired_not_loaded',{});else await getTenant(legacy());}   // t1265: a retired wallet is never built (no runtime, no index entries)
  {const r0=legacy()&&REG.get(legacy());if(r0?.retired&&r0.movedTo)copyPush(legacy(),r0.movedTo);}   // t1239: a move done before this release
  // t1265: restored-from-backup data must not bring an erased RETIRED wallet back either (live wallets do this in buildTenant)
  for(const rec of (REG.all?.()??[]))if(rec.retired){try{const t=TOMB_G.latest(rec.wallet);if(t!==null&&!(Number(rec.erasedAt??0)>=t)){await eraseRetired(rec,{tombstone:false,at:t});OBS.log('tombstone_check',{reason:'reapplied_retired'});}}catch(e){OBS.log('tombstone_check',{reason:'error_retired'});if(!fork&&ENV.KIPURSE_TOMBSTONE_STRICT!=='0')throw e;}}
  // one-shot at startup (no cron): load every tenant so pending 10-minute holds are re-armed and due ones run without waiting for a request
  setTimeout(async()=>{let n=0;for(const rec of (REG.all?.()??[])){if(rec.retired)continue;try{const t=await getTenant(rec.wallet);const due=t?.engine?.()?.pendingHoldsDue?.()??0;n+=due;}catch{}}OBS.log('holds_rearmed',{pending:n});},3000).unref?.();
  {const {applyServerTimeouts}=await import(G+'src/v5/obs.mjs');applyServerTimeouts(agentSrv);}   /* t1278 S1: requestTimeout / headersTimeout (were Node defaults 300 s / 60 s) */
  await new Promise(r=>agentSrv.listen(agentPort,'127.0.0.1',r));
  const T0=async()=>{if(!legacy()||REG.get(legacy())?.retired)return null;try{return await getTenant(legacy());}catch(e){if(REG.get(legacy())?.retired)return null;throw e;}};const t0=await T0();   // t1238: retired (moved-away) legacy wallet must not stop startup
  return {signin:SIGNIN,registry:REG,index:IDX,tenant:getTenant,newOnboard:NEW,phone:t0?.PH,phoneSession:t0?.PS,ownerPay:t0?.OPAY,limits:t0?.LIM,readState:t0?.readState,oauth:t0?.OA,state:t0?.S,engine:()=>t0?.engine(),cfg:t0?.cfg,
    ownerSurface:t0?.ownerSurface,agentSrv,ownerUrl:`http://localhost:${ownerPort}`,agentUrl:`http://127.0.0.1:${agentPort}`,kv:KV,obs:OBS,
    close:async()=>{clearInterval(revokeTimer);for(const t of TEN.values())try{(await t).close();}catch{}agentSrv.close();try{KV.close();}catch{}}};}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(new URL(import.meta.url).pathname)){
  const GO=process.env.KIPURSE_MAINNET_GO??(()=>{try{return JSON.parse(fs.readFileSync(join(CONF,'mainnet-trustflow.config.json'))).ownerDecision?.go}catch{return null}})();
  if(GO!=='owner-confirmed')throw Error('Owner has not said go. Refusing to start on Base mainnet.');
  const r=await startMainnet();console.log(JSON.stringify({mainnet:true,ownerPage:r.ownerUrl,loginLinkFile:join(DATA,'owner-login-url.txt'),agentApi:r.agentUrl}));}
