// FORK-ONLY local ERC-4337 bundler (t1185 rehearsal): JSON-RPC subset the userOp writer uses, backed by the anvil fork's real
// EntryPoint v0.7 + real Circle paymaster. eth_sendUserOperation = simulate handleOps (eth_call), then send it from an impersonated
// bundler EOA. Never used against a real network.
import http from 'node:http';import {createPublicClient,createWalletClient,createTestClient,http as vh,encodeFunctionData,decodeEventLog,getAddress,hexToBigInt,toHex,decodeErrorResult} from 'viem';
import {entryPoint07Abi,toPackedUserOperation,getUserOperationHash} from 'viem/account-abstraction';import {base} from 'viem/chains';
const EP='0x0000000071727De22E5E9d8BAf0edAc6f37da032';const BUNDLER='0x00000000000000000000000000000000b0bb1e55';
const B=v=>v===undefined||v===null?undefined:hexToBigInt(v);
export function fromRpc(r){return {sender:getAddress(r.sender),nonce:B(r.nonce),factory:r.factory,factoryData:r.factoryData,callData:r.callData,callGasLimit:B(r.callGasLimit),verificationGasLimit:B(r.verificationGasLimit),
  preVerificationGas:B(r.preVerificationGas),maxFeePerGas:B(r.maxFeePerGas),maxPriorityFeePerGas:B(r.maxPriorityFeePerGas),paymaster:r.paymaster,paymasterVerificationGasLimit:B(r.paymasterVerificationGasLimit)??0n,
  paymasterPostOpGasLimit:B(r.paymasterPostOpGasLimit)??0n,paymasterData:r.paymasterData??'0x',signature:r.signature};}
const errText=e=>{const d=e?.cause?.data??e?.data??e?.cause?.cause?.data;if(typeof d==='string'&&d.startsWith('0x')){try{const x=decodeErrorResult({abi:entryPoint07Abi,data:d});return x.errorName+' '+JSON.stringify(x.args,(k,v)=>typeof v==='bigint'?v.toString():v);}catch{return 'revert '+d.slice(0,74);}}return String(e?.shortMessage??e?.message??e).slice(0,300);};
export async function startBundlerShim({rpc,port=0,log=()=>{}}){
  const pub=createPublicClient({chain:base,transport:vh(rpc)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(rpc)});
  await tc.impersonateAccount({address:BUNDLER});await tc.setBalance({address:BUNDLER,value:10n**20n});
  const wc=createWalletClient({chain:base,transport:vh(rpc),account:BUNDLER});
  const receipts=new Map();const sent=[];
  const simulate=async op=>{const data=encodeFunctionData({abi:entryPoint07Abi,functionName:'handleOps',args:[[toPackedUserOperation(op)],BUNDLER]});
    await pub.call({account:BUNDLER,to:EP,data,gas:15_000_000n});return data;};
  const methods={
    eth_chainId:async()=>toHex(8453),eth_supportedEntryPoints:async()=>[EP],
    pimlico_getUserOperationGasPrice:async()=>{const b=await pub.getBlock();const bf=b.baseFeePerGas??1000000n;const tip=1000000n;const s={maxFeePerGas:toHex(bf*2n+tip),maxPriorityFeePerGas:toHex(tip)};return {slow:s,standard:s,fast:s};},
    eth_estimateUserOperationGas:async([r])=>{const op=fromRpc(r);
      // execution must not revert (a reverting payment is never sent)
      let g;try{g=await pub.estimateGas({account:EP,to:op.sender,data:op.callData});}catch(e){throw Object.assign(Error('UserOperation reverted during simulation: '+errText(e)),{rpcCode:-32521});}
      return {preVerificationGas:toHex(60000n),verificationGasLimit:toHex(250000n),callGasLimit:toHex(g*12n/10n+20000n),paymasterVerificationGasLimit:toHex(150000n),paymasterPostOpGasLimit:toHex(50000n)};},
    eth_sendUserOperation:async([r])=>{const op=fromRpc(r);const h=getUserOperationHash({chainId:8453,entryPointAddress:EP,entryPointVersion:'0.7',userOperation:op});
      const tg=op.callGasLimit+op.verificationGasLimit+op.preVerificationGas+op.paymasterVerificationGasLimit+op.paymasterPostOpGasLimit;log('op gas '+JSON.stringify({call:String(op.callGasLimit),verif:String(op.verificationGasLimit),pre:String(op.preVerificationGas),pmv:String(op.paymasterVerificationGasLimit),pmp:String(op.paymasterPostOpGasLimit),total:String(tg),maxFee:String(op.maxFeePerGas),maxCostWei:String(tg*op.maxFeePerGas),permit:op.paymasterData&&op.paymasterData.length>=108?String(BigInt('0x'+op.paymasterData.slice(44,108))):null}));
      let data;try{data=await simulate(op);}catch(e){throw Object.assign(Error('UserOperation rejected (simulation): '+errText(e)),{rpcCode:-32500});}
      const tx=await wc.sendTransaction({to:EP,data,gas:15_000_000n});const rc=await pub.waitForTransactionReceipt({hash:tx});
      let ev=null,reason=null;for(const l of rc.logs){if(getAddress(l.address)!==EP)continue;try{const d=decodeEventLog({abi:entryPoint07Abi,data:l.data,topics:l.topics});
        if(d.eventName==='UserOperationEvent'&&d.args.userOpHash===h)ev=d.args;if(d.eventName==='UserOperationRevertReason'&&d.args.userOpHash===h)reason=d.args.revertReason;}catch{}}
      if(!ev)throw Object.assign(Error('UserOperation not included: '+tx),{rpcCode:-32500});
      const logs=rc.logs.map(l=>({address:l.address,topics:l.topics,data:l.data,logIndex:toHex(l.logIndex),transactionHash:l.transactionHash,blockNumber:toHex(l.blockNumber)}));
      const out={userOpHash:h,sender:op.sender,nonce:toHex(op.nonce),paymaster:op.paymaster,success:ev.success,reason:reason??'',actualGasCost:toHex(ev.actualGasCost),actualGasUsed:toHex(ev.actualGasUsed),logs,
        receipt:{transactionHash:tx,blockNumber:toHex(rc.blockNumber),gasUsed:toHex(rc.gasUsed),status:rc.status==='success'?'0x1':'0x0',logs}};
      receipts.set(h,out);sent.push({userOpHash:h,tx,op:r,success:ev.success,callData:r.callData});log('sent '+h+' success='+ev.success);return h;},
    eth_getUserOperationReceipt:async([h])=>receipts.get(h)??null,
  };
  const srv=http.createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;let j;try{j=JSON.parse(b);}catch{res.end('{}');return;}
    const f=methods[j.method];let out;
    if(!f)out={jsonrpc:'2.0',id:j.id,error:{code:-32601,message:'method not found '+j.method}};
    else try{out={jsonrpc:'2.0',id:j.id,result:await f(j.params??[])};}catch(e){out={jsonrpc:'2.0',id:j.id,error:{code:e.rpcCode??-32603,message:String(e.message)}};log('error '+j.method+': '+e.message);}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(out));});
  await new Promise(r=>srv.listen(port,'127.0.0.1',r));const url=`http://127.0.0.1:${srv.address().port}/rpc`;
  return {url,sent,receipts,close:()=>new Promise(r=>srv.close(r))};}
