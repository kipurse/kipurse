# Money-transmission analysis (FinCEN + Texas)

> **NOT LEGAL ADVICE.** Informational summary to prepare a lawyer consultation. The facts below describe the product as built on 2026-11-03.

## 1. Product facts the analysis depends on
- **Non-custodial:** each user has their own smart wallet (owned by Coinbase Smart Wallet / Base Account). Kipurse has no pooled funds and never holds user USDC or private keys.
- **Server powers:** the server holds an executor/session key and can only pay within the SpendPermission limits the user signed on-chain, following the user's rules; it cannot add new payees (requires phone Face ID signature), change limits, or block withdrawals.
- **Withdraw:** only back to the user's own Coinbase wallet; works through the open-source page even if the server is down.
- **Fees:** 0.1% service fee per payment (USDC, deducted from the user's wallet balance); network cost at actual cost, deducted from the wallet balance. New-wallet setup has a fixed 0.05 USDC network fee ("setup fee"), also deducted from the wallet balance.
- **Funding:** only from the user's own Coinbase Wallet / Base Account; Apple Pay purchases are completed by Coinbase Onramp (Coinbase is a licensed MSB).
- **Identity:** relies only on the Coinbase Verified Account on-chain attestation; Kipurse does no KYC itself.
- **Company:** Blessbridge Global Trading LLC (Houston, Texas).

## 2. FinCEN (federal)
- 2019 FinCEN Guidance (FIN-2019-G001) §4.2: a **non-custodial wallet software provider** (does not hold or control user funds) is generally **not** a money transmitter. The key test is "independent control of value".
- Risk points (need counsel's judgment):
  1. The server executor key can **actively** start payments within limits — is that "total independent control" over funds? Our argument: limits and payee scope are bounded by the user's on-chain signature, and the user can revoke / pause / withdraw at any time, so it is not independent control.
  2. The 0.1% fee is taken from payments — does that make Kipurse part of an "accepting and transmitting" chain?
  3. The setup network fee arises at wallet creation and is then deducted from the wallet balance — is that "transmitting value for others" or credit?
  4. The fee address is Kipurse's operating account: it collects our own fee, not transfers on behalf of customers (to confirm).
- If deemed an MSB: FinCEN registration (Form 107), AML program, SAR/CTR, OFAC compliance.

## 3. Texas (state)
- Texas Finance Code Chapter 152 (Money Services Businesses), as amended in 2023, explicitly includes "virtual currency" in "money or monetary value" (HB 1666 / 2023), supervised by the Texas Department of Banking.
- Texas DoB Supervisory Memorandum 1037 (virtual currency): non-custodial software that does not receive user funds generally needs no license; "receiving funds with a promise to transmit" does.
- USDC is a stablecoin → likely treated as "money or monetary value" in Texas.
- Counsel to confirm: whether Kipurse's executor payments count as "receiving" users' monetary value.

## 4. Other states
- Users are not only in Texas: New York BitLicense and California DFAL (licensing requirements effective July 2026) may define "control" more broadly. Recommend a 50-state matrix from counsel or limiting launch states.

## 5. Questions for counsel
1. Under FIN-2019-G001, does a server key that can actively pay within user-signed limits make us a money transmitter? If so, what architecture change avoids it (e.g. a user signature for every payment)?
2. Does deducting the 0.1% service fee from payments have regulatory implications? Would charging it separately be better?
3. Does a setup network fee that arises first and is then deducted from the wallet balance count as lending or money transmission?
4. Texas Ch. 152 + SM 1037: do we need a Texas MSB license? Should we request a written no-action / confirmation from the Texas DoB?
5. California DFAL, New York BitLicense: do we need licenses, or should we not open to these states for now?
6. Is relying only on the Coinbase Verified attestation, without our own KYC, sufficient (especially if deemed an MSB)?
7. Is OFAC screening (address lists + Chainalysis on-chain oracle) sufficient? Do we need a written sanctions compliance policy?
8. Are the App Store publisher (Blessbridge Global Trading LLC) and the Terms' liability limits and arbitration clause enforceable?
9. Do the open-source licenses (Apache-2.0 + AGPL-3.0) affect liability?
10. Legally, who authorizes a payment made by the user's AI agent within limits? How should the Terms say it?

## 6. Status
- Legal opinion: **missing**. No written legal opinion exists.
- Recommendation: obtain at least written FinCEN + Texas opinions before launch.
