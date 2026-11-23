// SPDX-License-Identifier: AGPL-3.0-only
// t1250 (handbook §6#119): V5.5 contract suite - deterministic CREATE2 deploy PLAN. PLAN ONLY: builds the deterministic deployer's
// calldata from the forge build of work/t1214/contracts, predicts every address and (with --check) reads the chain to confirm every
// predicted address is still empty. It never signs, never sends, never broadcasts.
//   node mainnet/v55-plan.mjs [--out <contracts/out>] [--gas <measured-gas.json>] [--check <rpc>] [--write mainnet/v55-deploy-plan.json]
// Canonical build: work/t1214/contracts, forge 1.10.0 / solc 0.8.37, via_ir, optimizer 200, cancun; the metadata uses RELATIVE remappings,
// so the bytecode does not depend on where the folder sits (checked: the plan's sha256 is the same from any copy of the folder).
import fs from 'node:fs';import {createHash} from 'node:crypto';
import {encodeAbiParameters,concat,keccak256,toHex,getAddress,getContractAddress,createPublicClient,http} from 'viem';
export const DETERMINISTIC_DEPLOYER='0x4e59b44847b379578588920cA78FbF26c0B4956C';
/** Live Base contracts the V5.5 suite REUSES (read from chain 2026-11-22: V5.4 adapter fees() / V5.3 factory entryPoint()/paymaster()/paymaster2()). */
export const BASE_V55={chainId:8453,entryPoint:'0x0000000071727De22E5E9d8BAf0edAc6f37da032',paymaster:'0x6C973eBe80dCD8660841D4356bf15c32460271C9',
  paymaster2:'0x0000000000000000000000000000000000000000',manager:'0xf85210B21cC50302F477BA56686d2019dC9b67Ad',usdc:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  feeController:'0x8F52D223DF89E388DcB5d39C53f154b9F8F9a67A',cbswFactory:'0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',
  registryMaintainer:'0x4242b022A8296cB18B0E0b1Cb9879C518170A718'/* synthetic placeholder: set your registry maintainer (the live registry's maintainer is readable on chain) */,registryDelay:172800n};
export const SALTS_V55={factory:keccak256(toHex('kipurse-v5.5-factory')),adapter:keccak256(toHex('kipurse-v5.5-adapter')),registry:keccak256(toHex('kipurse-v5.5-registry-v2'))};
export const SEAT_V2_SALT=keccak256(toHex('kipurse-key-seat-v2'));
const art=(out,file,name)=>{const j=JSON.parse(fs.readFileSync(`${out}/${file}/${name}.json`,'utf8'));return j.bytecode.object??j.bytecode;};
const sha=h=>createHash('sha256').update(Buffer.from(String(h).replace(/^0x/,''),'hex')).digest('hex');
const A=a=>({type:'address'}),enc=(types,vals)=>encodeAbiParameters(types.map(t=>({type:t})),vals);
/** Pure: every init code, salt and address of the suite for the given chain constants. */
export function v55Suite({out,c=BASE_V55,deployer=DETERMINISTIC_DEPLOYER}){
  const fArgs=[getAddress(c.entryPoint),getAddress(c.paymaster),getAddress(c.paymaster2)];
  const fInit=concat([art(out,'KipursePayerVaultV55.sol','PayerVaultFactoryV55'),enc(['address','address','address'],fArgs)]);
  const factory=getContractAddress({from:deployer,opcode:'CREATE2',salt:SALTS_V55.factory,bytecode:fInit});
  const aArgs=[getAddress(c.manager),getAddress(c.usdc),factory,getAddress(c.feeController)];
  const aInit=concat([art(out,'KipurseAdapterV55.sol','KipurseAdapterV55'),enc(['address','address','address','address'],aArgs)]);
  const adapter=getContractAddress({from:deployer,opcode:'CREATE2',salt:SALTS_V55.adapter,bytecode:aInit});
  const trust=getContractAddress({from:adapter,nonce:1n});               // adapter constructor: `new KipurseTrustV55()` (first CREATE)
  const vaultImpl=getContractAddress({from:factory,nonce:1n});           // factory.prepare (called by the adapter constructor): PayerVaultV55 impl
  const floatImpl=getContractAddress({from:factory,nonce:2n});           //   then KipurseFloatVaultV55 impl
  const rArgs=[getAddress(c.registryMaintainer),BigInt(c.registryDelay)];
  const rInit=concat([art(out,'KipurseMerchantRegistryV2.sol','KipurseMerchantRegistryV2'),enc(['address','uint256'],rArgs)]);
  const registry=getContractAddress({from:deployer,opcode:'CREATE2',salt:SALTS_V55.registry,bytecode:rInit});
  const seatCode=art(out,'KipurseKeySeatV2.sol','KipurseKeySeatV2');
  const step=(label,key,salt,init,address)=>({label,key,to:getAddress(deployer),address,salt,initCodeKeccak:keccak256(init),data:concat([salt,init])});
  return {factory,adapter,trust,vaultImpl,floatImpl,registry,constructorArgs:{factory:fArgs,adapter:aArgs,registry:rArgs.map(String)},
    seatV2:{salt:SEAT_V2_SALT,creationCodeKeccak:keccak256(seatCode),creationCodeBytes:(seatCode.length-2)/2},
    steps:[step('PayerVaultFactoryV55(entryPoint v0.7, Circle paymaster, paymaster2 = none) - same values as the live V5.3/V5.4 factory','factory',SALTS_V55.factory,fInit,factory),
           step('KipurseAdapterV55(SPM, USDC, factoryV55, live fee controller) - its constructor creates KipurseTrustV55 and the shared PayerVaultV55 / KipurseFloatVaultV55 implementations','adapter',SALTS_V55.adapter,aInit,adapter),
           step('KipurseMerchantRegistryV2(maintainer = the owner\'s Base Account, delay 48 h) - same maintainer/delay as the live registry','registry',SALTS_V55.registry,rInit,registry)]};}
/** Read-only: every predicted address has no code and nonce 0 on the given RPC. */
export async function checkEmpty(pub,S){const out={};for(const k of ['factory','adapter','trust','vaultImpl','floatImpl','registry']){const a=S[k];
  const [c,n]=await Promise.all([pub.getCode({address:a}),pub.getTransactionCount({address:a})]);out[k]={address:a,code:!c||c==='0x'?'0x':'present',nonce:n,empty:(!c||c==='0x')&&n===0};}
  return out;}
if(import.meta.url===`file://${process.argv[1]}`){
  const arg=k=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:null;};
  const out=arg('--out')??new URL('../../contracts/out',import.meta.url).pathname;
  const S=v55Suite({out});const gas=arg('--gas')?JSON.parse(fs.readFileSync(arg('--gas'),'utf8')):null;
  let check=null;if(arg('--check')){const pub=createPublicClient({transport:http(arg('--check'),{timeout:15000})});check={rpc:new URL(arg('--check')).host,block:String(await pub.getBlockNumber()),at:new Date().toISOString(),addresses:await checkEmpty(pub,S)};}
  const plan={note:'t1250 (handbook §6#119): V5.5 suite, deterministic CREATE2 deploy via the public deterministic deployer. PLAN ONLY: nothing here was signed or sent. Canonical build: work/t1214/contracts (forge 1.10.0, solc 0.8.37, via_ir, optimizer 200, evm cancun; relative remappings, so the bytecode is location independent). The owner\'s Base Account sends the steps (see src/v5/deploy-v55.mjs deployV55Batches); KipurseKeySeatV2 is per wallet (CREATE2 in each opening batch), not part of this plan.',
    chainId:8453,deployer:DETERMINISTIC_DEPLOYER,
    reused:{feeController:BASE_V55.feeController,spendPermissionManager:BASE_V55.manager,usdc:BASE_V55.usdc,coinbaseSmartWalletFactory:BASE_V55.cbswFactory,entryPointV07:BASE_V55.entryPoint,circlePaymaster:BASE_V55.paymaster,paymaster2:BASE_V55.paymaster2},
    addresses:{factory:S.factory,adapter:S.adapter,trust:S.trust,vaultImpl:S.vaultImpl,floatImpl:S.floatImpl,registryV2:S.registry},
    derivation:{trust:'CREATE(adapter, nonce 1)',vaultImpl:'CREATE(factory, nonce 1)',floatImpl:'CREATE(factory, nonce 2)',vault:'adapter.vaultAddress(wallet) = factory.vaultAddress(adapter, wallet, USDC) = EIP-1167 clone of vaultImpl, CREATE2(factory, salt = bytes32(uint256(uint160(wallet))))',
      seatV2:'CREATE2(deployer, keccak256("kipurse-key-seat-v2"), keccak256(KipurseKeySeatV2.creationCode ‖ abi.encode(cbswFactory, ownerBaseAccount, SPM, trust)))',wallet:'cbswFactory.getAddress([abi.encode(owner), abi.encode(seatV2), abi.encode(SPM)], 0)'},
    constructorArgs:S.constructorArgs,seatV2:S.seatV2,
    gas:gas??undefined,onChainCheck:check??undefined,
    steps:S.steps.map(s=>({label:s.label,key:s.key,to:s.to,address:s.address,salt:s.salt,initCodeKeccak:s.initCodeKeccak,sha256:sha(s.data),gas:gas?.steps?.[s.key]??undefined,data:String(s.data).toLowerCase()}))};
  const txt=JSON.stringify(plan,null,1)+'\n';
  if(arg('--write'))fs.writeFileSync(arg('--write'),txt);
  console.log(JSON.stringify({...plan,steps:plan.steps.map(s=>({...s,data:s.data.slice(0,66)+'… ('+((s.data.length-2)/2)+' bytes)'}))},null,1));}
