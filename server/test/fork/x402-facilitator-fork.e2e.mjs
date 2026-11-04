// FORK-ONLY (Base Sepolia fork, no real funds): a local x402 merchant server + the OFFICIAL @x402/evm facilitator
// verify+settle a Kipurse-shaped payment against real Base Sepolia USDC (FiatToken v2.2, transferWithAuthorization(bytes)).
// Payer = a contract with the same ERC-1271 rule as KipursePayerVaultV5 path (a): adapter-reserved digest -> valid, signature bytes ignored.
// Header built by the production builder (engine x402Header), request parsed by the production detector. Run:
//   X402_DIR=./state node --test test/fork/x402-facilitator-fork.e2e.mjs
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {spawn} from 'node:child_process';import fs from 'node:fs';
import {createPublicClient,createWalletClient,createTestClient,http as vh,parseAbi,getAddress,hashTypedData,keccak256,encodeAbiParameters,toHex,publicActions} from 'viem';import {baseSepolia} from 'viem/chains';
import {privateKeyToAccount} from 'viem/accounts';
import {detect} from '../../src/v4/detector.mjs';import {x402Header} from '../../src/v5/engine.mjs';
const D=process.env.X402_DIR,UP=process.env.SEPOLIA_RPC??'https://sepolia.base.org',PROBE='./state';
const USDC=getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e');const NET='eip155:84532';
test('x402 exact/eip3009: official facilitator settles a vault-style ERC-1271 payment (v2 + v1), rejects unreserved + replay',{skip:!D,timeout:240000},async()=>{
  const {x402Facilitator}=await import(D+'/@x402/core/dist/esm/facilitator/index.mjs');const {registerExactEvmScheme,toFacilitatorEvmSigner}={...await import(D+'/@x402/evm/dist/esm/exact/facilitator/index.mjs'),...await import(D+'/@x402/evm/dist/esm/index.mjs')};
  const port=19500+Math.floor(Math.random()*300);const RPC=`http://127.0.0.1:${port}`;
  const anvil=spawn(process.env.ANVIL??(process.env.HOME+'/.foundry/bin/anvil'),['--fork-url',UP,'--port',String(port),'--silent']);
  try{
    for(let i=0;i<60;i++){try{await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}'});break;}catch{await new Promise(r=>setTimeout(r,500));}}
    const pub=createPublicClient({chain:baseSepolia,transport:vh(RPC)});const tc=createTestClient({chain:baseSepolia,mode:'anvil',transport:vh(RPC)});
    const [a0,a1]=await tc.request({method:'eth_accounts'});
    const w0=createWalletClient({chain:baseSepolia,transport:vh(RPC),account:a0});
    const dh=await w0.deployContract({abi:JSON.parse(fs.readFileSync(PROBE+'/Approver.abi','utf8')),bytecode:'0x'+fs.readFileSync(PROBE+'/Approver.bin','utf8').trim()});
    const vault=getAddress((await pub.waitForTransactionReceipt({hash:dh})).contractAddress);
    const ERC=parseAbi(['function balanceOf(address) view returns (uint256)','function authorizationState(address,bytes32) view returns (bool)']);
    // fund the vault with 10 USDC on the fork (FiatToken balances mapping, slot 9)
    await tc.setStorageAt({address:USDC,index:keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[vault,9n])),value:toHex(10_000_000n,{size:32})});
    assert.equal(await pub.readContract({address:USDC,abi:ERC,functionName:'balanceOf',args:[vault]}),10_000_000n);
    const facSigner=toFacilitatorEvmSigner(Object.assign(createWalletClient({chain:baseSepolia,transport:vh(RPC),account:a1}).extend(publicActions),{address:a1}));
    const fac=registerExactEvmScheme(new x402Facilitator(),{signer:facSigner,networks:NET});
    const payTo=getAddress('0x000000000000000000000000000000000000dEaD'.replace('dEaD','bEEF'));
    const reqV2={scheme:'exact',network:NET,amount:'1250000',asset:USDC,payTo,maxTimeoutSeconds:120,extra:{name:'USDC',version:'2'}};
    const reqV1={scheme:'exact',network:'base-sepolia',maxAmountRequired:'750000',resource:'http://local/v1',description:'v1',mimeType:'application/json',asset:USDC,payTo,maxTimeoutSeconds:120,extra:{name:'USDC',version:'2'}};
    const results=[];
    const srv=http.createServer(async(q,s)=>{const v1=q.url==='/v1';const ph=q.headers[v1?'x-payment':'payment-signature'];
      if(!ph){if(v1){s.writeHead(402,{'content-type':'application/json'});return s.end(JSON.stringify({x402Version:1,error:'pay',accepts:[reqV1]}));}
        s.writeHead(402,{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify({x402Version:2,resource:{url:'http://local/v2'},accepts:[{...reqV2,extra:{...reqV2.extra,assetTransferMethod:'permit2'}},reqV2]})).toString('base64')});return s.end();}
      const payload=JSON.parse(Buffer.from(ph,'base64').toString());const reqs=v1?reqV1:reqV2;
      const vr=await fac.verify(payload,reqs);if(!vr.isValid){results.push({v1,vr});s.writeHead(402);return s.end(JSON.stringify(vr));}
      const st=await fac.settle(payload,reqs);results.push({v1,vr,st});
      if(!st.success){s.writeHead(402);return s.end(JSON.stringify(st));}
      s.writeHead(200,{[v1?'X-PAYMENT-RESPONSE':'PAYMENT-RESPONSE']:Buffer.from(JSON.stringify(st)).toString('base64'),'content-type':'application/json'});s.end('{"data":"paid content"}');});
    globalThis.__srv=srv;await new Promise(r=>srv.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${srv.address().port}`;
    const now=BigInt((await pub.getBlock()).timestamp);
    const pay=async(path,{reserve=true,nonce}={})=>{
      const r1=await fetch(base+path);assert.equal(r1.status,402);
      const n=detect({status:402,headers:Object.fromEntries(r1.headers),body:await r1.text()},{chains:[84532]});assert.ok(n.ok,n.code);
      assert.equal(n.mode,'eip3009');assert.equal(n.payee,payTo);
      const auth={from:vault,to:n.payee,value:n.amount.toString(),validAfter:'0',validBefore:String(now+600n),nonce:nonce??keccak256(toHex(path+Math.random()))};
      const digest=hashTypedData({domain:{name:'USDC',version:'2',chainId:84532,verifyingContract:USDC},primaryType:'TransferWithAuthorization',
        types:{TransferWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]},
        message:{...auth,value:BigInt(auth.value),validAfter:0n,validBefore:BigInt(auth.validBefore)}});
      if(reserve)await pub.waitForTransactionReceipt({hash:await w0.writeContract({address:vault,abi:parseAbi(['function approve(bytes32,uint256)']),functionName:'approve',args:[digest,now+600n]})});
      const h=x402Header(n,digest,auth);const r2=await fetch(base+path,{headers:{[h.name]:h.value}});
      return {n,auth,status:r2.status,resp:r2.headers.get('payment-response')??r2.headers.get('x-payment-response'),body:await r2.text()};};
    const bal=a=>pub.readContract({address:USDC,abi:ERC,functionName:'balanceOf',args:[a]});
    const p0=await bal(payTo);
    const ok2=await pay('/v2');assert.equal(ok2.n.standard,'x402-v2');assert.equal(ok2.status,200,ok2.body);
    const sr=JSON.parse(Buffer.from(ok2.resp,'base64').toString());assert.equal(sr.success,true);assert.match(sr.transaction,/^0x[0-9a-f]{64}$/);
    assert.equal((await pub.getTransactionReceipt({hash:sr.transaction})).status,'success');
    assert.equal(await bal(payTo),p0+1_250_000n);
    const ok1=await pay('/v1');assert.equal(ok1.n.standard,'x402-v1');assert.equal(ok1.status,200,ok1.body);assert.equal(await bal(payTo),p0+2_000_000n);
    assert.equal(await bal(vault),10_000_000n-2_000_000n);
    const bad=await pay('/v2',{reserve:false});assert.equal(bad.status,402);assert.equal(results.at(-1).vr.isValid,false);// not reserved by the adapter -> refused
    const rep=await pay('/v2',{nonce:ok2.auth.nonce});assert.equal(rep.status,402);// same nonce -> USDC refuses replay
    assert.equal(await bal(payTo),p0+2_000_000n);
    console.log('X402_E2E',JSON.stringify({v2tx:sr.transaction,v1:results.find(r=>r.v1)?.st?.transaction,unreserved:results.at(-2).vr.invalidReason,replay:results.at(-1).vr?.invalidReason??results.at(-1).st?.errorReason}));
  }finally{globalThis.__srv?.closeAllConnections?.();globalThis.__srv?.close();anvil.kill();}
});
