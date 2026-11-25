# Kipurse security audit package: scope

Kipurse is a **non-custodial USDC wallet on Base** in which AI agents can pay merchants **only within limits the human owner signed**. The owner's wallet is a Coinbase Smart Wallet. The owner's Base Account (passkey) is its root owner. Kipurse gets a Coinbase SpendPermissionManager (SPM) spend permission whose `spender` is a Kipurse adapter. The owner's iPhone holds a Face ID-gated Secure Enclave P-256 key. That key can approve a narrow set of Kipurse actions, and nothing else.

This folder is the starting point for external auditors and security researchers:

| File | What it covers |
|---|---|
| `README.md` (this file) | Scope: what is deployed, what is in and out of scope, and the build settings |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Actors, keys, and the money flow for every payment and exit path |
| [`THREAT_MODEL.md`](THREAT_MODEL.md) | Assets, trust assumptions, invariants to try to break, known limitations |
| [`TESTING.md`](TESTING.md) | How to build and test every component, with the results we got |

To report a vulnerability, see [`../../SECURITY.md`](../../SECURITY.md). Please do not open public issues for security bugs.

> **Status:** the contracts below are live on Base mainnet. They have had internal reviews only and **no third-party audit**. Several source files still carry the old "development only / NOT audited" comment. That comment is accurate about the audit and stale about deployment.

---

## 1. Build settings (all contracts)

From `contracts/foundry.toml`:

| Setting | Value |
|---|---|
| Compiler | solc **0.8.37** (`pragma ^0.8.28` in sources) |
| EVM version | `cancun` (the code uses transient storage, EIP-1153) |
| Optimizer | enabled, `optimizer_runs = 200` |
| IR pipeline | `via_ir = true` |
| Fuzz | `runs = 512` |
| Invariant | `runs = 64`, `depth = 64`, `fail_on_revert = false` |
| Dependencies | pinned by commit in `contracts/install-deps.sh` (forge-std, OpenZeppelin, solady, account-abstraction, webauthn-sol / FreshCryptoLib, Coinbase smart-wallet, magicspend, spend-permissions) |

**Deployed bytecode vs. this tree.** We compared runtime bytecode on 2026-11-22 for the V5.3 and V5.4 suites, the shared fee controller, the merchant registry and the fee-recipient operations account. Built from this tree with the settings above, every one matches the on-chain code byte for byte, except for:

- immutable slots;
- the trailing CBOR metadata hash, because comments and paths changed after deployment.

The vault factory also differs in 64 additional bytes, which we believe are the embedded metadata hashes of the contracts it creates. Please confirm this yourself; `TESTING.md` §5 shows how. The **V5.2 adapter, V5.2 vault factory and V5.2 vault implementation** were built from an earlier revision that is not in this tree, and their bytecode differs. See the table notes.

## 2. In-scope contracts

nSLOC counts non-blank, non-comment-only lines; Total is `wc -l`. Every address below is on Base mainnet (chain id 8453).

### 2.0 V5.5 suite (newest)

New wallets open on V5.5 (owners: Base Account, `KipurseKeySeatV2`, SPM). Runtime bytecode built from this tree matches the chain for every contract below, apart from immutables and the trailing metadata hash (checked 2026-11-25).

| Contract | File | nSLOC / Total | Address(es) |
|---|---|---|---|
| `KipurseAdapterV55` | `contracts/src/KipurseAdapterV55.sol` | 487 / 636 | `0x53F99af228A165A312Ed4A7E47447a9137dbf03e` |
| `KipurseTrustV55` | `contracts/src/KipurseTrustV55.sol` | 169 / 234 | `0xDBb66b5E7a2773e0419093Ea5cf6E70E68A747B4` (created by the adapter) |
| `PayerVaultFactoryV55` / `PayerVaultV55` | `contracts/src/KipursePayerVaultV55.sol` | 245 / 332 | factory `0xC01C40bBE92D0e959C2730c5f62F2737baEEc248`; vault implementation `0xB0F92441A31CbCB7Baa5659a08228De8De7d2BDf` (EIP-1167 clones) |
| `KipurseFloatVaultV55` | `contracts/src/KipurseFloatVaultV55.sol` | 63 / 89 | implementation `0x54830Fc7042DBe7A4Eb03928ACf22Cf7B251780b` (clones) |
| `KipurseKeySeatV2` | `contracts/src/KipurseKeySeatV2.sol` | 105 / 155 | one per wallet (CREATE2 in each opening batch) |
| `KipurseMerchantRegistryV2` | `contracts/src/KipurseMerchantRegistryV2.sol` | 128 / 185 | `0xB8ce1FfCbF88DBd73C5C6f557b3D68cF0b92Eb68` |
| `KipurseFeeControllerV5` (reused) | `contracts/src/KipurseFeeControllerV5.sol` | 37 / 50 | `0x8F52D223DF89E388DcB5d39C53f154b9F8F9a67A` |

Deploy plan: `server/mainnet/v55-deploy-plan.json` (deterministic deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`).

### 2.1 Live (older suites)

| Contract | File | nSLOC / Total | Address(es) | Status |
|---|---|---|---|---|
| `KipurseAdapterV54` | `contracts/src/KipurseAdapterV54.sol` | 482 / 624 | `0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa` | **Live**: V5.4 suite (signer grants, key-seat wallets) |
| `KipurseTrustV54` (extends `KipurseTrustV5`) | `contracts/src/KipurseTrustV54.sol` | 31 / 45 | `0x22eF1633252653932076cB911b155F9D7f73A9E9` (created by the V5.4 adapter constructor) | **Live** |
| `KipurseKeySeatV1` | `contracts/src/KipurseKeySeatV1.sol` | 79 / 115 | one per wallet, at a deterministic CREATE2 address: deterministic deployer, args `(factory, owner, SPM, trust)` | **Live**: the phone-key owner of V5.4 wallets |
| `KipurseAdapterV52` source, deployed as the **V5.3** adapter | `contracts/src/KipurseAdapterV52.sol` | 464 / 595 | `0xb150030be35903AdEE466d7733Bf0841B667033C` | **Live**: suite for new wallets |
| `KipurseTrustV5` | `contracts/src/KipurseTrustV5.sol` | 117 / 156 | V5.3: `0xDa1dCc6677f352bA551fEb8ca0f39d46B41535c3`; V5.2: `0x65D2cE04DA7aCe81e7C4ab08712509282745eC84` | **Live** |
| `PayerVaultFactoryV5` / `PayerVaultV5` (in `KipurseAdapterV5.sol`) | `contracts/src/KipurseAdapterV5.sol` (only these two contracts are live from this file) | 629 / 818 for the whole file | factory (V5.3 / V5.4) `0x34d9Bdc9E10815fB6913AF5BC0DAad7E53dbD57D`; vault implementations: V5.3 `0x0bf04254cf9a16c83c10159a79e2420528608cda`, V5.4 `0x99D11aFAc77B4E8Ea8AF00C543eee36a74591bBc`; vaults are EIP-1167 clones, one per wallet | **Live** |
| `KipurseFloatVaultV5` | `contracts/src/KipurseFloatVaultV5.sol` | 57 / 80 | EIP-1167 clones created by the factory (micropayment float) | **Live** (the feature may be switched off per deployment) |
| `KipurseFeeControllerV5` | `contracts/src/KipurseFeeControllerV5.sol` | 37 / 50 | `0x8F52D223DF89E388DcB5d39C53f154b9F8F9a67A` (shared by V5.2, V5.3 and V5.4); `feePpm` = 1000 (0.1%) when this was written | **Live** |
| `KipurseMerchantRegistry` | `contracts/src/KipurseMerchantRegistry.sol` | 121 / 169 | `0x26c707ccbd569624CF31F5c574d4Fdf7E3f23998` (`delay` = 48 h) | **Live** (optional; each owner opts in per permission) |
| `KipurseOpsAccountV5` | `contracts/src/KipurseOpsAccountV5.sol` | 93 / 124 | the fee controller's `feeRecipient()` | **Live** (protocol fee recipient, an ERC-4337 account) |
| `KipursePhoneApproverV4` | `contracts/src/KipursePhoneApproverV4.sol` | 72 / 102 | one per wallet (CREATE2) | **Live** on V5.4 wallets that were migrated with an approver owner. Newer wallets use a key seat instead. The kinds and bodies are the same as in the key seat. |
| `KipursePhoneApproverV3` | `contracts/src/KipursePhoneApproverV3.sol` | 63 / 91 | one per wallet (CREATE2) | **Live** for V5.2 / V5.3 wallets |
| `KipurseErrors`, `ISpendPermissionManager`, `IKipurseMerchantRegistry` | `contracts/src/` | 83 + 17 + 7 | n/a | Shared |

Live total: about 2,300 nSLOC, counting the whole `KipurseAdapterV5.sol` file.

### 2.2 Legacy: still on chain, no new wallets

| Contract | Address | Note |
|---|---|---|
| V5.2 adapter | `0x05320BeD08309F66316F7d73e2D0be110400FbB2` | Wallets opened before V5.3 may still hold a valid V5.2 permission. **Bytecode does not match** `KipurseAdapterV52.sol` in this tree (22,098 vs. 23,821 bytes): it is an earlier revision of the same design. |
| V5.2 vault factory / implementation | `0x6CE7BC537379A6e10b88D1e98A5c3803a9812BE9` / `0xc53ab278fe26b31f85b5ccc73eb5a7dd81e05038` | Earlier revision, before the daily operations cap. |

If you need the exact V5.2 sources, ask the maintainers. A finding that also applies to V5.2 is in scope.

### 2.3 Retired or not deployed on mainnet (lower priority; useful for context and diffs)

| File | Status |
|---|---|
| `KipurseAdapterV5` contract (in `KipurseAdapterV5.sol`) | Superseded by V5.2. The vault and factory in the same file are live. |
| `KipurseAdapterV51.sol`, `KipurseTrustV51.sol`, `KipurseOrderVerifier.sol` | V5.1 line: not used by any live suite. |
| `KipursePhoneApprover.sol`, `KipursePhoneApproverV2.sol` | Retired approver versions. |
| `KipurseEscrowV1.sol` | Testnet and fork only; not deployed on mainnet. |

### 2.4 External contracts Kipurse relies on (out of scope, but assumptions about them are in scope)

- USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (EIP-3009, EIP-2612)
- Coinbase SpendPermissionManager: `0xf85210B21cC50302F477BA56686d2019dC9b67Ad`
- Coinbase Smart Wallet (owner wallets), ERC-4337 EntryPoint v0.6 / v0.7, Circle USDC paymaster
- RIP-7212 P-256 precompile at `0x100`, with FreshCryptoLib as the fallback

## 3. In-scope off-chain components, in priority order

The contracts bound the damage. The off-chain code decides *what the owner is shown and signs*, and *what the executor submits*.

1. **Phone-side signature checks (iOS, `ios/Sources/KipurseCore/`).** The phone must never sign a digest it did not rebuild itself from fields it shows the owner. Key files:
   - `OwnerPay.swift` (one-time payment approval)
   - `PhoneTrust.swift` (trust and signer-grant digests)
   - `OwnerAsk.swift` (owner-ask cards)
   - `RequestVerify.swift` and `BatchVerify.swift` (owner batches before Coinbase signing)
   - `KeySeat.swift` (seat address and key changes)
   - `KipurseSuite.swift` (which contract suite a wallet uses)
   - `SafetyCaps.swift`, `DisplaySafe.swift` (lookalike-address display)
   - `ChainRescue.swift`, `OwnerExit.swift` (exit without the server)

   About 1,600 lines.
2. **Gateway payment engine (`server/src/v5/engine.mjs`, `userop.mjs`, `mandates.mjs`).** Routing, preflight, exactly-once logic (idempotency keys, claims, on-chain `purchaseUsed` / `orderUsed` checks), and UserOp construction.
3. **Owner-ask and trust (`server/src/v5/owner-ask.mjs`, `owner-ask-approve.mjs`, `trust-requests.mjs`, `trust-approve-public.mjs`, `signer-trust-v54.mjs`, `joint-trust.mjs`, `address-trust.mjs`).** How an AI request becomes a card the owner approves with Face ID, and how the stored grants are used afterwards.
4. **Phone enrollment and sessions (`server/src/v5/phone-signer.mjs`, `phone-session.mjs`, `key-seat.mjs`, `move-seat.mjs`).** Who can start a key change, and how phone sessions are bound to a wallet.
5. **Attestor (`server/src/v5/attestor.mjs`, `attestor-client.mjs`, `discovery.mjs`, `merchant-sig.mjs`).** A Kipurse-held per-domain order signer that reads a merchant's order over HTTPS and signs a `PaymentOrder` for it.
6. **Push approval (`server/src/v5/push.mjs`, `push-tokens.mjs`, plus the iOS push handler in `ios/App/`).** Push payloads carry only IDs, and card data is always re-read. Check that a push action cannot skip the full card.
7. **Owner withdraw and emergency (`server/src/v5/owner-withdraw.mjs`, `owner-emergency.mjs`, `owner-pay.mjs`).**

## 4. Out of scope

- Vendored or third-party code under `contracts/lib/`, `contracts/shim/` and the SPM sources: OpenZeppelin, solady, Coinbase smart-wallet, magicspend, spend-permissions, webauthn-sol, FreshCryptoLib, account-abstraction. *Misuse* of these libraries by Kipurse code is in scope.
- UI layout, copy, localization, widgets and Siri phrasing, unless they cause the owner to approve something other than what is displayed.
- `testshop/` (a demo merchant), deployment and migration scripts under `contracts/script/` and `server/mainnet/`, and documentation.
- Operator infrastructure: hosting, TLS, DNS, APNs keys, RPC providers. The threat model still covers "the server is compromised" as a whole.
- Coinbase, Base, Apple and Circle services themselves.
- Findings that only restate the known limitations in `THREAT_MODEL.md` §6. A way to turn one of them into an actual loss *is* in scope.

## 5. What we would most like you to look at

1. Can the executor or gateway move more than the owner-signed `single` / `daily` / `term` caps, or pay a payee outside the owner's trust / approval / registry / stranger tiers?
2. Can a phone-key signature (key seat or approver) authorize anything other than the five Kipurse kinds: trust, untrust, deny-signer, pay-once and signer-trust?
3. Exactly-once payment: can one purchase key or merchant order be paid twice, across `payDirect`, `paySigned`, `paySignedTrusted`, x402 `prepareAuthorization` and the float?
4. Accounting: vault reservations, `pendingFees` / `accruedFees`, float reconciliation, fee refunds. Can fees or reserved funds get stuck or be stolen?
5. Owner exit: can anything stop the owner from revoking the permission, pausing, and withdrawing with only their Base Account?
