// FORK-ONLY end-to-end for owner-initiated payments (nothing is broadcast to a real network).
// Needs a local anvil fork of Base mainnet and the public SpendPermission of an account to test with:
//   FORK_RPC=http://127.0.0.1:8560 FORK_PERMISSION_JSON='{"account":..}' node --test test/fork/owner-pay-fork.e2e.mjs
// Steps: phone V1 enrolled -> migrate to V2 (enroll, confirm, retire V1) -> owner-pay challenge -> "phone" P-256 signs ->
// submit -> real adapter payDirect by the impersonated executor -> payee received, fees charged, ledger row; then the
// negative paths and delete-everything.
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPublicClient,createTestClient,createWalletClient,http,parseAbi,getAddress,decodeAbiParameters,keccak256,toHex} from 'viem';import {base} from 'viem/chains';
import * as P256 from 'ox/P256';
import {createPhoneEnrollment,WALLET_ABI} from '../../src/v5/phone-signer.mjs';import {createOwnerPay} from '../../src/v5/owner-pay.mjs';import {createEngineV5} from '../../src/v5/engine.mjs';
import {decodePolicyV5} from '../../src/v5/abi.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)']);const AD=parseAbi(['function trust() view returns (address)','function feeFor(uint256) view returns (uint256)']);
test('owner pay on a Base mainnet fork (phone V2, migration, delete)',{skip:!RPC||!PJ},async()=>{
  const perm=JSON.parse(PJ);const W=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);
  const pub=createPublicClient({chain:base,transport:http(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:http(RPC)});
  const pol=decodePolicyV5(perm.extraData);const EXEC=getAddress(pol.executor);const trust=await pub.readContract({address:A,abi:AD,functionName:'trust'});
  const OWNER=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  for(const a of [EXEC,OWNER]){await tc.impersonateAccount({address:a});await tc.setBalance({address:a,value:10n**18n});}
  {// FIXTURE FIX: the fixture wallet is empty on mainnet now (owner withdrew everything) -> top it up on the FORK from a USDC whale
    const WH='0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A';await tc.impersonateAccount({address:WH});await tc.setBalance({address:WH,value:10n**18n});
    const h=await createWalletClient({chain:base,transport:http(RPC),account:WH}).writeContract({address:USDC,abi:parseAbi(['function transfer(address,uint256) returns (bool)']),functionName:'transfer',args:[W,50_000_000n]});await pub.waitForTransactionReceipt({hash:h});}
  const as=a=>createWalletClient({chain:base,transport:http(RPC),account:a});
  const run=async(calls,from)=>{for(const c of calls){const h=await as(from).sendTransaction({to:c.to,data:c.data,value:0n});const r=await pub.waitForTransactionReceipt({hash:h});assert.equal(r.status,'success');}};
  // --- phone keys (stand-ins for the Secure Enclave keys) ---
  const kp=()=>{const privateKey=P256.randomPrivateKey();const pk=P256.getPublicKey({privateKey});return {privateKey,x:toHex(pk.x,{size:32}),y:toHex(pk.y,{size:32})};};
  const S={};const save=()=>{};const caps=()=>({single:1000000n,daily:2000000n});
  const mk=v=>createPhoneEnrollment({S,save,pub,wallet:W,trust,owner:OWNER,chainId:8453,base:()=>'http://fork.invalid',caps,script:()=>'',approverVersion:v});
  const k1=kp(),k2=kp();
  let PH=mk('v1');let e=await PH.enroll(k1);await run(PH.calls(S.phone.pending[e.id]),OWNER);assert.equal((await PH.confirm(e.id)).ok,true);
  // migration to V2
  PH=mk('v2');e=await PH.enroll(k2);await run(PH.calls(S.phone.pending[e.id]),OWNER);const c2=await PH.confirm(e.id);assert.equal(c2.ok,true);assert.equal(PH.active().version,'v2');
  assert.ok(PH.retiring(),'old V1 approver queued for removal');await run(await PH.retiringCalls(),OWNER);assert.equal((await PH.retiringConfirm()).ok,true);assert.equal(PH.retiring(),null);
  assert.equal(await pub.readContract({address:W,abi:WALLET_ABI,functionName:'isOwnerAddress',args:[c2.approver]}),true);
  // --- engine on the fork, executor impersonated ---
  const dir=mkdtempSync(join(tmpdir(),'opfork-'));
  const engine=createEngineV5({chainId:8453,rpc:RPC,adapter:A,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',token:USDC,policy:pol,permission:perm,impersonateExecutor:EXEC,allowLegacyOnMainnet:true,
    gasPricing:{usdcPerEth:'3000000000',gasPriceWei:'10000000'},fee:{ppm:'1000'},merchantRegistry:[],retryDelayMs:50,ownerRulesDir:join(dir,'rules'),trustRequestsFile:join(dir,'tr.json')},{ledgerFile:join(dir,'l.sqlite'),agentDefault:'owner'});
  const KNOWN=getAddress(keccak256(toHex('fork-known-payee')).slice(0,42)),NEW=getAddress(keccak256(toHex('fork-new-payee')).slice(0,42));
  const store={};let session=true;
  const OP=createOwnerPay({enabled:true,store,save,resolveTenant:async()=>session?{wallet:W,chainId:8453,token:USDC,pub,phone:PH,engine,knownPayees:async()=>[{address:KNOWN,name:'Known'}]}:null});
  const sign=(d,k=k2)=>{const s=P256.sign({payload:d,privateKey:k.privateKey});return {r:toHex(s.r,{size:32}),s:toHex(s.s,{size:32})};};
  const bal=a=>pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[a]});
  // new payee without the extra confirmation -> refused
  let [code,o]=await OP._challenge(await (async()=>({wallet:W,chainId:8453,token:USDC,pub,phone:PH,engine,knownPayees:async()=>[{address:KNOWN}]}))(),{payee:NEW,amount:'10000'});assert.equal(code,409);assert.equal(o.error,'new_payee_needs_confirm');
  const ten={wallet:W,chainId:8453,token:USDC,pub,phone:PH,engine,knownPayees:async()=>[{address:KNOWN}]};
  // wrong key -> refused, challenge consumed
  [code,o]=await OP._challenge(ten,{payee:KNOWN,amount:'10000'});assert.equal(code,200,JSON.stringify(o));
  let [c3,o3]=await OP._submit(ten,{id:o.id,...sign(o.digest,k1)});assert.equal(c3,403);[c3,o3]=await OP._submit(ten,{id:o.id,...sign(o.digest)});assert.equal(c3,400,'single use');
  // happy path, known payee
  const w0=await bal(W),p0=await bal(KNOWN);
  [code,o]=await OP._challenge(ten,{payee:KNOWN,amount:'10000'});assert.equal(code,200);assert.equal(o.chainId,8453);
  [c3,o3]=await OP._submit(ten,{id:o.id,...sign(o.digest)});assert.equal(c3,200,JSON.stringify(o3));
  assert.equal((await bal(KNOWN))-p0,10000n,'payee got exactly the amount');
  const spent=w0-(await bal(W));const fee=await pub.readContract({address:A,abi:AD,functionName:'feeFor',args:[10000n]});
  assert.equal(spent,10000n+fee+BigInt(o3.networkFee||0),'wallet paid amount + protocol fee + network fee');
  assert.equal(store.ownerPay[W.toLowerCase()].payments[0].txHash,o3.txHash);assert.equal(store.ownerPay[W.toLowerCase()].payments[0].fee,fee.toString());
  // explicit new address with the extra confirmation
  [code,o]=await OP._challenge(ten,{payee:NEW,amount:'5000',confirmNewPayee:true});assert.equal(code,200);assert.equal(o.newPayee,true);
  [c3,o3]=await OP._submit(ten,{id:o.id,...sign(o.digest)});assert.equal(c3,200,JSON.stringify(o3));assert.equal(await bal(NEW),5000n);
  // above the phone's own per-payment cap (1 USDC) -> the approver refuses on chain, no money moves
  const nb=await bal(W);[code,o]=await OP._challenge(ten,{payee:KNOWN,amount:'1000001'});
  if(code===200){[c3,o3]=await OP._submit(ten,{id:o.id,...sign(o.digest)});assert.notEqual(c3,200);}assert.equal(await bal(W),nb);
  // phone removed from the wallet -> refused before signing
  const idx=await PH.findIndex(PH.active().approver);await run([{to:W,data:(await PH.revokeCalls())[0].data}],OWNER);
  [code,o]=await OP._challenge(ten,{payee:KNOWN,amount:'10000'});assert.equal(code,409);assert.equal(o.error,'phone_not_owner');
  // delete everything for this tenant
  OP.forget(W);PH.forget();assert.equal(store.ownerPay[W.toLowerCase()],undefined);assert.equal(S.phone.active,null);assert.ok(idx>=0);
});
