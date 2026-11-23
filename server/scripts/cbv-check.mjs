// read-only: Coinbase Verified Account attestation status for addresses (Base mainnet). Usage: node scripts/cbv-check.mjs <rpc> addr...
import {createPublicClient,http} from 'viem';import {base} from 'viem/chains';import {checkVerified} from '../src/v5/cb-verified.mjs';
const [rpc,...as]=process.argv.slice(2);const pub=createPublicClient({chain:base,transport:http(rpc)});
const W='0x5e4c116dd45edc2dbed826be8b97a72499d03fc8';
if(as.includes('owners')){const n=await pub.readContract({address:W,abi:[{name:'nextOwnerIndex',type:'function',stateMutability:'view',inputs:[],outputs:[{type:'uint256'}]}],functionName:'nextOwnerIndex'});
  for(let i=0n;i<n;i++){try{const o=await pub.readContract({address:W,abi:[{name:'ownerAtIndex',type:'function',stateMutability:'view',inputs:[{type:'uint256'}],outputs:[{type:'bytes'}]}],functionName:'ownerAtIndex',args:[i]});console.log('owner',i,o.length===66?'0x'+o.slice(-40):o.slice(0,20)+'…(key)');}catch{}}process.exit(0);}
for(const a of as)console.log(a,JSON.stringify(await checkVerified(pub,a)));
