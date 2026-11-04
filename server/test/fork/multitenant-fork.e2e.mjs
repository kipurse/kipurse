// FORK-ONLY, launch-level: the multi-user gateway. Tenant A = migrated single-wallet deployment (legacy URLs, files untouched);
// tenant B = a brand-new user created through /onboard/new (factory wallet + permission + phone approver V2 in his own batch).
// Then cross-tenant attacks, wallet discovery, erase isolation.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,getAddress,decodeAbiParameters,toHex,hashMessage} from 'viem';import {base} from 'viem/chains';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import * as P256 from 'ox/P256';
import {WALLET_ABI} from '../../src/v5/phone-signer.mjs';import {decodePolicyV5} from '../../src/v5/abi.mjs';import {hashToken,mintAgentToken} from '../../src/v4/agents.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;const GW=new URL('../../',import.meta.url).pathname;
const AD=parseAbi(['function trust() view returns (address)','function vaultAddress(address) view returns (address)']);
test('multi-user gateway: migrate, new user, isolation, discovery, erase',{skip:!RPC||!PJ,timeout:600000},async()=>{
  const perm=JSON.parse(PJ);const W=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);const pol=decodePolicyV5(perm.extraData);const EXEC=getAddress(pol.executor);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});const vault=await pub.readContract({address:A,abi:AD,functionName:'vaultAddress',args:[W]});
  const OWNER=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  for(const a of [EXEC,OWNER]){await tc.impersonateAccount({address:a});await tc.setBalance({address:a,value:10n**18n});}
  {// FIXTURE FIX: the fixture wallet is empty on mainnet now -> top it up on the FORK from a USDC whale
    const WH='0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';await tc.impersonateAccount({address:WH});await tc.setBalance({address:WH,value:10n**18n});
    const h=await createWalletClient({chain:base,transport:vh(RPC),account:WH}).writeContract({address:getAddress(JSON.parse(PJ).token),abi:parseAbi(['function transfer(address,uint256) returns (bool)']),functionName:'transfer',args:[getAddress(JSON.parse(PJ).account),50_000_000n]});await pub.waitForTransactionReceipt({hash:h});}
  const run=async(calls,from)=>{let g=0n;for(const c of calls){const h=await createWalletClient({chain:base,transport:vh(RPC),account:from}).sendTransaction({to:c.to,data:c.data,value:BigInt(c.value??0)});const r=await pub.waitForTransactionReceipt({hash:h});assert.equal(r.status,'success');g+=r.gasUsed;}return g;};
  const kp=()=>{const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});return {privateKey,x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};};
  const sign=(d,k)=>{const s=P256.sign({payload:d,privateKey:k.privateKey});return {r:toHex(s.r,{size:32}),s:toHex(s.s,{size:32})};};
  const dir=mkdtempSync(join(tmpdir(),'mt-'));const CONF=join(dir,'conf'),DATA=join(dir,'data');fs.mkdirSync(CONF);fs.mkdirSync(DATA);
  const tokA=mintAgentToken();fs.writeFileSync(join(CONF,'agents.json'),JSON.stringify([{id:'grok-bot',tokenSha256:hashToken(tokA)}]));
  fs.writeFileSync(join(CONF,'mainnet-trustflow.config.json'),JSON.stringify({chainId:8453,wallet:W,ownerBaseAccount:OWNER,token:USDC,adapter:A,trust,vault,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
    currentPermission:perm,newCaps:{single:pol.single},engine:{chainId:8453,rpc:RPC,adapter:A,trust,token:USDC,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',ownerSigner:{wallet:W,ownerIndex:0},
      ownerRulesDir:join(DATA,'owner-rules'),ledgerFile:join(DATA,'ledger.sqlite')}}));
  const SF=join(DATA,'runtime-state.json');fs.writeFileSync(SF,JSON.stringify({permission:perm}));const before=fs.readFileSync(SF,'utf8');
  process.env.KIPURSE_REQUIRE_CBV='0';/* CBV gate: covered by test/cb-verified.test.mjs (fork has no attestations for random owners) */process.env.KIPURSE_GATEWAY=GW;process.env.KIPURSE_MAIN_CONFIG_DIR=CONF;process.env.KIPURSE_MAIN_DATA_DIR=DATA;
  console.log('STEP import');
  const {startMainnet}=await import('../../mainnet/mainnet-owner-launch.mjs?mt');const port=18700+Math.floor(Math.random()*200);
  const M=await startMainnet({fork:true,agentPort:port,ownerPort:port+1000,stateFile:SF,overrides:{rpc:RPC,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,gasMode:'legacy',onboard:true,userErase:true,ownerPay:true,phoneOnChain:async()=>true,
    gasPricing:{usdcPerEth:'3000000000',gasPriceWei:'10000000'},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,publicBase:'http://fork.invalid',kvFile:join(DATA,'kv.sqlite')}});
  console.log('STEP started');
  const U=`http://127.0.0.1:${port}`;const R={};
  const call=async(path,{method='GET',body,headers={}}={})=>{const r=await fetch(U+path,{method,headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json();}catch{}return {status:r.status,j};};
  const mcp=(path,tok,h={})=>call(path,{method:'POST',headers:{authorization:'Bearer '+tok,accept:'application/json, text/event-stream',...h},body:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'t',version:'1'}}}});
  // ---- migration: A registered, legacy files untouched, legacy URLs work
  assert.equal(M.registry.count(),1);const recA=M.registry.get(W);assert.equal(recA.publicPath,'');assert.equal(fs.readFileSync(SF,'utf8').includes(perm.salt??''),true);
  R.legacyMcp=(await mcp('/mcp',tokA)).status;assert.equal(R.legacyMcp,200);
  console.log('STEP migrated');
  // A binds a phone through its own tenant (Base Account = OWNER signs)
  const kA=kp();const TA=await M.tenant(W);const e=await TA.PH.enroll(kA);await run(TA.PH.calls(TA.S.phone.pending[e.id]),OWNER);assert.equal((await TA.PH.confirm(e.id)).ok,true);TA.reindex();
  console.log('STEP phoneA');
  // ---- new user B: random Base Account (EOA owner on the fork), phone kB, chosen limits; ONE batch built for HIS owner
  const ownB=privateKeyToAccount(generatePrivateKey());await tc.setBalance({address:ownB.address,value:10n**17n});const kB=kp();
  R.newQuote=(await call('/onboard/new/quote')).j;assert.ok(R.newQuote?.feeUSDC&&R.newQuote.sponsoredByKipurse===false&&(R.newQuote.payer===null||R.newQuote.payer===''),JSON.stringify(R.newQuote));
  const st=await call('/onboard/new/start',{method:'POST',body:{x:kB.x,y:kB.y,single:'2',daily:'5',term:'20',days:30}});assert.equal(st.status,200,JSON.stringify(st.j));
  const pg=await fetch(U+'/onboard/new?id='+st.j.id);assert.equal(pg.status,200);
  const pr=await call('/onboard/new/prepare',{method:'POST',body:{id:st.j.id,owner:ownB.address}});assert.equal(pr.status,200,JSON.stringify(pr.j));assert.equal(pr.j.existing,false);
  console.log('STEP prepared');
  const WB=getAddress(pr.j.wallet);R.newGas=String(await run(pr.j.calls,ownB));
  const cf=await call('/onboard/confirm',{method:'POST',body:{id:st.j.id}});assert.equal(cf.j?.ok,true,JSON.stringify(cf.j));assert.equal(getAddress(cf.j.wallet),WB);
  assert.equal((await call('/onboard/new/status?id='+st.j.id)).j.wallet,WB);assert.equal(M.registry.count(),2);
  // forged owner: preparing for someone else's Base Account yields HIS wallet batch (useless to the attacker: only that owner can sign it)
  console.log('STEP created');
  // ---- discovery by phone key
  const find=async k=>{const c=await call('/phone/find/challenge',{method:'POST'});return call('/phone/find',{method:'POST',body:{nonce:c.j.nonce,x:k.x,y:k.y,...sign(c.j.digest,k)}});};
  R.findB=(await find(kB)).j;assert.equal(getAddress(R.findB.wallet),WB);R.findA=(await find(kA)).j;assert.equal(getAddress(R.findA.wallet),W);
  const kX=kp();R.findUnknown=(await find(kX)).status;assert.equal(R.findUnknown,404);
  {const c=await call('/phone/find/challenge',{method:'POST'});R.findForged=(await call('/phone/find',{method:'POST',body:{nonce:c.j.nonce,x:kB.x,y:kB.y,...sign(c.j.digest,kA)}})).status;assert.equal(R.findForged,401);}
  console.log('STEP found');
  {const c=await call('/phone/find/challenge',{method:'POST'});const body={nonce:c.j.nonce,x:kB.x,y:kB.y,...sign(c.j.digest,kB)};R.replayFind=[(await call('/phone/find',{method:'POST',body})).status,(await call('/phone/find',{method:'POST',body})).status];assert.deepEqual(R.replayFind,[200,400]);}
  // ---- sessions
  const PB='/t/'+WB.toLowerCase(),PA='/t/'+W.toLowerCase();
  const sess=async(pre,k)=>{const c=await call(pre+'/phone/session/challenge',{method:'POST'});if(c.status!==200)return c;return call(pre+'/phone/session',{method:'POST',body:{nonce:c.j.nonce,...sign(c.j.digest,k)}});};
  {const c=await call(PB+'/phone/session/challenge',{method:'POST'});const body={nonce:c.j.nonce,...sign(c.j.digest,kB)};R.replaySession=[(await call(PB+'/phone/session',{method:'POST',body})).status,(await call(PB+'/phone/session',{method:'POST',body})).status];assert.equal(R.replaySession[0],200);assert.ok(R.replaySession[1]>=400);}
  R.injection=[(await call("/t/0x1111'%20OR%201=1/mcp")).status,(await call('/phone/find',{method:'POST',body:{nonce:{$ne:1},x:'<script>',y:1,r:1,s:1}})).status,(await call('/onboard/new/start',{method:'POST',body:{x:'1',y:'2',single:'1e99',daily:'-1',term:'x'}})).status];
  assert.ok(R.injection.every(c=>c>=400&&c<500),JSON.stringify(R.injection));
  const sB=await sess(PB,kB);assert.equal(sB.status,200,JSON.stringify(sB.j));const sA=await sess('',kA);assert.equal(sA.status,200);
  const stB=await call(PB+'/phone/session/state',{headers:{authorization:'Bearer '+sB.j.token}});assert.equal(stB.status,200,JSON.stringify(stB.j));
  console.log('STEP sessions');
  // ---- cross-tenant attacks
  const atk={};
  atk.agentTokA_onB=(await mcp(PB+'/mcp',tokA)).status;
  atk.agentTokA_cookieB=(await mcp('/mcp',tokA,{cookie:'kpt='+WB.toLowerCase()})).status;
  atk.agentTokA_headerB=(await mcp('/mcp',tokA,{'x-kipurse-wallet':WB})).status;
  atk.bogusTok_onB=(await mcp(PB+'/mcp',mintAgentToken())).status;
  atk.sessA_onB=(await call(PB+'/phone/session/state',{headers:{authorization:'Bearer '+sA.j.token}})).status;
  atk.sessB_onA=(await call('/phone/session/state',{headers:{authorization:'Bearer '+sB.j.token}})).status;
  atk.phoneA_sessionOnB=(await sess(PB,kA)).status;
  atk.ownerPayB_withSessA=(await call(PB+'/owner/pay/prepare',{method:'POST',headers:{authorization:'Bearer '+sA.j.token},body:{}})).status;
  {// OAuth: a live access token issued by tenant A must not work on tenant B (any routing trick)
    const {createHash,randomBytes}=await import('node:crypto');const oTok=randomBytes(32).toString('hex');const TA2=await M.tenant(W);
    TA2.S.oauthAgents??={};TA2.S.oauthAgents['oauth-xt']={id:'oauth-xt',name:'xt',kind:'xt',created:new Date().toISOString()};TA2.S.oauth.tokens[createHash('sha256').update(oTok).digest('hex')]={type:'access',agentId:'oauth-xt',exp:Date.now()/1000+600};
    R.oauthA_onA=(await mcp('/mcp',oTok)).status;assert.equal(R.oauthA_onA,200);
    atk.oauthA_onB=(await mcp(PB+'/mcp',oTok)).status;atk.oauthA_headerB=(await mcp('/mcp',oTok,{'x-kipurse-wallet':WB})).status;atk.oauthA_cookieB=(await mcp('/mcp',oTok,{cookie:'kpt='+WB.toLowerCase()})).status;
    delete TA2.S.oauthAgents['oauth-xt'];}
  atk.unknownTenant=(await mcp('/t/0x0000000000000000000000000000000000000001/mcp',tokA)).status;
  {const c=await call(PB+'/user/erase/challenge',{method:'POST',headers:{authorization:'Bearer '+sB.j.token}});
    atk.eraseB_signedByA=(await call(PB+'/user/erase',{method:'POST',headers:{authorization:'Bearer '+sB.j.token},body:{nonce:c.j.nonce,phrase:'DELETE',...sign(c.j.digest,kA)}})).status;}
  R.attacks=atk;console.log('ATTACKS',JSON.stringify(atk));for(const [k,v] of Object.entries(atk))assert.ok([401,403,404,409,400].includes(v),k+' -> '+v);
  console.log('STEP attacks');
  // ---- erase B: B gone from indexes, A untouched
  const c=await call(PB+'/user/erase/challenge',{method:'POST',headers:{authorization:'Bearer '+sB.j.token}});
  const er=await call(PB+'/user/erase',{method:'POST',headers:{authorization:'Bearer '+sB.j.token},body:{nonce:c.j.nonce,phrase:'DELETE',...sign(c.j.digest,kB)}});assert.equal(er.status,200,JSON.stringify(er.j));
  R.afterErase={findB:(await find(kB)).status,findA:(await find(kA)).status,mcpA:(await mcp('/mcp',tokA)).status,sessA:(await call('/phone/session/state',{headers:{authorization:'Bearer '+sA.j.token}})).status,
    sessB:(await call(PB+'/phone/session/state',{headers:{authorization:'Bearer '+sB.j.token}})).status,registryKeepsWallet:!!M.registry.get(WB)};
  assert.deepEqual([R.afterErase.findB,R.afterErase.findA,R.afterErase.mcpA,R.afterErase.sessA],[404,200,200,200]);assert.equal(R.afterErase.sessB,401);
  console.log('STEP erased');
  // ---- B re-opens the same wallet with a new phone: prepare finds HIS existing wallet (re-setup batch through his tenant)
  const kB2=kp();const st2=await call('/onboard/new/start',{method:'POST',body:{x:kB2.x,y:kB2.y,single:'2',daily:'5',term:'20',days:30}});
  const pr2=await call('/onboard/new/prepare',{method:'POST',body:{id:st2.j.id,owner:ownB.address}});assert.equal(pr2.status,200,JSON.stringify(pr2.j));assert.equal(pr2.j.existing,true);
  R.reopenGas=String(await run(pr2.j.calls,ownB));const cf2=await call('/onboard/confirm',{method:'POST',body:{id:st2.j.id}});assert.equal(cf2.j?.ok,true,JSON.stringify(cf2.j));
  assert.equal(getAddress((await find(kB2)).j.wallet),WB);
  // ---- emergency stop (phone session): server pause + on-chain executor pause; cross-wallet refused; agent payments refused while paused
  {const H={authorization:'Bearer '+sA.j.token};R.stopNoSess=(await call('/safety/stop',{method:'POST'})).status;R.stopOtherWallet=(await call(PB+'/safety/stop',{method:'POST',headers:H})).status;
    const st=await call('/safety/stop',{method:'POST',headers:H});assert.equal(st.status,200,JSON.stringify(st.j));R.stop={server:st.j.server?.reason,chainPaused:st.j.chain?.paused,chainErr:st.j.chain?.error??null};
    R.pausedOnChain=(await (await M.tenant(W)).engine().status().then(x=>typeof x==='string'?JSON.parse(x):x.content?JSON.parse(x.content[0].text):x).catch(e=>({err:String(e)})));
    R.pausedOnChain=R.pausedOnChain?.paused??R.pausedOnChain?.err??'?';
    R.safetyStatus=(await call('/safety/status',{headers:H})).j?.paused?.reason;R.resume=(await call('/safety/resume',{method:'POST',headers:H})).j?.error;/* NO-AI-TRUST (t621): resume needs a fresh Face ID signature; a bare session is refused */
    assert.equal(R.stopNoSess,401);assert.ok([401,403].includes(R.stopOtherWallet));assert.equal(R.safetyStatus,'owner_stop');assert.equal(R.resume,'face_id_required');
    const J2=H;
    R.badDur=(await call('/safety/stop',{method:'POST',headers:J2,body:{duration:'1y'}})).status;assert.equal(R.badDur,400);
    const s7=await call('/safety/stop',{method:'POST',headers:J2,body:{duration:'7d'}});assert.equal(s7.status,200);const left=s7.j.server.until-Date.now();assert.ok(left>6.9*86400e3&&left<=7*86400e3,'7 days');
    const si=await call('/safety/stop',{method:'POST',headers:J2,body:{duration:'until_resume'}});assert.equal(si.j.server.until,null,'until resume');
    assert.equal((await call('/safety/status',{headers:H})).j?.paused?.until,null);assert.equal((await call('/safety/resume',{method:'POST',headers:H})).status,428,'resume without Face ID refused');assert.notEqual((await call('/safety/status',{headers:H})).j?.paused,null,'still paused');
    const wq=await call('/safety/withdraw/quote',{headers:H});assert.equal(wq.status,200,JSON.stringify(wq.j));R.withdrawTo=wq.j.to;assert.equal((await call('/safety/withdraw/quote',{})).status,401);
    const pg=await fetch(U+'/owner/withdraw');const pgt=await pg.text();assert.equal(pg.status,200);assert.ok(!/<input/.test(pgt));
    const pr=await call('/owner/withdraw/prepare',{method:'POST',body:{to:'0x000000000000000000000000000000000000dEaD'}});
    if(pr.status===200)assert.equal(pr.j.owner.toLowerCase(),wq.j.to.toLowerCase());}
  R.health=(await call('/healthz')).j;console.log('RESULT',JSON.stringify(R));await M.close();setTimeout(()=>process.exit(0),300).unref?.();});
