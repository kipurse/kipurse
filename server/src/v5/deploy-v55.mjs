// SPDX-License-Identifier: AGPL-3.0-only
// t1250 (handbook §6#119): the V5.5 suite deploy, the same practical way as the V5.4 deploy (deploy-v54.mjs): the owner's own Base Account
// confirms fixed batches in Coinbase; each batch = deterministic-deployer calls (CREATE2, pinned init code) + a USDC fee leg from the owner's
// Base Account to the Kipurse fee address. PREPARED ONLY: this module loads + verifies mainnet/v55-deploy-plan.json and builds the batches,
// their KPVH commitments and a wallet_sendCalls payload. It never signs or sends. The page / sponsor wiring of V5.4 (createDeployV54) is
// not cloned here: it is OFF for V5.5 until the owner asks for the deploy (then mirror createDeployV54 with these batches).
// Two batches (not one): the adapter alone is ~11-12M gas (its constructor creates the trust and both vault implementations); the V5.4 deploy
// op was ~10.2M and passed Coinbase's estimator, so each V5.5 batch is kept near that size.
import fs from 'node:fs';import {createHash} from 'node:crypto';
import {getAddress,getContractAddress,slice,encodeFunctionData,parseAbi} from 'viem';
import {V55,V55_PIN,v55On} from './suite-v55.mjs';
import {commitment} from './batch-commit.mjs';
export const deployV55On=v55On;
export const DEPLOYER=V55.deployer;
/** Fee per batch (6 dp): actual cost is far lower (see the plan's gas section); the same 0.15 headroom the V5.3 / V5.4 deploys used. */
export const DEPLOY_V55_FEE_USDC=150_000n;
const sha=h=>createHash('sha256').update(Buffer.from(String(h).replace(/^0x/,''),'hex')).digest('hex');
const KEYS=['factory','adapter','registry'];
/** Load + verify the fixed plan: 3 steps, each to the deployer, sha256-pinned, CREATE2 address = pinned address. Throws otherwise. */
export function loadV55Plan(src){const D=typeof src==='string'?JSON.parse(fs.readFileSync(src,'utf8')):src;const S=D?.steps;
  if(!Array.isArray(S)||S.length!==3)throw Error('v55 plan: need exactly 3 steps');
  const want={factory:V55.factory,adapter:V55.adapter,registry:V55.registryV2};const steps={};
  S.forEach((s,i)=>{const k=KEYS[i];if(s.key!==k)throw Error('v55 plan: step order');if(getAddress(s.to)!==getAddress(DEPLOYER))throw Error('v55 plan: not to the deployer');
    if(!/^0x[0-9a-fA-F]+$/.test(String(s.data))||sha(s.data)!==V55_PIN[k].sha256)throw Error('v55 plan: data hash '+k);
    const a=getContractAddress({opcode:'CREATE2',from:DEPLOYER,salt:slice(s.data,0,32),bytecode:slice(s.data,32)});
    if(a!==getAddress(want[k])||getAddress(s.address)!==a)throw Error('v55 plan: address '+k);
    steps[k]={key:k,label:String(s.label??''),to:getAddress(DEPLOYER),address:a,data:String(s.data).toLowerCase(),gas:s.gas!=null?BigInt(s.gas):null};});
  if(getAddress(D.addresses?.trust)!==getContractAddress({from:V55.adapter,nonce:1n}))throw Error('v55 plan: trust');
  return {addresses:{...D.addresses},steps,gas:D.gas??null};}
const TRA=parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const feeLeg=f=>({to:getAddress(V55.usdc),value:'0x0',data:encodeFunctionData({abi:TRA,functionName:'transfer',args:[getAddress(V55.feeTo),f]})});
/** The owner's batches: [1] factory + registry V2 + fee, [2] adapter (needs the factory) + fee. Order matters: batch 2 only after 1 landed. */
export function deployV55Batches(plan,{fee=DEPLOY_V55_FEE_USDC}={}){const f=BigInt(fee);if(f<=0n||f>250_000n)throw Error('fee');
  const c=s=>({to:s.to,value:'0x0',data:s.data});
  return [{n:1,label:'V5.5 vault factory + merchant registry V2',calls:[c(plan.steps.factory),c(plan.steps.registry),feeLeg(f)],creates:[plan.steps.factory.address,plan.steps.registry.address]},
          {n:2,label:'V5.5 adapter (creates KipurseTrustV55 + vault / float implementations)',calls:[c(plan.steps.adapter),feeLeg(f)],creates:[plan.steps.adapter.address,plan.addresses.trust]}];}
export const deployV55Commitment=(batch,owner)=>commitment({chainId:8453,from:getAddress(owner),calls:batch.calls});
/** EIP-5792 wallet_sendCalls params the signing page would hand to the Base Account (capabilities: the page adds its paymaster URL). */
export const sendCallsPayload=(batch,owner)=>({version:'2.0.0',chainId:'0x2105',from:getAddress(owner),atomicRequired:true,calls:batch.calls.map(c=>({to:c.to,value:c.value,data:c.data}))});
/** Which batch is next (read-only): 1 until the factory + registry exist, 2 until the adapter exists, then done. */
export async function deployV55State(pub){const has=async a=>{const c=await pub.getCode({address:getAddress(a)});return !!c&&c!=='0x';};
  const [f,r,a]=await Promise.all([has(V55.factory),has(V55.registryV2),has(V55.adapter)]);return {factory:f,registry:r,adapter:a,next:!(f&&r)?1:!a?2:null,done:f&&r&&a};}
