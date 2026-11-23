// FORK-ONLY local ERC-4337 v0.8 bundler with EIP-7702 support (JSON-RPC subset the sweep uses). It simulates handleOps with the
// authorization (eth_call), then sends a type-4 transaction from an anvil dev account to the fork's REAL EntryPoint v0.8 (and so the real
// Circle paymaster v0.8, real Simple7702Account, real USDC). Never points at a real network.
import http from 'node:http';import {createPublicClient,createWalletClient,http as vh,encodeFunctionData,decodeEventLog,getAddress,hexToBigInt,toHex,decodeErrorResult} from 'viem';
import {entryPoint08Abi,toPackedUserOperation,getUserOperationHash} from 'viem/account-abstraction';import {privateKeyToAccount} from 'viem/accounts';import {base} from 'viem/chains';
const EP='0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const ANVIL0='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';   // anvil's well-known dev key (fork-only, public test key)
const B=v=>v===undefined||v===null?undefined:hexToBigInt(v);
const fromRpc=r=>({sender:getAddress(r.sender),nonce:B(r.nonce),factory:r.factory,factoryData:r.factoryData,callData:r.callData,callGasLimit:B(r.callGasLimit),verificationGasLimit:B(r.verificationGasLimit),
  preVerificationGas:B(r.preVerificationGas),maxFeePerGas:B(r.maxFeePerGas),maxPriorityFeePerGas:B(r.maxPriorityFeePerGas),paymaster:r.paymaster,paymasterVerificationGasLimit:B(r.paymasterVerificationGasLimit)??0n,
  paymasterPostOpGasLimit:B(r.paymasterPostOpGasLimit)??0n,paymasterData:r.paymasterData??'0x',signature:r.signature,
  authorization:r.eip7702Auth?{address:getAddress(r.eip7702Auth.address),chainId:Number(r.eip7702Auth.chainId),nonce:Number(r.eip7702Auth.nonce),r:r.eip7702Auth.r,s:r.eip7702Auth.s,yParity:Number(r.eip7702Auth.yParity)}:undefined});
const errText=e=>{let d=e;for(let i=0;i<6&&d;i++){const x=d.data??d.cause?.data;if(typeof x==='string'&&x.startsWith('0x')){try{const r=decodeErrorResult({abi:entryPoint08Abi,data:x});return r.errorName+' '+JSON.stringify(r.args,(k,v)=>typeof v==='bigint'?v.toString():v);}catch{return 'revert '+x.slice(0,138);}}d=d.cause;}return String(e?.shortMessage??e?.message??e).slice(0,300);};
export async function startBundler7702({rpc,log=()=>{}}){const pub=createPublicClient({chain:base,transport:vh(rpc)});const acct=privateKeyToAccount(ANVIL0);
  const wc=createWalletClient({chain:base,transport:vh(rpc),account:acct});const receipts=new Map();const sent=[];
  const packed=op=>toPackedUserOperation({...op,factory:op.factory==='0x7702'?'0x7702000000000000000000000000000000000000':op.factory});
  const methods={eth_chainId:async()=>toHex(8453),eth_supportedEntryPoints:async()=>[EP],
    pimlico_getUserOperationGasPrice:async()=>{const b=await pub.getBlock();const s={maxFeePerGas:toHex((b.baseFeePerGas??1000000n)*2n+1000000n),maxPriorityFeePerGas:toHex(1000000n)};return {slow:s,standard:s,fast:s};},
    eth_estimateUserOperationGas:async([r])=>{const op=fromRpc(r);const data=encodeFunctionData({abi:entryPoint08Abi,functionName:'handleOps',args:[[packed(op)],acct.address]});
      try{await pub.call({account:acct,to:EP,data,gas:5_000_000n,authorizationList:op.authorization?[op.authorization]:undefined});}catch(e){throw Object.assign(Error('UserOperation reverted during simulation: '+errText(e)),{rpcCode:-32521});}
      return {preVerificationGas:toHex(80000n),verificationGasLimit:toHex(120000n),callGasLimit:toHex(80000n),paymasterVerificationGasLimit:toHex(120000n),paymasterPostOpGasLimit:toHex(50000n)};},
    eth_sendUserOperation:async([r])=>{const op=fromRpc(r);const h=getUserOperationHash({chainId:8453,entryPointAddress:EP,entryPointVersion:'0.8',userOperation:op});
      const data=encodeFunctionData({abi:entryPoint08Abi,functionName:'handleOps',args:[[packed(op)],acct.address]});const al=op.authorization?[op.authorization]:undefined;
      try{await pub.call({account:acct,to:EP,data,gas:5_000_000n,authorizationList:al});}catch(e){throw Object.assign(Error('UserOperation rejected (simulation): '+errText(e)),{rpcCode:-32500});}
      const tx=await wc.sendTransaction({to:EP,data,gas:5_000_000n,authorizationList:al});const rc=await pub.waitForTransactionReceipt({hash:tx});
      let ev=null;for(const l of rc.logs){if(getAddress(l.address)!==EP)continue;try{const d=decodeEventLog({abi:entryPoint08Abi,data:l.data,topics:l.topics});if(d.eventName==='UserOperationEvent'&&d.args.userOpHash===h)ev=d.args;}catch{}}
      if(!ev)throw Object.assign(Error('UserOperation not included: '+tx+' status '+rc.status),{rpcCode:-32500});
      const logs=rc.logs.map(l=>({address:l.address,topics:l.topics,data:l.data,logIndex:toHex(l.logIndex),transactionHash:l.transactionHash,blockNumber:toHex(l.blockNumber)}));
      receipts.set(h,{userOpHash:h,sender:op.sender,nonce:toHex(op.nonce),paymaster:op.paymaster,success:ev.success,actualGasCost:toHex(ev.actualGasCost),actualGasUsed:toHex(ev.actualGasUsed),logs,
        receipt:{transactionHash:tx,blockNumber:toHex(rc.blockNumber),logs,status:rc.status==='success'?'0x1':'0x0'}});
      sent.push({userOpHash:h,tx,success:ev.success,gasUsed:ev.actualGasUsed,authorization:!!al});log('sent '+h+' success='+ev.success);return h;},
    eth_getUserOperationReceipt:async([h])=>receipts.get(h)??null};
  const srv=http.createServer((q,s)=>{let d='';q.on('data',c=>d+=c);q.on('end',async()=>{let m;try{m=JSON.parse(d);}catch{s.end('{}');return;}
    const f=methods[m.method];let out;if(!f)out={jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'method not found '+m.method}};
    else try{out={jsonrpc:'2.0',id:m.id,result:await f(m.params??[])};}catch(e){out={jsonrpc:'2.0',id:m.id,error:{code:e.rpcCode??-32000,message:String(e.message)}};}
    s.setHeader('content-type','application/json');s.end(JSON.stringify(out));});});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));return {url:'http://127.0.0.1:'+srv.address().port,sent,close:()=>srv.close()};}
