# Multi-chain / multi-stablecoin design (t968, design only)
Goal: same self-custody + on-chain caps model on more EVM chains and stablecoins, without pooled custody and without raising caps.

## Abstractions
- `ChainAdapter {chainId, name, rpc, explorer, usdc, spendPermissionManager, entryPoint, paymaster?, l1FeeOracle?, sequencerFeed?}` —
  today hard-coded in `server/kit/rescue/src/plan.mjs CHAINS` and `server/src/v5/chain.mjs`; move to one `chains.json` registry read by server, rescue page and iOS (`Mainnet.swift`).
- `TokenAdapter {address, decimals, symbol, permitStyle: 'eip2612'|'eip3009'|'none'}` — USDC first (native Circle USDC only, never bridged), then EURC.
- Caps stay per wallet per chain, in token base units; the app shows one combined view but each chain enforces its own caps on-chain.
- Fee quoting: `quoteNetworkFee` becomes chain-pluggable (OP-stack L1 oracle on Base/Optimism, ArbGasInfo on Arbitrum).

## Order
1. Base Sepolia (done) → Optimism Sepolia → Arbitrum Sepolia: deploy V5 contracts on testnets, run existing Foundry + e2e suites per chain.
2. Mainnet deploy per chain = owner decision (gas spend, CDP/Base Account support check).
3. Offline exit: rescue page reads `chains.json`; one rescue card per chain.

## Risks
Spend Permission Manager / Base Account availability differs per chain; Coinbase Verified attestation exists on Base only (KYC gate stays Base-only).
