# Kipurse V5 threat model (pre-audit, 2026-10-17)

Status: development only, NOT audited. Scope:
- Contracts in `src/`.
- Gateway (AGPL) behaviour where it affects funds.

## Assets

1. **Owner USDC in the Coinbase Smart Wallet.** It is spendable only through the SpendPermissionManager (SPM) permission given to the adapter.
2. **USDC in transit:**
   - PayerVault reservations (x402);
   - the FloatVault daily float (at most `floatCap`, default 5 USDC);
   - adapter `pendingFees` / `accruedFees`.
3. **Owner authority:** trust, deny, pause, revoke, float cap, and the owner signatures used by the BySig actions.
4. **Protocol fee configuration:** rate and recipient.
5. **Gateway operating funds:** owner principle 2026-10-17: our reserve is ZERO. On mainnet the executor holds no ETH and there is no postpaid sponsor; users pay gas in USDC atomically, through a mechanism that is pending the zero-reserve design. On testnet the executor still pays test ETH and is reimbursed in USDC, and failed-tx gas is a receivable (the GasBook).

## Actors and trust

| Actor | Trust | Can | Cannot |
|---|---|---|---|
| Owner (Smart Wallet) | full | approve or revoke the permission; trust, deny, pause/unpause; set the float cap; withdraw from the vaults; exit with ONE batch even when Kipurse is down | — |
| Executor (gateway hot key) | **untrusted beyond its bounds** | call pay* / prepareAuthorization / fundFloat within the policy; pause for 24h | exceed per-tier single/daily caps, the term allowance or the max network fee; trust/untrust/unpause; touch reservations; forge owner approvals (S7 tests) |
| Agent (LLM using MCP/SDK) | untrusted | request payments through the gateway | anything the executor cannot; tools never expose keys |
| Merchant signer | partially trusted | sign orders for its OWN bound payees | redirect to an unbound payee (S6); a leaked signer is bounded by caps and is deniable by the owner or registry |
| Registry maintainer | partially trusted | list, after a ≥48h timelock; remove or block immediately | override owner trust or owner denies; exceed owner caps (R tests) |
| Fee admin | partially trusted | lower the fee; change the recipient after 48h | raise the fee; exceed 0.3%; stop payments (a blocklisted recipient does not brick payments) |
| Session key (float) | untrusted | sign EIP-3009 vouchers from the float vault only, up to maxSingle and before expiry | spend beyond the float balance; touch the wallet (float leak test) |
| Facilitator (x402) | untrusted | submit an authorization the vault approved | change amount, recipient or window (tampered-auth test) |
| Base sequencer | trusted for liveness, timestamps within seconds | delay or reorder txs | — |
| Price oracles | partially trusted | Chainlink ETH/USD plus an off-chain second source, used only for the gas quote | move the quote silently: refused on >2% divergence, a stale source, sequencer down, or the 1h grace period |

## Threats, mitigations, evidence

| ID | Threat | Mitigation | Evidence |
|---|---|---|---|
| T1 | Compromised executor drains the wallet | All spends go through on-chain policy: tier caps, daily caps including fees, the term allowance in the SPM, max network fee per tx. Daily damage is bounded. | S7 tests, `invariant_dailyCaps`, `invariant_termCapIncludingFees` |
| T2 | Prompt injection pays an arbitrary address | The stranger tier is capped at 0.10 per payment plus a stranger daily cap. Known merchants require trust. | S5c, `testFuzz_strangerDailyBound`, `invariant_attackerOnlyStrangerTier` |
| T3 | Fake merchant site / fake signer | Signed orders pay only payees bound to the signer's merchant. An unbound payee falls to the stranger tier. | S5a/S5b, `testFuzz_signedOrderOnlyToBoundPayee` |
| T4 | Double payment (agent retries, two agents) | A purchase key per (payee, merchantRef, repeatKey) or (merchant, orderId) is used once. The gateway allows one tx in flight per account and uses idempotency keys. | S3, `testFuzz_samePurchaseNeverPaidTwice` |
| T5 | Owner-approval forgery or replay | EIP-712 digest bound to account, purchase key, payee, amount and deadline. BySig nonces. | `testFuzz_ownerApprovalUnforgeable`, S1b |
| T6 | Fee manipulation | Fee only goes down, hard max 0.3%. The owner also bounds the accepted rate in the policy. The recipient changes only after 48h. | FeeController suite, `invariant_feeBoundedByHardMax`, `test_policy_ownerMustAcceptFeeRate` |
| T7 | Gas over-charging | networkFee ≤ the owner's maxNetworkFee per tx (on-chain). Quote = actual + 20%. The gateway refuses over the cap, on oracle divergence >2%, with the sequencer down, or within the grace period. | `test_networkFee_*`, gateway v5-price tests |
| T8 | Gas under-recovery (users never pay failed gas) | Failed gas goes into the GasBook and is recovered FIFO on the next payment OR the next float funding, within the cap. An owner-signed settle step appears in the exit plan. 3 failures per agent per day stops that agent. **No bond**: it would lock user funds and add contract surface, and the exit must never depend on it. The residual risk (a wallet that never returns) is bounded at ≤3 failed txs per agent per day. | gateway v5-recovery and v5-gas tests |
| T9 | Leaked float session key | The worst case is the current float, at most `floatCap`. Vouchers are limited to maxSingle and expiry, are EIP-3009 only, and stop immediately on pause or deny. | float leak, pause and deny tests |
| T10 | Stuck funds / service down | The owner exit is one batch: pause, revoke, cancel reservations, reconcile the float, sweep. Reclaim by anyone after expiry. Unmarked fees return after 7 days. | S8, `test_fork_v5ServiceDownExitDrill`, `test_float_ownerExitReturnsEverythingUnspent` |
| T11 | Registry compromise | 48h timelock to list. Owner trust takes precedence. Owner caps bound verified merchants. Opt-out is available. A griefing registry is gas-capped and degrades to owner trust or the stranger tier. | R tests |
| T12 | Vault spoofing / ERC-1271 abuse | The CREATE2 address is verified. PayerVault validates only reserved digests and never a permit or an arbitrary hash. | `test_vault_factoryCannotBeSpoofed`, `test_x402_vaultNeverApprovesPermitOrArbitraryHash` |
| T13 | Reentrancy | `nonReentrant` on all value-moving entry points. Callees are immutable and trusted. Exact-delivery balance checks. | static analysis triage |
| T14 | Licensing contamination | Production contracts compile from Apache/MIT sources only (minimal SPM interface). | gateway licensing test |

## Known issues / open items for the auditor

- **K-1 (Low).** A USDC-blocklisted account makes the late-fee return in `markSettled` revert for that digest. See `STATIC_ANALYSIS_TRIAGE.md`.
- **K-2 (Info).** The second price source is off-chain (Coinbase Exchange / Kraken) and enforced by the gateway, not on chain. The on-chain bound is still the owner's maxNetworkFee per tx.
- **K-3 (Info).** Base Sepolia has no Chainlink sequencer uptime feed, so the sequencer check runs on Base mainnet only and the fork rehearses it.
- **K-4 (Info).** No upgradeability: new versions need a new deploy plus an owner migration batch (`scripts/v5-owner-batch.mjs`).
- **K-5 (Info).** Coverage of the lib-dependent SPM paths comes from the fork tests, not from `forge coverage` (which runs without the fork).

## Zero-reserve additions (2026-10-17, ERC-4337 vault + Circle Paymaster)

| # | Threat | Mitigation | Evidence |
|---|---|---|---|
| T15 | Session key compromise (it signs userOps) | The session key has the same powers as the executor: it can only call the adapter / trust or `approve` an allowlisted paymaster ≤ maxGasPerOp, under all the Policy caps. It holds nothing, so there is nothing to steal from it. The owner can revoke or pause at any time. | ZR unit tests: execute allowlist, permit1271 |
| T16 | Gas griefing by a compromised session key (spamming ops that burn the buffer) | Each op is charged ≤ maxGasPerOp by the vault's own permit check. Losses are bounded by the vault balance (0.20 buffer plus top-ups; each top-up ≤ maxNetworkFee and counted in the daily cap) and by the 3-failures-per-agent-per-day breaker off-chain. Recorded as K-6. | testFuzz_gasAllowanceNeverAboveCap |
| T17 | A paymaster draining the vault | The paymaster is allowlisted by immutable address (Circle v0.7 plus an optional second); approve and permit ≤ maxGasPerOp; the vault never pays ETH (`missingAccountFunds != 0` reverts). | validateUserOp test; fork ZR on the real Circle Paymaster |
| T18 | Gas consuming USDC that backs an open x402 reservation | Both the permit path and the approve path require `balance ≥ reserved + value`. This was found in this pre-audit pass and FIXED. | test_gasNeverTouchesReservedX402Funds |
| T19 | Bundler censorship or outage | The bundler is pluggable (BYO key); F2 mode needs no tx; the owner can always exit with their own gas. | v5-userop tests |
| T20 | Paymaster outage or policy change (Circle) | paymaster2 slot (Circle v0.8); F2 mode; owner exit independent of us. | runbook §4 |
| T21 | ERC-7562 validation-rule violation, so bundlers drop ops | validateUserOp reads only the vault's own storage. The USDC balance read runs inside USDC.permit during the staked paymaster's validation. | Sepolia: 4/4 userOps accepted by the Pimlico public bundler |

Known issues added:
- **K-6.** A compromised session key can burn the vault's gas buffer with useless ops: bounded and accepted.
- **K-7.** Bundler pass-through cost: a paid bundler cannot be charged per op on-chain. Only free-tier or BYO-key bundlers are accepted.
- **K-8.** Fee collection needs gas, and we hold no reserve. Open; see runbook §4.
- **K-9.** A first-time CREATE2 vault deploy is heavy (the payer vault in the owner batch, about 1.1M gas; the float vault in fundFloat, about 1.2M gas). EIP-1167 clones are not done yet (design §5.1-6).

## Round 2 (2026-10-17 evening): status changes
- **K-1: FIXED.** `_refundFee` never reverts. It tries the wallet, then the owner's vault, and as a last resort keeps the fee as protocol fee in `accruedFees`. It is used in the `markSettled` late-fee branch and in `_release` (reclaim / cancel). `_release` also wraps `vault.pay(account, value)` in try/catch, so a blocklisted wallet's value stays unreserved in its own vault. Tests: `KipurseV5Round2` (3 K-1 tests).
- **K-7: CHANGED.** There is now an optional per-op bundler-fee pass-through in the vault. It is OFF by default and only the owner wallet sets it (`setBundlerFee(to, maxPerOp)`). It allows at most one `USDC.transfer(bundlerFeeTo, <= maxBundlerFee)` per userOp, never from reserved x402 funds. The user pays it; Kipurse never does. Hosted mainnet stays on free-tier or BYO bundlers.
- **K-8: CLOSED by design.** The fee recipient is `KipurseOpsAccountV5`, a 4337 account that collects fees as a userOp and pays the Circle gas out of the collected USDC. The gateway runs collection only when `accrued >= 20 x the expected gas`.
- **K-9: FIXED.** Vaults are EIP-1167 clones. First deploy fork gas went from 1,656,628 to 528,436 for paySigned (it includes creating the vault) and from 2,359,905 to 631,823 for the first fundFloat.
- **T22 (new): the ops account / deployer.** Its signer is a fresh 0600 key that holds nothing. In the deploy phase the signer can CREATE2 arbitrary code from the ops account, but only before `lock`, and per-op gas is <= `maxDeployGas`. After `lock` the only allowed actions are `adapter.collectFees()`, a paymaster approve <= `maxGasPerOp`, and a USDC transfer to the TREASURY (the owner) that keeps a 4 x maxGasPerOp buffer. Worst case for a stolen signer after lock: it burns the gas buffer with useless ops. The treasury can rotate the signer and withdraw everything directly.
- **T23 (new): clone implementation.** The implementation's `account` is 0 and `init` is factory-only and once-only, so the implementation itself cannot be bound. A spoofed `prepare` by another caller gives a clone whose adapter is that caller, at a different address. Tests: `test_vault_factoryCannotBeSpoofed`, `test_clones_*`.
- **K-10 (new, Low): uint64 day counters.** They cap a permission-day at 1.8e13 USDC (`_charge` requires <= uint64 max). Downcasts in `_release` are bounded by construction, because each amount was added under that check. Aderyn H-3 is triaged as a false positive.
