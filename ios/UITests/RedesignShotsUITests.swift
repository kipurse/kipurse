import XCTest

/// Redesign before/after screenshots ("rd-<lang>-<name>"). Screenshots only; never fails on a missing screen.
final class RedesignShotsUITests: XCTestCase {
  var app: XCUIApplication!
  @MainActor func shot(_ n: String) { sleep(1); let a = XCTAttachment(screenshot: app.screenshot()); a.name = "rd-" + n; a.lifetime = .keepAlways; add(a) }
  @MainActor func go(_ args: [String]) { app?.terminate(); app = XCUIApplication(); app.launchArguments = args; app.launch(); sleep(3) }
  @MainActor func tap(_ id: String) -> Bool { let b = app.descendants(matching: .any).matching(identifier: id).firstMatch; guard b.waitForExistence(timeout: 5) else { return false }; var i = 0; while !b.isHittable && i < 6 { app.swipeUp(); i += 1 }; b.tap(); sleep(1); return true }
  @MainActor func testRedesignShots() {
    executionTimeAllowance = 1500   // t800
    continueAfterFailure = true
    let langs = (ProcessInfo.processInfo.environment["RD_LANGS"] ?? "zh,en").split(separator: ",").map(String.init)
    for L in langs {
      let p = L + "-"
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"]); shot(p + "home"); app.swipeUp(); shot(p + "home-s1")
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID", "-kpDark"]); shot(p + "home-dark")
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpApplePayMock", "-kpCBV", "later"])
      if tap("home.deposit") { shot(p + "deposit"); if tap("deposit.applepay") { shot(p + "applepay-needs-verify") } }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpApplePayMock"]); if tap("home.deposit") { if tap("deposit.applepay") { shot(p + "applepay-verified") } }
      go(["-kpOnboard", "-kp.lang", L, "-kpIdentityOK", "-kpCBV", "later"]); shot(p + "onboard-gate"); if tap("gate.onboard") { shot(p + "cbv-guide") }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"]); if tap("home.limits") { shot(p + "limits"); app.swipeUp(); shot(p + "limits-s1") }
      go(["-demo", "main", "-tab", "settings", "-kp.lang", L, "-kpSkipFaceID"]); shot(p + "settings"); app.swipeUp(); shot(p + "settings-s1")
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kp.simpleMode", "YES"]); shot(p + "large-text-home")
      if tap("simple.tips") { shot(p + "safety-tips") }
      go(["-demo", "main", "-tab", "settings", "-kp.lang", L, "-kpSkipFaceID"]); if tap("settings.phone") { shot(p + "faceid-approvals") }
      go(["-demo", "main", "-tab", "settings", "-kp.lang", L, "-kpSkipFaceID"]); app.swipeUp(); app.swipeUp(); app.swipeUp(); shot(p + "settings-bottom")
      go(["-demo", "main", "-tab", "life", "-kp.lang", L, "-kpSkipFaceID"]); if tap("approve.open") { shot(p + "approve-sheet") }   // decision 110: 待你批准 on AI 生活
      go(["-kpIdentityOK", "-kpUnbound", "-kp.lang", L]); shot(p + "unbound-home")
      go(["-demo", "main-all", "-tab", "agents", "-kp.lang", L, "-kpSkipFaceID"]); shot(p + "agents")
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"]); if tap("home.withdraw") { shot(p + "withdraw") }
      go(["-demo", "main", "-kp.lang", L, "-kpGasGate"]); shot(p + "error-gas-gate")
      go(["-kpIdentityOK", "-kpUnbound", "-kpEmergencyOffline", "-kp.lang", L]); if tap("unbound.emergency") { shot(p + "error-offline") }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID", "-kpLight"]); shot(p + "home-light")
    }
  }
}
