// FORK-ONLY phone approver V3 rehearsal (see below). Based on the new-user rehearsal harness.
// ORIGINAL HEADER: new-user rehearsal (private anvil fork of Base, never broadcasts, no real money): TWO brand-new users, each with a fresh
// Base Account (Coinbase Smart Wallet owned by a fresh key) and a fresh phone key, go end to end through the real gateway:
// onboarding (one batch) -> own deterministic wallet -> deposit -> agent pays within caps (over-cap refused) -> pause -> withdraw all
// -> delete. Cross-user isolation checked between them. Writes a JSON report (addresses, tx hashes, gas, fees) to $REPORT.
import {plantCbv} from './cbv-fork.mjs';import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,getAddress,decodeAbiParameters,encodeAbiParameters,encodeFunctionData,toHex,serializeTransaction} from 'viem';import {base} from 'viem/chains';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import * as P256 from 'ox/P256';
import {WALLET_ABI} from '../../src/v5/phone-signer.mjs';import {amountProblems} from '../../src/v5/usdc-out.mjs';/* t1166u §6#80 permanent check */import {TOOL_NAMES_V5} from '../../src/v5/mcp.mjs';import {decodePolicyV5} from '../../src/v5/abi.mjs';import {hashToken,mintAgentToken} from '../../src/v4/agents.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;const MD=process.env.MATRIX_DIR??'/workspace/t1139';/* t1150: output dir (rescue-in/out, fixtures, report) */const GW=new URL('../../',import.meta.url).pathname;
const AD=parseAbi(['function trust() view returns (address)','function vaultAddress(address) view returns (address)']);
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);
const FACTORY='0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';const FACT=parseAbi(['function createAccount(bytes[] owners,uint256 nonce) payable returns (address)','function getAddress(bytes[] owners,uint256 nonce) view returns (address)']);
const BA_ABI=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable']);
const FEED='0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';const FEED_ABI=parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const L1='0x420000000000000000000000000000000000000F';const L1_ABI=parseAbi(['function getL1Fee(bytes) view returns (uint256)']);
test('t1150 matrix (t1138u + t1148u dup cases): phone approver V3: new user, Siri above old cap, phone trust above 5, V2->V3 migration',{skip:!RPC||!PJ,timeout:900000},async()=>{
  let perm=JSON.parse(PJ);const W0=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);const pol=decodePolicyV5(perm.extraData);const EXEC=getAddress(pol.executor);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});const vault0=await pub.readContract({address:A,abi:AD,functionName:'vaultAddress',args:[W0]});
  /* t1197u §6#92: new wallets open on V5.3; this fork wallet (like 0x5150) stays on V5.2. adOf(w) = the adapter whose vault for w has code. */
  const V53=JSON.parse(fs.readFileSync(GW+'mainnet/v53-suite.json','utf8'));const V53A=getAddress(V53.adapter);
  const adOf=async w=>{try{const v=getAddress(await pub.readContract({address:V53A,abi:AD,functionName:'vaultAddress',args:[w]}));const c=await pub.getCode({address:v});if(c&&c!=='0x')return V53A;}catch{}return A;};
  const OWNER0=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W0,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  await tc.impersonateAccount({address:EXEC});await tc.setBalance({address:EXEC,value:10n**18n});
  const whale='0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';await tc.impersonateAccount({address:whale});await tc.setBalance({address:whale,value:10n**18n});
  const bal=a=>pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[a]});
  const [,ethUsd8]=await pub.readContract({address:FEED,abi:FEED_ABI,functionName:'latestRoundData'});
  const R={fork:true,chainId:await pub.getChainId(),block:String(await pub.getBlockNumber()),ethUsd:Number(ethUsd8)/1e8,gasPriceWei:String(await pub.getGasPrice()),liveGasPriceWei:String(await createPublicClient({chain:base,transport:vh('https://mainnet.base.org')}).getGasPrice()),users:{},isolation:{},steps:[]};
  const step=(u,n,ok,d)=>{R.steps.push({user:u,step:n,ok:!!ok,...(d?{d}:{})});console.log((ok?'PASS ':'FAIL ')+u+' '+n+' '+JSON.stringify(d??'',(k,v)=>typeof v==='bigint'?v.toString():v).slice(0,600));};
  const feeOf=async(r,data,to)=>{const l1=await pub.readContract({address:L1,abi:L1_ABI,functionName:'getL1Fee',args:[serializeTransaction({chainId:8453,type:'eip1559',to,data,nonce:1,gas:r.gasUsed,maxFeePerGas:1n,maxPriorityFeePerGas:1n})]});
    const gp=BigInt(R.liveGasPriceWei);const wei=r.gasUsed*gp+l1;return {gas:String(r.gasUsed),l2Wei:String(r.gasUsed*gp),l1Wei:String(l1),usd:Number(wei)*R.ethUsd/1e18};};
  // the user's Base Account sends a list of calls as ONE atomic tx (executeBatch), like wallet_sendCalls
  const batch=async(u,calls)=>{const data=encodeFunctionData({abi:BA_ABI,functionName:'executeBatch',args:[calls.map(c=>({target:getAddress(c.to),value:BigInt(c.value??0),data:c.data}))]});
    const h=await createWalletClient({chain:base,transport:vh(RPC),account:u.key}).sendTransaction({to:u.ba,data,gas:8_000_000n});const r=await pub.waitForTransactionReceipt({hash:h});return {hash:h,status:r.status,...await feeOf(r,data,u.ba)};};
  const kp=()=>{const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});return {privateKey,x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};};
  const sign=(d,k)=>{const s=P256.sign({payload:d,privateKey:k.privateKey});return {r:toHex(s.r,{size:32}),s:toHex(s.s,{size:32})};};
  // ---- gateway (isolated temp data dir; operator's legacy tenant = the existing fork wallet, untouched)
  const dir=mkdtempSync(join(tmpdir(),'rh-'));const CONF=join(dir,'conf'),DATA=join(dir,'data');fs.mkdirSync(CONF);fs.mkdirSync(DATA);
  fs.writeFileSync(join(CONF,'agents.json'),JSON.stringify([{id:'legacy',tokenSha256:hashToken(mintAgentToken())}]));
  fs.writeFileSync(join(CONF,'mainnet-trustflow.config.json'),JSON.stringify({chainId:8453,wallet:W0,ownerBaseAccount:OWNER0,token:USDC,adapter:A,trust,vault:vault0,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
    currentPermission:perm,newCaps:{single:pol.single},engine:{chainId:8453,rpc:RPC,adapter:A,trust,token:USDC,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',ownerSigner:{wallet:W0,ownerIndex:0},
      ownerRulesDir:join(DATA,'owner-rules'),ledgerFile:join(DATA,'ledger.sqlite')}}));
  const SF=join(DATA,'runtime-state.json');fs.writeFileSync(SF,JSON.stringify({permission:perm}));
  /* t796 KYC on: real CBV check against the fork; each new owner gets a planted Coinbase attestation (cbv-fork.mjs) */process.env.KIPURSE_CBV_RPCS=RPC;delete process.env.KIPURSE_REQUIRE_CBV;process.env.KIPURSE_GATEWAY=GW;process.env.KIPURSE_MAIN_CONFIG_DIR=CONF;process.env.KIPURSE_MAIN_DATA_DIR=DATA;
  /* t1240: FORK-ONLY. Since 2026-11-20 the owner's real old wallet (the matrix's boot tenant) moved to its key-seat wallet: its V5.2 permission is
     revoked and its trust paused on chain. Restore both ON THE FORK ONLY (impersonating that wallet), so the matrix boots exactly as before the move. */
  {const SPM='0xf85210B21cC50302F477BA56686d2019dC9b67Ad';const PT='(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
    const SA=parseAbi(['function approve('+PT+' p) returns (bool)','function isValid('+PT+' p) view returns (bool)']);const TA=parseAbi(['function isPaused(address) view returns (bool)','function setPaused(bool)']);
    const pj={account:getAddress(perm.account),spender:getAddress(perm.spender),token:getAddress(perm.token),allowance:BigInt(perm.allowance),period:Number(perm.period),start:Number(perm.start),end:Number(perm.end),salt:BigInt(perm.salt),extraData:perm.extraData};
    const send=async(to,data)=>{const h=await tc.sendUnsignedTransaction({from:W0,to,data,gas:3_000_000n});return (await pub.waitForTransactionReceipt({hash:h})).status;};
    if(!await pub.readContract({address:SPM,abi:SA,functionName:'isValid',args:[pj]})){await tc.impersonateAccount({address:W0});await tc.setBalance({address:W0,value:10n**18n});
      /* a revoked permission can never be approved again (SPM): approve the same permission with a new salt (same limits, window, executor) */
      perm={...perm,salt:String(BigInt(perm.salt)+1000n)};pj.salt=BigInt(perm.salt);
      console.log('FORK_RESTORE permission',await send(SPM,encodeFunctionData({abi:SA,functionName:'approve',args:[pj]})),await pub.readContract({address:SPM,abi:SA,functionName:'isValid',args:[pj]}));
      fs.writeFileSync(SF,JSON.stringify({permission:perm}));{const cf=join(CONF,'mainnet-trustflow.config.json');const c=JSON.parse(fs.readFileSync(cf,'utf8'));c.currentPermission=perm;fs.writeFileSync(cf,JSON.stringify(c));}
      try{const RA=parseAbi(['function registerPermission('+PT+' p) returns (address)']);console.log('FORK_RESTORE register',await send(A,encodeFunctionData({abi:RA,functionName:'registerPermission',args:[pj]})));}catch(e){console.log('FORK_RESTORE register n/a');}
      if(await pub.readContract({address:trust,abi:TA,functionName:'isPaused',args:[W0]}).catch(()=>false))console.log('FORK_RESTORE unpause',await send(trust,encodeFunctionData({abi:TA,functionName:'setPaused',args:[false]})));
      await tc.stopImpersonatingAccount({address:W0});}}
  let OV,M;const {startMainnet}=await import('../../mainnet/mainnet-owner-launch.mjs?rh');const port=19100+Math.floor(Math.random()*200);
  const START=async(ver,port)=>startMainnet({fork:true,agentPort:port,ownerPort:port+1000,stateFile:SF,overrides:OV={rpc:RPC,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,gasMode:'legacy',onboard:true,userErase:true,ownerPay:true,phoneOnChain:async()=>true,
    gasPricing:{usdcPerEth:String(Math.round(R.ethUsd*1e6)),gasPriceWei:R.liveGasPriceWei},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,publicBase:'http://fork.invalid',allowHttpMerchantForTests:true/* t1204 §6#93: the 127.0.0.1 mock merchant */,kvFile:join(DATA,'kv.sqlite')}});
  const FX={};const fx=(k,v)=>{FX[k]=JSON.parse(JSON.stringify(v,(kk,vv)=>typeof vv==='bigint'?vv.toString():vv));};
  M=await START(null,port);let GU=`http://127.0.0.1:${port}`;
  try{
  const call=async(path,{method='GET',body,headers={}}={})=>{const r=await fetch(GU+path,{method,headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json();}catch{}return {status:r.status,j};};
  const rpcBody=async r=>{const t=await r.text();const m=t.match(/^data: (.*)$/m);try{return JSON.parse(m?m[1]:t);}catch{return {raw:t.slice(0,200)};}};
  const mcpTool=async(pre,tok,name,args)=>{const H={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+tok};
    const i=await fetch(GU+pre+'/mcp',{method:'POST',headers:H,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'rh',version:'1'}}})});
    if(i.status!==200)return {status:i.status};const sid=i.headers.get('mcp-session-id');await rpcBody(i);const H2={...H,...(sid?{'mcp-session-id':sid}:{})};
    await fetch(GU+pre+'/mcp',{method:'POST',headers:H2,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
    const c=await fetch(GU+pre+'/mcp',{method:'POST',headers:H2,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}})});const j=await rpcBody(c);
    const text=j?.result?.content?.[0]?.text;let out;try{out=JSON.parse(text);}catch{out=text??j;}return {status:c.status,isError:!!j?.result?.isError,out};};
  const mcpMany=async(pre,tok,calls)=>{const H={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+tok};
    const i=await fetch(GU+pre+'/mcp',{method:'POST',headers:H,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'rh',version:'1'}}})});
    if(i.status!==200)return {status:i.status,res:[]};const sid=i.headers.get('mcp-session-id');await rpcBody(i);const H2={...H,...(sid?{'mcp-session-id':sid}:{})};
    await fetch(GU+pre+'/mcp',{method:'POST',headers:H2,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
    const tl=await rpcBody(await fetch(GU+pre+'/mcp',{method:'POST',headers:H2,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})}));
    const res=[];let id=3;for(const [name,args] of calls){const c=await fetch(GU+pre+'/mcp',{method:'POST',headers:H2,body:JSON.stringify({jsonrpc:'2.0',id:id++,method:'tools/call',params:{name,arguments:args}})});const j=await rpcBody(c);
      const text=j?.result?.content?.[0]?.text;let out;try{out=JSON.parse(text);}catch{out=undefined;}res.push({name,status:c.status,isError:!!j?.result?.isError,out,text:typeof text==='string'?text.slice(0,300):null});}
    return {status:200,tools:tl?.result?.tools??[],res};};
  const AIOUT=[];/* t1166u §6#80: every AI-facing answer collected here is checked at the end (permanent; never remove) */const aiOut=(surface,label,o)=>{if(o!==undefined&&o!==null&&typeof o==='object')AIOUT.push({surface,label,o});};
  const find=async k=>{const c=await call('/phone/find/challenge',{method:'POST'});return call('/phone/find',{method:'POST',body:{nonce:c.j.nonce,x:k.x,y:k.y,...sign(c.j.digest,k)}});};
  const sess=async(pre,k)=>{const c=await call(pre+'/phone/session/challenge',{method:'POST'});if(c.status!==200)return c;return call(pre+'/phone/session',{method:'POST',body:{nonce:c.j.nonce,...sign(c.j.digest,k)}});};
  R.onboardQuote=(await call('/onboard/new/quote')).j;R.inheritedStrangerCaps={openSingle:String(pol.openSingle),openDaily:String(pol.openDaily)};console.log('CAPS',JSON.stringify(R.inheritedStrangerCaps));
  const PAY=BigInt(pol.openSingle)/2n>500_000n?500_000n:BigInt(pol.openSingle)/2n;const PAYS=(Number(PAY)/1e6).toString();

  const PH_ABI=parseAbi(['function maxSingle() view returns (uint160)','function wallet() view returns (address)']);
  const TRUST_ABI=parseAbi(['function payeeTrust(address account,address payee) view returns (bytes32,uint160,uint160)']);
  const useExec=async u=>{const {createHash}=await import('node:crypto');const kf=join(DATA,'executors',createHash('sha256').update('kipurse-exec-v1:'+u.w.toLowerCase()).digest('hex').slice(0,40)+'.key');const ex=getAddress(JSON.parse(fs.readFileSync(kf)).address);
    OV.impersonateExecutor=ex;await tc.impersonateAccount({address:ex});await tc.setBalance({address:ex,value:10n**18n});};
  const usdc=n=>BigInt(Math.round(n*1e6));

  const login=async u=>{const s=await sess(u.pre,u.phone);u.H={authorization:'Bearer '+s.j?.token};return s;};
  const state=async u=>(await call(u.pre+'/phone/session/state',{headers:u.H})).j;
  const freshState=async u=>{await new Promise(r=>setTimeout(r,31000));await state(u);await new Promise(r=>setTimeout(r,4000));return state(u);};
  const tryStep=async(u,n,f)=>{try{await f();}catch(e){step(u,n+' (threw)',false,String(e?.message??e).slice(0,400));}};
  // ===================== OPENING (app: OnboardFlow.start + verifiedPage) =====================
  const openUser=async(name,{deposit='20',single='5',daily='20',term='100'}={})=>{
    const key=privateKeyToAccount(generatePrivateKey());await tc.setBalance({address:key.address,value:10n**18n});
    const owners=[encodeAbiParameters([{type:'address'}],[key.address])];const ba=getAddress(await pub.readContract({address:FACTORY,abi:FACT,functionName:'getAddress',args:[owners,0n]}));
    {const h=await createWalletClient({chain:base,transport:vh(RPC),account:key}).writeContract({address:FACTORY,abi:FACT,functionName:'createAccount',args:[owners,0n]});await pub.waitForTransactionReceipt({hash:h});}
    await plantCbv(RPC,ba);
    {const h=await createWalletClient({chain:base,transport:vh(RPC),account:whale}).writeContract({address:USDC,abi:ERC20,functionName:'transfer',args:[ba,200_000_000n]});await pub.waitForTransactionReceipt({hash:h});}
    const u={name,key,ba,phone:kp()};
    const q=await call('/onboard/new/quote?owner='+ba);fx(name+'.quote',q.j);step(name,'opening quote (GET onboard/new/quote?owner=)',q.status===200,q.j);
    // app body: Onboard.startBody (decimal strings, days as String, owner) — no attest on fork (App Attest is device-only)
    const sb={x:u.phone.x,y:u.phone.y,single,daily,term,days:'90',owner:ba};
    const st=await call('/onboard/new/start',{method:'POST',body:sb});fx(name+'.start',{req:sb,status:st.status,res:st.j});
    step(name,'opening start returns id + url (+ fingerprint = phone)',st.status===200&&!!st.j?.id&&!!st.j?.url,{status:st.status,keys:Object.keys(st.j??{}),err:st.j?.error});
    if(st.status!==200)return u;
    const pb={id:st.j.id,owner:ba,features:[],deposit:String(BigInt(Math.round(Number(deposit)*1e6)))};
    const pr=await call('/onboard/new/prepare',{method:'POST',body:pb});fx(name+'.prepare',{req:pb,status:pr.status,res:pr.j,x:u.phone.x,y:u.phone.y,choice:{single,daily,term,days:'90'},deposit});
    step(name,'opening prepare returns calls + wallet (+owner match)',pr.status===200&&Array.isArray(pr.j?.calls)&&!!pr.j?.wallet&&(!pr.j.owner||pr.j.owner.toLowerCase()===ba.toLowerCase()),{status:pr.status,err:pr.j?.error,keys:Object.keys(pr.j??{})});
    if(pr.status!==200)return u;
    u.w=getAddress(pr.j.wallet);u.pre='/t/'+u.w.toLowerCase();
    const baBefore=await bal(ba);const ob=await batch(u,pr.j.calls);await useExec(u).catch(()=>{});
    let cf;for(let i=0;i<5&&!(cf?.j?.ok);i++){cf=await call('/onboard/confirm',{method:'POST',body:{id:st.j.id}});if(!cf.j?.ok)await new Promise(r=>setTimeout(r,500));}
    fx(name+'.confirm',cf.j);u.openGas=ob;
    const wBal=await bal(u.w);
    step(name,'opening = ONE Base Account tx, confirm ok, wallet matches, deposit landed minus fee',ob.status==='success'&&cf.j?.ok===true&&getAddress(cf.j.wallet??'0x0000000000000000000000000000000000000000')===u.w&&wBal>0n,{tx:ob.hash,status:ob.status,confirm:cf.j,walletUSDC:String(wBal),baSpent:String(baBefore-await bal(ba)),siri:cf.j?.siri});
    const s=await login(u);step(name,'phone session (challenge digest + P-256 sig) -> token',s.status===200&&!!s.j?.token,{status:s.status,err:s.j?.error});
    const ch=await call(u.pre+'/phone/session/challenge',{method:'POST'});fx(name+'.sessionChallenge',ch.j);
    const stt=await state(u);fx(name+'.stateAfterOpen',stt);
    step(name,'state after opening: wallet, active, everyday (AI) NOT authorized, phone approver on',!!stt&&(stt.setup?.wallet??stt.wallet??'').toLowerCase()===u.w.toLowerCase(),{bal:stt?.balance,everyday:stt?.everyday?.authorized,keys:Object.keys(stt??{}).slice(0,40)});
    return u;};
  // ---- opening negative: missing total is refused (three limits required)
  {const k=kp();const st=await call('/onboard/new/start',{method:'POST',body:{x:k.x,y:k.y,single:'5',daily:'20',term:'',days:'90'}});fx('neg.startNoTerm',{status:st.status,res:st.j});
   step('NEG','opening without a total limit is refused',st.status>=400,{status:st.status,err:st.j?.error});}
  const U1=await openUser('U1');
  R.U1={wallet:U1.w,ba:U1.ba};
  // ===================== DEPOSIT (plain USDC transfer from the user's Base Account) =====================
  await tryStep('U1','suite',async()=>{const VA53=parseAbi(['function opsPerDay() view returns (uint256)','function vaultAddress(address) view returns (address)']);
    const v53=getAddress(await pub.readContract({address:V53A,abi:VA53,functionName:'vaultAddress',args:[U1.w]}));const st=await state(U1);
    step('U1','§6#92 NEW wallet opened on V5.3: server vault = V5.3 vault (has code, 500 ops/day), adapter = 0xb150…',getAddress(String(st?.vault?.address??'0x0000000000000000000000000000000000000000'))===v53&&(await adOf(U1.w))===V53A&&BigInt(await pub.readContract({address:v53,abi:VA53,functionName:'opsPerDay'}))===500n,{vault:st?.vault?.address,v53});
    const w0v53=getAddress(await pub.readContract({address:V53A,abi:VA53,functionName:'vaultAddress',args:[W0]}));const c0=await pub.getCode({address:w0v53});
    step('U1','§6#92 existing wallet stays on V5.2: its permission spender is the V5.2 adapter and it has NO V5.3 vault',A!==V53A&&(!c0||c0==='0x')&&(await adOf(W0))===A,{w0:W0,v52adapter:A});});
  await tryStep('U1','deposit',async()=>{const before=await bal(U1.w);const dep=await batch(U1,[{to:USDC,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[U1.w,30_000_000n]})}]);
    const stt=await freshState(U1);/* the server ledger rescans at most every 30 s */fx('U1.stateAfterDeposit',stt);
    step('U1','deposit 30 USDC lands; state balance = chain balance',dep.status==='success'&&String(stt?.balance)===String(await bal(U1.w)),{tx:dep.hash,stateBalance:stt?.balance,chain:String(await bal(U1.w)),before:String(before)});
    const led=(await call(U1.pre+'/phone/session/ledger',{headers:U1.H}));fx('U1.ledgerAfterDeposit',{status:led.status,res:led.j});});
  // ===================== t1150u / handbook 0A#7 layer 3: SAME DEPOSIT RESCANNED -> credited once (tx:logIndex) =====================
  await tryStep('U1','DUP-3 deposit rescan',async()=>{
    const {createLedger}=await import('../../src/v5/ledger.mjs');const dh=(R.steps.filter(s=>s.user==='U1'&&/^deposit 30 USDC/.test(s.step)).pop()?.d?.tx);
    const rc=await pub.getTransactionReceipt({hash:dh});const vault=getAddress(await pub.readContract({address:await adOf(U1.w),abi:AD,functionName:'vaultAddress',args:[U1.w]}));
    const f=join(dir,'dup3-ledger.json');const from=Number(rc.blockNumber)-3;
    const mk=()=>createLedger({pub,token:USDC,wallet:U1.w,vault,paymasters:[],names:{},owner:U1.ba,feeTo:'0xf14ef5dc4723245866c22c749a0a84afceba0dd9',fromBlock:from,file:f,minIntervalMs:0});
    await mk().refresh();/* first scan */
    for(let i=0;i<3;i++){const j=JSON.parse(fs.readFileSync(f,'utf8'));j.next=from;fs.writeFileSync(f,JSON.stringify(j));const L=mk();await L.refresh();await L.refresh();}/* rewind the scan cursor = server restart rescanning the same blocks, 3x, plus a second scan per instance */
    const cache=JSON.parse(fs.readFileSync(f,'utf8'));const raw=cache.transfers.filter(x=>String(x.tx).toLowerCase()===dh.toLowerCase()&&String(x.to).toLowerCase()===U1.w.toLowerCase());
    const v=mk().view({wallet:await bal(U1.w),vault:await bal(vault)});const rows=v.rows.filter(r=>r.tx.toLowerCase()===dh.toLowerCase()&&r.account==='wallet');
    const credited=rows.reduce((s,r)=>s+BigInt(r.delta),0n);const sumWallet=v.rows.filter(r=>r.account==='wallet').reduce((s,r)=>s+BigInt(r.delta),0n);
    const s2=await freshState(U1);const srv=(s2?.ledger??[]).filter(r=>String(r.tx).toLowerCase()===dh.toLowerCase()&&r.account==='wallet');
    step('U1','DUP-3 same deposit (tx:logIndex) rescanned 3x after cursor rewind -> credited ONCE (1 raw log, 1 deposit row of +30, wallet rows sum = chain - opening; server ledger lists it once)',
      raw.length===1&&rows.length===1&&rows[0].kind==='deposit'&&credited===30_000_000n&&BigInt(v.opening.wallet)+sumWallet===await bal(U1.w)&&srv.length===1&&String(srv[0].delta)==='30000000',
      {tx:dh,rawLogs:raw.length,rows:rows.length,credited:String(credited),opening:v.opening.wallet,sumWallet:String(sumWallet),chain:String(await bal(U1.w)),serverRows:srv.length});});
  // ===================== WITHDRAW (app: WithdrawView: quote -> prepare{amount} -> owner batch -> confirm) =====================
  for(const [label,amt] of [['amount 1.5',1_500_000n],['all',null]]){
   await tryStep('U1','withdraw '+label,async()=>{
    const qq=await call(U1.pre+'/owner/withdraw',{});fx('U1.withdrawQuote.'+label,{status:qq.status,res:qq.j});
    const wb=await bal(U1.w);const amount=amt??BigInt(qq.j?.amount??wb);
    const pr=await call(U1.pre+'/owner/withdraw/prepare',{method:'POST',body:{amount:String(amount)}});fx('U1.withdrawPrepare.'+label,{req:{amount:String(amount)},status:pr.status,res:pr.j,owner:U1.ba,wallet:U1.w});
    step('U1','withdraw '+label+': prepare has id/owner/wallet/amount/calls, amount = confirmed',pr.status===200&&!!pr.j?.id&&!!pr.j?.owner&&!!pr.j?.wallet&&pr.j?.amount===String(amount)&&Array.isArray(pr.j?.calls),{status:pr.status,err:pr.j?.error,amount:pr.j?.amount,want:String(amount),keys:Object.keys(pr.j??{})});
    if(pr.status!==200)return;
    // the pinned withdraw page (owner-sign/static/withdraw.js) re-prepares the wallet-pays shape for the plan the app checked
    const wp=await call(U1.pre+'/owner/withdraw/prepare',{method:'POST',body:{feeFrom:'wallet',amount:String(amount),plan:pr.j.id}});fx('U1.withdrawPagePrepare.'+label,{status:wp.status,res:wp.j,owner:U1.ba,wallet:U1.w,amount:String(amount)});
    step('U1','withdraw '+label+': page re-prepare = wallet-pays fee, same amount',wp.status===200&&wp.j?.feeFrom==='wallet'&&wp.j?.amount===String(amount),{status:wp.status,err:wp.j?.error,feeFrom:wp.j?.feeFrom,amount:wp.j?.amount,fee:wp.j?.fee});
    const use=wp.status===200&&wp.j?.feeFrom==='wallet'?wp.j:pr.j;
    const baB=await bal(U1.ba);const b=await batch(U1,use.calls);
    let cf;for(let i=0;i<5&&!(cf?.j?.ok);i++){cf=await call(U1.pre+'/owner/withdraw/confirm',{method:'POST',body:{id:pr.j.id}});if(!cf.j?.ok)await new Promise(r=>setTimeout(r,500));}
    const cfPage=use!==pr.j?await call(U1.pre+'/owner/withdraw/confirm',{method:'POST',body:{id:use.id}}):null;fx('U1.withdrawConfirm.'+label,{app:cf.j,page:cfPage?.j});
    const got=(await bal(U1.ba))-baB,spent=wb-await bal(U1.w);
    step('U1','withdraw '+label+': on chain, wallet paid amount (fee inside), owner got amount-fee, APP poll (its own plan id) confirms ok',b.status==='success'&&cf.j?.ok===true&&spent===amount&&got===amount-BigInt(use.fee??0),{tx:b.hash,got:String(got),spentFromWallet:String(spent),fee:String(use.fee??0),appConfirm:cf.j,pageConfirm:cfPage?.j});
    const stt=await freshState(U1);fx('U1.stateAfterWithdraw.'+label,stt);const row=(stt?.ledger??[]).find(x=>x.tx===b.hash);
    step('U1','withdraw '+label+': 记录 row = withdraw to your Base Account, amount + wallet-paid fee split out',!!row&&row.kind==='withdraw'&&String(row.delta)===String(-amount)&&String(row.detail?.fee??'0')===String(use.fee??0)&&/你的 Base Account/.test(row.zh),{row});});
   if(label==='amount 1.5'){/* top up again for later flows */await batch(U1,[{to:USDC,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[U1.w,40_000_000n]})}]);}
  }
  await batch(U1,[{to:USDC,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[U1.w,50_000_000n]})}]);
  // ===================== CHANGE WALLET SAFETY LIMITS (app: LimitsFee.load + verifyThenSign) =====================
  await tryStep('U1','limits change',async()=>{
    const fee=await call(U1.pre+'/owner/limits/fee');fx('U1.limitsFee',{status:fee.status,res:fee.j});
    step('U1','limits fee: usdcText + gasToken USDC + feeFrom wallet',fee.status===200&&!!fee.j?.usdcText&&fee.j?.gasToken==='USDC',{status:fee.status,res:fee.j});
    const body={single:'8000000',daily:'30000000',term:'150000000',days:90};
    const wb=await bal(U1.w);const pr=await call(U1.pre+'/owner/limits/prepare',{method:'POST',body});fx('U1.limitsPrepare',{req:body,status:pr.status,res:pr.j,wallet:U1.w,owner:U1.ba});
    step('U1','limits prepare: id + calls + chainId (+owner)',pr.status===200&&!!pr.j?.id&&Array.isArray(pr.j?.calls),{status:pr.status,err:pr.j?.error,detail:pr.j?.detail,keys:Object.keys(pr.j??{})});
    if(pr.status!==200)return;const b=await batch(U1,pr.j.calls);
    let cf;for(let i=0;i<5&&!(cf?.j?.ok);i++){cf=await call(U1.pre+'/owner/limits/confirm',{method:'POST',body:{id:pr.j.id}});if(!cf.j?.ok)await new Promise(r=>setTimeout(r,700));}
    step('U1','limits change on chain, fee from wallet, confirm ok',b.status==='success'&&cf.j?.ok===true,{tx:b.hash,feeFromWallet:String(wb-await bal(U1.w)),confirm:cf.j});
    const stt=await freshState(U1);fx('U1.stateAfterLimits',stt);const row=(stt?.ledger??[]).find(x=>x.tx===b.hash);
    step('U1','limits change: 记录 row = network fee only (walletfee), not a transfer to someone',!!row&&row.kind==='walletfee'&&String(row.detail?.fee)===String(-BigInt(row.delta)),{row});});

  // ===================== FACE ID REVOKE (app: verifiedRevokeURL) then POST-OPENING ENABLE (app: PhoneEnroll.enroll + verifiedEnrollURL) =====================
  await tryStep('U1','faceid revoke',async()=>{
    const s0=await call(U1.pre+'/phone/status');fx('U1.phoneStatusBefore',s0.j);
    const pl=await call(U1.pre+'/phone/revoke/plan');fx('U1.revokePlan',{status:pl.status,res:pl.j,wallet:U1.w,owner:U1.ba});
    step('U1','Face ID revoke plan: calls + owner',pl.status===200&&Array.isArray(pl.j?.calls),{status:pl.status,err:pl.j?.error,keys:Object.keys(pl.j??{})});
    if(pl.status!==200)return;const b=await batch(U1,pl.j.calls);await new Promise(r=>setTimeout(r,800));const rc=await call(U1.pre+'/phone/revoke/confirm',{method:'POST'});fx('U1.revokeConfirm',{status:rc.status,res:rc.j});
    const st=await call(U1.pre+'/phone/status');fx('U1.phoneStatusAfterRevoke',st.j);
    step('U1','Face ID revoke on chain; revoke/confirm ok; phone/status no longer active',b.status==='success'&&rc.j?.ok===true&&!st.j?.active,{tx:b.hash,confirm:rc.j,before:s0.j,after:st.j});});
  await tryStep('U1','faceid enable',async()=>{
    const k=kp();const wb=await bal(U1.w),ob=await bal(U1.ba);
    /* t1240 §6#110 F1: no owner proof -> refused (anyone could make a real-domain "add this phone" link before) */
    {const r0=await call(U1.pre+'/phone/enroll',{method:'POST',body:{x:k.x,y:k.y}});step('U1','F1 add-this-phone without owner proof -> 401 sign_in_first',r0.status===401&&r0.j?.error==='sign_in_first',{status:r0.status,err:r0.j?.error});}
    /* the App's path: Coinbase sign-in on this phone with this key -> "bind" read grant for these x / y (signin.mjs verify; emulated here, signin has its own tests) */
    {const {kvKey}=await import(GW+'src/v5/store.mjs');M.kv.put(kvKey('readgrant',getAddress(U1.w),'phone'),{x:k.x,y:k.y,owner:U1.ba,exp:Date.now()+600e3},600e3);}
    const r=await call(U1.pre+'/phone/enroll',{method:'POST',body:{x:k.x,y:k.y}});fx('U1.enroll',{status:r.status,res:r.j,x:k.x,y:k.y,wallet:U1.w,owner:U1.ba});
    step('U1','post-opening Face ID enroll returns calls',r.status===200&&Array.isArray(r.j?.calls),{status:r.status,err:r.j?.error,keys:Object.keys(r.j??{})});
    if(r.status!==200)return;
    if(r.j.id){const q=await call(U1.pre+'/phone/enroll/quote?id='+encodeURIComponent(r.j.id));fx('U1.enrollQuote',{status:q.status,res:q.j});
      step('U1','enroll quote <= 0.05 USDC (t1128u)',q.status===200,{status:q.status,res:q.j});}
    const b=await batch(U1,r.j.calls);await new Promise(r=>setTimeout(r,800));
    let cf=null;if(r.j.id){cf=await call(U1.pre+'/phone/enroll/confirm',{method:'POST',body:{id:r.j.id}});}
    const st=await call(U1.pre+'/phone/status');fx('U1.phoneStatusAfterEnroll',st.j);
    step('U1','Face ID re-enabled on chain, phone/status active with new key',b.status==='success'&&!!st.j?.active,{tx:b.hash,confirm:cf&&{status:cf.status,j:cf.j},status:st.j,walletFee:String(wb-await bal(U1.w)),ownerSpentUSDC:String(ob-await bal(U1.ba))});
    U1.phone=k;const s=await login(U1);step('U1','session with the new phone key',s.status===200&&!!s.j?.token,{status:s.status,err:s.j?.error});});
  // ===================== AI CONNECT IN-APP (app: AIConnect.confirmFirst -> ConnectApprove: phone-prepare -> phone-decide) =====================
  const approveFirst=async(u,req,amts,label)=>{
    const pp=await call(u.pre+'/oauth/phone-prepare',{method:'POST',body:{req,...amts}});fx(u.name+'.'+label+'.phonePrepare',{req:{req,...amts},status:pp.status,res:pp.j,wallet:u.w});
    const okShape=pp.status===200&&pp.j?.mode==='first'&&!!pp.j?.nonce&&pp.j?.single===amts.single&&pp.j?.daily===amts.daily&&pp.j?.total===amts.total&&(pp.j?.wallet??'').toLowerCase()===u.w.toLowerCase()&&!!pp.j?.digest;
    step(u.name,label+': phone-prepare mode=first with nonce, the 3 amounts, wallet, digest (app guard)',okShape,{status:pp.status,err:pp.j?.error,mode:pp.j?.mode,nonce:!!pp.j?.nonce});
    if(!okShape)return null;
    const dd=await call(u.pre+'/oauth/phone-decide',{method:'POST',body:{req,approve:true,...sign(pp.j.digest,u.phone)}});fx(u.name+'.'+label+'.phoneDecide',{status:dd.status,res:dd.j});
    step(u.name,label+': phone-decide approved',dd.status===200&&dd.j?.status==='approved',{status:dd.status,res:dd.j});
    const stt=await state(u);fx(u.name+'.stateAfter.'+label,stt);
    step(u.name,label+': state.everyday authorized with exactly these amounts',stt?.everyday?.authorized===true&&stt.everyday.requestedSingle===amts.single&&stt.everyday.requestedDaily===amts.daily&&stt.everyday.requestedTerm===amts.total,{everyday:stt?.everyday});
    return dd.j;};
  await tryStep('U1','ai connect in-app',async()=>{
    const amts={single:'2000000',daily:'5000000',total:'20000000'};
    const f=await call(U1.pre+'/oauth/first',{method:'POST',body:{agent:'grok-bot',...amts}});fx('U1.oauthFirst',{req:{agent:'grok-bot',...amts},status:f.status,res:f.j,wallet:U1.w});
    step('U1','oauth/first mode=first + req id',f.status===200&&f.j?.mode==='first'&&!!f.j?.req,{status:f.status,err:f.j?.error,keys:Object.keys(f.j??{})});
    if(f.status!==200)return;await approveFirst(U1,f.j.req,amts,'inAppConnect');
    const again=await call(U1.pre+'/oauth/first',{method:'POST',body:{agent:'claude',...amts}});step('U1','oauth/first after limits confirmed -> already_confirmed (app goes reuse path)',again.status===409,{status:again.status,err:again.j?.error});});
  // ===================== SIRI / OWNER PAY (app: SiriPay challenge -> Face ID -> submit) =====================
  await tryStep('U1','siri pay',async()=>{
    const shop=privateKeyToAccount(generatePrivateKey()).address;const c0=await call(U1.pre+'/owner/pay/challenge',{method:'POST',headers:U1.H,body:{payee:shop,amount:'1000000',confirmNewPayee:false}});
    step('U1','Siri pay to a new address without confirm -> new_payee_needs_confirm',c0.status===409&&c0.j?.error==='new_payee_needs_confirm',{status:c0.status,res:c0.j});
    const c=await call(U1.pre+'/owner/pay/challenge',{method:'POST',headers:U1.H,body:{payee:shop,amount:'1000000',confirmNewPayee:true}});fx('U1.siriChallenge',{status:c.status,res:c.j});
    step('U1','Siri pay challenge',c.status===200&&!!c.j?.digest,{status:c.status,err:c.j?.error,detail:c.j?.detail,reasons:c.j?.reasons});if(c.status!==200)return;
    const sb=await call(U1.pre+'/owner/pay/submit',{method:'POST',headers:U1.H,body:{id:c.j.id,...sign(c.j.digest,U1.phone)}});fx('U1.siriSubmit',{status:sb.status,res:sb.j});
    step('U1','Siri pay 1 USDC paid on chain',sb.status===200&&(await bal(shop))===1_000_000n,{status:sb.status,res:sb.j,shop:String(await bal(shop))});
    const stt=await state(U1);fx('U1.stateAfterSiriPay',stt);
    step('U1','Siri balance source (state.balance, read by the app Siri entity) = chain balance after the pay',String(stt?.balance)===String(await bal(U1.w)),{stateBalance:stt?.balance,chain:String(await bal(U1.w))});});
  // ===================== t1161u (§6#78): ANY Siri intent marks Siri used (app SiriSeen -> POST siri/allowances with the phone session); never moves money =====================
  await tryStep('U1','siri seen marker',async()=>{const w0=await bal(U1.w);const s0=await state(U1);const before=(s0?.agents??[]).find(a=>a.id==='siri')?.lastUsed??null;const t0=Date.now();
    const r=await call(U1.pre+'/siri/allowances',{method:'POST',headers:U1.H,body:{}});aiOut('siri','U1 /siri/allowances',r.j);const s1=await state(U1);const sr=(s1?.agents??[]).find(a=>a.id==='siri');fx('U1.siriSeen',{status:r.status,before,after:sr?.lastUsed});
    const fresh=!!sr?.lastUsed&&Date.parse(sr.lastUsed)>=t0-2000;
    step('U1','phone session siri/allowances -> Siri lastUsed now (home bead online), no money moved',r.status===200&&fresh&&(await bal(U1.w))===w0,{status:r.status,before,after:sr?.lastUsed,connected:sr?.connected});
    const nr=await call(U1.pre+'/siri/allowances',{method:'POST',body:{}});step('U1','siri/allowances without a phone session -> 401 (cannot fake Siri online)',nr.status===401,{status:nr.status});});
  // ===================== AI-INITIATED CONNECT (computer AI: register -> authorize -> phone sets limits -> code -> token) =====================
  const U2=await openUser('U2');R.U2={wallet:U2.w};
  let tok=null,agentId=null;const shopA=privateKeyToAccount(generatePrivateKey()).address;
  await tryStep('U2','ai-initiated connect',async()=>{
    const {createHash,randomBytes}=await import('node:crypto');const ru='https://www.cursor.com/agents/mcp/oauth/callback';
    const rg=await call(U2.pre+'/oauth/register',{method:'POST',body:{client_name:'Test AI',redirect_uris:[ru]}});
    const ver=randomBytes(32).toString('base64url'),chal=createHash('sha256').update(ver).digest('base64url');
    const az=await fetch(GU+U2.pre+'/oauth/authorize?'+new URLSearchParams({response_type:'code',client_id:rg.j.client_id,redirect_uri:ru,code_challenge:chal,code_challenge_method:'S256',state:'s1'}),{redirect:'manual'});
    step('U2','AI register + authorize opens a pending request',rg.status===201&&az.status===200,{reg:rg.status,authorize:az.status});
    const stt=await state(U2);fx('U2.stateWithConnectRequest',stt);const req=(stt?.connectRequests??[])[0]?.id;
    step('U2','state.connectRequests shows the AI request to the phone',!!req,{connectRequests:stt?.connectRequests});if(!req)return;
    const blank=await call(U2.pre+'/oauth/phone-prepare',{method:'POST',body:{req}});step('U2','phone-prepare without amounts -> limits_required (app opens the AI-limit screen first)',blank.status===409&&blank.j?.error==='limits_required',{status:blank.status,err:blank.j?.error});
    const d=await approveFirst(U2,req,{single:'2000000',daily:'5000000',total:'20000000'},'aiInitiatedConnect');if(!d)return;
    const code=new URL(d.redirect).searchParams.get('code');const tk=await call(U2.pre+'/oauth/token',{method:'POST',body:{grant_type:'authorization_code',code,client_id:rg.j.client_id,redirect_uri:ru,code_verifier:ver}});
    step('U2','AI exchanges the code for a token (PKCE)',tk.status===200&&!!tk.j?.access_token,{status:tk.status,err:tk.j?.error});tok=tk.j?.access_token;});
  // ===================== TRUST A NEW PAYEE (AI asks; app: PhoneApproveTrustSheet phone-prepare -> Face ID -> phone-sign) =====================
  if(tok)await tryStep('U2','trust payee',async()=>{await useExec(U2);
    const rq=await mcpTool(U2.pre,tok,'kipurse_request_trust',{payee:shopA,merchantName:'T1138 Shop',reason:'t1138 matrix shop',perPaymentCap:'5.0',totalCap:'30.0'});
    const stt=await state(U2);fx('U2.stateWithTrustRequest',stt);const trq=stt?.trustRequests;const rid=(Array.isArray(trq)?trq:Object.values(trq?.pending??trq?.requests??trq??{}).flat()).map(x=>x?.id).filter(Boolean)[0]??(JSON.stringify(rq.out).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)??[])[0];
    step('U2','AI trust request shows in state.trustRequests',!!rid,{out:rq.out,trustRequests:stt?.trustRequests});if(!rid)return;
    const pp=await call(U2.pre+'/approve/trust/phone-prepare',{method:'POST',body:{id:rid}});fx('U2.trustPhonePrepare',{status:pp.status,res:pp.j});
    step('U2','trust phone-prepare: request/message/domain/digest',pp.status===200&&!!pp.j?.digest&&!!pp.j?.message,{status:pp.status,err:pp.j?.error,keys:Object.keys(pp.j??{})});if(pp.status!==200)return;
    const rsh=await pub.readContract({address:U2.w,abi:parseAbi(['function replaySafeHash(bytes32) view returns (bytes32)']),functionName:'replaySafeHash',args:[pp.j.digest]});fx('U2.trustReplaySafeHash',rsh);
    const ps=await call(U2.pre+'/approve/trust/phone-sign',{method:'POST',body:{id:rid,...sign(rsh,U2.phone)}});fx('U2.trustPhoneSign',{status:ps.status,res:ps.j});
    step('U2','phone (Face ID) approves the payee on chain',ps.status===200,{status:ps.status,res:ps.j});});
  // ===================== AI PAY within / over limits =====================
  const aiPay=async(amount,ref)=>mcpTool(U2.pre,tok,'kipurse_pay',{to:shopA,amount,merchant:'t1138-shop',orderRef:ref});
  if(tok)await tryStep('U2','ai pay',async()=>{
    const b0=await bal(shopA);const p1=await aiPay('1','m-1');fx('U2.aiPayWithin',p1);
    step('U2','AI pays 1 USDC (within 2/5/20) -> paid on chain',(await bal(shopA))-b0===1_000_000n,{out:p1.out,isError:p1.isError});
    const b1=await bal(shopA);const p2=await aiPay('3','m-2');fx('U2.aiPayOverSingle',p2);
    step('U2','AI pays 3 USDC (> per-payment 2) -> refused, nothing paid',(await bal(shopA))===b1&&!/paid/.test(String(p2.out?.state??'')),{out:p2.out});
    const stt=await state(U2);fx('U2.stateAfterAiPay',stt);});
  // ===================== t1161u (§6#78): an AI's READ-ONLY MCP call marks THAT agent used; a bad token is refused (never shown online); no money moves =====================
  if(tok)await tryStep('U2','ai read marks used',async()=>{const w0=await bal(U2.w);const t0=Date.now();
    const rd=await mcpTool(U2.pre,tok,'kipurse_allowances',{});const s1=await state(U2);const ai=(s1?.agents??[]).filter(a=>a.id!=='siri');const hit=ai.find(a=>a.lastUsed&&Date.parse(a.lastUsed)>=t0-2000);fx('U2.aiReadSeen',{status:rd.status,agents:ai.map(a=>({id:a.id,connected:a.connected,lastUsed:a.lastUsed}))});
    step('U2','AI read-only MCP call -> that agent lastUsed now + connected, no money moved',rd.status===200&&!rd.isError&&!!hit&&hit.connected===true&&ai.filter(a=>a.lastUsed&&Date.parse(a.lastUsed)>=t0-2000).length===1&&(await bal(U2.w))===w0,{status:rd.status,isError:rd.isError,agents:ai.map(a=>({id:a.id,connected:a.connected,lastUsed:a.lastUsed}))});
    const bad=await mcpTool(U2.pre,'kat_'+'0'.repeat(40),'kipurse_allowances',{});step('U2','unknown/expired AI token -> 401 at /mcp (honest broken connection, not online)',bad.status===401,{status:bad.status});});
  // ===================== t1166u / handbook §6#80 (PERMANENT, mandatory before every deploy): every AI-facing amount is human-ready USDC =====================
  if(tok)await tryStep('U2','ai amounts human-ready (MCP)',async()=>{const w0=await bal(U2.w);const pk=FX['U2.aiPayWithin']?.out?.purchaseKey??null;
    const calls=[['kipurse_wallet_status',{}],['kipurse_limits',{}],['kipurse_allowances',{}],['kipurse_list_purchases',{}],['kipurse_spending_summary',{period:'month'}],['kipurse_spending_report',{period:'month'}],
      ['kipurse_address_book',{}],['kipurse_trust_list',{}],['kipurse_deposit_info',{}],['kipurse_deposits',{}],['kipurse_pending_payments',{}],['kipurse_float_status',{}],['kipurse_verify_payee',{address:shopA}],
      ['kipurse_preflight',{to:shopA,amount:'0.5'}],['kipurse_parse_payment',{to:shopA,amount:'0.5'}],['kipurse_annual_summary',{year:new Date().getFullYear()}],
      ...(pk?[['kipurse_receipt',{purchaseKey:pk}],['kipurse_get_purchase',{purchaseKey:pk}],['kipurse_order_status',{purchaseKey:pk}]]:[])].filter(([n])=>TOOL_NAMES_V5.includes(n));
    const m=await mcpMany(U2.pre,tok,calls);fx('U2.aiAmounts',m);
    step('U2','§6#80 every MCP tool description says amounts are already USDC (no conversion)',m.status===200&&m.tools.length>0&&m.tools.every(t=>/already USDC.*no conversion/.test(t.description??'')),{status:m.status,tools:m.tools.length,missing:m.tools.filter(t=>!/already USDC.*no conversion/.test(t.description??'')).map(t=>t.name)});
    for(const r of m.res){aiOut('mcp',r.name,r.out);step('U2','§6#80 MCP '+r.name+' (read-only): JSON answer, every amount is USDC + "x.xx USDC", no raw base units',r.status===200&&r.out!==undefined&&amountProblems(r.out).length===0,{status:r.status,isError:r.isError,problems:r.out===undefined?['not JSON: '+r.text]:amountProblems(r.out).slice(0,5)});}
    const ws=m.res.find(r=>r.name==='kipurse_wallet_status')?.out;const chain=await bal(U2.w);const want=(()=>{const w=chain/1000000n,f=(chain%1000000n).toString().padStart(6,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;})();
    const rawHit=ws?JSON.stringify(ws).match(new RegExp('"([A-Za-z_]+)":"?'+chain.toString()+'"?[,}]','g'))?.filter(x=>!/Atomic"/.test(x))??[]:['no answer'];
    step('U2','§6#80 balance headline: wallet_status usdc = chain balance in USDC, usdcDisplay "x.xx USDC", summary 余额…, raw base units only under *Atomic',!!ws&&ws.usdc===want&&/^[0-9]+\.[0-9]{2} USDC$|^0\.0+[0-9]* USDC$/.test(ws.usdcDisplay??'')&&ws.usdcAtomic===chain.toString()&&ws.summary===`余额 ${ws.usdcDisplay} / Balance ${ws.usdcDisplay}`&&ws.amountsUnit==='USDC'&&chain>=1_000_000n&&rawHit.length===0,
      {usdc:ws?.usdc,usdcDisplay:ws?.usdcDisplay,summary:ws?.summary,chain:chain.toString(),rawHit});
    step('U2','§6#80 read-only sweep moved no money',(await bal(U2.w))===w0,{});});
  // ===================== t1150u / handbook 0A#7 layers 1+2: SAME REQUEST RESENT; SAME ORDER PAID AGAIN WITH A NEW KEY =====================
  const aiPayK=async(amount,ref,key)=>mcpTool(U2.pre,tok,'kipurse_pay',{to:shopA,amount,merchant:'t1150-dup-shop',orderRef:ref,idempotencyKey:key});
  if(tok)await tryStep('U2','DUP-1/2',async()=>{const tag=Date.now().toString(36);
    const s0=await bal(shopA),w0=await bal(U2.w);const k1='dup1-'+tag;const a=await aiPayK('1','dup-order-'+tag,k1);fx('U2.dupFirst',a);
    const s1=await bal(shopA),w1=await bal(U2.w);
    step('U2','DUP-0 first pay (merchant t1150-dup-shop, orderRef dup-order, 1 USDC, Idempotency-Key k1) -> paid once',a.out?.state==='paid'&&s1-s0===1_000_000n&&w0-w1>=1_000_000n,{state:a.out?.state,tx:a.out?.txHash,shopDelta:String(s1-s0),walletDelta:String(w0-w1),total:a.out?.total});
    const r1=await aiPayK('1','dup-order-'+tag,k1);const r2=await aiPayK('1','dup-order-'+tag,k1);fx('U2.dupResend',r1);
    const s2=await bal(shopA),w2=await bal(U2.w);
    step('U2','DUP-1 same request resent twice with the SAME Idempotency-Key -> exact first result replayed (same state/txHash/purchaseKey), shop +0, wallet -0',
      r1.out?.state==='paid'&&r2.out?.state==='paid'&&r1.out?.txHash===a.out?.txHash&&r2.out?.txHash===a.out?.txHash&&r1.out?.purchaseKey===a.out?.purchaseKey&&s2===s1&&w2===w1,
      {state1:r1.out?.state,state2:r2.out?.state,tx1:r1.out?.txHash,first:a.out?.txHash,reason:r1.out?.reason,shopDelta:String(s2-s1),walletDelta:String(w1-w2)});
    const k2='dup2-'+tag;const n1=await aiPayK('1','dup-order-'+tag,k2);const n2=await aiPayK('1','dup-order-'+tag,'dup3-'+tag);fx('U2.dupNewKey',n1);
    const s3=await bal(shopA),w3=await bal(U2.w);
    step('U2','DUP-2 same merchant + orderRef + amount paid again with a NEW Idempotency-Key (2 new keys) -> deduped (already_paid*, no new tx), no second charge, nothing sent',
      /^already_paid/.test(String(n1.out?.state??''))&&/^already_paid/.test(String(n2.out?.state??''))&&[undefined,null,a.out?.txHash].includes(n1.out?.txHash)&&[undefined,null,a.out?.txHash].includes(n2.out?.txHash)&&s3===s2&&w3===w2,
      {state1:n1.out?.state,state2:n2.out?.state,reason:n1.out?.reason,tx:n1.out?.txHash,shopDelta:String(s3-s2),walletDelta:String(w2-w3)});});
  // ===================== AI LIMIT CHANGE (app: saveEveryday -> POST everyday {single,daily,term}) =====================
  if(tok)await tryStep('U2','ai limit change',async()=>{
    const body={single:'4000000',daily:'8000000',term:'30000000'};const r=await call(U2.pre+'/everyday',{method:'POST',headers:U2.H,body});fx('U2.everydayPost',{req:body,status:r.status,res:r.j});
    const stt=await state(U2);fx('U2.stateAfterLimitChange',stt);
    step('U2','AI limit change saved (200) and state.everyday shows 4/8/30',r.status===200&&stt?.everyday?.requestedSingle===body.single&&stt?.everyday?.requestedDaily===body.daily&&stt?.everyday?.requestedTerm===body.term,{status:r.status,res:r.j,everyday:stt?.everyday});
    const b1=await bal(shopA);const p=await aiPay('3','m-3');step('U2','after raising per-payment to 4, AI pays 3 -> paid',(await bal(shopA))-b1===3_000_000n,{out:p.out});});
  // ===================== EMERGENCY STOP + RESUME =====================
  if(tok)await tryStep('U2','emergency stop',async()=>{
    const s=await call(U2.pre+'/safety/stop',{method:'POST',headers:U2.H,body:{duration:'until_resume'}});fx('U2.safetyStop',{status:s.status,res:s.j});
    step('U2','emergency stop ok (server + chain pause)',s.status===200&&s.j?.ok===true&&s.j?.chain?.paused===true,{status:s.status,res:s.j});
    const b1=await bal(shopA);const p=await aiPay('1','m-4');step('U2','AI pay while stopped -> refused',(await bal(shopA))===b1,{out:p.out});
    const stt=await state(U2);fx('U2.stateWhileStopped',stt);
    const faceIdResume=async()=>{const c=await call(U2.pre+'/safety/resume',{method:'POST',headers:U2.H,body:{}});return {c,r:c.status===428?await call(U2.pre+'/safety/resume',{method:'POST',headers:U2.H,body:{nonce:c.j.nonce,...sign(c.j.digest,U2.phone)}}):c};};
    const U2T=(await adOf(U2.w))===V53A?getAddress(V53.trust):trust;/* t1197u §6#92: the trust contract of U2's suite */const IP=parseAbi(['function isPaused(address) view returns (bool)']);const chainPaused=()=>pub.readContract({address:U2T,abi:IP,functionName:'isPaused',args:[U2.w]});
    const {checkResumeCalls,RESUME_FEE_TO}=await import('../../src/v5/resume-onchain.mjs');
    const {c,r}=await faceIdResume();fx('U2.safetyResume',{challenge:{status:c.status,res:c.j},resume:{status:r.status,res:r.j},wallet:U2.w,owner:U2.ba,trust:U2T});
    step('U2','resume: Face ID challenge (428) then 202 confirm_on_chain plan (chain still paused -> NOT reported resumed)',c.status===428&&r.status===202&&r.j?.state==='confirm_on_chain'&&!!r.j?.id,{challenge:c.status,status:r.status,keys:Object.keys(r.j??{}),fee:r.j?.fee,err:r.j?.error});
    if(r.status!==202)return;const pl=r.j;
    const F=checkResumeCalls(pl.calls,{wallet:U2.w,trust:U2T,feeTo:RESUME_FEE_TO});
    step('U2','resume plan: from = owner Base Account, 2 calls = fee leg to 0xf14e…0dd9 + wallet.execute(trust, setPaused(false)), fee < 0.01 USDC, ur- sponsor',
      F!==null&&String(F)===pl.fee.usdc&&F<10_000n&&pl.from.toLowerCase()===U2.ba.toLowerCase()&&pl.owner.toLowerCase()===U2.ba.toLowerCase()&&pl.wallet.toLowerCase()===U2.w.toLowerCase()&&pl.feeTo===RESUME_FEE_TO&&pl.feeFrom==='kipurse_wallet_fee'&&/\/onboard\/new\/paymaster\?id=ur-[0-9a-f]{24}$/.test(pl.pm)&&pl.pm.endsWith(pl.id),
      {fee:pl.fee,feeTo:pl.feeTo,pm:pl.pm.replace(/^.*\?/,'?')});
    {const s1=await state(U2);const b1=await bal(shopA);const p=await aiPay('1','m-4b');
     step('U2','after Face ID only (chain still paused): app state still paused, AI pay still refused',s1?.paused!==false&&(await bal(shopA))===b1&&await chainPaused()===true,{statePaused:s1?.paused,out:p.out});}
    const pg=await fetch(GU+U2.pre+'/safety/resume?plan='+pl.id+'&lang=zh');const html=await pg.text();fx('U2.resumePage',{status:pg.status,html});
    const kd=JSON.parse((/<script type="application\/json" id=kp-data>([\s\S]*?)<\/script>/.exec(html)??[])[1]??'null');
    step('U2','resume sign page: 200, kp-data = the same calls/owner/pm/fee, loads /safety/resume.js, shows the fee',pg.status===200&&JSON.stringify(kd?.calls)===JSON.stringify(pl.calls)&&kd?.owner===pl.owner&&kd?.pm===pl.pm&&kd?.fee?.usdc===pl.fee.usdc&&kd?.id===pl.id&&/src="\/safety\/resume\.js"/.test(html)&&html.includes(pl.fee.usdcText+' USDC'),{status:pg.status,len:html.length});
    const early=await call(U2.pre+'/safety/resume',{method:'POST',body:{confirm:pl.id}});
    step('U2','resume confirm before the chain tx -> not ok (page keeps waiting)',early.status===200&&!early.j?.ok&&!early.j?.error,{res:early.j});
    const wb=await bal(U2.w),fb=await bal(RESUME_FEE_TO);const b=await batch(U2,pl.calls);
    const paid=wb-await bal(U2.w),got=await bal(RESUME_FEE_TO)-fb,cp=await chainPaused();
    step('U2','resume batch: ONE Base Account tx; wallet paid exactly the quoted fee to 0xf14e…0dd9; isPaused(wallet) = false on chain',b.status==='success'&&paid===F&&got===F&&cp===false,{tx:b.hash,gas:b.gas,actualUsd:b.usd,quotedUSDC:pl.fee.usdc,paid:String(paid),chainPaused:cp});
    let cf;for(let i=0;i<5&&!(cf?.j?.ok);i++){cf=await call(U2.pre+'/safety/resume',{method:'POST',body:{confirm:pl.id}});if(!cf.j?.ok)await new Promise(r=>setTimeout(r,500));}
    step('U2','resume confirm after the chain tx -> ok (what the page and the App poll)',cf.j?.ok===true,{res:cf.j});
    {const sr=await state(U2);fx('U2.stateAfterResume',sr);const st=await call(U2.pre+'/safety/status',{headers:U2.H});
     step('U2','after resume: app state not paused, safety/status not paused, chain not paused',sr?.paused===false&&!st.j?.paused&&await chainPaused()===false,{statePaused:sr?.paused,status:st.j});}
    const b2=await bal(shopA);const p2=await aiPay('1','m-5');step('U2','AI pay immediately after resume -> paid',(await bal(shopA))-b2===1_000_000n,{out:p2.out});
    {const again=await faceIdResume();step('U2','resume when the chain is not paused (e.g. auto safety pause) -> 200 right after Face ID, no Coinbase step, no fee',again.r.status===200&&again.r.j?.chain?.paused===false,{status:again.r.status,res:again.r.j});}
    {const s2=await call(U2.pre+'/safety/stop',{method:'POST',headers:U2.H,body:{duration:'24h'}});const x=await faceIdResume();const stale=await call(U2.pre+'/safety/resume',{method:'POST',body:{confirm:pl.id}});
     step('U2','stop again -> new resume plan; the old plan id is void (expired)',s2.j?.chain?.paused===true&&x.r.status===202&&x.r.j?.id!==pl.id&&stale.j?.error==='expired',{stop:s2.j?.chain,status:x.r.status,stale:stale.j});
     if(x.r.status===202){const b3=await batch(U2,x.r.j.calls);let c3;for(let i=0;i<5&&!(c3?.j?.ok);i++){c3=await call(U2.pre+'/safety/resume',{method:'POST',body:{confirm:x.r.j.id}});if(!c3.j?.ok)await new Promise(r=>setTimeout(r,500));}
       const b4=await bal(shopA);const p4=await aiPay('1','m-5b');step('U2','second stop -> resume -> AI pay paid again',b3.status==='success'&&c3.j?.ok===true&&(await bal(shopA))-b4===1_000_000n,{tx:b3.hash,confirm:c3.j,out:p4.out});}}
    {const bogus=await call(U2.pre+'/safety/resume?plan=000000000000000000000000');step('U2','unknown / expired resume page -> 410 page, no kp-data',bogus.status===410,{status:bogus.status});}
  });
  // ===================== t1170u (handbook §6#82, locked): NEW payee above an AI auto limit -> "do you know this payee?" (owner ask) =====================
  if(tok)await new Promise(r=>setTimeout(r,61000));/* fresh per-IP rate window (prod limit unchanged) */
  if(tok)await tryStep('ASK','owner ask (new payee over the AI limit)',async()=>{await useExec(U2);const tag=Date.now().toString(36);
    const buyA=(args)=>mcpTool(U2.pre,tok,'kipurse_buy',{purpose:'daily',merchant:'T1170 Desk',item:'standing desk',user_request:'buy the desk',...args});
    const props=async()=>((await call(U2.pre+'/safety/mandates',{headers:U2.H})).j?.proposals??[]);
    const rsh=d=>pub.readContract({address:U2.w,abi:parseAbi(['function replaySafeHash(bytes32 hash) view returns (bytes32)']),functionName:'replaySafeHash',args:[d]});
    const approveAsk=async(id,mode,{forge=false}={})=>{const p=await call(U2.pre+'/safety/mandates/ask-prepare',{method:'POST',headers:U2.H,body:{id,mode}});if(p.status!==200)return {prep:p};
      const sg=forge?{r:toHex(7n,{size:32}),s:toHex(9n,{size:32})}:sign(p.j.sign.digest,U2.phone);const body={id,mode,...sg,pay:forge?sg:sign(p.j.pay.digest,U2.phone),...(p.j.trust?{trust:forge?sg:sign(await rsh(p.j.trust.digest),U2.phone)}:{})};
      const ap=await call(U2.pre+'/safety/mandates/approve',{method:'POST',headers:U2.H,body});let trustFinal=null;
      if(ap.status===200&&mode==='trust'){const t0=Date.now();for(;;){const x=((await call(U2.pre+'/safety/mandates',{headers:U2.H})).j?.askTrust??[]).find(z=>z.id===id);trustFinal=x?.trust??null;if((trustFinal&&trustFinal.state!=='submitting')||Date.now()-t0>90000)break;await new Promise(z=>setTimeout(z,250));}}/* t1243 §6#113: the trust lands after the paid reply */
      return {prep:p,ap,trustFinal};};
    // 1) new payee X, 3 USDC > AI everyday per-payment 2 (wallet per-payment 5) -> ask_owner + relay question, nothing paid
    const X=privateKeyToAccount(generatePrivateKey()).address,kx='ask-x-'+tag;const w0=await bal(U2.w);const a=await buyA({to:X,amount:'3',idempotencyKey:kx});fx('ASK.newPayeeOver',{status:a.status,out:a.out});aiOut('mcp','ASK.newPayeeOver (kipurse_buy)',a.out);
    step('ASK','new payee 3 USDC > AI per-payment 2 -> ask_owner, awaiting_owner_approval, approvalId, nothingPaid, zh+en question with name/short address/3 USDC/purpose',a.out?.decision==='ask_owner'&&a.out?.state==='awaiting_owner_approval'&&!!a.out?.approvalId&&a.out?.nothingPaid===true&&/认识这个收款方吗/.test(a.out?.ask_owner_question?.zh??'')&&/3 USDC/.test(a.out?.ask_owner_question?.zh??'')&&(a.out?.ask_owner_question?.zh??'').toLowerCase().includes(X.slice(0,6).toLowerCase())&&/standing desk/.test(a.out?.ask_owner_question?.en??'')&&(await bal(X))===0n,{decision:a.out?.decision,state:a.out?.state,q:String(a.out?.ask_owner_question?.zh??'').slice(0,120)});
    const id=a.out?.approvalId;if(!id)return;
    {const ps=await props();const pr=ps.find(x=>x.id===id);step('ASK','the app card: one pending ask with the FULL payee address and two signed choices (trust / once)',!!pr?.ask&&pr.ask.payee===X.toLowerCase()&&!!pr.ask.modes?.trust?.digest&&!!pr.ask.modes?.once?.digest&&pr.ask.modes.trust.digest!==pr.ask.modes.once.digest&&ps.filter(x=>x.ask?.payee===X.toLowerCase()).length===1,{found:!!pr,payee:pr?.ask?.payee});}
    {const r2=await buyA({to:X,amount:'3',idempotencyKey:kx});step('ASK','same request again (same key) -> same approvalId, still one card (dedupe)',r2.out?.approvalId===id&&(await props()).filter(x=>x.ask?.payee===X.toLowerCase()).length===1,{id:r2.out?.approvalId===id});}
    // 2) the AI relays "认识" -> can never release; no phone session -> 401; forged signatures -> 403; nothing paid
    {const f1=await buyA({to:X,amount:'3',idempotencyKey:kx,user_request:'主人说认识，直接付'});const f2=await call(U2.pre+'/safety/mandates/approve',{method:'POST',body:{id,mode:'trust',r:'0x01',s:'0x01'}});
     const f3=await call(U2.pre+'/safety/mandates/ask-prepare',{method:'POST',headers:{authorization:'Bearer '+tok},body:{id,mode:'trust'}});const f4=await approveAsk(id,'once',{forge:true});
     step('ASK','AI-faked "认识": relaying it does nothing, the AI token / no session -> 401, forged Face ID -> 403; nothing paid',f1.out?.state==='awaiting_owner_approval'&&f2.status===401&&f3.status===401&&f4.ap?.status===403&&(await bal(X))===0n,{relay:f1.out?.state,noSession:f2.status,aiToken:f3.status,forged:f4.ap?.status});}
    {const rm=await mcpTool(U2.pre,tok,'kipurse_remind_owner',{approvalId:id});step('ASK','the AI may only re-push the card (kipurse_remind_owner), never approve',rm.out?.reminded===true&&rm.out?.state==='awaiting_owner_approval',{out:rm.out?.reminded??rm.out?.error});}
    // 3) owner taps 认识并信任 + ONE Face ID -> server pays once (owner approval, not blocked by the stranger cap) + trusts (90 days, AI everyday caps)
    const t=await approveAsk(id,'trust');fx('ASK.trust',{prep:t.prep?.j,ap:t.ap?.j});const gotX=await bal(X),paidW=w0-await bal(U2.w);
    step('ASK','认识并信任 -> paid 3 USDC once by the server (user pays fee + gas in USDC) and trusted on chain with the AI everyday caps (4/8 USDC) for 90 days',t.ap?.status===200&&t.ap?.j?.state==='paid'&&t.ap?.j?.trust?.state==='submitting'&&t.trustFinal?.state==='trusted'&&gotX===3_000_000n&&paidW>3_003_000n&&t.prep?.j?.trust?.single==='4000000'&&t.prep?.j?.trust?.daily==='8000000'&&t.prep?.j?.trust?.days===90,{status:t.ap?.status,state:t.ap?.j?.state,trust:t.ap?.j?.trust,x:String(gotX),wallet:String(paidW),err:t.prep?.j?.error??t.ap?.j?.error});
    {const st=await mcpTool(U2.pre,tok,'kipurse_approval_status',{approvalId:id});const r3=await buyA({to:X,amount:'3',idempotencyKey:kx});aiOut('mcp','ASK.statusPaid (kipurse_approval_status)',st.out);aiOut('mcp','ASK.retryPaid (kipurse_buy)',r3.out);
     step('ASK','the AI reads the result: approval status paid; same key again -> paid answer, no second payment',st.out?.state==='paid'&&r3.out?.state==='paid'&&(await bal(X))===3_000_000n,{status:st.out?.state,retry:r3.out?.state});}
    {const d2=await approveAsk(id,'trust');step('ASK','double approval -> already handled, paid exactly once',(d2.prep?.status===409||d2.ap?.status===409)&&(await bal(X))===3_000_000n,{prep:d2.prep?.status,ap:d2.ap?.status});}
    {const n=await buyA({to:X,amount:'1',idempotencyKey:'ask-x2-'+tag});aiOut('mcp','ASK.trustedNext (kipurse_buy)',n.out);step('ASK','trusted payee: next 1 USDC (inside the AI limits) is paid automatically, no question',n.out?.state==='paid'&&(await bal(X))===4_000_000n,{state:n.out?.state,reason:n.out?.reason});}
    // 4) 只付这一次 -> paid once, NOT trusted: the next payment asks again
    {const Y=privateKeyToAccount(generatePrivateKey()).address;const y=await buyA({to:Y,amount:'3',idempotencyKey:'ask-y-'+tag});const o=y.out?.approvalId?await approveAsk(y.out.approvalId,'once'):{};fx('ASK.once',{ask:y.out,ap:o.ap?.j});
     step('ASK','只付这一次 -> paid 3 USDC once, not added to the trust list',y.out?.decision==='ask_owner'&&o.ap?.status===200&&o.ap?.j?.state==='paid'&&o.ap?.j?.trust===null&&(await bal(Y))===3_000_000n,{ask:y.out?.state,ap:o.ap?.status,state:o.ap?.j?.state});
     const y2=await buyA({to:Y,amount:'1',idempotencyKey:'ask-y2-'+tag});step('ASK','only once: the next payment to the same payee asks again, nothing paid',y2.out?.decision==='ask_owner'&&y2.out?.state!=='paid'&&(await bal(Y))===3_000_000n,{decision:y2.out?.decision,state:y2.out?.state});}
    // 5) over the wallet per-payment limit (5) -> no approvable card; raise the wallet limit in the app
    {const Z=privateKeyToAccount(generatePrivateKey()).address;const n0=(await props()).length;const z=await buyA({to:Z,amount:'6',idempotencyKey:'ask-z-'+tag});aiOut('mcp','ASK.overWallet (kipurse_buy)',z.out);
     step('ASK','6 USDC > wallet per-payment 5 -> refuse OVER_WALLET_LIMIT, no card, tell the owner to raise the wallet limit in the app',z.out?.reason==='OVER_WALLET_LIMIT'&&z.out?.nothingPaid===true&&(await props()).length===n0&&/钱包总限额/.test(z.out?.say_to_user??'')&&(await bal(Z))===0n,{reason:z.out?.reason,cards:(await props()).length-n0});}
    // 6) 24 h expiry -> nothing paid, card gone
    {const V=privateKeyToAccount(generatePrivateKey()).address;const v=await buyA({to:V,amount:'3',idempotencyKey:'ask-v-'+tag});const vid=v.out?.approvalId;let ok=false;
     if(vid){const T=await M.tenant(U2.w);const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(T.engine().ledgerPath);db.prepare(`UPDATE owner_ask SET expires_at=?,created_at=? WHERE approval_id=?`).run(Date.now()-1,Date.now()-86400e3-1,vid);db.prepare(`UPDATE mandate_proposal SET created_at=? WHERE id=?`).run(Date.now()-86400e3-1000,vid);db.close();
       const e1=await approveAsk(vid,'once');const s1=await mcpTool(U2.pre,tok,'kipurse_approval_status',{approvalId:vid});ok=e1.prep?.status===409&&s1.out?.state==='expired'&&s1.out?.nothingPaid===true&&!(await props()).some(x=>x.id===vid)&&(await bal(V))===0n;}
     step('ASK','24 h expiry -> approval refused, status expired, card gone, nothing paid',ok,{id:!!vid});}
    // 7) §6#80: every ask answer above is human-ready USDC
    {const l=AIOUT.filter(x=>/^ASK\./.test(x.label));const bad=l.filter(x=>amountProblems(x.o).length);step('ASK','§6#82 ask answers keep the §6#80 amount rule (USDC + Display, no raw base units)',l.length>=5&&bad.length===0,{count:l.length,bad:bad.map(x=>x.label)});}
  });
  // ===================== t1204 / handbook §6#93: MERCHANT ORDER, the AI fills the order fields (ExampleShop-shaped MOCK merchant on 127.0.0.1, never the real one) =====================
  if(tok)await tryStep('U2','§6#93 merchant order',async()=>{const http=await import('node:http');const {randomUUID}=await import('node:crypto');
    /* runs AFTER every U2 limit/ask check, on a NEW chain day (+24 h, wallet day cap) and with the owner's everyday 24 h limit raised (app saveEveryday), so its 1.1 USDC never eats the budget those checks rely on */
    await tc.increaseTime({seconds:86400+60});await tc.mine({blocks:1});
    /* + a plain 50 USDC deposit to U2's wallet, so these 1.1 USDC are not >50% of the balance moved out in 24 h (the large_outflow safety pause stays a real guard, not tripped by test bookkeeping) */
    {const h=await createWalletClient({chain:base,transport:vh(RPC),account:whale}).writeContract({address:USDC,abi:ERC20,functionName:'transfer',args:[U2.w,50_000_000n]});await pub.waitForTransactionReceipt({hash:h});}
    {const ev=await call(U2.pre+'/everyday',{method:'POST',headers:U2.H,body:{single:'4000000',daily:'20000000',term:'60000000'}/* = U2's wallet floor 5/20/100 at most */});step('U2','§6#93 setup: owner raises everyday 24 h limit for the merchant-order steps (app saveEveryday)',ev.status===200,{status:ev.status,err:ev.j?.error});}
    const F=JSON.parse(fs.readFileSync(GW+'test/fixtures/t1204-example-shop-shape.json','utf8'));const TOKEN=randomUUID(),SUBSEC='subsec-'+randomUUID(),MGMT='mgmt-'+randomUUID();
    const seen={create:[],status:[],first:[]};const ordersM=new Map();
    const orderOf=async(pid,c=50)=>{const t=Number((await pub.getBlock()).timestamp);return {purchaseId:pid,status:'open',chainId:8453,tokenContract:USDC,depositAddress:shopA,amountAtomic:String(c*10000),amountUsdc:(c/100).toFixed(2),amountCents:c,expiresAt:new Date((t+900)*1000).toISOString(),statusUrl:'/api/v1/agent/usdc-orders/'+pid};};
    const srv=http.createServer(async(q,s)=>{let raw='';for await(const c of q)raw+=c;const u=new URL(q.url,'http://x');const J=(c,b)=>{s.writeHead(c,{'content-type':'application/json'});s.end(JSON.stringify(b));};
      if(q.method==='GET'&&u.pathname==='/openapi.json')return J(200,F.openapi);if(q.method==='GET'&&u.pathname==='/api/v1/agent/capabilities')return J(200,F.capabilities);
      if(q.method==='POST'&&u.pathname==='/api/v1/agent/usdc-orders'){const b=JSON.parse(raw||'{}');seen.create.push(b);
        if(b.ownerToken!==TOKEN)return J(403,{error:'invalid ownerToken '+String(b.ownerToken)});if(!b.listingId||!b.purchaseId||!b.targetBid||!b.board)return J(400,{error:'bad_request'});
        if(!ordersM.has(b.purchaseId))ordersM.set(b.purchaseId,await orderOf(b.purchaseId));return J(200,{...ordersM.get(b.purchaseId),listingId:b.listingId,board:b.board,targetBid:b.targetBid});}
      if(q.method==='POST'&&u.pathname==='/api/v1/agent/first-bid'){const b=JSON.parse(raw||'{}');seen.first.push(b);
        if(b.submissionSecret!==SUBSEC||b.userApproved!==true||!b.idempotencyKey||!b.purchaseId)return J(400,{error:'bad_request'});
        if(!ordersM.has(b.purchaseId))ordersM.set(b.purchaseId,await orderOf(b.purchaseId,60));/* another amount: the same-payee+amount layer must not be what decides here */const o=ordersM.get(b.purchaseId);
        return J(200,{stage:'payment_request_ready',purchaseId:b.purchaseId,statusUrl:o.statusUrl,listing:{id:'lst-new',ownerToken:MGMT,managementUrl:'/manage/'+MGMT},paymentRequest:{chainId:8453,tokenContract:USDC,depositAddress:o.depositAddress,amountAtomic:o.amountAtomic,amountUsdc:o.amountUsdc,expiresAt:o.expiresAt}});}
      if(q.method==='GET'&&u.pathname.startsWith('/api/v1/agent/usdc-orders/')){seen.status.push(q.headers.authorization??null);
        const pid=decodeURIComponent(u.pathname.split('/').pop());if(!ordersM.has(pid))return J(404,{error:'not_found'});return J(200,{purchaseId:pid,status:'fulfilled',rank:1});}
      J(404,{error:'not_found'});});
    await new Promise(r=>srv.listen(0,'127.0.0.1',r));const ORIGIN='http://127.0.0.1:'+srv.address().port;
    const cap=[];const ow=process.stdout.write.bind(process.stdout),ew=process.stderr.write.bind(process.stderr);
    process.stdout.write=(c,...a)=>{cap.push(String(c));return ow(c,...a);};process.stderr.write=(c,...a)=>{cap.push(String(c));return ew(c,...a);};
    try{
      const buy=(args)=>mcpTool(U2.pre,tok,'kipurse_buy',{purpose:'promo',merchant:'ExampleShop-shaped mock',item:'bid for my listing',user_request:'把我的网站竞价到第一',origin:ORIGIN,waitSeconds:3,...args});
      const tl=await mcpMany(U2.pre,tok,[]);const mdesc=(tl.tools??[]).find(t=>t.name==='kipurse_pay_merchant_order')?.description??'';
      step('U2','§6#93 MCP: kipurse_pay_merchant_order says YOU fill orderParams; no "owner config" credential',/YOU fill orderParams/.test(mdesc)&&!/owner config/.test(mdesc),{desc:mdesc.slice(0,160)});
      const b0=await bal(shopA);const m1=await buy({orderParams:{targetBid:1,board:'all'},merchantPurchaseId:randomUUID()});
      step('U2','§6#93 missing order fields -> refuse, names listingId + ownerToken, says get them from the user/merchant, nothing created or paid',
        m1.out?.decision==='refuse'&&m1.out?.reason==='missing_order_fields'&&JSON.stringify(m1.out?.missingFields)==='["listingId","ownerToken"]'&&/listingId/.test(m1.out?.say_to_user??'')&&/ownerToken/.test(m1.out?.say_to_user??'')&&seen.create.length===0&&(await bal(shopA))===b0,
        {reason:m1.out?.reason,missing:m1.out?.missingFields,say:m1.out?.say_to_user,creates:seen.create.length});
      const PID=randomUUID();const m2=await buy({orderParams:{listingId:'lst-1',ownerToken:TOKEN,targetBid:1,board:'all'},merchantPurchaseId:PID});const b1=await bal(shopA);
      step('U2','§6#93 AI-supplied fields (listingId, ownerToken, targetBid, board) -> merchant got the AI token in the JSON body, paid 0.5 USDC exactly once to the order deposit address',
        m2.out?.state==='paid'&&b1-b0===500_000n&&seen.create.length===1&&seen.create[0].ownerToken===TOKEN&&seen.create[0].purchaseId===PID,{state:m2.out?.state,reason:m2.out?.reason,delta:String(b1-b0),creates:seen.create.length});
      step('U2','§6#93 status follow-up used the AI token as Bearer for that merchant only -> fulfilled',m2.out?.fulfillment==='fulfilled'&&seen.status.length>=1&&seen.status.every(h=>h==='Bearer '+TOKEN),{fulfillment:m2.out?.fulfillment,polls:seen.status.length});
      step('U2','§6#93 the AI token is not in the answer',!JSON.stringify(m2).includes(TOKEN),{});
      const m3=await buy({orderParams:{listingId:'lst-1',ownerToken:TOKEN,targetBid:1,board:'all'},merchantPurchaseId:PID});const b2=await bal(shopA);
      step('U2','§6#93 same merchantPurchaseId again -> no second charge (duplicate protection)',b2===b1&&[undefined,null,m2.out?.txHash].includes(m3.out?.txHash),{state:m3.out?.state,reason:m3.out?.reason,delta:String(b2-b1),sameTx:m3.out?.txHash===m2.out?.txHash});
      const m4=await buy({orderParams:{listingId:'lst-1',ownerToken:'wrong-'+TOKEN,targetBid:1,board:'all'},merchantPurchaseId:randomUUID()});
      step('U2','§6#93 merchant refusal that echoes the AI token -> redacted in the answer, nothing paid',m4.out?.decision==='refuse'&&!JSON.stringify(m4).includes(TOKEN)&&(await bal(shopA))===b2,{reason:m4.out?.reason,detail:m4.out?.detail});
      const FP=randomUUID();const m5=await buy({orderParams:{destination:'https://game.example',category:'games',rulesVersion:'2026-11',userApproved:true,credentialsSavedSecurely:true,submissionSecret:SUBSEC,purchaseId:FP,board:'today',targetBid:1,maxAmountCents:100},merchantPurchaseId:'idem-'+FP});const b3=await bal(shopA);
      step('U2','§6#93 no-listing first bid (publish-and-prepare route) -> paid 0.6 USDC from the nested paymentRequest; submissionSecret + new listing token never in the answer',
        m5.out?.state==='paid'&&b3-b2===600_000n&&seen.first.length===1&&seen.first[0].idempotencyKey==='idem-'+FP&&!JSON.stringify(m5).includes(SUBSEC)&&!JSON.stringify(m5).includes(MGMT),{state:m5.out?.state,reason:m5.out?.reason,delta:String(b3-b2)});
      const leaks=[];const scan=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=join(d,e.name);if(e.isDirectory())scan(p);else{const buf=fs.readFileSync(p);for(const [k,v] of [['token',TOKEN],['submissionSecret',SUBSEC],['merchantReceipt',MGMT]])if(buf.includes(Buffer.from(v)))leaks.push(k+'@'+p.slice(DATA.length));}}};scan(DATA);scan(CONF);
      step('U2','§6#93 AI secrets never stored: not in ledger / kv / any data or config file',leaks.length===0,{leaks});
      const logs=cap.join('');step('U2','§6#93 AI secrets never logged (gateway stdout/stderr during the merchant steps)',!logs.includes(TOKEN)&&!logs.includes(SUBSEC)&&!logs.includes(MGMT),{bytes:logs.length});
    }finally{process.stdout.write=ow;process.stderr.write=ew;srv.close();}});
  // ===================== REVOKE CONNECTION (app: AllowancesView stop agent) =====================
  if(tok)await tryStep('U2','revoke connection',async()=>{
    const m=await call(U2.pre+'/safety/mandates',{headers:U2.H});fx('U2.mandates',{status:m.status,res:m.j});
    const ag=(m.j?.agents??[]).find(a=>a.id!=='siri');step('U2','connected AI listed for the owner',!!ag,{agents:m.j?.agents});if(!ag)return;
    const r=await call(U2.pre+'/safety/agents/stop',{method:'POST',headers:U2.H,body:{agentId:ag.id}});fx('U2.agentStop',{status:r.status,res:r.j});
    const b1=await bal(shopA);const p=await aiPay('1','m-6');step('U2','after stopping the AI, its pay is refused',r.status===200&&(await bal(shopA))===b1,{stop:r.j,out:p.out});
    if(tok){/* t1170u §6#82: a stopped AI never gets an owner ask (no card, no push), even for a new payee above its limit */const n0=((await call(U2.pre+'/safety/mandates',{headers:U2.H})).j?.proposals??[]).length;const Q=privateKeyToAccount(generatePrivateKey()).address;
     const q=await mcpTool(U2.pre,tok,'kipurse_buy',{purpose:'daily',merchant:'T1170 Stopped',item:'x',user_request:'x',to:Q,amount:'3',idempotencyKey:'ask-stop-'+Date.now().toString(36)});const n1=((await call(U2.pre+'/safety/mandates',{headers:U2.H})).j?.proposals??[]).length;
     step('U2','ASK stopped AI: new payee over its limit -> AGENT_STOPPED, no owner ask card',q.out?.decision!=='ask_owner'&&/AGENT_STOPPED|stopped/i.test(JSON.stringify(q.out??{}))&&n1===n0&&(await bal(Q))===0n,{out:q.out?.reason??q.out?.state,cards:[n0,n1]});}
    const stt=await state(U2);fx('U2.stateFinal',stt);});
  // ===================== t1153u SIRI RECONNECT (an older oauth-siri record must be replaced, not block the connection) =====================
  const U3=await openUser('U3');R.U3={wallet:U3.w};
  /* t1161u: the extra seen-marker steps push this one-IP test past the 600/min per-IP limit (prod limit unchanged); pace like a real client: start U3 in a fresh rate window */
  await new Promise(r=>setTimeout(r,61000));
  await tryStep('U3','siri reconnect',async()=>{
    const T=await M.tenant(U3.w);step('U3','tenant loaded for the Siri reconnect case',!!T?.S,{});if(!T?.S)return;
    T.S.oauthAgents??={};T.S.oauthAgents['oauth-siri']={id:'oauth-siri',name:'Siri',kind:'custom',clientId:'kpc_t1153_OLD',created:'2026-11-14T00:00:00.000Z'};T.saveState();
    const amts={single:'2000000',daily:'5000000',total:'20000000'};
    const f=await call(U3.pre+'/oauth/first',{method:'POST',body:{agent:'siri',...amts}});fx('U3.siriFirst',{status:f.status,res:f.j});
    step('U3','Siri oauth/first with an older Siri record present -> mode=first',f.status===200&&f.j?.mode==='first'&&!!f.j?.req,{status:f.status,err:f.j?.error});if(f.status!==200)return;
    const d=await approveFirst(U3,f.j.req,amts,'siriReconnect');
    U3.siriCred=d?.siriCredential??null;/* t1158u: Siri-scoped credential from the signed Siri approval */
    const row=T.S.oauthAgents['oauth-siri'];
    step('U3','Siri reconnect: old record replaced by the new client (no agent_id_in_use)',!!d&&row?.clientId===f.j.clientId&&row?.clientId!=='kpc_t1153_OLD',{row:row?{clientId:row.clientId===f.j.clientId?'new':'other'}:null});;
    // t1157u: what the app reads after the reconnect (home Siri bead + Siri page): ONE Siri, the phone row, connected; mandates one Siri; reply carries the saved limits
    const isSiri=a=>[a?.id,a?.kind,a?.name].filter(Boolean).some(x=>String(x).toLowerCase().includes('siri'));
    const s3=await state(U3);fx('U3.stateAfterSiriReconnect',{agents:s3?.agents,everyday:s3?.everyday});const sl=(s3?.agents??[]).filter(isSiri);
    step('U3','after Siri reconnect: state lists exactly one Siri (id siri) and it is connected',sl.length===1&&sl[0].id==='siri'&&sl[0].connected===true&&s3?.everyday?.authorized===true,{siri:sl.map(a=>({id:a.id,via:a.via,connected:a.connected}))});
    const m3=await call(U3.pre+'/safety/mandates',{headers:U3.H});const ml=(m3.j?.agents??[]).filter(isSiri);
    step('U3','after Siri reconnect: /safety/mandates lists Siri once',m3.status===200&&ml.length===1&&ml[0].id==='siri',{status:m3.status,siri:ml.map(a=>a.id)});
    step('U3','phone-decide reply carries the saved AI limits (app updates without a stale view)',d?.everyday?.authorized===true&&d.everyday.requestedSingle===amts.single&&d.everyday.requestedTerm===amts.total,{everyday:d?.everyday?{authorized:d.everyday.authorized}:null});});
  // ===================== t1158u (§6#77) SIRI PAY PARITY: real POST /siri/buy with the Siri credential (no phone session) =====================
  await tryStep('U3','siri buy (credential)',async()=>{await useExec(U3);
    const cred=U3.siriCred;step('U3','signed Siri approval returned a Siri credential (ksc_…)',/^ksc_[A-Za-z0-9_-]{43}$/.test(String(cred??'')),{has:!!cred});if(!cred)return;
    const C={authorization:'Bearer '+cred};const tag=Date.now().toString(36);const cafe=privateKeyToAccount(generatePrivateKey()).address;const NAME='T1158 Cafe '+tag;
    const sb=(body,headers=C)=>call(U3.pre+'/siri/buy?lang=zh',{method:'POST',headers,body:{purpose:'daily',lang:'zh',item:'Siri 付款给 '+NAME,merchant:NAME,user_request:'Siri: pay',...body}});
    {const a=await sb({to:cafe,amount:'1',idempotencyKey:'siri-noauth-'+tag},{});const b=await sb({to:cafe,amount:'1',idempotencyKey:'siri-bad-'+tag},{authorization:'Bearer ksc_'+'A'.repeat(43)});
     step('U3','/siri/buy without auth or with a wrong credential -> 401, nothing paid',a.status===401&&b.status===401&&(await bal(cafe))===0n,{noAuth:a.status,wrong:b.status});}
    {const m=await call(U3.pre+'/mcp',{method:'POST',headers:{...C,accept:'application/json, text/event-stream'},body:{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'x',version:'1'}}}});
     const st=await call(U3.pre+'/phone/session/state',{headers:C});step('U3','the Siri credential opens nothing else (/mcp, phone state -> 401)',m.status===401&&st.status===401,{mcp:m.status,state:st.status});}
    // new payee inside the limits -> ask_owner (Face ID push) -> owner approves -> the server completes exactly that payment once
    const k0='siri-new-'+tag;const w0=await bal(U3.w);const r0=await sb({to:cafe,amount:'0.1',idempotencyKey:k0});fx('U3.siriNewPayee',{status:r0.status,res:r0.j});
    step('U3','Siri pays a NEW payee 0.1 USDC -> ask_owner with an approval id, nothing paid',r0.status===200&&r0.j?.decision==='ask_owner'&&!!r0.j?.approvalId&&(await bal(cafe))===0n,{status:r0.status,decision:r0.j?.decision,reason:r0.j?.reason,state:r0.j?.state,approvalId:!!r0.j?.approvalId});
    if(r0.j?.approvalId){const m=await call(U3.pre+'/safety/mandates',{headers:U3.H});const pr=(m.j?.proposals??[]).find(x=>x.id===r0.j.approvalId);
      step('U3','the Siri request shows as a pending approval for the owner (Face ID push target)',!!pr?.digest,{found:!!pr,by:pr?.by});
      if(pr?.digest){const ap=await call(U3.pre+'/safety/mandates/approve',{method:'POST',headers:U3.H,body:{id:pr.id,...sign(pr.digest,U3.phone)}});fx('U3.siriApprove',{status:ap.status,res:ap.j});
        const got=await bal(cafe),paid=w0-await bal(U3.w);
        step('U3','owner Face ID approval -> server completes the Siri payment once: cafe +0.1 USDC, wallet paid 0.1 + 0.1% fee + gas (user pays every fee)',ap.status===200&&ap.j?.ok===true&&ap.j?.siri?.state==='paid'&&got===100_000n&&paid>100_100n,{status:ap.status,siri:ap.j?.siri,cafe:String(got),walletPaid:String(paid)});
        const again=await call(U3.pre+'/safety/mandates/approve',{method:'POST',headers:U3.H,body:{id:pr.id,...sign(pr.digest,U3.phone)}});
        step('U3','approving the same request again -> not_pending, no second payment',again.status===409&&!again.j?.siri&&(await bal(cafe))===100_000n,{status:again.status,err:again.j?.error});}}
    // the approved payee is now a saved name: Siri pays it by NAME inside the limits with no Face ID; fee 0.1%
    {const s3=await state(U3);const pb=(s3?.payeeBook??[]).find(x=>x.name===NAME);step('U3','state.payeeBook lists the approved payee name (what Siri may say)',!!pb&&pb.address.toLowerCase()===cafe.toLowerCase()&&pb.status!=='new',{payeeBook:(s3?.payeeBook??[]).map(x=>({name:x.name,status:x.status}))});}
    const ord='siri-order-'+tag,k1='siri-in-'+tag;const c1=await bal(cafe),w1=await bal(U3.w);const r1=await sb({payee_name:NAME,amount:'0.05',orderRef:ord,idempotencyKey:k1});fx('U3.siriInLimit',{status:r1.status,res:r1.j});
    const c2=await bal(cafe),w2=await bal(U3.w);
    step('U3','Siri pays the saved payee BY NAME 0.05 USDC inside the limits -> paid on chain, no Face ID, protocol fee 0.1% (0.00005 USDC) + network fee paid by the user',r1.j?.state==='paid'&&c2-c1===50_000n&&String(r1.j?.feeAtomic)==='50'&&r1.j?.fee==='0.00005'&&w1-w2===BigInt(r1.j?.totalAtomic??0)&&w1-w2>50_050n&&!!r1.j?.say_to_user&&!/Something went wrong/.test(r1.j?.say_to_user),{state:r1.j?.state,decision:r1.j?.decision,reason:r1.j?.reason,fee:r1.j?.fee,networkFee:r1.j?.networkFee,total:r1.j?.total,cafe:String(c2-c1),wallet:String(w1-w2)});
    // 0A#7 layer 1: same Siri request resent with the SAME key -> replay; layer 2: same order paid again with NEW keys -> blocked
    {const a=await sb({payee_name:NAME,amount:'0.05',orderRef:ord,idempotencyKey:k1});const b=await sb({payee_name:NAME,amount:'0.05',orderRef:ord,idempotencyKey:k1});const c3=await bal(cafe),w3=await bal(U3.w);
     step('U3','DUP-1 (Siri) same request resent twice with the same Idempotency-Key -> first result replayed (same txHash / purchaseKey), cafe +0, wallet -0',a.j?.txHash===r1.j?.txHash&&b.j?.txHash===r1.j?.txHash&&a.j?.purchaseKey===r1.j?.purchaseKey&&c3===c2&&w3===w2,{tx:a.j?.txHash===r1.j?.txHash,state:a.j?.state,cafe:String(c3-c2),wallet:String(w2-w3)});
     const n1=await sb({payee_name:NAME,amount:'0.05',orderRef:ord,idempotencyKey:'siri-in2-'+tag});const n2=await sb({payee_name:NAME,amount:'0.05',orderRef:ord,idempotencyKey:'siri-in3-'+tag});const c4=await bal(cafe),w4=await bal(U3.w);
     step('U3','DUP-2 (Siri) same payee + orderRef + amount with NEW keys -> already_paid, no second charge',/^already_paid/.test(String(n1.j?.state??''))&&/^already_paid/.test(String(n2.j?.state??''))&&c4===c3&&w4===w3,{state1:n1.j?.state,state2:n2.j?.state,reason:n1.j?.reason,cafe:String(c4-c3),wallet:String(w3-w4)});}
    // 1 USDC to an off-chain-approved payee is above the on-chain unverified-payee cap: like every AI it needs the owner (trust on chain); nothing is paid
    {const c5=await bal(cafe);const o=await sb({payee_name:NAME,amount:'1',idempotencyKey:'siri-1usd-'+tag});fx('U3.siriAboveStrangerCap',{status:o.status,res:o.j});
     step('U3','Siri 1 USDC to a payee not trusted on chain -> ask_owner (owner trusts it in the app), nothing paid (same as every AI)',o.j?.decision==='ask_owner'&&o.j?.state!=='paid'&&(await bal(cafe))===c5,{decision:o.j?.decision,reason:o.j?.reason});}
    // over the owner's everyday per-payment limit (2): like every AI, nothing is paid and Siri gets a plain spoken reason
    {const c5=await bal(cafe);const o=await sb({payee_name:NAME,amount:'3',idempotencyKey:'siri-over-'+tag});fx('U3.siriOverLimit',{status:o.status,res:o.j});
     step('U3','Siri 3 USDC > everyday per-payment 2 -> not paid, plain reason to speak (same rule as every AI)',o.status===200&&o.j?.state!=='paid'&&(await bal(cafe))===c5&&!!o.j?.say_to_user&&!/Something went wrong/.test(o.j?.say_to_user),{decision:o.j?.decision,reason:o.j?.reason,say:String(o.j?.say_to_user??'').slice(0,80)});}
    // unknown name -> ask_owner "who?" , nothing paid
    {const c6=await bal(cafe);const u=await sb({payee_name:'Nobody '+tag,amount:'1',idempotencyKey:'siri-unk-'+tag});
     step('U3','Siri unknown payee name -> ask_owner (who to pay), nothing paid',u.j?.decision==='ask_owner'&&u.j?.nothingPaid===true&&(await bal(cafe))===c6,{decision:u.j?.decision,code:u.j?.code});}
    // Siri disconnect (agent stop) revokes the credential -> 401
    {const st=await call(U3.pre+'/safety/agents/stop',{method:'POST',headers:U3.H,body:{agentId:'siri'}});const c7=await bal(cafe);const r=await sb({payee_name:NAME,amount:'1',idempotencyKey:'siri-rev-'+tag});
     step('U3','after Siri is disconnected (agent stop) the Siri credential is revoked -> 401, nothing paid',st.status===200&&r.status===401&&(await bal(cafe))===c7,{stop:st.status,status:r.status});}
  });
  // ===================== t1166u / handbook §6#80 (PERMANENT): payment + Siri answers the AIs actually got =====================
  await tryStep('AI','ai amounts human-ready (pay + siri)',async()=>{
    for(const k of ['U2.aiPayWithin','U2.aiPayOverSingle','U2.dupFirst','U2.dupResend','U2.dupNewKey'])if(FX[k]?.out&&typeof FX[k].out==='object')aiOut('mcp',k+' (kipurse_pay)',FX[k].out);
    for(const k of ['U3.siriNewPayee','U3.siriInLimit','U3.siriAboveStrangerCap','U3.siriOverLimit'])if(FX[k]?.res)aiOut('siri',k+' (/siri/buy)',FX[k].res);
    const by=s=>AIOUT.filter(x=>x.surface===s);
    for(const s of ['mcp','siri']){const l=by(s);const bad=l.map(x=>({label:x.label,p:amountProblems(x.o)})).filter(x=>x.p.length);
      step('AI','§6#80 all '+l.length+' '+s+' answers collected in this run: amounts are USDC + Display, no raw base units',l.length>=(s==='mcp'?10:3)&&bad.length===0,{count:l.length,bad:bad.slice(0,5).map(x=>({label:x.label,p:x.p.slice(0,3)}))});}
    const pay=FX['U2.aiPayWithin']?.out;step('AI','§6#80 the 1 USDC AI payment answer says amount "1" / "1.00 USDC" (base units only in amountAtomic)',!!pay&&JSON.stringify(pay).includes('"amountDisplay":"1.00 USDC"')&&!/"amount":"?1000000"?[,}]/.test(JSON.stringify(pay)),{amount:pay?.amount,amountDisplay:pay?.amountDisplay,amountAtomic:pay?.amountAtomic});});
  const f1=await state(U1);fx('U1.stateFinal',f1);
  // ===================== OFFLINE RESCUE (app: ChainRescue.balances -> ChainRescue.plan -> Coinbase confirm of wallet.executeBatch) =====================
  await tryStep('U1','offline rescue',async()=>{
    const RA=parseAbi(['function vaultAddress(address) view returns (address)','function floatAddress(address) view returns (address)']);const VA=parseAbi(['function reserved() view returns (uint256)']);
    const wB=await bal(U1.w);let vault=null,vB=0n,vR=0n,flt=null,fB=0n;const UA=await adOf(U1.w);
    try{vault=getAddress(await pub.readContract({address:UA,abi:RA,functionName:'vaultAddress',args:[U1.w]}));if(/^0x0+$/.test(vault))vault=null;}catch{vault=null;}
    if(vault){vB=await bal(vault);vR=await pub.readContract({address:vault,abi:VA,functionName:'reserved'}).catch(()=>0n);}
    try{flt=getAddress(await pub.readContract({address:UA,abi:RA,functionName:'floatAddress',args:[U1.w]}));const code=await pub.getCode({address:flt});if(!code||code==='0x')flt=null;else fB=await bal(flt);}catch{flt=null;}
    const inp={wallet:U1.w,owner:U1.ba,adapter:UA,usdc:USDC,b:{wallet:String(wB),vault:String(vB),vaultReserved:String(vR),float:String(fB),vaultAddress:vault,floatAddress:flt}};
    fs.writeFileSync(MD+'/rescue-in.json',JSON.stringify(inp,null,1));fx('U1.rescueIn',inp);console.log('RESCUE_IN_WRITTEN');
    let out=null;const RW=Number(process.env.MATRIX_RESCUE_WAIT_S??600)/2;/* t1150: mutation runs set a short wait (no Mac handshake) */for(let i=0;i<RW&&!out;i++){try{out=JSON.parse(fs.readFileSync(MD+'/rescue-out.json','utf8'));}catch{await new Promise(r=>setTimeout(r,2000));}}
    step('U1','app ChainRescue.plan produced a call',!!out?.call,{out});if(!out?.call)return;
    const ob=await bal(U1.ba);const b=await batch(U1,[{to:out.call.to,data:out.call.data}]);
    const got=(await bal(U1.ba))-ob;
    step('U1','offline rescue: ONE owner tx, everything to the owner, wallet empty, no Kipurse server involved',b.status==='success'&&got===BigInt(out.amount)&&(await bal(U1.w))===0n,{tx:b.hash,got:String(got),planned:out.amount,walletLeft:String(await bal(U1.w))});
    const stt=await state(U1);fx('U1.stateAfterRescue',stt);});


  R.ok=true;
  }catch(e){console.log('ERR',String(e.stack??e).slice(0,1500));}finally{fs.writeFileSync(MD+'/fixtures.json',JSON.stringify(FX,null,1));fs.writeFileSync(process.env.REPORT??MD+'/matrix-report.json',JSON.stringify(R,(k,v)=>typeof v==='bigint'?v.toString():v,1));await M.close().catch(()=>{});setTimeout(()=>process.exit(0),500).unref?.();}});
