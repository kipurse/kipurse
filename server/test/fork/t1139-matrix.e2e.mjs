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
const FEED='0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';const FEED_ABI=parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const L1='0x420000000000000000000000000000000000000F';const L1_ABI=parseAbi(['function getL1Fee(bytes) view returns (uint256)']);
test('t1138 matrix: phone approver V3: new user, Siri above old cap, phone trust above 5, V2->V3 migration',{skip:!RPC||!PJ,timeout:900000},async()=>{
  const perm=JSON.parse(PJ);const W0=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);const pol=decodePolicyV5(perm.extraData);const EXEC=getAddress(pol.executor);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});const vault0=await pub.readContract({address:A,abi:AD,functionName:'vaultAddress',args:[W0]});
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
  let OV,M;const {startMainnet}=await import('../../mainnet/mainnet-owner-launch.mjs?rh');const port=19100+Math.floor(Math.random()*200);
  const START=async(ver,port)=>startMainnet({fork:true,agentPort:port,ownerPort:port+1000,stateFile:SF,overrides:OV={rpc:RPC,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,gasMode:'legacy',onboard:true,userErase:true,ownerPay:true,phoneOnChain:async()=>true,
    gasPricing:{usdcPerEth:String(Math.round(R.ethUsd*1e6)),gasPriceWei:R.liveGasPriceWei},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,publicBase:'http://fork.invalid',kvFile:join(DATA,'kv.sqlite')}});
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
  await tryStep('U1','deposit',async()=>{const before=await bal(U1.w);const dep=await batch(U1,[{to:USDC,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[U1.w,30_000_000n]})}]);
    const stt=await freshState(U1);/* the server ledger rescans at most every 30 s */fx('U1.stateAfterDeposit',stt);
    step('U1','deposit 30 USDC lands; state balance = chain balance',dep.status==='success'&&String(stt?.balance)===String(await bal(U1.w)),{tx:dep.hash,stateBalance:stt?.balance,chain:String(await bal(U1.w)),before:String(before)});
    const led=(await call(U1.pre+'/phone/session/ledger',{headers:U1.H}));fx('U1.ledgerAfterDeposit',{status:led.status,res:led.j});});
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
    const IP=parseAbi(['function isPaused(address) view returns (bool)']);const chainPaused=()=>pub.readContract({address:trust,abi:IP,functionName:'isPaused',args:[U2.w]});
    const {checkResumeCalls,RESUME_FEE_TO}=await import('../../src/v5/resume-onchain.mjs');
    const {c,r}=await faceIdResume();fx('U2.safetyResume',{challenge:{status:c.status,res:c.j},resume:{status:r.status,res:r.j},wallet:U2.w,owner:U2.ba,trust});
    step('U2','resume: Face ID challenge (428) then 202 confirm_on_chain plan (chain still paused -> NOT reported resumed)',c.status===428&&r.status===202&&r.j?.state==='confirm_on_chain'&&!!r.j?.id,{challenge:c.status,status:r.status,keys:Object.keys(r.j??{}),fee:r.j?.fee,err:r.j?.error});
    if(r.status!==202)return;const pl=r.j;
    const F=checkResumeCalls(pl.calls,{wallet:U2.w,trust,feeTo:RESUME_FEE_TO});
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
  // ===================== REVOKE CONNECTION (app: AllowancesView stop agent) =====================
  if(tok)await tryStep('U2','revoke connection',async()=>{
    const m=await call(U2.pre+'/safety/mandates',{headers:U2.H});fx('U2.mandates',{status:m.status,res:m.j});
    const ag=(m.j?.agents??[]).find(a=>a.id!=='siri');step('U2','connected AI listed for the owner',!!ag,{agents:m.j?.agents});if(!ag)return;
    const r=await call(U2.pre+'/safety/agents/stop',{method:'POST',headers:U2.H,body:{agentId:ag.id}});fx('U2.agentStop',{status:r.status,res:r.j});
    const b1=await bal(shopA);const p=await aiPay('1','m-6');step('U2','after stopping the AI, its pay is refused',r.status===200&&(await bal(shopA))===b1,{stop:r.j,out:p.out});
    const stt=await state(U2);fx('U2.stateFinal',stt);});
  const f1=await state(U1);fx('U1.stateFinal',f1);
  // ===================== OFFLINE RESCUE (app: ChainRescue.balances -> ChainRescue.plan -> Coinbase confirm of wallet.executeBatch) =====================
  await tryStep('U1','offline rescue',async()=>{
    const RA=parseAbi(['function vaultAddress(address) view returns (address)','function floatAddress(address) view returns (address)']);const VA=parseAbi(['function reserved() view returns (uint256)']);
    const wB=await bal(U1.w);let vault=null,vB=0n,vR=0n,flt=null,fB=0n;
    try{vault=getAddress(await pub.readContract({address:A,abi:RA,functionName:'vaultAddress',args:[U1.w]}));if(/^0x0+$/.test(vault))vault=null;}catch{vault=null;}
    if(vault){vB=await bal(vault);vR=await pub.readContract({address:vault,abi:VA,functionName:'reserved'}).catch(()=>0n);}
    try{flt=getAddress(await pub.readContract({address:A,abi:RA,functionName:'floatAddress',args:[U1.w]}));const code=await pub.getCode({address:flt});if(!code||code==='0x')flt=null;else fB=await bal(flt);}catch{flt=null;}
    const inp={wallet:U1.w,owner:U1.ba,adapter:A,usdc:USDC,b:{wallet:String(wB),vault:String(vB),vaultReserved:String(vR),float:String(fB),vaultAddress:vault,floatAddress:flt}};
    fs.writeFileSync('/workspace/t1139/rescue-in.json',JSON.stringify(inp,null,1));fx('U1.rescueIn',inp);console.log('RESCUE_IN_WRITTEN');
    let out=null;for(let i=0;i<300&&!out;i++){try{out=JSON.parse(fs.readFileSync('/workspace/t1139/rescue-out.json','utf8'));}catch{await new Promise(r=>setTimeout(r,2000));}}
    step('U1','app ChainRescue.plan produced a call',!!out?.call,{out});if(!out?.call)return;
    const ob=await bal(U1.ba);const b=await batch(U1,[{to:out.call.to,data:out.call.data}]);
    const got=(await bal(U1.ba))-ob;
    step('U1','offline rescue: ONE owner tx, everything to the owner, wallet empty, no Kipurse server involved',b.status==='success'&&got===BigInt(out.amount)&&(await bal(U1.w))===0n,{tx:b.hash,got:String(got),planned:out.amount,walletLeft:String(await bal(U1.w))});
    const stt=await state(U1);fx('U1.stateAfterRescue',stt);});


  R.ok=true;
  }catch(e){console.log('ERR',String(e.stack??e).slice(0,1500));}finally{fs.writeFileSync('/workspace/t1139/fixtures.json',JSON.stringify(FX,null,1));fs.writeFileSync(process.env.REPORT??'/workspace/t1139/matrix-report.json',JSON.stringify(R,(k,v)=>typeof v==='bigint'?v.toString():v,1));await M.close().catch(()=>{});setTimeout(()=>process.exit(0),500).unref?.();}});
