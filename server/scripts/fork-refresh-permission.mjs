// FORK FIXTURE FIX: the fixture's stored SpendPermission goes stale whenever the owner changes limits on mainnet (new salt), so
// startMainnet refuses it ("stored permission is not valid on chain for tenant"). This reads the newest SpendPermissionApproved
// event for the fixture account + adapter from PUBLIC chain logs, checks isValid, and rewrites fork.json (backup kept). Read-only on chain.
import fs from 'node:fs';import {createPublicClient,http,parseAbiItem,parseAbi,getAddress} from 'viem';import {base} from 'viem/chains';
const [file,rpc='https://mainnet.base.org']=process.argv.slice(2);const cfg=JSON.parse(fs.readFileSync(file,'utf8'));const old=cfg.permission;
const SPM=getAddress(cfg.manager);const pub=createPublicClient({chain:base,transport:http(rpc)});
const ev=parseAbiItem('event SpendPermissionApproved(bytes32 indexed hash, (address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData) spendPermission)');
const ABI=parseAbi(['function isValid((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData) p) view returns (bool)']);
const head=await pub.getBlockNumber();let from=head-BigInt(process.env.LOOKBACK??400000);const step=BigInt(process.env.STEP??2000);let errs=0;let found=null;
for(let hi=head;hi>from&&!found;hi-=step){const lo=hi-step+1n;let logs=[];try{logs=await pub.getLogs({address:SPM,event:ev,fromBlock:lo,toBlock:hi});}catch(e){if(++errs>20){console.error(String(e.shortMessage??e.message).slice(0,200));process.exit(2);}await new Promise(r=>setTimeout(r,500));hi+=step;continue;}
  for(const l of logs.reverse()){const p=l.args.spendPermission;if(getAddress(p.account)!==getAddress(old.account)||getAddress(p.spender)!==getAddress(old.spender))continue;
    if(await pub.readContract({address:SPM,abi:ABI,functionName:'isValid',args:[p]})){found=p;break;}}}
if(!found){console.log(JSON.stringify({ok:false,error:'no valid permission found'}));process.exit(1);}
const np={account:found.account,spender:found.spender,token:found.token,allowance:String(found.allowance),period:Number(found.period),start:Number(found.start),end:Number(found.end),salt:String(found.salt),extraData:found.extraData};
fs.copyFileSync(file,file+'.bak-'+Date.now());cfg.permission=np;fs.writeFileSync(file,JSON.stringify(cfg,null,2));
console.log(JSON.stringify({ok:true,oldSalt:old.salt,newSalt:np.salt,start:np.start,end:np.end}));
