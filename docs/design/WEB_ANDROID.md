# Web wallet and Android plan (t968, plan only)
Same contracts, same gateway, same rules: one 「暂停 AI 付款」 control, Face-ID-equivalent approval, no email/phone collection, fees in USDC from the wallet.

## Web wallet (first, ~3 weeks)
- Passkey (WebAuthn) owner via Base Account / Coinbase Smart Wallet; approval = platform authenticator (Touch ID / Windows Hello).
- Reuses: `owner-sign/` pages, rescue page (already server-free), `server/src/v5/receipt.mjs` for fee display before approval.
- Screens: wallet balance, connected AIs (real status), approve request, pause, withdraw, disputes. Each function appears once.
- No Apple Pay on web; top-up = USDC transfer only until Coinbase Onramp web approval.

## Android (in parallel with web, ~6 weeks; Play account available)
- Kotlin + Jetpack Compose; Credential Manager passkeys; BiometricPrompt for approvals; Play Integrity instead of App Attest.
- Port `ios/Sources/KipurseCore` logic (pure Swift) to a shared Kotlin module; reuse server test vectors for parity.
- Google Play: owner already has a developer account. Plan: internal testing track first (week 4), closed testing (week 5, Play requires testers for new personal accounts), production review (week 6).
- Release rule mirrors TestFlight: every Play build is synced to github.com/kipurse/kipurse and tagged (`android-vX.Y.Z-buildN`).
- Play policy items to prepare: Financial features declaration (crypto wallet, non-custodial), Data safety form (no email/phone collected), target API level current, App signing by Google Play.
- External: Coinbase Onramp approval for Google Pay (separate from the Apple Pay application).
