# Web wallet and Android plan (t968, plan only)
Same contracts, same gateway, same rules: one 「暂停 AI 付款」 control, Face-ID-equivalent approval, no email/phone collection, fees in USDC from the wallet.

## Web wallet (first, ~3 weeks)
- Passkey (WebAuthn) owner via Base Account / Coinbase Smart Wallet; approval = platform authenticator (Touch ID / Windows Hello).
- Reuses: `owner-sign/` pages, rescue page (already server-free), `server/src/v5/receipt.mjs` for fee display before approval.
- Screens: wallet balance, connected AIs (real status), approve request, pause, withdraw, disputes. Each function appears once.
- No Apple Pay on web; top-up = USDC transfer only until Coinbase Onramp web approval.

## Android (second, ~6 weeks)
- Kotlin + Jetpack Compose; Credential Manager passkeys; BiometricPrompt for approvals; Play Integrity instead of App Attest.
- Port `ios/Sources/KipurseCore` logic (pure Swift) to a shared Kotlin module; reuse server test vectors for parity.
- Needs: Google Play developer account (owner decision, $25), Onramp approval for Google Pay (external).
