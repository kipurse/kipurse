// SPDX-License-Identifier: AGPL-3.0-only
// V5 on-chain client for the gateway executor (testnet: local executor key loaded by the caller; mainnet: not wired here).
import {createPublicClient,createWalletClient,http,keccak256,getAddress,encodeFunctionData,recoverAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';import {base,baseSepolia} from 'viem/chains';
import {rpcTransport} from './rpc.mjs';import {isRevokedSigner} from '../security/revoked-signers.mjs';import {abiFor} from './abi.mjs';
export function v5Client({chainId,rpc,adapter,executorKey,impersonate,maxPriorityFeeWei,version}){
  const v5Abi=abiFor(version);
  const chain=chainId===8453?base:baseSepolia;
  const pub=createPublicClient({chain,transport:rpcTransport(rpc)});
  const account=executorKey?privateKeyToAccount(executorKey):impersonate?getAddress(impersonate):undefined;
  const wal=account&&executorKey?createWalletClient({chain,account,transport:rpcTransport(rpc)}):undefined;
  const read=(functionName,args=[],address=adapter)=>pub.readContract({address,abi:v5Abi,functionName,args});
  let lock=Promise.resolve();
  function write(...a){const p=lock.then(()=>write0(...a));lock=p.catch(()=>{});return p;} // one executor nonce stream per process
  async function write0(functionName,args,{beforeSend,confirmations=1,address=adapter}={}){
    if(!account)throw Error('NO_EXECUTOR');
    if(functionName==='paySigned'){const dg=await read('orderDigest',[args[1]]);if(isRevokedSigner(await recoverAddress({hash:dg,signature:args[2]})))throw Error('REVOKED_MERCHANT_SIGNER');}
    await pub.simulateContract({address,abi:v5Abi,functionName,args,account}); // nothing doomed is ever sent
    const data=encodeFunctionData({abi:v5Abi,functionName,args});
    if(!wal){const hash=await pub.request({method:'eth_sendTransaction',params:[{from:account,to:address,data,gas:'0x2dc6c0'}]});await beforeSend?.(hash);
      const r=await pub.waitForTransactionReceipt({hash});if(r.status!=='success')throw Object.assign(Error('TX_REVERTED'),{hash,gasUsed:r.gasUsed,gasPrice:r.effectiveGasPrice,onChain:true});return {hash,blockNumber:r.blockNumber,gasUsed:r.gasUsed,gasPrice:r.effectiveGasPrice};}
    const req=await wal.prepareTransactionRequest({to:address,data,value:0n});
    req.gas=req.gas*13n/10n;if(req.gas<400000n)req.gas=400000n;
    // tip cap (the gateway quotes gas at gasPrice + this tip, so the payer reimburses what the executor really pays)
    if(maxPriorityFeeWei!==undefined&&req.maxPriorityFeePerGas!==undefined&&req.maxPriorityFeePerGas>BigInt(maxPriorityFeeWei)){
      const tip=BigInt(maxPriorityFeeWei);const base=(await pub.getBlock()).baseFeePerGas??0n;req.maxPriorityFeePerGas=tip;req.maxFeePerGas=base*2n+tip;}
    const raw=await wal.signTransaction(req);const hash=keccak256(raw);await beforeSend?.(hash);
    await pub.sendRawTransaction({serializedTransaction:raw}).catch(e=>{if(!/already known|nonce too low/i.test(String(e?.message)))throw e;});
    const r=await pub.waitForTransactionReceipt({hash,timeout:180000,confirmations});
    if(r.status!=='success')throw Object.assign(Error('TX_REVERTED'),{hash,gasUsed:r.gasUsed,gasPrice:r.effectiveGasPrice,onChain:true}); // real gas spent: the engine books it as debt
    return {hash,blockNumber:r.blockNumber,gasUsed:r.gasUsed,gasPrice:r.effectiveGasPrice};
  }
  const idle=async()=>{let l;do{l=lock;await l;}while(l!==lock);};
  return {pub,account,read,write,chain,idle};
}
