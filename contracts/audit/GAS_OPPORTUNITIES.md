# Kipurse V5 gas-saving opportunities (analysis, plus the zero-reserve pass results at the end)

**Why this matters.** Under the zero-reserve principle the user pays every unit of gas in USDC, so contract gas is a direct user cost.

**What the numbers are.** Gas figures come from the local Foundry gas report for `KipurseV5Core`. They include the mocks' cold-access effects; medians are the useful reference.

Adapter, local medians (min…max):

| Function | Median | Range | Note |
|---|---|---|---|
| payDirect | 126k | 50k…875k | the max includes the first-time vault deploy |
| paySigned | 167k | 74k…877k | |
| prepareAuthorization (x402) | 1.01M | 79k…1.05M | dominated by the vault deploy plus the reservation storage |
| markSettled | 112k | | |

On the fork, the float costs about 12.8k gas of ours per micropayment (fund 1.15M on the first day, 365k after that; reconcile 131k).

Ranked by expected saving per typical payment. Every item needs an audit-visible change, so they are proposals for the owner and auditor. Savings are estimates from EVM pricing.

| # | Area | Today | Proposal | Est. saving | Risk / trade-off |
|---|---|---|---|---|---|
| G1 | **Vault hop** (direct and signed) | wallet → adapter (SPM.spend) → `safeTransfer` to the PayerVault → `vault.pay` → payee. That is 3 USDC transfers plus 1 external call, and the vault is deployed on the first payment. | Pay the payee straight from the adapter in `_settleNow`. The vault is needed only as the on-chain payer for x402/EIP-3009, so it stays for prepareAuthorization only. This also avoids the ~400k+ vault deploy for wallets that never use x402. | ~25–35k per payment (1 transfer, 1 call, 2 balance reads), and ~450k once per wallet | Low. The payee-delivery check stays. Changes the meaning of the "vault is the payer" event field. |
| G2 | **x402 reservation storage** | `Reservation` takes about 7 storage slots (account/day/validBefore/tier/open packed, plus permissionHash, purchaseKey, merchant, value, fee, networkFee); every new slot costs 22.1k | Store only `keccak256(reservation)` in 1 slot and an `open` flag. Pass the full struct as calldata to markSettled / reclaim / cancel, which then check the hash. | ~120k per x402 payment, plus a cheaper close | Medium. Callers must supply the struct, which the gateway already has from events. |
| G3 | **Day/term counters** | `termSpent`, `daySpent`, plus a tier counter (`openDaySpent` / `verifiedDaySpent`) and `merchantDaySpent`: up to 4 SSTOREs per payment, and a NEW day slot costs 22.1k | Pack term (uint96) + day index (uint32) + day spent (uint96) into one slot per permission. Pack the tier day counters likewise. | ~20–45k on the first payment of a day, ~5–10k afterwards | Medium. Needs overflow bounds; USDC fits easily in uint96. |
| G4 | **External reads per payment** | `fees.feePpm()` read twice (in the policy and in feeFor), `manager.getHash(p)` as an external call, `trust.gate` + `payeeTrust`/`signerTrust` (separate contract, cold), and `vaultAddress()` recomputed (keccak of creationCode) inside `_policy` for the payee check | Read feePpm once per call. Compute the SPM hash locally (it is a pure EIP-712 hash, so the result can be checked against `getHash` in tests). Merge the trust reads into one `gate` call that returns everything. Compare against the stored `vaultOf` instead of recomputing CREATE2. | ~8–15k | Low. A local hash must exactly match the SPM's (fork test). |
| G5 | **Calldata (L1 data fee)** | Each pay call carries the full `SpendPermission` (~10 words) plus 384 bytes of policy in `extraData`, so ~22 words before order fields. On Base the L1 data fee usually dominates for small txs. | (a) Register the permission once (`permissionHash → policy` stored when first used) and pass only the hash after that. (b) Shorter policy encoding (uint96 caps, packed). | ~600–700 calldata bytes per tx, which is often the largest part of the user's USDC fee on Base | Medium. (a) adds 1 SLOAD per call; the register step can ride on the first payment. |
| G6 | **Events** | `Paid` has 9 fields (3 indexed). x402 emits both `AuthorizationPrepared` and later `Paid` + `AuthorizationClosed`. | Drop fields that can be derived (tier, merchant, networkFee are reconstructable off-chain from the tx), and merge Paid + AuthorizationClosed at close. | ~1–3k per payment | Low. The tax CSV and receipts read these events, so the gateway indexer would need updating. |
| G7 | **Exact-delivery balance checks** | `balanceOf` before and after on both pull (adapter) and delivery (payee): 4 external reads | Keep the payee check. Drop the pull check, because the SPM plus USDC are fixed and audited and the SPM reverts on failure. | ~5k | Low–medium. Defence in depth versus gas; recommend keeping it until audit. |
| G8 | **markSettled loop** | `pendingFees -=` and `accruedFees +=` per item | Accumulate in memory and write once after the loop. | ~2–5k per extra item in a batch | Low. |
| G9 | **Float for sub-$1** (already done, M3) | 100 micropayments cost 2 of our txs | Raise adoption: the gateway routes all payments ≤ $1 through the float when it is enabled. | ~100k+ per micropayment versus a direct pay | None on chain. |
| G10 | **Fee collection** | `collectFees` is a separate tx, paid by whoever calls it | Leave it manual or piggy-back on the next payment above a threshold. Never as a recurring job (owner rule). | No cost to users if left manual | None. |

**Recommended order:**
1. G1 + G4 + G8: low risk, small diff.
2. G5(a): the biggest user-visible USDC saving on Base.
3. G2: x402 only.
4. G3.

All of these should go to the auditor together with the zero-reserve design, because the paymaster path changes the per-tx overhead too (EntryPoint v0.7 validation plus the paymaster postOp).


## Done in the zero-reserve pass, and measured before vs after

Done:
- **Transient-storage reentrancy lock** (EIP-1153). This replaces the 2 SSTOREs per call, about 5k gas per call when warm.
- **`adapter.trust()` cached as a vault immutable.** This saves one external call (about 2.6k gas cold) per userOp call.
- **Tighter `callGasLimit`**: min(bundler estimate +10%, `eth_estimateGas` +15% +10k).
  - EntryPoint v0.7 bills 10% of unused call gas. The bundler's Sepolia estimate for fundFloat was 2.26M against 1.15M actually used. A limit that loose wasted gas and also pushed Circle's prefund past the 0.05 USDC cap.
- **Simulate before sending.** A payment that would revert costs nobody anything.

### Gas comparison: legacy executor-pays vs zero reserve

| Operation | Legacy (executor EOA pays ETH, reimbursed) | Zero reserve (vault userOp, Circle USDC) |
|---|---|---|
| Base-fork payDirect (stranger) | 302,185 gas (tx); ETH fronted by **our** executor | op1 590,393 / op2 418,790 handleOps gas; **1,519 / 1,150 atomic USDC** (0.0015 / 0.0012 USD) from the **owner's vault**; our cost 0 |
| Base-fork failed op | gas recovered later from the owner (a debt) | **873 atomic USDC**, charged to the vault atomically; no debt |
| Sepolia signed order | 811,050 gas; actual 0.011637, charged 0.017630 USDC (+20% margin) | 483,853 op gas; **0.009616 USDC = actual charge, no margin** |
| Sepolia direct stranger (first op) | n/a | 574,107 op gas; 0.011376 USDC |
| Sepolia fundFloat (incl. CREATE2 float vault) | 1,020,440 gas; 0.023802 USDC charged | 1,234,876 op gas; 0.023247 USDC |
| Sepolia reconcileFloat | 101,028 gas | 275,911 op gas; 0.005577 USDC |

How to read the table:
- Per op, the 4337 path costs more gas: about +90k for EntryPoint validation, +~120k for Circle's validation and postOp with permit, plus the 10% unused-gas penalty.
- Even so, the user pays less USDC, because there is no 20% safety margin and no recovery debt.
- Our reserve is 0 instead of an ETH float.
- Sepolia prices are about 8× those on Base mainnet at the fork block.

### Still open, in order of value

1. **EIP-1167 clones for PayerVaultV5 and KipurseFloatVaultV5** (design §5.1-6). The first-time deploy currently costs about 1.1–1.2M gas each: the payer vault is paid by the owner in the migration batch, the float vault by the vault in the first fundFloat. Clones would cut each to about 45k gas plus init. Constraint: the vault's immutables (account, token) would move into storage or the clone's immutable args.
2. **registerPermission, then pass only the permission hash** (design §3). This removes about 320 bytes of calldata per op, which is the L1 data fee and the largest part of the userOp's preVerificationGas.
3. **Packed day/term counters** (G3).
4. **Vault as the SPM spender** (design §5.3-5, phase 2). This removes the vault hop (G1).

## Round 2 results (2026-10-17 evening), Base mainnet fork at the REAL base fee
**Measurement fix.** Forge executes test calls with BASEFEE 0 unless it is pinned. Earlier fork USD figures (op1 1,519 / op2 1,150 atomic) were therefore priced at the 0.001 gwei tip only, which understates them by about 6x. Both the before and the after code were re-measured with `vm.fee(<fork base fee 0.005 gwei>)`, a 0.001 gwei tip, and Circle's live price.

| Per payment (Circle USDC charge, actual) | Before (round-1 code) | After (round 2) | Change |
|---|---|---|---|
| op1 payDirect, vault buffer pays | 590,405 gas, 9,143 atomic = $0.009143 | 570,784 gas, 8,889 = $0.008889 | -2.8% |
| op2 payDirect + top-up | 418,778 gas, 6,920 = $0.006920 | 416,293 gas, 6,888 = $0.006888 | -0.5% |
| failed op (reverts inside) | 5,254 = $0.005254 | 5,311 = $0.005311 | +1.1% (clone delegatecall; no counter savings on revert) |
| First vault deploy (paySigned incl. vault, owner tx) | 1,656,628 gas | 528,436 gas | -1,128,192 gas (~$0.016 at 0.006 gwei) |
| First fundFloat (incl. float vault) | 2,359,905 gas | 631,823 gas | -1,728,082 gas |
| Fee collection by the ops account | n/a | 3,898 atomic = $0.0039 | |

- **Clones (shipped).** The per-op delegatecall overhead is about 2.6-4k gas. On successful payments it is more than offset by the packed counters. Breakeven against the vault-deploy saving alone is roughly 1.13M / 3.3k, about 340 ops per vault.
- **Packed daily counters (shipped).** One slot instead of four mappings.
- **Permission-hash-only after registration: NOT shipped (measured net loss).** SPM.spend needs the full struct, so ph-only means re-reading it from storage. It saves 704 calldata bytes (3,404 L2 gas plus 5.4e8 wei of L1 fee) but costs 49,374 gas of cold SLOADs. Net loss: 2.75e11 wei per payment, about $0.00066.
- **Permit = estimate x 1.5, capped (shipped, gateway).** Circle's price is learned from its `UserOperationSponsored` event.
- **Cheapest-paymaster selection (shipped, gateway).** It is a pluggable interface; Circle v0.7 is today's only candidate.
