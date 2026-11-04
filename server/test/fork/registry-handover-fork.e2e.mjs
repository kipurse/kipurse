// FORK-ONLY (t629 item 2): hand the merchant-registry maintainer role from the owner's current Base Account to a NEW
// owner-held key. Nothing here touches mainnet: anvil fork + impersonation. Proves: (1) the server's executor key cannot touch the
// registry; (2) two-step, 48 h timelocked handover works and only the new key can accept; (3) gas of each step, priced in USDC.
import test from 'node:test';import assert from 'node:assert/strict';
import {createPublicClient,createTestClient,createWalletClient,http as vh,parseAbi,encodeFunctionData,getAddress} from 'viem';import {base} from 'viem/chains';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';import {decodePolicyV5} from '../../src/v5/abi.mjs';import {ETH_USD_FEED} from '../../src/v5/phone-signer.mjs';
const RPC=process.env.FORK_RPC,PJ=process.env.FORK_PERMISSION_JSON;
const RA=parseAbi(['function maintainer() view returns (address)','function pendingMaintainer() view returns (address)','function pendingMaintainerEta() view returns (uint64)','function delay() view returns (uint256)',
  'function proposeMaintainer(address next)','function acceptMaintainer()','function setBlocked(address who,bool v)']);
const FA=parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
test('registry maintainer handover to a new owner-held key (fork only)',{skip:!RPC||!PJ,timeout:300000},async()=>{
  const perm=JSON.parse(PJ);const pol=decodePolicyV5(perm.extraData);const REG=getAddress(pol.registry),EXEC=getAddress(pol.executor);
  const pub=createPublicClient({chain:base,transport:vh(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:vh(RPC)});
  const OLD=await pub.readContract({address:REG,abi:RA,functionName:'maintainer'});const delay=await pub.readContract({address:REG,abi:RA,functionName:'delay'});
  assert.notEqual(OLD.toLowerCase(),EXEC.toLowerCase(),'the server executor is not the maintainer');
  const tx=async(from,data)=>{await tc.impersonateAccount({address:from});await tc.setBalance({address:from,value:10n**18n});
    const wc=createWalletClient({chain:base,transport:vh(RPC),account:from});try{const h=await wc.sendTransaction({to:REG,data,gas:300000n});const r=await pub.waitForTransactionReceipt({hash:h});return r;}catch(e){return {status:'reverted'};}};
  // (1) server executor key cannot change anything
  assert.notEqual((await tx(EXEC,encodeFunctionData({abi:RA,functionName:'setBlocked',args:[EXEC,true]}))).status,'success');
  assert.notEqual((await tx(EXEC,encodeFunctionData({abi:RA,functionName:'proposeMaintainer',args:[EXEC]}))).status,'success');
  // (2) owner proposes a NEW owner-held key; nobody else can accept; not before the timelock; then the new key accepts
  const NEW=privateKeyToAccount(generatePrivateKey()).address;
  const p=await tx(OLD,encodeFunctionData({abi:RA,functionName:'proposeMaintainer',args:[NEW]}));assert.equal(p.status,'success');
  const acc=encodeFunctionData({abi:RA,functionName:'acceptMaintainer'});
  assert.notEqual((await tx(EXEC,acc)).status,'success','server cannot accept');
  assert.notEqual((await tx(NEW,acc)).status,'success','not before the 48 h timelock');
  await tc.increaseTime({seconds:Number(delay)+1});await tc.mine({blocks:1});
  const a=await tx(NEW,acc);assert.equal(a.status,'success');
  assert.equal((await pub.readContract({address:REG,abi:RA,functionName:'maintainer'})).toLowerCase(),NEW.toLowerCase());
  assert.notEqual((await tx(OLD,encodeFunctionData({abi:RA,functionName:'setBlocked',args:[EXEC,true]}))).status,'success','old maintainer lost the role');
  // (3) cost in USDC at today's real Base gas price (fork mirrors mainnet), plus a smart-account (Base Account) overhead allowance
  const live=createPublicClient({chain:base,transport:vh('https://mainnet.base.org')});const gp=await live.getGasPrice();
  const [,ans]=await live.readContract({address:ETH_USD_FEED,abi:FA,functionName:'latestRoundData'});
  const usdc=g=>Number(g*gp*BigInt(ans)/10n**8n)/1e18;const OVER=150000n;
  console.log('RESULT',JSON.stringify({registry:REG,oldMaintainer:OLD,delayHours:Number(delay)/3600,gasPropose:String(p.gasUsed),gasAccept:String(a.gasUsed),gasPriceGwei:Number(gp)/1e9,ethUsd:Number(ans)/1e8,
    usdcPropose:usdc(p.gasUsed+OVER).toFixed(4),usdcAccept:usdc(a.gasUsed+OVER).toFixed(4)}));});
