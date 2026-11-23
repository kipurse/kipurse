# Kipurse threat model

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) first; it defines the actors, tiers and flows this document refers to.

## 1. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| A1: the owner's USDC | Owner wallet; per-wallet PayerVault (reservations, gas buffer); float vault | The money itself |
| A2: the owner's spending authority | The SPM spend permission plus `Policy` (caps) | Bounds everything the executor can do |
| A3: owner-signed grants | Inline trust (kind 1), signer grants (kind 5) and one-time approvals (kind 4), stored by the gateway | Each is reusable or single-use spending authority *together with* the executor |
| A4: the phone key | iPhone Secure Enclave, Face ID-gated | Can create A3 |
| A5: the executor session key | Kipurse gateway | Can spend within A2, using A3 |
| A6: protocol fees | `accruedFees` / `pendingFees` in the adapter; fee recipient | Kipurse revenue; must never come from more than the owner accepted |
| A7: the integrity of what the owner sees | iOS cards, push text, the Coinbase signing page | If the display lies, the owner signs the wrong thing |
| A8: privacy | Payee names, amounts, AI text in pushes and records | Leaks spending behaviour |

## 2. Trust assumptions

### 2.1 Fully trusted (out of scope to break)

- The owner's Base Account (passkey) and Coinbase's signing popup.
- Coinbase Smart Wallet, SpendPermissionManager, USDC, EntryPoint and the Circle paymaster behave as specified.
- iOS Secure Enclave and Face ID.

### 2.2 Compromised Kipurse server, gateway or executor

This is the main adversary. Assume the attacker holds the executor key, every stored grant (A3) and the database, and can change any gateway response.

**What it CAN do:**

- Pay **trusted** payees (owner trust or still-valid grants) up to their single and daily caps.
- Pay **registry** merchants up to the verified-tier caps, if the owner enabled the registry.
- Pay **any address** up to `openSingle` / `openDaily`, if the owner enabled the stranger tier (non-zero).
- With a kind-5 signer grant, pay any payee that the granted signer names. If the attacker *also* controls the signer, that means any payee, within the grant caps. This is why the attestor key matters: it is a gateway-held signer.
- In every case, stay within the policy's `daily` and `term`, which equal the SPM allowance. The worst case is "drain up to `term` at the `daily` rate". It is **not** "drain the whole balance".
- Pause the wallet for 24 h. Refuse service: stop paying, stop showing cards, withhold refunds it would otherwise initiate.
- Show the owner false *off-chain* information, such as history or names. The iOS app re-reads balances, vaults, owners and the active suite from chain wherever it can.
- Ask the owner to sign things. The phone rebuilds every digest from the fields it displays, so the server cannot get a phone signature over a digest the owner did not see. It can still propose a trust with large caps or a long expiry, and social-engineer the owner into approving it.

**What it CANNOT do (try to break these):**

- Spend above `single` per payment, above `daily` per day (fees included), or above `term` in total.
- Pay a payee outside the owner's trust, approval, registry and stranger tiers.
- Raise the fee above the controller's `feePpm`, or above the owner's `maxFeePpm`. Charge a network fee above `maxNetworkFee`.
- Use a phone signature for anything other than the five Kipurse kinds, or for another wallet, chain or adapter domain.
- Change the phone key, add a wallet owner, or change the permission. All of these need the Base Account.
- Block the owner's exit (§3, I-9).

### 2.3 Compromised AI agent

The agent holds only an agent token. It can request payments, trust and allowance changes, and it can write the free text shown in a push or card. It **cannot** approve anything, and agent trust requests can never add *signers*. Its main lever is prompt-injected purchases, such as planting a merchant order in a page the AI reads. These are bounded by the tiers above. Payments outside the trusted tiers need the owner's Face ID.

### 2.4 Malicious merchant

A malicious merchant can sign orders with arbitrary payees and amounts.

- Without a grant, payee binding (`paySigned`) limits it to its own bound payees.
- With a kind-5 grant, it can name any payee within the grant caps, until the owner revokes the grant (untrust or deny-signer) or the grant expires.
- It cannot replay an order id (`orderUsed`, `purchaseUsed`).
- It can refuse delivery. Escrow is not live on mainnet, so on mainnet this is a commercial dispute, not a protocol one.

### 2.5 Stolen or lost phone

- The phone key needs Face ID. An attacker who has an unlocked device *and* can pass Face ID, or who knows the passcode where the app allows it, is out of scope.
- The owner recovers with only the Base Account: `seat.clearKey()` / `setKey(new)` (or removes the approver owner on older wallets), `trust.setPaused(true)`, and `SPM.revoke`.
- Old phone signatures stop validating as soon as the key changes. But see KL-1.

### 2.6 Lookalike addresses and domains

- The phone shows the **full** payee address before Face ID, and the app flags lookalikes (`DisplaySafe.swift`, `SafetyCaps.swift`).
- In a signer grant or the attestor flow, the owner's anchor is the **merchant domain string**. A lookalike domain that publishes its own signer would get a card reading "Trust <lookalike> and pay". If the owner approves it, that grant covers any payee its signer names, within the caps, until it expires. Please assess how strong this anchor is in practice.

### 2.7 Kipurse admins

| Admin | Powers | Limits |
|---|---|---|
| **Fee admin** | `lowerFee` (only down) and `proposeRecipient` | The recipient change has a 48 h timelock; `MAX_FEE_PPM` = 3000 (0.3%) is a hard cap. Today this is a single smart account, not a multisig. |
| **Registry maintainer** | Merchant additions | Additions have a 48 h timelock; blocks and unbinds are immediate; records expire after 90 days. A malicious maintainer can list an attacker's merchant after 48 h. That only affects owners who opted into the registry, and only within `verifiedSingle` / `verifiedDaily`. Today this is a single smart account. |
| **No upgrade path** | None | Adapters, trust and seats have no proxy, no owner and no `selfdestruct`. Moving to a new version requires the owner to sign a new permission. |

## 3. Invariants to try to break

Invariants I-1 to I-9 are the main ones. I-10 to I-14 are secondary.

| # | Invariant | Where it is enforced | Existing tests |
|---|---|---|---|
| I-1 | The executor never moves more than the owner-signed caps: per payment ≤ `single` (or the tier's single), per day ≤ `daily` (fees included), total ≤ `term` = SPM allowance (fees included). | `_policy`, `_charge`, SPM | `invariant_dailyCaps`, `invariant_termCapIncludingFees`, `testFuzz_feeCountedInEveryCap` (on the V5 adapter; see `TESTING.md`) |
| I-2 | No payee is paid outside: owner trust (stored or inline), a kind-5 grant, a one-time owner approval, the registry tier (if enabled, not opted out, not blocked), or the stranger tier (`openSingle` > 0). | `_routePayee`, `_routeWithApproval`, `_routeSigned`, `paySignedTrusted` | `invariant_attackerOnlyStrangerTier`, `testFuzz_signedOrderOnlyToBoundPayee` |
| I-3 | `feePpm ≤ MAX_FEE_PPM` (3000). `feePpm` never increases. The fee charged ≤ the owner's `maxFeePpm`. The network fee ≤ `maxNetworkFee`. | `KipurseFeeControllerV5`, `_policy` | `testFuzz_feeNeverRises`, `invariant_feeBoundedByHardMax` |
| I-4 | A fee-recipient change takes effect only ≥ 48 h after it is proposed, and the admin can cancel it. | `KipurseFeeControllerV5` | unit tests |
| I-5 | One payment per `purchaseKey` per wallet. One per `(signer, orderId)`. One per `(merchant, orderId)` per wallet. One x402 reservation per owner approval. | `purchaseUsed`, `orderUsed`, `approvalUsed`, EIP-3009 nonce | `testFuzz_samePurchaseNeverPaidTwice` |
| I-6 | A phone-key signature validates only for the five Kipurse kinds, for this wallet, on this chain and this trust/adapter domain. Never for a UserOp, permit, spend permission, Permit2 or owner change. | `KipurseKeySeatV1`, `KipursePhoneApproverV3/V4` | `test_seat_cannot_sign_anything_else`, `test_v3_cannotSignArbitraryHashes` |
| I-7 | After `untrust(M)` / `untrustBySig`, `setDeniedSigner`, `seat.setKey/clearKey` or expiry, no previously signed trust or grant for the affected merchant, signer or key works. | Trust epoch, deny lists, seat key | `KipurseV54SignerTrust.t.sol`, `KipurseKeySeatV1.t.sol` |
| I-8 | The adapter holds only fees (`accruedFees + pendingFees`). A vault never holds less USDC than its open reservations. | Adapter, vault | `invariant_adapterHoldsOnlyFees`, `invariant_vaultCoversReservations` |
| I-9 | **The owner can always exit** using only the Base Account: revoke the permission, pause, withdraw from the wallet and vault, cancel reservations and reconcile the float. Nothing Kipurse or a third party does can block this. That includes USDC blocklisting of another party and a failing registry. | Wallet, vault `withdraw` / `sweep`, `cancelReservation`, `reconcileFloat`, `_refundFee` | `withdraw-fork.e2e.mjs` (fork) and unit tests |
| I-10 | An executor pause lasts ≤ 24 h. Only the owner ends an owner or guardian pause. | `KipurseTrustV5.pauseFor` | unit tests |
| I-11 | A registry that reverts or burns gas is treated as "not listed, not blocked". It can never block a payment to an owner-trusted payee. | `_reg*` with `REGISTRY_GAS` | unit tests |
| I-12 | A V5.4 signer-grant payment requires `order.payer == wallet`. | `paySignedTrusted` | `KipurseV54SignerTrust.t.sol` |
| I-13 | The vault signs (ERC-1271) only digests approved by the adapter and userOps from the session signer. It never signs a permit or an arbitrary hash. | `PayerVaultV5.isValidSignature` | `test_x402_vaultNeverApprovesPermitOrArbitraryHash` |
| I-14 | The vault's userOp gas charge stays within `maxGasPerOp`, and the number of session ops per day stays within `opsPerDay`. | `PayerVaultV5.validateUserOp` | `testFuzz_gasAllowanceNeverAboveCap` |

Off-chain invariants:

| # | Invariant |
|---|---|
| O-1 | The phone never signs a digest it did not rebuild from fields it displays. |
| O-2 | Push actions never reach Face ID without the full card being shown. |
| O-3 | A phone session or agent token from one wallet never acts on another wallet. |
| O-4 | Only an authenticated owner context can start a phone key change. |
| O-5 | The gateway never submits a payment the owner's tiers would not allow. The chain is the backstop, but a gateway bug that relies on the chain to reject a payment still costs gas. |

## 4. Known design properties (not bugs, but please probe the edges)

- **`paySigned` accepts orders with `payer = 0`.** Any Kipurse wallet that trusts the signer may pay such an order. The gateway refuses AI-initiated unbound orders unless it fetched the order itself from the merchant's verified origin. The contract does not enforce this. The V5.4 `paySignedTrusted` path requires `payer == wallet`.
- **`orderUsed[signer][orderId]` is global per signer.** Whoever pays an order first marks it used for everybody. Probe this for front-running and griefing.
- **High-s P-256 signatures are accepted.** No path deduplicates on signature bytes; replay is controlled by state, nonces and keys.
- **`seat.setKey` does not check that the key is on the curve.** An off-curve key only disables the seat, and each failing check spends roughly 200k gas in the FreshCryptoLib fallback.
- **Stranger tier.** If the owner sets `openSingle` / `openDaily` above 0, the executor can pay *any* address within those caps. This is by design: small purchases from unknown shops.

## 5. Fixed findings from internal review (for context)

Internal reviews found the following issues. They were fixed in the gateway or app and deployed. Please check that the fixes hold:

- **Phone-key enrollment.** Starting a phone-key enrollment, which is a key-seat key change, could be done without an authenticated owner context.
- **Unbound orders.** The gateway accepted AI-supplied signed orders with `payer = 0` (see §4).
- **Trust ceilings.** The phone checked trust-mode ceilings against server-supplied values, and did not check `daily`.
- **Push shortcut.** Lock-screen push actions could reach Face ID before the full card was shown.
- **Device tokens.** Push device tokens were copied between wallets during a wallet migration too broadly, and copied again on every restart.

## 6. Known limitations (accepted for now)

Reports that only restate these are not new findings. A way to turn one of them into an actual loss is very welcome.

- **KL-1: the phone key epoch is not bound into signatures.** If the owner clears the key and later sets the *same* key again, old signatures from that key become valid again while still inside their deadline. That includes stored inline trusts and signer grants, which can last up to their expiry of at most 365 days. Changing to a *different* key does invalidate them.
- **KL-2: inline trusts and signer grants are reusable bearer approvals.** Their nonce is not consumed, and their signature deadline equals the grant expiry, 90 days by default. Whoever holds a stored grant *and* the executor can pay within the grant caps until the grant is revoked (untrust or deny-signer), the key changes, or it expires.
- **KL-3: the gateway's decision function is not the code path that submits the payment.** The "can this be paid / does it need approval" answer is computed separately from the path that builds the payment, so explanations and preflight can disagree with what is submitted in edge cases. One stored mapping from signer to merchant can also be overwritten when two merchants share a signer. On-chain checks still bound the spend.
- **KL-4: some trust "prepare" endpoints are unauthenticated.** Anyone who knows a request id can move it to "awaiting signature" and read its fields. Completing it still needs a valid phone or owner signature.
- **KL-5: the key seat's `setKey` does not check that the P-256 point is on the curve, and high-s signatures are accepted.** An off-curve key only locks out its own owner (no signature can verify against it). Malleable signatures cannot be replayed, because every approved digest is single-use or bound to a nonce. Impact is low, but the check is cheap to add in a future version.
- **KL-6: the fuzz and invariant harness still targets the retired V5 adapter.** The live V5.3 and V5.4 adapters have unit tests and fork tests, but branch coverage is low (about 27–30%). Reviewers should treat the V5.4 `paySignedTrusted`, inline-trust and phone-approval paths as the least-tested surface.
- **KL-7: source verification is partial.** The deployed bytecode matches this source apart from immutables and the metadata hash, so explorer "exact match" verification is not available for every contract. See TESTING.md for how to compare the runtime code yourself.
