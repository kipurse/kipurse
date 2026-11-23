// SPDX-License-Identifier: AGPL-3.0-only
// M5: brand-new PASSKEY Base Account (Coinbase Smart Wallet whose only owner is a P-256 passkey) activates Kipurse with ONE passkey
// signature (= one Face ID), on real Base Sepolia. The account is created in that same operation (initCode), and the kit's whole setup
// batch runs inside it. Then "Take everything back" is a second single passkey signature. Software passkey in a temp 0600 file stands in
// for the iPhone authenticator (same WebAuthn bytes the Secure Enclave returns). Throwaway keys + test USDC only.
//   KIPURSE_ADAPTER=0x... node kit/e2e-passkey-activation-sepolia.mjs <testnet keys.json> [out.json]
import fs from 'node:fs';import {join} from 'node:path';import {spawn} from 'node:child_process';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {randomBytes} from 'node:crypto';
import {createPublicClient,createWalletClient,http,parseAbi,encodeFunctionData,concat,getAddress} from 'viem';import {privateKeyToAccount} from 'viem/accounts';import {baseSepolia} from 'viem/chains';
import {loadOrCreatePasskey,passkeyOwnerBytes,passkeySign} from '../scripts/lib/soft-passkey.mjs';import {CBSW_FACTORY,cbswAbi} from '../src/v5/passkey-test.mjs';
const K=JSON.parse(fs.readFileSync(process.argv[2]));const funder=privateKeyToAccount(K.owner);const out=process.argv[3]??'passkey-activation.json';
const U='0x036CbD53842c5426634e7929541eC2318f3dCF7e',EP='0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';
const pub=createPublicClient({chain:baseSepolia,transport:http('https://sepolia.base.org',{retryCount:3})});const w=createWalletClient({chain:baseSepolia,account:funder,transport:http('https://sepolia.base.org',{retryCount:3})});
const ERC=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);const bal=a=>pub.readContract({address:U,abi:ERC,functionName:'balanceOf',args:[a]});
const WAL=parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable','function execute(address target,uint256 value,bytes data) payable']);
const OP='(address sender,uint256 nonce,bytes initCode,bytes callData,uint256 callGasLimit,uint256 verificationGasLimit,uint256 preVerificationGas,uint256 maxFeePerGas,uint256 maxPriorityFeePerGas,bytes paymasterAndData,bytes signature)';
const EPA=parseAbi([`function getUserOpHash(${OP} op) view returns (bytes32)`,`function handleOps(${OP}[] ops,address beneficiary)`,'function getNonce(address,uint192) view returns (uint256)']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const R=[];const step=(n,ok,ev={})=>{R.push({n,ok:!!ok,ev});console.log((ok?'PASS ':'FAIL ')+n+' '+JSON.stringify(ev).slice(0,220));};
const tx=async h=>{const r=await pub.waitForTransactionReceipt({hash:h,timeout:180000});if(r.status!=='success')throw Error('reverted '+h);return r;};
const pkDir=mkdtempSync(join(tmpdir(),'pk-'));const pk=loadOrCreatePasskey(join(pkDir,'passkey.json'));const owners=[passkeyOwnerBytes(pk)];const salt=BigInt('0x'+randomBytes(8).toString('hex'));
const BA=getAddress(await pub.readContract({address:CBSW_FACTORY,abi:cbswAbi,functionName:'getAddress',args:[owners,salt]}));
let faceIds=0;
async function passkeyOp(calls,{init}){const gp=await pub.getGasPrice();
  const op={sender:BA,nonce:await pub.readContract({address:EP,abi:EPA,functionName:'getNonce',args:[BA,0n]}),initCode:init?concat([CBSW_FACTORY,encodeFunctionData({abi:cbswAbi,functionName:'createAccount',args:[owners,salt]})]):'0x',
    callData:encodeFunctionData({abi:WAL,functionName:'executeBatch',args:[calls.map(c=>({target:getAddress(c.to),value:BigInt(c.value??0),data:c.data}))]}),
    callGasLimit:3500000n,verificationGasLimit:init?1500000n:800000n,preVerificationGas:120000n,maxFeePerGas:gp*2n+1000n,maxPriorityFeePerGas:gp,paymasterAndData:'0x',signature:'0x'};
  const h=await pub.readContract({address:EP,abi:EPA,functionName:'getUserOpHash',args:[op]});op.signature=passkeySign(pk,{challenge:h,ownerIndex:0});faceIds++;
  return tx(await w.writeContract({address:EP,abi:EPA,functionName:'handleOps',args:[[op],funder.address],gas:6000000n}));}
const P=8713,B=`http://localhost:${P}`;const DIR=mkdtempSync(join(tmpdir(),'pkkit-'));const KEYF=join(mkdtempSync(join(tmpdir(),'pkk-')),'k.key');
const srv=spawn(process.execPath,['kit/server.mjs','--port',String(P),'--dir',DIR],{stdio:'ignore',env:{KIPURSE_DEMO:'1',...process.env,KIPURSE_KEY_FILE:KEYF,KIPURSE_PUBLIC_URL:B}});
try{for(let i=0;i<60&&!fs.existsSync(join(DIR,'owner-link.txt'));i++)await sleep(500);
  const lg=await fetch(fs.readFileSync(join(DIR,'owner-link.txt'),'utf8').trim(),{redirect:'manual'});const cookie=lg.headers.get('set-cookie').split(';')[0];const csrf=(await (await fetch(B+'/api/csrf',{headers:{cookie}})).json()).csrf;
  const api=async(p,b)=>{const r=await fetch(B+'/api/'+p,{method:'POST',headers:{cookie,'x-kp-csrf':csrf,'content-type':'application/json','x-kp-lang':'en',origin:B},body:JSON.stringify(b??{})});const j=await r.json();if(!r.ok)throw Error(p+': '+j.error);return j;};
  step('new passkey Base Account address (not deployed yet)',(await pub.getCode({address:BA}))===undefined,{baseAccount:BA});
  const prep=await api('prepare',{owner:BA,answers:{termDays:30,perPayment:'0.2',perDay:'0.3',termTotal:'0.35',unrecognizedPerPayment:'0.05',unrecognizedPerDay:'0.1',depositDailyLimit:'1',withdrawalAddress:funder.address,riskNoticeAcknowledged:true,technicalConsent:true}});
  await tx(await w.writeContract({address:U,abi:ERC,functionName:'transfer',args:[prep.wallet,250000n],gas:120000n}));
  await tx(await w.sendTransaction({to:BA,value:2000000000000000n,gas:60000n}));   // ETH only for the EntryPoint prefund in this headless stand-in (a paymaster covers it in the Base app)
  const r1=await passkeyOp(prep.calls,{init:true});let code;for(let i=0;i<10;i++){code=await pub.getCode({address:BA});if(code?.length>2)break;await sleep(2000);}
  step('ONE passkey signature creates the Base Account AND runs the full Kipurse setup batch',r1.status==='success'&&code?.length>2,{tx:r1.transactionHash,faceIds,innerCalls:prep.calls.length,gasUsed:r1.gasUsed.toString()});
  let st;for(let i=0;i<60;i++){st=await api('state');if(st.setup?.active)break;await sleep(5000);}step('kit sees the wallet active',st.setup?.active,{wallet:prep.wallet,reserve:st.reserve});
  const rv=await api('revokeCalls');const total=(await bal(prep.wallet))+BigInt(st.reserve??'0');
  const back={to:prep.wallet,data:encodeFunctionData({abi:WAL,functionName:'execute',args:[U,0n,encodeFunctionData({abi:ERC,functionName:'transfer',args:[funder.address,total]})]})};
  const r2=await passkeyOp([...rv.calls,back],{init:false});await sleep(5000);
  step('"Take everything back" is ONE more passkey signature; wallet ends empty',r2.status==='success'&&(await bal(prep.wallet))===0n,{tx:r2.transactionHash,returned:total.toString(),faceIds});
}catch(e){step('crashed',false,{err:String(e.message).slice(0,300)});}
finally{srv.kill();fs.rmSync(pkDir,{recursive:true,force:true});fs.writeFileSync(out,JSON.stringify({when:new Date().toISOString(),steps:R},null,1));console.log(`${R.filter(x=>x.ok).length}/${R.length} passed`);}
