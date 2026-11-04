// FORK-ONLY (throwaway anvil fork of Base, never broadcasts, no real money). t603u/t604u: a brand-new user whose Base Account holds
// ZERO ETH onboards (sponsored), then sets the FIRST AI limit authorization for free (onboarding sponsorship, once per owner), and a
// LATER change is paid in USDC by his Base Account at actual cost. ETH balance of the Base Account stays 0 the whole time.
// Bundler/paymaster are simulated: the EntryPoint (impersonated) executes the Base Account's batch; a local mock stands in for the
// CDP paymaster behind our real /onboard/new/paymaster gate; the USDC gas charge is a USDC transfer of the quoted fee.
import {plantCbv} from './cbv-fork.mjs';import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import https from 'node:https';import {execSync} from 'node:child_process';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,getAddress,encodeAbiParameters,encodeFunctionData,toHex} from 'viem';import {base} from 'viem/chains';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import * as P256 from 'ox/P256';
import {decodePolicyV5} from '../../src/v5/abi.mjs';import {hashToken,mintAgentToken} from '../../src/v4/agents.mjs';import {WALLET_ABI} from '../../src/v5/phone-signer.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;const GW=new URL('../../',import.meta.url).pathname;
const AD=parseAbi(['function trust() view returns (address)','function vaultAddress(address) view returns (address)']);
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);
const FACTORY='0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';const FACT=parseAbi(['function createAccount(bytes[] owners,uint256 nonce) payable returns (address)','function getAddress(bytes[] owners,uint256 nonce) view returns (address)']);
const BA_ABI=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable']);const EP6='0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
test('zero-ETH Base Account: first limits authorization free (sponsored), later change paid in USDC',{skip:!RPC||!PJ,timeout:600000},async()=>{
  const perm=JSON.parse(PJ);const W0=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);const pol=decodePolicyV5(perm.extraData);const EXEC=getAddress(pol.executor);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});const vault0=await pub.readContract({address:A,abi:AD,functionName:'vaultAddress',args:[W0]});
  await tc.impersonateAccount({address:EXEC});await tc.setBalance({address:EXEC,value:10n**18n});
  const whale='0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';await tc.impersonateAccount({address:whale});await tc.setBalance({address:whale,value:10n**18n});
  await tc.impersonateAccount({address:EP6});await tc.setBalance({address:EP6,value:10n**18n});
  const bal=a=>pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[a]});
  // mock CDP paymaster (https, local) behind OUR gate; counts what our proxy forwarded
  const dir=mkdtempSync(join(tmpdir(),'lim-'));execSync(`openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=127.0.0.1 -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 2>/dev/null`);
  const fwd=[];const pm=https.createServer({key:fs.readFileSync(dir+'/k.pem'),cert:fs.readFileSync(dir+'/c.pem')},(q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{const j=JSON.parse(b);fwd.push(j.method);s.end(JSON.stringify({jsonrpc:'2.0',id:j.id,result:{paymaster:'0x9d3927128b74460e164a1b1dee445d490e7eca72',paymasterData:'0x',sponsor:{name:'mock'}}}));});});
  await new Promise(r=>pm.listen(0,'127.0.0.1',r));process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';process.env.KIPURSE_ONBOARD_PAYMASTER_URL=`https://127.0.0.1:${pm.address().port}/rpc`;
  const CONF=join(dir,'conf'),DATA=join(dir,'data');fs.mkdirSync(CONF);fs.mkdirSync(DATA);
  fs.writeFileSync(join(CONF,'agents.json'),JSON.stringify([{id:'legacy',tokenSha256:hashToken(mintAgentToken())}]));
  fs.writeFileSync(join(CONF,'mainnet-trustflow.config.json'),JSON.stringify({chainId:8453,wallet:W0,ownerBaseAccount:'0x0000000000000000000000000000000000000001',token:USDC,adapter:A,trust,vault:vault0,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
    currentPermission:perm,newCaps:{single:pol.single},engine:{chainId:8453,rpc:RPC,adapter:A,trust,token:USDC,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',ownerSigner:{wallet:W0,ownerIndex:0},ownerRulesDir:join(DATA,'owner-rules'),ledgerFile:join(DATA,'ledger.sqlite')}}));
  const SF=join(DATA,'runtime-state.json'); // no legacy tenant: only the brand-new user
  /* t796 KYC on: real CBV check against the fork; each new owner gets a planted Coinbase attestation (cbv-fork.mjs) */process.env.KIPURSE_CBV_RPCS=RPC;/* fork has no real Apple App Attest: model an attested device for the free first authorization (M4 gate is unit-tested) */process.env.KIPURSE_APP_ATTEST="log";delete process.env.KIPURSE_REQUIRE_CBV;process.env.KIPURSE_GATEWAY=GW;process.env.KIPURSE_MAIN_CONFIG_DIR=CONF;process.env.KIPURSE_MAIN_DATA_DIR=DATA;
  const gp=await pub.getGasPrice();const {startMainnet}=await import('../../mainnet/mainnet-owner-launch.mjs?lim');const port=19400+Math.floor(Math.random()*200);let OV;
  const M=await startMainnet({fork:true,agentPort:port,ownerPort:port+1000,stateFile:SF,overrides:OV={rpc:RPC,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,gasMode:'legacy',onboard:true,phoneOnChain:async()=>true,
    gasPricing:{usdcPerEth:'3000000000',gasPriceWei:String(gp)},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,publicBase:`http://127.0.0.1:${port}`,kvFile:join(DATA,'kv.sqlite')}});
  const GU=`http://127.0.0.1:${port}`;const R={steps:[]};const step=(n,ok,d)=>{console.log((ok?'PASS ':'FAIL ')+n+' '+JSON.stringify(d??'').slice(0,400));R.steps.push(n);assert.ok(ok,n+' '+JSON.stringify(d??''));};
  try{
    const call=async(path,{method='GET',body}={})=>{const r=await fetch(GU+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json();}catch{}return {status:r.status,j};};
    const kp=()=>{const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});return {privateKey,x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};};
    // brand-new person: fresh key -> Base Account; 0 ETH anywhere on his side
    const key=privateKeyToAccount(generatePrivateKey());const owners=[encodeAbiParameters([{type:'address'}],[key.address])];
    const ba=getAddress(await pub.readContract({address:FACTORY,abi:FACT,functionName:'getAddress',args:[owners,0n]}));
    {const h=await createWalletClient({chain:base,transport:vh(RPC),account:whale}).writeContract({address:FACTORY,abi:FACT,functionName:'createAccount',args:[owners,0n]});await pub.waitForTransactionReceipt({hash:h});}await plantCbv(RPC,ba);
    const eth0=async()=>(await pub.getBalance({address:ba}))+(await pub.getBalance({address:key.address}));
    step('Base Account and its key hold 0 ETH',await eth0()===0n);
    // the bundler path: EntryPoint executes the Base Account's batch (gas is the paymaster's or USDC, never the user's ETH)
    const viaEP=async calls=>{const data=encodeFunctionData({abi:BA_ABI,functionName:'executeBatch',args:[calls.map(c=>({target:getAddress(c.to),value:BigInt(c.value??0),data:c.data}))]});
      const h=await createWalletClient({chain:base,transport:vh(RPC),account:EP6}).sendTransaction({to:ba,data,gas:8_000_000n});const r=await pub.waitForTransactionReceipt({hash:h});return {status:r.status,gas:r.gasUsed,data};};
    const op=data=>({sender:ba,callData:data,callGasLimit:'0x7a120',verificationGasLimit:'0x30d40',preVerificationGas:'0xc350',maxFeePerGas:'0x'+BigInt(process.env.LIVE_GAS_PRICE_WEI??gp).toString(16)});
    const pmCall=async(url,data)=>{const u=new URL(url);const r=await fetch(GU+u.pathname+u.search,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'pm_getPaymasterData',params:[op(data),EP6,'0x2105',{}]})});return r.json();};
    // 1. onboarding: the user chooses his own limits (no preset), sponsored
    const phone=kp();const st=await call('/onboard/new/start',{method:'POST',body:{x:phone.x,y:phone.y,single:'2',daily:'5',term:'20',days:30}});
    const pr=await call('/onboard/new/prepare',{method:'POST',body:{id:st.j.id,owner:ba}});assert.equal(pr.status,200,JSON.stringify(pr.j));const W=getAddress(pr.j.wallet);
    const ob=await viaEP(pr.j.calls);step('onboarding batch lands via EntryPoint (sponsored), user ETH 0',ob.status==='success'&&await eth0()===0n,{gas:String(ob.gas)});
    {const {createHash}=await import('node:crypto');const kf=join(DATA,'executors',createHash('sha256').update('kipurse-exec-v1:'+W.toLowerCase()).digest('hex').slice(0,40)+'.key');
      if(fs.existsSync(kf)){const ex=getAddress(JSON.parse(fs.readFileSync(kf)).address);OV.impersonateExecutor=ex;await tc.impersonateAccount({address:ex});await tc.setBalance({address:ex,value:10n**18n});}}
    const cf=await call('/onboard/confirm',{method:'POST',body:{id:st.j.id}});step('onboarding confirmed',cf.j?.ok===true,cf.j);
    const T='/t/'+W.toLowerCase();
    // 2. FIRST limits authorization: free. Page says so and states the later per-change fee in USDC.
    const page=await (await fetch(GU+T+'/owner/limits?single=3&daily=6&term=30')).text();if(process.env.PAGEDBG)console.log('PAGEDBG',page.length,page.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(-1300));
    /* t796 KYC-on reality: onboarding already lands the first (sponsored) authorization, so this page is a paid change */step('limits page: change fee stated in USDC, no ETH ask',/手续费|Network fee/.test(page)&&/USDC/.test(page)&&!/需要 ETH|need ETH/i.test(page));
    /* t796: the old 'first change sponsored' block is gone; under KYC-on the first authorization is the sponsored onboarding batch (asserted above, paymaster gate covered by onboard-fork). Every later change is paid in USDC: */
    // 3. LATER change, wallet has 0 USDC: 402 wallet_needs_topup BEFORE any signing page, beginner explanation, never ETH
    const fund=async(to,amt)=>{const h=await createWalletClient({chain:base,transport:vh(RPC),account:whale}).writeContract({address:USDC,abi:ERC20,functionName:'transfer',args:[to,amt]});await pub.waitForTransactionReceipt({hash:h});};
    const w0=await bal(W);if(w0>0n){/* drain wallet so the test is deterministic: impersonate wallet */}
    const p2=await call(T+'/owner/limits/prepare',{method:'POST',body:{single:'4',daily:'8',term:'40'}});
    step('later change, empty wallet: 402 wallet_needs_topup, nothing to sign, explained, no ETH ask',p2.status===402&&(w0>0n||p2.j.error==='wallet_needs_topup')&&!p2.j.calls&&/区块链上/.test(p2.j.detail?.zh??'')&&!/需要 ETH|need ETH/i.test(JSON.stringify(p2.j)),{d:p2.j?.detail,k:Object.keys(p2.j),m:JSON.stringify(p2.j).match(/.{20}(需要 ETH|need ETH).{20}/i)?.[0]});
    // 3b. wallet funded, Base Account has 0 USDC float: 402 base_account_needs_float
    await fund(W,5_000_000n);
    const p2b=await call(T+'/owner/limits/prepare',{method:'POST',body:{single:'4',daily:'8',term:'40'}});
    step('later change, wallet funded but Base Account 0 USDC: 402 base_account_needs_float, nothing to sign',p2b.status===402&&p2b.j.error==='base_account_needs_float'&&!p2b.j.calls,{e:p2b.j?.error});
    // 4. both ok: batch = limits + wallet refunds fee to Base Account; net Base Account cost 0, wallet pays fee
    await fund(ba,2_000_000n);
    const p3=await call(T+'/owner/limits/prepare',{method:'POST',body:{single:'4',daily:'8',term:'40'}});
    const rf=p3.j?.calls?.at(-1);
    step('later change: no paymaster, batch ends with wallet fee refund to Base Account',p3.status===200&&p3.j.sponsored===false&&!p3.j.pm&&p3.j.fee?.walletPays===true&&getAddress(rf.to)===W&&rf.label==='fee_refund',{fee:p3.j?.fee,n:p3.j?.calls?.length});
    const ba0=await bal(ba),w1=await bal(W);
    const x3=await viaEP([...p3.j.calls,{to:USDC,value:0,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:['0x9d3927128b74460e164a1b1dee445d490e7eca72',BigInt(p3.j.fee.usdc)]})}]);
    await call(T+'/owner/limits/submitted',{method:'POST',body:{id:p3.j.id}});const c3=await call(T+'/owner/limits/confirm',{method:'POST',body:{id:p3.j.id}});
    step('later change lands; wallet paid the fee, Base Account net 0, ETH 0',x3.status==='success'&&c3.j?.ok===true&&c3.j.single==='4'&&ba0===await bal(ba)&&w1-(await bal(W))===BigInt(p3.j.fee.usdc)&&await eth0()===0n,{feeUSDC:p3.j.fee.usdcText,gas:String(x3.gas)});
    R.laterFee=p3.j.fee;console.log('REPORT',JSON.stringify(R));
  }catch(e){console.log('ERR',String(e.stack??e).slice(0,1500));throw e;}finally{pm.close();await M.close().catch(()=>{});setTimeout(()=>process.exit(0),500).unref?.();}});
