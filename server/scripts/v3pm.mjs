// Dry-run only: asks the paymaster for STUB data (no signature, nothing sent, nothing spent). URL comes from the service env; never printed.
import fs from 'node:fs';import {createPublicClient,http,parseAbi,encodeFunctionData,getAddress,toHex} from 'viem';import {base} from 'viem/chains';
import {approverInit} from '../src/v5/phone-signer.mjs';
const out=fs.readFileSync('/root/rh-v3/probe.out','utf8').trim().split('\n');const P=JSON.parse(out[out.length-1]);
const O=getAddress('0xC14B0707634A55B3DE43811FD34C92f6f49f410b');const EP='0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const pub=createPublicClient({chain:base,transport:http('https://base-rpc.publicnode.com')});
const DD='0x4e59b44847b379578588920cA78FbF26c0B4956C';const dep=P.calls.find(c=>getAddress(c.to)===getAddress(DD)&&c.data.length>2000);
const W=JSON.parse(fs.readFileSync('/root/rh-v3/probe.wallet','utf8')).wallet;
const TRUST=process.env.TRUST;const a3=approverInit({wallet:W,trust:TRUST,x:P.x,y:P.y,maxSingle:1n,maxDaily:1n,version:'v3'});
console.log('approver_is_v3',!!dep&&dep.data.toLowerCase()===a3.deployData.toLowerCase(),'approver',a3.address,'calls',P.calls.length);
const callData=encodeFunctionData({abi:parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls)']),functionName:'executeBatch',args:[P.calls.map(c=>({target:getAddress(c.to),value:BigInt(c.value??0),data:c.data}))]});
const nonce=await pub.readContract({address:EP,abi:parseAbi(['function getNonce(address,uint192) view returns (uint256)']),functionName:'getNonce',args:[O,0n]});
const gp=await pub.getGasPrice();
const op={sender:O,nonce:toHex(nonce),initCode:'0x',callData,callGasLimit:toHex(2_600_000n),verificationGasLimit:toHex(400_000n),preVerificationGas:toHex(120_000n),maxFeePerGas:toHex(gp*2n),maxPriorityFeePerGas:toHex(gp),paymasterAndData:'0x',signature:'0x'};
const u=process.env.KIPURSE_ONBOARD_PAYMASTER_URL;if(!u){console.log('no paymaster url');process.exit(1);}
const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'pm_getPaymasterStubData',params:[op,EP,'0x2105',{}]})});
const j=await r.json().catch(()=>null);console.log('http',r.status,'accepted',!!j?.result,'sponsor',JSON.stringify(j?.result?.sponsor??null),'error',JSON.stringify(j?.error??null).slice(0,200),'pmLen',(j?.result?.paymasterAndData??'').length);
