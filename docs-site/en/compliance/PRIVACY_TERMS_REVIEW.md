# Privacy policy & Terms of Service review

> Not legal advice. Based on the 2026-10-27 drafts and the live kipurse.com/privacy (last updated October 23, 2026).

## Live status (checked 2026-11-03)
- `https://kipurse.com/privacy` → real privacy policy page dated 2026-10-23 (the **old version**; the 10-27 draft updates were not published).
- `https://kipurse.com/terms` → returns 200 but shows the **home page** (single-page-app fallback); **the Terms of Service are not published yet**.
- App: Settings → Help already has "Privacy Policy"; this round added "Terms of Service" (in that one place only). Until the terms page is published, the link opens the home page — it must be published first.

## Privacy policy — issues found
1. **Outdated wording on network fees**: the live policy's gas wording no longer matches the product. New-wallet setup now has a fixed 0.05 USDC network fee deducted from the wallet balance. Suggested wording: "the wallet setup network fee is deducted from your Kipurse wallet balance".
2. **Apple Pay / Onramp**: only the Coinbase-hosted page (Coinbase itself collects email, phone and payment details); Kipurse never collects or verifies email or phone. The policy should state that purchases go to a Coinbase page and we pass only the wallet address, asset and amount.
3. **Push tokens**: covered in the draft; confirm whether the nutrition label should tick "Device ID".
4. **Reading the Coinbase Verified attestation**: state that we read the public on-chain EAS attestation (only whether the address has one, no identity data).
5. **AI agent data**: OAuth authorization, agent name — covered in the draft.
6. **Children**: state 18+ (relies on Coinbase KYC).

## Terms of Service — issues found
1. **Not published** (biggest issue).
2. §9 says Apache-2.0 + AGPL-3.0 — matches the open-source repo (contracts/ios/SDK Apache-2.0, server AGPL-3.0).
3. §6 Fees: the placeholder about the first wallet-setup network fee must be updated to the current setup-fee rule.
4. §2 "Apple Pay/Onramp US only" to be confirmed after Coinbase approval.
5. §4 says "Kipurse does not limit the limits users set" — no conflict with the setup network-fee caps (20/day, $2/day, $0.25 per transaction, setup network fee only), but worth explaining.
6. New "Pause AI payments": one switch stops every AI (including Siri), top-ups and withdrawals keep working — suggest adding to §4.
7. §15 dispute resolution, §12 liability cap, §16 Apple terms are all marked "for attorney" and need a lawyer.
8. Traditional Chinese: not offered (owner rule). Suggest publishing the English version as authoritative plus a Simplified Chinese reference translation, stating that English prevails.

## Next steps (owner)
2. Attorney review of both drafts.
3. Publish kipurse.com/terms and update /privacy (website changes need owner approval).
