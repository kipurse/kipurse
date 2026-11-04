// FORK-ONLY (private anvil fork of Base, never broadcasts): "Sign in with Coinbase" identity flow through the real gateway.
//  A) brand-new Base Account -> free SIWE signature (ERC-1271, no tx) -> 'new' -> onboarding bound to THAT account (other account refused)
//  B) same account + same phone key -> 'reconnect' with NO transaction, same wallet, phone session works
//  C) same account + a fresh phone key -> 'bind' -> onboarding reuses the SAME wallet (no createAccount, never a 2nd wallet)
//  D) signature by a different account is refused
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,getAddress,decodeAbiParameters,encodeAbiParameters,encodeFunctionData,toHex,hashMessage} from 'viem';import {base} from 'viem/chains';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import * as P256 from 'ox/P256';
import {WALLET_ABI} from '../../src/v5/phone-signer.mjs';import {decodePolicyV5} from '../../src/v5/abi.mjs';import {hashToken,mintAgentToken} from '../../src/v4/agents.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;const GW=new URL('../../',import.meta.url).pathname;
const AD=parseAbi(['function trust() view returns (address)','function vaultAddress(address) view returns (address)']);
const FACTORY='0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';const FACT=parseAbi(['function createAccount(bytes[] owners,uint256 nonce) payable returns (address)','function getAddress(bytes[] owners,uint256 nonce) view returns (address)']);
const BA_ABI=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable','function replaySafeHash(bytes32 hash) view returns (bytes32)']);
test('sign in with Coinbase: new / reconnect (no tx) / bind (same wallet) / wrong signer',{skip:!RPC||!PJ,timeout:900000},async()=>{
  const perm=JSON.parse(PJ);const W0=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);const pol=decodePolicyV5(perm.extraData);const EXEC=getAddress(pol.executor);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});const vault0=await pub.readContract({address:A,abi:AD,functionName:'vaultAddress',args:[W0]});
  const OWNER0=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W0,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  await tc.impersonateAccount({address:EXEC});await tc.setBalance({address:EXEC,value:10n**18n});
  const R={steps:[]};const step=(n,ok,d)=>{R.steps.push({step:n,ok:!!ok});console.log((ok?'PASS ':'FAIL ')+n+' '+JSON.stringify(d??'').slice(0,300));assert.ok(ok,n+' '+JSON.stringify(d??''));};
  const kp=()=>{const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});return {privateKey,x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};};
  const sign=(d,k)=>{const s=P256.sign({payload:d,privateKey:k.privateKey});return {r:toHex(s.r,{size:32}),s:toHex(s.s,{size:32})};};
  const batch=async(u,calls)=>{const data=encodeFunctionData({abi:BA_ABI,functionName:'executeBatch',args:[calls.map(c=>({target:getAddress(c.to),value:BigInt(c.value??0),data:c.data}))]});
    const h=await createWalletClient({chain:base,transport:vh(RPC),account:u.key}).sendTransaction({to:u.ba,data,gas:8_000_000n});const r=await pub.waitForTransactionReceipt({hash:h});return {hash:h,status:r.status,gas:String(r.gasUsed)};};
  // Base Account (Coinbase Smart Wallet) ERC-1271 signature: owner signs replaySafeHash(hashMessage(m)), wrapped as SignatureWrapper(ownerIndex, sig)
  const baSign=async(u,message)=>{const h=await pub.readContract({address:u.ba,abi:BA_ABI,functionName:'replaySafeHash',args:[hashMessage(message)]});const sig=await u.key.sign({hash:h});
    return encodeAbiParameters([{type:'tuple',components:[{name:'ownerIndex',type:'uint256'},{name:'signatureData',type:'bytes'}]}],[{ownerIndex:0n,signatureData:sig}]);};
  const dir=mkdtempSync(join(tmpdir(),'si-'));const CONF=join(dir,'conf'),DATA=join(dir,'data');fs.mkdirSync(CONF);fs.mkdirSync(DATA);
  fs.writeFileSync(join(CONF,'agents.json'),JSON.stringify([{id:'legacy',tokenSha256:hashToken(mintAgentToken())}]));
  fs.writeFileSync(join(CONF,'mainnet-trustflow.config.json'),JSON.stringify({chainId:8453,wallet:W0,ownerBaseAccount:OWNER0,token:USDC,adapter:A,trust,vault:vault0,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
    currentPermission:perm,newCaps:{single:pol.single},engine:{chainId:8453,rpc:RPC,adapter:A,trust,token:USDC,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',ownerSigner:{wallet:W0,ownerIndex:0},
      ownerRulesDir:join(DATA,'owner-rules'),ledgerFile:join(DATA,'ledger.sqlite')}}));
  const SF=join(DATA,'runtime-state.json');fs.writeFileSync(SF,JSON.stringify({permission:perm}));
  process.env.KIPURSE_REQUIRE_CBV='0';/* CBV gate: covered by test/cb-verified.test.mjs (fork has no attestations for random owners) */process.env.KIPURSE_GATEWAY=GW;process.env.KIPURSE_MAIN_CONFIG_DIR=CONF;process.env.KIPURSE_MAIN_DATA_DIR=DATA;
  const {startMainnet}=await import('../../mainnet/mainnet-owner-launch.mjs?si');const port=19400+Math.floor(Math.random()*200);
  const M=await startMainnet({fork:true,agentPort:port,ownerPort:port+1000,stateFile:SF,overrides:{rpc:RPC,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,gasMode:'legacy',onboard:true,userErase:true,ownerPay:true,phoneOnChain:async()=>true,
    gasPricing:{usdcPerEth:'2335000000',gasPriceWei:'6000000'},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,publicBase:'http://fork.invalid',kvFile:join(DATA,'kv.sqlite')}});
  const GU=`http://127.0.0.1:${port}`;
  try{
  const call=async(path,{method='GET',body}={})=>{const r=await fetch(GU+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json();}catch{}return {status:r.status,j};};
  const find=async k=>{const c=await call('/phone/find/challenge',{method:'POST'});return call('/phone/find',{method:'POST',body:{nonce:c.j.nonce,x:k.x,y:k.y,...sign(c.j.digest,k)}});};
  const sess=async(pre,k)=>{const c=await call(pre+'/phone/session/challenge',{method:'POST'});if(c.status!==200)return c;return call(pre+'/phone/session',{method:'POST',body:{nonce:c.j.nonce,...sign(c.j.digest,k)}});};
  const signin=async(u,phone,signer=u)=>{const st=await call('/signin/start',{method:'POST',body:phone?{x:phone.x,y:phone.y}:{}});const pg=await fetch(GU+'/signin?id='+st.j.id);
    const m=await call('/signin/message',{method:'POST',body:{id:st.j.id,address:u.ba}});const sig=await baSign(signer,m.j.message);
    const v=await call('/signin/verify',{method:'POST',body:{id:st.j.id,address:u.ba,message:m.j.message,signature:sig}});return {v,pageOk:pg.status===200,status:(await call('/signin/status?id='+st.j.id)).j};};
  const nonces=async u=>[await pub.getTransactionCount({address:u.key.address}),await pub.getBlockNumber()];
  const mkUser=async()=>{const key=privateKeyToAccount(generatePrivateKey());await tc.setBalance({address:key.address,value:10n**18n});
    const owners=[encodeAbiParameters([{type:'address'}],[key.address])];const ba=getAddress(await pub.readContract({address:FACTORY,abi:FACT,functionName:'getAddress',args:[owners,0n]}));
    const h=await createWalletClient({chain:base,transport:vh(RPC),account:key}).writeContract({address:FACTORY,abi:FACT,functionName:'createAccount',args:[owners,0n]});await pub.waitForTransactionReceipt({hash:h});return {key,ba};};
  const U=await mkUser(),X=await mkUser();const stale=kp();
  // A) brand-new account, phone carries a stale key from an earlier install
  let n0=await nonces(U);const a=await signin(U,stale);let n1=await nonces(U);
  step('A new account: SIWE (ERC-1271) verified -> new, wallet none',a.v.status===200&&a.v.j.result==='new'&&a.v.j.wallet===null&&a.pageOk,a.v.j);
  step('A sign-in sent NO transaction (owner nonce + block unchanged)',n0[0]===n1[0]&&n0[1]===n1[1],{n0:n0.map(String),n1:n1.map(String)});
  const phone=kp();// app creates a FRESH key for a new account; the stale one is never sent to onboarding
  const st=await call('/onboard/new/start',{method:'POST',body:{x:phone.x,y:phone.y,single:'2',daily:'5',term:'20',days:30,owner:U.ba}});
  const wrong=await call('/onboard/new/prepare',{method:'POST',body:{id:st.j.id,owner:X.ba}});
  step('A onboarding bound to the signed-in account: another account is refused',wrong.status===400&&wrong.j.error==='owner_mismatch',wrong.j);
  const pr=await call('/onboard/new/prepare',{method:'POST',body:{id:st.j.id,owner:U.ba}});
  const expectW=getAddress(await pub.readContract({address:FACTORY,abi:FACT,functionName:'getAddress',args:[[encodeAbiParameters([{type:'address'}],[U.ba])],0n]}));
  step('A new wallet = deterministic from his Base Account',pr.status===200&&pr.j.existing===false&&getAddress(pr.j.wallet)===expectW,{wallet:pr.j?.wallet});
  const ob=await batch(U,pr.j.calls);step('A onboarding = ONE tx paid by his Base Account',ob.status==='success',ob);
  const cf=await call('/onboard/confirm',{method:'POST',body:{id:st.j.id}});step('A confirm ok (SPM owner + approver + permission on chain)',cf.j?.ok===true,cf.j);
  const W=getAddress(cf.j.wallet);
  // B) reinstall: same account + same phone key -> reconnect, no tx
  n0=await nonces(U);const b=await signin(U,phone);n1=await nonces(U);
  step('B same account + same key -> reconnect, same wallet',b.v.j?.result==='reconnect'&&getAddress(b.v.j.wallet)===W&&b.status.result==='reconnect',b.v.j);
  step('B reconnect sent NO transaction',n0[0]===n1[0]&&n0[1]===n1[1]);
  const f=await find(phone);const s=await sess('/t/'+W.toLowerCase(),phone);step('B reused key opens the wallet (find + phone session)',f.status===200&&getAddress(f.j.wallet)===W&&s.status===200,{find:f.status,sess:s.status});
  const bs=await signin(U,stale);step('B same account + stale key from another install -> bind (not reconnect)',bs.v.j?.result==='bind'&&getAddress(bs.v.j.wallet)===W);
  // C) new phone key for the same account -> bind -> SAME wallet, never a second one
  const phone2=kp();const c=await signin(U,phone2);step('C same account + new key -> bind',c.v.j?.result==='bind'&&getAddress(c.v.j.wallet)===W);
  const st2=await call('/onboard/new/start',{method:'POST',body:{x:phone2.x,y:phone2.y,single:'2',daily:'5',term:'20',days:30,owner:U.ba}});
  const pr2=await call('/onboard/new/prepare',{method:'POST',body:{id:st2.j.id,owner:U.ba}});
  const hasCreate=(pr2.j?.calls??[]).some(x=>getAddress(x.to)===getAddress(FACTORY));
  step('C bind uses the existing wallet (existing:true, no createAccount)',pr2.status===200&&pr2.j.existing===true&&getAddress(pr2.j.wallet)===W&&!hasCreate,{status:pr2.status,j:pr2.j,st2:st2.j&&{status:st2.status,err:st2.j.error,detail:st2.j.detail}});
  const ob2=await batch(U,pr2.j.calls);const cf2=await(async()=>{for(let i=0;i<5;i++){const r=await call('/onboard/confirm',{method:'POST',body:{id:st2.j.id}});if(r.j?.ok)return r;await new Promise(r=>setTimeout(r,500));}return await call('/onboard/confirm',{method:'POST',body:{id:st2.j.id}});})();
  step('C bind batch lands (user-paid) and confirms',ob2.status==='success'&&cf2.j?.ok===true,{tx:ob2.status,cf:cf2.j});
  const c2=await signin(U,phone2);step('C after bind: new key -> reconnect, same wallet',c2.v.j?.result==='reconnect'&&getAddress(c2.v.j.wallet)===W,c2.v.j);
  step('C registry: exactly ONE wallet for this Base Account',M.registry.byOwner(U.ba).length===1,{n:M.registry.byOwner(U.ba).length});
  // D) wrong signer
  const d=await signin(U,phone2,X);step('D signature by another account refused (401)',d.v.status===401&&d.v.j.error==='bad_signature',d.v.j);
  const xs=await signin(X,phone);step('D other brand-new account -> new (sees nothing of U)',xs.v.j?.result==='new'&&xs.v.j.wallet===null);
  console.log('SIGNIN_FORK_SUMMARY',JSON.stringify({steps:R.steps.length,pass:R.steps.filter(s=>s.ok).length,wallet:W,onboardGas:ob.gas,bindGas:ob2.gas}));
  }finally{await M.close();}
});
