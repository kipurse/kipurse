// Sweep: move the USDC that customers paid into one deposit address to the owner's wallet, WITHOUT anyone holding ETH.
// Each deposit address is a plain EOA (key derived from the shop seed). The sweep is ONE ERC-4337 user operation on EntryPoint v0.8 in which
//   - the deposit EOA signs an EIP-7702 authorization that delegates it to eth-infinitism's Simple7702Account (the address stays the same),
//   - the call is Simple7702Account.execute(USDC, 0, transfer(owner, balance - permitAmount)),
//   - gas is paid in USDC by that same address through Circle's USDC paymaster for v0.8 (EIP-2612 permit in paymasterData).
// Circle refunds over-prefund in postOp, so a little dust (permitAmount - actual gas charge) stays in the address; a later sweep picks it up
// once it is worth more than the fee. The destination is fixed by configuration; nothing here accepts a destination from a request.
// Why not a Coinbase Smart Wallet: its implementation (factory 0xBA5ED110...) only works with EntryPoint v0.6, and Circle's USDC paymasters
// exist only for v0.7 / v0.8. A 7702-delegated EOA on v0.8 keeps the same "no ETH, gas in USDC" property and plain EOA keys stay
// recoverable by hand if the bundler / paymaster route is ever unavailable.
import {encodeFunctionData,encodePacked,encodeAbiParameters,parseAbiParameters,parseAbi,getAddress,keccak256,toHex,maxUint256,hexToBigInt,decodeEventLog} from 'viem';
import {toSimple7702SmartAccount,formatUserOperationRequest,entryPoint08Abi} from 'viem/account-abstraction';
export const ENTRYPOINT_V08='0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
export const CIRCLE_PAYMASTER_V08='0x0578cFB241215b77442a541325d6A4E6dFE700Ec';
export const SIMPLE7702_IMPL='0xe6Cae83BdE06E4c305530e199D7217f42808555B';
export const CHAINLINK_ETH_USD_BASE='0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const ERC20=parseAbi(['function balanceOf(address) view returns (uint256)','function nonces(address) view returns (uint256)','function DOMAIN_SEPARATOR() view returns (bytes32)','function transfer(address to,uint256 amount) returns (bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
const FEED=parseAbi(['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const PERMIT_TYPEHASH=keccak256(toHex('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));
export function bundlerRpc(url,{fetch:f=globalThis.fetch}={}){let id=0;
  return async(method,params)=>{const r=await f(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(30000)});
    const j=await r.json().catch(()=>({error:{message:'HTTP '+r.status}}));if(j.error)throw Object.assign(Error('bundler '+method+': '+String(j.error.message??JSON.stringify(j.error)).slice(0,300)),{code:'bundler_error'});return j.result;};}
/** USDC atomic per 1 ETH from Chainlink (8 decimals -> 6); fallback = a deliberately high price (bigger permit, never too small) */
export async function usdcPerEth(pub,{feed=CHAINLINK_ETH_USD_BASE,fallbackUsd=10000n}={}){try{const r=await pub.readContract({address:feed,abi:FEED,functionName:'latestRoundData'});const p=BigInt(r[1]);if(p>0n)return p/100n;}catch{}return fallbackUsd*1_000_000n;}
/** permit = Circle's prefund estimate (gas limits x maxFee x price x 1.1) x safety, at least 0.001 USDC, at most cap */
export function sizePermit({totalGas,maxFeePerGas,usdcPerEthAtomic,safetyBps=20000n,cap}){const wei=BigInt(totalGas)*BigInt(maxFeePerGas);
  let p=(wei*BigInt(usdcPerEthAtomic)*11n/10n+10n**18n-1n)/10n**18n;p=(p*BigInt(safetyBps)+9999n)/10000n;if(p<1000n)p=1000n;return p>BigInt(cap)?BigInt(cap):p;}
const pad=(v,bps)=>BigInt(v)*BigInt(10000+bps)/10000n;
/**
 * Sweep one deposit address. owner = viem LocalAccount of the deposit key; to = fixed destination.
 * Returns {state:'swept'|'skipped', ...}. Throws on a bundler / chain error (nothing is lost: the funds stay where they are).
 */
export async function sweepOne({pub,rpc,owner,to,token,chainId=8453,entryPoint=ENTRYPOINT_V08,paymaster=CIRCLE_PAYMASTER_V08,implementation=SIMPLE7702_IMPL,
  maxGasAtomic=50_000n,minSendAtomic=10_000n,price,pollMs=2000,timeoutMs=180000,log=()=>{}}){
  const sender=getAddress(owner.address);token=getAddress(token);to=getAddress(to);
  const bal=BigInt(await pub.readContract({address:token,abi:ERC20,functionName:'balanceOf',args:[sender]}));
  if(bal<=minSendAtomic)return {state:'skipped',reason:'balance_too_small',address:sender,balance:bal.toString()};
  const account=await toSimple7702SmartAccount({client:pub,owner,implementation,entryPoint:{abi:entryPoint08Abi,address:getAddress(entryPoint),version:'0.8'}});
  const eoaNonce=await pub.getTransactionCount({address:sender,blockTag:'pending'});
  const authorization=await owner.signAuthorization({contractAddress:getAddress(implementation),chainId,nonce:eoaNonce});
  const nonce=BigInt(await pub.readContract({address:getAddress(entryPoint),abi:entryPoint08Abi,functionName:'getNonce',args:[sender,0n]}));
  const domainSep=await pub.readContract({address:token,abi:ERC20,functionName:'DOMAIN_SEPARATOR'});
  const permitNonce=await pub.readContract({address:token,abi:ERC20,functionName:'nonces',args:[sender]});
  async function paymasterData(amount){const digest=keccak256(encodePacked(['bytes2','bytes32','bytes32'],['0x1901',domainSep,keccak256(encodeAbiParameters(parseAbiParameters('bytes32,address,address,uint256,uint256,uint256'),[PERMIT_TYPEHASH,sender,getAddress(paymaster),amount,permitNonce,maxUint256]))]));
    const sig=await owner.sign({hash:digest});return encodePacked(['uint8','address','uint256','bytes'],[0,token,amount,sig]);}
  let fees;try{const g=await rpc('pimlico_getUserOperationGasPrice',[]);fees={maxFeePerGas:hexToBigInt(g.standard.maxFeePerGas),maxPriorityFeePerGas:hexToBigInt(g.standard.maxPriorityFeePerGas)};}
  catch{const f=await pub.estimateFeesPerGas();fees={maxFeePerGas:f.maxFeePerGas,maxPriorityFeePerGas:f.maxPriorityFeePerGas};}
  const cap=BigInt(maxGasAtomic);const callFor=amount=>account.encodeCalls([{to:token,value:0n,data:encodeFunctionData({abi:ERC20,functionName:'transfer',args:[to,amount]})}]);
  const est0=bal-1n<cap?bal-1n:cap;
  const op={sender,nonce,factory:'0x7702',factoryData:'0x',callData:await callFor(bal-est0),callGasLimit:200000n,verificationGasLimit:200000n,preVerificationGas:100000n,...fees,
    paymaster:getAddress(paymaster),paymasterVerificationGasLimit:200000n,paymasterPostOpGasLimit:60000n,paymasterData:await paymasterData(est0),authorization};
  op.signature=await account.signUserOperation(op);
  const est=await rpc('eth_estimateUserOperationGas',[formatUserOperationRequest(op),getAddress(entryPoint)]);
  op.callGasLimit=pad(est.callGasLimit,2000);op.verificationGasLimit=pad(est.verificationGasLimit,2000);op.preVerificationGas=pad(est.preVerificationGas,1000);
  if(est.paymasterVerificationGasLimit){const v=pad(est.paymasterVerificationGasLimit,2000);if(v>op.paymasterVerificationGasLimit)op.paymasterVerificationGasLimit=v;}
  if(est.paymasterPostOpGasLimit){const v=pad(est.paymasterPostOpGasLimit,2000);if(v>op.paymasterPostOpGasLimit)op.paymasterPostOpGasLimit=v;}
  const totalGas=op.callGasLimit+op.verificationGasLimit+op.preVerificationGas+op.paymasterVerificationGasLimit+op.paymasterPostOpGasLimit;
  const px=price??await usdcPerEth(pub);
  async function attempt(permit){if(bal-permit<minSendAtomic)return {state:'skipped',reason:'fee_too_close_to_balance',address:sender,balance:bal.toString(),permit:permit.toString()};
    op.callData=await callFor(bal-permit);op.paymasterData=await paymasterData(permit);op.signature=await account.signUserOperation(op);
    const userOpHash=await rpc('eth_sendUserOperation',[formatUserOperationRequest(op),getAddress(entryPoint)]);log('sweep_sent',{address:sender,userOpHash});
    let rc=null;const t0=Date.now();while(!rc){rc=await rpc('eth_getUserOperationReceipt',[userOpHash]).catch(()=>null);if(!rc){if(Date.now()-t0>timeoutMs)throw Object.assign(Error('sweep receipt timeout '+userOpHash),{code:'receipt_timeout',userOpHash});await new Promise(r=>setTimeout(r,pollMs));}}
    let charged=0n,refund=0n,sent=0n;for(const l of rc.receipt?.logs??rc.logs??[]){if(getAddress(l.address)!==token)continue;let e;try{e=decodeEventLog({abi:ERC20,data:l.data,topics:l.topics});}catch{continue;}
      const f=getAddress(e.args.from),t=getAddress(e.args.to);if(f===sender&&t===getAddress(paymaster))charged+=e.args.value;if(f===getAddress(paymaster)&&t===sender)refund+=e.args.value;if(f===sender&&t===to)sent+=e.args.value;}
    return {state:rc.success?'swept':'reverted',address:sender,to,balanceBefore:bal.toString(),sent:sent.toString(),gasUsdc:(charged-refund).toString(),permit:permit.toString(),userOpHash,txHash:rc.receipt?.transactionHash??null};}
  const permit=sizePermit({totalGas,maxFeePerGas:op.maxFeePerGas,usdcPerEthAtomic:px,cap});
  try{return await attempt(permit);}
  catch(e){if(/AA33|allowance|exceeds/i.test(String(e.message))&&permit<cap){log('sweep_retry_at_cap',{address:sender});return await attempt(cap);}throw e;}}
