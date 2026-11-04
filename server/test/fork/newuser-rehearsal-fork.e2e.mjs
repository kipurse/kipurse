// FORK-ONLY new-user rehearsal (private anvil fork of Base, never broadcasts, no real money): TWO brand-new users, each with a fresh
// Base Account (Coinbase Smart Wallet owned by a fresh key) and a fresh phone key, go end to end through the real gateway:
// onboarding (one batch) -> own deterministic wallet -> deposit -> agent pays within caps (over-cap refused) -> pause -> withdraw all
// -> delete. Cross-user isolation checked between them. Writes a JSON report (addresses, tx hashes, gas, fees) to $REPORT.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
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
test('new-user rehearsal: two fresh users end to end + isolation',{skip:!RPC||!PJ,timeout:900000},async()=>{
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
  process.env.KIPURSE_REQUIRE_CBV='0';/* CBV gate: covered by test/cb-verified.test.mjs (fork has no attestations for random owners) */process.env.KIPURSE_GATEWAY=GW;process.env.KIPURSE_MAIN_CONFIG_DIR=CONF;process.env.KIPURSE_MAIN_DATA_DIR=DATA;
  let OV;const {startMainnet}=await import('../../mainnet/mainnet-owner-launch.mjs?rh');const port=19100+Math.floor(Math.random()*200);
  const M=await startMainnet({fork:true,agentPort:port,ownerPort:port+1000,stateFile:SF,overrides:OV={rpc:RPC,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,gasMode:'legacy',onboard:true,userErase:true,ownerPay:true,phoneOnChain:async()=>true,
    gasPricing:{usdcPerEth:String(Math.round(R.ethUsd*1e6)),gasPriceWei:R.liveGasPriceWei},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,publicBase:'http://fork.invalid',kvFile:join(DATA,'kv.sqlite')}});
  const GU=`http://127.0.0.1:${port}`;
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
  const users={};
  for(const name of ['U1','U2']){
    // 1. brand-new person: fresh key -> his own Base Account (smart wallet), a little ETH + USDC as if bought on Coinbase; fresh phone key
    const key=privateKeyToAccount(generatePrivateKey());await tc.setBalance({address:key.address,value:10n**18n});
    const owners=[encodeAbiParameters([{type:'address'}],[key.address])];const ba=getAddress(await pub.readContract({address:FACTORY,abi:FACT,functionName:'getAddress',args:[owners,0n]}));
    {const h=await createWalletClient({chain:base,transport:vh(RPC),account:key}).writeContract({address:FACTORY,abi:FACT,functionName:'createAccount',args:[owners,0n]});await pub.waitForTransactionReceipt({hash:h});}
    {const h=await createWalletClient({chain:base,transport:vh(RPC),account:whale}).writeContract({address:USDC,abi:ERC20,functionName:'transfer',args:[ba,20_000_000n]});await pub.waitForTransactionReceipt({hash:h});}
    const u={name,key,ba,phone:kp()};users[name]=u;const Ru=R.users[name]={baseAccount:ba,txs:{}};
    step(name,'fresh: Base Account never seen by the gateway',(await find(u.phone)).status===404&&(await call('/onboard/new/start',{method:'POST',body:{x:u.phone.x,y:u.phone.y,single:'2',daily:'5',term:'20',days:30}})).status===200);
    // 2. one-step onboarding (one atomic batch from his Base Account)
    const st=await call('/onboard/new/start',{method:'POST',body:{x:u.phone.x,y:u.phone.y,single:'2',daily:'5',term:'20',days:30}});
    const pg=await fetch(GU+'/onboard/new?id='+st.j.id);const pgt=await pg.text();
    const pr=await call('/onboard/new/prepare',{method:'POST',body:{id:st.j.id,owner:ba}});assert.equal(pr.status,200,JSON.stringify(pr.j));
    u.w=getAddress(pr.j.wallet);Ru.wallet=u.w;Ru.onboardCalls=pr.j.calls.length;
    const expectW=getAddress(await pub.readContract({address:FACTORY,abi:FACT,functionName:'getAddress',args:[[encodeAbiParameters([{type:'address'}],[ba])],0n]}));
    step(name,'own wallet address is deterministic from his Base Account (factory.getAddress)',u.w===expectW&&pr.j.existing===false,{wallet:u.w});
    const ob=await batch(u,pr.j.calls);Ru.txs.onboard=ob.hash;Ru.onboardFee=ob;step(name,'onboarding = ONE tx, success',ob.status==='success',{hash:ob.hash,gas:ob.gas,usd:ob.usd.toFixed(4)});
    {// fork harness only: legacy gas mode sends from ONE impersonated executor; point it at this wallet's own per-user executor (production uses it as the userop session key)
      const {createHash}=await import('node:crypto');const kf=join(DATA,'executors',createHash('sha256').update('kipurse-exec-v1:'+u.w.toLowerCase()).digest('hex').slice(0,40)+'.key');const ex=getAddress(JSON.parse(fs.readFileSync(kf)).address);
      OV.impersonateExecutor=ex;await tc.impersonateAccount({address:ex});await tc.setBalance({address:ex,value:10n**18n});Ru.perUserExecutor=ex;}
    const cf=await call('/onboard/confirm',{method:'POST',body:{id:st.j.id}});
step(name,'confirm: caps + phone approver (Face ID) + Siri on chain',cf.j?.ok===true&&cf.j.siri===true&&getAddress(cf.j.wallet)===u.w,cf.j);
    step(name,'onboarding page shows the phone fingerprint',pg.status===200&&pgt.includes(st.j.fingerprint));
    // 3. app: find wallet by phone key, open session, deposit screen shows HIS address
    const f=await find(u.phone);step(name,'app finds its wallet by the phone key',f.status===200&&getAddress(f.j.wallet)===u.w);
    u.pre='/t/'+u.w.toLowerCase();const s=await sess(u.pre,u.phone);step(name,'phone session (Face ID signature)',s.status===200,{status:s.status,scope:s.j?.scope});u.tok=s.j.token;u.H={authorization:'Bearer '+u.tok};
    const state=await call(u.pre+'/phone/session/state',{headers:u.H});step(name,'deposit screen address = his own wallet',state.status===200&&getAddress(state.j.setup?.wallet??'0x0000000000000000000000000000000000000000')===u.w,{wallet:state.j?.setup?.wallet});
    // 4. deposit 10 test USDC from his Base Account
    const dep=await batch(u,[{to:USDC,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[u.w,10_000_000n]})}]);Ru.txs.deposit=dep.hash;
    step(name,'deposit 10 USDC arrives',dep.status==='success'&&await bal(u.w)===10_000_000n,{hash:dep.hash});
    // 5. his AI agent (own token, own tenant) pays within caps; over cap refused
    u.agentTok=mintAgentToken();const T=await M.tenant(u.w);{const pp=decodePolicyV5(T.S.permission.extraData);console.log('POLICY',name,JSON.stringify({executor:pp.executor,sharedExec:EXEC,single:String(pp.single),openSingle:String(pp.openSingle),maxNetworkFee:String(pp.maxNetworkFee??''),maxFeePpm:String(pp.maxFeePpm??'')}));}T.agents.push({id:'agent-'+name,tokenSha256:hashToken(u.agentTok)});T.reindex();
    u.payee=privateKeyToAccount(generatePrivateKey()).address;
    const p0=await mcpTool(u.pre,u.agentTok,'kipurse_pay',{to:u.payee,amount:PAYS,merchant:'rehearsal-shop',orderRef:'rh-'+name+'-0'});
    step(name,'new payee: AI alone is refused, nothing paid (#7)',p0.out?.reason==='NEW_PAYEE_NEEDS_OWNER'&&p0.out?.nothingPaid===true&&await bal(u.payee)===0n,{out:JSON.stringify(p0.out).slice(0,300)});
    T.engine().mandates.remember(u.payee,'rehearsal-shop'); // = owner's one-time Face ID approval of this payee (approval path covered by unit tests)
    const p1=await mcpTool(u.pre,u.agentTok,'kipurse_pay',{to:u.payee,amount:PAYS,merchant:'rehearsal-shop',orderRef:'rh-'+name+'-1'});
    const got=await bal(u.payee);Ru.pay=p1.out;Ru.txs.pay=p1.out?.txHash??p1.out?.tx??p1.out?.hash??null;
    step(name,'AI pays '+PAYS+' USDC within caps',got===PAY,{status:p1.status,state:p1.out?.state,out:JSON.stringify(p1.out).slice(0,700),payee:got.toString()});
    const p2=await mcpTool(u.pre,u.agentTok,'kipurse_pay',{to:u.payee,amount:'3',merchant:'rehearsal-shop',orderRef:'rh-'+name+'-2'});
    step(name,'AI over the single cap (3 > 2) is refused, nothing moves',await bal(u.payee)===PAY,{state:p2.out?.state??p2.out?.error??String(JSON.stringify(p2.out)).slice(0,120)});
  }
  // 6. isolation between the two fresh users
  const [a,b]=[users.U1,users.U2];const iso=R.isolation;
  iso.agentU1_onU2=(await mcpTool(b.pre,a.agentTok,'kipurse_wallet_status',{})).status;
  iso.agentU1_headerU2=(await fetch(GU+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+a.agentTok,'x-kipurse-wallet':b.w},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'x',version:'1'}}})})).status;
  iso.sessU1_onU2=(await call(b.pre+'/phone/session/state',{headers:a.H})).status;
  iso.phoneU1_sessionOnU2=(await sess(b.pre,a.phone)).status;
  iso.stopU2_withU1=(await call(b.pre+'/safety/stop',{method:'POST',headers:a.H})).status;
  iso.withdrawQuoteU2_withU1=(await call(b.pre+'/safety/withdraw/quote',{headers:a.H})).status;
  {const c=await call(b.pre+'/user/erase/challenge',{method:'POST',headers:b.H});iso.eraseU2_signedByU1=(await call(b.pre+'/user/erase',{method:'POST',headers:b.H,body:{nonce:c.j.nonce,phrase:'DELETE',...sign(c.j.digest,a.phone)}})).status;}
  const sb=(await call(b.pre+'/phone/session/state',{headers:b.H})).j;iso.u2SeesU1Payee=JSON.stringify(sb).toLowerCase().includes(a.payee.toLowerCase().slice(2));
  console.log('ISOLATION',JSON.stringify(iso));
  step('both','different wallets',a.w!==b.w);
  step('both','cross-user requests all refused',['agentU1_onU2','agentU1_headerU2','sessU1_onU2','phoneU1_sessionOnU2','stopU2_withU1','withdrawQuoteU2_withU1','eraseU2_signedByU1'].every(k=>[400,401,403,404,409].includes(iso[k])),iso);
  step('both','U2 state shows nothing of U1',iso.u2SeesU1Payee===false);
  for(const u of [a,b]){const Ru=R.users[u.name];
    // 7. pause 24h from the phone; agent payment refused while paused
    const stp=await call(u.pre+'/safety/stop',{method:'POST',headers:u.H,body:{duration:'24h'}});const left=(stp.j?.server?.until??0)-Date.now();
    step(u.name,'pause 24h (server + on chain)',stp.status===200&&left>23.9*3600e3&&left<=24*3600e3,{chain:stp.j?.chain});
    const before=await bal(u.payee);const pp=await mcpTool(u.pre,u.agentTok,'kipurse_pay',{to:u.payee,amount:PAYS,merchant:'rehearsal-shop',orderRef:'rh-'+u.name+'-paused'});
    step(u.name,'AI payment refused while paused',await bal(u.payee)===before,{state:pp.out?.state??pp.out?.error});
    // 8. one-tap withdraw everything to his own Base Account (the quote the app shows, the plan his Base Account signs)
    const q=await call(u.pre+'/safety/withdraw/quote',{headers:u.H});step(u.name,'withdraw quote goes to his own Base Account',q.status===200&&getAddress(q.j.to)===u.ba,{amount:q.j?.amount,to:q.j?.to});
    const baBefore=await bal(u.ba);const plan=await call(u.pre+'/owner/withdraw/prepare',{method:'POST',body:{to:'0x000000000000000000000000000000000000dEaD'}});
    step(u.name,'withdraw plan ignores any other destination',plan.status===200&&getAddress(plan.j.owner)===u.ba,{amount:plan.j?.amount});
    const wd=await batch(u,plan.j.calls);Ru.txs.withdraw=wd.hash;Ru.withdrawFee=wd;
    const cfw=await call(u.pre+'/owner/withdraw/confirm',{method:'POST',body:{id:plan.j.id}});
    step(u.name,'withdraw: wallet emptied, money back in his Base Account',wd.status==='success'&&cfw.j?.ok===true&&await bal(u.w)===0n&&(await bal(u.ba))-baBefore===BigInt(plan.j.amount),{hash:wd.hash,amount:plan.j.amount});
    // 9. delete account (phone-signed); afterwards nothing is found, other user untouched
    const c=await call(u.pre+'/user/erase/challenge',{method:'POST',headers:u.H});
    const er=await call(u.pre+'/user/erase',{method:'POST',headers:u.H,body:{nonce:c.j.nonce,phrase:'DELETE',...sign(c.j.digest,u.phone)}});
    step(u.name,'delete account',er.status===200,er.j);
    step(u.name,'after delete: phone lookup 404, session dead, agent token dead',(await find(u.phone)).status===404&&(await call(u.pre+'/phone/session/state',{headers:u.H})).status===401&&[401,403,404].includes((await mcpTool(u.pre,u.agentTok,'kipurse_wallet_status',{})).status));
    if(u===a)step('U2','still works after U1 deleted',(await call(b.pre+'/phone/session/state',{headers:b.H})).status===200);
  }
  R.ok=true;if(process.env.REPORT)fs.writeFileSync(process.env.REPORT,JSON.stringify(R,(k,v)=>typeof v==='bigint'?v.toString():v,1));
  console.log('REPORT',JSON.stringify({users:Object.fromEntries(Object.entries(R.users).map(([k,v])=>[k,{wallet:v.wallet,baseAccount:v.baseAccount,txs:v.txs,onboardUsd:v.onboardFee?.usd,withdrawUsd:v.withdrawFee?.usd}])),isolation:R.isolation}));
  }catch(e){console.log('ERR',String(e.stack??e).slice(0,1500));throw e;}finally{await M.close().catch(()=>{});setTimeout(()=>process.exit(0),500).unref?.();}});
