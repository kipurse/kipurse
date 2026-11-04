// SPDX-License-Identifier: AGPL-3.0-only
// ZERO-RESERVE gas path (design 2026-10-17, primary P): the owner's PayerVaultV5 is the ERC-4337 v0.7 sender, the session signer
// (Policy.executor) signs userOps and holds NOTHING, gas is paid in USDC from the vault through the Circle Paymaster (permit mode,
// permitAmount <= Policy.maxGasPerOp), the bundler is pluggable (Pimlico public on Sepolia; mainnet: bring-your-own key or a free tier).
// Kipurse never fronts ETH or pays a sponsor bill. The USDC charge is the ACTUAL Circle charge (Circle refunds over-prefund in postOp);
// the next op tops the vault buffer up by exactly the charges not yet topped up (no margin).
import fs from 'node:fs';
import {encodeFunctionData,encodePacked,encodeAbiParameters,parseAbiParameters,parseAbi,getAddress,keccak256,toHex,decodeEventLog,maxUint256,hexToBigInt} from 'viem';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {getUserOperationHash} from 'viem/account-abstraction';
import {abiFor} from './abi.mjs';
import {circleCharge,permitAmount as sizePermit,paymasterSelector,circleCandidate} from './paymaster.mjs';

export const ENTRYPOINT_V07='0x0000000071727De22E5E9d8BAf0edAc6f37da032';
export const CIRCLE_PAYMASTER={8453:{v07:'0xc0de9762a5f06d7f98293b77d74230c750cba078',v08:'0xc0dec557cc20caccfa15407b240d5b47cad05aa8'},84532:{v07:'0xc0de34489365d618bb2a51f349b634f011492e48'}};
export const PIMLICO_PUBLIC=chainId=>`https://public.pimlico.io/v2/${chainId}/rpc`;
export const GAS_MODES=['userop','f2','legacy'];
const VAULT_ABI=parseAbi(['function execute(address target,uint256 value,bytes data)','function executeBatch((address target,uint256 value,bytes data)[] calls)',
  'function sessionSigner() view returns (address)','function maxGasPerOp() view returns (uint256)',
  'function paymaster() view returns (address)','function paymaster2() view returns (address)','function bundlerFeeTo() view returns (address)','function maxBundlerFee() view returns (uint96)','function reserved() view returns (uint256)']);
/** t766: amount of Kipurse dues this op may carry: only via the vault's owner-set fee slot (bundlerFeeTo == ops account), never more than
 *  the dues, the vault's on-chain maxBundlerFee, the payment's network-fee limit, or the vault's free USDC after keeping one op of gas. */
export function duesAmount({due,feeTo,opsTo,maxFee,netCap,balance,reserved,gasKeep}){if(!due||due<=0n||!feeTo||!opsTo||feeTo.toLowerCase()!==opsTo.toLowerCase())return 0n;
  let a=due;for(const c of [BigInt(maxFee??0),BigInt(netCap??0)])if(c<a)a=c;const free=BigInt(balance??0)-BigInt(reserved??0)-BigInt(gasKeep??0);if(free<a)a=free;return a>0n?a:0n;}
const XFER=parseAbi(['function transfer(address to,uint256 amount) returns (bool)']);
const EP_ABI=parseAbi(['function getNonce(address sender,uint192 key) view returns (uint256)',
  'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash,address indexed sender,uint256 nonce,bytes revertReason)']);
const ERC20=parseAbi(['function nonces(address) view returns (uint256)','function balanceOf(address) view returns (uint256)','function DOMAIN_SEPARATOR() view returns (bytes32)','event Transfer(address indexed from,address indexed to,uint256 value)']);
const PERMIT_TYPEHASH=keccak256(toHex('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));

/** Session signer key: generated once into a 0600 file, never printed or returned; only its ADDRESS leaves this module. */
export function loadOrCreateSessionKey(file){
  if(!fs.existsSync(file)){fs.writeFileSync(file,JSON.stringify({key:generatePrivateKey()}),{mode:0o600});}
  if((fs.statSync(file).mode&0o777)!==0o600)throw Error('session key file must be 0600');
  return privateKeyToAccount(JSON.parse(fs.readFileSync(file,'utf8')).key);
}

/** Pluggable bundler. `url` may carry the user's own API key (BYO); it is never logged or returned. Hosted default: a provider free tier,
 *  `maxOpsPerDay` keeps it inside the free quota (over it -> retry later, never a bill for us). costPerOpUsdc must be 0: a paid bundler
 *  is only allowed with the user's own key (the user pays the provider directly), so our reserve stays zero. */
export function bundlerFrom(cfg){
  const b=cfg.bundler??{};const url=b.url??(b.urlEnv?process.env[b.urlEnv]:undefined)??(cfg.chainId===84532?PIMLICO_PUBLIC(84532):undefined);
  if(!url)throw Object.assign(Error('BUNDLER_NOT_CONFIGURED'),{code:'bundler_not_configured',detail:'mainnet needs bundler.url / bundler.urlEnv (bring your own key) or a hosted free-tier endpoint'});
  if(BigInt(b.costPerOpUsdc??0)!==0n)throw Object.assign(Error('BUNDLER_COST_NOT_ZERO'),{code:'bundler_cost_not_zero',detail:'a paid bundler is only allowed with the user\'s own key; Kipurse never pays it'});
  let id=0;const used=new Map();
  const rpc=async(method,params)=>{const r=await(cfg.bundlerFetch??fetch)(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
    const j=await r.json().catch(()=>({error:{message:`HTTP ${r.status} (non-JSON response)`}}));if(j.error)throw Object.assign(Error(`bundler ${method}: ${j.error.message??JSON.stringify(j.error).slice(0,200)}`),{code:'bundler_error',bundlerCode:j.error.code,data:j.error.data});return j.result;};
  return {rpc,label:b.label??(url.startsWith('https://public.pimlico.io')?'pimlico-public':'custom'),
    quota(){const d=new Date().toISOString().slice(0,10);const n=used.get(d)??0;if(b.maxOpsPerDay&&n>=b.maxOpsPerDay)return false;used.set(d,n+1);return true;}};
}

const hex=v=>toHex(BigInt(v));
export function toRpcOp(o){const r={sender:o.sender,nonce:hex(o.nonce),...(o.factory?{factory:o.factory,factoryData:o.factoryData}:{}),callData:o.callData,callGasLimit:hex(o.callGasLimit),verificationGasLimit:hex(o.verificationGasLimit),
  preVerificationGas:hex(o.preVerificationGas),maxFeePerGas:hex(o.maxFeePerGas),maxPriorityFeePerGas:hex(o.maxPriorityFeePerGas),signature:o.signature};
  if(o.paymaster){r.paymaster=o.paymaster;r.paymasterVerificationGasLimit=hex(o.paymasterVerificationGasLimit);r.paymasterPostOpGasLimit=hex(o.paymasterPostOpGasLimit);r.paymasterData=o.paymasterData;}
  return r;}

/** Net USDC the paymaster took from the vault in this tx (prefund - postOp refund) = the actual charge. */
export function usdcCharged(logs,{token,vault,paymaster}){let out=0n,back=0n;
  for(const l of logs??[]){if(getAddress(l.address)!==getAddress(token))continue;let e;try{e=decodeEventLog({abi:ERC20,data:l.data,topics:l.topics});}catch{continue;}
    if(e.eventName!=='Transfer')continue;const f=getAddress(e.args.from),t=getAddress(e.args.to);
    if(f===getAddress(vault)&&t===getAddress(paymaster))out+=e.args.value;if(f===getAddress(paymaster)&&t===getAddress(vault))back+=e.args.value;}
  return out-back;}

/** writer.write(fn,args,{address,label,beforeSend}) with the same contract as the executor writer, but every call goes through the vault. */
export function createUserOpWriter({cfg,pub,session,vault,adapter,maxGasPerOp,onCharge,selector,dues=null}){
  const chainId=cfg.chainId,token=getAddress(cfg.token),ep=getAddress(cfg.entryPoint??ENTRYPOINT_V07);
  const defaultPm=getAddress(cfg.paymaster??CIRCLE_PAYMASTER[chainId]?.v07);const bundler=bundlerFrom(cfg);
  // permit sizing: Circle's last observed price (its UserOperationSponsored event) or the configured estimate; x safety, capped
  let lastPrice=cfg.userOp?.usdcPerEthEstimate!==undefined?BigInt(cfg.userOp.usdcPerEthEstimate):null;
  const SAFETY=BigInt(cfg.userOp?.permitSafetyBps??15000);
  const sel=selector??paymasterSelector([circleCandidate({address:defaultPm,usdcPerEth:async()=>lastPrice??0n})]);
  let paymaster=defaultPm;let allow=null;let lastDues=0n;
  const allowlisted=async()=>allow??=Promise.all(['paymaster','paymaster2'].map(f=>pub.readContract({address:vault,abi:VAULT_ABI,functionName:f}).catch(()=>null)));
  // optional per-op bundler fee pass-through (user-paid, OFF by default); must match what the owner set in the vault
  const bf=cfg.bundler?.feeTo?{to:getAddress(cfg.bundler.feeTo),amount:BigInt(cfg.bundler.feePerOpUsdc??0)}:null;let bfOk=null;
  async function checkBundlerFee(){if(!bf)return;bfOk??=(async()=>{const [to,max]=await Promise.all([pub.readContract({address:vault,abi:VAULT_ABI,functionName:'bundlerFeeTo'}),pub.readContract({address:vault,abi:VAULT_ABI,functionName:'maxBundlerFee'})]);
    if(getAddress(to)!==bf.to||BigInt(max)<bf.amount)throw Object.assign(Error('BUNDLER_FEE_NOT_AUTHORIZED: the owner has not set this bundler fee in the vault (setBundlerFee); nothing was sent'),{code:'bundler_fee_not_authorized'});})();return bfOk;}
  const PM_VER=BigInt(cfg.userOp?.paymasterVerificationGasLimit??200000),PM_POST=BigInt(cfg.userOp?.paymasterPostOpGasLimit??40000);
  let domain;
  async function permitData(amount){
    domain??=await pub.readContract({address:token,abi:ERC20,functionName:'DOMAIN_SEPARATOR'});
    const n=await pub.readContract({address:token,abi:ERC20,functionName:'nonces',args:[vault]});
    const digest=keccak256(encodePacked(['bytes2','bytes32','bytes32'],['0x1901',domain,keccak256(encodeAbiParameters(parseAbiParameters('bytes32,address,address,uint256,uint256,uint256'),[PERMIT_TYPEHASH,vault,paymaster,amount,n,maxUint256]))]));
    const ecdsa=await session.sign({hash:digest});
    const permitSig=encodeAbiParameters(parseAbiParameters('address,uint256,uint256,uint256,bytes'),[paymaster,amount,n,maxUint256,ecdsa]);
    return encodePacked(['uint8','address','uint256','bytes'],[0,token,amount,permitSig]);
  }
  async function fees(){try{const g=await bundler.rpc('pimlico_getUserOperationGasPrice',[]);return {maxFeePerGas:hexToBigInt(g.standard.maxFeePerGas),maxPriorityFeePerGas:hexToBigInt(g.standard.maxPriorityFeePerGas)};}
    catch{const f=await pub.estimateFeesPerGas();return {maxFeePerGas:f.maxFeePerGas,maxPriorityFeePerGas:f.maxPriorityFeePerGas};}}
  const hashOf=o=>getUserOperationHash({chainId,entryPointAddress:ep,entryPointVersion:'0.7',userOperation:o});
  async function build(calls0,{permitAtCap=false,raw=null}={}){
    if(!raw)await checkBundlerFee();let calls=!raw&&bf&&bf.amount>0n?[...calls0,{to:token,data:encodeFunctionData({abi:XFER,functionName:'transfer',args:[bf.to,bf.amount]})}]:calls0;
    // t766u: Kipurse dues (fronted onboarding gas, failed-op debt) ride along in the vault's single fee slot when no bundler fee uses it
    let duesTaken=0n;if(!raw&&dues&&!(bf&&bf.amount>0n)){try{const due=BigInt(await dues.get());if(due>0n){const [to,mx,bal,rs]=await Promise.all([pub.readContract({address:vault,abi:VAULT_ABI,functionName:'bundlerFeeTo'}),pub.readContract({address:vault,abi:VAULT_ABI,functionName:'maxBundlerFee'}),pub.readContract({address:token,abi:ERC20,functionName:'balanceOf',args:[vault]}),pub.readContract({address:vault,abi:VAULT_ABI,functionName:'reserved'})]);
      duesTaken=duesAmount({due,feeTo:to,opsTo:dues.to,maxFee:mx,netCap:maxGasPerOp,balance:bal,reserved:rs,gasKeep:maxGasPerOp});
      if(duesTaken>0n)calls=[...calls,{to:token,data:encodeFunctionData({abi:XFER,functionName:'transfer',args:[getAddress(dues.to),duesTaken]})}];else dues.blocked?.(getAddress(to)===getAddress(dues.to)?'no_room':'fee_slot_not_set');}}catch{duesTaken=0n;}}
    lastDues=duesTaken;
    const callData=raw?raw.callData:calls.length===1?encodeFunctionData({abi:VAULT_ABI,functionName:'execute',args:[calls[0].to,0n,calls[0].data]})
      :encodeFunctionData({abi:VAULT_ABI,functionName:'executeBatch',args:[calls.map(c=>({target:c.to,value:0n,data:c.data}))]});
    const nonce=await pub.readContract({address:ep,abi:EP_ABI,functionName:'getNonce',args:[vault,0n]});
    const cap=BigInt(maxGasPerOp);
    const o={sender:vault,nonce,callData,...(raw?.initCode?{factory:getAddress(raw.initCode.slice(0,42)),factoryData:'0x'+raw.initCode.slice(42)}:{}),callGasLimit:600000n,verificationGasLimit:150000n,preVerificationGas:80000n,...await fees(),
      paymaster,paymasterVerificationGasLimit:PM_VER,paymasterPostOpGasLimit:PM_POST,paymasterData:await permitData(cap)};
    o.signature=await session.signMessage({message:{raw:hashOf(o)}});
    // simulate first (bundler estimate executes the call): a reverting payment is never sent, so it costs nobody anything
    const est=await bundler.rpc('eth_estimateUserOperationGas',[toRpcOp(o),ep]);
    const pad=(v,bps)=>BigInt(v)*BigInt(10000+bps)/10000n;
    o.callGasLimit=pad(est.callGasLimit,1000);
    // bundler estimates overshoot CREATE2-heavy calls ~2x (Pimlico: 2.26M for a 1.15M fundFloat). A loose callGasLimit inflates Circle's USDC
    // prefund past the owner's maxGasPerOp permit (and v0.7 bills 10% of unused call gas), so take the tighter of the bundler's figure and a
    // direct eth_estimateGas of vault.execute from the EntryPoint (exact execution) + 15%.
    try{const own=await pub.estimateGas({account:ep,to:vault,data:callData});const tight=pad(own,1500)+10000n;if(tight<o.callGasLimit)o.callGasLimit=tight;}catch{}if(raw?.callGasLimit)o.callGasLimit=BigInt(raw.callGasLimit);o.verificationGasLimit=pad(est.verificationGasLimit,1000);o.preVerificationGas=pad(est.preVerificationGas,500);
    if(est.paymasterVerificationGasLimit){const v=pad(est.paymasterVerificationGasLimit,1000);o.paymasterVerificationGasLimit=v>PM_VER?v:PM_VER;}
    if(est.paymasterPostOpGasLimit){const v=pad(est.paymasterPostOpGasLimit,1000);o.paymasterPostOpGasLimit=v>PM_POST?v:PM_POST;} // Circle rejects postOp limits < 35k (PostOpGasLimitTooLow) even when the bundler measures less
    // pick the cheapest allowlisted paymaster for the final limits, then size the permit: estimate x safety, capped by maxGasPerOp
    const totalGas=o.callGasLimit+o.verificationGasLimit+o.preVerificationGas+o.paymasterVerificationGasLimit+o.paymasterPostOpGasLimit;
    const pick=await sel.select({allowlisted:await allowlisted(),totalGas,maxFeePerGas:o.maxFeePerGas});
    if(pick.address!==paymaster){paymaster=pick.address;o.paymaster=paymaster;}
    o.permitAmount=permitAtCap?cap:sizePermit({totalGas,maxFeePerGas:o.maxFeePerGas,usdcPerEth:lastPrice,cap,safetyBps:SAFETY});
    o.paymasterData=pick.data?await pick.data({amount:o.permitAmount}):await permitData(o.permitAmount);
    o.signature=await session.signMessage({message:{raw:hashOf(o)}});
    return o;
  }
  async function send(calls,{beforeSend,timeoutMs=180000,raw=null,kind}={}){
    if(!bundler.quota())throw Object.assign(Error('BUNDLER_QUOTA'),{code:'retry_later',detail:'hosted bundler free-tier quota reached; nothing was sent'});
    let o=await build(calls,{raw});let limits={callGasLimit:o.callGasLimit,verificationGasLimit:o.verificationGasLimit,preVerificationGas:o.preVerificationGas,paymasterVerificationGasLimit:o.paymasterVerificationGasLimit,paymasterPostOpGasLimit:o.paymasterPostOpGasLimit,maxFeePerGas:o.maxFeePerGas};
    const totalGas=limits.callGasLimit+limits.verificationGasLimit+limits.preVerificationGas+limits.paymasterVerificationGasLimit+limits.paymasterPostOpGasLimit;
    let userOpHash,retriedAtCap=false;
    const isAllowance=e=>/AA33/.test(e.message)&&/allowance|exceeds/i.test(e.message);
    try{userOpHash=await bundler.rpc('eth_sendUserOperation',[toRpcOp(o),ep]);}
    catch(e0){let e=e0;
      // the sized permit was below Circle's real prefund (price moved): retry ONCE at the owner's cap; never above it
      if(isAllowance(e)&&o.permitAmount<BigInt(maxGasPerOp)){retriedAtCap=true;o=await build(calls,{permitAtCap:true,raw});
        try{userOpHash=await bundler.rpc('eth_sendUserOperation',[toRpcOp(o),ep]);e=null;}catch(e1){e=e1;}}
      if(e&&isAllowance(e))throw Object.assign(Error('GAS_CAP_TOO_LOW: the paymaster prefund for this op exceeds the owner\'s maxGasPerOp permit; nothing was sent or charged'),{code:'gas_cap_too_low',limits,totalGas,maxPrefundWei:totalGas*o.maxFeePerGas,maxGasPerOp:BigInt(maxGasPerOp)});
      if(e)throw Object.assign(e,{limits,totalGas});}beforeSend?.(userOpHash);
    let rc=null;const t0=Date.now();while(!rc){rc=await bundler.rpc('eth_getUserOperationReceipt',[userOpHash]).catch(()=>null);if(!rc){if(Date.now()-t0>timeoutMs)throw Error('userOp receipt timeout '+userOpHash);await new Promise(r=>setTimeout(r,cfg.userOp?.pollMs??2000));}}
    const logs=rc.receipt?.logs??rc.logs;const charged=usdcCharged(logs,{token,vault,paymaster});
    // Circle's own charge event: record its price for the next permit sizing; the vault's net Transfer stays authoritative
    const ev=circleCharge(logs,{paymaster,sender:vault,userOpHash});if(ev?.nativeTokenPrice>0n)lastPrice=ev.nativeTokenPrice;
    const out={hash:rc.receipt.transactionHash,userOpHash,blockNumber:hexToBigInt(rc.receipt.blockNumber),gasUsed:hexToBigInt(rc.actualGasUsed),
      actualGasCostWei:hexToBigInt(rc.actualGasCost),usdcGas:charged,status:rc.success?'success':'reverted',bundler:bundler.label,
      callDataBytes:(o.callData.length-2)/2,paymasterDataBytes:(o.paymasterData.length-2)/2,paymaster,permitAmount:o.permitAmount,retriedAtCap,
      circle:ev?{nativeTokenPrice:ev.nativeTokenPrice,actualTokenNeeded:ev.actualTokenNeeded,feeTokenAmount:ev.feeTokenAmount,matchesTransfers:ev.actualTokenNeeded===charged}:null,
      bundlerFee:bf?.amount??0n};
    onCharge?.({userOpHash,txHash:out.hash,charged,success:rc.success,kind});if(rc.success&&lastDues>0n){out.duesPaid=lastDues;try{dues?.paid?.(lastDues,out.hash);}catch{}}
    if(!rc.success)throw Object.assign(Error('user operation reverted: '+(rc.reason??'')),{onChain:true,hash:out.hash,gasUsed:0n,gasPrice:0n,userOp:out});
    return out;
  }
  return {mode:'userop',get paymaster(){return paymaster;},entryPoint:ep,bundler:bundler.label,send,sendRaw:(raw,o={})=>send(null,{...o,raw}),lastPrice:()=>lastPrice,
    write:(fn,args,o={})=>send([{to:getAddress(o.address??adapter),data:encodeFunctionData({abi:abiFor(cfg?.version),functionName:fn,args})}],o)};
}
