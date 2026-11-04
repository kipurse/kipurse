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
3. App: one place only ("AI 刷卡" inside the existing AI payment limits); KYC opens the issuer's hosted page; Kipurse stores no PII.
4. Fees: issuer costs passed through in USDC from wallet at actual cost, shown in the receipt before Face ID (no new Kipurse fee — fee changes are owner decisions).

## Owner decisions needed
- Accept issuer-hosted KYC (issuer collects phone/address, Kipurse never stores it)?
- Which entity applies; who signs program agreements; any setup fee.
