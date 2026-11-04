# App Store 3.1.5 + Apple Pay checklist

> Based on our reading of the App Store Review Guidelines (3.1.1, 3.1.5, 5.1, 5.3, etc.), not an official answer from Apple. The owner should re-check against the latest guidelines before submitting.

## 3.1.5 Cryptocurrencies
| Clause | Requirement | Kipurse | Status |
|---|---|---|---|
| 3.1.5(i) Wallets | Wallet apps must be submitted by an **organization** (not individual) developer account | Blessbridge Global Trading LLC organization account | ✅ |
| 3.1.5(ii) Mining | No on-device mining | No mining | ✅ |
| 3.1.5(iii) Exchanges | Crypto trading must go through a licensed exchange and be offered by the licensed party | We do not sell crypto; Apple Pay purchases are provided by Coinbase Onramp (licensed) | ✅ (depends on Coinbase approving the application) |
| 3.1.5(iv) ICO | No ICOs | None | ✅ |
| 3.1.5(v) | No crypto rewards for tasks (downloads, posts, etc.) | No rewards | ✅ |
| 3.1.1 IAP | Unlocking digital content/features must use IAP | The 0.1% service fee is a payment fee, not unlocking digital content — **needs confirmation** that Apple does not treat it as IAP | ⚠️ Unverified |
| 5.1.1 Privacy | Privacy policy link in the app and in App Store Connect; accurate privacy nutrition label | Settings has "Privacy Policy"; label must be checked against the policy | ⚠️ Label not checked item by item |
| 5.1.1(v) Account deletion | Account can be deleted in the app | Settings → Danger zone → Delete | ✅ |
| 5.3 / Regions | Financial services must comply with the law in each launch region | Needs legal opinion (see MONEY_TRANSMISSION.md); recommend US only at first | ⚠️ |
| Terms of Service | Financial apps should provide an EULA/terms | "Terms of Service" added under Settings → Help (single entry point); **kipurse.com/terms is not published yet** (currently opens the home page) | ❌ Publish the terms page first |
| 2.1 Completeness | Reviewers can complete the core flows | Needs demo account / demo mode instructions (Review Notes) | ⚠️ |

## Apple Pay (via Coinbase Onramp)
| Item | Requirement | Status |
|---|---|---|
| Provider | Only the Coinbase-hosted Onramp page; Kipurse never touches card data and does not collect email or phone | ✅ Design |
| Coinbase approval | Production hosted Onramp access requires Coinbase review; Guest Checkout on the hosted page was retired on 2026-06-30; whether Apple Pay is available inside a Coinbase account is pending Coinbase's confirmation | ❌ Applied |
| KYC gate | Coinbase Verified attestation required before buying (owner rule, fail closed) | ✅ Implemented in code |
| Terms shown | Show Coinbase Guest Checkout Terms + Privacy links | ✅ (ApplePayBuy.swift) |
| Arrival | Show "Received" only after the server confirms the money reached the wallet | ✅ Design; not verified on device |
| Not yet enabled | Button shows "Applied", nothing is charged | ✅ |
| Apple Pay branding | Use the official Apple Pay button style / mark | ⚠️ Not checked against Apple Pay Marketing Guidelines |
| Merchant ID | If done inside Coinbase's web page, Kipurse does not need its own Apple Pay merchant ID — to confirm with Coinbase | ⚠️ |
