# Kipurse architecture (for auditors)

Scope and addresses are in [`README.md`](README.md). This document describes *who holds which key* and *how money moves*. Contract references are to `contracts/src/KipurseAdapterV54.sol`, the newest adapter. The V5.3 adapter (`KipurseAdapterV52.sol`) is the same apart from `paySignedTrusted`.

## 1. Actors and keys

| Actor | Key / identity | What it can do |
|---|---|---|
| **Owner** | Base Account (Coinbase passkey). Root owner (index 0) of the owner's Coinbase Smart Wallet. | Everything the wallet can do: sign the SPM spend permission (the caps), change trust, pause and unpause, revoke the permission, withdraw, change the phone key. Every action is confirmed in Coinbase's own popup. |
| **Owner wallet** ("Kipurse wallet") | Coinbase Smart Wallet. Owners: `[Base Account, phone owner, SpendPermissionManager]`. | Holds the USDC. `msg.sender` for owner-only contract calls (`trust.set*`, `vault.withdraw`, `seat.setKey`). |
| **Phone owner** | iPhone Secure Enclave P-256 key, Face ID-gated. Installed as a wallet owner contract: `KipurseKeySeatV1` (current) or `KipursePhoneApproverV3/V4` (older). | Answers ERC-1271 `isValidSignature` for exactly five Kipurse struct kinds bound to this wallet: (1) trust, (2) untrust, (3) deny signer, (4) pay once, (5) signer trust. It never makes calls itself. It cannot sign UserOps, permits, spend permissions or owner changes. |
| **Kipurse executor / gateway** | `Policy.executor`: a session key that holds no funds. It signs ERC-4337 UserOps for the owner's **PayerVault**, and gas is paid in USDC through the Circle paymaster. | Calls the adapter's paying functions inside the owner-signed policy. Pauses for 24 h. Stores the owner's signed grants and approvals and attaches them to payments. |
| **PayerVault** | Per-wallet EIP-1167 clone, which is an ERC-4337 account. | The ERC-4337 sender for payments. Holds x402 reservations. Anyone can `sweep()` it to the wallet, minus a small gas buffer; the owner wallet can always sweep everything and can `withdraw`. |
| **AI agent** | MCP / OAuth token scoped to one wallet. | *Requests* payments, trust and allowances. Holds no key that the contracts recognize. |
| **Merchant** | A payee address, and optionally an EIP-712 order signer. | Receives USDC. Can sign `PaymentOrder`s that name the payee, amount, order id, deadline and, optionally, the payer. |
| **Attestor** | Per-merchant-domain secp256k1 key held by the Kipurse gateway. | Signs a `PaymentOrder` after reading the order over HTTPS from the merchant's own domain. It is useful only for domains the owner trusted with this attestor as signer, and only within those caps. |
| **Merchant registry maintainer** | One address (`KipurseMerchantRegistry.maintainer`). | Proposes merchants (48 h timelock) and blocks or unbinds them immediately. Only matters for owners whose permission names the registry and who have not opted out. |
| **Fee admin** | `KipurseFeeControllerV5.admin` (immutable). | Can only *lower* `feePpm`, and can propose a fee recipient, which takes effect after 48 h. |

## 2. The signed policy (the caps)

The owner signs one SPM `SpendPermission` per term:

- `spender = adapter`, `token = USDC`, `allowance = term`, a single period of 365 days at most;
- `extraData = abi.encode(Policy)`.

`Policy` holds:

| Field | Meaning |
|---|---|
| `executor` | The only caller, besides the owner's own vault |
| `guardian` | Optional pauser |
| `single` | Maximum per payment, fees excluded |
| `daily` | Maximum per day, fees included |
| `term` | Must equal the SPM allowance |
| `openSingle`, `openDaily` | Stranger tier; 0 disables it |
| `verifiedSingle`, `verifiedDaily` | Registry tier |
| `registry` | The registry used for that tier |
| `maxFeePpm` | Highest protocol fee rate the owner accepts |
| `maxNetworkFee` | Highest per-payment USDC gas reimbursement |

The adapter re-checks all of this on every payment (`_policy`, around line 432). It also routes each payee into a **tier**:

| Tier | When | Caps |
|---|---|---|
| Trusted | The owner's trust record in `KipurseTrust*`, an inline owner-signed trust, or a kind-5 signer grant | The trust's single / daily, with single ≤ policy single |
| Verified | Registry merchant, if the owner enabled it | `min(registry caps, verifiedSingle / verifiedDaily)` |
| Approved | One owner-signed `OwnerApproval(account, purchaseKey, payee, amount, deadline)` | Policy single; one use |
| Stranger | Anything else | `openSingle` / `openDaily`; 0 = refuse |

Every tier also counts against the policy's `daily` and `term`, and the SPM allowance is a second, independent term cap.

## 3. Money flows

### 3.1 AI payment within limits (trusted payee, no human in the loop)

```mermaid
sequenceDiagram
  autonumber
  participant AI as AI agent
  participant GW as Kipurse gateway (executor)
  participant V as PayerVault (4337 sender)
  participant AD as Adapter V5.x
  participant SPM as SpendPermissionManager
  participant W as Owner wallet
  participant M as Merchant payee
  AI->>GW: pay(payee, amount, merchantRef) [agent token]
  GW->>GW: preflight: tier, caps, idempotency key, already paid on chain?
  GW->>V: UserOp signed by the session key (USDC paymaster)
  V->>AD: payDirect(permission, Direct, ownerApproval="", networkFee, txDeadline)
  AD->>AD: _policy() checks caps, pause, denied payee; _routePayee() picks the tier
  AD->>AD: _usePurchase(purchaseKey) (exactly once)
  AD->>SPM: spend(permission, amount + fee + networkFee)
  SPM->>W: pull USDC (bounded by the allowance = term)
  AD->>M: amount
  AD->>V: networkFee (repays the paymaster)
  Note over AD: protocol fee accrues in the adapter; collectFees() pays feeRecipient
```

### 3.2 Owner-ask with Face ID: "trust" or "pay just once"

If the payee is not trusted, or the amount is above what its tier allows, the gateway does not pay. Instead it creates an **owner-ask card** and sends a push notification that carries only the card id.

```mermaid
sequenceDiagram
  autonumber
  participant AI as AI agent
  participant GW as Gateway
  participant P as Owner's iPhone (Secure Enclave)
  participant W as Owner wallet (ERC-1271)
  participant S as Key seat / approver
  participant AD as Adapter
  AI->>GW: pay(...) needs approval
  GW->>P: push {cardId}
  P->>GW: fetch card (phone session)
  P->>P: rebuild the digest locally from payee, amount, purchaseKey, deadline (≤ 1 h) or the trust fields; show the full address
  P->>P: Face ID, then P-256 sign(wallet.replaySafeHash(digest))
  P->>GW: approve {kind, body, r, s}
  GW->>W: isValidSignature(hash, sig) (pre-check)
  W->>S: isValidSignature(hash, abi.encode(kind, body, r, s))
  S-->>W: valid only if hash == replaySafeHash(trust.ownerDigest(structHash(kind, body)))
  GW->>AD: payDirect(..., ownerApproval) (Approved tier, once) or with "KPTR" + inline trust (Trusted tier)
  AD->>W: SignatureChecker.isValidSignatureNow(wallet, digest, sig)
```

- **Once** (kind 4): `OwnerApproval` is bound to the purchase key, payee, amount and deadline. It is consumed through `purchaseUsed`, and for x402 also through `approvalUsed`.
- **Trust** (kind 1, inline): `OwnerTrust`, with the merchant's current epoch, payees, single / daily caps and an expiry of at most 365 days. Nothing is stored on chain. The signature travels with each payment and is re-verified every time. An `untrust(merchant)` increments the epoch, which kills every stored signature for that merchant.

### 3.3 Signed merchant orders and kind-5 signer grants (V5.4)

- **`paySigned`** (V5.2 and later): the merchant signs `PaymentOrder` with the adapter as the EIP-712 domain. The adapter checks:
  - the signer is not denied;
  - the signer is trusted *and* the payee is bound to that signer's merchant (or both are found through the registry);
  - `orderUsed[signer][orderId]` and `purchaseUsed[account][keccak(merchant, orderId)]` are unused.

  `payer = 0` orders are accepted on this path; see the threat model.
- **`paySignedTrusted`** (V5.4): the owner signs once with Face ID: "trust the order signer(s) of merchant M, any per-order payee they name, up to single and daily, until expiry". This is an `OwnerSignerTrust` (kind 5) at M's current epoch. The order must name **this wallet** as payer. The per-merchant daily cap is tracked per permission. Deny-signer, untrust (epoch bump) and expiry each revoke the grant.
- **Attestor:** for a merchant that cannot sign orders, the owner trusts the merchant's domain with the Kipurse attestor as its only signer. The gateway fetches the order from that exact HTTPS origin, and the attestor signs a `PaymentOrder` with `orderId = keccak(domain:orderRef)` and `payer = wallet`.

### 3.4 x402 / EIP-3009 "exact" payments

1. `prepareAuthorization` charges the caps and pulls `value + fee + networkFee` through SPM. It moves `value + networkFee` into the owner's vault and records a reservation. The vault then ERC-1271-approves exactly one `TransferWithAuthorization(from = vault, to, value, validAfter, validBefore, nonce = purchaseKey)`, with a window of 10 minutes at most.
2. The merchant's facilitator settles the transfer from the vault.
3. Anyone can call `markSettled`, in batches, to move the reserved fee into `accruedFees`. If the transfer never settled, `reclaim` (anyone, after expiry) or `cancelReservation` (owner) returns the value, credits the caps back and refunds the fee. A fee nobody marked within 7 days is also returned to the owner.

### 3.5 Micropayment float

`fundFloat` opens one session per wallet: at most 24 h, a session key, and a fee reserve of 0.1%. `reconcileFloat` charges the fee on what was actually spent (never above the reserve) and returns the rest. Caps are charged when the float is funded and are never credited back.

### 3.6 Withdraw and rescue without the Kipurse server

All of these are signed only by the owner's Base Account, in Coinbase's popup. The iOS app builds each batch itself from public chain data (`ChainRescue.swift`, `OwnerExit.swift`) and refuses any batch it did not build.

- `wallet.execute(USDC.transfer(owner, amount))`: the wallet's own USDC.
- `wallet.execute(vault.sweep())` / `vault.withdraw(token, to, amount)`: vault leftovers. Reserved x402 value is released by `reclaim` or `cancelReservation`.
- `adapter.reconcileFloat(wallet)`: closes the float.
- `SPM.revoke(permission)`: cuts off the executor for good.
- `trust.setPaused(true)`, `untrust`, `setDeniedPayee`, `setDeniedSigner`, `seat.clearKey()`.

None of these needs the gateway, the executor or the phone.

### 3.7 Pause

| Who | How | Effect |
|---|---|---|
| Executor or vault | `adapter.pause(permission)` | 24 h pause that ends by itself |
| Guardian (optional, owner-chosen) | `adapter.pause(permission)` | Pauses until the owner unpauses |
| Owner wallet | `trust.setPaused(bool)` | Pause or unpause at any time |

Every paying function calls `trust.gate()` and reverts with `WalletPaused` while the wallet is paused.

### 3.8 Phone key change (key seat)

The wallet is created with owners `[Base Account, seat, SPM]` and owners are never changed afterwards. A new phone, a reinstall or turning Face ID off is handled by `wallet.execute(seat, 0, setKey(x, y) / clearKey())`, which the owner confirms in Coinbase's popup. Once that call lands, old phone signatures stop validating, because the seat checks against its *current* key.

## 4. Exactly-once layers

| Layer | Where | Mechanism |
|---|---|---|
| On chain | Adapter | `purchaseUsed[account][purchaseKey]` (payee, merchantRef, repeatKey; amount not included); `orderUsed[signer][orderId]` (global per signer); `approvalUsed[digest]` (x402 owner approvals); the EIP-3009 nonce = purchaseKey |
| Gateway | `server/src/v5/engine.mjs` | Idempotency keys, a claim lease per payment, a per-wallet transaction lock, an on-chain "already paid" read before sending, and day-keyed ERC-4337 nonces |
| Ledger | Gateway | Deposits are recorded once per `txHash:logIndex` |
