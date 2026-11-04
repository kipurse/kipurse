// FORK-ONLY: after "delete my data" every agent credential is dead (bearer tokens from agents.json + OAuth), it stays dead after a
// restart, a newly minted token works, and the next phone binding removes ALL dead approver owners in the same owner signature.
//   FORK_RPC=http://127.0.0.1:18591 FORK_PERMISSION_JSON='{...}' node --test test/fork/agent-revoke-fork.e2e.mjs
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import http from 'node:http';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,getAddress,decodeAbiParameters,encodeFunctionData,toHex} from 'viem';import {base} from 'viem/chains';
import * as P256 from 'ox/P256';
import {createPhoneEnrollment,WALLET_ABI} from '../../src/v5/phone-signer.mjs';import {createPhoneSession,sessionDigest} from '../../src/v5/phone-session.mjs';
import {createOwnerPay} from '../../src/v5/owner-pay.mjs';import {createEngineV5} from '../../src/v5/engine.mjs';import {decodePolicyV5} from '../../src/v5/abi.mjs';
import {createUserDataEraser,mainnetEraseParts,eraseDigest,applyAgentRevocations} from '../../src/v5/user-data.mjs';import {createPublicLimits} from '../../src/v5/limits-public.mjs';
import {createV5HttpServer} from '../../src/v5/http.mjs';import {resolveAgent,hashToken,mintAgentToken} from '../../src/v4/agents.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);const AD=parseAbi(['function trust() view returns (address)']);
test('erase revokes every agent credential; reconnect removes dead approvers in one signature; withdraw works',{skip:!RPC||!PJ,timeout:300000},async()=>{
  const perm=JSON.parse(PJ);const W=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  assert.equal(await pub.getChainId(),8453);const pol=decodePolicyV5(perm.extraData);const EXEC=getAddress(pol.executor);const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});
  const OWNER=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  for(const a of [EXEC,OWNER]){await tc.impersonateAccount({address:a});await tc.setBalance({address:a,value:10n**18n});}
  const bal=a=>pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[a]});
  if(await bal(W)<1_000_000n){const whale='0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';await tc.impersonateAccount({address:whale});await tc.setBalance({address:whale,value:10n**18n});
    const h=await createWalletClient({chain:base,transport:vh(RPC),account:whale}).writeContract({address:USDC,abi:ERC20,functionName:'transfer',args:[W,2_000_000n]});await pub.waitForTransactionReceipt({hash:h});}
  let gasUsed=0n;const run=async(calls,from)=>{for(const c of calls){const h=await createWalletClient({chain:base,transport:vh(RPC),account:from}).sendTransaction({to:c.to,data:c.data,value:0n});const r=await pub.waitForTransactionReceipt({hash:h});assert.equal(r.status,'success');gasUsed+=r.gasUsed;}};
  const kp=()=>{const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});return {privateKey,x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};};
  const sign=(d,k)=>{const s=P256.sign({payload:d,privateKey:k.privateKey});return {r:toHex(s.r,{size:32}),s:toHex(s.s,{size:32})};};
  const isOwner=a=>pub.readContract({address:W,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[a]});
  const dir=mkdtempSync(join(tmpdir(),'revoke-'));const SF=join(dir,'runtime-state.json');
  const S={permission:perm,oauth:{clients:{},pending:{},codes:{},tokens:{t1:{agentId:'oauth-claude',exp:9e9}}},oauthAgents:{'oauth-claude':{id:'oauth-claude',name:'Synthetic Claude'}}};
  const save=()=>fs.writeFileSync(SF,JSON.stringify(S));
  // synthetic agents.json (fresh test tokens, never the real ones)
  const tokM=mintAgentToken(),tokG=mintAgentToken();const AJ=join(dir,'agents.json');
  fs.writeFileSync(AJ,JSON.stringify([{id:'muse',tokenSha256:hashToken(tokM),dailyAtomic:'1000000'},{id:'grok-bot',tokenSha256:hashToken(tokG)}]));
  let agents=JSON.parse(fs.readFileSync(AJ));applyAgentRevocations(S,agents);assert.ok(resolveAgent(agents,tokM)&&resolveAgent(agents,tokG),'no erase yet: live agents untouched');
  // two phone bindings: V2 old (k0) replaced by V2 (k) -> retiring + active approvers both on chain
  const PH=createPhoneEnrollment({S,save,pub,wallet:W,trust,owner:OWNER,chainId:8453,base:()=>'http://fork.invalid',caps:()=>({single:1000000n,daily:2000000n}),script:()=>'',approverVersion:'v2'});
  const k0=kp(),k=kp();for(const key of [k0,k]){const e=await PH.enroll(key);await run(PH.calls(S.phone.pending[e.id]),OWNER);assert.equal((await PH.confirm(e.id)).ok,true);}
  const oldA=S.phone.retiring.approver,curA=S.phone.active.approver;assert.ok(await isOwner(oldA)&&await isOwner(curA));
  const cfg={chainId:8453,rpc:RPC,adapter:A,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',token:USDC,policy:pol,permission:perm,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,
    gasPricing:{usdcPerEth:'3000000000',gasPriceWei:'10000000'},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,ownerRulesDir:join(dir,'rules'),trustRequestsFile:join(dir,'tr.json')};
  const engine=createEngineV5(cfg,{ledgerFile:join(dir,'l.sqlite')});const O=()=>cfg.__trustRequestsOwner;
  const LIM=createPublicLimits({plan:async()=>({}),confirm:async()=>({valid:false}),current:async()=>({}),script:()=>'',base:()=>'http://fork.invalid'});
  const OPAY=createOwnerPay({enabled:true,store:S,save,resolveTenant:async()=>null});
  S.phoneSession??={};const PS=createPhoneSession({phone:{active:()=>PH.active()},wallet:W,store:S.phoneSession,save,readState:async()=>({})});
  const ERASE=createUserDataEraser({enabled:true,resolveTenant:async req=>PS.check(req)?{wallet:W,phone:PH}:null,
    parts:mainnetEraseParts({S,save,ownerPay:OPAY,phone:PH,ledgerCache:{forget(){}},limits:LIM,trustOwner:O,getDb:()=>engine.ledger.db,agents})});
  const readBody=async req=>{let b='';for await(const c of req)b+=c;try{return b?JSON.parse(b):{};}catch{return {};}};
  // same bearer gate as /mcp in mainnet-owner-launch.mjs + the /v1 agent API (createV5HttpServer)
  const v1=createV5HttpServer(engine,{agents});
  const srv=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://x');if(await PS.handle(req,res,u,{readBody,ip:'t'}))return;if(await ERASE.handle(req,res,u,{readBody}))return;
    if(u.pathname==='/mcp'){const tok=String(req.headers.authorization??'').replace(/^Bearer\s+/i,'');const a=resolveAgent(agents,tok);res.writeHead(a?200:401,{'content-type':'application/json'});res.end(JSON.stringify(a?{agent:a.id}:{error:'invalid_token'}));return;}
    if(u.pathname.startsWith('/v1/'))return v1.emit('request',req,res);res.writeHead(404);res.end();});
  const merch=http.createServer((req,res)=>{res.writeHead(402,{'content-type':'application/json'});res.end(JSON.stringify({x402Version:1,error:'payment required',accepts:[{scheme:'exact',network:'base',maxAmountRequired:'10000',resource:'http://127.0.0.1/x',payTo:'0x4f2a9C1e0B7d3E8a6F5c2D1b0A9e8F7c6D5b4A3e',asset:USDC,maxTimeoutSeconds:60,extra:{name:'USD Coin',version:'2'}}]}));});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));await new Promise(r=>merch.listen(0,'127.0.0.1',r));const B=`http://127.0.0.1:${srv.address().port}`,M=`http://127.0.0.1:${merch.address().port}/x`;
  const post=async(p,body,tok,h={})=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',...h,...(tok?{authorization:'Bearer '+tok}:{})},body:JSON.stringify(body??{})});return [r.status,await r.json().catch(()=>({}))];};
  const get=async(p,tok)=>{const r=await fetch(B+p,{headers:tok?{authorization:'Bearer '+tok}:{}});return r.status;};
  const pay=tok=>post('/v1/fetch',{url:M,maxAmount:'10000',intentId:'i-'+Math.random()},tok,{'idempotency-key':'k'+Math.random()});
  const session=async key=>{const [,c]=await post('/phone/session/challenge');return post('/phone/session',{nonce:c.nonce,...sign(c.digest,key)});};
  const R={};
  try{
    // before erase: both tokens authenticate and reach the payment path
    R.before={mcpMuse:(await post('/mcp',{},tokM))[0],mcpGrok:(await post('/mcp',{},tokG))[0],v1LimitsMuse:await get('/v1/limits',tokM)};
    const [pc,po]=await pay(tokM);R.before.payMuse=pc;R.before.payMuseState=po.state??po.error??null;
    assert.equal(R.before.mcpMuse,200);assert.equal(R.before.mcpGrok,200);assert.equal(R.before.v1LimitsMuse,200);assert.notEqual(pc,401);
    // erase (phone-signed)
    let [code,o]=await session(k);assert.equal(code,200);const tok=o.token;
    [code,o]=await post('/user/erase/challenge',{},tok);const [c2,o2]=await post('/user/erase',{nonce:o.nonce,phrase:'DELETE',...sign(o.digest,k)},tok);assert.equal(c2,200);R.erased=o2.erased;
    assert.equal(o2.erased[0],'agent-credentials');
    R.after={mcpMuse:(await post('/mcp',{},tokM))[0],mcpGrok:(await post('/mcp',{},tokG))[0],v1LimitsMuse:await get('/v1/limits',tokM),v1LimitsGrok:await get('/v1/limits',tokG)};
    const [ac,ao]=await pay(tokM);const [ag]=await pay(tokG);R.after.payMuse=ac;R.after.payGrok=ag;R.after.payBody=ao;
    for(const v of [R.after.mcpMuse,R.after.mcpGrok,R.after.v1LimitsMuse,R.after.v1LimitsGrok,ac,ag])assert.equal(v,401);
    assert.equal(engine.listPurchases({limit:50}).filter(p=>p.state==='paid').length,0,'no payment went through');
    // restart: fresh agents.json from disk + saved state -> still revoked; a NEWLY minted token for muse works
    const disk=JSON.parse(fs.readFileSync(SF));const agents2=JSON.parse(fs.readFileSync(AJ));R.revokedAfterRestart=applyAgentRevocations(disk,agents2);
    assert.equal(R.revokedAfterRestart,2);assert.equal(resolveAgent(agents2,tokM),null);assert.equal(resolveAgent(agents2,tokG),null);
    const tokM2=mintAgentToken();agents2[0].tokenSha256=hashToken(tokM2);delete agents2[0].disabled;applyAgentRevocations(disk,agents2);assert.equal(resolveAgent(agents2,tokM2)?.id,'muse','re-issued token works');
    assert.ok(!JSON.stringify(disk).includes(tokM)&&!JSON.stringify(disk).includes(tokG),'no raw tokens in state');
    assert.deepEqual(Object.keys(disk.oauth.tokens),[]);assert.deepEqual(disk.oauthAgents,{});
    // phone record keeps ONLY the dead approver addresses
    R.phoneAfterErase=disk.phone;assert.deepEqual(Object.keys(disk.phone).sort(),['active','dead','pending']);assert.deepEqual(disk.phone.dead.sort(),[oldA,curA].map(a=>getAddress(a)).sort());
    assert.equal((await session(k))[0],409,'old key: no session (no active phone)');
    // reconnect: new phone key; ONE owner batch deploys + adds the new approver AND removes both dead approvers
    const k2=kp();const e=await PH.enroll(k2);R.reconnect={removes:e.removes.length,fee:e.feeUSDC};assert.equal(e.removes.length,2);
    const calls=PH.calls(S.phone.pending[e.id]);R.reconnect.calls=calls.length;
    const before=await bal(W);gasUsed=0n;
    // atomic: the Base Account sends all calls as one batch (impersonated self-call of executeBatch, like wallet_sendCalls)
    const BA=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable']);
    const code0=await pub.getCode({address:OWNER});
    if(code0&&code0!=='0x'){await tc.impersonateAccount({address:OWNER});const h=await createWalletClient({chain:base,transport:vh(RPC),account:OWNER}).writeContract({address:OWNER,abi:BA,functionName:'executeBatch',args:[calls.map(c=>({target:c.to,value:0n,data:c.data}))]});
      const r=await pub.waitForTransactionReceipt({hash:h});assert.equal(r.status,'success');gasUsed=r.gasUsed;R.reconnect.atomic=true;}else{await run(calls,OWNER);R.reconnect.atomic=false;}
    R.reconnect.gas=gasUsed.toString();
    const cf=await PH.confirm(e.id);assert.equal(cf.ok,true);assert.deepEqual(cf.deadLeft,[]);assert.equal(S.phone.dead,undefined);
    assert.equal(await isOwner(oldA),false);assert.equal(await isOwner(curA),false);assert.equal(await isOwner(S.phone.active.approver),true);
    R.reconnect.walletFeePaid=(before-await bal(W)).toString();
    assert.equal((await session(k2))[0],200,'new phone opens a session on the same wallet');
    // withdraw still works (owner -> wallet.execute(USDC.transfer)), no server involved
    const wb=await bal(W),ob=await bal(OWNER);await run([{to:W,data:encodeFunctionData({abi:WALLET_ABI,functionName:'execute',args:[USDC,0n,encodeFunctionData({abi:ERC20,functionName:'transfer',args:[OWNER,wb]})]})}],OWNER);
    assert.equal(await bal(W),0n);assert.equal((await bal(OWNER))-ob,wb);R.withdraw=wb.toString();
    console.log('RESULT',JSON.stringify(R));
  }finally{srv.close();merch.close();}
});
