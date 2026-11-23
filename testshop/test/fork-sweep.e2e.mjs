// FORK-ONLY e2e of the shop's money path on a Base mainnet fork (anvil): customers pay real USDC transfers to new deposit addresses,
// the shop sees paid / review, then `sweep` moves the USDC to the owner wallet with ONE EIP-7702 + ERC-4337 v0.8 user operation per address,
// gas paid in USDC through the REAL Circle paymaster v0.8 on the fork. The deposit addresses never hold ETH. Never touches a real network.
// Usage: FORK_RPC=http://127.0.0.1:8697 node test/fork-sweep.e2e.mjs
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID,randomBytes} from 'node:crypto';
import {createPublicClient,createTestClient,createWalletClient,http,parseAbi,keccak256,encodeAbiParameters,toHex,getAddress} from 'viem';import {base} from 'viem/chains';import {privateKeyToAccount} from 'viem/accounts';
import {shopKeys} from '../src/keys.mjs';import {chainReader} from '../src/chain.mjs';import {createShop,USDC} from '../src/shop.mjs';import {bundlerRpc,SIMPLE7702_IMPL} from '../src/sweep.mjs';
import {startBundler7702} from './helpers/bundler7702-shim.mjs';
const RPC=process.env.FORK_RPC??'http://127.0.0.1:8697';const OWNER='0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb';
const pub=createPublicClient({chain:base,transport:http(RPC)});const tc=createTestClient({chain:base,mode:'anvil',transport:http(RPC)});
if(Number(await pub.getChainId())!==8453||!(await tc.request({method:'anvil_nodeInfo'}).catch(()=>null)))throw Error('refusing: FORK_RPC is not an anvil Base fork');
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)']);const bal=a=>pub.readContract({address:USDC,abi:ERC20,functionName:'balanceOf',args:[a]});
let ok=true;const out=[];const chk=(n,c,d)=>{out.push({n,ok:!!c,d});if(!c)ok=false;console.log((c?'PASS ':'FAIL ')+n+' '+JSON.stringify(d??'',(k,v)=>typeof v==='bigint'?v.toString():v).slice(0,300));};
// a fork-only customer (anvil dev account #1) with test USDC set in storage; it pays with REAL USDC transfers (Transfer logs)
const cust=privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
await tc.setStorageAt({address:USDC,index:keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[cust.address,9n])),value:toHex(5_000_000n,{size:32})});
const wc=createWalletClient({chain:base,transport:http(RPC),account:cust});const pay=async(to,amt)=>pub.waitForTransactionReceipt({hash:await wc.writeContract({address:USDC,abi:ERC20,functionName:'transfer',args:[to,amt]})});
const B=await startBundler7702({rpc:RPC,log:m=>console.log('BUNDLER',m)});
const d=mkdtempSync(join(tmpdir(),'testshop-fork-'));const keys=shopKeys(randomBytes(32));
const shop=createShop({stateFile:join(d,'state.json'),keys,origin:'http://127.0.0.1:1',chain:chainReader(pub),refreshMinMs:0,nowS:()=>Math.floor(Date.now()/1000),log:(e,x)=>console.log('SHOP',e,JSON.stringify(x)),
  sweep:{to:OWNER,rpc:bundlerRpc(B.url),pub,pollMs:300,autoMinAtomic:300000n}});
const o1=(await shop.createOrder({purchaseId:randomUUID(),item:'poster'})).body,o2=(await shop.createOrder({purchaseId:randomUUID(),item:'badge'})).body,o3=(await shop.createOrder({purchaseId:randomUUID(),item:'sticker'})).body,o4=(await shop.createOrder({purchaseId:randomUUID(),item:'sticker'})).body;
await pay(o1.depositAddress,500000n);await pay(o2.depositAddress,200000n);await pay(o3.depositAddress,150000n);
const st=async o=>(await shop.getStatus(o.purchaseId)).status;
chk('exact payments -> paid',await st(o1)==='paid'&&await st(o2)==='paid',{o1:await st(o1),o2:await st(o2)});
chk('wrong amount -> review',await st(o3)==='review');chk('unpaid -> open',await st(o4)==='open');
for(const o of [o1,o2,o3])chk('deposit '+o.orderId+' holds USDC and NO ETH',await bal(o.depositAddress)>0n&&await pub.getBalance({address:o.depositAddress})===0n);
const dry=await shop.sweepAll({dryRun:true});chk('dry run lists the 3 funded addresses only',dry.results.filter(r=>r.state==='would_sweep').length===3,dry.results.map(r=>r.state));
const owner0=await bal(OWNER);const r=await shop.sweepAll({reason:'fork-test'});
for(const x of r.results)console.log('SWEEP',JSON.stringify(x));
const swept=r.results.filter(x=>x.state==='swept');chk('sweep: 3 user operations succeeded (7702 + v0.8 + Circle paymaster)',swept.length===3&&B.sent.length===3&&B.sent.every(s=>s.success&&s.authorization),r.results.map(x=>x.state+':'+(x.error??'')));
const owner1=await bal(OWNER);const sent=swept.reduce((a,x)=>a+BigInt(x.sent),0n);const gas=swept.reduce((a,x)=>a+BigInt(x.gasUsdc),0n);
chk('owner wallet received exactly what the sweep reports',owner1-owner0===sent&&sent>0n,{received:owner1-owner0,sent});
let dust=0n;for(const o of [o1,o2,o3]){const b=await bal(o.depositAddress);dust+=b;}
chk('conservation: paid in (0.85) = to owner + USDC gas + dust left in the addresses',sent+gas+dust===850000n,{sent,gas,dust});
chk('gas was paid in USDC (small) and the addresses still hold no ETH',gas>0n&&gas<60000n&&(await Promise.all([o1,o2,o3].map(o=>pub.getBalance({address:o.depositAddress})))).every(x=>x===0n),{gas});
{const code=await pub.getCode({address:o1.depositAddress});chk('deposit address is now 7702-delegated to Simple7702Account',code?.toLowerCase()==='0xef0100'+SIMPLE7702_IMPL.slice(2).toLowerCase(),{code});}
chk('after the sweep, orders still read paid / review (paymaster refund is not a customer payment)',await st(o1)==='paid'&&await st(o2)==='paid'&&await st(o3)==='review',{o1:await st(o1)});
const again=await shop.sweepAll({reason:'fork-test-2'});chk('second sweep: nothing left worth sweeping (dust below the minimum), nothing sent',again.results.every(x=>x.state==='skipped')&&B.sent.length===3,again.results.map(x=>x.state+':'+(x.reason??x.error??'')));
// a second payment cycle on an already-delegated address works too (late money to a swept order)
await pay(o1.depositAddress,300000n);chk('late payment to a swept order -> review',await st(o1)==='review');
const r3=await shop.sweepAll({reason:'fork-test-3',all:true});chk('re-sweep of an already-delegated address succeeds',r3.results.some(x=>x.state==='swept'&&x.address===getAddress(o1.depositAddress)),r3.results.map(x=>x.state+':'+(x.error??x.reason??'')));
console.log(JSON.stringify({sweptToOwner:(await bal(OWNER)-owner0).toString(),userOps:B.sent.length}));
B.close();console.log(ok?'ALL PASS':'SOME FAIL');process.exit(ok?0:1);
