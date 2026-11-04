# $1 mainnet real-device offline-exit test — owner steps (prepared, nothing spent)
Purpose: prove the owner can get money out with Kipurse servers OFF, using only the rescue page + Base mainnet.
Spend: 1 USDC test amount (returns to the owner) + Base network cost (a few cents) paid by the owner.

1. Owner (iPhone, Kipurse app): note current wallet balance. Top up exactly 1 USDC from own Base Account into the Kipurse wallet (or use existing balance).
2. Owner: in app, open "Offline withdraw guide" and save the rescue card (the link stays on the phone; never sent to a server).
3. Me (with owner watching): stop the public kit + mainnet runtime routes temporarily (`systemctl stop kipurse-main` on VPS) — needs owner "go" at that moment; confirm https://pay.kipurse.com/mcp no longer answers.
4. Owner: open the rescue page from the saved card (static page, works without our server), choose destination = own Base Account, sign with Base Account (Face ID).
5. Verify on basescan.org: one executeBatch from the Kipurse wallet, USDC transfer to the owner's address, wallet balance 0 (or the remaining amount).
6. Me: restart `kipurse-main`, check health (/mcp 401, owner page 200), app reconnects.
7. Record tx hash + times in ~/t968/PROGRESS.md and docs/security/ATTACK_PATHS.md (mark offline exit "verified on mainnet").
Rollback: if step 4 fails, restart kipurse-main immediately; funds stay in the wallet (self-custody, nothing moved).
