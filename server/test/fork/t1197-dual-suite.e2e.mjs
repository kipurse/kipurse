// FORK-ONLY dual-suite rehearsal (t1197u, handbook §6#92). Private anvil fork of Base mainnet AFTER the owner's real V5.3 deploy, one-off keys,
// never broadcasts, no real money. Gateway = this release with the PRODUCTION shape of config: the operator wallet is a V5.2 wallet (like 0x5150),
// config adapter/trust = V5.2. Proves: D the real mainnet V5.3 suite is used as deployed (no redeploy); E an existing V5.2 user stays on V5.2
// untouched and still pays; G a brand-new user opens on V5.3 automatically (seed 0.15, 500 ops/day), ask_owner, trust auto-pay, ops cap calm +
// raise, X cancel-replay refused (ApprovalUsed), W withdraw everything.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,getAddress,decodeAbiParameters,encodeAbiParameters,encodeFunctionData,toHex,keccak256} from 'viem';import {base} from 'viem/chains';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import * as P256 from 'ox/P256';
import {WALLET_ABI,approverInit} from '../../src/v5/phone-signer.mjs';import {decodePolicyV5,permissionToJson,v5Abi} from '../../src/v5/abi.mjs';import {hashToken,mintAgentToken} from '../../src/v4/agents.mjs';
import {buildMigrationPlanV5} from '../../src/v5/plan.mjs';import {loadOrCreateSessionKey,createUserOpWriter,opsToday} from '../../src/v5/userop.mjs';import {phonePayWrapper} from '../../src/v5/owner-pay.mjs';
import {v53Suite} from '../../mainnet/v53-deploy.mjs';import {plantCbv} from './cbv-fork.mjs';import {startBundlerShim} from './bundler-shim.mjs';
const RPC=process.env.FORK_RPC,OUTD=process.env.V53_OUT??'/workspace/t1185/contracts/out';const GW=new URL('../../',import.meta.url).pathname;
const OLD_ADAPTER='0x05320BeD08309F66316F7d73e2D0be110400FbB2',USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',SPM='0xf85210B21cC50302F477BA56686d2019dC9b67Ad',PM07='0x6C973eBe80dCD8660841D4356bf15c32460271C9';
const AD=parseAbi(['function trust() view returns (address)','function vaultAddress(address) view returns (address)','function vaultFactory() view returns (address)','function fees() view returns (address)',
  'function approvalDigest(address account,bytes32 purchaseKey,address payee,uint256 amount,uint256 deadline) view returns (bytes32)','function purchaseKey(address payee,bytes32 merchantRef,bytes32 repeatKey) view returns (bytes32)',
  'function approvalUsed(bytes32) view returns (bool)','function cancelReservation(bytes32 digest)','event AuthorizationPrepared(bytes32 indexed purchaseKey,address indexed account,address indexed vault,bytes32 digest,address to,uint256 value,uint256 fee,uint256 validAfter,uint256 validBefore)']);
const VA=parseAbi(['function opsPerDay() view returns (uint256)','function sweep() returns (uint256)','function paymaster() view returns (address)','function sessionSigner() view returns (address)','function account() view returns (address)','function unreserved() view returns (uint256)']);
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);
const SPMA=parseAbi(['function isValid((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData) p) view returns (bool)','function isRevoked((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData) p) view returns (bool)']);
const FACTORY='0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';const FACT=parseAbi(['function createAccount(bytes[] owners,uint256 nonce) payable returns (address)','function getAddress(bytes[] owners,uint256 nonce) view returns (address)']);
const BA_ABI=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable']);
const APPR=parseAbi(['function trust() view returns (address)','function wallet() view returns (address)']);
const DAY=86400;
test('t1197 dual-suite rehearsal: V5.2 user untouched + pays, new user on V5.3 end to end (userop), ops cap calm + raise, x402 cancel-replay, withdraw',{skip:!RPC,timeout:1500000},async()=>{
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  const R={fork:true,block:String(await pub.getBlockNumber()),steps:[],gas:{},addresses:{}};let fails=0;
  const step=(u,n,ok,d)=>{R.steps.push({user:u,step:n,ok:!!ok,...(d?{d}:{})});console.log((ok?'PASS ':'FAIL ')+u+' '+n+' '+JSON.stringify(d??'',(k,v)=>typeof v==='bigint'?v.toString():v).slice(0,400));if(!ok)fails++;};
  const whale='0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';await tc.impersonateAccount({address:whale});await tc.setBalance({address:whale,value:10n**18n});
  const fund=async(to,amt)=>{const h=await createWalletClient({chain:base,transport:vh(RPC),account:whale}).writeContract({address:USDC,abi:ERC20,functionName:'transfer',args:[to,amt]});await pub.waitForTransactionReceipt({hash:h});};
  const bal=a=>pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[a]});
  const kp=()=>{const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});return {privateKey,x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};};
  const sign=(d,k)=>{const s=P256.sign({payload:d,privateKey:k.privateKey});return {r:toHex(s.r,{size:32}),s:toHex(s.s,{size:32})};};
  const batch=async(u,calls,label)=>{const data=encodeFunctionData({abi:BA_ABI,functionName:'executeBatch',args:[calls.map(c=>({target:getAddress(c.to),value:BigInt(c.value??0),data:c.data}))]});
    const h=await createWalletClient({chain:base,transport:vh(RPC),account:u.key}).sendTransaction({to:u.ba,data,gas:12_000_000n});const r=await pub.waitForTransactionReceipt({hash:h});if(label)R.gas[label]=String(r.gasUsed);
    if(r.status!=='success'){for(const [i,c] of calls.entries()){try{await pub.call({account:u.ba,to:getAddress(c.to),data:c.data,blockNumber:r.blockNumber-1n});}catch(e){console.log('BATCH_REVERT call',i,c.to,String(e.shortMessage??e.message).slice(0,300),String(e.cause?.data??e.data??'').slice(0,80));}}}
    return {hash:h,status:r.status,gas:r.gasUsed};};
  const inW=(w,calls)=>({to:w,value:0n,data:encodeFunctionData({abi:v5Abi,functionName:'executeBatch',args:[calls.map(c=>({target:getAddress(c.to),value:BigInt(c.value??0),data:c.data}))]})});
  const newPerson=async()=>{const key=privateKeyToAccount(generatePrivateKey());await tc.setBalance({address:key.address,value:10n**18n});
    const owners=[encodeAbiParameters([{type:'address'}],[key.address])];const ba=getAddress(await pub.readContract({address:FACTORY,abi:FACT,functionName:'getAddress',args:[owners,0n]}));
    const h=await createWalletClient({chain:base,transport:vh(RPC),account:key}).writeContract({address:FACTORY,abi:FACT,functionName:'createAccount',args:[owners,0n]});await pub.waitForTransactionReceipt({hash:h});
    await fund(ba,30_000_000n);await plantCbv(RPC,ba);return {key,ba,phone:kp()};};
  const ownersOf=async w=>{const n=Number(await pub.readContract({address:w,abi:WALLET_ABI,functionName:'nextOwnerIndex'}));const o=[];for(let i=0;i<n;i++){const b=await pub.readContract({address:w,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[BigInt(i)]});if(b&&b!=='0x')o.push({i,bytes:b,addr:b.length===66?getAddress(decodeAbiParameters([{type:'address'}],b)[0]):null});}return o;};
  // ======================= D: deploy the V5.3 suite exactly as on mainnet (deterministic deployer, same EntryPoint / paymaster / fee controller)
  const S=v53Suite({out:OUTD});const dep=privateKeyToAccount(generatePrivateKey());await tc.setBalance({address:dep.address,value:10n**18n});
  const SJ=JSON.parse(fs.readFileSync(GW+'mainnet/v53-suite.json','utf8'));
  for(const s of S.steps){const c=await pub.getCode({address:s.address});step('D','already on Base mainnet (owner deploy 2026-11-18), not redeployed: '+s.label,!!c&&c.length>2,{address:s.address});}
  step('D','v53-suite.json = the deployed suite (factory, adapter, trust)',getAddress(SJ.factory)===S.factory&&getAddress(SJ.adapter)===S.adapter&&getAddress(SJ.trust)===S.trust);
  const A=S.adapter,TR=getAddress(await pub.readContract({address:A,abi:AD,functionName:'trust'}));R.addresses={factory:S.factory,adapter:A,trust:TR};
  step('D','adapter wiring: trust = predicted, factory = new, fee controller = live, paymaster = Circle v0.7',TR===S.trust&&getAddress(await pub.readContract({address:A,abi:AD,functionName:'vaultFactory'}))===S.factory&&getAddress(await pub.readContract({address:A,abi:AD,functionName:'fees'}))===getAddress(await pub.readContract({address:OLD_ADAPTER,abi:AD,functionName:'fees'}))&&getAddress(await pub.readContract({address:S.factory,abi:parseAbi(['function paymaster() view returns (address)']),functionName:'paymaster'}))===PM07,R.addresses);
  // ======================= M: an existing V5.2 user migrates
  const dir=mkdtempSync(join(tmpdir(),'v53-'));const CONF=join(dir,'conf'),DATA=join(dir,'data');fs.mkdirSync(CONF);fs.mkdirSync(DATA);
  const SESSF=join(DATA,'session.json');const sess0=loadOrCreateSessionKey(SESSF);
  const U0=await newPerson();const W0=getAddress(await pub.readContract({address:FACTORY,abi:FACT,functionName:'getAddress',args:[[encodeAbiParameters([{type:'address'}],[U0.ba])],0n]}));U0.w=W0;
  const oldTrust=getAddress(await pub.readContract({address:OLD_ADAPTER,abi:AD,functionName:'trust'}));const oldVault=getAddress(await pub.readContract({address:OLD_ADAPTER,abi:AD,functionName:'vaultAddress',args:[W0]}));
  const now0=Number((await pub.getBlock()).timestamp);
  const planArgs=(adapter,trust,vault,extra)=>({chainId:8453,wallet:W0,owner:U0.ba,adapter,trust,token:USDC,manager:SPM,executor:sess0.address,headroom:false,maxFeePpm:'1000',maxNetworkFee:'50000',fee:{ppm:'1000'},
    stated:{single:'5000000',daily:'10000000',term:'50000000',openSingle:'100000',openDaily:'1000000',verifiedSingle:'0',verifiedDaily:'0'},start:now0-30,end:now0+60*DAY,zeroReserve:{vault,buffer:300000},...extra});
  const oldPl=buildMigrationPlanV5(planArgs(OLD_ADAPTER,oldTrust,oldVault,{salt:1n,trusts:[{merchantId:'old-shop',payees:['0x00000000000000000000000000000000000c0ffe'],single:'1000000',daily:'2000000',days:30}]}));
  const oldAp=approverInit({wallet:W0,trust:oldTrust,x:U0.phone.x,y:U0.phone.y,version:'v3'});
  {const b=await batch(U0,[{to:FACTORY,data:encodeFunctionData({abi:FACT,functionName:'createAccount',args:[[encodeAbiParameters([{type:'address'}],[U0.ba])],0n]})},{to:oldAp.address.length?'0x4e59b44847b379578588920cA78FbF26c0B4956C':'',data:oldAp.deployData},
      {to:W0,data:encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[SPM]})},{to:USDC,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[W0,8_300_000n]})},
      {to:W0,data:oldPl.walletExecuteBatch.data},{to:W0,data:encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[oldAp.address]})}]);
   step('E','setup: an existing V5.2 user on the LIVE adapter (permission, old vault with 0.30 USDC, phone approver bound to the live trust, 8 USDC in the wallet)',b.status==='success'&&await bal(oldVault)===300000n&&await bal(W0)===8_000_000n,{wallet:W0,oldVault,status:b.status,hash:b.hash,v:await bal(oldVault),w:await bal(W0),code:(await pub.getCode({address:W0}))?.length});if(b.status!=='success')throw Error('setup failed');}
  const oldPerm=JSON.parse(JSON.stringify(oldPl.permission));
  const v53Of0=getAddress(await pub.readContract({address:A,abi:AD,functionName:'vaultAddress',args:[W0]}));
  // ======================= G: gateway on the V5.3 suite, gasMode userop (production), local bundler shim -> real EntryPoint + Circle paymaster
  const B=await startBundlerShim({rpc:RPC,log:m=>console.log('BUNDLER',m)});
  fs.writeFileSync(join(CONF,'agents.json'),JSON.stringify([{id:'legacy',tokenSha256:hashToken(mintAgentToken())}]));
  fs.writeFileSync(join(CONF,'mainnet-trustflow.config.json'),JSON.stringify({chainId:8453,wallet:W0,ownerBaseAccount:U0.ba,token:USDC,adapter:OLD_ADAPTER,trust:oldTrust,vault:oldVault,manager:SPM,
    currentPermission:oldPerm,newCaps:{single:'5000000'},engine:{chainId:8453,rpc:RPC,adapter:OLD_ADAPTER,trust:oldTrust,token:USDC,manager:SPM,ownerSigner:{wallet:W0,ownerIndex:0},sessionKeyFile:SESSF,
      ownerRulesDir:join(DATA,'owner-rules'),ledgerFile:join(DATA,'ledger.sqlite')}}));
  const SF=join(DATA,'runtime-state.json');fs.writeFileSync(SF,JSON.stringify({permission:oldPerm}));
  /* KYC on: real CBV check against the fork (planted attestations, cbv-fork.mjs) */process.env.KIPURSE_CBV_RPCS=RPC;delete process.env.KIPURSE_REQUIRE_CBV;process.env.KIPURSE_PHONE_APPROVER='v3';process.env.KIPURSE_ONBOARD_PAYMASTER_URL='https://pm.fork.invalid/rpc';process.env.KIPURSE_GATEWAY=GW;process.env.KIPURSE_MAIN_CONFIG_DIR=CONF;process.env.KIPURSE_MAIN_DATA_DIR=DATA;
  const {startMainnet}=await import('../../mainnet/mainnet-owner-launch.mjs?t1197');const port=19400+Math.floor(Math.random()*200);
  const ethUsd=3000;
  let M;try{M=await startMainnet({fork:true,agentPort:port,ownerPort:port+1000,stateFile:SF,overrides:{rpc:RPC,gasMode:'userop',bundler:{url:B.url},paymaster:PM07,userOp:{midnightGuardS:20},onboard:true,userErase:true,ownerPay:true,phoneOnChain:async()=>true,
    fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,publicBase:'http://fork.invalid',kvFile:join(DATA,'kv.sqlite')}});}catch(e){await B.close();console.log('ERR start',String(e.stack??e).slice(0,800));setTimeout(()=>process.exit(1),300);throw e;}
  const GU=`http://127.0.0.1:${port}`;
  try{
  const call=async(path,{method='GET',body,headers={}}={})=>{const r=await fetch(GU+path,{method,headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json();}catch{}return {status:r.status,j};};
  const rpcBody=async r=>{const t=await r.text();const m=t.match(/^data: (.*)$/m);try{return JSON.parse(m?m[1]:t);}catch{return {raw:t.slice(0,200)};}};
  const mcpTool=async(pre,tok,name,args)=>{const H={'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+tok};
    const i=await fetch(GU+pre+'/mcp',{method:'POST',headers:H,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'v53',version:'1'}}})});
    if(i.status!==200)return {status:i.status};const sid=i.headers.get('mcp-session-id');await rpcBody(i);const H2={...H,...(sid?{'mcp-session-id':sid}:{})};
    await fetch(GU+pre+'/mcp',{method:'POST',headers:H2,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
    const c=await fetch(GU+pre+'/mcp',{method:'POST',headers:H2,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}})});const j=await rpcBody(c);
    const text=j?.result?.content?.[0]?.text;let out;try{out=JSON.parse(text);}catch{out=text??j;}return {status:c.status,isError:!!j?.result?.isError,out};};
  const find=async k=>{const c=await call('/phone/find/challenge',{method:'POST'});return call('/phone/find',{method:'POST',body:{nonce:c.j.nonce,x:k.x,y:k.y,...sign(c.j.digest,k)}});};
  const sess=async(pre,k)=>{const c=await call(pre+'/phone/session/challenge',{method:'POST'});if(c.status!==200)return c;return call(pre+'/phone/session',{method:'POST',body:{nonce:c.j.nonce,...sign(c.j.digest,k)}});};
  // ---- new user U1: one-batch opening on the V5.3 suite
  const u=await newPerson();u.name='U1';
  const st=await call('/onboard/new/start',{method:'POST',body:{x:u.phone.x,y:u.phone.y,single:'5',daily:'10',term:'50',days:30}});assert.equal(st.status,200,JSON.stringify(st.j));
  const pr=await call('/onboard/new/prepare',{method:'POST',body:{id:st.j.id,owner:u.ba}});assert.equal(pr.status,200,JSON.stringify(pr.j));u.w=getAddress(pr.j.wallet);
  const ob=await batch(u,pr.j.calls,'openingBatch');step('U1','open wallet: ONE batch from his Base Account (wallet, SpendPermission on the V5.3 adapter, vault registered, phone approver bound to the V5.3 trust)',ob.status==='success',{wallet:u.w,calls:pr.j.calls.length,gas:ob.gas});
  const cf=await call('/onboard/confirm',{method:'POST',body:{id:st.j.id}});step('U1','confirm: caps + phone approver on chain',cf.j?.ok===true,cf.j);
  u.vault=getAddress(await pub.readContract({address:A,abi:AD,functionName:'vaultAddress',args:[u.w]}));
  {const rec=M.registry.get(u.w);step('U1','§6#92 the NEW wallet is recorded on V5.3 (registry suite + adapter 0xb150… + trust 0xDa1d…), the server vault is its V5.3 vault',rec?.suite==='v5.3'&&getAddress(rec.adapter)===A&&getAddress(rec.trust)===TR&&getAddress(pr.j.vault)===u.vault,{suite:rec?.suite,vault:pr.j.vault});
   const r0=M.registry.get(W0);step('E','§6#92 the existing wallet record is unchanged (no suite -> V5.2)',!!r0&&r0.suite===undefined&&r0.adapter===undefined,{keys:Object.keys(r0??{})});}
  step('U1','opening put 0.15 USDC of his own money (from his Base Account) into his vault = fee reserve (§6#86)',await bal(u.vault)===150000n&&pr.j.calls.length>0,{vaultUSDC:String(await bal(u.vault)),lastCall:pr.j.calls.at(-1)?.to});
  step('U1','his vault is a V5.3 vault (default 500 ops/day) on the new factory',BigInt(await pub.readContract({address:u.vault,abi:VA,functionName:'opsPerDay'}))===500n,{vault:u.vault});
  {const ow=await ownersOf(u.w);const ap=ow.find(o=>o.addr&&o.addr!==u.ba&&o.addr!==getAddress(SPM));step('U1','phone approver bound to the V5.3 trust',!!ap&&getAddress(await pub.readContract({address:ap.addr,abi:APPR,functionName:'trust'}))===TR,{approver:ap?.addr});u.approverIdx=ap?.i;}
  const f=await find(u.phone);step('U1','app finds the wallet by the phone key',f.status===200&&getAddress(f.j.wallet)===u.w);
  u.pre='/t/'+u.w.toLowerCase();const s=await sess(u.pre,u.phone);u.H={authorization:'Bearer '+s.j?.token};step('U1','phone session',s.status===200);
  {const d=await batch(u,[{to:USDC,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[u.w,20_000_000n]})}]);step('U1','deposit 20 USDC',d.status==='success'&&await bal(u.w)===20_000_000n);}
  const T=await M.tenant(u.w);u.tok=mintAgentToken();T.agents.push({id:'agent-U1',tokenSha256:hashToken(u.tok)});T.reindex();
  {const ev=await call(u.pre+'/everyday',{method:'POST',headers:u.H,body:{single:'2000000',daily:'4000000',term:'20000000'}});step('U1','owner sets the AI everyday limits in the app (2 / 4 / 20 USDC)',ev.status===200,{status:ev.status,err:ev.j?.error});}
  {const st2=await call(u.pre+'/phone/session/state',{headers:u.H});R.stateOps=st2.j?.ops??st2.j?.wallet?.ops??null;step('U1','app state shows the daily operations (cap 500, used, left, reset time)',JSON.stringify(st2.j??{}).includes('perDayCount'),{ops:R.stateOps});}
  const buy=(args)=>mcpTool(u.pre,u.tok,'kipurse_buy',{purpose:'daily',merchant:'V53 Desk',item:'desk lamp',user_request:'buy the lamp',...args});
  const rsh=d=>pub.readContract({address:u.w,abi:parseAbi(['function replaySafeHash(bytes32 hash) view returns (bytes32)']),functionName:'replaySafeHash',args:[d]});
  const approveAsk=async(id,mode)=>{const p=await call(u.pre+'/safety/mandates/ask-prepare',{method:'POST',headers:u.H,body:{id,mode}});if(p.status!==200)return {prep:p};
    const body={id,mode,...sign(p.j.sign.digest,u.phone),pay:sign(p.j.pay.digest,u.phone),...(p.j.trust?{trust:sign(await rsh(p.j.trust.digest),u.phone)}:{})};return {prep:p,ap:await call(u.pre+'/safety/mandates/approve',{method:'POST',headers:u.H,body})};};
  // ---- AI payment to a NEW payee -> ask_owner -> owner Face ID (trust) -> server pays once through a userOp (vault = sender, Circle paymaster)
  let X=privateKeyToAccount(generatePrivateKey()).address;const tag=Date.now().toString(36);
  const a1=await buy({to:X,amount:'1',idempotencyKey:'v53-ask-'+tag});R.ask=a1.out;
  step('U1','new payee -> ask_owner, nothing paid',a1.out?.decision==='ask_owner'&&a1.out?.nothingPaid===true&&await bal(X)===0n,{decision:a1.out?.decision,state:a1.out?.state,reason:a1.out?.reason});
  if(a1.out?.approvalId){const n0=B.sent.length;const t=await approveAsk(a1.out.approvalId,'trust');R.askApprove=t.ap?.j??t.prep?.j;if(t.ap?.status===200){const t0=Date.now();for(;;){const x=((await call(u.pre+'/safety/mandates',{headers:u.H})).j?.askTrust??[]).find(z=>z.id===a1.out.approvalId);R.askTrustFinal=x?.trust??null;if((x&&x.trust?.state!=='submitting')||Date.now()-t0>90000)break;await new Promise(z=>setTimeout(z,250));}}/* t1243 §6#113: trust lands after the paid reply */
    step('U1','FIRST AI payment of the new wallet: owner approves (认识并信任, Face ID) -> paid once via userOp from the seeded vault, payee trusted on the V5.3 trust',t.ap?.status===200&&t.ap?.j?.state==='paid'&&await bal(X)===1_000_000n&&B.sent.length>n0&&B.sent.slice(n0).every(x=>x.success),{status:t.ap?.status,state:t.ap?.j?.state,trust:t.ap?.j?.trust?.state,ops:B.sent.length-n0,err:t.prep?.j?.error??t.ap?.j?.error});}
  const pay=async(amt,k)=>{const b0=await bal(X);const r=await buy({to:X,amount:amt,idempotencyKey:k});return {r,paid:(await bal(X))-b0};};
  {const p=await pay('0.5','v53-p1-'+tag);step('U1','trusted payee: AI pays 0.5 USDC automatically (userOp)',p.paid===500000n,{state:p.r.out?.state,reason:p.r.out?.reason});}
  // ---- daily operations cap: owner lowers it (App limits screen -> Coinbase batch), reaches it -> calm refusal -> raises -> paid
  const today=async()=>opsToday({pub,vault:u.vault});
  const setOps=async(n,label)=>{const pol=decodePolicyV5(T.S.permission.extraData);const body={single:String(pol.single),daily:String(pol.daily),term:String(pol.term),opsPerDay:n};/* atomic USDC, as the App sends */
    const p=await call(u.pre+'/owner/limits/prepare',{method:'POST',body});if(p.status!==200)return {p};const b=await batch(u,p.j.calls,label);
    let c;for(let i=0;i<5&&!(c?.j?.ok);i++){c=await call(u.pre+'/owner/limits/confirm',{method:'POST',body:{id:p.j.id}});if(!c.j?.ok)await new Promise(r=>setTimeout(r,500));}return {p,b,c};};
  const t0=await today();const low=Number(t0.used)+1;
  {const x=await setOps(low,'opsCapLower');R.limitsPlanLabels=x.p?.j?.labels;step('U1',`owner lowers daily operations to ${low} (used today ${t0.used}) in ONE Coinbase-confirmed batch`,x.b?.status==='success'&&x.c?.j?.ok===true&&BigInt(await pub.readContract({address:u.vault,abi:VA,functionName:'opsPerDay'}))===BigInt(low),{prep:x.p?.status,err:x.p?.j?.error,label:(x.p?.j?.labels??[]).find(l=>/operations/.test(l)),confirm:x.c?.j?.ok});}
  {const p=await pay('0.25','v53-p2-'+tag);step('U1','one more AI payment fits (last op of the day)',p.paid===250000n,{state:p.r.out?.state,reason:p.r.out?.reason});}
  {const n0=B.sent.length;const p=await pay('0.25','v53-p3-'+tag);R.calm=p.r.out;const o=p.r.out??{};
   step('U1','cap reached -> calm refusal: DAILY_OPERATIONS_USED_UP, nothing paid, retryable, reset 00:00 UTC, owner can raise; nothing sent',o.reason==='DAILY_OPERATIONS_USED_UP'&&o.nothingPaid===true&&o.retryable===true&&p.paid===0n&&B.sent.length===n0&&/UTC 0 点会自动恢复/.test(o.say_to_user??'')&&/钱包安全底线/.test(o.say_to_user??''),{reason:o.reason,state:o.state,say:String(o.say_to_user??'').slice(0,160)});
   step('U1','calm wording: no error words (失败/错误/危险/被盗/攻击), no red',!/失败|错误|危险|被盗|攻击/.test(o.say_to_user??'')&&!/error|fail|danger/i.test(String(o.say_to_user??'').split(' / ')[1]??''));}
  {const t=await today();R.opsAtCap={cap:String(t.cap),used:String(t.used),left:String(t.left)};step('U1','vault counter: used = cap, left 0',t.used===t.cap&&t.left===0n,R.opsAtCap);}
  {const x=await setOps(500,'opsCapRaise');step('U1','owner raises it back to 500 (Coinbase batch is NOT blocked by the cap: it is the Base Account\'s own tx)',x.b?.status==='success'&&x.c?.j?.ok===true&&BigInt(await pub.readContract({address:u.vault,abi:VA,functionName:'opsPerDay'}))===500n,{err:x.p?.j?.error,prep:x.p?.status,b:x.b?.status,c:x.c?.j});}
  {const p=await pay('0.25','v53-p3b-'+tag);step('U1','after the raise: the same order with a NEW idempotency key is paid once',p.paid===250000n,{state:p.r.out?.state,reason:p.r.out?.reason});}
  // ======================= X: x402 owner approval, cancel, replay by the server -> refused on chain (V5.3 approvalUsed)
  {const {createHash}=await import('node:crypto');const kf=join(DATA,'executors',createHash('sha256').update('kipurse-exec-v1:'+u.w.toLowerCase()).digest('hex').slice(0,40)+'.key');
   const ex=privateKeyToAccount(JSON.parse(fs.readFileSync(kf,'utf8')).key);
   const perm=(await import('../../src/v5/abi.mjs')).permissionFromJson(T.S.permission);const pol=decodePolicyV5(perm.extraData);
   const wr=createUserOpWriter({cfg:{chainId:8453,token:USDC,paymaster:PM07,bundler:{url:B.url},userOp:{midnightGuardS:20}},pub,session:ex,vault:u.vault,adapter:A,maxGasPerOp:BigInt(pol.maxNetworkFee)});
   const Y=privateKeyToAccount(generatePrivateKey()).address;const nb=Number((await pub.getBlock()).timestamp);
   const a={to:Y,value:300000n,validAfter:BigInt(nb-60),validBefore:BigInt(nb+600),merchantRef:keccak256(toHex('v53-x402-'+tag)),repeatKey:toHex(0n,{size:32})};
   const pk=await pub.readContract({address:A,abi:AD,functionName:'purchaseKey',args:[Y,a.merchantRef,a.repeatKey]});const ad=await pub.readContract({address:A,abi:AD,functionName:'approvalDigest',args:[u.w,pk,Y,a.value,a.validBefore]});
   const sg=sign(await rsh(ad),u.phone);const approval=phonePayWrapper(u.approverIdx,{purchaseKey:pk,payee:Y,amount:a.value,deadline:a.validBefore},sg.r,sg.s);
   const args=[perm,a,approval,50000n,BigInt(nb+240)];
   const r1=await wr.write('prepareAuthorization',args,{address:A});const rc=await pub.getTransactionReceipt({hash:r1.hash});
   let digest=null;for(const l of rc.logs){try{const d=(await import('viem')).decodeEventLog({abi:AD,data:l.data,topics:l.topics});if(d.eventName==='AuthorizationPrepared')digest=d.args.digest;}catch{}}
   step('X','owner-approved x402 reservation prepared (userOp), approval marked used on chain',r1.status==='success'&&!!digest&&await pub.readContract({address:A,abi:AD,functionName:'approvalUsed',args:[ad]})===true,{digest});
   const c=await batch(u,[inW(u.w,[{to:A,data:encodeFunctionData({abi:AD,functionName:'cancelReservation',args:[digest]})}])]);step('X','owner cancels the reservation (his Base Account)',c.status==='success');
   const n0=B.sent.length;let err=null;try{await wr.write('prepareAuthorization',[perm,a,approval,50000n,BigInt(Number((await pub.getBlock()).timestamp)+240)],{address:A});}catch(e){err=String(e.message);}
   step('X','server replays the SAME owner approval after cancel -> refused (ApprovalUsed), nothing sent, nothing paid',!!err&&B.sent.length===n0&&await bal(Y)===0n,{err:err?.slice(0,200)});}
  // ======================= W: withdraw everything
  {const q=await call(u.pre+'/safety/withdraw/quote',{headers:u.H});const baBefore=await bal(u.ba);const plan=await call(u.pre+'/owner/withdraw/prepare',{method:'POST',body:{}});
   const wd=await batch(u,plan.j?.calls??[],'withdrawBatch');const cfw=await call(u.pre+'/owner/withdraw/confirm',{method:'POST',body:{id:plan.j?.id}});
   R.withdraw={quote:q.j?.amount,plan:plan.j?.amount,walletAfter:String(await bal(u.w)),vaultAfter:String(await bal(u.vault))};
   step('W','withdraw all: wallet emptied to his Base Account',wd.status==='success'&&cfw.j?.ok===true&&await bal(u.w)===0n&&(await bal(u.ba))-baBefore===BigInt(plan.j.amount),R.withdraw);}
  // ---- existing V5.2 user (legacy operator tenant, like 0x5150) pays exactly as before, through its V5.2 vault
  {const T0=await M.tenant(W0);const tok=mintAgentToken();T0.agents.push({id:'agent-U0',tokenSha256:hashToken(tok)});T0.reindex();const pre='/t/'+W0.toLowerCase();
   const Z='0x00000000000000000000000000000000000c0ffe';const b0=await bal(Z);/* owner-initiated pay (the owner's own Face ID path, agentId owner): exercises the migrated permission + V5.3 vault userOp; AI limits for this fork user were never set */let r={};try{r.out=await T0.engine().pay({agentId:'owner',idempotencyKey:'v52-u0-'+tag,request:{direct:{chainId:8453,token:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',payee:Z,amount:'500000',merchantOrderId:'v52-u0-'+tag}}});}catch(e){r.out={error:String(e.message)};}
   step('E','§6#92 existing V5.2 user: a payment goes through its V5.2 vault (userOp) with its V5.2 permission, unchanged',(await bal(Z))-b0===500000n,{status:r.status,state:r.out?.state,reason:r.out?.reason,err:String(JSON.stringify(r.out)).slice(0,300)});}
  {const ow=await ownersOf(W0);const ap=ow.find(o=>o.addr&&getAddress(o.addr)===oldAp.address);const c=await pub.getCode({address:v53Of0});
   step('E','§6#92 existing V5.2 user untouched: V5.2 permission still valid (spender = V5.2 adapter), phone approver still bound to the V5.2 trust, no V5.3 vault created',
     await pub.readContract({address:SPM,abi:SPMA,functionName:'isValid',args:[(await import('../../src/v5/abi.mjs')).permissionFromJson(oldPerm)]})===true&&getAddress(oldPerm.spender)===getAddress(OLD_ADAPTER)&&!!ap&&getAddress(await pub.readContract({address:oldAp.address,abi:APPR,functionName:'trust'}))===oldTrust&&(!c||c==='0x'),{v53VaultOfW0:v53Of0});}
  R.userOps=B.sent.map(x=>({userOpHash:x.userOpHash,tx:x.tx,success:x.success}));R.fails=fails;
  if(process.env.REPORT)fs.writeFileSync(process.env.REPORT,JSON.stringify(R,(k,v)=>typeof v==='bigint'?v.toString():v,1));
  console.log('SUMMARY',JSON.stringify({pass:R.steps.filter(x=>x.ok).length,fail:fails}));
  assert.equal(fails,0,'failed steps: '+R.steps.filter(x=>!x.ok).map(x=>x.user+' '+x.step).join(' | '));
  }catch(e){console.log('ERR',String(e.stack??e).slice(0,1500));if(process.env.REPORT)fs.writeFileSync(process.env.REPORT,JSON.stringify(R,(k,v)=>typeof v==='bigint'?v.toString():v,1));throw e;}finally{await M.close().catch(()=>{});await B.close().catch(()=>{});setTimeout(()=>process.exit(0),500).unref?.();}});
