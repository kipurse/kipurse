# App Store / TestFlight kit (M9)

## Identity (decided)
| Item | Value |
|---|---|
| Team | **Blessbridge Global Trading LLC — YOUR_TEAM_ID** (paid) |
| App (Release) | `com.blessbridge.kipurse.app` |
| Widget (Release) | `com.blessbridge.kipurse.app.widget` |
| Test build (Debug, on the iPhone now) | `com.blessbridge.kipurse.app.test` (+ `.widget`) |
| App Group | `group.com.blessbridge.kipurse` |
| Capabilities | Push Notifications, App Groups, Associated? (no), Face ID usage, Camera usage, Background fetch + remote notifications, Live Activities |
`com.kipurse.*` is not available to this team (registered elsewhere), so all IDs use `com.blessbridge.kipurse`. The display name stays **Kipurse**.

## Files in the repo
- `App/Resources/PrivacyInfo.xcprivacy` — no tracking. Data collected by the developer (all **linked to the user**, purpose **App Functionality** only, not used for tracking): **User ID** (wallet + owner address, phone public key, connected-agent IDs), **Purchase History** (payments made through Kipurse), **Other Financial Info** (limits, trusted payees, fees). UserDefaults reasons CA92.1/1C8F.1.
- App Store Connect "App Privacy" answers must match the manifest exactly: Data Used to Track You = none; Data Linked to You = User ID, Purchase History, Other Financial Info (App Functionality). Do **not** answer "Data Not Collected". Privacy policy URL must describe the same three types (see the 2026-10-27 draft).
- `ITSAppUsesNonExemptEncryption = NO` (only HTTPS + Apple CryptoKit; exempt) → no export-compliance question per build.
- `AppStore/archive.sh` + `ExportOptions-AppStore.plist` → Release archive + IPA on the Mac. **Never uploads by itself.**
- `AppStore/metadata/` — listing text (en-US, zh-Hans) and review notes. Privacy answers: see the PrivacyInfo line above.

## Owner-only steps (in order, ~30 min total)
1. **App Store Connect** (appstoreconnect.apple.com, sign in with the Blessbridge Apple ID) → Apps → "+" → New App:
   platform iOS, name **Kipurse** (if taken: "Kipurse Wallet"), primary language English (U.S.), bundle ID `com.blessbridge.kipurse.app`,
   SKU `kipurse-ios-001`, full access.
2. **Agreements, Tax, Banking**: accept the Free Apps agreement (Paid not needed; the app is free).
3. Tell us "go upload" → we run `AppStore/archive.sh` on the Mac and you click **Distribute App → Upload** in Xcode Organizer
   (or approve us doing it). First build lands in TestFlight in ~15–30 min.
4. **TestFlight → Internal testing**: add yourself (and up to 100 team members) — no review needed.
   External testers (public link) need a short Beta App Review (~1 day).
5. **App Privacy** questionnaire (multi-user server, 2026-10-23): **Data collected, linked to the user, not used for tracking, purpose App Functionality only**: Identifiers → User ID (wallet address, phone public key, agent/OAuth ids); Purchases → Purchase History (payment records/labels); Financial Info → Other Financial Info (spend limits, balances read from chain). No contact info, location, health, browsing, diagnostics or advertising data. All of it is deletable in-app (Settings → Delete my data) and matches PrivacyInfo.xcprivacy.
6. **Before public release** (later): screenshots (6.9" and 6.5"), support URL, privacy policy URL (`https://kipurse.com/privacy`),
   age rating 18+ (owner decision t614u 2026-10-27: adults only, no child/family accounts; Financial: yes, Gambling none), category Finance. In App Store Connect choose the 18+ rating.

## App Review risk notes (prepared answers in `metadata/review-notes.md`)
- Crypto wallet apps are allowed (guideline 3.1.5(b) / 3.1.5(c)): Kipurse is a **non-custodial** wallet; the app does not sell crypto
  itself; purchases go through Coinbase (licensed). Organization account required — ✅ (Blessbridge LLC).
- Provide a **demo mode** for review: the app's built-in demo (Settings → Demo) shows a full wallet without a server.
- Test mode (Base Sepolia) builds must not be submitted for public release; Release config sets `KipurseTestMode = NO`.

## Review notes: identity (t624u, 2026-10-27)
- Kipurse has no email, no password and does no KYC of its own. It collects no identity data.
- To open a NEW wallet, the user's Base Account must carry Coinbase's public on-chain "Coinbase Verified Account" attestation (EAS on Base, schema 0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9, attester 0x357458739F90461b99789350868CD7CF330Dd7EE). The server reads it (read-only, free). Users without it get a guided 4-step flow that links only to official Coinbase pages (coinbase.com/signup, Coinbase identity help, coinbase.com/onchain-verify).
- Existing wallets are not gated: withdraw, pause and stop always work.
- App Privacy labels: unchanged (no identity data collected; the attestation is a public on-chain fact read by address).
- Reviewer demo account: the reviewer's Base Account needs the attestation, or use the demo mode described above.
