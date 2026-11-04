// Prepare (never send) the merchant-registry maintainer handover. Read-only + prints unsigned calls for the OWNER to sign himself.
//   node scripts/registry-handover.mjs <NEW_MAINTAINER_ADDRESS>
import {createPublicClient,http,parseAbi,encodeFunctionData,getAddress} from 'viem';import {base} from 'viem/chains';import {createHash} from 'node:crypto';
const REG=getAddress(process.env.KIPURSE_REGISTRY??'0xd1af1402f4ec42366e7233d274115a773d0553a6');const next=process.argv[2];
if(!/^0x[0-9a-fA-F]{40}$/.test(next??''))throw Error('usage: node scripts/registry-handover.mjs <NEW_MAINTAINER_ADDRESS>');const NEW=getAddress(next);
const RA=parseAbi(['function maintainer() view returns (address)','function pendingMaintainer() view returns (address)','function delay() view returns (uint256)','function proposeMaintainer(address next)','function acceptMaintainer()']);
const pub=createPublicClient({chain:base,transport:http(process.env.KIPURSE_RPC??'https://mainnet.base.org')});
const cur=await pub.readContract({address:REG,abi:RA,functionName:'maintainer'}),delay=await pub.readContract({address:REG,abi:RA,functionName:'delay'});
if(cur.toLowerCase()===NEW.toLowerCase())throw Error('already the maintainer');
const step1={chainId:8453,from:cur,to:REG,value:'0',data:encodeFunctionData({abi:RA,functionName:'proposeMaintainer',args:[NEW]})};
const step2={chainId:8453,from:NEW,to:REG,value:'0',data:encodeFunctionData({abi:RA,functionName:'acceptMaintainer'})};
const commit=s=>createHash('sha256').update(`kpbatch1|${s.chainId}|${s.from.toLowerCase()}|${s.to.toLowerCase()},0,${s.data.toLowerCase()}`).digest('hex');
console.log(JSON.stringify({registry:REG,currentMaintainer:cur,newMaintainer:NEW,timelockHours:Number(delay)/3600,
  step1_proposeMaintainer_signedBy_current:{...step1,kpvhCommitment:commit(step1)},step2_acceptMaintainer_signedBy_new_after_timelock:step2,
  cancel_if_wrong:'current maintainer calls proposeMaintainer(0x0000000000000000000000000000000000000000) before step 2'},null,1));
