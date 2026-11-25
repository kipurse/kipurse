// SPDX-License-Identifier: AGPL-3.0-only
// t1185 (decision 85): V5.3 contract suite (daily on-chain operations cap, default 500/vault, owner-adjustable) - deterministic
// CREATE2 deploy data. PLAN ONLY: builds calldata for the public deterministic deployer and predicts every address; it never signs
// or broadcasts. Mainnet deploy needs the owner's explicit confirmation (handbook §9).
import fs from 'node:fs';import {encodeAbiParameters,concat,keccak256,toHex,getAddress,getContractAddress} from 'viem';
export const DETERMINISTIC_DEPLOYER='0x4e59b44847b379578588920ca78fbf26c0b4956c';
export const BASE={entryPoint:'0x0000000071727De22E5E9d8BAf0edAc6f37da032',paymaster:'0x6C973eBe80dCD8660841D4356bf15c32460271C9',paymaster2:'0x0000000000000000000000000000000000000000',
  manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',feeController:'0x8F52D223DF89E388DcB5d39C53f154b9F8F9a67A'};
const art=(out,file,name)=>{const j=JSON.parse(fs.readFileSync(`${out}/${file}/${name}.json`,'utf8'));return j.bytecode.object??j.bytecode;};
export const SALTS={factory:keccak256(toHex('kipurse-v5.3-factory')),adapter:keccak256(toHex('kipurse-v5.3-adapter'))};
/** {steps:[{label,to,data,address}], factory, adapter, trust} for the given chain constants (defaults: Base mainnet, same paymaster / fee controller as live). */
export function v53Suite({out,c=BASE,deployer=DETERMINISTIC_DEPLOYER}={}){
  const fInit=concat([art(out,'KipurseAdapterV5.sol','PayerVaultFactoryV5'),encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'}],[getAddress(c.entryPoint),getAddress(c.paymaster),getAddress(c.paymaster2)])]);
  const factory=getContractAddress({from:deployer,opcode:'CREATE2',salt:SALTS.factory,bytecode:fInit});
  const aInit=concat([art(out,'KipurseAdapterV52.sol','KipurseAdapterV52'),encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'address'}],[getAddress(c.manager),getAddress(c.usdc),factory,getAddress(c.feeController)])]);
  const adapter=getContractAddress({from:deployer,opcode:'CREATE2',salt:SALTS.adapter,bytecode:aInit});
  const trust=getContractAddress({from:adapter,nonce:1n});
  return {factory,adapter,trust,initHashes:{factory:keccak256(fInit),adapter:keccak256(aInit)},
    steps:[{label:'deploy PayerVaultFactoryV5 (V5.3 vault code: daily operations cap)',to:getAddress(deployer),data:concat([SALTS.factory,fInit]),address:factory,gas:3_500_000n},
           {label:'deploy KipurseAdapterV52 (V5.3; creates KipurseTrustV5 and the vault implementations)',to:getAddress(deployer),data:concat([SALTS.adapter,aInit]),address:adapter,gas:14_000_000n}]};}
