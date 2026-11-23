// SPDX-License-Identifier: AGPL-3.0-only
// t1250 (handbook §6#119): PRINT the V5.5 deploy batches the owner's Base Account would confirm in Coinbase (same shape as the V5.4 deploy:
// deterministic-deployer calls + a 0.15 USDC fee leg per batch). READ-ONLY: checks the chain (predicted addresses empty, which batch is next,
// the owner's USDC) and prints calls + KPVH commitment + wallet_sendCalls payload. It never signs, sends or broadcasts anything.
//   node mainnet/v55-deploy.mjs [--rpc https://base-rpc.publicnode.com] [--owner 0x4242…] [--full]
import {createPublicClient,http,parseAbi,getAddress} from 'viem';
import {loadV55Plan,deployV55Batches,deployV55Commitment,sendCallsPayload,deployV55State,DEPLOY_V55_FEE_USDC} from '../src/v5/deploy-v55.mjs';
import {checkEmpty} from './v55-plan.mjs';
const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:null;};
const rpc=arg('--rpc')??'https://base-rpc.publicnode.com';const owner=getAddress(arg('--owner')??'0x4242b022A8296cB18B0E0b1Cb9879C518170A718');
const pub=createPublicClient({transport:http(rpc,{timeout:15000})});
const plan=loadV55Plan(new URL('./v55-deploy-plan.json',import.meta.url).pathname);const B=deployV55Batches(plan);
const st=await deployV55State(pub);const empty=await checkEmpty(pub,{...plan.addresses,registry:plan.addresses.registryV2});
const usdc=await pub.readContract({address:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',abi:parseAbi(['function balanceOf(address) view returns (uint256)']),functionName:'balanceOf',args:[owner]});
const full=process.argv.includes('--full');
console.log(JSON.stringify({chainId:8453,owner,block:String(await pub.getBlockNumber()),state:st,predictedEmpty:empty,ownerUsdc:String(usdc),feePerBatch:String(DEPLOY_V55_FEE_USDC),
  needsUsdc:String(BigInt(B.length)*DEPLOY_V55_FEE_USDC),measuredGas:plan.gas,
  batches:B.map(b=>({n:b.n,label:b.label,creates:b.creates,commitment:deployV55Commitment(b,owner),link:'#vh='+deployV55Commitment(b,owner),
    wallet_sendCalls:full?sendCallsPayload(b,owner):{...sendCallsPayload(b,owner),calls:b.calls.map(c=>({to:c.to,value:c.value,data:c.data.slice(0,74)+'… ('+((c.data.length-2)/2)+' bytes)'}))}})),
  note:'PREPARED ONLY. Batch 2 only after batch 1 landed. Nothing was signed or sent.'},null,1));
