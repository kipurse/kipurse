import XCTest

/// UX audit (owner t556): a zero-crypto beginner walks every path. Screenshots only ("ux-<n>"); never fails on missing screens.
final class BeginnerAuditUITests: XCTestCase {
  var app: XCUIApplication!
  @MainActor func shot(_ n: String) { sleep(1); let a = XCTAttachment(screenshot: app.screenshot()); a.name = "ux-" + n; a.lifetime = .keepAlways; add(a) }
  @MainActor func go(_ args: [String]) { app?.terminate(); app = XCUIApplication(); app.launchArguments = args; app.launch(); sleep(3) }
  @MainActor func tap(_ id: String) -> Bool { let b = app.descendants(matching: .any).matching(identifier: id).firstMatch; guard b.waitForExistence(timeout: 5) else { return false }; b.tap(); sleep(1); return true }
  @MainActor func tapText(_ t: String) -> Bool { let b = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", t)).firstMatch; guard b.waitForExistence(timeout: 4) else { return false }; b.tap(); sleep(1); return true }
  @MainActor func back() { let b = app.navigationBars.buttons.element(boundBy: 0); if b.exists { b.tap() } else { app.swipeDown(velocity: .fast) }; sleep(1) }
  /// Scrolls until the element is hittable (cards lower on the page were missed in the first audit).
  @MainActor func tapScroll(_ q: XCUIElement, _ max: Int = 6) -> Bool { guard q.waitForExistence(timeout: 5) else { return false }; var i = 0; while !q.isHittable && i < max { app.swipeUp(); i += 1 }; guard q.isHittable else { return false }; q.tap(); sleep(1); return true }
  @MainActor func scrollShots(_ n: String, _ k: Int = 2) { shot(n); for i in 1...k { app.swipeUp(); shot(n + "-s\(i)") } }

  @MainActor func testBeginnerWalkthrough() {
    executionTimeAllowance = 1500   // t800: long walkthrough (zh + en)
    continueAfterFailure = true
    for L in ["zh", "en"] {
      let p = L + "-"
      // 1 fresh install / sign-in / wallet creation
      go(["-kpFreshInstall", "-kp.lang", L]); scrollShots(p + "01-first-open", 1)
      go(["-kpFreshInstall", "-kp.lang", L, "-kpOnboard", "-kpSigninMock", "new"]); shot(p + "02-signin-new")
      for c in app.buttons.allElementsBoundByIndex.prefix(1) { if c.isHittable { c.tap(); sleep(2); shot(p + "03-after-first-button") } }
      go(["-kpFreshInstall", "-kp.lang", L, "-kpOnboard", "-kpSigninMock", "bind"]); shot(p + "04-signin-existing-bind")
      // 2 empty wallet, first-use guide, funding
      go(["-demo", "main-new", "-kp.lang", L, "-kpSkipFaceID"]); scrollShots(p + "05-new-wallet-guide", 2)
      // t691: two-page layout opens on 「AI 生活」; wallet actions live on the 「钱包」 page (-tab home)
      go(["-demo", "main-new", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID", "-kpApplePayMock", "-kpCBV", "later"])
      if tapScroll(app.descendants(matching: .any).matching(identifier: "home.deposit").firstMatch) { scrollShots(p + "06-deposit", 2); back() }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpArrive"]); shot(p + "07-deposit-arrived")
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpStray", "USDT:3.5,ETH:0.002"]); shot(p + "08-wrong-token")
      // 3 phone binding
      go(["-kpIdentityOK", "-kpUnbound", "-kp.lang", L]); scrollShots(p + "09-unbound-home", 1)
      go(["-demo", "main", "-tab", "settings", "-kp.lang", L, "-kpSkipFaceID"]); if tap("settings.phone") { scrollShots(p + "10-this-phone", 1) }
      // 4 connect AI
      go(["-demo", "main", "-tab", "agents", "-kp.lang", L]); scrollShots(p + "11-agents-tab", 2)
      go(["-demo", "main-connect", "-kp.lang", L, "-kpConnectClaude"]); shot(p + "12-connect-claude")
      go(["-demo", "main", "-kp.lang", L, "-openURL", "kipurse://approve-connect?id=demoGrokBotReq01"]); shot(p + "13-approve-connect-grok")
      go(["-demo", "main", "-tab", "agents", "-kp.lang", L]); if tapText("Siri") { scrollShots(p + "14-siri", 1); back() }
      go(["-demo", "main-nomuse", "-tab", "agents", "-kp.lang", L]); if tapText("Muse") { scrollShots(p + "15-muse-not-connected", 1) }
      // 5 connected agent buy page / allowances / stop
      // connected card -> buy page (main-all: every card connected; the first audit tapped the unconnected Claude)
      go(["-demo", "main-all", "-tab", "agents", "-kp.lang", L, "-kpSiriOn"])
      if tapScroll(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'agent.' AND NOT (identifier BEGINSWITH 'agent.siri')")).firstMatch) { scrollShots(p + "16-agent-buy-page", 2) }
      go(["-demo", "main-all", "-tab", "agents", "-kp.lang", L, "-kpSiriOn"]); scrollShots(p + "17-agents-all-connected", 1)
      // 6 first purchase new merchant (approval), repeat, owner pay
      go(["-demo", "main", "-tab", "home", "-kp.lang", L]); shot(p + "18-home-with-approval-badge")
      if tap("home.approvals") || tapText(L == "zh" ? "待批准" : "pproval") { scrollShots(p + "19-approval-sheet", 1); back() }
      go(["-demo", "main", "-kp.lang", L, "-kpPayDraft", "-kpOwnerPayMock", "-kpOwnerPayNewPayee"]); scrollShots(p + "20-pay-new-payee", 1)
      go(["-demo", "main", "-kp.lang", L, "-kpPayDraft", "-kpOwnerPayMock"]); shot(p + "21-pay-known-payee")
      go(["-demo", "main", "-kp.lang", L, "-kpPayDraft"]); shot(p + "22-siri-pay-confirm")
      // 7 large payment delay / hold
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpHold"]); shot(p + "23-hold-banner")
      // 8 limits, spending summary, activity
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"]); scrollShots(p + "24-home", 2)
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"])
      if tapScroll(app.descendants(matching: .any).matching(identifier: "home.limits").firstMatch) { scrollShots(p + "25-limits", 2); back() }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"])
      if tapScroll(app.descendants(matching: .any).matching(identifier: "home.allActivity").firstMatch, 8) { scrollShots(p + "26-activity", 2); back() }
      go(["-demo", "main", "-tab", "life", "-kp.lang", L, "-kpSkipFaceID", "-kpLifeDemo"]); if tapScroll(app.descendants(matching: .any).matching(identifier: "life.all").firstMatch, 8) { scrollShots(p + "26b-life-all", 2) }
      go(["-demo", "main", "-tab", "life", "-kp.lang", L, "-kpSkipFaceID"]); shot(p + "33-life-unnamed-payee")
      // 9 withdraw, pause, emergency, settings
      go(["-demo", "main", "-tab", "settings", "-kp.lang", L, "-kpSkipFaceID"]); scrollShots(p + "27-settings", 3)
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"]); if tapScroll(app.descendants(matching: .any).matching(identifier: "home.withdraw").firstMatch) { scrollShots(p + "28-withdraw", 1); back() }
      go(["-demo", "main", "-tab", "settings", "-kp.lang", L, "-kpResumeUnbound", "-kpSkipFaceID"]); shot(p + "29-resume-unbound")
      go(["-kpIdentityOK", "-kpUnbound", "-kp.lang", L]); app.swipeUp(); if tapText(L == "zh" ? "紧急" : "mergency") { scrollShots(p + "30-emergency", 1) }
      go(["-kpIdentityOK", "-kpUnbound", "-kp.lang", L, "-kpEmergencyOffline"]); app.swipeUp(); if tap("unbound.emergency") { shot(p + "30b-emergency-offline") }
      go(["-demo", "main-nomuse", "-tab", "agents", "-kp.lang", L]); if tapText("Muse") { _ = tapText(L == "zh" ? "高级" : "Advanced"); shot(p + "15b-muse-advanced-open") }
      go(["-demo", "main", "-kp.lang", L, "-kpGasGate"]); shot(p + "31-gas-gate")
      go(["-demo", "main", "-kp.lang", L, "-kpMasked"]); shot(p + "32-balance-hidden")
      go(["-demo", "main", "-tab", "agents", "-kp.lang", L]); if tapText("Siri") { RunLoop.current.run(until: Date().addingTimeInterval(0.4)); let a = XCTAttachment(screenshot: app.screenshot()); a.name = "ux-" + p + "34-demo-note"; a.lifetime = .keepAlways; add(a) }
      if L == "en" { break }
    }
    app.terminate()
  }
}
