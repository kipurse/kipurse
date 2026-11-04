# Coverage (forge coverage --ir-minimum, offline suites; fork suite excluded), 2026-10-17

| Contract | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| KipurseAdapterV5 (incl. PayerVaultV5 + factory) | 99.67% (305/306) | 99.46% (368/370) | 46.20% (79/171) | 100.00% (53/53) |
| KipurseFeeControllerV5 | 100.00% (18/18) | 100.00% (21/21) | 16.67% (2/12) | 100.00% (6/6) |
| KipurseFloatVaultV5 | 100.00% (25/25) | 97.87% (46/47) | 61.54% (8/13) | 100.00% (6/6) |
| KipurseMerchantRegistry | 98.63% (72/73) | 98.80% (82/83) | 29.41% (10/34) | 94.12% (16/17) |
| KipurseTrustV5 | 100.00% (67/67) | 100.00% (85/85) | 38.46% (10/26) | 100.00% (21/21) |

**About the branch percentages.** They understate real coverage. `--ir-minimum` together with `require(cond, CustomError())` is miscounted: every `require` is counted as a branch whose revert side is matched to a specific error. Many of those revert paths ARE exercised by `vm.expectRevert(X.selector)` tests but are not attributed.

Example: FeeController shows 2/12 branches, even though the suite hits all 6 revert paths (Zero ×2, FeeMax, Admin, OnlyDown, Timelock) and both success paths. The auditor should use line, statement and function coverage, plus the revert-path tests listed in `INVARIANTS.md`.

The full numbers (including lib/) are in `evidence/coverage-m12.txt`; the LCOV is in `evidence/coverage-m12.lcov`. The fork suite (5 tests) covers the real SPM, Smart Wallet and USDC paths on top of this.


## Rerun after the zero-reserve changes (evidence/coverage-zr.txt, coverage-zr.lcov)

This is 125 offline tests with `--ir-minimum`; the fork suites are excluded. `KipurseAdapterV5.sol` includes PayerVaultV5 (the 4337 account) and the factory.

| File | Lines | Statements | Branches* | Functions |
|---|---|---|---|---|
| KipurseAdapterV5.sol | 99.72% (357/358) | 99.34% (452/455) | 47.14% (99/210) | 100% (62/62) |
| KipurseFeeControllerV5.sol | 100% (18/18) | 100% (21/21) | 16.67% (2/12) | 100% (6/6) |
| KipurseFloatVaultV5.sol | 100% (25/25) | 97.87% (46/47) | 61.54% (8/13) | 100% (6/6) |
| KipurseMerchantRegistry.sol | 98.63% (72/73) | 98.80% (82/83) | 29.41% (10/34) | 94.12% (16/17) |
| KipurseTrustV5.sol | 100% (67/67) | 100% (85/85) | 38.46% (10/26) | 100% (21/21) |

\* `--ir-minimum` with custom-error `require(cond, Err())` under-reports branch coverage (see above).

The real EntryPoint v0.7 and Circle Paymaster paths are exercised by `BaseMainnetForkZeroReserve.t.sol` (fork) and the live Sepolia ZR run. Those are not counted in this table.

## Round 2 (2026-10-17 evening): `forge coverage --ir-minimum --no-match-contract Fork --skip test/BaseMainnetForkOpsDeploy.t.sol`
(The new fork file hits stack-too-deep under --ir-minimum. Fork tests are not part of coverage anyway.)

| File | Lines | Statements | Branches | Funcs |
|---|---|---|---|---|
| KipurseAdapterV5.sol (adapter + vault + factory) | 99.75% (393/394) | 99.39% (489/492) | 45.61% (104/228) | 100% (71/71) |
| KipurseFeeControllerV5.sol | 100% (18/18) | 100% (21/21) | 16.67% (2/12) | 100% (6/6) |
| KipurseFloatVaultV5.sol | 100% (28/28) | 97.96% (48/49) | 60.00% (9/15) | 100% (7/7) |
| KipurseMerchantRegistry.sol | 98.63% (72/73) | 98.80% (82/83) | 29.41% (10/34) | 94.12% (16/17) |
| KipurseOpsAccountV5.sol (new) | 92.31% (48/52) | 87.67% (64/73) | 39.58% (19/48) | 90.91% (10/11) |
| KipurseTrustV5.sol | 100% (67/67) | 100% (85/85) | 38.46% (10/26) | 100% (21/21) |
