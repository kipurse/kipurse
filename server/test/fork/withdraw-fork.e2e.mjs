// FORK-ONLY end-to-end for one-tap "withdraw all" and pause durations (nothing is broadcast to a real network).
// Withdraw-all goes to the wallet's own owner (its Base Account) and works while AI payments are paused, revoked or expired;
// nobody else can execute it, and the server cannot change the destination.
import test from 'node:test';import assert from 'node:assert/strict';
import {createPublicClient,createTestClient,createWalletClient,http,parseAbi,getAddress,decodeAbiParameters,encodeFunctionData,keccak256,encodeAbiParameters,toHex,pad} from 'viem';import {base} from 'viem/chains';
import {WALLET_ABI,ETH_USD_FEED} from '../../src/v5/phone-signer.mjs';import {decodePolicyV5,v5Abi,permissionFromJson} from '../../src/v5/abi.mjs';
import {createOwnerWithdraw,checkWithdrawCalls,withdrawCalls} from '../../src/v5/owner-withdraw.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;const MANAGER='0xf85210B21cC50302F477BA56686d2019dC9b67Ad';
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)']);const AD=parseAbi(['function trust() view returns (address)']);
test('withdraw all + pause durations on a Base mainnet fork',{skip:!RPC||!PJ},async()=>{
  const perm=JSON.parse(PJ);const W=getAddress(perm.account),A=getAddress(perm.spender),USDC=getAddress(perm.token);const p=permissionFromJson(perm);
  const pub=createPublicClient({chain:base,transport:http(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:http(RPC)});
  const EXEC=getAddress(decodePolicyV5(perm.extraData).executor);const TRUST=await pub.readContract({address:A,abi:AD,functionName:'trust'});
  const OWNER=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  const ATT=getAddress(keccak256(toHex('fork-attacker')).slice(0,42));
  for(const a of [EXEC,OWNER,ATT,W]){await tc.impersonateAccount({address:a});await tc.setBalance({address:a,value:10n**18n});}
  const as=a=>createWalletClient({chain:base,transport:http(RPC),account:a});
  const send=async(from,to,data)=>{try{const h=await as(from).sendTransaction({to,data,value:0n,gas:1_500_000n});return (await pub.waitForTransactionReceipt({hash:h})).status;}catch{return 'reverted';}};
  const bal=a=>pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[a]});
  const deal=async(to,amt)=>{const slot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[to,9n]));await tc.setStorageAt({address:USDC,index:slot,value:pad(toHex((await bal(to))+amt),{size:32})});};
  const isPaused=()=>pub.readContract({address:TRUST,abi:v5Abi,functionName:'isPaused',args:[W]});
  const WD=createOwnerWithdraw({pub,wallet:W,owner:OWNER,token:USDC,feed:ETH_USD_FEED,script:()=>''});
  const withdrawNow=async label=>{const before=await bal(OWNER),wb=await bal(W);assert.ok(wb>0n,label+': wallet has USDC');
    const q=await WD.quote();assert.equal(q.to,OWNER);assert.equal(BigInt(q.amount),wb);
    const pl=await WD.prepare();assert.equal(checkWithdrawCalls(pl.calls,{wallet:W,owner:OWNER,token:USDC}),null);
    // the attacker cannot run the owner's batch, nor a batch paying himself
    assert.equal(await send(ATT,W,pl.calls[0].data),'reverted',label+': attacker cannot execute');
    assert.equal(await send(ATT,W,withdrawCalls({wallet:W,owner:ATT,token:USDC,amount:wb})[0].data),'reverted',label+': attacker cannot pay himself');
    assert.equal(await send(EXEC,W,pl.calls[0].data),'reverted',label+': the AI executor cannot execute');
    assert.equal(await send(OWNER,pl.calls[0].to,pl.calls[0].data),'success',label+': owner withdraw');
    assert.equal(await bal(W),0n,label+': wallet empty');assert.equal((await bal(OWNER))-before,wb,label+': all of it reached the owner');
    assert.equal((await WD.confirm(pl.id)).ok,true);return wb;};
  // 0) a tampered batch (any other destination) is refused by the checker the server and app both use
  assert.equal(checkWithdrawCalls(withdrawCalls({wallet:W,owner:ATT,token:USDC,amount:1n}),{wallet:W,owner:OWNER,token:USDC}),'destination_not_owner');
  // 1) executor pause (24 h) -> it expires by itself; re-arming works
  await deal(W,3_000_000n);
  assert.equal(await send(EXEC,A,encodeFunctionData({abi:v5Abi,functionName:'pause',args:[p]})),'success','executor pause');assert.equal(await isPaused(),true);
  await withdrawNow('paused');
  await tc.increaseTime({seconds:23*3600});await tc.mine({blocks:1});assert.equal(await isPaused(),true,'still paused at 23 h');
  await tc.increaseTime({seconds:2*3600});await tc.mine({blocks:1});assert.equal(await isPaused(),false,'expired after 24 h');
  assert.equal(await send(EXEC,A,encodeFunctionData({abi:v5Abi,functionName:'pause',args:[p]})),'success','re-arm');assert.equal(await isPaused(),true,'re-armed');
  // 2) AI permission revoked
  await deal(W,2_000_000n);assert.equal(await send(W,MANAGER,encodeFunctionData({abi:v5Abi,functionName:'revoke',args:[p]})),'success','revoke');
  await withdrawNow('revoked');
  // 3) permission expired (jump past its end)
  await deal(W,1_500_000n);const now=Number((await pub.getBlock()).timestamp);const gap=Math.max(Number(p.end)-now+86400,86400);
  await tc.increaseTime({seconds:gap});await tc.mine({blocks:1});await withdrawNow('expired');
  // 5) empty wallet -> nothing to sign
  await assert.rejects(WD.prepare(),/余额是 0/);
});

test('withdraw all includes the fee reserve (sweep + transfer) on a Base mainnet fork',{skip:!RPC||!PJ||!process.env.FORK_VAULT},async()=>{
  const perm=JSON.parse(PJ);const W=getAddress(perm.account),USDC=getAddress(perm.token);
  const pub=createPublicClient({chain:base,transport:http(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:http(RPC)});
  const OWNER=getAddress(decodeAbiParameters([{type:'address'}],await pub.readContract({address:W,abi:WALLET_ABI,functionName:'ownerAtIndex',args:[0n]}))[0]);
  const ATT=getAddress(keccak256(toHex('fork-attacker2')).slice(0,42));for(const a of [OWNER,ATT]){await tc.impersonateAccount({address:a});await tc.setBalance({address:a,value:10n**18n});}
  const as=a=>createWalletClient({chain:base,transport:http(RPC),account:a});
  const send=async(from,to,data)=>{try{const h=await as(from).sendTransaction({to,data,value:0n,gas:1_500_000n});return (await pub.waitForTransactionReceipt({hash:h})).status;}catch{return 'reverted';}};
  const bal=a=>pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[a]});
  const deal=async(to,amt)=>{const slot=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[to,9n]));await tc.setStorageAt({address:USDC,index:slot,value:pad(toHex((await bal(to))+amt),{size:32})});};
  // fee reserve (the wallet's own gas vault) comes back in the SAME withdrawal: sweep + transfer, all to the owner
  if(process.env.FORK_VAULT){const V=getAddress(process.env.FORK_VAULT);const VA=parseAbi(['function unreserved() view returns (uint256)']);
    if((await pub.getCode({address:V}))?.length>2){await deal(W,1_000_000n);await deal(V,250_000n);const ur=await pub.readContract({address:V,abi:VA,functionName:'unreserved'});assert.ok(ur>0n,'vault has a reserve');
      const WV=createOwnerWithdraw({pub,wallet:W,owner:OWNER,vault:V,token:USDC,feed:ETH_USD_FEED,script:()=>''});const q=await WV.quote();
      assert.equal(BigInt(q.amount),(await bal(W))+ur,'quote = wallet + reserve');const pl=await WV.prepare();assert.equal(pl.calls.length,2);
      assert.equal(checkWithdrawCalls(pl.calls,{wallet:W,owner:OWNER,token:USDC,vault:V}),null);
      assert.equal(await send(ATT,W,pl.calls[0].data),'reverted','attacker cannot sweep via the wallet');
      const before=await bal(OWNER);for(const c of pl.calls)assert.equal(await send(OWNER,c.to,c.data),'success','owner batch call');
      assert.equal(await bal(W),0n,'wallet empty');assert.equal(await pub.readContract({address:V,abi:VA,functionName:'unreserved'}),0n,'reserve empty');
      assert.equal((await bal(OWNER))-before,BigInt(q.amount),'owner got wallet + reserve');assert.equal((await WV.confirm(pl.id)).ok,true);}}
});
