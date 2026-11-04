// FORK-ONLY: one-time setup ("开通") = ONE atomic batch from the owner's Base Account (one signature, one gas payment):
// spend permission + caps, phone approver V2 deploy + addOwner (Face ID + Siri), dead-approver removal. Also a brand-new wallet.
//   FORK_RPC=http://127.0.0.1:18591 FORK_PERMISSION_JSON='{...}' node --test test/fork/onboard-fork.e2e.mjs
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import http from 'node:http';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,getAddress,decodeAbiParameters,encodeAbiParameters,encodeFunctionData,toHex,serializeTransaction} from 'viem';import {base} from 'viem/chains';
import * as P256 from 'ox/P256';
import {createPhoneEnrollment,WALLET_ABI,approverInit,DETERMINISTIC_DEPLOYER} from '../../src/v5/phone-signer.mjs';import {createOnboarding,ONBOARD_GAS} from '../../src/v5/onboard.mjs';
import {buildMigrationPlanV5} from '../../src/v5/plan.mjs';import {decodePolicyV5,v5Abi,permissionFromJson} from '../../src/v5/abi.mjs';import {limitsWindow} from '../../src/v5/limits-public.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;const MANAGER='0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);
const AD=parseAbi(['function trust() view returns (address)','function fees() view returns (address)','function vaultAddress(address) view returns (address)']);
const BA_ABI=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable']);
const FACTORY='0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';const FACT_ABI=parseAbi(['function createAccount(bytes[] owners,uint256 nonce) payable returns (address)','function getAddress(bytes[] owners,uint256 nonce) view returns (address)']);
const L1_ORACLE='0x420000000000000000000000000000000000000F';const L1_ABI=parseAbi(['function getL1Fee(bytes) view returns (uint256)']);
test('one-time setup: one atomic Base Account batch (permission+caps, approver V2, dead owners), confirm on chain, Siri ready',{skip:!RPC||!PJ,timeout:400000},async()=>{
  const perm=JSON.parse(PJ);const W=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  assert.equal(await pub.getChainId(),8453);const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});
  const OWNER=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  assert.ok((await pub.getCode({address:OWNER}))?.length>2,'owner is a smart account (Base Account) on the fork');
  await tc.impersonateAccount({address:OWNER});await tc.setBalance({address:OWNER,value:10n**18n});
  const whale='0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';await tc.impersonateAccount({address:whale});await tc.setBalance({address:whale,value:10n**18n});
  const fund=async(to,amt)=>{const h=await createWalletClient({chain:base,transport:vh(RPC),account:whale}).writeContract({address:USDC,abi:ERC20,functionName:'transfer',args:[to,amt]});await pub.waitForTransactionReceipt({hash:h});};
  await fund(OWNER,5_000_000n);
  // the Base Account sends the calls as ONE batch (its own executeBatch, same as wallet_sendCalls atomicRequired)
  const sendBatch=async calls=>{const data=encodeFunctionData({abi:BA_ABI,functionName:'executeBatch',args:[calls.map(c=>({target:getAddress(c.to),value:0n,data:c.data}))]});
    try{const h=await createWalletClient({chain:base,transport:vh(RPC),account:OWNER}).sendTransaction({to:OWNER,data,gas:6_000_000n});const r=await pub.waitForTransactionReceipt({hash:h});
      const l1=await pub.readContract({address:L1_ORACLE,abi:L1_ABI,functionName:'getL1Fee',args:[serializeTransaction({chainId:8453,type:'eip1559',to:OWNER,data,nonce:1,gas:r.gasUsed,maxFeePerGas:1n,maxPriorityFeePerGas:1n})]});
      return {status:r.status,gas:r.gasUsed,l1Wei:l1,bytes:(data.length-2)/2};}catch(e){return {status:'reverted',err:String(e.shortMessage??e.message).slice(0,120)};}};
  const run1=async c=>{const h=await createWalletClient({chain:base,transport:vh(RPC),account:OWNER}).sendTransaction({to:c.to,data:c.data,value:0n});assert.equal((await pub.waitForTransactionReceipt({hash:h})).status,'success');};
  const kp=()=>{const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});return {privateKey,x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};};
  const isOwner=(w,a)=>pub.readContract({address:w,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[a]});
  const valid=p=>pub.readContract({address:MANAGER,abi:v5Abi,functionName:'isValid',args:[permissionFromJson(p)]});
  const ppm=await pub.readContract({address:await pub.readContract({address:A,abi:AD,functionName:'fees'}),abi:v5Abi,functionName:'feePpm'});
  const chainNow=async()=>Number((await pub.getBlock()).timestamp);
  const dir=mkdtempSync(join(tmpdir(),'onb-'));const S={permission:perm};const save=()=>fs.writeFileSync(join(dir,'s.json'),JSON.stringify(S));
  const pol=()=>decodePolicyV5(permissionFromJson(S.permission).extraData);
  // same shape as planCapChange() in mainnet-owner-launch.mjs
  const planFor=async(c,{wallet=W,revoke=[S.permission],zr={vault:W,buffer:0}}={})=>{const cp=pol();const mn=(a,b)=>(BigInt(a)<BigInt(b)?BigInt(a):BigInt(b)).toString();
    return buildMigrationPlanV5({chainId:8453,wallet,owner:OWNER,adapter:A,trust,token:USDC,manager:MANAGER,executor:cp.executor,guardian:cp.guardian,registry:cp.registry,headroom:false,maxFeePpm:cp.maxFeePpm,maxNetworkFee:cp.maxNetworkFee,fee:{ppm:String(ppm)},
      stated:{single:c.single.toString(),daily:c.daily.toString(),term:c.term.toString(),openSingle:mn(cp.openSingle,c.single),openDaily:mn(cp.openDaily,c.daily),verifiedSingle:mn(cp.verifiedSingle,c.single),verifiedDaily:mn(cp.verifiedDaily,c.daily)},
      ...limitsWindow(await chainNow(),c.days,S.permission.end),salt:BigInt(S.permission.salt)+1n+BigInt(Math.floor(Math.random()*1e6)),revoke,zeroReserve:zr});};
  const PH=createPhoneEnrollment({S,save,pub,wallet:W,trust,owner:OWNER,chainId:8453,base:()=>'http://fork.invalid',caps:()=>({single:1000000n,daily:2000000n}),script:()=>'',approverVersion:'v2'});
  const ONB=createOnboarding({S,save,pub,wallet:W,owner:OWNER,trust,base:()=>'http://fork.invalid',phone:PH,plan:c=>planFor(c),enabled:true,token:USDC,ownerPay:()=>true,
    confirmPlan:async pl=>{if(!await valid(pl.permission))return {valid:false};S.permission=pl.permission;save();return {valid:true,permissionHash:pl.permissionHash};},script:()=>'/*js*/'});
  const readBody=async req=>{let b='';for await(const c of req)b+=c;try{return b?JSON.parse(b):{};}catch{return {};}};
  const srv=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://x');if(await ONB.handle(req,res,u,{readBody}))return;res.writeHead(404);res.end();});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const B=`http://127.0.0.1:${srv.address().port}`;
  const post=async(p,b)=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return [r.status,await r.json()];};
  const R={};
  try{
    // prior life: a phone V2 was bound, then "delete my data" -> its approver is a dead owner (address kept, nothing else)
    const k0=kp();const e0=await PH.enroll(k0);await fund(W,1_000_000n);for(const c of PH.calls(S.phone.pending[e0.id]))await run1(c);assert.equal((await PH.confirm(e0.id)).ok,true);
    const deadA=S.phone.active.approver;PH.forget();assert.deepEqual(S.phone.dead,[getAddress(deadA)]);
    // ---- 1) re-setup through HTTP: quote, start, page, ONE batch, confirm
    let [qc,q]=[0,null];{const r=await fetch(B+'/onboard/quote');qc=r.status;q=await r.json();}assert.equal(qc,200);assert.equal(q.sponsoredByKipurse,false);assert.equal(q.signatures,1);
    const k1=kp();let [c,o]=await post('/onboard/start',{x:k1.x,y:k1.y,single:'2',daily:'5',term:'50',days:90});assert.equal(c,200,JSON.stringify(o));
    R.labels=o.labels;R.removes=o.removes;assert.deepEqual(o.removes,[getAddress(deadA)]);
    const html=await (await fetch(B+'/onboard?id='+o.id)).text();assert.ok(html.includes(o.fingerprint)&&(html.includes('完全一样')||html.includes('exactly')));
    const calls=JSON.parse(html.match(/id=kp-data>([^<]*)<\/script>/)[1]).calls;assert.equal(calls.length,4);
    // confirm before the batch lands: nothing switches
    [c,o.pre]=await post('/onboard/confirm',{id:o.id});assert.equal(o.pre.ok,false);const permBefore=JSON.stringify(S.permission);assert.equal(JSON.stringify(S.permission),permBefore);
    // atomicity: a tampered batch (bad last call) reverts EVERYTHING
    const bad=[...calls.slice(0,3),{to:W,data:encodeFunctionData({abi:WALLET_ABI,functionName:'removeOwnerAtIndex',args:[0n,'0x'+'00'.repeat(32)]})}];
    const rb=await sendBatch(bad);R.tamperedBatch=rb.status;assert.equal(rb.status,'reverted');
    assert.equal(await pub.getCode({address:o.approver}).then(x=>!x||x==='0x'),true,'no approver deployed');assert.equal(await isOwner(W,deadA),true,'dead owner untouched');
    // the real batch
    const rs=await sendBatch(calls);assert.equal(rs.status,'success');R.resetup={gas:rs.gas.toString(),l1Wei:rs.l1Wei.toString(),calldataBytes:rs.bytes};
    [c,o.done]=await post('/onboard/confirm',{id:o.id});assert.equal(o.done.ok,true,JSON.stringify(o.done));R.confirm=o.done;
    assert.equal(o.done.siri,true);assert.deepEqual(o.done.deadLeft,[]);assert.equal(await isOwner(W,deadA),false);assert.equal(await isOwner(W,o.approver),true);
    assert.equal(await valid(S.permission),true);const p=pol();R.newCaps={single:p.single,daily:p.daily,term:p.term};assert.equal(BigInt(p.single),2_000_000n);
    assert.equal(PH.active().version,'v2');assert.equal((await PH.payCapable()).ok,true);assert.equal(S.phone.dead,undefined);
    // ---- 2) brand-new user: wallet created + permission/caps + vault gas buffer + approver, all in ONE Base Account batch
    const owners=[encodeAbiParameters([{type:'address'}],[OWNER])];const nonce=BigInt(Date.now());
    const W2=getAddress(await pub.readContract({address:FACTORY,abi:FACT_ABI,functionName:'getAddress',args:[owners,nonce]}));
    const V2=getAddress(await pub.readContract({address:A,abi:AD,functionName:'vaultAddress',args:[W2]}));
    const c2={single:1_000_000n,daily:5_000_000n,term:20_000_000n,days:90};const pl2=await planFor(c2,{wallet:W2,revoke:[],zr:{vault:V2,buffer:200000}});
    const k2=kp();const a2=approverInit({wallet:W2,trust,x:k2.x,y:k2.y,maxSingle:c2.single,maxDaily:c2.daily,version:'v2'});
    const fresh=[{to:FACTORY,data:encodeFunctionData({abi:FACT_ABI,functionName:'createAccount',args:[owners,nonce]})},
      {to:USDC,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[W2,1_000_000n]})},   // first deposit, same signature
      {to:DETERMINISTIC_DEPLOYER,data:a2.deployData},{to:W2,data:pl2.walletExecuteBatch.data},
      {to:W2,data:encodeFunctionData({abi:WALLET_ABI,functionName:'addOwnerAddress',args:[a2.address]})}];
    const rf=await sendBatch(fresh);R.newUser={status:rf.status,err:rf.err,calls:fresh.length,planLabels:pl2.calls.map(x=>x.label)};
    if(rf.status==='success'){R.newUser.gas=rf.gas.toString();R.newUser.l1Wei=rf.l1Wei.toString();R.newUser.calldataBytes=rf.bytes;
      assert.equal(await valid(pl2.permission),true);assert.equal(await isOwner(W2,a2.address),true);R.newUser.vaultUSDC=(await pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[V2]})).toString();}
    const gp=await createPublicClient({chain:base,transport:vh('https://mainnet.base.org')}).getGasPrice();R.mainnetGasPriceWei=gp.toString();R.ONBOARD_GAS=ONBOARD_GAS.toString();
    console.log('RESULT',JSON.stringify(R,(k,v)=>typeof v==='bigint'?v.toString():v));
    assert.equal(rf.status,'success',rf.err);
  }finally{srv.close();}
});
