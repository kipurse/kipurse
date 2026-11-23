// SPDX-License-Identifier: AGPL-3.0-only
// t1250 (handbook §6#119, option A): PRINT the ONE batch the owner's Base Account would confirm to open his NEW V5.5 wallet
// [Base Account, KipurseKeySeatV2, SPM] and exit his V5.4 wallet into it (revoke V5.4 permission, V5.4 vault -> wallet, USDC -> new wallet).
// READ-ONLY: reads the chain, quotes the actual network fee, builds the calls + KPVH commitment. Never signs, sends or broadcasts.
//   node mainnet/v55-move.mjs --executor 0x<new wallet's server executor> [--rpc …] [--preview]   (--preview: build even before V5.5 is deployed)
import fs from 'node:fs';import {createPublicClient,http,parseAbi,getAddress} from 'viem';
import {readExitStateV54,moveToV55Calls,moveFeeV55,precheckExit} from '../src/v5/wallet-v55.mjs';import {commitment} from '../src/v5/batch-commit.mjs';
const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:null;};
const rpc=arg('--rpc')??'https://base-rpc.publicnode.com';const pub=createPublicClient({transport:http(rpc,{timeout:15000})});
const OWNER=getAddress(arg('--owner')??'0x4242b022A8296cB18B0E0b1Cb9879C518170A718');const OLD=getAddress(arg('--wallet')??'0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb');
const oldPermission=JSON.parse(fs.readFileSync(arg('--permission')??new URL('../test/fixtures/t1250-v54-live-permission.json',import.meta.url).pathname,'utf8'));
const executor=arg('--executor');if(!executor){console.error('need --executor (the new wallet\'s own server executor address)');process.exit(2);}
const S=await readExitStateV54(pub,{wallet:OLD,owner:OWNER,known:{oldPermission,trusts:[],openReservations:[],serverInFlight:false}});
const pc=precheckExit(S);const preview=process.argv.includes('--preview');
const gp=await pub.getGasPrice();const eth=(await pub.readContract({address:'0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',abi:parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']),functionName:'latestRoundData'}))[1];
const q=moveFeeV55({gasPriceWei:gp,ethUsd8:eth});
const out={block:String(await pub.getBlockNumber()),old:{wallet:OLD,usdc:String(S.walletBalance),vault:S.oldVault,vaultUsdc:String(S.oldVaultBalance),reserved:String(S.oldVaultReserved),permissionValid:S.oldPermissionValid,phoneKeyFromSeatV1:!!S.phone},
  next:{wallet:S.newWallet,seatV2:S.seatV2,vaultV55:S.vaultV55},precheck:pc,feeUsdc:String(q.usdc)};
if(pc.ok||preview){const s=preview?{...S,v55Deployed:true}:S;const vault=S.vaultV55??'0x0000000000000000000000000000000000000001';
  const m=moveToV55Calls(s,{owner:OWNER,newWallet:S.newWallet,vault,fee:q.usdc,executor,seatDeployed:S.seatV2Deployed});
  out.batch={calls:m.calls.map(c=>({label:c.label,to:c.to,value:c.value,data:c.data.length>140?c.data.slice(0,138)+'…':c.data})),move:m.move,commitment:commitment({chainId:8453,from:OWNER,calls:m.calls}),preview};
  if(preview&&!S.vaultV55)out.batch.note='PREVIEW: V5.5 is not on chain yet, so the vault address in the seed / ops calls is a placeholder; rebuild after the deploy.';}
console.log(JSON.stringify(out,null,1));
