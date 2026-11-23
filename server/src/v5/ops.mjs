// SPDX-License-Identifier: AGPL-3.0-only
// Kipurse ops account (KipurseOpsAccountV5): zero-reserve DEPLOYER (M5) and protocol FEE RECIPIENT. Every op is a userOp whose gas
// is paid in USDC by the ops account itself through the Circle paymaster; nobody holds ETH. Deploy-phase helpers build the four ops
// (factory, fee controller, adapter, lock); fee collection runs only when it is profitable.
import {encodeFunctionData,encodeAbiParameters,parseAbi,parseAbiParameters,concat,getAddress,keccak256,getContractAddress,toHex,pad} from 'viem';
import {createUserOpWriter} from './userop.mjs';

export const CREATEX='0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed'; // public CreateX (Base + Base Sepolia); called, never compiled into our code
export const OPS_ABI=parseAbi(['function deploy(bytes32 salt,bytes initCode) returns (address)','function lock(address adapter)',
  'function execute(address target,uint256 value,bytes data)','function executeBatch((address target,uint256 value,bytes data)[] calls)',
  'function locked() view returns (bool)','function adapter() view returns (address)','function maxGasPerOp() view returns (uint96)','function treasury() view returns (address)']);
const CX=parseAbi(['function deployCreate2(bytes32 salt,bytes initCode) payable returns (address)']);
const ADAPTER=parseAbi(['function accruedFees() view returns (uint256)','function collectFees() returns (uint256)']);
const ERC20=parseAbi(['function transfer(address to,uint256 amount) returns (bool)','function balanceOf(address) view returns (uint256)','function DOMAIN_SEPARATOR() view returns (bytes32)']);
const EP=parseAbi(['function getSenderAddress(bytes initCode)']);

/** initCode for the ops account's first userOp: CreateX.deployCreate2(salt, opsCreationCode ++ ctorArgs). */
export function opsInitCode({opsBytecode,entryPoint,paymaster,paymaster2,token,tokenDomain,treasury,signer,maxGasPerOp,maxDeployGas,salt}){
  const init=concat([opsBytecode,encodeAbiParameters(parseAbiParameters('address,address,address,address,bytes32,address,address,uint96,uint96'),
    [entryPoint,paymaster,paymaster2??'0x0000000000000000000000000000000000000000',token,tokenDomain,treasury,signer,BigInt(maxGasPerOp),BigInt(maxDeployGas)])]);
  return concat([CREATEX,encodeFunctionData({abi:CX,functionName:'deployCreate2',args:[salt,init]})]);
}
/** Counterfactual ops address = EntryPoint.getSenderAddress(initCode) (reverts with SenderAddressResult(address)). Read-only. */
export async function opsAddress(pub,{entryPoint,initCode}){
  const data=encodeFunctionData({abi:EP,functionName:'getSenderAddress',args:[initCode]});
  const find=x=>{for(let e=x,i=0;e&&i<8;e=e.cause,i++){for(const v of [e.data,e.data?.data,e.details,e.message]){const m=/0x6ca7b806(?:000000000000000000000000)([0-9a-fA-F]{40})/.exec(typeof v==='string'?v:'');if(m)return getAddress('0x'+m[1]);}}return null;};
  try{await pub.request({method:'eth_call',params:[{to:entryPoint,data},'latest']});}catch(e){const a=find(e);
    // SenderAddressResult(0): the initCode cannot deploy (e.g. the account already exists). Never return 0x0 as an address to fund.
    if(a&&a!=='0x0000000000000000000000000000000000000000')return a;if(a)throw Object.assign(Error('OPS_ADDRESS_ZERO: initCode cannot create the account (already deployed?)'),{code:'ops_address_zero'});throw e;}
  throw Error('getSenderAddress did not revert');
}
/** The deploy plan: CREATE2 by the ops account with fixed salts 1..3, then lock(adapter). Addresses are known before any op. */
export function deployPlan({ops,factoryBytecode,feeCtlBytecode,adapterBytecode,registryBytecode,registryMaintainer,registryDelay=172800n,entryPoint,paymaster,paymaster2,feeAdmin,feePpm=1000n,spm,token}){
  const Z='0x0000000000000000000000000000000000000000';
  const fInit=concat([factoryBytecode,encodeAbiParameters(parseAbiParameters('address,address,address'),[entryPoint,paymaster,paymaster2??Z])]);
  const s=i=>pad(toHex(i),{size:32});
  const factory=getContractAddress({opcode:'CREATE2',from:ops,salt:s(1),bytecode:fInit});
  const cInit=concat([feeCtlBytecode,encodeAbiParameters(parseAbiParameters('address,uint256,address'),[feeAdmin,BigInt(feePpm),ops])]);
  const feeController=getContractAddress({opcode:'CREATE2',from:ops,salt:s(2),bytecode:cInit});
  const aInit=concat([adapterBytecode,encodeAbiParameters(parseAbiParameters('address,address,address,address'),[spm,token,factory,feeController])]);
  const adapter=getContractAddress({opcode:'CREATE2',from:ops,salt:s(3),bytecode:aInit});
  const dep=(i,code)=>encodeFunctionData({abi:OPS_ABI,functionName:'deploy',args:[s(i),code]});
  // optional 5th deploy op (before lock): the merchant registry, maintainer = a multisig, 48h timelock by default
  let registry=null,rStep=[];
  if(registryBytecode){if(!registryMaintainer)throw Error('deployPlan: registryMaintainer required');
    const rInit=concat([registryBytecode,encodeAbiParameters(parseAbiParameters('address,uint256'),[registryMaintainer,BigInt(registryDelay)])]);
    registry=getContractAddress({opcode:'CREATE2',from:ops,salt:s(4),bytecode:rInit});rStep=[{name:'registry',callData:dep(4,rInit),address:registry,initBytes:(rInit.length-2)/2}];}
  return {factory,feeController,adapter,registry,steps:[
    {name:'factory',callData:dep(1,fInit),address:factory,initBytes:(fInit.length-2)/2},
    {name:'feeController',callData:dep(2,cInit),address:feeController,initBytes:(cInit.length-2)/2},
    {name:'adapter',callData:dep(3,aInit),address:adapter,initBytes:(aInit.length-2)/2},...rStep,
    {name:'lock',callData:encodeFunctionData({abi:OPS_ABI,functionName:'lock',args:[adapter]})}]};
}

/** Fee collection as the fee recipient, paying its own gas from the collected USDC. Runs only when accruedFees >= minRatio x the
 *  expected gas charge (default 20x: the gas is <= 5% of what is collected) and >= minCollect; otherwise returns {skipped}.
 *  Optionally forwards `toTreasury` (atomic) in the same op (the contract keeps a 4 x maxGasPerOp gas buffer). Never on a schedule:
 *  the operator / owner calls it. */
export async function collectFeesViaOps({cfg,pub,session,ops,adapter,expectedChargeUsdc,minRatio=20n,minCollect=0n,toTreasury=0n,force=false,writer}){
  const accrued=await pub.readContract({address:adapter,abi:ADAPTER,functionName:'accruedFees'});
  const exp=BigInt(expectedChargeUsdc??0n);
  if(!force&&(accrued===0n||accrued<BigInt(minCollect)||accrued<exp*BigInt(minRatio)))return {skipped:'not_profitable',accrued,expectedChargeUsdc:exp,minRatio:BigInt(minRatio)};
  const maxGas=await pub.readContract({address:ops,abi:OPS_ABI,functionName:'maxGasPerOp'});
  const w=writer??createUserOpWriter({cfg,pub,session,vault:ops,adapter,maxGasPerOp:maxGas});
  const calls=[{to:getAddress(adapter),data:encodeFunctionData({abi:ADAPTER,functionName:'collectFees'})}];
  if(BigInt(toTreasury)>0n){const t=await pub.readContract({address:ops,abi:OPS_ABI,functionName:'treasury'});
    calls.push({to:getAddress(cfg.token),data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[t,BigInt(toTreasury)]})});}
  const r=await w.send(calls);
  return {...r,accrued,netCollected:accrued-r.usdcGas};
}
