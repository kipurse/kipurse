# Virtual card issuing partnership plan (t971 #6) — 2026-11-04
Goal: let an AI pay card-only merchants from the owner's self-custodied USDC, without pooled custody and without Kipurse collecting email/phone.

## Hard conflict to decide first
Every regulated card program requires cardholder KYC with name, DOB, residential address and (Bridge/Stripe) a phone number. Sources: Bridge cards KYC docs (phone_number validation, 24h re-confirm), Rain onboarding (KYC/KYB approved before issuing), Lithic (KYC via Lithic, BYO or EXEMPT only for pre-approved programs).
Fit with our "never collect email/phone" rule: only possible if **the issuer's hosted KYC page collects it and Kipurse never stores or sees it** (Bridge/Persona hosted link, Rain hosted). Kipurse stores only the issuer customer/cardholder id. Owner must approve this interpretation.
Also: a card balance is held by the issuer (prepaid / collateral), i.e. leaves self-custody at top-up time. Design: just-in-time funding — the AI's USDC payment (within on-chain caps) funds exactly one card authorization; nothing pooled by Kipurse.

## Options
| Option | Model | Stablecoin funding | KYC | Our requirements | Cost (to verify in sales call) | Timeline | Fit |
|---|---|---|---|---|---|---|---|
| Bridge + Stripe Issuing | consumer virtual Visa, stablecoin-backed | yes, native (Bridge) | Bridge hosted Persona link, 24h freshness | Stripe account in good standing, US entity (Blessbridge LLC), program approval per region | Stripe Issuing per-card + per-auth fees; Bridge fees | 6–12 weeks incl. program review | Best API fit; US-first regions |
| Rain | crypto card issuing program (Visa), collateral in USDC on chain | yes, on-chain collateral | Rain KYC/KYB applications | KYB of our company, program agreement | setup + per-card + interchange share | 8–12 weeks | Strong on-chain fit; good for Base |
| Lithic (stablecoin pilot) | prepaid financial account funded by stablecoin deposit addresses (Base supported) | yes, pilot | Lithic KYC or BYO/EXEMPT if pre-approved | program manager approval, bank sponsor | platform fee + per-card | 8–16 weeks, pilot access | Flexible, but pilot status |
| Crossmint / Coinbase card options | agent-card APIs on top of an issuer | via their wallets | their KYC + email | partner agreement; tends to require their wallet/email | revenue share | 4–8 weeks | Weak: pushes email + their custody |

## Recommendation
1. Apply to **Bridge (Stripe Issuing)** and **Rain** in parallel (company KYB as Blessbridge Global Trading LLC). No spend needed to apply.
2. Build behind a feature flag: `server/src/v5/cards.mjs` already has a card-rail interface with a mock provider — add `bridge-stripe` and `rain` providers; one per-purchase card, amount-locked, merchant-locked, single-use, funded JIT from the AI's capped USDC payment.
3. App: one place only ("AI card payments" inside the existing AI payment limits); KYC opens the issuer's hosted page; Kipurse stores no PII.
4. Fees: issuer costs passed through in USDC from wallet at actual cost, shown in the receipt before Face ID (no new Kipurse fee — fee changes are owner decisions).

## Owner decisions needed
- Accept issuer-hosted KYC (issuer collects phone/address, Kipurse never stores it)?
- Which entity applies; who signs program agreements; any setup fee.

---
# Decision update (t972, 2026-11-04) — owner approved issuer-hosted KYC, Kipurse stores nothing
## Recommendation: Stripe Issuing + Bridge stablecoin-backed cards (backup: Rain)
Why (sources read 2026-11-04):
- **Lowest published cost:** Stripe Issuing virtual card $0.10 each (US/UK/EU), dispute $15, cross-border 1% + $0.30 (+1% FX) — docs.stripe.com/issuing/choose-cards; Lithic Starter also ~$0.10 but stablecoin is pilot and US/Canada only; Rain pricing is contract-only (not published).
- **Widest acceptance/coverage:** Visa acceptance worldwide; stablecoin cards for cardholders in 60+ countries (US, LatAm, Caribbean, Africa, Asia) — docs.stripe.com/issuing/stablecoin-cards; Bridge blog 2026-04-29 (30 countries, 100+ planned by end of 2026).
- **Keeps self-custody:** "Non-custodial wallet" funding source — Bridge pulls funds from the user's own wallet at authorization (no pooled Kipurse balance). Matches our no-pooled-custody rule.
- **KYC fits the rule:** Bridge hosted KYC link (Persona) with `?endorsement=cards`; Kipurse stores only the Bridge customer id + Stripe cardholder id. Note: endorsement must be re-confirmed if no card is created within 24 h.
- Built-in disputes/chargebacks on card payments (Stripe Issuing disputes) — also closes our "no chargeback protection" gap for card spend.
To verify on the sales call: Base + USDC support for non-custodial funding (chain list), consumer-program availability for our cardholders' countries, Bridge fees on top of Stripe's, monthly minimums.

Backup: **Rain** — Visa Principal Member, 150M+ merchants, Rain-managed per-user smart contract collateral (self-custody), ~6-week launch; pricing by contract.

## Signup steps (company: Blessbridge Global Trading LLC)
1. Stripe: use existing or new Stripe account for the company → Dashboard → Issuing → "Stablecoin-backed cards" → contact sales (public preview access). Needs: company KYB (EIN, registered address, beneficial owners), website (kipurse.com), program description (consumer prepaid/debit virtual cards for AI-agent purchases, self-custodial USDC funding, issuer-hosted KYC).
2. Bridge: bridge.xyz → "Get started" developer account → sandbox API keys → request cards endorsement for production with the Stripe account linked.
3. Compliance pack to send: docs/compliance/MONEY_TRANSMISSION.md, PRIVACY_TERMS_REVIEW.md, this plan, fee table (docs/fees/FEES.md).
4. Sandbox build (no money): add `bridge-stripe` provider to server/src/v5/cards.mjs (single-use, amount- and merchant-locked virtual card, JIT funding from the AI's capped USDC), test in Bridge sandbox + Stripe test mode.
5. Owner decisions at signing: contract terms, any minimums; card costs passed through in USDC from the wallet at actual cost (no new Kipurse fee).
Owner action needed: the Stripe/Bridge signups are company accounts (new accounts) — I prepare everything, owner does the account creation and KYB.
