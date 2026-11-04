# Kipurse bug bounty (draft)
Status: **draft, rewards not yet funded** — reward amounts need the owner's decision. Until then: public credit in SECURITY.md and release notes.

Report privately to the address in `SECURITY.md`. Do not test on mainnet wallets you do not own; use Base Sepolia.

| Severity | Example | Proposed reward (pending) |
|---|---|---|
| Critical | AI spends past an on-chain cap; funds moved without owner; pause bypass | up to 10,000 USDC |
| High | Exactly-once broken (double pay); offline exit blocked | up to 2,500 USDC |
| Medium | Wrong fee shown before Face ID; dispute/refund mis-match | up to 500 USDC |
| Low | Info leak of non-secret metadata | credit |

Out of scope: see SECURITY.md. Safe harbor: good-faith research following this policy will not be pursued legally.
Static analysis in CI: Slither (fail on high), Echidna cap properties, Foundry tests, gitleaks — `ci/contracts-security.yml` (activate by moving to `.github/workflows/`).
External audit: not yet done (needs budget; candidates Cantina, Spearbit, Zellic, OpenZeppelin).
