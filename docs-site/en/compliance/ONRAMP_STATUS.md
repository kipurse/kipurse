# Coinbase Onramp application status (updated 2026-11-03)

## Owner rule
Kipurse **never collects or verifies** users' email or phone numbers. Apple Pay purchases go only through the **Coinbase-hosted Onramp page**, where Coinbase itself handles email, phone and payment. **We do not apply for Headless Onramp** (it requires the app to collect and OTP-verify email and phone, plus integration fees).

## Status
- On 2026-10-27 the owner approved applying for CDP Onramp as Blessbridge Global Trading LLC, on the condition that it costs nothing; if any payment is required, stop and ask the owner.
- The in-app "Apple Pay top-up" button exists and shows "Applied"; a Coinbase Verified attestation is required before buying.
- Coinbase has not approved yet; no record of an application number or submission date was found (unverified).
- Official channel: CDP Onramp onboarding form https://support.cdp.coinbase.com/onramp-onboarding (requires a CDP login). There is no public email.

## ⚠️ Key risk
Coinbase docs state: **Guest Checkout on the hosted Onramp page (debit card, Apple Pay, no Coinbase account) was retired on 2026-06-30**, and Coinbase recommends Headless instead. The hosted page now supports "payment methods after signing in to a Coinbase account", labeled with no developer fees.
→ Whether Apple Pay works on the hosted page depends on whether Coinbase offers Apple Pay inside the Coinbase account; that is exactly the question for Coinbase in the application. Our users must already have a KYC-verified Coinbase account, so "sign in to Coinbase, then buy" fits our rules.

## Next steps
1. The owner signs in to CDP and submits the form above (text in the report / this directory's README).
2. Publish kipurse.com/terms (applications usually need terms and privacy policy links).
3. If Coinbase replies that it charges fees or offers only Headless → stop and let the owner decide.
