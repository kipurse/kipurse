# Building and testing Kipurse

Every command below runs from the repository root. Nothing here broadcasts a transaction. Fork tests run against a local anvil fork and are skipped unless you configure them.

The results quoted below are from one run on 2026-11-22 on an Apple-silicon Mac (macOS 26), with:

- Foundry `forge 1.10.0`
- solc 0.8.37
- Node 26.7 (the project requires Node ≥ 24)
- Swift 6.4 (Xcode toolchain)

## 1. Contracts (Foundry)

```sh
cd contracts
./install-deps.sh              # fetches the pinned dependency commits into lib/ (needs git + network, about 1.5 GB with nested submodules)
forge build                    # solc 0.8.37, via_ir, optimizer 200 runs, evm cancun
forge test                     # unit + fuzz + invariant
forge test -vvv --match-path test/KipurseV54SignerTrust.t.sol   # a single suite
forge coverage --report summary --ir-minimum                    # coverage (via_ir code needs --ir-minimum)
```

`foundry.toml` sets `offline = true`, so `forge` never downloads a compiler. Install solc 0.8.37 once beforehand, for example with `forge build --offline=false`, or fetch it with svm.

**Dependency pins.** `install-deps.sh` pins these commits:

| Library | Commit |
|---|---|
| forge-std | `58d30519` |
| openzeppelin-contracts | `1edc2ae0` |
| solady | `d87a6baa` |
| account-abstraction | `fa61290d` |
| webauthn-sol | `619f20ab` |
| smart-wallet | `1bc2d0aa` |
| magicspend | `4ce54f16` |
| spend-permissions | `e0004e63` |

Nested submodules, including FreshCryptoLib, follow the gitlinks of those commits. `remappings.txt` routes account-abstraction's OpenZeppelin 4 imports to `shim/oz4`. On 2026-11-22 we checked that a fresh `install-deps.sh` produces exactly the same source files as the tree the deployed contracts were built from; the fresh checkout only adds extra test and tooling files.

### Results we got

| Step | Result | Wall time |
|---|---|---|
| `forge build` (cold) | OK: 132 files compiled. Warnings only: shadowing and unused variables in tests, no errors. | about 28 s |
| `forge test` | **282 passed, 0 failed, 1 skipped**, in 28 suites. The skipped test is the mainnet-fork test, which needs `FORK_URL`. | about 1.3 s |
| Fuzz | 13 fuzz tests × 512 runs | included above |
| Invariant | `KipurseV5InvariantTest`: 6 invariants × 64 runs × depth 64 (4,096 calls each), 0 reverts | included above |
| `forge coverage --report summary --ir-minimum` | see below | about 30 s |

Coverage, `src/` only. Branch percentages under `--ir-minimum` undercount `require(cond, CustomError())` branches, so treat them as a lower bound.

| File | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| KipurseAdapterV54.sol (live) | 69.6% (224/322) | 66.7% | 29.4% (52/177) | 69.4% |
| KipurseAdapterV52.sol (live as V5.3) | 63.6% (196/308) | 60.7% | 26.6% (45/169) | 66.7% |
| KipurseAdapterV5.sol (vault and factory live; adapter retired) | 99.8% (407/408) | 99.4% | 46.5% (114/245) | 100% |
| KipurseTrustV5.sol | 100% | 100% | 38.5% | 100% |
| KipurseTrustV54.sol | 100% | 100% | 31.6% | 100% |
| KipurseKeySeatV1.sol | 76.7% (33/43) | 61.9% | 46.7% | 100% |
| KipursePhoneApproverV4.sol | 67.6% | 48.5% | 25.0% | 100% |
| KipursePhoneApproverV3.sol | 96.7% | 91.5% | 81.8% | 100% |
| KipurseFeeControllerV5.sol | 100% | 100% | 16.7% | 100% |
| KipurseMerchantRegistry.sol | 98.6% | 98.8% | 29.4% | 94.1% |
| KipurseFloatVaultV5.sol | 100% | 98.0% | 60.0% | 100% |
| KipurseOpsAccountV5.sol | 92.3% | 87.7% | 39.6% | 90.9% |
| **All `src/`** | **75.5% (1674/2218)** | **72.4%** | **36.0% (388/1078)** | **79.2%** |

**Gaps worth knowing about.**

- The fuzz and invariant harness (`test/KipurseV5Fuzz.t.sol`, `test/V5Base.sol`) deploys the **V5 adapter**, not the live V5.3 or V5.4 adapters.
- The live adapters are covered by scenario and regression suites: `KipurseV52*`, `KipurseV54*`, `KipurseApprovalOnceStrict`, `KipurseBranchT1181`. Their line coverage is about 64–70%.
- Porting the invariant handler to `KipurseAdapterV54` would be a high-value addition.

Slither and other static analysers were **not** run for this package. Running them is welcome.

## 2. Gateway (Node)

```sh
cd server
npm ci            # we ran `npm ci --ignore-scripts`; no install scripts are needed
npm test          # node --test test/*.test.mjs, with KIPURSE_DEMO=1 and no operator config
```

Result: **653 tests: 645 passed, 0 failed, 8 skipped**, in about 11 s. The skipped tests need live credentials or an operator configuration.

## 3. iOS core logic (Swift package)

```sh
cd ios
swift test        # KipurseCore: validation, digest rebuilding, batch checks; runs on macOS or Linux, no simulator needed
```

Result: **447 XCTest tests, 0 failures**, in about 10 s (about 25 s including the build). The SwiftUI app itself (`ios/App`, generated with XcodeGen from `project.yml`) needs Xcode and is not covered by `swift test`.

## 4. Fork tests (not run here)

Fork tests replay real flows against **a local anvil fork of Base mainnet**. They impersonate accounts and set balances, and they never broadcast.

- `contracts/test/fork/*.t.sol` reads `FORK_URL` and `FORK_PERMISSION`, the ABI-encoded spend permission of a live Kipurse account, which is public on chain. Without them each test calls `vm.skip`.
- `server/test/fork/*.e2e.mjs` reads `FORK_RPC` and `FORK_PERMISSION_JSON`, and some tests also need an operator configuration. Without them the tests are skipped. Typical setup:

  ```sh
  anvil --fork-url <BASE_MAINNET_RPC> --port 8545 &
  FORK_RPC=http://127.0.0.1:8545 FORK_PERMISSION_JSON='<permission json>' node --test server/test/fork/withdraw-fork.e2e.mjs
  ```

The operator's own fork rehearsals were run against specific live wallets and are not included in the public repository. Any live Kipurse permission works as an input: read it from the `PermissionRegistered` events of a live adapter.

## 5. Checking deployed bytecode against source

```sh
cd contracts
forge inspect KipurseAdapterV54 deployedBytecode > local.hex
cast code 0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa --rpc-url https://mainnet.base.org > chain.hex
```

Then compare the two files, ignoring:

- the `immutableReferences` ranges in `out/KipurseAdapterV54.sol/KipurseAdapterV54.json`;
- the trailing CBOR metadata, whose length is in the last 2 bytes.

On 2026-11-22 this comparison found **zero** differing executable bytes for:

- `KipurseAdapterV54`, `KipurseTrustV54`;
- `KipurseAdapterV52` deployed as V5.3, and both `KipurseTrustV5` instances;
- `KipurseFeeControllerV5`, `KipurseMerchantRegistry`, `KipurseOpsAccountV5`;
- both live `PayerVaultV5` implementations.

`PayerVaultFactoryV5` differs in 64 more bytes, which we believe are the metadata of the contracts it creates. The V5.2 adapter, factory and vault are an earlier revision and do not match.
