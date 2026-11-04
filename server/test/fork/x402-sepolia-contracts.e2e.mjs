// TESTNET ONLY: the REAL Kipurse V52 contracts (script/E2EX402Sepolia.s.sol, deployed on a Base Sepolia anvil fork or Base Sepolia)
// + real Base Sepolia USDC + the OFFICIAL @x402/evm facilitator + the production engine and pay entry (createBuy).
// Env: X402_DIR (node_modules with @x402/*), X402_RPC (anvil fork of Base Sepolia), X402_DEPLOY (deploy json), X402_EXEC (executor address, impersonated).
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createPublicClient,createWalletClient,createTestClient,http as vh,parseAbi,getAddress,keccak256,encodeAbiParameters,toHex,publicActions} from 'viem';import {baseSepolia} from 'viem/chains';
import {createEngineV5} from '../../src/v5/engine.mjs';import {createBuy} from '../../src/v5/buy.mjs';import {BEGINNER_DEFAULTS} from '../../src/v5/mandates.mjs';
const D=process.env.X402_DIR,RPC=process.env.X402_RPC,DJ=process.env.X402_DEPLOY,EXEC=process.env.X402_EXEC;
test('x402 on the real V52 contracts: prepareAuthorization -> official facilitator verify+settle -> markSettled; rules hold',{skip:!D||!RPC||!DJ||!EXEC,timeout:300000},async()=>{
  const dep=JSON.parse(fs.readFileSync(DJ,'utf8'));const USDC=getAddress(dep.token);const NET='eip155:84532';
  const {x402Facilitator}=await import(D+'/@x402/core/dist/esm/facilitator/index.mjs');const {registerExactEvmScheme}=await import(D+'/@x402/evm/dist/esm/exact/facilitator/index.mjs');const {toFacilitatorEvmSigner}=await import(D+'/@x402/evm/dist/esm/index.mjs');
  const pub=createPublicClient({chain:baseSepolia,transport:vh(RPC)});const tc=createTestClient({chain:baseSepolia,mode:'anvil',transport:vh(RPC)});
  const ERC=parseAbi(['function balanceOf(address) view returns (uint256)']);const bal=a=>pub.readContract({address:USDC,abi:ERC,functionName:'balanceOf',args:[a]});
  await tc.impersonateAccount({address:EXEC});await tc.setBalance({address:EXEC,value:10n**18n});
  // testnet USDC for the owner wallet (fork: FiatToken balances slot 9)
  await tc.setStorageAt({address:USDC,index:keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[getAddress(dep.wallet),9n])),value:toHex(50_000_000n,{size:32})});
  const [fac0]=await tc.request({method:'eth_accounts'});
  const fac=registerExactEvmScheme(new x402Facilitator(),{signer:toFacilitatorEvmSigner(Object.assign(createWalletClient({chain:baseSepolia,transport:vh(RPC),account:fac0}).extend(publicActions),{address:fac0})),networks:NET});
  const TRUSTED=getAddress('0x000000000000000000000000000000000000bEEF'),STRANGER=getAddress(keccak256(toHex('kipurse-x402-stranger-'+Date.now())).slice(0,42));
  const st={amount:'1500000',payTo:TRUSTED};const log=[];
  const srv=http.createServer(async(q,s)=>{const req={scheme:'exact',network:NET,amount:st.amount,asset:USDC,payTo:st.payTo,maxTimeoutSeconds:120,extra:{name:'USDC',version:'2'}};const ph=q.headers['payment-signature'];
    if(!ph){s.writeHead(402,{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify({x402Version:2,resource:{url:'http://local'+q.url},accepts:[req]})).toString('base64')});return s.end();}
    const p=JSON.parse(Buffer.from(ph,'base64').toString());const vr=await fac.verify(p,req);if(!vr.isValid){log.push({vr});s.writeHead(402);return s.end();}
    const sr=await fac.settle(p,req);log.push({vr,sr});if(!sr.success){s.writeHead(402);return s.end();}
    s.writeHead(200,{'PAYMENT-RESPONSE':Buffer.from(JSON.stringify(sr)).toString('base64')});s.end('paid content');});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${srv.address().port}`;
  try{
    const perm={account:dep.wallet,spender:dep.adapter,token:USDC,allowance:'100000000',period:2592000,start:dep.start,end:dep.end,salt:'1',extraData:dep.extraData};
    // quote with the LIVE Base Sepolia gas price (anvil's own 1 gwei default is not Base's price)
    const upGas=BigInt((await (await fetch(process.env.SEPOLIA_RPC??'https://sepolia.base.org',{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice"}'})).json()).result);
    const dir=mkdtempSync(join(tmpdir(),'x4s-'));
    const engine=createEngineV5({chainId:84532,rpc:RPC,adapter:dep.adapter,trust:dep.trust,token:USDC,manager:dep.manager,permission:perm,impersonateExecutor:EXEC,gasMode:'legacy',prepareConfirmations:1,gasPricing:{usdcPerEth:'3000000000',marginBps:0,gasPriceWei:upGas.toString()},ownerRulesDir:join(dir,'rules')},{ledgerFile:join(dir,'l.sqlite')});
    engine.mandates.propose({items:BEGINNER_DEFAULTS.map(d=>({...d}))});for(const p of engine.mandates.proposals())engine.mandates.approve(p.id,()=>true);
    const buy=createBuy(engine,{sleep:async()=>{},waitMs:0});
    const p0=await bal(TRUSTED),w0=await bal(dep.wallet);
    const r=await buy.buy({item:'api call',merchant:'x402 test merchant',url:base+'/a',idempotencyKey:'idem-x4s-0001'},'grok');
    assert.equal(r.state,'paid',JSON.stringify(r,(k,v)=>typeof v==='bigint'?v.toString():v).slice(0,1500));
    assert.equal(r.fee,'1500','0.1%');assert.equal(r.gasRecovery??'0','0');
    assert.equal(await bal(TRUSTED),p0+1_500_000n,'merchant got exactly the price');
    assert.equal(w0-await bal(dep.wallet),1_500_000n+1500n+BigInt(r.networkFee),'owner paid price + 0.1% + network fee');
    assert.equal((await pub.getTransactionReceipt({hash:r.settlement.transaction})).status,'success');
    // over the ONE limit (5 USDC per payment): refused before anything is signed
    st.amount='6000000';const n=log.length;const big=await buy.buy({item:'big',merchant:'x402 test merchant',url:base+'/b',idempotencyKey:'idem-x4s-0002'},'grok');
    assert.notEqual(big.state,'paid');assert.equal(big.nothingPaid,true);assert.equal(log.length,n);
    // stranger payTo: new payee -> owner Face ID, nothing paid
    st.amount='1000000';st.payTo=STRANGER;const sx=await buy.buy({item:'c',merchant:'other',url:base+'/c',idempotencyKey:'idem-x4s-0003'},'grok');
    assert.notEqual(sx.state,'paid');assert.equal(sx.nothingPaid,true);assert.equal(await bal(STRANGER),0n);
    // replay of the settled header is refused by USDC (nonce used)
    console.log('X402_REAL',JSON.stringify({prepareTx:r.prepareTx,settleTx:r.settlement.transaction,fee:r.fee,networkFee:r.networkFee,big:big.reason??big.decision,stranger:sx.reason??sx.decision}));
    if(engine.settleRoutine){const sr=await engine.settleRoutine?.({});console.log('SETTLE_ROUTINE',JSON.stringify(sr,(k,v)=>typeof v==='bigint'?v.toString():v)?.slice(0,300));}
  }finally{srv.closeAllConnections?.();srv.close();}
});
