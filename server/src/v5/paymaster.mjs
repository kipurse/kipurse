// SPDX-License-Identifier: AGPL-3.0-only
// Zero-reserve gas helpers (round 2, 2026-10-17): Circle charge event, permit sizing, pluggable cheapest-paymaster selection,
// and the F2 (degraded) user-facing warning.
import {parseAbi,decodeEventLog,getAddress} from 'viem';

/** Circle Paymaster v0.7 postOp event (topic verified against Base Sepolia receipts of our own e2e userOps:
 *  0x859cffc122e69a171c48ee57adbf5286e1cd0b3ec8e47fef3afd8150e417a069). nativeTokenPrice = USDC atomic per 1 ETH used by Circle. */
export const CIRCLE_EVENT_ABI=parseAbi(['event UserOperationSponsored(address indexed token,address indexed sender,bytes32 userOpHash,uint256 nativeTokenPrice,uint256 actualTokenNeeded,uint256 feeTokenAmount)']);
export const CIRCLE_SPONSORED_TOPIC='0x859cffc122e69a171c48ee57adbf5286e1cd0b3ec8e47fef3afd8150e417a069';

/** The Circle charge for one userOp from the receipt logs, or null when the paymaster emitted none. */
export function circleCharge(logs,{paymaster,sender,userOpHash}){
  for(const l of logs??[]){if(getAddress(l.address)!==getAddress(paymaster)||l.topics?.[0]!==CIRCLE_SPONSORED_TOPIC)continue;
    let e;try{e=decodeEventLog({abi:CIRCLE_EVENT_ABI,data:l.data,topics:l.topics});}catch{continue;}
    if(getAddress(e.args.sender)!==getAddress(sender))continue;if(userOpHash&&e.args.userOpHash.toLowerCase()!==userOpHash.toLowerCase())continue;
    return {token:e.args.token,userOpHash:e.args.userOpHash,nativeTokenPrice:e.args.nativeTokenPrice,actualTokenNeeded:e.args.actualTokenNeeded,feeTokenAmount:e.args.feeTokenAmount};}
  return null;
}

/** Circle's prefund in USDC for these limits: sum(gas limits) x maxFeePerGas x price x (1 + fee). */
export const prefundUsdc=({totalGas,maxFeePerGas,usdcPerEth,feeBps=1000})=>{const wei=BigInt(totalGas)*BigInt(maxFeePerGas);
  const base=(wei*BigInt(usdcPerEth)+10n**18n-1n)/10n**18n;return (base*BigInt(10000+feeBps)+9999n)/10000n;};

/** permitAmount = Circle's estimated prefund x safety, capped by the owner's maxGasPerOp. The cap keeps the worst case for a
 *  compromised session key at maxGasPerOp per op; the smaller permit makes each op's USDC exposure equal to what it needs. */
export function permitAmount({totalGas,maxFeePerGas,usdcPerEth,cap,safetyBps=15000,feeBps=1000,min=1n}){
  if(!usdcPerEth)return BigInt(cap);
  const want=(prefundUsdc({totalGas,maxFeePerGas,usdcPerEth,feeBps})*BigInt(safetyBps)+9999n)/10000n;
  const w=want<BigInt(min)?BigInt(min):want;return w>BigInt(cap)?BigInt(cap):w;
}

/** Pluggable paymaster selection. A candidate: {name,address,quote:async({totalGas,maxFeePerGas})=>usdcAtomic, data?:async(...)=>paymasterData}.
 *  Only candidates the vault allowlists on chain (vault.paymaster() / paymaster2()) are eligible; the cheapest quote wins;
 *  a candidate whose quote throws is skipped. With one candidate this is the identity. */
export function paymasterSelector(candidates){
  if(!candidates?.length)throw Error('paymasterSelector: no candidates');
  return {candidates,async select({allowlisted,totalGas,maxFeePerGas}){
    const allow=new Set((allowlisted??[]).filter(Boolean).map(a=>getAddress(a)));let best=null;
    for(const c of candidates){if(allow.size&&!allow.has(getAddress(c.address)))continue;
      let q;try{q=BigInt(await c.quote({totalGas,maxFeePerGas}));}catch{continue;}
      if(!best||q<best.quote)best={...c,address:getAddress(c.address),quote:q};}
    if(!best)throw Object.assign(Error('NO_PAYMASTER: no allowlisted paymaster could quote this op; nothing was sent'),{code:'no_paymaster'});
    return best;}};
}
/** Circle candidate; usdcPerEth() returns Circle's last observed nativeTokenPrice (from its event) or a configured estimate. */
export const circleCandidate=({address,usdcPerEth,feeBps=1000,name='circle-v07'})=>({name,address,
  quote:async({totalGas,maxFeePerGas})=>prefundUsdc({totalGas,maxFeePerGas,usdcPerEth:await usdcPerEth(),feeBps})});

/** F2 = degraded mode (bundler or paymaster unavailable): no on-chain transactions. Shown in status / preflight / docs. */
export const F2_WARNING='Degraded mode (F2): the gas path (bundler / Circle paymaster) is unavailable, so no on-chain transaction can be sent. '
  +'Only x402 micropayments from an already-funded float work, and their limits are enforced by the gateway off-chain (the float balance '
  +'is the worst case). Direct and signed payments, top-ups, reconcile and fee collection wait until the gas path is back. Your funds stay in '
  +'your wallet and vault; the owner exit kit still works with your own gas.';
