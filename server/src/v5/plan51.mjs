// SPDX-License-Identifier: Apache-2.0
// Kipurse V5.1 (2026-10-18) PLAN ONLY (builds calldata; never signs or broadcasts).
//  1) deployPlanV51: a NEW ops account (the V5 one is locked) CREATE2-deploys the stable KipurseOrderVerifier (salt 1) and
//     KipurseAdapterV51 (salt 2; reuses the live PayerVaultFactoryV5 + KipurseFeeControllerV5), then lock(adapter). USDC gas.
//  2) opsFundingPlanV51: zero reserve + no extra owner signature: the deploy gas reaches the new ops account as ordinary
//     stranger-tier V5 payments (<= openSingle each, <= openDaily per day incl. fees + gas) that the executor makes from the
//     owner's EXISTING V5 permission, before the renewal.
//  3) buildRenewalMigrationV51: the 90-day renewal batch (ONE owner signature) that also migrates V5 -> V5.1:
//     revoke V5 -> [close float] -> sweep the old vault -> approve the V5.1 permission (same policy, fresh term) ->
//     registerPermission (new vault, same session signer) -> gas buffer into the new vault -> owner trust (anyPayee for
//     merchants with per-order deposit addresses) -> float cap.
import {encodeFunctionData,encodeAbiParameters,parseAbiParameters,concat,getAddress,getContractAddress,pad,toHex,toBytes,keccak256,parseAbi} from 'viem';
import {v51Abi,v5Abi,ZERO,decodePolicyV5,permissionFromJson,permissionToJson,spendPermissionHash,withFeeHeadroom} from './abi.mjs';
import {OPS_ABI} from './ops.mjs';import {merchantIdBytes} from './ref.mjs';import {SPM_BASE,validatePolicy} from './plan.mjs';
const DAY=86400;const s32=i=>pad(toHex(i),{size:32});
const usd=a=>`${(Number(a)/1e6).toFixed(6).replace(/0+$/,'').replace(/\.$/,'')} USDC`;
const call=(abi,to,fn,args)=>({to:getAddress(to),value:0n,data:encodeFunctionData({abi,functionName:fn,args})});
const J=x=>JSON.parse(JSON.stringify(x,(k,v)=>typeof v==='bigint'?v.toString():v));

/** Frozen address derivation (merchant spec): verifier = CREATE2(ops51, salt 0x..01, keccak256(verifierInitCode ++ abi.encode(SPM))). */
export function verifierInit({verifierBytecode,spm=SPM_BASE}){return concat([verifierBytecode,encodeAbiParameters(parseAbiParameters('address'),[getAddress(spm)])]);}
export function deployPlanV51({ops,verifierBytecode,adapterBytecode,spm=SPM_BASE,token,factory,feeController,verifier:existingVerifier}){
  const vInit=verifierInit({verifierBytecode,spm});
  const verifier=existingVerifier?getAddress(existingVerifier):getContractAddress({opcode:'CREATE2',from:ops,salt:s32(1),bytecode:vInit});
  const aInit=concat([adapterBytecode,encodeAbiParameters(parseAbiParameters('address,address,address,address,address'),[getAddress(spm),getAddress(token),getAddress(factory),getAddress(feeController),verifier])]);
  const adapter=getContractAddress({opcode:'CREATE2',from:ops,salt:s32(2),bytecode:aInit});
  const trust=getContractAddress({from:adapter,nonce:1n}); // `new KipurseTrustV51()` is the adapter's first (only) CREATE
  const dep=(i,code)=>encodeFunctionData({abi:OPS_ABI,functionName:'deploy',args:[s32(i),code]});
  const steps=[...(existingVerifier?[]:[{name:'verifier',callData:dep(1,vInit),address:verifier,initBytes:(vInit.length-2)/2}]),
    {name:'adapter51',callData:dep(2,aInit),address:adapter,initBytes:(aInit.length-2)/2},
    {name:'lock',callData:encodeFunctionData({abi:OPS_ABI,functionName:'lock',args:[adapter]})}];
  return {verifier,adapter,trust,verifierInitCodeHash:keccak256(vInit),adapterInitCodeHash:keccak256(aInit),steps};
}

/** Stranger-tier funding of the new ops account from the EXISTING V5 permission (no owner signature). Splits `need` into
 *  payments <= openSingle whose per-day total (amount + fee + gas estimate) stays <= openDaily. */
export function opsFundingPlanV51({need,openSingle,openDaily,feePpm=1000n,gasPerPayment=12000n}){
  need=BigInt(need);openSingle=BigInt(openSingle);openDaily=BigInt(openDaily);const days=[];let left=need;
  const cost=a=>a+(a*BigInt(feePpm)+999999n)/1000000n+BigInt(gasPerPayment);
  while(left>0n){let room=openDaily;const pays=[];
    while(left>0n){const a=left<openSingle?left:openSingle;let x=a;while(x>0n&&cost(x)>room)x-=1000n;if(x<=0n)break;pays.push(x);room-=cost(x);left-=x;}
    if(!pays.length)throw Error('PLAN: openDaily too small for any funding payment');days.push(pays);if(days.length>30)throw Error('PLAN: funding would take > 30 days');}
  return {need,days:days.map((p,i)=>({day:i+1,payments:p,total:p.reduce((a,b)=>a+b,0n),walletCost:p.reduce((a,b)=>a+cost(b),0n)}))};
}

/** The renewal-batch migration. current = the live V5 permission JSON; policy is reused verbatim (no second fee headroom). */
export function buildRenewalMigrationV51({chainId,current,oldAdapter,oldVault,adapter51,trust51,vault51,verifier,token,manager=SPM_BASE,owner=null,
  days=90,start,salt,trusts=[],floatCap,buffer=200000n,floatOpen=false,nowS=Math.floor(Date.now()/1000),feePpm=1000n,allowEarly=false}){
  const p=permissionFromJson(current);const pol=decodePolicyV5(p.extraData);const S=Number(start??nowS+600);
  if(!(Number(days)>0&&Number(days)<=365))throw Error('PLAN: renewal term must be 1..365 days');
  if(!allowEarly&&S<Number(p.end)-30*DAY)throw Error('PLAN: renew at most 30 days before the current permission ends');
  validatePolicy(pol,{feePpm});
  const np={account:p.account,spender:getAddress(adapter51),token:p.token,allowance:BigInt(pol.term),period:Number(days)*DAY,start:S,end:S+Number(days)*DAY,salt:BigInt(salt??(BigInt(p.salt)+1n)),extraData:p.extraData};
  const calls=[],labels=[];const add=(c,l)=>{calls.push(c);labels.push(l);};
  add(call(v5Abi,manager,'revoke',[p]),`end the current Kipurse V5 permission (spender ${p.spender}); no agent can spend through V5 after this`);
  if(floatOpen)add(call(v5Abi,oldAdapter,'reconcileFloat',[p.account]),'close the V5 micropayment float (unspent float + fee reserve back to the wallet)');
  if(oldVault)add(call(v5Abi,oldVault,'sweep',[]),'return the V5 vault gas buffer to the wallet');
  add(call(v51Abi,manager,'approve',[np]),`approve Kipurse V5.1 for ${days} days with the SAME caps (${usd(pol.single)}/payment, ${usd(pol.daily)}/day, ${usd(pol.term)} total, strangers ${usd(pol.openSingle)}/payment)`);
  add(call(v51Abi,adapter51,'registerPermission',[np]),`make your new V5.1 vault the gas payer (same session signer ${pol.executor}, at most ${usd(pol.maxNetworkFee)} gas per operation)`);
  if(BigInt(buffer)>0n)add(call(v51Abi,token??p.token,'transfer',[getAddress(vault51),BigInt(buffer)]),`${usd(buffer)} gas buffer into your new vault (yours, returned at exit)`);
  const tr=[];for(const t of trusts){const name=String(t.merchantId).trim().toLowerCase();const exp=BigInt(t.expiry??(S+Number(t.days??days)*DAY));
    if(!(exp>BigInt(S)&&exp<=BigInt(S+365*DAY)))throw Error('PLAN: trust expiry within 365 days for '+name);
    const x={merchant:merchantIdBytes(name),name,payees:(t.payees??[]).map(a=>getAddress(a)),signers:(t.signers??[]).map(a=>getAddress(a)),single:BigInt(t.single),daily:t.capsIncludeFee?BigInt(t.daily):withFeeHeadroom(t.daily??t.single,feePpm),expiry:exp,anyPayee:!!t.anyPayee};
    if(x.anyPayee&&!x.signers.length)throw Error('PLAN: anyPayee needs an order signer for '+name);if(!x.payees.length&&!x.anyPayee)throw Error('PLAN: payees required for '+name);
    if(x.single>BigInt(pol.single))throw Error('PLAN: trust single above permission single for '+name);
    add(call(v51Abi,trust51,'setTrust',[x]),`trust ${name}: ${usd(x.single)}/payment, ${usd(t.daily??t.single)}/day until ${new Date(Number(exp)*1000).toISOString()}`+(x.anyPayee?`; orders signed by ${x.signers.join(', ')} may name a NEW deposit address each time (unsigned payments to unknown addresses stay at the stranger cap)`:''));tr.push(x);}
  if(floatCap!==undefined&&BigInt(floatCap)>0n)add(call(v51Abi,trust51,'setFloatCap',[BigInt(floatCap)]),`micropayment float: up to ${usd(floatCap)} per day`);
  const data=encodeFunctionData({abi:v51Abi,functionName:'executeBatch',args:[calls.map(c=>({target:c.to,value:0n,data:c.data}))]});
  return J({WARNING:'PLAN ONLY - nothing was signed or broadcast. ONE owner signature: renewal + V5 -> V5.1 migration.',kind:'renewal-migration-v5.1',chainId,wallet:p.account,owner,
    manager:getAddress(manager),adapter:getAddress(adapter51),trust:getAddress(trust51),vault:getAddress(vault51),orderVerifier:getAddress(verifier),policy:pol,
    permission:permissionToJson(np),permissionHash:spendPermissionHash(np,{chainId,manager}),renews:{permissionHash:spendPermissionHash(p,{chainId,manager}),oldEnd:Number(p.end),newEnd:np.end,days:Number(days)},
    trusts:tr,calls:calls.map((c,i)=>({label:labels[i],to:c.to,value:'0',data:c.data})),walletExecuteBatch:{to:p.account,data},
    walletSendCalls:{version:'2.0.0',chainId:toHex(chainId),from:p.account,atomicRequired:true,calls:calls.map(c=>({to:c.to,value:'0x0',data:c.data}))}});
}

// Independent re-check of a built renewal batch before it is shown to the owner (January dry run). Returns {ok,errors[],facts}.
export const LEAKED_SIGNERS=['0x28c91ce8ee453aFA81202bdB94A4d630D8e53ED1'];
export function validateRenewalPlanV51(plan,{wallet,owner,adapter51,trust51,verifier,oldSpender,nowS=Math.floor(Date.now()/1000),maxBuffer=1_000_000n,allowedSigners=[]}={}){
  const errors=[],eq=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase(),need=(c,m)=>{if(!c)errors.push(m);};
  need(plan?.kind==='renewal-migration-v5.1','kind is not renewal-migration-v5.1');need(plan?.chainId===8453,'chainId is not Base mainnet 8453');
  if(wallet)need(eq(plan.wallet,wallet)&&eq(plan.permission?.account,wallet),'plan wallet/account mismatch');
  if(owner)need(eq(plan.owner,owner),'owner mismatch');if(adapter51)need(eq(plan.adapter,adapter51)&&eq(plan.permission?.spender,adapter51),'new spender is not the V5.1 adapter');
  if(trust51)need(eq(plan.trust,trust51),'trust mismatch');if(verifier)need(eq(plan.orderVerifier,verifier),'verifier mismatch');
  const p=plan.permission??{};need(Number(p.start)>=nowS-60,'new permission start is in the past');need(Number(p.end)-Number(p.start)===Number(p.period),'permission period != end-start');
  need(Number(p.period)<=365*86400,'term above 365 days');need(BigInt(p.allowance??0)===BigInt(plan.policy?.term??-1),'allowance != policy term (caps changed)');
  const calls=plan.calls??[];need(calls.length>=4&&calls.length<=12,'unexpected call count '+calls.length);
  need(eq(calls[0]?.to,plan.manager)&&/end the current Kipurse V5 permission/.test(calls[0]?.label??''),'first call must revoke the current V5 permission');
  if(oldSpender)need(String(calls[0]?.label).toLowerCase().includes(String(oldSpender).toLowerCase()),'revoke does not name the current spender');
  for(const c of calls)need(c.value==='0','call with ETH value');
  const ws=plan.walletSendCalls;need(ws?.atomicRequired===true&&ws.calls?.length===calls.length,'walletSendCalls not atomic / length mismatch');
  need(eq(plan.walletExecuteBatch?.to,plan.wallet),'executeBatch not addressed to the wallet');
  const xfer=calls.filter(c=>String(c.data).startsWith('0xa9059cbb'));need(xfer.length<=1,'more than one token transfer in the batch');for(const c of xfer){const amt=BigInt('0x'+c.data.slice(74,138));need(amt<=BigInt(maxBuffer),'gas buffer above '+maxBuffer);need(eq('0x'+c.data.slice(34,74),plan.vault),'buffer not sent to the V5.1 vault');}
  for(const t of plan.trusts??[]){for(const s of t.signers??[]){need(!LEAKED_SIGNERS.some(l=>eq(l,s)),'LEAKED signer trusted: '+s);if(allowedSigners.length)need(allowedSigners.some(a=>eq(a,s)),'signer not on allow-list: '+s);}
    need(BigInt(t.single)<=BigInt(plan.policy.single),'trust single above permission single');}
  return {ok:!errors.length,errors,facts:{calls:calls.length,start:Number(p.start),end:Number(p.end),days:Number(p.period)/86400,trusts:(plan.trusts??[]).map(t=>t.name)}};
}
