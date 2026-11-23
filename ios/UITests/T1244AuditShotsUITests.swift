import XCTest

/// §6#114 (t1244) read-only UI audit: screenshots of every main screen (zh + en, dark default), demo data only.
/// A tool, not a gate: never fails on a missing screen. Attachments are named "<lang>-<screen>".
final class T1244AuditShotsUITests: XCTestCase {
  var app: XCUIApplication!
  var L = "zh"
  @MainActor func shot(_ n: String) { sleep(1); let a = XCTAttachment(screenshot: app.screenshot()); a.name = L + "-" + n; a.lifetime = .keepAlways; add(a) }
  @MainActor func go(_ demo: String?, _ tab: String? = nil, _ extra: [String] = []) {
    app?.terminate(); app = XCUIApplication()
    var a = ["-kp.lang", L, "-kpSkipFaceID", "-AppleLanguages", L == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", L == "zh" ? "zh_CN" : "en_US"]
    if let d = demo { a += ["-demo", d] }; if let t = tab { a += ["-tab", t] }
    app.launchArguments = a + extra; app.launch(); sleep(3)
  }
  @MainActor func el(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
  @MainActor func tap(_ id: String, scroll: Int = 8) -> Bool {
    let b = el(id); guard b.waitForExistence(timeout: 6) else { return false }
    var i = 0; while !b.isHittable && i < scroll { app.swipeUp(); i += 1 }
    guard b.isHittable else { return false }; b.tap(); sleep(2); return true
  }
  @MainActor func tapLabel(_ t: String) -> Bool {
    let b = app.buttons.matching(NSPredicate(format: "label == %@", t)).firstMatch; guard b.waitForExistence(timeout: 4) else { return false }
    var i = 0; while !b.isHittable && i < 6 { app.swipeUp(); i += 1 }; b.tap(); sleep(1); return true
  }
  @MainActor func scrollShots(_ n: String, _ k: Int) { shot(n); for i in 1...k { app.swipeUp(); shot(n + "-s\(i)") } }
  @MainActor func filters(_ prefix: String) {
    let names = L == "zh" ? ["入金", "支付", "提现", "全部"] : ["Deposits", "Payments", "Withdrawals", "All"]
    let keys = ["deposit", "payment", "withdraw", "all"]
    for (n, k) in zip(names, keys) {
      let seg = el("ledger.filter"); guard seg.waitForExistence(timeout: 4) else { return }
      let b = seg.buttons[n]; if b.exists { var i = 0; while !b.isHittable && i < 6 { app.swipeUp(); i += 1 }; b.tap(); sleep(1); shot(prefix + "-" + k) }
    }
  }

  @MainActor func walk() {
    continueAfterFailure = true
    // AI 生活
    go("main", "life"); scrollShots("life", 3)
    go("main", "life", ["-kpLifeDemo"]); scrollShots("life-rich", 3)
    go("main-new", "life"); scrollShots("life-empty", 2)
    go("main-connect", "life"); shot("life-connect-request")
    go("main", "life", ["-kpHold"]); shot("life-hold")
    // AI 智能体 + one AI detail
    go("main", "life"); if tap("life.manage") { scrollShots("agents", 2) }
    go("main-all", "agents", ["-kpSiriOn"]); scrollShots("agents-all", 1)
    if tap("agent.grok-bot") { scrollShots("agent-detail", 2) }
    // connect-an-AI first screen (an unconnected AI)
    go("main", "agents"); if tap("agent.claude") { scrollShots("connect-ai", 1) }
    go("main-connect", nil, ["-kpConnectClaude"]); shot("connect-claude")
    go("main", nil, ["-openURL", "kipurse://approve-connect?id=demoGrokBotReq01"]); shot("connect-approve")
    // AI 花钱上限 / 信任的商家 / 暂停
    go("main", "life"); if tap("life.aiLimit") { scrollShots("ai-limit", 3) }
    go("main", "life"); if tap("life.trusted") { scrollShots("trusted", 1) }
    go("main", "life"); if tap("safety.pause") { shot("pause-dialog") }
    go("main", "life", ["-kpResumeUnbound"]); let pz = el("safety.pause"); _ = pz.waitForExistence(timeout: 5); for _ in 0..<8 where pz.exists && !pz.isHittable { app.swipeUp() }; shot("paused")
    if pz.exists && pz.isHittable { pz.tap(); sleep(1); shot("resume-dialog") }
    // AllowancesSheet (normal + owner ask)
    go("main", "life", ["-kpStill"]); if tap("allow.card.pending") { scrollShots("allowances", 2) }
    go("main", "life", ["-kpStill", "-kpAskDemo"]); shot("life-ask"); if tap("allow.card.pending") { scrollShots("allowances-ask", 1) }
    go("main", "life"); if tap("approve.open") { scrollShots("approve-payee", 1) }
    // TxDetail receipt
    go("main", "life", ["-kpLifeDemo"]); if tap("life.tx.0") { scrollShots("txdetail", 1) }
    go("main", "life"); if tap("life.tx.0") { shot("txdetail-plain") }
    // 钱包
    go("main", "home"); scrollShots("wallet", 2)
    go("main", "home"); filters("wallet-filter")
    go("main", "home"); if tap("home.allActivity") { shot("activity"); filters("activity"); app.swipeUp(); shot("activity-s1") }
    go("main", "home", ["-kpApplePayMock"]); if tap("home.deposit") { scrollShots("deposit", 1) }
    go("main", "home"); if tap("home.withdraw") { scrollShots("withdraw", 1) }
    go("main", "home"); if tap("wallet.totalLimit") { scrollShots("wallet-limit", 2) }
    go("main-zero", "home"); scrollShots("zero-home", 1)
    go("main-new", "home"); scrollShots("new-home", 1)
    // 设置
    go("main", "settings"); scrollShots("settings", 4)
    go("main", "settings"); if tap("settings.usageGuide") { scrollShots("usage-guide", 3) }
    go("main", "settings"); if tap("settings.lostPhone") { scrollShots("lost-phone", 2) }
    go("main", "settings"); if tap("settings.tips") { scrollShots("tips", 2) }
    go("main", "settings"); if tap("settings.phone") { scrollShots("faceid-approve", 1) }
    // onboarding / welcome
    go(nil, nil, ["-kpFreshInstall"]); scrollShots("signin", 1)
    go(nil, nil, ["-kpFreshInstall", "-kpWelcome", "-kpWelcomeHold"]); shot("welcome")
    go(nil, nil, ["-kpFreshInstall", "-kpOnboard", "-kpSigninMock", "new"]); shot("onboard-new")
    app.terminate()
  }
  @MainActor func testZh() { executionTimeAllowance = 3000; L = "zh"; walk() }
  @MainActor func testEn() { executionTimeAllowance = 3000; L = "en"; walk() }
}
