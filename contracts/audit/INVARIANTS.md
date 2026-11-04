# Kipurse V5 invariants, each mapped to the tests that check it

Legend:
- **inv** = Foundry invariant (stateful fuzz, handler `V5Handler`)
- **fz** = fuzz test
- **u** = unit or scenario test
- **fork** = Base-mainnet-fork test
- **gw** = gateway Node test

| ID | Invariant | Tests |
|---|---|---|
| I-1 | The adapter holds only fees: balance(adapter) == pendingFees + accruedFees | inv `invariant_adapterHoldsOnlyFees`; u `test_vault_isOnChainPayerAndAdapterHoldsOnlyAccruedFees` |
| I-2 | Each payer vault's balance is ≥ its open reservations, and owner withdraw/sweep can never take reserved funds | inv `invariant_vaultCoversReservations`; u `test_x402_sweepReturnsStrayButNotReserved`, `test_S11_ownerCannotWithdrawReservedButCanCancel` |
| I-3 | Per-day spend per tier (fees included) ≤ the tier daily cap, and stranger spend ≤ the stranger daily cap | inv `invariant_dailyCaps`; fz `testFuzz_strangerDailyBound`, `testFuzz_feeCountedInEveryCap`; u `test_tier_stranger_exact_0_10_perPayment_feesCountDaily` |
| I-4 | Total pulled over the term (amount + fee + networkFee) ≤ the permission allowance (term cap) | inv `invariant_termCapIncludingFees`; u `test_policy_allowanceMustEqualTermAndTermNonZero` |
| I-5 | Fee ≤ amount × MAX_FEE_PPM, rounded up; the fee rate never rises | inv `invariant_feeBoundedByHardMax`; fz `testFuzz_feeNeverAboveHardMax`, `testFuzz_feeNeverRises`; u `test_feeOnlyDown` |
| I-6 | Fee recipient changes only ≥48h after a proposal; only the admin proposes or cancels | u `test_recipientTimelock`, `test_cancelRecipient`, `test_feeController_hardMaxOnlyDownAndTimelockedRecipient` |
| I-7 | One purchase key is paid at most once (all modes) | fz `testFuzz_samePurchaseNeverPaidTwice`; u S3 suite |
| I-8 | A signed order pays only a payee bound to the signer's merchant | fz `testFuzz_signedOrderOnlyToBoundPayee`; u `test_binding_*`, S6 |
| I-9 | An attacker without trust or registry listing reaches only the stranger tier | inv `invariant_attackerOnlyStrangerTier`; u S5a |
| I-10 | Owner approvals are unforgeable and bound to (account, key, payee, amount, deadline) | fz `testFuzz_ownerApprovalUnforgeable`; u `test_tier_ownerApprovalBoundToTermsAndAccount` |
| I-11 | networkFee ≤ the owner's maxNetworkFee per tx, counts toward the daily cap, and is never refunded | u `test_networkFee_actualGasBoundedByOwnerMaxCountsDailyAndIsNeverRefunded`; gw v5-gas |
| I-12 | Only the executor named in the policy can pay; the executor can never trust, untrust, unpause, or cancel a reservation | u `test_onlyExecutorPays`, S7 suite |
| I-13 | Pause stops all spending immediately; only the owner unpauses; an executor pause expires after 24h | u `test_pause_*`, `test_float_pauseAndDenyStopVouchersImmediately` |
| I-14 | The exit works while paused and while Kipurse is down; every unspent unit returns to the owner | u S8, `test_pause_exitStillWorksWhilePaused`, `test_float_ownerExitReturnsEverythingUnspent`; fork `test_fork_v5ServiceDownExitDrill` |
| I-15 | Float spend per day ≤ floatCap; the float fee = ceil(0.1% × actual spend) ≤ the reserved fee; value is conserved at reconcile | fz `testFuzz_float_reconcileFeeNeverAboveReserveAndConserves`; u `test_float_capsAndBounds`, `test_float_100Micropayments_*`; fork `test_fork_floatMicropayments` |
| I-16 | A leaked session key can move at most the current float, only through EIP-3009 within its bounds | u `test_float_leakedSessionKey_*` |
| I-17 | PayerVault ERC-1271 approves only open, unexpired, reserved digests | u `test_x402_vaultNeverApprovesPermitOrArbitraryHash`, `test_x402_tamperedAuthorizationRejectedByToken` |
| I-18 | Fees never get stuck: an unmarked settled reservation returns its fee after 7 days | u `test_fee_unmarkedSettlementReturnsFeeToOwnerAfterWindow` (exception: K-1) |
| I-19 | A blocklisted fee recipient never bricks payments | u `test_fee_blocklistedRecipientNeverBricksPayments` |
| I-20 | Registry: listing takes ≥48h; removal or blocking is immediate; records expire after 90 days unless renewed; owner trust takes precedence | u registry suite, R suite |
| I-21 | (gateway) The quote refuses on >2% oracle divergence, sequencer down, the grace period, or a stale or unavailable second source, and uses the higher price | gw v5-price |
| I-22 | (gateway) Failed-tx gas is recovered FIFO, never above the owner's max per tx; the settle step is optional and separate from the exit | gw v5-gas, v5-recovery |
| I-23 | (gateway) At most one tx in flight per account; 3 failures per agent per day stops that agent | gw v5-gas, v5-gateway |
| I-24 | (zero reserve) The vault never pays ETH: validateUserOp reverts on `missingAccountFunds != 0`; execute rejects value != 0; a paymaster is required | ZR unit test validateUserOp; fork ZR; Sepolia ZR (vault 0 ETH at every checkpoint) |
| I-25 | (zero reserve) USDC gas per op ≤ maxGasPerOp (= Policy.maxNetworkFee), and never from USDC reserved for open x402 authorizations | testFuzz_gasAllowanceNeverAboveCap; test_permit1271…; test_gasNeverTouchesReservedX402Funds |
| I-26 | (zero reserve) Kipurse holds only the 0.1% fees: adapter USDC == accruedFees + pendingFees, adapter ETH == 0; gas top-ups go to the owner's vault | KipurseV5Core networkFee test; fork lifecycle; Sepolia ZR (10/10 checkpoints) |
| I-27 | (zero reserve) The session signer holds nothing and sends no txs (nonce 0) | Sepolia ZR (10/10 checkpoints) |
| I-28 | (gateway) Gas charged to the user = the actual Circle charge (prefund − refund); top-up = exactly the pending charges, capped | v5-userop tests; Sepolia ZR userOp 2 (top-up 11,376 == op 1 charge) |
| I-29 | (gateway) A payment that would revert is simulated and never sent, so it costs nobody gas | Sepolia ZR "over-cap payment refused" |

## Round 2 (2026-10-17 evening)
| # | Invariant | Evidence |
|---|---|---|
| I-30 | `markSettled` / `reclaim` / `cancelReservation` never revert because of the fee refund recipient (K-1). The fee goes to the wallet, else the vault, else accruedFees | KipurseV5Round2 K-1 x3 |
| I-31 | A vault / float vault is an EIP-1167 clone bound once, by the factory, to its account. The implementation is bound to nobody | test_clones_* , spoof test |
| I-32 | Bundler fee: <= 1 transfer per userOp, only to the owner-set operator, <= the owner cap, never below the reserved balance | test_bundlerFeePassThrough_* |
| I-33 | Packed day counters equal the sum of charges per tier (total / stranger / registry / float) | test_packedDayCounters_allTiersInOneSlot + all cap tests |
| I-34 | Ops account: deploy only before lock. After lock, only collectFees / paymaster approve <= cap / transfer to the treasury leaving a 4 x cap buffer. 0 ETH always | KipurseOpsAccountV5 x3; fork ops deploy; Sepolia ops deploy 7/7 + ZR e2e fee collection |
| I-35 | (gateway) permitAmount = min(maxGasPerOp, Circle prefund estimate x 1.5). An allowance failure retries once at the cap, never above it | v5-paymaster tests |
