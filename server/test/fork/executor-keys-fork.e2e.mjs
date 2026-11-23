// FORK-ONLY: per-user executor keys. The owner's limits change (signed by his Base Account) moves wallet A to its OWN executor key;
// then keys of other users and the old shared key cannot act for A on chain, and the keyring refuses cross-wallet use.
// (was: the multi-user gateway. Tenant A = migrated single-wallet deployment (legacy URLs, files untouched);
// tenant B = a brand-new user created through /onboard/new (factory wallet + permission + phone approver V2 in his own batch).
// Then cross-tenant attacks, wallet discovery, erase isolation.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,getAddress,decodeAbiParameters,toHex,hashMessage} from 'viem';import {base} from 'viem/chains';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import * as P256 from 'ox/P256';
import {WALLET_ABI} from '../../src/v5/phone-signer.mjs';import {decodePolicyV5} from '../../src/v5/abi.mjs';import {hashToken,mintAgentToken} from '../../src/v4/agents.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;const GW=new URL('../../',import.meta.url).pathname;
const AD=parseAbi(['function trust() view returns (address)','function vaultAddress(address) view returns (address)']);
test('per-user executor keys: rotation by owner signature, cross-user attacks',{skip:!RPC||!PJ,timeout:600000},async()=>{
  const perm=JSON.parse(PJ);const W=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);const pol=decodePolicyV5(perm.extraData);const EXEC=getAddress(pol.executor);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});const vault=await pub.readContract({address:A,abi:AD,functionName:'vaultAddress',args:[W]});
  const OWNER=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  for(const a of [EXEC,OWNER]){await tc.impersonateAccount({address:a});await tc.setBalance({address:a,value:10n**18n});}
  { const whale='0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';await tc.impersonateAccount({address:whale});await tc.setBalance({address:whale,value:10n**18n});const wc=createWalletClient({chain:base,transport:vh(RPC),account:whale});const h=await wc.writeContract({address:USDC,abi:parseAbi(['function transfer(address,uint256) returns (bool)']),functionName:'transfer',args:[W,20_000000n]});await pub.waitForTransactionReceipt({hash:h}); } // fresh fork: wallet needs USDC to pay fees in USDC
  const run=async(calls,from)=>{let g=0n;for(const c of calls){const h=await createWalletClient({chain:base,transport:vh(RPC),account:from}).sendTransaction({to:c.to,data:c.data,value:BigInt(c.value??0)});const r=await pub.waitForTransactionReceipt({hash:h});assert.equal(r.status,'success');g+=r.gasUsed;}return g;};
  const kp=()=>{const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});return {privateKey,x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};};
  const sign=(d,k)=>{const s=P256.sign({payload:d,privateKey:k.privateKey});return {r:toHex(s.r,{size:32}),s:toHex(s.s,{size:32})};};
  const dir=mkdtempSync(join(tmpdir(),'mt-'));const CONF=join(dir,'conf'),DATA=join(dir,'data');fs.mkdirSync(CONF);fs.mkdirSync(DATA);
  const tokA=mintAgentToken();fs.writeFileSync(join(CONF,'agents.json'),JSON.stringify([{id:'grok-bot',tokenSha256:hashToken(tokA)}]));
  fs.writeFileSync(join(CONF,'mainnet-trustflow.config.json'),JSON.stringify({chainId:8453,wallet:W,ownerBaseAccount:OWNER,token:USDC,adapter:A,trust,vault,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',
    currentPermission:perm,newCaps:{single:pol.single},engine:{chainId:8453,rpc:RPC,adapter:A,trust,token:USDC,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',ownerSigner:{wallet:W,ownerIndex:0},
      ownerRulesDir:join(DATA,'owner-rules'),ledgerFile:join(DATA,'ledger.sqlite')}}));
  const SF=join(DATA,'runtime-state.json');fs.writeFileSync(SF,JSON.stringify({permission:perm}));const before=fs.readFileSync(SF,'utf8');
  process.env.KIPURSE_GATEWAY=GW;process.env.KIPURSE_MAIN_CONFIG_DIR=CONF;process.env.KIPURSE_MAIN_DATA_DIR=DATA;
  console.log('STEP import');
  const {startMainnet}=await import('../../mainnet/mainnet-owner-launch.mjs?ek');const port=18700+Math.floor(Math.random()*200);
  const M=await startMainnet({fork:true,agentPort:port,ownerPort:port+1000,stateFile:SF,overrides:{rpc:RPC,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,gasMode:'legacy',onboard:true,perUserExecutor:true,executorDir:join(DATA,'executors'),userErase:true,ownerPay:true,phoneOnChain:async()=>true,
    gasPricing:{usdcPerEth:'3000000000',gasPriceWei:'10000000'},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,publicBase:'http://fork.invalid',kvFile:join(DATA,'kv.sqlite')}});
  console.log('STEP started');
  const U=`http://127.0.0.1:${port}`;const R={};
  const call=async(path,{method='GET',body,headers={}}={})=>{const r=await fetch(U+path,{method,headers:{'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});let j=null;try{j=await r.json();}catch{}return {status:r.status,j};};

  const {createExecutorKeyring}=await import('../../src/v5/executor-keys.mjs');const {v5Abi,permissionFromJson}=await import('../../src/v5/abi.mjs');const {encodeFunctionData}=await import('viem');
  const KR=createExecutorKeyring({dir:join(DATA,'executors'),allowPlain:true});
  const send=async(acct,to,data)=>{try{const wc=createWalletClient({chain:base,transport:vh(RPC),account:acct});const h=await wc.sendTransaction({to,data,value:0n,gas:800000n});return (await pub.waitForTransactionReceipt({hash:h})).status;}catch{return 'reverted';}};
  const TA0=await M.tenant(W);assert.equal(TA0.cfg?.executorMode??'shared_legacy','shared_legacy','before: legacy shared key');
  // owner rotates: the limits page batch names A's own key (Base Account signature = impersonated OWNER on the fork)
  const pr=await call('/owner/limits/prepare',{method:'POST',body:{single:String(pol.single),daily:String(pol.daily),term:String(BigInt(pol.single)*10n),days:30}});assert.equal(pr.status,200,JSON.stringify(pr.j));
  await run(pr.j.calls,OWNER);let cf;for(let i=0;i<5&&!(cf?.j?.ok);i++)cf=await call('/owner/limits/confirm',{method:'POST',body:{id:pr.j.id}});assert.equal(cf.j.ok,true,JSON.stringify(cf.j));
  const TA=await M.tenant(W);const PA=permissionFromJson(TA.S.permission);const exA=getAddress(decodePolicyV5(TA.S.permission.extraData).executor);
  assert.equal(exA,KR.address(W),'new permission names A\'s own key');assert.notEqual(exA,EXEC,'not the shared key');
  const keyA=KR.accountFor(W,TA.S.permission);assert.equal(keyA.address,exA);
  // another user's key (B) and the old shared key cannot act for A
  const WB=getAddress('0x2000000000000000000000000000000000000004');KR.ensure(WB);const fakePB={...TA.S.permission,account:WB};
  assert.throws(()=>KR.accountFor(WB,TA.S.permission),/another wallet/,'keyring: B cannot get a key for A\'s permission');
  assert.throws(()=>KR.accountFor(W,fakePB),/another wallet/);
  const keyB=privateKeyToAccount(JSON.parse(fs.readFileSync(KR._file(WB),'utf8')).key);assert.notEqual(keyB.address,keyA.address);
  for(const a of [keyA.address,keyB.address])await tc.setBalance({address:a,value:10n**17n});
  const pauseA=encodeFunctionData({abi:v5Abi,functionName:'pause',args:[PA]});
  assert.equal(await send(keyB,A,pauseA),'reverted','B\'s key cannot pause A');
  assert.equal(await send(EXEC,A,pauseA),'reverted','old shared key cannot act for A any more');
  assert.equal(await send(keyA,A,pauseA),'success','A\'s own key works for A');
  // swapping key files between users does not help: A's file under B's name is rejected
  fs.copyFileSync(KR._file(W),KR._file(WB));assert.throws(()=>KR.accountFor(WB,fakePB),/does not belong|another wallet/);
  // erase deletes the key
  KR.forget(W);assert.equal(fs.existsSync(KR._file(W)),false);assert.throws(()=>KR.accountFor(W,TA.S.permission),/no executor key/);
  await M.close?.();
});
