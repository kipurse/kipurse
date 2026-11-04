# Security Policy

## Reporting a vulnerability
Please email **security@kipurse.com** with a description and reproduction steps. Do not open a public issue for security problems. We aim to acknowledge within 3 business days.

## Scope
- iOS app (`ios/`): key handling, Face ID / approval flows, AI caps, pause switch, emergency withdraw.
- Server (`server/`): authorization, replay protection, spend-permission enforcement.

## Design guarantees
- Self-custody: Kipurse never holds user funds or private keys.
- The owner can withdraw everything without the Kipurse server.
- AI payments are bounded by on-chain spend permissions and app-side caps; new payees and over-cap payments require Face ID.

## Out of scope
Attacks requiring a fully compromised, unlocked device with the passcode known; third-party services (Coinbase, Base, Apple).

See `docs/security/ATTACK_PATHS.md` for the threat review and known gaps.
