// Read-only Base chain access for the shop (public RPC, failover over a list). Nothing here signs or sends anything.
import {createPublicClient,http,fallback,parseAbi,parseAbiItem,getAddress} from 'viem';import {base} from 'viem/chains';
export const USDC_BASE='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)']);
const TRANSFER=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
export function makePublicClient(rpcs){const list=(Array.isArray(rpcs)?rpcs:String(rpcs).split(',')).map(s=>s.trim()).filter(Boolean);if(!list.length)throw Error('no RPC configured');
  return createPublicClient({chain:base,transport:list.length===1?http(list[0],{timeout:15000,retryCount:1}):fallback(list.map(u=>http(u,{timeout:15000,retryCount:1})))});}
/** chain reader used by the shop; injectable in tests */
export function chainReader(pub,{token=USDC_BASE,maxRange=1500n}={}){const tsCache=new Map();
  async function blockTs(n){const k=String(n);if(tsCache.has(k))return tsCache.get(k);const b=await pub.getBlock({blockNumber:BigInt(n)});const t=Number(b.timestamp);
    if(tsCache.size>5000)tsCache.clear();tsCache.set(k,t);return t;}
  return {
    blockNumber:async()=>await pub.getBlockNumber({cacheTime:0}),
    balanceOf:async a=>BigInt(await pub.readContract({address:getAddress(token),abi:ERC20,functionName:'balanceOf',args:[getAddress(a)]})),
    /** USDC transfers INTO `to` in blocks [from, to] (chunked), each with its block timestamp */
    async transfersTo(addr,fromBlock,toBlock){const out=[];let a=BigInt(fromBlock);const z=BigInt(toBlock);
      while(a<=z){const b=a+maxRange-1n<z?a+maxRange-1n:z;
        const logs=await pub.getLogs({address:getAddress(token),event:TRANSFER,args:{to:getAddress(addr)},fromBlock:a,toBlock:b});
        for(const l of logs)out.push({txHash:l.transactionHash,logIndex:Number(l.logIndex),block:Number(l.blockNumber),from:getAddress(l.args.from),value:BigInt(l.args.value),ts:await blockTs(l.blockNumber)});
        a=b+1n;}
      return out;},
    blockTs};}
