// V5 test fixture: Sepolia-shaped config + in-memory mock of the V5 adapter reads (no network).
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {hashDomain,keccak256,toHex} from 'viem';import {createEngineV5} from '../../src/v5/engine.mjs';import {encodePolicyV5,ZERO,ZERO32} from '../../src/v5/abi.mjs';import {purchaseKeyV5} from '../../src/v5/ref.mjs';
export const USDC='0x036CbD53842c5426634e7929541eC2318f3dCF7e',ADAPTER='0x00000000000000000000000000000000000A5005',WALLET='0xc44Cf075a58Df30B7c63b114CdF6784376009E0b',EXEC='0x68a0C5D60983c0b90973a7352284bb8839e1E435';
export const PAYEE='0xaC3c14a42628EAA726DCF3560c97F4cB4F4Bd521',TRUSTED='0x3444AA8eD2716e0F60483E02DEC8EDaB7B2E94d3',VAULT='0x00000000000000000000000000000000000Fa017';
export const MERCH=keccak256(toHex('shop.example'));
export const FLOATV='0x000000000000000000000000000000000000F10a';
export const TRUSTC='0x00000000000000000000000000000000000071A5',FEECTL='0x0000000000000000000000000000000000000Fc1';
export function policy(over={}){return {executor:EXEC,guardian:ZERO,single:'6000000',daily:'12000000',term:'30000000',openSingle:'100000',openDaily:'200000',verifiedSingle:'0',verifiedDaily:'0',registry:ZERO,maxFeePpm:'1000',maxNetworkFee:'50000',...over};}
export function cfgFor(over={},pol={}){const now=Math.floor(Date.now()/1000);const P=policy(pol);
  return {chainId:84532,rpc:'http://unused.invalid',adapter:ADAPTER,manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',token:USDC,policy:P,fee:{ppm:'1000',recipient:'0xc0ded1524f49244a3e59165ca305f484fbe362a6'},gasPricing:{usdcPerEth:'2500000000',gasPriceWei:'7000000'},
    permission:{account:WALLET,spender:ADAPTER,token:USDC,allowance:P.term,period:30*86400,start:now-86400,end:now+29*86400,salt:'0',extraData:encodePolicyV5(P)},
    merchantRegistry:[{id:'shop.example',name:'Shop',payTo:[TRUSTED]}],retryDelayMs:1,...over};}
export function mockChain(st={}){
  const s={bal:5000000n,term:0n,today:0n,openToday:0n,merchToday:0n,paused:false,used:new Set(),orderUsed:new Set(),trusted:{},simRevert:null,writes:[],delayMs:20,settled:true,reservations:{},...st};
  const read=async(fn,args=[])=>{switch(fn){case 'getHash':return '0x'+'ab'.repeat(32);case 'balanceOf':return args[0]===FLOATV?(s.floatBal??0n):s.bal;case 'floats':return s.float??[ZERO32,0n,0n,0n,false];case 'floatCap':return s.floatCap??0n;case 'floatAddress':return FLOATV;case 'floatBlocked':return s.paused||(s.floatDenied??[]).includes(args[1]);case 'termSpent':return s.term;case 'daySpent':return s.today;case 'openDaySpent':return s.openToday;
    case 'verifiedDaySpent':return 0n;case 'merchantDaySpent':return s.merchToday;case 'paused':case 'isPaused':return s.paused;case 'pausedUntil':return 0n;case 'trust':return TRUSTC;case 'fees':return FEECTL;case 'feePpm':return 1000n;case 'feeRecipient':return '0xc0ded1524f49244a3e59165ca305f484fbe362a6';case 'accruedFees':return s.accrued??0n;case 'pendingFees':return 0n;case 'deniedPayee':return false;case 'deniedSigner':return false;case 'registryOptOut':return false;
    case 'trustedPayee':return s.trusted[String(args[1]).toLowerCase()]?[MERCH,1n]:[ZERO32,0n];case 'trustedSigner':return [ZERO32,0n];
    case 'trustOf':return args[1]===MERCH&&Object.keys(s.trusted).length?[1n,4102444800n,true,1000000n,2000000n]:[s.epoch??0n,0n,false,0n,0n];
    case 'purchaseUsed':return s.used.has(args[1]);case 'orderUsed':return s.orderUsed.has(String(args[1]).toLowerCase());
    case 'DOMAIN_SEPARATOR':return hashDomain({domain:{name:'USDC',version:'2',chainId:84532,verifyingContract:USDC},types:{EIP712Domain:[{name:'name',type:'string'},{name:'version',type:'string'},{name:'chainId',type:'uint256'},{name:'verifyingContract',type:'address'}]}});
    case 'vaultAddress':return VAULT;case 'authorizationDigest':return keccak256(toHex(JSON.stringify(args,(k,v)=>typeof v==='bigint'?v.toString():v)));
    case 'authorizationState':return s.settled;case 'reserved':return 0n;
    case 'reservations':{const r=s.reservations[args[0]];return r?[WALLET,0n,BigInt(r.validBefore),1,r.open,ZERO32,ZERO32,ZERO32,0n,0n,0n]:[ZERO,0n,0n,0,false,ZERO32,ZERO32,ZERO32,0n,0n,0n];}
    default:throw Error('mock read '+fn);}};
  const write=async(fn,args,o={})=>{s.writes.push({fn,args,label:o.label,address:o.address});const h='0x'+String(s.writes.length).padStart(64,'0');await o.beforeSend?.(h);await new Promise(z=>setTimeout(z,s.delayMs));
    if(s.revertOnChain>0){s.revertOnChain--;throw Object.assign(Error('TX_REVERTED'),{hash:h,gasUsed:300000n,gasPrice:7000000n,onChain:true});} // passed simulation, reverted on chain
    if(fn==='collectFees')s.accrued=0n;
    if(fn==='fundFloat'){s.float=[ZERO32,args[2],(args[2]*1000n+999999n)/1000000n,args[3],true];s.floatBal=args[2];}if(fn==='reconcileFloat'){s.float=[ZERO32,0n,0n,0n,false];s.floatBal=0n;}
    if(fn==='payDirect')s.used.add(purchaseKeyV5(args[1].payee,args[1].merchantRef,args[1].repeatKey));if(fn==='prepareAuthorization')s.used.add(purchaseKeyV5(args[1].to,args[1].merchantRef,args[1].repeatKey));if(fn==='paySigned')s.orderUsed.add(args[1].orderId.toLowerCase());
    if(fn==='markSettled')for(const d of args[0])s.reservations[d].open=false;if(fn==='reclaim')s.reservations[args[0]].open=false;return {hash:h,blockNumber:1n};};
  const pub={getBlock:async()=>({timestamp:BigInt(Math.floor(Date.now()/1000))}),simulateContract:async()=>{if(s.simRevert)throw Object.assign(Error(s.simRevert),{shortMessage:'execution reverted: '+s.simRevert});return {};},
    estimateContractGas:async()=>200000n,getGasPrice:async()=>7000000n,
    readContract:async({functionName,args})=>{if(functionName==='getL1Fee'){s.l1Calls=(s.l1Calls??0)+1;s.l1Data=args[0];return s.l1Fee??0n;}throw Error('mock pub read '+functionName);}};
  return {s,client:{pub,read,write,idle:async()=>{}}};
}
export function engineFor(over={},st={},pol={}){const m=mockChain(st);const dir=mkdtempSync(join(tmpdir(),'v5-'));const cfg=cfgFor(over,pol);
  return {...m,cfg,engine:createEngineV5(cfg,{ledgerFile:join(dir,'l.sqlite'),client:m.client,agentDefault:'a1'})};}
export const direct=(amount='20000',ref='ord-1',payee=PAYEE)=>({direct:{chainId:84532,token:USDC,payee,amount,merchantOrderId:ref}});
