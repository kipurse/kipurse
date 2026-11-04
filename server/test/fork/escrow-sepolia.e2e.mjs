// TESTNET ONLY: KipurseEscrowV1 + real V52 contracts on a Base Sepolia anvil fork, through the production engine + pay entry.
// Env: X402_RPC, X402_DEPLOY (script/E2EX402Sepolia.s.sol output incl. escrow), X402_EXEC, OWNER_PK_FILE (throwaway testnet owner key file).
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPublicClient,createWalletClient,createTestClient,http as vh,parseAbi,getAddress,keccak256,encodeAbiParameters,toHex} from 'viem';import {baseSepolia} from 'viem/chains';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {createEngineV5} from '../../src/v5/engine.mjs';import {createBuy} from '../../src/v5/buy.mjs';import {BEGINNER_DEFAULTS} from '../../src/v5/mandates.mjs';import {createEscrow,ESCROW_ABI} from '../../src/v5/escrow.mjs';
const RUN=Date.now().toString(36);const RPC=process.env.X402_RPC,DJ=process.env.X402_DEPLOY,EXEC=process.env.X402_EXEC,OPK=process.env.OWNER_PK_FILE;
test('escrow on the real contracts: pay in (merchant-gated) -> merchant confirms -> release; timeout refund; owner cancel; limits + sanctions',{skip:!RPC||!DJ||!EXEC||!OPK,timeout:300000},async()=>{
  const dep=JSON.parse(fs.readFileSync(DJ,'utf8'));const USDC=getAddress(dep.token),ESC=getAddress(dep.escrow),W=getAddress(dep.wallet);
  const pub=createPublicClient({chain:baseSepolia,transport:vh(RPC)});const tc=createTestClient({chain:baseSepolia,mode:'anvil',transport:vh(RPC)});
  const bal=a=>pub.readContract({address:USDC,abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[a]});
  await tc.impersonateAccount({address:EXEC});await tc.setBalance({address:EXEC,value:10n**18n});
  await tc.setStorageAt({address:USDC,index:keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[W,9n])),value:toHex(50_000_000n,{size:32})});
  const ex=createWalletClient({chain:baseSepolia,transport:vh(RPC),account:getAddress(EXEC)});
  const write=async(fn,args)=>{const h=await ex.writeContract({address:ESC,abi:ESCROW_ABI,functionName:fn,args});const r=await pub.waitForTransactionReceipt({hash:h});if(r.status!=='success')throw Error(fn+' reverted');return h;};
  const upGas=BigInt((await (await fetch('https://sepolia.base.org',{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice"}'})).json()).result);
  const perm={account:W,spender:dep.adapter,token:USDC,allowance:'100000000',period:2592000,start:dep.start,end:dep.end,salt:'1',extraData:dep.extraData};const dir=mkdtempSync(join(tmpdir(),'esc-'));
  const engine=createEngineV5({chainId:84532,rpc:RPC,adapter:dep.adapter,trust:dep.trust,token:USDC,manager:dep.manager,permission:perm,impersonateExecutor:EXEC,gasMode:'legacy',prepareConfirmations:1,
    gasPricing:{usdcPerEth:'3000000000',marginBps:0,gasPriceWei:upGas.toString()},ownerRulesDir:join(dir,'rules'),escrow:{address:ESC},sanctionsExtra:['0x00000000000000000000000000000000000005d1']},{ledgerFile:join(dir,'l.sqlite')});
  engine.mandates.propose({items:BEGINNER_DEFAULTS.map(d=>({...d}))});const approve=()=>{for(const p of engine.mandates.proposals())engine.mandates.approve(p.id,()=>true);};approve();
  const buy=createBuy(engine,{sleep:async()=>{},waitMs:0});const E=createEscrow({buy,pub,write,address:ESC});
  const mAcct=privateKeyToAccount(generatePrivateKey());const M=mAcct.address;
  // 1) new merchant: Face ID first (gated on the MERCHANT, not the trusted escrow address)
  const a0=await E.pay({merchant:M,merchantName:'Shoe Shop',amount:'2',item:'shoes',idempotencyKey:'idem-esc-'+RUN+'A'},'grok');assert.equal(a0.decision,'ask_owner',JSON.stringify(a0).slice(0,300));assert.equal(a0.nothingPaid,true);
  approve();const w0=await bal(W),e0=await bal(ESC);
  const a=await E.pay({merchant:M,merchantName:'Shoe Shop',amount:'2',item:'shoes',idempotencyKey:'idem-esc-'+RUN+'A'},'grok');assert.equal(a.state,'paid',JSON.stringify(a,(k,v)=>typeof v==='bigint'?v.toString():v).slice(0,600));
  assert.equal(a.escrow.state,'open');assert.equal(a.fee,'2000','0.1% once');assert.equal(await bal(ESC),e0+2_000_000n);assert.equal(w0-await bal(W),2_000_000n+2000n+BigInt(a.networkFee));
  const b=await E.pay({merchant:M,merchantName:'Shoe Shop',amount:'1',item:'never shipped',idempotencyKey:'idem-esc-'+RUN+'B',deadlineSec:3600},'grok');assert.equal(b.state,'paid');
  const c=await E.pay({merchant:M,merchantName:'Shoe Shop',amount:'1',item:'changed my mind',idempotencyKey:'idem-esc-'+RUN+'C'},'grok');assert.equal(c.state,'paid');
  // limits + sanctions still apply to escrow payments
  const big=await E.pay({merchant:M,merchantName:'Shoe Shop',amount:'6',item:'big',idempotencyKey:'idem-esc-'+RUN+'D'},'grok');assert.notEqual(big.state,'paid');assert.equal(big.nothingPaid,true);
  const sx=await E.pay({merchant:'0x00000000000000000000000000000000000005d1',amount:'1',item:'x',idempotencyKey:'idem-esc-'+RUN+'S'},'grok');assert.equal(sx.reason,'SANCTIONED_ADDRESS');
  const nf=await buy.buy({to:ESC,amount:'1',merchant:'escrow',item:'no merchant',idempotencyKey:'idem-esc-'+RUN+'N'},'grok');assert.equal(nf.reason,'escrow_needs_merchant');
  // owner cancels C (owner key signs wallet.execute)
  const owner=privateKeyToAccount(fs.readFileSync(OPK,'utf8').match(/OWNER_PK=(0x[0-9a-fA-F]{64})/)[1]);const ow=createWalletClient({chain:baseSepolia,transport:vh(RPC),account:owner});
  const wb=await bal(W);const oc=E.ownerCall(W,'ownerCancel',c.escrow.id);await pub.waitForTransactionReceipt({hash:await ow.sendTransaction({to:oc.to,data:oc.data})});
  assert.equal((await E.status(c.escrow.id)).state,'refunded');assert.equal(await bal(W),wb+1_000_000n);
  // merchant confirms A with a signature relayed by the gateway; release only after the review window
  const sig=await mAcct.sign({hash:await E.fulfilledDigest(a.escrow.id)});await E.confirmFulfilled(a.escrow.id,sig);assert.equal((await E.status(a.escrow.id)).state,'fulfilled');
  await assert.rejects(E.release(a.escrow.id));
  await tc.increaseTime({seconds:86400+3700});await tc.mine({blocks:1});
  await E.release(a.escrow.id);assert.equal(await bal(M),2_000_000n);
  const wr=await bal(W);await E.refundExpired(b.escrow.id);assert.equal(await bal(W),wr+1_000_000n);assert.equal(await bal(M),2_000_000n);
  assert.equal(await bal(ESC),e0,'escrow empty again');
  // crash between pay-in and open: the retry opens the already-paid deposit (no second payment)
  const k='idem-esc-'+RUN+'R';const r1=await buy.buy({to:ESC,amount:'1',merchant:'Shoe Shop',item:'resume',escrowFor:M,idempotencyKey:k},'grok');assert.equal(r1.state,'paid');
  const wbr=await bal(W);const r2=await E.pay({merchant:M,merchantName:'Shoe Shop',amount:'1',item:'resume',idempotencyKey:k},'grok');assert.equal(r2.escrow?.state,'open',JSON.stringify(r2).slice(0,300));assert.equal(await bal(W),wbr,'not paid twice');assert.equal(await bal(ESC),e0+1_000_000n);
  console.log('ESCROW_E2E',JSON.stringify({fee:a.fee,networkFee:a.networkFee,openTx:a.escrow.openTx,big:big.reason??big.decision}));
});
