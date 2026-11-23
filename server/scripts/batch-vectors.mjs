// Generates test/vectors/batch-verify.json: real server-built batches (same builders as production) + tampered variants,
// used by the iOS BatchVerifyTests and test/batch-commit.test.mjs. Public test data only (anvil-style keys, no user data).
import fs from 'node:fs';import {P256} from 'ox';
import {encodeFunctionData,encodeAbiParameters,getAddress,parseAbi,keccak256,getContractAddress,concat,pad,toHex} from 'viem';
import {approverInit,DETERMINISTIC_DEPLOYER,WALLET_ABI} from '../src/v5/phone-signer.mjs';import {buildMigrationPlanV5} from '../src/v5/plan.mjs';
import {commitment,canon} from '../src/v5/batch-commit.mjs';
const FACT=parseAbi(['function createAccount(bytes[] owners,uint256 nonce) returns (address)']);const F='0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842';
const TRUST='0x6b91dcb27cf3d69b1d9a6fddeb06ed1af2ed0bf9',ADAPTER='0xc7d7c8b03e94576bc3c99a7e37827e07f7d9a4e8',SPM='0xf85210B21cC50302F477BA56686d2019dC9b67Ad',USDC='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const IMPL='0x00000110dCdEdC9581cb5eCB8467282f2926534d';
const OWNER=getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8'),ATTACKER=getAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'),EXEC=getAddress('0x90F79bf6EB2c4f870365E785982E1f101E93b906');
const pk=P256.getPublicKey({privateKey:'0x'+'2b'.repeat(32)});
const x=toHex(pk.x,{size:32}),y=toHex(pk.y,{size:32});
const owners=[encodeAbiParameters([{type:'address'}],[OWNER])];
const W=getContractAddress({from:F,opcode:'CREATE2',salt:keccak256(encodeAbiParameters([{type:'bytes[]'},{type:'uint256'}],[owners,0n])),bytecode:concat(['0x603d3d8160223d3973',IMPL,'0x60095155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3'])});
const ch={single:'5000000',daily:'20000000',term:'100000000',days:90};const now=1798000000;
const pl=buildMigrationPlanV5({chainId:8453,wallet:W,owner:OWNER,adapter:ADAPTER,trust:TRUST,token:USDC,manager:SPM,executor:EXEC,guardian:'0x0000000000000000000000000000000000000000',registry:'0x0000000000000000000000000000000000000000',headroom:false,
  maxFeePpm:'3000',maxNetworkFee:'50000',fee:{ppm:'1000'},stated:{single:ch.single,daily:ch.daily,term:ch.term,openSingle:'100000',openDaily:'1000000',verifiedSingle:ch.single,verifiedDaily:ch.daily},
  start:now-60,end:now-60+ch.days*86400,salt:7n,revoke:[],zeroReserve:{vault:'0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',buffer:0}});
const a=approverInit({wallet:W,trust:TRUST,x,y,maxSingle:ch.single,maxDaily:ch.daily,version:'v3'});
const c=(to,data)=>({to,value:'0x0',data});const wf=(fn,args)=>encodeFunctionData({abi:WALLET_ABI,functionName:fn,args});
const setupNew=[c(F,encodeFunctionData({abi:FACT,functionName:'createAccount',args:[owners,0n]})),c(DETERMINISTIC_DEPLOYER,a.deployData),c(W,wf('addOwnerAddress',[SPM])),c(W,pl.walletExecuteBatch.data),c(W,wf('addOwnerAddress',[a.address]))];
const ERC=parseAbi(['function transfer(address to,uint256 amount) returns (bool)']);
const refund=amt=>c(W,wf('execute',[USDC,0n,encodeFunctionData({abi:ERC,functionName:'transfer',args:[OWNER,amt]})]));
const oldAp=getAddress('0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65');
const enroll=[c(DETERMINISTIC_DEPLOYER,a.deployData),c(W,wf('addOwnerAddress',[a.address])),c(W,wf('removeOwnerAtIndex',[2n,pad(oldAp)])),refund(24000n)];
const revoke=[c(W,wf('removeOwnerAtIndex',[2n,pad(oldAp)]))];
const aBad=approverInit({wallet:W,trust:TRUST,x:toHex(P256.getPublicKey({privateKey:'0x'+'3c'.repeat(32)}).x,{size:32}),y:toHex(P256.getPublicKey({privateKey:'0x'+'3c'.repeat(32)}).y,{size:32}),maxSingle:ch.single,maxDaily:ch.daily,version:'v3'});
const T={
  setup_attacker_owner:setupNew.map((k,i)=>i===4?c(W,wf('addOwnerAddress',[ATTACKER])):k),
  setup_other_owner_wallet:[c(F,encodeFunctionData({abi:FACT,functionName:'createAccount',args:[[encodeAbiParameters([{type:'address'}],[ATTACKER])],0n]})),...setupNew.slice(1)],
  setup_other_phone:[setupNew[0],c(DETERMINISTIC_DEPLOYER,aBad.deployData),setupNew[2],setupNew[3],c(W,wf('addOwnerAddress',[aBad.address]))],
  setup_extra_transfer:[...setupNew,c(W,wf('execute',[USDC,0n,encodeFunctionData({abi:ERC,functionName:'transfer',args:[ATTACKER,1000000n]})]))],
  setup_eth:setupNew.map((k,i)=>i===2?{...k,value:'0x1'}:k),
  enroll_remove_owner:[...enroll.slice(0,2),c(W,wf('removeOwnerAtIndex',[0n,pad(OWNER)]))],
  enroll_refund_attacker:[...enroll.slice(0,3),c(W,wf('execute',[USDC,0n,encodeFunctionData({abi:ERC,functionName:'transfer',args:[ATTACKER,24000n]})]))],
  enroll_refund_big:[...enroll.slice(0,3),refund(60000n)],
  enroll_other_phone:[c(DETERMINISTIC_DEPLOYER,aBad.deployData),c(W,wf('addOwnerAddress',[aBad.address]))],
  revoke_owner:[c(W,wf('removeOwnerAtIndex',[0n,pad(OWNER)]))],
};
// t767u: same setup with the dues slot (vault.setBundlerFee(Kipurse ops, 0.05)) as the last inner call, + tampered variants
const VAULT='0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',OPS='0xf14ef5dc4723245866c22c749a0a84afceba0dd9';
const plD=(bf)=>buildMigrationPlanV5({chainId:8453,wallet:W,owner:OWNER,adapter:ADAPTER,trust:TRUST,token:USDC,manager:SPM,executor:EXEC,guardian:'0x0000000000000000000000000000000000000000',registry:'0x0000000000000000000000000000000000000000',headroom:false,
  maxFeePpm:'3000',maxNetworkFee:'50000',fee:{ppm:'1000'},stated:{single:ch.single,daily:ch.daily,term:ch.term,openSingle:'100000',openDaily:'1000000',verifiedSingle:ch.single,verifiedDaily:ch.daily},
  start:now-60,end:now-60+ch.days*86400,salt:7n,revoke:[],zeroReserve:{vault:bf.vault??VAULT,buffer:0,bundlerFee:{to:bf.to,maxPerOp:bf.max}}});
const withPl=p=>setupNew.map((k,i)=>i===3?c(W,p.walletExecuteBatch.data):k);
const dues={vault:VAULT,setupNewDues:withPl(plD({to:OPS,max:50000n})),tampered:{dues_to_attacker:withPl(plD({to:ATTACKER,max:50000n})),dues_cap_too_high:withPl(plD({to:OPS,max:50001n})),dues_other_vault:withPl(plD({to:OPS,max:50000n,vault:ATTACKER}))}};
const out={owner:OWNER,wallet:W,x,y,approver:a.address,choice:ch,setupNew,enroll,revoke,revokeApprover:oldAp,tampered:T,dues,
  commit:{chainId:8453,from:OWNER,calls:setupNew,canon:canon({chainId:8453,from:OWNER,calls:setupNew}),hex:commitment({chainId:8453,from:OWNER,calls:setupNew})}};
fs.writeFileSync(new URL('../test/vectors/batch-verify.json',import.meta.url),JSON.stringify(out,null,1));console.log('wallet',W,'approver',a.address,'start',now-60);
