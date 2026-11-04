# KipurseAdapterV52 inline payee trust: self-audit (2026-10-26, internal, NOT a third-party audit)

## Change
`_routeWithApproval`: if `ownerApproval` starts with `0x4b505452` ("KPTR"), decode `(TrustParams t, bytes32 nonce, uint256 deadline, bytes sig)`, and:
1. require `t.merchant != 0`, `t.signers.length == 0`, `now < t.expiry`, `now < deadline`;
2. require the payee is in `t.payees` (PayeeBinding);
3. rebuild the KipurseTrustV5 OwnerTrust struct hash with the **current** `trust.trustOf(account, merchant).epoch`;
4. `SignatureChecker.isValidSignatureNow(account, trust.ownerDigest(sh), sig)` (ERC-1271 through the Coinbase Smart Wallet, so any wallet owner, incl. the V3 phone approver KIND_TRUST, works);
5. route = Trusted(merchant, min(t.single, policy.single), t.daily).
Everything else is byte-for-byte V5 (constructor creates its own KipurseTrustV5, so the executor/guardian pause works).

## Threats reviewed
| Threat | Result |
|---|---|
| Forged / other key signature | ERC-1271 fails → `Approval` (test) |
| Server alters caps, payees, name, expiry | struct hash changes → `Approval` (test: tampered caps) |
| Signature for wallet A used for wallet B | `account` in struct + replaySafeHash bound to wallet → `Approval` (test) |
| Payee swap | PayeeBinding (test) |
| Replay after revoke | untrust bumps epoch (in the digest) → `Approval` (test, incl. phone KIND_UNTRUST e2e) |
| Other chain / other adapter | domain = chainId + adapter (trust.core) → rejected (test) |
| Expired | `now < expiry && now < deadline` (test) |
| Signer escalation (trust a merchant signing key inline) | `signers` must be empty (test) |
| Blacklist / pause bypass | `_policy` gate runs before routing (test) |
| Policy single / daily / term, merchant daily | unchanged `_charge` (tests) |
| Old approver bound to another trust | approver recomputes digest with ITS trust → mismatch → rejected (test); migration needs a new approver |
| Tag collision with a real SignatureWrapper | abi-encoded wrapper always starts with offset word 0x00000020 → first 4 bytes are 0 → no collision |
| Gas griefing via huge payee list | caller is the executor (only it can call pay fns) and pays its own gas from the user vault; iOS limits payees ≤ 10 |
| Compromised server | can only replay signatures the owner gave, within those caps, until the owner revokes (no expiry, owner rule t554); can't widen |

## Residual risks
- No expiry (owner t554): a leaked/stored signature stays usable within its caps until the owner revokes. Revocation needs 1 on-chain tx (user-paid, ~109k gas). Forgetting only on the server is NOT a revocation.
- Not third-party audited. Contract size 23,653 / 24,576 bytes.
- Approve&remember on the phone is a long-lived signature: the phone UI must show payee, caps, expiry (it does; shows "never, until you remove it"; RequestVerify allows payees only).
