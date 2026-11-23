import XCTest

/// UX audit (owner t556): a zero-crypto beginner walks every path. Screenshots only ("ux-<n>"); never fails on missing screens.
final class T927AuditUITests: XCTestCase {
  var app: XCUIApplication!
  /// Env first, then /tmp file (TEST_RUNNER_* does not reach the UI test runner).
  func t927Env(_ key: String, file: String, fallback: String) -> String {
    if let v = ProcessInfo.processInfo.environment[key], !v.isEmpty { return v }
    if let v = try? String(contentsOfFile: file, encoding: .utf8) {
      let s = v.trimmingCharacters(in: .whitespacesAndNewlines)
      if !s.isEmpty { return s }
    }
    return fallback
  }
  var t927Tag: String { t927Env("T927TAG", file: "/tmp/t927tag", fallback: "x") }
  @MainActor func shot(_ n: String) { sleep(1); let tag = t927Tag; let d = "/tmp/t927shots"; try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true); try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: d + "/" + tag + "-" + n + ".png")); let names = "state=\(app.state.rawValue)" + (app.state != .runningForeground ? " APP-LEFT" : ""); try? names.write(toFile: d + "/" + tag + "-" + n + ".txt", atomically: true, encoding: .utf8) }
  @MainActor func go(_ args: [String]) { app?.terminate(); app = XCUIApplication(); app.launchArguments = args; app.launch(); sleep(3) }
  @MainActor func tap(_ id: String) -> Bool { let b = app.descendants(matching: .any).matching(identifier: id).firstMatch; guard b.waitForExistence(timeout: 5) else { return false }; b.tap(); sleep(1); return true }
  @MainActor func tapText(_ t: String) -> Bool { let b = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", t)).firstMatch; guard b.waitForExistence(timeout: 4) else { return false }; b.tap(); sleep(1); return true }
  @MainActor func back() { let b = app.navigationBars.buttons.element(boundBy: 0); if b.exists { b.tap() } else { app.swipeDown(velocity: .fast) }; sleep(1) }
  /// Scrolls until the element is hittable (cards lower on the page were missed in the first audit).
  @MainActor func tapScroll(_ q: XCUIElement, _ max: Int = 6) -> Bool { guard q.waitForExistence(timeout: 5) else { return false }; var i = 0; while !q.isHittable && i < max { app.swipeUp(); i += 1 }; guard q.isHittable else { return false }; q.tap(); sleep(1); return true }
  @MainActor func scrollShots(_ n: String, _ k: Int = 2) { shot(n); for i in 1...k { app.swipeUp(); shot(n + "-s\(i)") } }

  @MainActor func testT927Walk() {
    executionTimeAllowance = 2400   // one-language batch; zh alone was ~1680s
    continueAfterFailure = true
    let langs = t927Env("T927LANGS", file: "/tmp/t927langs", fallback: "zh,en").split(separator: ",").map(String.init)
    for L in langs {
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
      go(["-demo", "main", "-tab", "life", "-kp.lang", L, "-kpHold"]); shot(p + "23-hold-banner")   // §6#110: holds live in 待你批准 on AI 生活
      // 8 limits, spending summary, activity
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"]); scrollShots(p + "24-home", 2)
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"])
      if tapScroll(app.descendants(matching: .any).matching(identifier: "wallet.totalLimit").firstMatch) { scrollShots(p + "25-limits", 2); back() }
      go(["-demo", "main", "-tab", "life", "-kp.lang", L, "-kpSkipFaceID"])
      if tapScroll(app.descendants(matching: .any).matching(identifier: "life.aiLimit").firstMatch) { scrollShots(p + "25b-ai-limits", 2); back() }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"])
      if tapScroll(app.descendants(matching: .any).matching(identifier: "home.allActivity").firstMatch, 8) { scrollShots(p + "26-activity", 2); back() }
      // t1150u: same demo data as the wallet frames (no -kpLifeDemo), so the life ring and「本月 AI 已花」agree
      go(["-demo", "main", "-tab", "life", "-kp.lang", L, "-kpSkipFaceID"]); if tapScroll(app.descendants(matching: .any).matching(identifier: "life.all").firstMatch, 8) { scrollShots(p + "26b-life-all", 2) }
      go(["-demo", "main", "-tab", "life", "-kp.lang", L, "-kpSkipFaceID"]); shot(p + "33-life-unnamed-payee")
      // 9 withdraw, pause, emergency, settings
      go(["-demo", "main", "-tab", "settings", "-kp.lang", L, "-kpSkipFaceID"]); scrollShots(p + "27-settings", 3)
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"]); if tapScroll(app.descendants(matching: .any).matching(identifier: "home.withdraw").firstMatch) { scrollShots(p + "28-withdraw", 1); back() }
      go(["-demo", "main", "-tab", "life", "-kp.lang", L, "-kpResumeUnbound", "-kpSkipFaceID"]); let pz = app.buttons["safety.pause"]; _ = pz.waitForExistence(timeout: 5); for _ in 0..<8 where pz.exists && !pz.isHittable { app.swipeUp() }; shot(p + "29-resume-unbound")   // §6#110: pause / resume on AI 生活
      go(["-kpIdentityOK", "-kpUnbound", "-kp.lang", L]); app.swipeUp(); if tapText(L == "zh" ? "紧急" : "mergency") { scrollShots(p + "30-emergency", 1) }
      go(["-kpIdentityOK", "-kpUnbound", "-kp.lang", L, "-kpEmergencyOffline"]); app.swipeUp(); if tap("unbound.emergency") { shot(p + "30b-emergency-offline") }
      go(["-demo", "main-nomuse", "-tab", "agents", "-kp.lang", L]); if tapText("Muse") { _ = tapText(L == "zh" ? "高级" : "Advanced"); shot(p + "15b-muse-advanced-open") }
      go(["-demo", "main", "-kp.lang", L, "-kpGasGate"]); shot(p + "31-gas-gate")
      go(["-demo", "main", "-kp.lang", L, "-kpMasked"]); shot(p + "32-balance-hidden")
      go(["-demo", "main", "-tab", "agents", "-kp.lang", L]); if tapText("Siri") { RunLoop.current.run(until: Date().addingTimeInterval(0.4)); let a = XCTAttachment(screenshot: app.screenshot()); a.name = "ux-" + p + "34-demo-note"; a.lifetime = .keepAlways; add(a) }
      // t924 extras: eye / cold start / pay / zero
      go(["-demo", "main", "-tab", "home", "-kp.lang", L]); shot(p + "40-coldstart-home")
      if tap("balance.masked") || tap("balance.amount") { shot(p + "41-after-eye-tap") }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L]); shot(p + "42-coldstart-again")
      go(["-demo", "main-new", "-tab", "home", "-kp.lang", L]); scrollShots(p + "43-zero-home-noskip", 1)
      if tap("home.withdraw") { shot(p + "44-zero-withdraw"); back() }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"]); if tapScroll(app.descendants(matching: .any).matching(identifier: "home.withdraw").firstMatch) { if tap("withdraw.all") || tapText(L == "en" ? "All" : "全部") { shot(p + "45-withdraw-all") }; if tap("withdraw.go") { shot(p + "46-withdraw-go") } }
      go(["-demo", "main", "-tab", "agents", "-kp.lang", L]); for n in ["claude", "grok", "muse", "siri"] { if tap("agent.logo." + n) { sleep(2); let st = app.state; let a = XCUIApplication(bundleIdentifier: "com.apple.springboard"); try? a.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/t927shots/" + t927Tag + "-" + p + "47-avatar-" + n + ".png")); try? "state=\(st.rawValue)".write(toFile: "/tmp/t927shots/" + t927Tag + "-" + p + "47-avatar-" + n + ".txt", atomically: true, encoding: .utf8); go(["-demo", "main", "-tab", "agents", "-kp.lang", L]) } }
      go(["-demo", "main", "-tab", "agents", "-kp.lang", L, "-kpGasSiri"]); if tap("agent.siri.connect") { scrollShots(p + "48-siri-intro", 2) }
      go(["-demo", "main", "-tab", "settings", "-kp.lang", L, "-kpSkipFaceID"]); scrollShots(p + "49-settings-full", 5)
    }
    app.terminate()
  }
  @MainActor func testT927Extras() {
    executionTimeAllowance = 1500; continueAfterFailure = true
    let langs = t927Env("T927LANGS", file: "/tmp/t927langs", fallback: "zh,en").split(separator: ",").map(String.init)
    for L in langs { let p = L + "-"
      // t924 extras: eye / cold start / pay / zero
      go(["-demo", "main", "-tab", "home", "-kp.lang", L]); shot(p + "40-coldstart-home")
      if tap("balance.masked") || tap("balance.amount") { shot(p + "41-after-eye-tap") }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L]); shot(p + "42-coldstart-again")
      go(["-demo", "main-new", "-tab", "home", "-kp.lang", L]); scrollShots(p + "43-zero-home-noskip", 1)
      if tap("home.withdraw") { shot(p + "44-zero-withdraw"); back() }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpSkipFaceID"]); if tapScroll(app.descendants(matching: .any).matching(identifier: "home.withdraw").firstMatch) { if tap("withdraw.all") || tapText(L == "en" ? "All" : "全部") { shot(p + "45-withdraw-all") }; if tap("withdraw.go") { shot(p + "46-withdraw-go") } }
      go(["-demo", "main", "-tab", "agents", "-kp.lang", L]); for n in ["claude", "grok", "muse", "siri"] { if tap("agent.logo." + n) { sleep(2); let st = app.state; let a = XCUIApplication(bundleIdentifier: "com.apple.springboard"); try? a.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/t927shots/" + t927Tag + "-" + p + "47-avatar-" + n + ".png")); try? "state=\(st.rawValue)".write(toFile: "/tmp/t927shots/" + t927Tag + "-" + p + "47-avatar-" + n + ".txt", atomically: true, encoding: .utf8); go(["-demo", "main", "-tab", "agents", "-kp.lang", L]) } }
      go(["-demo", "main", "-tab", "agents", "-kp.lang", L, "-kpGasSiri"]); if tap("agent.siri.connect") { scrollShots(p + "48-siri-intro", 2) }
      go(["-demo", "main", "-tab", "settings", "-kp.lang", L, "-kpSkipFaceID"]); scrollShots(p + "49-settings-full", 5)
    }
  }
}
