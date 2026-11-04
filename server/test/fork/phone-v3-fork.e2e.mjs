// FORK-ONLY phone approver V3 rehearsal (see below). Based on the new-user rehearsal harness.
// ORIGINAL HEADER: new-user rehearsal (private anvil fork of Base, never broadcasts, no real money): TWO brand-new users, each with a fresh
// Base Account (Coinbase Smart Wallet owned by a fresh key) and a fresh phone key, go end to end through the real gateway:
// onboarding (one batch) -> own deterministic wallet -> deposit -> agent pays within caps (over-cap refused) -> pause -> withdraw all
// -> delete. Cross-user isolation checked between them. Writes a JSON report (addresses, tx hashes, gas, fees) to $REPORT.
import {plantCbv} from './cbv-fork.mjs';import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,getAddress,decodeAbiParameters,encodeAbiParameters,encodeFunctionData,toHex,serializeTransaction} from 'viem';import {base} from 'viem/chains';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import * as P256 from 'ox/P256';
import {WALLET_ABI} from '../../src/v5/phone-signer.mjs';import {decodePolicyV5} from '../../src/v5/abi.mjs';import {hashToken,mintAgentToken} from '../../src/v4/agents.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;const GW=new URL('../../',import.meta.url).pathname;
const AD=parseAbi(['function trust() view returns (address)','function vaultAddress(address) view returns (address)']);
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);
const FACTORY='0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';const FACT=parseAbi(['function createAccount(bytes[] owners,uint256 nonce) payable returns (address)','function getAddress(bytes[] owners,uint256 nonce) view returns (address)']);
const BA_ABI=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable']);
const FEED='0xc0dedd749573f2e967a4ba53190c27ffbc2f8b31';const FEED_ABI=parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const L1='0x420000000000000000000000000000000000000F';const L1_ABI=parseAbi(['function getL1Fee(bytes) view returns (uint256)']);
test('phone approver V3: new user, Siri above old cap, phone trust above 5, V2->V3 migration',{skip:!RPC||!PJ,timeout:900000},async()=>{
  const perm=JSON.parse(PJ);const W0=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);const pol=decodePolicyV5(perm.extraData);const EXEC=getAddress(pol.executor);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});const vault0=await pub.readContract({address:A,abi:AD,functionName:'vaultAddress',args:[W0]});
  const OWNER0=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W0,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  await tc.impersonateAccount({address:EXEC});await tc.setBalance({address:EXEC,value:10n**18n});
  const whale='0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';await tc.impersonateAccount({address:whale});await tc.setBalance({address:whale,value:10n**18n});
  const bal=a=>pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[a]});
  const [,ethUsd8]=await pub.readContract({address:FEED,abi:FEED_ABI,functionName:'latestRoundData'});
  const R={fork:true,chainId:await pub.getChainId(),block:String(await pub.getBlockNumber()),ethUsd:Number(ethUsd8)/1e8,gasPriceWei:String(await pub.getGasPrice()),liveGasPriceWei:String(await createPublicClient({chain:base,transport:vh('https://mainnet.base.org')}).getGasPrice()),users:{},isolation:{},steps:[]};
  const step=(u,n,ok,d)=>{R.steps.push({user:u,step:n,ok:!!ok,...(d?{d}:{})});console.log((ok?'PASS ':'FAIL ')+u+' '+n+' '+JSON.stringify(d??'').slice(0,300));assert.ok(ok,u+' '+n+' '+JSON.stringify(d??''));};
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
  let OV,M;const {startMainnet}=await import('../../mainnet/mainnet-owner-launch.mjs?rh');const port=19100+Math.floor(Math.random()*200);
  const START=async(ver,port)=>startMainnet({fork:true,agentPort:port,ownerPort:port+1000,stateFile:SF,overrides:OV={rpc:RPC,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,gasMode:'legacy',onboard:true,userErase:true,ownerPay:true,approverVersion:ver,phoneOnChain:async()=>true,
    gasPricing:{usdcPerEth:String(Math.round(R.ethUsd*1e6)),gasPriceWei:R.liveGasPriceWei},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,publicBase:'http://fork.invalid',kvFile:join(DATA,'kv.sqlite')}});
  M=await START('v2',port);let GU=`http://127.0.0.1:${port}`;
  try{
  const call=async(path,{method='GET',body,headers={}}={})=>{const r=await fetch(GU+path,{method,headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json();}catch{}return {status:r.status,j};};
  const rpcBody=async r=>{const t=await r.text();const m=t.match(/^data: (.*)$/m);try{return JSON.parse(m?m[1]:t);}catch{return {raw:t.slice(0,200)};}};
  const mcpTool=async(pre,tok,name,args)=>{const H={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+tok};
    const i=await fetch(GU+pre+'/mcp',{method:'POST',headers:H,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'rh',version:'1'}}})});
    if(i.status!==200)return {status:i.status};const sid=i.headers.get('mcp-session-id');await rpcBody(i);const H2={...H,...(sid?{'mcp-session-id':sid}:{})};
    await fetch(GU+pre+'/mcp',{method:'POST',headers:H2,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
    const c=await fetch(GU+pre+'/mcp',{method:'POST',headers:H2,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}})});const j=await rpcBody(c);
    const text=j?.result?.content?.[0]?.text;let out;try{out=JSON.parse(text);}catch{out=text??j;}return {status:c.status,isError:!!j?.result?.isError,out};};
  const find=async k=>{const c=await call('/phone/find/challenge',{method:'POST'});return call('/phone/find',{method:'POST',body:{nonce:c.j.nonce,x:k.x,y:k.y,...sign(c.j.digest,k)}});};
  const sess=async(pre,k)=>{const c=await call(pre+'/phone/session/challenge',{method:'POST'});if(c.status!==200)return c;return call(pre+'/phone/session',{method:'POST',body:{nonce:c.j.nonce,...sign(c.j.digest,k)}});};
  R.onboardQuote=(await call('/onboard/new/quote')).j;R.inheritedStrangerCaps={openSingle:String(pol.openSingle),openDaily:String(pol.openDaily)};console.log('CAPS',JSON.stringify(R.inheritedStrangerCaps));
  const PAY=BigInt(pol.openSingle)/2n>500_000n?500_000n:BigInt(pol.openSingle)/2n;const PAYS=(Number(PAY)/1e6).toString();

  const PH_ABI=parseAbi(['function maxSingle() view returns (uint160)','function wallet() view returns (address)']);
  const TRUST_ABI=parseAbi(['function payeeTrust(address account,address payee) view returns (bytes32,uint160,uint160)']);
  const useExec=async u=>{const {createHash}=await import('node:crypto');const kf=join(DATA,'executors',createHash('sha256').update('kipurse-exec-v1:'+u.w.toLowerCase()).digest('hex').slice(0,40)+'.key');const ex=getAddress(JSON.parse(fs.readFileSync(kf)).address);
    OV.impersonateExecutor=ex;await tc.impersonateAccount({address:ex});await tc.setBalance({address:ex,value:10n**18n});};
  const usdc=n=>BigInt(Math.round(n*1e6));
  const newUser=async(name,ver)=>{const key=privateKeyToAccount(generatePrivateKey());await tc.setBalance({address:key.address,value:10n**18n});
    const owners=[encodeAbiParameters([{type:'address'}],[key.address])];const ba=getAddress(await pub.readContract({address:FACTORY,abi:FACT,functionName:'getAddress',args:[owners,0n]}));
    {const h=await createWalletClient({chain:base,transport:vh(RPC),account:key}).writeContract({address:FACTORY,abi:FACT,functionName:'createAccount',args:[owners,0n]});await pub.waitForTransactionReceipt({hash:h});}await plantCbv(RPC,ba);
    {const h=await createWalletClient({chain:base,transport:vh(RPC),account:whale}).writeContract({address:USDC,abi:ERC20,functionName:'transfer',args:[ba,200_000_000n]});await pub.waitForTransactionReceipt({hash:h});}
    const u={name,key,ba,phone:kp()};const Ru=R.users[name]={baseAccount:ba,txs:{}};
    const st=await call('/onboard/new/start',{method:'POST',body:{x:u.phone.x,y:u.phone.y,single:'5',daily:'50',term:'500',days:90}});assert.equal(st.status,200,JSON.stringify(st.j));
    const pr=await call('/onboard/new/prepare',{method:'POST',body:{id:st.j.id,owner:ba}});assert.equal(pr.status,200,JSON.stringify(pr.j));u.w=getAddress(pr.j.wallet);Ru.wallet=u.w;
    const ob=await batch(u,pr.j.calls);Ru.onboard={hash:ob.hash,gas:ob.gas,usd:ob.usd};await useExec(u);
    const cf=await call('/onboard/confirm',{method:'POST',body:{id:st.j.id}});
    step(name,'onboarding ('+ver+') = ONE tx, success, Siri on',ob.status==='success'&&cf.j?.ok===true&&cf.j.siri===true,{gas:ob.gas,usd:ob.usd.toFixed(4),calls:pr.j.calls.length});
    u.pre='/t/'+u.w.toLowerCase();await login(u);
    const dep=await batch(u,[{to:USDC,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[u.w,100_000_000n]})}]);step(name,'deposit 100 USDC',dep.status==='success');
    return u;};
  const login=async u=>{const s=await sess(u.pre,u.phone);assert.equal(s.status,200,JSON.stringify(s.j));u.H={authorization:'Bearer '+s.j.token};};
  const phoneActive=async u=>(await call(u.pre+'/phone/status',{headers:u.H})).j?.active;
  const siri=async(u,payee,amount)=>{const c=await call(u.pre+'/owner/pay/challenge',{method:'POST',headers:u.H,body:{payee,amount:String(amount),confirmNewPayee:true}});
    if(c.status!==200)return {challenge:c.status,error:c.j?.error,reasons:c.j?.reasons};
    await useExec(u);const sb=await call(u.pre+'/owner/pay/submit',{method:'POST',headers:u.H,body:{id:c.j.id,...sign(c.j.digest,u.phone)}});return {challenge:200,viaCaps:c.j.viaCaps,submit:sb.status,state:sb.j?.state,tx:sb.j?.txHash,fee:sb.j?.fee,networkFee:sb.j?.networkFee,detail:sb.j?.detail};};
  const raise=async(u,single,daily,term)=>{const pr=await call(u.pre+'/owner/limits/prepare',{method:'POST',body:{single:String(usdc(single)),daily:String(usdc(daily)),term:String(usdc(term)),days:90}});assert.equal(pr.status,200,JSON.stringify(pr.j));
    const b=await batch(u,pr.j.calls);let cf;for(let i=0;i<5&&!(cf?.j?.ok);i++)cf=await call(u.pre+'/owner/limits/confirm',{method:'POST',body:{id:pr.j.id}});return {ok:b.status==='success'&&cf.j?.ok===true,gas:b.gas,usd:b.usd};};

  // ===== A. OLD user on V2 (today's production) =====
  const old=await newUser('OLD','v2');let a0=await phoneActive(old);
  step('OLD','phone approver is V2 with frozen per-pay ceiling 5',a0?.version==='v2'&&String(await pub.readContract({address:a0.approver,abi:PH_ABI,functionName:'maxSingle'}))==='5000000',{approver:a0?.approver});
  const rz=await raise(old,20,60,500);step('OLD','raise wallet limits to 20/day 60 (one Base Account tx)',rz.ok,{gas:rz.gas,usd:rz.usd?.toFixed(4)});
  const shopA=privateKeyToAccount(generatePrivateKey()).address;const s0=await siri(old,shopA,usdc(8));
  step('OLD','V2: Siri 8 USDC to a new payee is NOT possible (frozen phone cap 5)',(await bal(shopA))===0n,s0);R.v2Siri8=s0;
  await M.close();await new Promise(r=>setTimeout(r,800));
  // ===== B. server flag flipped to V3 =====
  const port2=port+3;M=await START('v3',port2);GU=`http://127.0.0.1:${port2}`;
  await useExec(old);// fork harness: the impersonated executor must be set before the tenant engine is rebuilt
  await login(old);
  // ===== C. OLD user migrates V2 -> V3: ONE Base Account tx (add V3, remove V2), SAME phone key (no re-registration) =====
  const T=await M.tenant(old.w);const e=await T.PH.enroll({x:old.phone.x,y:old.phone.y});const pend=T.S.phone.pending[e.id];
  const mcalls=T.PH.calls(pend);const wBefore=await bal(old.w),baBefore=await bal(old.ba);const mb=await batch(old,mcalls);const mc=await T.PH.confirm(e.id);
  const a1=await phoneActive(old);const v2still=await pub.readContract({address:old.w,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[a0.approver]});
  const v3owner=await pub.readContract({address:old.w,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[a1.approver]});
  let hasMax=true;try{await pub.readContract({address:a1.approver,abi:PH_ABI,functionName:'maxSingle'});}catch{hasMax=false;}
  R.migration={hash:mb.hash,gas:mb.gas,usd:mb.usd,calls:mcalls.length,feeUSDCfromWallet:String(wBefore-await bal(old.w)),toBaseAccount:String((await bal(old.ba))-baBefore),removes:e.removes};
  step('OLD','migration V2 -> V3 in ONE tx: V3 owner, V2 removed, no ceiling, same phone key',mb.status==='success'&&mc.ok===true&&a1.version==='v3'&&v3owner&&!v2still&&!hasMax&&a1.fingerprint===a0.fingerprint&&!T.PH.retiring(),R.migration);
  // ===== D. Siri above the old phone cap, bounded by the LIVE wallet limit (20) =====
  const s1=await siri(old,shopA,usdc(8));step('OLD','V3: Siri 8 USDC (> old phone cap 5) paid, on-chain phone approval',s1.state==='paid'&&s1.viaCaps===false&&(await bal(shopA))===usdc(8),s1);R.v3Siri8=s1;
  const s2=await siri(old,shopA,usdc(25));step('OLD','V3: Siri 25 USDC (> live wallet limit 20) refused, nothing moves',(await bal(shopA))===usdc(8)&&s2.state!=='paid',s2);
  // ===== E. trusted payee approved by the phone with per-payment 15 (> old 5) =====
  const tok=mintAgentToken();T.agents.push({id:'agent-old',tokenSha256:hashToken(tok)});T.reindex();
  const shopB=privateKeyToAccount(generatePrivateKey()).address;const rq=await mcpTool(old.pre,tok,'kipurse_request_trust',{payee:shopB,merchantName:'V3 Rehearsal Shop',reason:'v3 rehearsal shop',perPaymentCap:'15.0',totalCap:'40.0'});
  const rid=(JSON.stringify(rq.out).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)??[])[0];assert.ok(rid,JSON.stringify(rq.out).slice(0,400));
  await useExec(old);const pp=await call(old.pre+'/approve/trust/phone-prepare',{method:'POST',body:{id:rid}});assert.equal(pp.status,200,JSON.stringify(pp.j));
  const ps=await call(old.pre+'/approve/trust/phone-sign',{method:'POST',body:{id:rid,...sign(await pub.readContract({address:old.w,abi:parseAbi(['function replaySafeHash(bytes32) view returns (bytes32)']),functionName:'replaySafeHash',args:[pp.j.digest]}),old.phone)}});
  let tr=[0];for(let i=0;i<10&&BigInt(tr[1]??0)===0n;i++){tr=await pub.readContract({address:trust,abi:TRUST_ABI,functionName:'payeeTrust',args:[old.w,shopB]});if(BigInt(tr[1])===0n)await new Promise(r=>setTimeout(r,500));}
  step('OLD','phone (V3) approves trusted payee with per-payment 15 / day 40',ps.status===200&&String(tr[1])==='15000000',{status:ps.status,tx:ps.j?.txHash,error:ps.j?.error,single:String(tr[1]),daily:String(tr[2])});
  const p12=await mcpTool(old.pre,tok,'kipurse_pay',{to:shopB,amount:'12',merchant:'v3shop',orderRef:'v3-12'});
  step('OLD','AI pays trusted payee 12 USDC (> old 5, <= trust 15, <= live 20)',(await bal(shopB))===usdc(12),{state:p12.out?.state,tx:p12.out?.txHash});
  const p16=await mcpTool(old.pre,tok,'kipurse_pay',{to:shopB,amount:'16',merchant:'v3shop',orderRef:'v3-16'});
  step('OLD','AI 16 USDC to trusted payee refused (> trust 15)',(await bal(shopB))===usdc(12),{state:p16.out?.state??p16.out?.error});
  // ===== F. brand-new user with the flag on: V3 in the single onboarding tx =====
  const nu=await newUser('NEW','v3');const an=await phoneActive(nu);let nMax=true;try{await pub.readContract({address:an.approver,abi:PH_ABI,functionName:'maxSingle'});}catch{nMax=false;}
  step('NEW','phone approver is V3 (no ceiling), bound to his wallet',an.version==='v3'&&!nMax&&getAddress(await pub.readContract({address:an.approver,abi:PH_ABI,functionName:'wallet'}))===nu.w,{approver:an.approver});
  const rn=await raise(nu,50,200,1000);step('NEW','raise limits to 50/day 200 (no re-bind, no phone fee)',rn.ok,{gas:rn.gas,usd:rn.usd?.toFixed(4)});
  const shopC=privateKeyToAccount(generatePrivateKey()).address;const s3=await siri(nu,shopC,usdc(30));
  step('NEW','Siri 30 USDC right after raising limits',s3.state==='paid'&&(await bal(shopC))===usdc(30),s3);
  R.ok=true;fs.writeFileSync(process.env.REPORT??'/tmp/v3-report.json',JSON.stringify(R,(k,v)=>typeof v==='bigint'?v.toString():v,1));
  console.log('REPORT',JSON.stringify({users:R.users,migration:R.migration,v2Siri8:R.v2Siri8,v3Siri8:R.v3Siri8}));
  }catch(e){console.log('ERR',String(e.stack??e).slice(0,1500));throw e;}finally{await M.close().catch(()=>{});setTimeout(()=>process.exit(0),500).unref?.();}});
