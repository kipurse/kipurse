# Kipurse iOS (native shell)

- `Sources/KipurseCore` (Swift package, Foundation only, tested on Linux): answer/limit rules (port of `src/v5/answer-rules.mjs`), owner API client
  (`/login` one-time code -> `kp` cookie, `/api/csrf`, `/api/*`), loose JSON state model, approval diffing, owner-link parsing.
- `App/Sources` (SwiftUI, iOS 16+): onboarding (QR / paste / `kipurse://login?server=…&code=…`), wizard with preset buttons + 自己填
  (`.decimalPad` / `.numberPad`), deposit QR, 待批准 list, limits, withdraw, connect-AI, pause, settings.
- Session: `kp` cookie + CSRF in the Keychain (`AfterFirstUnlockThisDeviceOnly`, not synced). Logout deletes it.
- App lock: LocalAuthentication (`deviceOwnerAuthentication`: Face ID, passcode fallback) on launch/return and before every owner action
  (approve trust / loosen limits / withdraw / set limits / create agent link / open signing). Pause stays one tap (emergency).
- Notifications: foreground poll every 5 s + `BGAppRefreshTask` (best effort, iOS decides timing) -> local notification per NEW approval.
- Signing (Base Account / keys.coinbase.com): NOT a WKWebView. The SDK opens keys.coinbase.com with `window.open` and talks back to the
  opener with `postMessage`, so the kit page itself must run in a Safari engine view that supports popups. The app asks the server for a
  fresh single-use web login (`POST /api/webLink`, 120 s) and opens it in:
  1. `SFSafariViewController` (default),
  2. `ASWebAuthenticationSession` (callback scheme `kipurse`), or
  3. external Safari.
  The page returns with `kipurse://done?step=prepared|signed|exit` (kit `app.js` `back()` when opened with `?return=kipurse`).
  Answers from the native wizard are passed as `?answers=<base64url>`; the page still shows the disclosure and the two consent boxes.
