# Security Policy

## Reporting a vulnerability
Report privately through GitHub (Security tab → **Report a vulnerability**), or email **support@kipurse.com** with the subject "Security", a description and reproduction steps. Please do not open a public issue for security problems. We aim to acknowledge within 3 business days.

## Status
- The contracts are deployed on Base mainnet and are **not audited** by a third party.
- Kipurse is self-custodial: it never holds user funds or the owner's keys. The owner can always revoke the Kipurse spend permission from their own Base Account and withdraw without the Kipurse server.

## Scope
- iOS app (`ios/`): key handling (Secure Enclave), Face ID approval flows, batch verification before signing, AI limits, pause switch, offline exit.
- Gateway (`server/`): authorization, replay protection, limit enforcement, signing-page integrity, agent (MCP/OAuth) access.
- Contracts (`contracts/`): trust/adapter/vault logic, phone approver, escrow, merchant registry.

## Known limitations
These are known and accepted for now; reports that only restate them are not new findings, but ways to turn them into an actual loss are very welcome.
1. **Phone key epoch is not bound into signatures.** A phone-approver signature is checked against the currently enrolled key, but the key's enrollment epoch is not part of the signed message.
2. **Some inline / per-payment grants are reusable until they expire or are revoked.** A grant of this kind can be used again within its limits until its expiry or an explicit revocation, rather than being strictly single-use.
3. **The gateway's decision function is not the same code path as the payment it describes.** The gateway's "can this be paid / does it need approval" answer is computed separately from the path that builds and submits the payment, so the two can disagree in edge cases. On-chain limits still bound what can be spent.
4. **Some trust "prepare" endpoints are unauthenticated.** They only build an approval request for the owner; they cannot approve anything or move funds, but they can be called by anyone.

## Out of scope
Attacks that need a fully compromised, unlocked device with the passcode; bugs in third-party services (Coinbase, Base, Apple) unless Kipurse uses them incorrectly; social engineering of the owner.
