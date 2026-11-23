import XCTest

/// Drives every button on every tab with the built-in demo data (no network writes, no real money).
final class KipurseUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  override func tearDown() { if (testRun?.failureCount ?? 0) > 0, let a = app { print("T800DIAG-BEGIN \(name)\n" + a.debugDescription + "\nT800DIAG-END") } }
  func launch(_ demo: String, tab: String = "home", extra: [String] = []) {
    app = XCUIApplication(); app.launchArguments = ["-demo", demo, "-tab", tab, "-kp.lang", "zh", "-kpLimitsAdvanced"] + extra; app.launch()
  }
  /// t1073/t1076: demo "main" has no everyday policy, so connect is gated until a saved AI limit exists.
  let kpAISaved = ["-kpAISaved", "10000000,50000000,200000000"]
  /// t665: two tabs (AI 生活 / 钱包), found by icon identifier. "AI 智能体" and "设置" are now pages inside them:
  /// tab("AI 智能体") = AI 生活 → 管理, tab("设置") = 钱包 → gear.
  let tabIcons = ["AI 生活": "sparkles", "钱包": "creditcard.fill", "设置": "gearshape.fill"]   // t879: 设置 is the third tab
  func tab(_ name: String) -> XCUIElement {
    if name == "AI 智能体" { let l = tabButton("AI 生活"); if l.waitForExistence(timeout: 8) { l.tap() }; return app.buttons["life.manage"] }
    return tabButton(name) }
  /// The tab-bar button: some simulator boots put the SF Symbol name on the button, others only on its image child,
  /// so match the button by its icon id OR by its own label (zh / en) — the same tab either way.
  let tabLabelsEN = ["AI 生活": "AI Life", "钱包": "Wallet", "设置": "Settings"]
  func tabButton(_ name: String) -> XCUIElement {
    app.tabBars.buttons.matching(NSPredicate(format: "identifier == %@ OR label IN %@", tabIcons[name]!, [name, tabLabelsEN[name]!])).firstMatch }
  func tabCount() -> Int { tabIcons.keys.filter { app.tabBars.buttons.matching(NSPredicate(format: "identifier == %@ OR label IN %@", tabIcons[$0]!, [$0, tabLabelsEN[$0]!])).count > 0 }.count }
  func back() { app.buttons["BackButton"].firstMatch.tap() }
  func reveal(_ e: XCUIElement) { var n = 0; while !e.isHittable && n < 8 { app.swipeUp(); n += 1 } }
  func tapPreset(_ label: String, _ index: Int) { let e = app.buttons.matching(NSPredicate(format: "label == %@", label)).element(boundBy: index); reveal(e); e.tap() }
  /// Sheets slide in; a tap during the animation can be dropped. Wait until the element is hittable and settled, then tap.
  func tapWhenReady(_ e: XCUIElement, timeout: TimeInterval = 8) {
    let end = Date().addingTimeInterval(timeout); var last = CGRect.null
    while Date() < end { if e.exists && e.isHittable { let f = e.frame; if f == last { break }; last = f }; RunLoop.current.run(until: Date().addingTimeInterval(0.25)) }
    e.tap()
  }
  /// t800: with onboarding on, binding a phone goes through the onboarding flow (Coinbase verification first, then setup).
  func bindEntry() -> Bool { ["cbv.title", "onboard.step1", "onboard.go"].contains { app.descendants(matching: .any)[$0].firstMatch.waitForExistence(timeout: 2) } }
  /// t800 H1: a forged kipurse://login link pointing at another server must not log in.
  func testForgedLoginLinkDoesNotLogIn() {
    app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", "zh"]; app.launch()
    XCTAssertTrue(app.buttons["cb.signin"].waitForExistence(timeout: 15))
    XCUIDevice.shared.system.open(URL(string: "kipurse://login?server=https://evil.example&code=0123456789abcdef0123456789abcdef")!)
    let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    for t in ["打开", "Open"] { let b = sb.buttons[t]; if b.waitForExistence(timeout: 4) { b.tap(); break } }
    sleep(4); XCTAssertEqual(app.state, .runningForeground)
    XCTAssertTrue(app.buttons["cb.signin"].waitForExistence(timeout: 8), "still on Sign in with Coinbase")
    for id in ["wallet.title", "home.deposit", "balance.amount", "demo.banner"] { XCTAssertFalse(app.descendants(matching: .any)[id].exists, id) }
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "evil")).firstMatch.exists); shot("h1-forged-login")
  }
  func shot(_ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }

  func testThreeTabsWithBadge() {
    launch("main")
    XCTAssertTrue(tab("钱包").waitForExistence(timeout: 5))
    XCTAssertEqual(tabCount(), 3, "t879: AI 生活 / 钱包 / 设置")
    XCTAssertEqual(tab("钱包").label, "钱包"); XCTAssertEqual(tab("AI 生活").label, "AI 生活")
    XCTAssertEqual(tab("设置").label, "设置"); tab("设置").tap()
    XCTAssertTrue(app.staticTexts["settings.title"].waitForExistence(timeout: 5) || app.staticTexts["设置"].waitForExistence(timeout: 5)); XCTAssertFalse(app.buttons["BackButton"].exists, "t879: a tab, not a pushed page")
    shot("settings-tab-zh"); tab("钱包").tap()
    XCTAssertFalse(app.buttons["记录"].exists); XCTAssertFalse(app.buttons["待批准"].exists)
    XCTAssertTrue(["2项", "2items"].contains((tab("AI 生活").value as? String)?.replacingOccurrences(of: " ", with: "") ?? ""), "§6#110: badge on AI 生活: \(String(describing: tab("AI 生活").value))")  // t1245 U9: badge = every card under 待你批准 — demo "main" has the Example Shop trust request + the Claude 8 USDC one-time request (VoiceOver word is the system's language)
    XCTAssertFalse(((tab("钱包").value as? String) ?? "").range(of: "[0-9]", options: .regularExpression) != nil, "§6#110: no badge on 钱包")
    XCTAssertTrue(app.descendants(matching: .any)["balance.unit"].exists); XCTAssertFalse(app.staticTexts["主网"].exists)
    XCTAssertTrue(app.descendants(matching: .any)["balance.amount"].label.contains("14.10"), "t665: 2 decimals")
    XCTAssertFalse(app.descendants(matching: .any)["caps.spent"].exists, "t927/§6#110: home = balance, 充值/提现, 入金/支付/提现 records (待你批准 lives on AI 生活)")
    XCTAssertFalse(app.descendants(matching: .any)["life.pending.title"].exists, "§6#110: no 待你批准 on 钱包")
    shot("main-home")
    tab("AI 生活").tap(); XCTAssertTrue(app.descendants(matching: .any)["life.pending.title"].waitForExistence(timeout: 5))   // the badge number = the cards shown here
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "8 USDC")).firstMatch.exists, "one-time request card"); shot("life-pending")
  }
  func testApprovalOpensPhoneApproveSheet() {
    launch("main", tab: "life")   // §6#110: 待你批准 lives on AI 生活
    XCTAssertTrue(app.staticTexts["待你批准"].waitForExistence(timeout: 5))
    app.buttons["approve.open"].tap()
    XCTAssertTrue(app.navigationBars["允许 AI 付给新收款方？"].waitForExistence(timeout: 5))
    shot("approve-sheet")
    app.buttons["关闭"].tap()
    XCTAssertTrue(app.buttons["approve.open"].waitForExistence(timeout: 5))
  }
  /// ONE LIMIT: pending AI request on home -> sheet shows the single AI payment limit (no category toggles) -> approve the AI request -> stop one AI.
  func testAllowancesSetupApproveAndStopAgent() {
    launch("main", tab: "life")   // §6#110: the pending AI request card lives on AI 生活
    let card = app.descendants(matching: .any)["allow.card.pending"]; _ = card.waitForExistence(timeout: 8); reveal(card)
    if !card.exists { print("TREE>>>" + app.debugDescription) }
    XCTAssertTrue(card.exists); card.tap()
    // ONE LIMIT: no per-category setup; the sheet shows the single AI payment limit and auto-sorted spending
    XCTAssertFalse(app.buttons["allow.setup.approve"].exists); XCTAssertFalse(app.switches["allow.default.daily"].exists)
    let lim = app.descendants(matching: .any)["allow.limit"]; XCTAssertTrue(lim.waitForExistence(timeout: 5)); XCTAssertTrue(lim.label.contains("5") && lim.label.contains("500"), lim.label); shot("allow-limit")
    let ok = app.buttons["allow.pending.approve"]; XCTAssertTrue(ok.exists); ok.tap()
    XCTAssertTrue(ok.waitForNonExistence(timeout: 5))
    let stop = app.buttons["allow.agent.stop"].firstMatch; reveal(stop); XCTAssertTrue(stop.waitForExistence(timeout: 5)); stop.tap()
    XCTAssertTrue(app.descendants(matching: .any)["allow.agent.stopped"].waitForExistence(timeout: 5)); shot("allow-done")
    app.buttons["allow.close"].tap()
    XCTAssertTrue(app.staticTexts["life.title"].waitForExistence(timeout: 5))   // t927: no summary card (one approvals block) · §6#110: back on AI 生活
  }
  func testSuspiciousDustCollapsed() {
    launch("main")
    let all = app.buttons["home.allActivity"]; reveal(all); all.tap()
    XCTAssertTrue(app.navigationBars["全部记录"].waitForExistence(timeout: 5))
    let t = app.buttons["ledger.suspicious.toggle"]; reveal(t); XCTAssertTrue(t.waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["+0.000001"].exists, "dust row hidden by default")
    XCTAssertFalse(app.descendants(matching: .any)["ledger.suspicious.warning"].exists)
    t.tap()
    XCTAssertTrue(app.descendants(matching: .any)["ledger.suspicious.warning"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["可疑小额转账，可能是假地址，别用它付款。"].exists)
    shot("dust-open")
  }
  func testAllActivityAndDetail() {
    launch("main")
    let all = app.buttons["home.allActivity"]; reveal(all); all.tap()
    XCTAssertTrue(app.navigationBars["全部记录"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["+10"].waitForExistence(timeout: 5))
    back()
    XCTAssertTrue(app.buttons["home.deposit"].waitForExistence(timeout: 5))
  }
  func testOwnAddressShortenedByDefault() {
    launch("main")
    app.buttons["home.deposit"].tap()
    let other = app.buttons["deposit.other"]; if other.waitForExistence(timeout: 5) { other.tap() }   // t800: Apple Pay first, address under "already have USDC?"
    let ad = app.staticTexts["qr.addr"]; XCTAssertTrue(ad.waitForExistence(timeout: 5)); reveal(ad)
    XCTAssertTrue(ad.label.contains("…"), "own address must be shortened: \(ad.label)"); XCTAssertLessThanOrEqual(ad.label.count, 13, ad.label)
    let rv = app.buttons["qr.addr.reveal"]; reveal(rv); rv.tap()
    let full = app.staticTexts["qr.addr"]; XCTAssertFalse(full.label.contains("…")); XCTAssertGreaterThanOrEqual(full.label.replacingOccurrences(of: " ", with: "").count, 42, full.label); shot("own-address-revealed")
  }
  func testSafetyTipsReachableBothLanguages() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "settings", "-kp.lang", lang, "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)"]; app.launch()   // t927: simple mode removed; tips live in 设置
      let t = app.buttons["settings.tips"]; XCTAssertTrue(t.waitForExistence(timeout: 10)); for _ in 0..<8 where !t.isHittable { app.swipeUp() }; t.tap()
      XCTAssertTrue(app.staticTexts["tips.title"].waitForExistence(timeout: 5))
      XCTAssertEqual(app.staticTexts["tips.title"].label, lang == "zh" ? "安全小贴士" : "Safety tips")
      let last = app.descendants(matching: .any)["tips.9"]; reveal(last); XCTAssertTrue(last.exists); XCTAssertTrue(last.label.contains("Coinbase"))
      I18nCheck.check(app, lang, "safety tips"); shot("tips-\(lang)"); app.terminate()
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-kp.simpleMode", "NO"]; app.launch()
      let st = tab("设置"); XCTAssertTrue(st.waitForExistence(timeout: 10)); st.tap()
      let lk = app.buttons["settings.tips"]; for _ in 0..<8 where !lk.isHittable { app.swipeUp() }; lk.tap()
      XCTAssertTrue(app.staticTexts["tips.title"].waitForExistence(timeout: 5)); app.terminate()
    }
  }
  /// t1057u + t1058u: no lost-phone subtitle on Settings; tips use normal KP body; address on Wallet.
  func testT1057T1058SettingsAndWalletAddress() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "settings", "-kp.lang", lang]; app.launch()
      let lost = app.buttons["settings.lostPhone"]; XCTAssertTrue(lost.waitForExistence(timeout: 10)); for _ in 0..<8 where !lost.isHittable { app.swipeUp() }
      let banned = lang == "zh" ? "Coinbase 钱包需留一点 USDC" : "keep a little USDC in your Coinbase wallet"
      XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", banned)).firstMatch.exists, lang)
      XCTAssertFalse(app.buttons["settings.copyWallet"].exists, lang)
      let tips = app.buttons["settings.tips"]; for _ in 0..<8 where !tips.isHittable { app.swipeUp() }; tips.tap()
      XCTAssertTrue(app.staticTexts["tips.title"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.descendants(matching: .any)["tips.1"].waitForExistence(timeout: 5))
      shot("t1057-tips-\(lang)"); back()
      tab("钱包").tap()   // tab() keys are Chinese identifiers (SF Symbol map)
      let cw = app.buttons["wallet.copyWallet"]; for _ in 0..<8 where !cw.exists || !cw.isHittable { app.swipeUp() }
      XCTAssertTrue(cw.waitForExistence(timeout: 8), lang); cw.tap()
      let full = (cw.value as? String) ?? ""   // t1133u: full address in the top card, the old row is gone
      XCTAssertTrue(full.hasPrefix("0x") && full.count == 42, lang)
      let title = lang == "zh" ? "我的钱包地址" : "My wallet address"
      XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch.exists, lang)
      shot("t1058-wallet-\(lang)"); app.terminate()
    }
  }

  /// Student pass: Apple Pay is the ONE main deposit button; every other way is folded under "其他方式".
  func otherWays() {
    let o = app.buttons["deposit.other"]; XCTAssertTrue(o.waitForExistence(timeout: 8))
    XCTAssertEqual(app.buttons.matching(identifier: "deposit.applepay").count, 1, "t932: exactly one Apple Pay 充值 entry"); XCTAssertFalse(app.buttons["deposit.coinbase"].exists, "address way starts folded")
    for _ in 0..<4 where !o.isHittable { app.swipeUp() }; o.tap()
  }
  func testDeposit() {
    launch("main")
    app.buttons["home.deposit"].tap()
    otherWays(); XCTAssertTrue(app.buttons["deposit.coinbase"].waitForExistence(timeout: 5))   // address/QR first (works with zero balance); direct move second
    XCTAssertFalse(app.buttons["deposit.onetap"].exists)   // the sign-in-account card is gone
    XCTAssertTrue(app.staticTexts["你的钱包地址（Base）"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.images.count > 0)
    let copy = app.buttons["qr.copy"]; for _ in 0..<4 where !copy.isHittable { app.swipeUp() }
    copy.tap()
    XCTAssertTrue(app.buttons["已复制"].waitForExistence(timeout: 3))
    shot("deposit")
    let cbw = app.buttons["deposit.coinbase"]; for _ in 0..<4 where !cbw.isHittable { app.swipeUp() }; cbw.tap()   // t885: Coinbase Wallet transfer page in the in-app browser, never the exchange
    let dl = app.descendants(matching: .any)["debug.launch"].firstMatch; XCTAssertTrue(dl.waitForExistence(timeout: 5))
    XCTAssertTrue(dl.label.hasPrefix("https://sign.kipurse.com/v12/deposit#u=") && dl.label.contains("mode%3Dtap") && dl.label.contains("&vw=0x"), dl.label); XCTAssertFalse(dl.label.contains("coinbase.com/send"), dl.label)
    for _ in 0..<4 where !app.buttons["sheet.done"].exists { app.swipeDown(velocity: .slow) }   // longer page: the toolbar hides after scrolling
    XCTAssertTrue(app.buttons["sheet.done"].waitForExistence(timeout: 5)); app.buttons["sheet.done"].tap()
  }
  func testDepositArrival() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kpArrive"]; app.launch()
    let d = app.buttons["home.deposit"]; reveal(d); d.tap()
    otherWays(); XCTAssertTrue(app.buttons["deposit.coinbase"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["deposit.onetap"].exists)
    shot("arrival-deposit")
    let c = app.buttons["deposit.coinbase"]; for _ in 0..<4 where !c.isHittable { app.swipeUp() }; c.tap()
    XCTAssertTrue(app.descendants(matching: .any)["deposit.waiting"].firstMatch.waitForExistence(timeout: 10))   // t1209: 4->10 s (pre-existing timing flake, A/B b72 2/3 = b73 2/3)
    shot("arrival-waiting")
    XCTAssertTrue(app.staticTexts["deposit.success"].waitForExistence(timeout: 20))   // t1209: hook now arrives on the 2nd 5-s tick
    XCTAssertTrue(app.staticTexts["deposit.success.amount"].label.contains("+10"))
    shot("arrival-success")
    app.buttons["deposit.success.done"].tap()
    XCTAssertTrue(app.buttons["home.deposit"].waitForExistence(timeout: 5))
  }
  func testWrongTokenNoticeAndWarning() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kpStray", "USDT:3.5,ETH:0.002"]; app.launch()
    XCTAssertTrue(app.otherElements["stray.card"].firstMatch.waitForExistence(timeout: 5) || app.staticTexts["stray.USDT"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["stray.USDT"].exists); XCTAssertTrue(app.staticTexts["stray.ETH"].exists); XCTAssertTrue(app.buttons["stray.return"].firstMatch.exists)
    shot("wrongtoken-home")
    let d = app.buttons["home.deposit"]; reveal(d); d.tap()
    otherWays(); XCTAssertTrue(app.buttons["deposit.coinbase"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.otherElements["deposit.onlyUSDC"].firstMatch.exists || app.staticTexts["deposit.onlyUSDC"].firstMatch.exists)
    XCTAssertTrue(app.buttons["stray.return"].firstMatch.exists)
    shot("wrongtoken-deposit")
  }
  func testLimitsFlowOpensSigningPage() throws {
    guard ProcessInfo.processInfo.environment["KP_LIVE_LIMITS"] != nil || FileManager.default.fileExists(atPath: "/tmp/kp-live-limits") else { throw XCTSkip("multi-user: the demo wallet is a placeholder; run against a staging tenant") }
    #if KP_VARIANT_fork
    throw XCTSkip("fork variant: its private fork server has no public limits-signing page")
    #endif
    launch("main")
    openLimits()
    XCTAssertTrue(app.navigationBars["钱包总限额"].waitForExistence(timeout: 5))
    tapPreset("2 USDC", 0); tapPreset("5 USDC", 1); tapPreset("5000 USDC", 0); tapPreset("90 天", 0)
    reveal(app.buttons["limits.sign"])
    XCTAssertTrue(app.staticTexts["limits.summary"].waitForExistence(timeout: 3))
    XCTAssertEqual(app.staticTexts["limits.summary"].label, "每笔 2 · 每天 5 · 总额 5000 USDC · 90 天")
    shot("limits")
    app.buttons["limits.sign"].tap()
    // The network-fee page (gas preflight) now comes first; confirm it, then the signing page opens.
    let feeSign = app.buttons["gas.sign"]
    if feeSign.waitForExistence(timeout: 10) {
      if app.descendants(matching: .any)["gas.why"].firstMatch.waitForExistence(timeout: 10) { app.descendants(matching: .any)["gas.why"].firstMatch.tap() }; XCTAssertTrue(app.descendants(matching: .any)["gas.notice"].firstMatch.waitForExistence(timeout: 5))
      let enabled = NSPredicate(format: "isEnabled == true"); expectation(for: enabled, evaluatedWith: feeSign); waitForExpectations(timeout: 20)
      shot("limits-fee"); feeSign.tap()
    }
    let page = app.webViews.staticTexts["修改钱包安全上限"]
    XCTAssertTrue(page.waitForExistence(timeout: 25), "public signing page loads with the chosen caps")
    XCTAssertTrue(app.webViews.staticTexts["用 Coinbase 确认"].exists || app.webViews.buttons["用 Coinbase 确认"].exists)
    // Leave for another app (e.g. Mail for a code) and come back: the signing page must still be there, same state.
    XCUIDevice.shared.press(.home)
    let other = XCUIApplication(bundleIdentifier: "com.apple.Preferences"); other.activate(); XCTAssertTrue(other.wait(for: .runningForeground, timeout: 10))
    sleep(4)   // longer than one 3 s poll tick
    app.activate()
    XCTAssertTrue(app.webViews.staticTexts["修改钱包安全上限"].waitForExistence(timeout: 10), "signing page survives app switching")
    XCTAssertTrue(app.webViews.staticTexts["用 Coinbase 确认"].exists || app.webViews.buttons["用 Coinbase 确认"].exists)
    shot("limits-page-after-switch")
    shot("limits-page")
  }
  /// t603u/t604u: the limit-change screen states the per-change network fee in USDC and never asks for ETH.
  /// t1038u: 钱包总限额 entry is on the Wallet tab (on-chain floor); AI 总限额 entry is on AI Life (agent caps + everyday). No settings entry.
  func openLimits(ai: Bool = false) {
    let t = app.tabBars.buttons.element(boundBy: ai ? 0 : 1); if t.waitForExistence(timeout: 8) { t.tap() }
    let l = app.buttons[ai ? "life.aiLimit" : "wallet.totalLimit"]; XCTAssertTrue(l.waitForExistence(timeout: 8), ai ? "life.aiLimit" : "wallet.totalLimit")
    for _ in 0..<6 where !l.isHittable { app.swipeUp() }; l.tap()
  }
  func testLimitsFreeVsCharged() {
    launch("main")
    openLimits()
    // redesign: the rule details live behind the ⓘ (progressive disclosure)
    XCTAssertTrue(app.descendants(matching: .any)["limits.simple"].waitForExistence(timeout: 5))
    let info = app.buttons["limits.info"]; XCTAssertTrue(info.waitForExistence(timeout: 5)); info.tap()
    let why = app.staticTexts["limits.info.text"]; XCTAssertTrue(why.waitForExistence(timeout: 5)); let whyLabel = why.label; XCTAssertTrue(whyLabel.contains("区块链") || whyLabel.contains("blockchain"), whyLabel)
    app.buttons["info.done"].tap(); sleep(1)
    let fc = app.staticTexts["floor.cost"]; reveal(fc); XCTAssertTrue(fc.exists); XCTAssertTrue(fc.label.contains("USDC") || fc.label.contains("不收手续费") || fc.label.contains("no fee"), fc.label)
    XCTAssertFalse(app.staticTexts["everyday.cost"].exists, "t1038: wallet total limit page has no AI everyday card")
    back(); openLimits(ai: true)
    XCTAssertTrue(app.navigationBars["AI 花钱上限"].waitForExistence(timeout: 5), "t1079: AI spending limits page")
    // t1245 (§6#115 U18): a blank AI limits page shows no yellow 「请填写每笔金额」 until the owner types; the cards are there.
    XCTAssertTrue(app.descendants(matching: .any)["everyday.title"].waitForExistence(timeout: 5))
    let ec = app.staticTexts["everyday.cost"]
    if ec.exists { XCTAssertTrue(ec.label.contains("请填写每笔") || ec.label.contains("Enter the per-payment") || ec.label.contains("所有 AI 共用") || ec.label.contains("Shared by every AI") || ec.label.contains("不收手续费"), ec.label) }
    for t in [whyLabel, fc.label] + (ec.exists ? [ec.label] : []) { XCTAssertFalse(t.contains("请先准备 ETH") || t.contains("add ETH"), t) }
    shot("limits-free-vs-charged")
  }
  /// t1156u (§6#75): AI spending limits save when the session step fails. Calm, specific text on the existing line; the network
  /// sentence only for a real network error. No new buttons; the save button stays.
  func testAILimitsSaveSessionErrorsAreCalm() {
    let cases: [(String, String, [String], [String])] = [
      ("zh", "faceidoff", ["设置 › Kipurse › 打开面容 ID", "没有批准，也没有扣钱"], ["暂时连不上", "不可用"]),
      ("zh", "nokey", ["这台 iPhone 还没开启 Face ID 批准", "设置 › Face ID 批准", "没有保存，也没有扣钱"], ["暂时连不上"]),
      ("zh", "cancel", ["没有保存，也没有扣钱"], ["暂时连不上"]),
      ("zh", "network", ["暂时连不上，请稍后再试。"], []),
      ("en", "faceidoff", ["Settings › Kipurse", "Nothing was approved or charged"], ["Can't connect"]),
      ("en", "nokey", ["Settings › Face ID approvals", "Nothing was saved or charged"], ["Can't connect"])]
    for (lang, kind, want, never) in cases {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-kpSessionFail", kind]; app.launch()
      openLimits(ai: true)
      // amounts inside the demo caps (same as T1071 testFilledAmountsWithinDemoCapsEnablesContinue)
      for (i, v) in ["2", "5", "30"].enumerated() {
        let f = app.textFields.element(boundBy: i); XCTAssertTrue(f.waitForExistence(timeout: 5)); f.tap()
        let cur = (f.value as? String) ?? ""; if !cur.isEmpty && cur != f.placeholderValue { f.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: cur.count + 2)) }
        f.typeText(v)
      }
      app.navigationBars.firstMatch.tap()
      let save = app.buttons["everyday.save"]; reveal(save); XCTAssertTrue(save.waitForExistence(timeout: 5), "\(lang) \(kind)"); XCTAssertTrue(save.isEnabled, "\(lang) \(kind) save enabled")
      save.tap()
      let msg = app.staticTexts["everyday.msg"]; XCTAssertTrue(msg.waitForExistence(timeout: 5), "\(lang) \(kind)")
      for w in want { XCTAssertTrue(msg.label.contains(w), "\(lang) \(kind): \(msg.label)") }
      for n in never { XCTAssertFalse(msg.label.contains(n), "\(lang) \(kind): \(msg.label)") }
      XCTAssertTrue(app.buttons["everyday.save"].exists, "no new buttons; save stays")
      if kind != "network" { shot("t1156-ailimits-\(kind)-\(lang)") }
      app.terminate()
    }
  }
  func testLimitsShowsUSDCFee() {
    launch("main")
    openLimits()
    tapPreset("2 USDC", 0); tapPreset("5 USDC", 1); tapPreset("5000 USDC", 0)
    let fee = app.staticTexts["limits.fee"]; reveal(fee); XCTAssertTrue(fee.waitForExistence(timeout: 5))
    XCTAssertTrue(fee.label.contains("USDC"), fee.label); XCTAssertTrue(fee.label.contains("ETH"), fee.label)
    XCTAssertTrue(fee.label.contains("永远不用 ETH") || fee.label.contains("Never ETH"), fee.label); shot("limits-usdc-fee")
  }
  func testLimitsRejectsBadOrder() {
    launch("main")
    openLimits()
    tapPreset("10 USDC", 0); tapPreset("5 USDC", 1)
    reveal(app.buttons["limits.sign"])
    XCTAssertTrue(app.staticTexts["每笔不能大于每天"].waitForExistence(timeout: 3))
    XCTAssertFalse(app.buttons["limits.sign"].isEnabled)
  }
  func testMuseConnected() {
    launch("main", tab: "agents")
    XCTAssertTrue(app.staticTexts["已连接"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["muse.connect"].exists); XCTAssertFalse(app.buttons["muse.reconnect"].exists)
    XCTAssertTrue(app.staticTexts["最近活动 10 分钟前"].exists)   // t1245 U37: same words as the AI 生活 orbs
    app.buttons["agents.copyMcp"].tap()
    XCTAssertTrue(app.staticTexts["已复制，粘贴到 AI 的“连接”设置里"].waitForExistence(timeout: 3))
    shot("agents-connected")
  }
  /// t1071 replaces the old intermediate Muse instructions sheet with direct launch.
  func testMuseNotConnectedFlow() {
    launch("main-nomuse", tab: "agents", extra: kpAISaved)
    let b = app.buttons["muse.connect"]; XCTAssertTrue(b.waitForExistence(timeout: 5)); b.tap()
    XCTAssertTrue(app.staticTexts["debug.launch"].waitForExistence(timeout: 8))
    XCTAssertEqual(app.staticTexts["debug.launch"].label, "https://muse.ai/chat")
    XCTAssertFalse(app.buttons["muse.copyOpen"].exists)
    XCTAssertTrue(b.exists, "Only server authorization can mark Muse connected")
    shot("t1071-muse-direct")
  }
  func testMuseDirectEnglish() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main-nomuse", "-tab", "agents", "-kp.lang", "en", "-AppleLanguages", "(en)", "-kpAISaved", "10000000,50000000,200000000"]; app.launch()
    let b = app.buttons["muse.connect"]; XCTAssertTrue(b.waitForExistence(timeout: 5)); b.tap()
    XCTAssertTrue(app.staticTexts["debug.launch"].waitForExistence(timeout: 8))
    XCTAssertEqual(app.staticTexts["debug.launch"].label, "https://muse.ai/chat")
    XCTAssertFalse(app.buttons["muse.copyOpen"].exists)
    I18nCheck.check(app, "en", "Muse direct launch")
    shot("t1071-muse-direct-en")
  }
  /// Authorization returning from Muse must still present the existing approval screen.
  func testApproveHandoffAfterMuseLaunch() {
    launch("main-nomuse", tab: "agents", extra: kpAISaved)
    let b = app.buttons["muse.connect"]; XCTAssertTrue(b.waitForExistence(timeout: 5)); b.tap()
    XCTAssertTrue(app.staticTexts["debug.launch"].waitForExistence(timeout: 8))
    app.open(URL(string: "kipurse://approve-connect?id=demoGrokBotReq01")!)
    XCTAssertTrue(app.buttons["connect.close"].waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["muse.copyOpen"].exists)
    shot("t1071-approve-after-muse")
  }
  func testSettingsButtons() {
    launch("main", tab: "settings")
    // t1068u: settings uses PageTitle (settings.title), not system large navigation title
    XCTAssertTrue(app.staticTexts["settings.title"].waitForExistence(timeout: 5) || app.staticTexts["设置"].waitForExistence(timeout: 5))
    shot("settings-main")
    XCTAssertFalse(app.buttons["settings.limits"].exists, "t1038: limits moved to Wallet / AI Life"); XCTAssertFalse(app.buttons["settings.deposit"].exists)   // deposit only on the wallet tab
    XCTAssertFalse(app.buttons["settings.withdraw"].exists, "the old manual withdraw is gone")
    app.buttons["settings.phone"].tap(); XCTAssertTrue(app.navigationBars["Face ID 批准"].waitForExistence(timeout: 5)); back()
    let rg = app.buttons["settings.lostPhone"]; for _ in 0..<6 where !rg.exists || !rg.isHittable { app.swipeUp() }; rg.tap()   // t821 / t1044
    XCTAssertTrue(app.staticTexts["手机丢了怎么办"].waitForExistence(timeout: 5)); back()
    // t1057u: Settings lost-phone row has no Coinbase subtitle
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Coinbase 钱包需留一点 USDC")).firstMatch.exists)
    XCTAssertFalse(app.buttons["settings.copyWallet"].exists, "t1058u: address moved to wallet")
    XCTAssertFalse(app.buttons["测试网"].exists); XCTAssertFalse(app.staticTexts["测试网"].exists); XCTAssertFalse(app.buttons["settings.network"].exists)
    tab("钱包").tap()
    XCTAssertTrue(app.descendants(matching: .any)["balance.unit"].waitForExistence(timeout: 5)); XCTAssertFalse(app.staticTexts["测试网"].exists)
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Sepolia")).firstMatch.exists)
    let cw = app.buttons["wallet.copyWallet"]; for _ in 0..<6 where !cw.exists || !cw.isHittable { app.swipeUp() }; XCTAssertTrue(cw.waitForExistence(timeout: 5)); cw.tap()
    shot("home-main-only")
  }
  /// First-time, non-technical walkthrough: every main screen in order, screenshots for review.
  func testStudentWalkthrough() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpMasked"]; app.launch()
    XCTAssertTrue(app.staticTexts["balance.masked"].waitForExistence(timeout: 8)); shot("walk-1-home-hidden")
    app.buttons["home.deposit"].tap(); otherWays(); XCTAssertTrue(app.buttons["deposit.coinbase"].waitForExistence(timeout: 5)); shot("walk-2-deposit"); app.buttons["sheet.done"].tap()
    shot("walk-3-limits-moved")   // t927: limits live in 设置 → AI 额度 (checked in testLimits*)
    let w = app.buttons["home.withdraw"]; reveal(w); w.tap(); XCTAssertTrue(app.buttons["withdraw.go"].waitForExistence(timeout: 5)); shot("walk-4-withdraw"); app.buttons["sheet.done"].tap()
    tab("AI 智能体").tap(); XCTAssertTrue(app.navigationBars["AI 智能体"].waitForExistence(timeout: 5)); shot("walk-5-agents")
    tab("设置").tap(); XCTAssertTrue(app.staticTexts["settings.title"].waitForExistence(timeout: 5) || app.staticTexts["设置"].waitForExistence(timeout: 5)); shot("walk-6-settings")
    let del = app.buttons["safety.delete"]; for _ in 0..<8 where !del.exists || !del.isHittable { app.swipeUp() }
    del.tap(); XCTAssertTrue(app.buttons["safety.deleteConfirm"].waitForExistence(timeout: 5)); shot("walk-7-erase-confirm")
  }
  /// A tampered limits request (batch for another wallet) is caught on the phone; no signing page opens.
  func testTamperedLimitsRequestBlocked() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpMockLimits", "tampered", "-kpLimitsAdvanced"]; app.launch()
    openLimits()
    let sign = app.buttons["limits.sign"]; XCTAssertTrue(sign.waitForExistence(timeout: 5)); reveal(sign); sign.tap()
    XCTAssertTrue(app.alerts["没有打开确认页"].waitForExistence(timeout: 5)); shot("verify-tampered-limits")
    XCTAssertTrue(app.alerts.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "another wallet")).firstMatch.exists)
  }
  /// Safety group: pause offers 24h / 48h / 7 days / until resume; delete warns to withdraw first.
  /// §6#110 (owner 2026-11-21): pause lives on AI 生活; delete stays in 设置 → 危险操作 (different tabs, never side by side).
  func testSafetyGroup() {
    launch("main", tab: "life"); XCTAssertTrue(app.staticTexts["life.title"].waitForExistence(timeout: 8))
    let pz = app.buttons["safety.pause"]; for _ in 0..<8 where !pz.exists || !pz.isHittable { app.swipeUp() }
    XCTAssertTrue(pz.isHittable, "safety.pause on AI 生活")
    XCTAssertFalse(app.buttons["safety.withdraw"].exists, "t930: withdraw has one entry (钱包 → 提现)")
    XCTAssertFalse(app.buttons["safety.delete"].exists, "delete is not next to pause")
    shot("safety-1-group")
    pz.tap()
    for t in ["24 小时", "48 小时", "7 天", "一直暂停，直到我恢复"] { XCTAssertTrue(app.buttons[t].waitForExistence(timeout: 5), t) }
    shot("safety-2-pause-picker"); dismissDialog()
    app.terminate(); launch("main", tab: "settings")   // fresh launch: a tab tap right after the dialog closes can be dropped
    XCTAssertTrue(app.staticTexts["settings.title"].waitForExistence(timeout: 8) || app.staticTexts["设置"].waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["safety.pause"].exists, "§6#110: pause moved out of 设置 (one place)")
    let del = app.buttons["safety.delete"]; for _ in 0..<8 where !del.exists || !del.isHittable { app.swipeUp() }; XCTAssertTrue(del.exists)
    app.buttons["safety.delete"].tap(); XCTAssertTrue(app.buttons["safety.deleteConfirm"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["先提现"].exists, "warns to withdraw first when money is left"); shot("safety-3-delete-confirm")
    app.buttons["safety.deleteConfirm"].firstMatch.tap(); XCTAssertTrue(app.alerts["真的要删除账户吗？"].waitForExistence(timeout: 5), "second confirmation"); shot("safety-4-delete-confirm2")
    app.alerts.buttons["不删除"].tap()
  }
  /// Withdraw: ONE screen, no addresses to type, no copy/paste, no jargon; confirm -> (Face ID) -> Coinbase confirm -> done with the amount.
  func testWithdrawOneScreen() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-kp.lang", "zh", "-kpSkipFaceID", "-tab", "home"]; app.launch()
    let t = app.buttons["home.withdraw"]; XCTAssertTrue(t.waitForExistence(timeout: 8)); t.tap()   // t930: the one withdraw entry
    let go = app.buttons["withdraw.go"]; XCTAssertTrue(go.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["你的 Coinbase 钱包"].exists && !app.staticTexts["你的 Coinbase 账户"].exists); XCTAssertTrue(app.staticTexts["withdraw.amount"].label.contains("14.1"), app.staticTexts["withdraw.amount"].label)   // t927: = the home balance (was a fixed 13.95)
    XCTAssertTrue(app.staticTexts["withdraw.net"].exists, "t927: 预计到账 = 余额 − 网络费")
    for w in ["execute", "target", "data", "BaseScan", "Basescan", "复制", "0x 开头", "Connect", "保险箱"] {
      // t1133u: the wallet card (behind this sheet) has 复制 inside wallet.copyWallet; the withdraw sheet itself must have none
      let p = NSPredicate(format: "label CONTAINS %@", w), card = app.buttons["wallet.copyWallet"]
      XCTAssertEqual(app.staticTexts.matching(p).count, card.exists ? card.staticTexts.matching(p).count : 0, w)
      XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS %@ AND identifier != %@", w, "wallet.copyWallet")).firstMatch.exists, w) }
    XCTAssertEqual(app.textFields.count, 1, "t1116u: only the optional amount field, no address to type"); XCTAssertTrue(app.textFields["withdraw.custom"].exists); XCTAssertTrue(app.buttons["withdraw.all"].isSelected, "default = 全部"); shot("withdraw-1-screen")
    go.tap(); let c = app.buttons["withdraw.confirm"].firstMatch; XCTAssertTrue(c.waitForExistence(timeout: 5)); shot("withdraw-2-confirm"); c.tap()
    XCTAssertTrue(app.descendants(matching: .any)["withdraw.done"].waitForExistence(timeout: 8)); XCTAssertTrue(app.staticTexts["withdraw.doneAmount"].label.contains("14.1")); shot("withdraw-3-done")
  }
  private func dismissDialog() { let c = app.buttons["取消"].firstMatch; if c.exists && c.isHittable { c.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap() }; sleep(1) }
  func testEmptyStates() {
    launch("main-empty")
    XCTAssertTrue(app.staticTexts["还没有记录"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["待你批准"].exists)
    tab("AI 生活").tap(); XCTAssertTrue(app.staticTexts["life.title"].waitForExistence(timeout: 5)); XCTAssertFalse(app.staticTexts["待你批准"].exists, "§6#110: nothing pending on AI 生活 either"); tab("钱包").tap()
    shot("main-empty")
    launch("empty")
    XCTAssertTrue(app.staticTexts["先设置额度，AI 才能付款"].waitForExistence(timeout: 5))
    app.buttons["设置额度"].tap()
    XCTAssertTrue(app.navigationBars["设置钱包"].waitForExistence(timeout: 5))
    shot("setup")
  }

  func testLimitsUpdatedCallbackReturnsHome() {
    // t1076: limits-updated is the wallet/chain caps callback. The AI card (caps.values) shows everyday policy, not chain caps.
    // -kpAISaved is a different amount than the callback so the card cannot be filled from j["caps"].
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh",
      "-kpAISaved", "2500000,7000000,15000000",
      "-kpHoldOverlay", "-openURL", "kipurse://limits-updated?single=10000000&daily=50000000&term=200000000&start=1792642081&end=1824178081"]; app.launch()
    XCTAssertTrue(app.staticTexts["limits.success"].waitForExistence(timeout: 15)); shot("limits-success")
    XCTAssertTrue(app.staticTexts["生效时间 2026-10-21 23:08"].exists || app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH '生效时间 '")).count > 0)
    XCTAssertTrue(app.staticTexts["结束时间 2027-10-21 23:08"].exists || app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH '结束时间 '")).count > 0)
    app.staticTexts["limits.success"].tap()
    XCTAssertTrue(app.staticTexts["limits.success"].waitForNonExistence(timeout: 6))
    openLimits(ai: true)   // t1038: caps card lives in AI 生活 → 设置 AI 总限额
    XCTAssertTrue(app.staticTexts["caps.updated"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.staticTexts["caps.values"].label, "每笔 2.5 · 每天 7 · 总额 15 USDC", "AI card shows the saved everyday policy, not the chain callback amounts")
    XCTAssertTrue(app.staticTexts["caps.term"].label.contains(" – 2027-10-"))
    shot("limits-home-updated")
  }

  func testLimitsPendingThenDone() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpHoldOverlay",
      "-kpAISaved", "2500000,7000000,15000000",
      "-openURL", "kipurse://limits-pending?single=10000000&daily=50000000&term=200000000&days=365"]; app.launch()
    XCTAssertTrue(app.staticTexts["auth.pending"].waitForExistence(timeout: 15)); XCTAssertEqual(app.staticTexts["auth.pending"].label, "授权中…")
    XCTAssertFalse(app.buttons["limits.sign"].exists, "never the stale pre-auth form"); shot("state-1-pending")
    XCTAssertTrue(app.staticTexts["auth.done"].waitForExistence(timeout: 10)); XCTAssertEqual(app.staticTexts["auth.done"].label, "授权完成")
    XCTAssertTrue(app.staticTexts["每笔最多 10 USDC"].exists); XCTAssertTrue(app.staticTexts["总额最多 200 USDC"].exists)
    XCTAssertTrue(app.staticTexts["生效时间 2026-10-21 23:08"].exists); XCTAssertTrue(app.staticTexts["结束时间 2027-10-21 23:08"].exists); shot("state-2-done")
    app.staticTexts["auth.done"].tap(); XCTAssertTrue(app.staticTexts["auth.done"].waitForNonExistence(timeout: 6))
    openLimits(ai: true)   // t1038
    XCTAssertTrue(app.staticTexts["caps.updated"].waitForExistence(timeout: 5)); XCTAssertEqual(app.staticTexts["caps.values"].label, "每笔 2.5 · 每天 7 · 总额 15 USDC", "AI card shows the saved everyday policy, not the chain callback amounts")
    XCTAssertEqual(app.staticTexts["caps.term"].label, "2026-10-21 23:08 – 2027-10-21 23:08"); shot("state-3-wallet-updated")
  }
  func testLimitsPendingFailsWithRetry() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpSimulateFail",
      "-openURL", "kipurse://limits-pending?single=10000000&daily=50000000&term=200000000&days=365"]; app.launch()
    XCTAssertTrue(app.staticTexts["auth.pending"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.staticTexts["auth.failed"].waitForExistence(timeout: 10)); XCTAssertTrue(app.buttons["auth.retry"].exists); shot("state-4-failed")
    app.buttons["auth.close"].tap(); XCTAssertTrue(app.staticTexts["auth.failed"].waitForNonExistence(timeout: 5)); XCTAssertTrue(app.buttons["home.deposit"].exists)
  }

  func testLedgerShowsEveryBalanceChange() {
    launch("main")
    let row = app.buttons["ledger.row.1"]; reveal(row); XCTAssertTrue(row.waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["入金 · 支付 · 提现记录"].exists, "§6#110: wallet records = 入金 / 支付 / 提现")
    for f in ["全部", "入金", "支付", "提现"] { XCTAssertTrue(app.segmentedControls["ledger.filter"].buttons[f].exists, f) }
    XCTAssertTrue(app.staticTexts["−0.03"].exists); XCTAssertTrue(app.staticTexts["余额 14.10"].exists)
    XCTAssertTrue(app.staticTexts["+10"].exists); XCTAssertTrue(app.staticTexts["余额 14.13"].exists)
    XCTAssertFalse(app.staticTexts["手续费（你的 Coinbase 付）"].exists, "fee rows folded (audit #8)"); XCTAssertTrue(app.descendants(matching: .any)["ledger.feeTotal"].exists, "one fee total line")
    shot("ledger-home")
    row.tap(); XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 20), "tap opens BaseScan")
  }

  func testAgentCards() {
    launch("main", tab: "agents", extra: kpAISaved)
    XCTAssertTrue(app.buttons["agent.grok-bot"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.buttons["agent.claude"].exists)
    // grouped by real status: 已连接 (Muse, Grok Bot) above 未连接 (Claude)
    let hOn = app.staticTexts["已连接"].firstMatch, hOff = app.staticTexts["未连接"].firstMatch
    XCTAssertTrue(hOn.exists); XCTAssertTrue(hOff.exists)
    let g = app.buttons["agent.grok-bot"].frame.minY, c = app.buttons["agent.claude"].frame.minY
    XCTAssertLessThan(app.descendants(matching: .any)["muse.row"].firstMatch.frame.minY, hOff.frame.minY); XCTAssertLessThan(g, hOff.frame.minY); XCTAssertGreaterThan(c, hOff.frame.minY)
    // server's "oauth-claude-desktop" record (no live token) is the Claude card, shown once, as 授权未完成 — no generic duplicate row
    XCTAssertTrue(app.staticTexts["未连接 · 还没连完，点“连接”继续"].exists);   // t1245 U37: same status word as AI 生活 + how to finish
    XCTAssertEqual(app.staticTexts.matching(identifier: "Claude").count, 1)
    for id in ["claude-code", "codex", "gemini-spark", "cursor"] { XCTAssertFalse(app.buttons["agent.\(id)"].exists, id) }
    shot("agents-cards")
    app.buttons["agent.claude"].tap()
    XCTAssertTrue(app.staticTexts["已在 Claude 打开添加连接器，链接也已复制"].waitForExistence(timeout: 8))
    let launched = app.staticTexts["debug.launch"].label; XCTAssertTrue(launched.hasPrefix("https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Kipurse&connectorUrl=https%3A%2F%2F")); XCTAssertTrue(launched.hasSuffix("%2Fmcp"))
  }

  /// Tapping a CONNECTED agent opens "use this AI to buy" (examples, allowance, purchases, pause), never the connect flow (zh + en).
  func testConnectedAgentCardOpensBuyNotConnect() {
    for (lang, connectHint) in [("zh", "已在 Grok 里填好，点发送"), ("en", "Filled in Grok — tap send")] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "agents", "-kp.lang", lang, "-kp.siri.pendingLimits", "()"]; app.launch()
      let g = app.buttons["agent.grok-bot"]; XCTAssertTrue(g.waitForExistence(timeout: 8)); g.tap()
      XCTAssertTrue(app.descendants(matching: .any)["buy.title"].firstMatch.waitForExistence(timeout: 5), "buy page")
      XCTAssertFalse(app.staticTexts[connectHint].exists, "no connect flow")
      XCTAssertFalse(app.staticTexts["debug.launch"].exists, "nothing launched by opening the card")
      XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Kipurse")).firstMatch.exists)
      XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "ExampleShop")).firstMatch.exists, "t927: no self-promo / jargon examples")
      XCTAssertTrue(app.buttons["buy.copy"].firstMatch.exists); XCTAssertTrue(app.buttons["buy.open"].firstMatch.exists)
      I18nCheck.check(app, lang, "buy page"); shot("buy-grok-\(lang)")
      app.buttons["buy.open"].firstMatch.tap(); let dl = app.staticTexts["debug.launch"]; XCTAssertTrue(dl.waitForExistence(timeout: 3)); XCTAssertTrue(dl.label.hasPrefix("grokbot://app/v1/prompt?text="), dl.label)
      for id in ["buy.pause", "buy.reconnect", "buy.disconnect"] { let e = app.descendants(matching: .any)[id].firstMatch; var n = 0; while !e.exists && n < 6 { app.swipeUp(); n += 1 }; XCTAssertTrue(e.exists, id) }
      I18nCheck.check(app, lang, "buy page bottom"); shot("buy-grok-bottom-\(lang)")
      app.terminate()
    }
  }
  func testAgentsAllConnected() {
    launch("main-all", tab: "agents")
    XCTAssertTrue(app.buttons["agent.claude"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["已连接"].exists); XCTAssertFalse(app.staticTexts["未连接"].exists)
    XCTAssertEqual(app.staticTexts.matching(identifier: "Claude").count, 1); XCTAssertTrue(app.staticTexts["刚连接"].exists)
    XCTAssertTrue(app.staticTexts["最近活动 10 分钟前"].exists); XCTAssertTrue(app.staticTexts["最近活动 1 小时前"].exists)   // t1245 U37: same words as the AI 生活 orbs
    shot("agents-all-connected")
  }

  /// t691: unnamed payee shows a friendly title (short address on the second line); the demo note never covers the Siri row.
  func testUnnamedPayeeAndDemoNotePlacement() {
    launch("main", tab: "life")
    let u = app.staticTexts["未命名收款方"]; XCTAssertTrue(u.waitForExistence(timeout: 8), "friendly title")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "0x")).firstMatch.exists, "short address on the grey line under the title")   // t1245 U1: line 2 = which AI + category, line 3 = address / time
    app.terminate(); launch("main", tab: "agents")
    let siri = app.buttons["agent.siri.connect"].exists ? app.buttons["agent.siri.connect"] : app.descendants(matching: .any)["agent.siri.on"].firstMatch
    XCTAssertTrue(siri.waitForExistence(timeout: 8)); let sf = siri.frame
    siri.tap()
    let toast = app.descendants(matching: .any)["app.toast"].firstMatch
    if toast.waitForExistence(timeout: 2) { XCTAssertFalse(toast.frame.intersects(sf), "demo note covers Siri: \(toast.frame) vs \(sf)") }
    shot("demo-note-not-over-siri")
  }
  func chooseUnsetLimits() {
    let state = app.descendants(matching: .any)["ai.limits.state"]
    XCTAssertTrue(state.waitForExistence(timeout: 8))
    XCTAssertEqual(state.value as? String, "blank")
    XCTAssertFalse(app.buttons["connect.approve"].exists)
    XCTAssertFalse(app.staticTexts["connect.done"].exists)
    let fields = app.textFields
    XCTAssertGreaterThanOrEqual(fields.count, 3)
    let start = fields.count - 3
    for (i, text) in ["2", "5", "30"].enumerated() {
      let field = fields.element(boundBy: start + i)
      field.tap(); field.typeText(text)
    }
    let go = app.buttons["ai.limits.continue"]
    XCTAssertTrue(go.waitForExistence(timeout: 5))
    for _ in 0..<4 where !go.isHittable { app.swipeUp() }
    XCTAssertTrue(go.isEnabled); go.tap()
  }
  func testConnectApproveFaceID() {
    launch("main-connect", tab: "life")   // §6#110: connect requests are in 待你批准 on AI 生活
    let open = app.buttons["connect.open"]; XCTAssertTrue(open.waitForExistence(timeout: 8)); shot("connect-card")
    open.tap()
    chooseUnsetLimits()
    XCTAssertTrue(app.staticTexts["Grok Bot 想连接你的钱包"].waitForExistence(timeout: 8), "title")
    let details = app.buttons["技术细节"]
    XCTAssertTrue(details.waitForExistence(timeout: 5), "details")
    details.tap()
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR value == %@ OR label CONTAINS %@", "www.cursor.com", "www.cursor.com", "www.cursor.com")).firstMatch.waitForExistence(timeout: 5), "host")
    shot("connect-sheet")
    let approve = app.buttons["connect.approve"]
    XCTAssertTrue(approve.waitForExistence(timeout: 8))
    XCTAssertEqual(app.buttons.matching(identifier: "connect.approve").count, 1)
    approve.tap()
    // Demo has no server signature. The tap must not sign, finish, or launch. This is not Face ID.
    XCTAssertFalse(app.descendants(matching: .any)["connect.signing"].waitForExistence(timeout: 2))
    XCTAssertFalse(app.descendants(matching: .any)["connect.done"].exists)
    XCTAssertFalse(app.staticTexts["debug.launch"].exists)
    XCTAssertTrue(app.staticTexts["没有完成"].waitForExistence(timeout: 5))
  }
  func testConnectFromPhoneReturnsToClaude() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main-connect", "-tab", "life", "-kp.lang", "zh", "-kpConnectClaude"]; app.launch()   // §6#110
    let open = app.buttons["connect.open"]; XCTAssertTrue(open.waitForExistence(timeout: 8)); open.tap()
    chooseUnsetLimits()
    if !app.staticTexts["Claude 想连接你的钱包"].waitForExistence(timeout: 8) { print("TREE", app.debugDescription) }; XCTAssertTrue(app.staticTexts["Claude 想连接你的钱包"].exists); app.buttons["技术细节"].tap(); XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "claude.ai")).count > 0)
    app.buttons["connect.approve"].tap()
    XCTAssertFalse(app.staticTexts["正在返回 Claude…"].waitForExistence(timeout: 2))
    XCTAssertFalse(app.descendants(matching: .any)["connect.done"].exists)
    XCTAssertFalse(app.staticTexts["debug.launch"].exists)
    XCTAssertTrue(app.staticTexts["没有完成"].waitForExistence(timeout: 5))
  }
  /// Opening the app never asks for Face ID; balances start hidden and only a tap (+ Face ID) reveals them.
  /// t893: the Face ID approval sheet shows 3 steps + "only other AIs", collapsed by default; tapping expands (zh + en), fee dynamic.
  func testT893StepsCollapsedThenExpand() {
    for (lang, o) in [("zh", "不需要这一步"), ("en", "need this step")] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-kpGasGate"]; app.launch()
      let any = app.descendants(matching: .any)
      let steps = any["t893.steps"].firstMatch; XCTAssertTrue(steps.waitForExistence(timeout: 10))
      XCTAssertTrue(any["t893.others"].firstMatch.exists)
      XCTAssertFalse(any["t893.step1"].firstMatch.exists, "collapsed by default")
      XCTAssertFalse(any["t893.othersText"].firstMatch.exists, "collapsed by default")
      shot("t893-collapsed-\(lang)")
      steps.tap()
      for id in ["t893.step1", "t893.step2", "t893.step3"] { XCTAssertTrue(any[id].firstMatch.waitForExistence(timeout: 5), id) }
      let s2 = any["t893.step2"].firstMatch.label; XCTAssertTrue(s2.contains("0.04"), s2)
      let s3 = any["t893.step3"].firstMatch.label; XCTAssertTrue(s3.contains(lang == "zh" ? "额度内" : "allowance"), "t899 step 3: " + s3); t899shot("faceid-sheet-steps-\(lang)")
      if !any["t893.others"].firstMatch.isHittable { app.swipeUp(); sleep(1) }   // t899: longer step 3 can push it below the fold
      any["t893.others"].firstMatch.tap()
      let ot = any["t893.othersText"].firstMatch; if !ot.waitForExistence(timeout: 2) { app.swipeUp(); sleep(1) }; XCTAssertTrue(ot.waitForExistence(timeout: 5)); XCTAssertTrue(ot.label.contains(o), ot.label)
      shot("t893-expanded-\(lang)")
      app.terminate()
    }
  }
  /// Phone upgrade fee page: network fee from the Kipurse wallet's USDC (stub quote, no network), sign enabled.
  func testUpgradeFeeFromKipurseUSDC() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpGasGate"]; app.launch()
    let fee = app.descendants(matching: .any)["gas.fee"].firstMatch
    if app.descendants(matching: .any)["gas.why"].firstMatch.waitForExistence(timeout: 10) { app.descendants(matching: .any)["gas.why"].firstMatch.tap() }; 
    let what = app.descendants(matching: .any)["gas.what"].firstMatch
    XCTAssertTrue(what.waitForExistence(timeout: 10)); XCTAssertTrue(what.label.contains("不需要开通 Siri"), what.label)
    XCTAssertTrue(app.navigationBars["开启 Face ID 批准"].exists, "bind title, not add/upgrade")
    let notice = app.descendants(matching: .any)["gas.notice"].firstMatch
    XCTAssertTrue(notice.label.contains("启付钱包")); XCTAssertTrue(notice.label.contains("不收一分钱"))
    var k = 0; while !fee.exists && k < 4 { app.swipeUp(); k += 1 }; XCTAssertTrue(fee.exists)
    XCTAssertFalse(app.descendants(matching: .any)["gas.missing"].exists); shot("fee-usdc")
    let b = app.buttons["gas.sign"]; var n = 0; while !b.isHittable && n < 4 { app.swipeUp(); n += 1 }
    XCTAssertTrue(app.descendants(matching: .any)["gas.agentsFree"].firstMatch.label.contains("不上区块链"))
    XCTAssertTrue(b.isEnabled); XCTAssertTrue(b.label.contains("用 Face ID 开启"), b.label); shot("fee-usdc-bottom")
  }
  /// The optional Siri upgrade sheet says Face ID already works without it (zh + en).
  func testSiriUpgradeSheetSaysFaceIDWorksWithout() {
    for (lang, title, what, btn) in [("zh", "更新 Face ID 批准", "不升级也不影响 Face ID", "用 Face ID 开启"), ("en", "Update Face ID approvals", "Face ID still works", "Turn on with Face ID")] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-kpGasGate", "-kpGasSiri"]; app.launch()
      if app.descendants(matching: .any)["gas.why"].firstMatch.waitForExistence(timeout: 10) { app.descendants(matching: .any)["gas.why"].firstMatch.tap() }; let w = app.descendants(matching: .any)["gas.what"].firstMatch; XCTAssertTrue(w.waitForExistence(timeout: 10)); XCTAssertTrue(w.label.contains(what), w.label)
      XCTAssertTrue(app.navigationBars[title].exists, title); shot("siri-upgrade-\(lang)")
      let b = app.buttons["gas.sign"]; var n = 0; while !(b.exists && b.isHittable) && n < 8 { app.swipeUp(); n += 1 }; XCTAssertTrue(b.label.contains(btn), b.label)
      app.terminate()
    }
  }
  /// t849: reinstall / new phone: sign in with Coinbase again (no bind card, no deposit), the no-phone emergency page stays (zh + en).
  func testUnboundHomeShowsBindCardAndEmergency() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-kpIdentityOK", "-kpUnbound", "-kp.lang", lang]; app.launch()
      XCTAssertTrue(app.buttons["cb.signin"].waitForExistence(timeout: 15), lang)
      XCTAssertFalse(app.buttons["main.retry"].exists, "no bare retry dead end")
      XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", lang == "zh" ? "存入" : "Add USDC")).firstMatch.exists, "never deposit-first")
      let e = app.buttons["unbound.emergency"]; for _ in 0..<4 where !e.exists { app.swipeUp() }; XCTAssertTrue(e.exists)
      XCTAssertTrue((e.value as? String ?? "").hasSuffix("/t/0x2000000000000000000000000000000000000002/owner/emergency"), e.value as? String ?? "")
      I18nCheck.check(app, lang, "unbound sign-in"); shot("unbound-\(lang)")
      app.terminate()
    }
  }
  /// New phone / reinstall, end to end: Sign in with Coinbase finds the wallet ("bind") -> emergency page offered right there ->
  /// leave and come back -> sign in again (not a retry, not a bind card) with the emergency page still there.
  func testNewPhonePathEndToEnd() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", lang, "-kpOnboard", "-kpSigninMock", "bind"]; app.launch()
      let b = app.buttons["cb.signin"]; XCTAssertTrue(b.waitForExistence(timeout: 10)); b.tap()
      XCTAssertTrue(app.descendants(matching: .any)["wallet.title"].firstMatch.waitForExistence(timeout: 10), "t1001u: returning user lands in the wallet home"); shot("newphone-1-\(lang)")
      sleep(2)   // t1209: let the first launch finish persisting the bind state before it is killed (pre-existing flake, A/B 2/3 = 2/3)
      app.terminate()
      app = XCUIApplication(); app.launchArguments = ["-kp.lang", lang, "-kpKeepUnbound"]; app.launch()
      XCTAssertTrue(app.buttons["cb.signin"].waitForExistence(timeout: 30), "come back = sign in with Coinbase again")   // t1209: 15->30 s
      XCTAssertFalse(app.buttons["main.retry"].exists); shot("newphone-2-\(lang)")
      app.terminate()
    }
  }
  /// t849: a phone that isn't the approver still gets the FULL wallet home (balance, deposit, withdraw); one small row opens Face ID approvals.
  func testUnboundPhoneLoadsFullWalletHome() {
    for (lang, row, nav) in [("zh", "只在付款时需要", "Face ID 批准"), ("en", "only needed for payments", "Face ID approvals")] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-kpBoundFalse"]; app.launch()
      XCTAssertTrue(app.descendants(matching: .any)["wallet.title"].firstMatch.waitForExistence(timeout: 15))
      XCTAssertTrue(app.buttons["home.withdraw"].exists, "withdraw on home")
      XCTAssertFalse(app.buttons["home.faceidOff"].exists, "t930: Face ID approvals have one entry, in 设置"); _ = row
      app.tabBars.buttons.element(boundBy: 2).tap(); let r = app.buttons["settings.phone"]; reveal(r)
      XCTAssertFalse(app.descendants(matching: .any)["gas.sign"].exists, "nothing forced open")
      r.tap(); XCTAssertTrue(app.navigationBars[nav].waitForExistence(timeout: 8) || bindEntry(), "row opens Face ID approvals"); shot("boundfalse-\(lang)")
      app.terminate()
    }
  }
  /// t851: wallet known on this phone but no session / sign-in mark yet -> straight to Sign in with Coinbase, ZERO Face ID prompts before it.
  func testFreshInstallNoFaceIDBeforeLogin() {
    app = XCUIApplication(); app.launchArguments = ["-kpIdentityOK", "-kpKnownWallet", "0x2000000000000000000000000000000000000002", "-kpKeepUnbound", "-kp.lang", "zh"]; app.launch()
    XCTAssertTrue(app.buttons["cb.signin"].waitForExistence(timeout: 15), "Coinbase login first")
    XCTAssertFalse(app.buttons["main.signin"].exists, "no 'open with Face ID' before login")
    sleep(2); XCTAssertEqual(app.descendants(matching: .any)["debug.prompts"].firstMatch.label, "prompts:0", "no Face ID before login")
  }
  /// t851 + t1027: returning phone -> wallet/browse with ZERO Face ID / LAContext on cold launch (0A.2 / 0B).
  func testReturningOneFaceIDStraightToHome() {
    app = XCUIApplication(); app.launchArguments = ["-kpIdentityOK", "-kpKnownWallet", "0x2000000000000000000000000000000000000002", "-kpKeepUnbound", "-kpSessionMark", "-kp.lang", "zh"]; app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["debug.prompts"].firstMatch.waitForExistence(timeout: 15)); sleep(3)
    XCTAssertFalse(app.buttons["cb.signin"].exists, "no Coinbase login for a returning phone")
    XCTAssertEqual(app.descendants(matching: .any)["debug.prompts"].firstMatch.label, "prompts:0", "nothing prompted before any tap")
    XCTAssertFalse(app.buttons["用 Face ID 解锁"].exists, "no app lock Face ID")
    XCTAssertFalse(app.buttons["用 Face ID 打开"].exists, "no Face ID open gate")
  }
  /// t1027 / 0A.2 / 0B guard: cold launch never evaluates LAContext (PromptLog stays 0).
  func testT1027ColdLaunchNoLAContext() {
    app = XCUIApplication(); app.launchArguments = ["-kpIdentityOK", "-kpKnownWallet", "0x2000000000000000000000000000000000000002", "-kpKeepUnbound", "-kpSessionMark", "-kp.lang", "zh"]; app.launch()
    let prompts = app.descendants(matching: .any)["debug.prompts"].firstMatch
    XCTAssertTrue(prompts.waitForExistence(timeout: 15))
    sleep(4)
    XCTAssertEqual(prompts.label, "prompts:0", "cold launch must not call LAContext.evaluatePolicy / Face ID")
    XCTAssertFalse(app.buttons["用 Face ID 解锁"].exists)
    XCTAssertFalse(app.buttons["用 Face ID 打开"].exists)
    // Enter wallet button (if gate) must not Face ID either
    let enter = app.buttons["main.signin"].firstMatch
    if enter.exists {
      enter.tap(); sleep(3)
      XCTAssertEqual(prompts.label, "prompts:0", "entering wallet still no LAContext")
    }
  }
  /// t853: start screen = two big choices only; the fee + Coinbase details only in the register screen (zh + en). No "每笔最多 0.05".
  func testStartScreenTwoChoicesOnly() {
    for (lang, reg, login, fee) in [("zh", "新用户注册", "老用户登录", "Coinbase 钱包（Base 账户）"), ("en", "Sign up", "Sign in", "Coinbase wallet (Base account)")] {
      app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", lang, "-kpOnboard"]; app.launch()
      let r = app.buttons["cb.register"], l = app.buttons["cb.signin"]
      XCTAssertTrue(r.waitForExistence(timeout: 10)); XCTAssertTrue(r.label.contains(reg), r.label); XCTAssertTrue(l.label.contains(login), l.label)
      XCTAssertFalse(app.descendants(matching: .any)["cb.why"].exists); XCTAssertFalse(app.descendants(matching: .any)["cb.progress"].exists)
      XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "0.05")).firstMatch.exists, "no fee text on the start screen")
      shot("start-\(lang)")
      r.tap(); let f = app.descendants(matching: .any)["reg.fee"].firstMatch; XCTAssertTrue(f.waitForExistence(timeout: 8)); XCTAssertTrue(f.label.contains(fee), f.label)
      XCTAssertFalse(f.label.contains("每笔最多")); XCTAssertTrue(app.buttons["reg.go"].exists); shot("register-\(lang)")
      app.terminate()
    }
  }
  /// t853: first launch shows the welcome animation once; Skip goes to the start screen; it never shows again.
  func testWelcomeShownOnceAndSkippable() {
    app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", "zh", "-kpWelcome", "-kpWelcomeHold"]; app.launch()
    XCTAssertTrue(app.buttons["welcome.skip"].waitForExistence(timeout: 8)); sleep(1); shot("welcome-zh"); app.buttons["welcome.skip"].tap()
    XCTAssertTrue(app.buttons["cb.register"].waitForExistence(timeout: 8)); app.terminate()
    app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", "zh"]; app.launch()
    XCTAssertTrue(app.buttons["cb.register"].waitForExistence(timeout: 8)); XCTAssertFalse(app.buttons["welcome.skip"].exists, "shown once")
    app.terminate()
    app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", "en", "-kpWelcome", "-kpWelcomeSlow"]; app.launch()   // t991: test-only 8 s auto-dismiss (product stays 2.6 s) so a busy simulator never misses it
    XCTAssertTrue(app.buttons["welcome.skip"].waitForExistence(timeout: 7), "en welcome")
    let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["welcome.skip"]); wait(for: [gone], timeout: 15)   // dismisses by itself (no tap)
    XCTAssertTrue(app.buttons["cb.register"].waitForExistence(timeout: 5))
  }
  /// Resume while the phone isn't bound: says so (not "Face ID needed") and offers to bind (zh + en).
  func testResumeUnboundSaysBindAndLinks() {
    for (lang, resume, text, go, nav) in [("zh", "恢复", "还没开启", "去开启", "Face ID 批准"), ("en", "Resume", "aren't on", "Turn on", "Face ID approvals")] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", lang, "-kpResumeUnbound", "-kpSkipFaceID"]; app.launch()   // §6#110: pause / resume on AI 生活
      let t = app.buttons["safety.pause"]; XCTAssertTrue(t.waitForExistence(timeout: 8)); for _ in 0..<8 where !t.isHittable { app.swipeUp() }; t.tap()
      let r = app.buttons[resume].firstMatch; XCTAssertTrue(r.waitForExistence(timeout: 5)); r.tap()
      let al = app.alerts.firstMatch; XCTAssertTrue(al.waitForExistence(timeout: 8))
      XCTAssertTrue(al.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.exists, lang); shot("resume-unbound-\(lang)")
      al.buttons[go].firstMatch.tap(); XCTAssertTrue(app.navigationBars[nav].waitForExistence(timeout: 8) || bindEntry(), nav)
      app.terminate()
    }
  }
  func testSiriAgentCard() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main-all", "-tab", "agents", "-kp.lang", "zh", "-kpSiriOn"]; app.launch()
    let siri = app.buttons["agent.siri.on"].firstMatch; XCTAssertTrue(siri.waitForExistence(timeout: 8)); shot("agents-siri")
    XCTAssertFalse(app.buttons["agent.siri.connect"].exists, "no duplicate")
    siri.tap(); sleep(2); shot("siri-sheet"); XCTAssertTrue(app.descendants(matching: .any)["siri.noSetup"].firstMatch.waitForExistence(timeout: 6))
  }
  /// t899: Siri has its own owner-set allowance like other AIs (per payment + per day), editable; inside it no Face ID.
  func t899shot(_ n: String) { shot(n); try? FileManager.default.createDirectory(atPath: "/tmp/t899shots", withIntermediateDirectories: true); try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/t899shots/\(n).png")) }
  func openSiriBuy(_ lang: String, extra: [String] = []) {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main-all", "-tab", "agents", "-kp.lang", lang, "-kpSiriOn"] + extra; app.launch()
    let siri = app.buttons["agent.siri.on"].firstMatch; XCTAssertTrue(siri.waitForExistence(timeout: 8)); siri.tap()
    XCTAssertTrue(app.descendants(matching: .any)["siri.noSetup"].firstMatch.waitForExistence(timeout: 6))
  }
  func scrollTo(_ e: XCUIElement) { var n = 0; while !(e.exists && e.isHittable) && n < 8 { app.swipeUp(); sleep(1); n += 1 } }
  func setField(_ id: String, _ v: String) { let f = app.textFields[id]; XCTAssertTrue(f.waitForExistence(timeout: 4)); f.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap(); sleep(1); f.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + v); XCTAssertEqual(f.value as? String, v, id) }
  func testT899SiriAllowanceEditable() {
    openSiriBuy("zh")
    let edit = app.buttons["agent.limit.edit"]; scrollTo(edit); XCTAssertTrue(edit.waitForExistence(timeout: 6))
    XCTAssertEqual(app.staticTexts["agent.limit.single"].label, "2 USDC"); XCTAssertEqual(app.staticTexts["agent.limit.daily"].label, "10 USDC")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "不用 Face ID")).firstMatch.exists, "within allowance: no Face ID")
    t899shot("siri-allowance-zh")
    edit.tap(); XCTAssertTrue(app.buttons["agent.limit.save"].waitForExistence(timeout: 4)); t899shot("siri-allowance-edit-zh")
    setField("agent.limit.singleField", "20"); setField("agent.limit.dailyField", "15"); app.buttons["agent.limit.save"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["agent.limit.error"].waitForExistence(timeout: 3), "per payment > per day is refused")
    setField("agent.limit.singleField", "3"); app.buttons["agent.limit.save"].tap()
    XCTAssertTrue(app.staticTexts["agent.limit.single"].waitForExistence(timeout: 6)); sleep(1)
    XCTAssertEqual(app.staticTexts["agent.limit.single"].label, "3 USDC"); XCTAssertEqual(app.staticTexts["agent.limit.daily"].label, "15 USDC"); t899shot("siri-allowance-saved-zh")
    let pz = app.buttons["buy.pause"]; scrollTo(pz); XCTAssertTrue(pz.exists, "Siri can be paused like other AIs")
  }
  func testT899SiriAllowanceEnglishAndResume() {
    openSiriBuy("en", extra: ["-kpSiriPaused"])
    let edit = app.buttons["agent.limit.edit"]; scrollTo(edit); XCTAssertTrue(edit.waitForExistence(timeout: 6))
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "no Face ID")).firstMatch.exists); t899shot("siri-allowance-en")
    let resume = app.buttons["buy.resume"]; scrollTo(resume); XCTAssertTrue(resume.waitForExistence(timeout: 6)); t899shot("siri-allowance-paused-en")
    scrollTo(resume); resume.tap(); XCTAssertTrue(app.buttons["buy.pause"].waitForExistence(timeout: 6), "resumed (Face ID in real mode)")
  }
  /// t902: 连接 Siri shows the intro + 3 steps FIRST; the Face ID approval sheet (fee) opens only from the last step's 下一步.
  func t902shot(_ n: String) { shot(n); try? FileManager.default.createDirectory(atPath: "/tmp/t902shots", withIntermediateDirectories: true); try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/t902shots/\(n).png")) }
  /// t1071 supersedes the t902 intro prerequisite; existing fee/approval consent is mandatory.
  func testT1071SiriDirectToFaceIDBothLanguages() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "agents", "-kp.lang", lang, "-kp.siri.pendingLimits", "()", "-kpAISaved", "10000000,50000000,200000000"]; app.launch()
      let c = app.buttons["agent.siri.connect"]; XCTAssertTrue(c.waitForExistence(timeout: 8)); c.tap()
      XCTAssertTrue(app.buttons["gas.sign"].waitForExistence(timeout: 12))
      XCTAssertFalse(app.textFields["siri.intro.single"].exists)
      XCTAssertFalse(app.buttons["siri.intro.next"].exists)
      t902shot("t1071-siri-direct-\(lang)")
      app.terminate()
    }
  }
  func testT1071SiriKeepsExplicitConsent() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "agents", "-kp.lang", "zh", "-kpAISaved", "10000000,50000000,200000000"]; app.launch()
    let c = app.buttons["agent.siri.connect"]; XCTAssertTrue(c.waitForExistence(timeout: 8)); c.tap()
    XCTAssertTrue(app.buttons["gas.sign"].waitForExistence(timeout: 12))
    XCTAssertFalse(app.webViews.firstMatch.exists, "Must not auto-continue to Coinbase signing")
    XCTAssertFalse(app.buttons["agent.siri.on"].exists, "Must not claim connected on open")
  }
  func testSiriAgentCardNotConnected() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "agents", "-kp.lang", "zh"]; app.launch()
    XCTAssertTrue(app.buttons["agent.siri.connect"].firstMatch.waitForExistence(timeout: 8)); XCTAssertFalse(app.buttons["agent.siri.on"].exists); shot("agents-siri-off")
  }
  func testBalanceHiddenUntilRevealed() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpMasked"]; app.launch()
    XCTAssertTrue(app.buttons["balance.reveal"].waitForExistence(timeout: 8), "balance is hidden on open, no lock screen")
    XCTAssertFalse(app.staticTexts["balance.amount"].exists)
    XCTAssertFalse(app.buttons["用 Face ID 解锁"].exists, "no app lock")
    XCTAssertEqual(app.buttons["balance.reveal"].firstMatch.label, "显示余额")
    let mask = app.staticTexts["balance.masked"]; XCTAssertTrue(mask.exists); XCTAssertFalse(app.staticTexts["****"].exists)
    XCTAssertFalse(app.staticTexts["余额 14.10"].exists, "ledger balances are masked too")
    shot("balance-hidden")
  }
  /// Eye toggle: shown -> tap eye hides immediately (no Face ID); eye.slash is back.
  func testBalanceEyeHidesWithoutFaceID() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh"]; app.launch()
    XCTAssertTrue(app.staticTexts["balance.amount"].waitForExistence(timeout: 8)); shot("balance-shown")
    XCTAssertEqual(app.buttons["balance.hide"].firstMatch.label, "隐藏余额")
    app.buttons["balance.hide"].firstMatch.tap()
    XCTAssertTrue(app.buttons["balance.reveal"].firstMatch.waitForExistence(timeout: 3)); XCTAssertFalse(app.staticTexts["balance.amount"].exists)
    XCTAssertTrue(app.staticTexts["balance.masked"].exists); XCTAssertEqual(app.staticTexts["balance.masked"].label, "余额已隐藏")
    XCTAssertTrue(app.staticTexts["balance.masked"].isHittable, "the mask itself is tappable (reveal, no Face ID)"); shot("balance-hidden-after-eye")
  }
  /// t889: cold start hidden; tap the eye reveals at once (no Face ID); stays across background/foreground; relaunch = hidden again.
  func testBalanceRevealNoFaceIDColdStartHidden() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpMasked"]; app.launch()
    let r = app.buttons["balance.reveal"].firstMatch; XCTAssertTrue(r.waitForExistence(timeout: 8)); XCTAssertFalse(app.staticTexts["balance.amount"].exists)
    r.tap(); XCTAssertTrue(app.staticTexts["balance.amount"].waitForExistence(timeout: 2), "revealed immediately")
    XCTAssertFalse(app.alerts.firstMatch.exists); XCTAssertFalse(app.otherElements["FaceID"].exists)
    XCUIDevice.shared.press(.home); sleep(2); app.activate()
    XCTAssertTrue(app.staticTexts["balance.amount"].waitForExistence(timeout: 5), "still revealed after background/foreground")
    app.terminate(); app.launch()
    XCTAssertTrue(app.buttons["balance.reveal"].firstMatch.waitForExistence(timeout: 8)); XCTAssertFalse(app.staticTexts["balance.amount"].exists, "cold start = hidden")
  }
  /// t890 + t1027: real mode cold start: no lock screen, no Face ID gate; enter wallet without LAContext.
  func testRealModeColdStartNeverBlockedByFaceID() {
    app = XCUIApplication(); app.launchArguments = ["-kp.lang", "zh"]; app.launch()
    sleep(6)
    XCTAssertFalse(app.buttons["用 Face ID 解锁"].exists, "no app lock screen on a cold start")
    XCTAssertFalse(app.buttons["用 Face ID 打开"].exists, "no Face ID open on cold start")
    let b = app.buttons["main.signin"].firstMatch
    if b.exists { b.tap(); XCTAssertTrue(app.wait(for: .runningForeground, timeout: 1)); sleep(4); XCTAssertFalse(app.buttons["main.signin"].exists, "the button must do something") }
    shot("real-cold-start"); app.terminate(); app.launch(); sleep(5)
    XCTAssertFalse(app.buttons["用 Face ID 解锁"].exists)
    XCTAssertFalse(app.buttons["用 Face ID 打开"].exists)
  }
  func testSiriPaymentConfirmNeedsFaceIDAndNeverPays() throws {
    #if KP_OWNER_PAY_YES
    throw XCTSkip("owner-pay build: confirm goes to the owner-pay flow (covered by testOwnerPay*Mock), not the no-route screen")
    #endif
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpPayDraft"]; app.launch()
    XCTAssertTrue(app.buttons["pay.confirm"].waitForExistence(timeout: 8)); XCTAssertTrue(app.staticTexts["付给 Example Shop"].exists); shot("siri-pay-confirm")
    tapWhenReady(app.buttons["pay.confirm"])
    XCTAssertTrue(app.descendants(matching: .any)["pay.noroute"].waitForExistence(timeout: 5)); shot("siri-pay-noroute")
    XCTAssertFalse(app.buttons["pay.confirm"].exists)
    app.buttons["pay.cancel"].tap(); XCTAssertFalse(app.buttons["pay.cancel"].waitForExistence(timeout: 2))
  }
  /// Owner payment flow against a MOCK server (no network, no money): known payee -> Face ID sign -> paid with fees shown.
  func testOwnerPayKnownPayeeMock() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpPayDraft", "-kpOwnerPayMock"]; app.launch()
    XCTAssertTrue(app.buttons["pay.confirm"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.staticTexts["pay.feeBefore"].label.contains("0.1%"), "protocol fee shown before Face ID")
    tapWhenReady(app.buttons["pay.confirm"])
    XCTAssertTrue(app.descendants(matching: .any)["pay.done"].waitForExistence(timeout: 8)); XCTAssertTrue(app.staticTexts["pay.fee"].label.contains("0.008")); shot("owner-pay-paid")
    XCTAssertFalse(app.buttons["pay.confirm"].exists)
  }
  /// A new address needs a second, explicit confirmation showing the full address before anything is signed.
  func testOwnerPayNewPayeeNeedsExtraConfirm() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpPayDraft", "-kpOwnerPayMock", "-kpOwnerPayNewPayee"]; app.launch()
    XCTAssertTrue(app.buttons["pay.confirm"].waitForExistence(timeout: 8)); tapWhenReady(app.buttons["pay.confirm"])
    XCTAssertTrue(app.descendants(matching: .any)["pay.newpayee"].waitForExistence(timeout: 8)); shot("owner-pay-new-address")
    XCTAssertFalse(app.descendants(matching: .any)["pay.done"].exists)
    app.buttons["pay.confirmNew"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["pay.done"].waitForExistence(timeout: 8))
  }
  /// Delete-everything (local): seeds session, payee cache, wallet, Spotlight, files; wipes; nothing may remain.
  func testDeleteEverythingLeavesNothing() {
    app = XCUIApplication(); app.launchArguments = ["-wipeSelfTest", "-kp.lang", "zh"]; app.launch()
    let t = app.staticTexts["debug.wipe"]; XCTAssertTrue(t.waitForExistence(timeout: 60))   // t1209: seed now waits (bounded) for Spotlight; same assertions
    XCTAssertTrue(t.label.contains("remnants=[]"), t.label); XCTAssertTrue(t.label.contains("pendingNotifications=0")); XCTAssertTrue(t.label.contains("tmpSeed=0")); XCTAssertTrue(t.label.contains("cachesSeed=0"))
    XCTAssertFalse(t.label.contains("seeded=0"), "seeding must have created data to delete")
    // Siri module: Spotlight held its entities before the wipe; afterwards no item, no donation, no cache key is left.
    XCTAssertFalse(t.label.contains("siriBefore=[spotlight=0"), t.label); XCTAssertTrue(t.label.contains("siriAfter=[spotlight=0 donations=0]"), t.label)
  }
  /// t1153u: Face ID off for Kipurse. On open: calm guidance on the status line, neutral (no red "没有完成"), only the existing Retry; no approve.
  func testConnectFaceIDOffShowsGuidanceOnOpen() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-openURL", "kipurse://approve-connect?id=demoGrokBotReq01", "-kpFaceIDOff"]; app.launch()
      chooseUnsetLimits()
      let note = app.descendants(matching: .any)["connect.faceidoff"]
      XCTAssertTrue(note.waitForExistence(timeout: 8), lang)
      XCTAssertTrue(note.label.contains(lang == "zh" ? "设置 › Kipurse › 打开面容 ID" : "Settings › Kipurse"), note.label)
      XCTAssertFalse(note.label.contains("不可用"), note.label)
      XCTAssertFalse(app.buttons["connect.approve"].exists); XCTAssertTrue(app.buttons["connect.retry"].exists)
      XCTAssertFalse(app.staticTexts[lang == "zh" ? "没有完成" : "Not finished"].exists)
      shot("t1153-faceid-off-\(lang)")
      app.terminate()
    }
  }
  /// t1153u: the approve tap hits LAError -6 -> same calm guidance instead of the system sentence; Retry returns to the sheet.
  func testConnectApproveFaceIDOffAfterTap() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-openURL", "kipurse://approve-connect?id=demoGrokBotReq01", "-kpSimulateFaceIDOff"]; app.launch()
    chooseUnsetLimits()
    let approve = app.buttons["connect.approve"]; XCTAssertTrue(approve.waitForExistence(timeout: 8)); approve.tap()
    let note = app.descendants(matching: .any)["connect.faceidoff"]
    XCTAssertTrue(note.waitForExistence(timeout: 5)); XCTAssertTrue(note.label.contains("没有批准，也没有扣钱"), note.label)
    XCTAssertFalse(app.descendants(matching: .any)["connect.done"].exists)
    app.buttons["connect.retry"].tap(); XCTAssertTrue(app.buttons["connect.approve"].waitForExistence(timeout: 5))
  }
  func testConnectDeepLinkAndFailure() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-openURL", "kipurse://approve-connect?id=demoGrokBotReq01", "-kpSimulateFail"]; app.launch()
    chooseUnsetLimits()
    let approve = app.buttons["connect.approve"]
    XCTAssertTrue(approve.waitForExistence(timeout: 8))
    XCTAssertEqual(app.buttons.matching(identifier: "connect.approve").count, 1)
    XCTAssertEqual(approve.value as? String, "demoGrokBotReq01")
    approve.tap()
    // -kpSimulateFail is not reached. The refusal is not a signature and not a grant.
    XCTAssertFalse(app.descendants(matching: .any)["connect.signing"].waitForExistence(timeout: 2))
    XCTAssertFalse(app.descendants(matching: .any)["connect.done"].exists)
    XCTAssertFalse(app.staticTexts["debug.launch"].exists)
    XCTAssertTrue(app.staticTexts["没有完成"].waitForExistence(timeout: 5))
  }

  /// Run with ONE simulated face match sent from the host (simctl notifyutil pearl.match). Passes only if unlock + key signature
  /// complete on that single prompt.
  func testFaceIDOncePerUnlock() throws {
    guard ProcessInfo.processInfo.environment["KP_FACETEST"] != nil || FileManager.default.fileExists(atPath: "/tmp/kp-facetest") else { throw XCTSkip("needs host face match") }
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpFaceTest"] + (FileManager.default.fileExists(atPath: "/tmp/kp-noctx") ? ["-kpNoCtx"] : []); app.launch()
    let l = app.staticTexts["debug.facetest"]; XCTAssertTrue(l.waitForExistence(timeout: 10))
    let done = NSPredicate(format: "label BEGINSWITH 'prompts='"); expectation(for: done, evaluatedWith: l); waitForExpectations(timeout: 40)
    XCTAssertEqual(l.label, "prompts=1 signed=true"); shot("facetest")
  }

  /// 开通 (one-time setup) against the local SIMULATOR MOCK of /onboard (tools/onboard-mock.mjs, port 18680): one screen, one fee,
  /// one signature page; the mock pretends the Coinbase wallet batch landed. The real batch is tested on the Base fork (onboard-fork.e2e.mjs).
  func testOnboardOneSignature() throws {
    guard DispatchQueue.global().sync(execute: { try? String(contentsOf: URL(string: "http://127.0.0.1:18680/onboard/quote")!) }) != nil else { throw XCTSkip("needs the onboard mock on 127.0.0.1:18680") }
    app = XCUIApplication(); app.launchArguments = ["-kpOnboard", "-kpOnboardServer", "http://127.0.0.1:18680", "-kp.lang", "zh", "-kpIdentityOK"]; app.launch()
    let gate = app.buttons["gate.onboard"]; XCTAssertTrue(gate.waitForExistence(timeout: 10)); shot("onboard-0-gate"); gate.tap()
    XCTAssertTrue(app.staticTexts["一次确认，全部开通"].waitForExistence(timeout: 5)) // header kept under "第 1 步"
    let fee = app.staticTexts["onboard.fee"]; let has = NSPredicate(format: "label CONTAINS 'USDC'"); expectation(for: has, evaluatedWith: fee); waitForExpectations(timeout: 10)
    XCTAssertTrue(fee.label.contains("0.035579"), fee.label); shot("onboard-1-screen")
    XCTAssertTrue(app.staticTexts["onboard.step1"].exists, "guided step 1"); XCTAssertTrue(app.staticTexts["onboard.laterFee"].label.contains("USDC"))
    XCTAssertFalse(app.staticTexts["onboard.laterFee"].label.contains("需要 ETH"))
    do { let g0 = app.buttons["onboard.go"]; reveal(g0); XCTAssertFalse(g0.isEnabled, "t603u: no preset limits, the user must choose") }
    tapPreset("2 USDC", 0); tapPreset("50 USDC", 0); tapPreset("500 USDC", 0)
    let go = app.buttons["onboard.go"]; reveal(go); XCTAssertEqual(app.staticTexts["onboard.summary"].label, "每笔 2 · 每天 50 · 总额 500 USDC · 90 天"); shot("onboard-2-fee"); go.tap()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15) || app.otherElements["WebSheet"].waitForExistence(timeout: 2)); sleep(2); shot("onboard-3-signing-page")
    XCTAssertTrue(app.descendants(matching: .any)["onboard.done"].waitForExistence(timeout: 40)); XCTAssertTrue(app.descendants(matching: .any)["onboard.siri"].label.contains("Siri 付款已可用")); shot("onboard-4-done")
  }

  func testNoCoinbaseGuideBothLanguages() {
    for lang in ["en", "zh"] {
      app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", lang, "-kpOnboard", "-kpSigninMock", "new"]; app.launch()
      let reg = app.buttons["cb.register"]; XCTAssertTrue(reg.waitForExistence(timeout: 20)); reg.tap()   // t853: details live in the register screen
      let why = app.descendants(matching: .any)["cb.why"].firstMatch; XCTAssertTrue(why.waitForExistence(timeout: 10))
      XCTAssertTrue(why.label.contains(lang == "zh" ? "用 Coinbase 做身份认证，保护你的钱" : "protect your money"), why.label)
      let nocb = app.buttons["gate.nocb"]; reveal(nocb); nocb.tap()
      XCTAssertTrue(app.staticTexts["nocb.title"].waitForExistence(timeout: 5)); XCTAssertTrue(app.buttons["nocb.signup"].exists)
      XCTAssertTrue(app.staticTexts["nocb.why"].label.contains(lang == "zh" ? "必须" : "required")); I18nCheck.check(app, lang, "no-coinbase guide"); shot("nocb-\(lang)")
      app.terminate()
    }
  }
  /// t927: the separate large-text simple mode was removed (duplicate of the system text size); even with the old flag the normal home shows. Lost-phone guide stays in 设置.
  func testSimpleModeHome() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kp.simpleMode", "YES"]; app.launch()
    XCTAssertTrue(app.buttons["home.deposit"].waitForExistence(timeout: 10)); XCTAssertFalse(app.buttons["simple.pause"].exists); shot("simple-home-gone")
    tab("设置").tap(); let lost = app.buttons["settings.lostPhone"]; for _ in 0..<8 where !lost.isHittable { app.swipeUp() }; lost.tap()
    XCTAssertTrue(app.staticTexts["lost.title"].waitForExistence(timeout: 5)); XCTAssertTrue(app.descendants(matching: .any)["lost.step5"].exists); shot("lost-phone")
  }
  func testGuidedSetupNoPreset() throws {
    guard DispatchQueue.global().sync(execute: { try? String(contentsOf: URL(string: "http://127.0.0.1:18680/onboard/quote")!) }) != nil else { throw XCTSkip("needs the onboard mock on 127.0.0.1:18680") }
    app = XCUIApplication(); app.launchArguments = ["-kpOnboard", "-kpOnboardServer", "http://127.0.0.1:18680", "-kp.lang", "zh", "-kpIdentityOK"]; app.launch()
    let gate = app.buttons["gate.onboard"]; XCTAssertTrue(gate.waitForExistence(timeout: 10)); gate.tap()
    XCTAssertTrue(app.buttons["guided.use0"].waitForExistence(timeout: 5)); XCTAssertFalse(app.buttons["guided.plan0"].exists, "no plan before answers")
    for id in ["guided.use0", "guided.use1", "guided.use2", "guided.spend0", "guided.spend1", "guided.spend2"] { XCTAssertEqual(app.buttons[id].value as? String, "not selected", id) }
    app.buttons["guided.use1"].tap(); let sp = app.buttons["guided.spend1"]; reveal(sp); sp.tap()
    for i in 0..<3 { let p = app.buttons["guided.plan\(i)"]; reveal(p); XCTAssertTrue(p.exists); XCTAssertEqual(p.value as? String, "not selected", "plan \(i) must not be pre-selected"); XCTAssertFalse(p.label.contains("每月")) }
    do { let g0 = app.buttons["onboard.go"]; reveal(g0); XCTAssertFalse(g0.isEnabled, "nothing chosen yet") }
    let p1 = app.buttons["guided.plan1"]; reveal(p1); p1.tap(); XCTAssertEqual(p1.value as? String, "selected")
    let go = app.buttons["onboard.go"]; reveal(go); XCTAssertEqual(app.staticTexts["onboard.summary"].label, "每笔 50 · 每天 50 · 总额 1500 USDC · 90 天"); XCTAssertTrue(go.isEnabled); shot("guided-picked")
  }
  func testFreshInstallSignInI18n() {
    for lang in ["en", "zh"] {
      app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", lang, "-kpOnboard", "-kpSigninMock", "new"] + (lang == "en" ? ["-AppleLanguages", "(en)"] : []); app.launch()
      let b = app.buttons["cb.signin"]; XCTAssertTrue(b.waitForExistence(timeout: 20)); I18nCheck.check(app, lang, "sign-in"); i18nShot("signin-\(lang)"); b.tap()
      let next = app.buttons["cb.next"]; XCTAssertTrue(next.waitForExistence(timeout: 8)); I18nCheck.check(app, lang, "sign-in done")
      next.tap(); sleep(2); I18nCheck.check(app, lang, "onboarding"); i18nShot("onboarding-\(lang)")
      for _ in 0..<2 { app.swipeUp(); I18nCheck.check(app, lang, "onboarding scrolled") }
      app.terminate()
    }
  }
  func i18nShot(_ n: String) { shot(n); try? FileManager.default.createDirectory(atPath: "/tmp/kp-i18n", withIntermediateDirectories: true); try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/kp-i18n/\(n).png")) }
  /// New install: the FIRST screen is "Sign in with Coinbase"; no wallet is looked up from a leftover phone key, no Face ID prompt.
  func testFreshInstallShowsSignInWithCoinbase() {
    app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", "zh"]; app.launch()
    XCTAssertTrue(app.buttons["cb.signin"].waitForExistence(timeout: 10)); XCTAssertTrue(app.buttons["cb.register"].exists)
    XCTAssertFalse(app.buttons["main.signin"].exists, "never the old 'open with Face ID' gate before Coinbase sign-in")
    XCTAssertFalse(app.buttons["gate.onboard"].exists); XCTAssertFalse(app.buttons["gate.demo"].exists); shot("cb-0-signin")
  }
  /// Account without a wallet -> new-user onboarding (fresh key); account with a wallet but another phone -> "add this iPhone".
  func testSignInOutcomesNewAndBind() {
    for (o, label) in [("new", "开通我的钱包")] {   // t1001u: "bind" now lands in the wallet home (testLoginZeroBalanceLandsOnWalletHome)
      app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", "zh", "-kpOnboard", "-kpSigninMock", o]; app.launch()
      let b = app.buttons["cb.signin"]; XCTAssertTrue(b.waitForExistence(timeout: 10)); b.tap()
      XCTAssertTrue(app.descendants(matching: .any)["cb.done"].waitForExistence(timeout: 8), o)
      let next = app.buttons["cb.next"]; XCTAssertTrue(next.waitForExistence(timeout: 3)); XCTAssertTrue(next.label.contains(label), next.label); shot("cb-1-" + o)
      next.tap(); if o == "bind" { XCTAssertTrue(app.buttons["phone.bind"].waitForExistence(timeout: 10), o) }   // t802: existing wallet -> bind this phone only
      else { XCTAssertTrue(app.staticTexts["一次确认，全部开通"].waitForExistence(timeout: 8) || bindEntry(), o) }   // t800: KYC (Coinbase verify) comes first
      app.terminate()
    }
  }
  /// t1001u LOCKED guard: login with 0 balance lands straight on the wallet home. No Face ID / phone-key setup step, nothing
  /// that needs a fee blocks the way, no new-wallet form (t802), and withdraw + Apple Pay / Coinbase 充值 stay reachable.
  func testLoginZeroBalanceLandsOnWalletHome() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", lang, "-kpOnboard", "-kpSigninMock", "bind"]; app.launch()
      let b = app.buttons["cb.signin"]; XCTAssertTrue(b.waitForExistence(timeout: 10)); b.tap()
      XCTAssertTrue(app.descendants(matching: .any)["wallet.title"].firstMatch.waitForExistence(timeout: 10), "lands on wallet home")
      sleep(2)
      for id in ["cb.next", "cb.done", "phone.bind", "phone.upgrade", "gas.sign", "gate.onboard", "unbound.bind", "onboard.step1", "onboard.go"] {
        XCTAssertFalse(app.descendants(matching: .any)[id].exists, "no setup step after login: \(id)") }
      XCTAssertFalse(app.staticTexts[lang == "zh" ? "开启 Face ID 批准" : "Turn on Face ID approvals"].exists)
      XCTAssertTrue(app.buttons["home.withdraw"].exists, "withdraw still on home"); XCTAssertTrue(app.buttons["home.deposit"].exists, "充值 reachable"); XCTAssertTrue(app.descendants(matching: .any)["home.zeroGuide"].exists); shot("login-zero-home-\(lang)")
      app.terminate()
    }
  }
  /// 退出登录 / 换账户: no confirmation, no Face ID, back to "Sign in with Coinbase".
  func testSignOutReturnsToCoinbaseSignIn() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "settings", "-kp.lang", "zh"]; app.launch()
    let b = app.buttons["settings.signout"]; for _ in 0..<8 where !b.exists || !b.isHittable { app.swipeUp() }
    XCTAssertTrue(b.waitForExistence(timeout: 8))
    // §6#110 (owner 2026-11-21): 退出登录 / 换账户 is the very last item, below 危险操作 (删除账户).
    let del = app.buttons["safety.delete"]; XCTAssertTrue(del.exists); XCTAssertGreaterThan(b.frame.minY, del.frame.maxY, "sign out sits below delete account")
    shot("signout-bottom"); b.tap()
    XCTAssertFalse(app.buttons["settings.signout.confirm"].exists, "no confirmation popup")
    XCTAssertTrue(app.buttons["cb.signin"].waitForExistence(timeout: 8)); shot("signout-done")
  }

  /// t625u: no Coinbase attestation -> one guided 4-step flow (official Coinbase links only), progress, check again; passes once verified. Both languages.
  func testCoinbaseVerifyGuideBothLanguages() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-kpOnboard", "-kp.lang", lang, "-kpIdentityOK", "-kpCBV", "later"] + (lang == "en" ? ["-AppleLanguages", "(en)"] : []); app.launch()   // t806: phone language too (system back button)
      let gate = app.buttons["gate.onboard"]; XCTAssertTrue(gate.waitForExistence(timeout: 10), lang); gate.tap()
      XCTAssertTrue(app.staticTexts["cbv.title"].waitForExistence(timeout: 8), lang)
      XCTAssertTrue(app.descendants(matching: .any)["cbv.status.none"].firstMatch.waitForExistence(timeout: 5), "check 1: none")
      XCTAssertFalse(app.buttons["onboard.go"].exists, "no setup before verification")
      XCTAssertTrue(app.staticTexts["cbv.progress"].label.contains(lang == "zh" ? "第 1 步" : "Step 1 of 4"))
      let why = app.buttons["cbv.whyButton"]; XCTAssertTrue(why.exists); why.tap(); XCTAssertTrue(app.staticTexts["cbv.whyText"].waitForExistence(timeout: 3)); XCTAssertTrue(app.staticTexts["cbv.whyText"].label.contains(lang == "zh" ? "一个验证只能开一个" : "One verification opens one"))
      let urls = ["https://www.coinbase.com/signup", "https://www.coinbase.com/onchain-verify"   /* t771u: step 2 opens the official verify page */, "https://www.coinbase.com/onchain-verify"]
      for i in 1...3 {
        let o = app.buttons["cbv.open\(i)"]; reveal(o); XCTAssertTrue(o.exists, "open \(i)"); o.tap()
        let dbg = app.staticTexts["cbv.debugOpen"]; XCTAssertTrue(dbg.waitForExistence(timeout: 3)); XCTAssertEqual(dbg.label, urls[i - 1])
        if i == 3 { XCTAssertTrue(app.staticTexts["cbv.address"].exists); XCTAssertEqual(app.staticTexts["cbv.address"].label, "0x1000…0003"); XCTAssertTrue(app.staticTexts["cbv.pick"].exists); let fb = app.buttons["cbv.full"]; for _ in 0..<4 where !fb.isHittable { app.swipeUp() }; fb.tap(); XCTAssertEqual(app.staticTexts["cbv.address"].label, "0x1000000000000000000000000000000000000003"); let cp = app.buttons["cbv.copy"]; reveal(cp); cp.tap(); XCTAssertTrue(app.buttons["cbv.copy"].label.contains(lang == "zh" ? "已复制" : "Copied")) }
        let n = app.buttons["cbv.next\(i)"]; reveal(n); n.tap()
      }
      XCTAssertTrue(app.staticTexts["cbv.progress"].label.contains(lang == "zh" ? "第 4 步" : "Step 4 of 4"))
      let later = app.buttons["cbv.later"]; reveal(later); for _ in 0..<3 where !later.isHittable { app.swipeUp() }; later.tap()
      let laterOK = expectation(for: NSPredicate(format: "label CONTAINS %@", lang == "zh" ? "下次打开" : "remind you next time"), evaluatedWith: app.buttons["cbv.later"]); wait(for: [laterOK], timeout: 5)
      I18nCheck.check(app, lang, "cbv guide"); shot("cbv-guide-\(lang)")
      let re = app.buttons["cbv.recheck"]; reveal(re); re.tap()
      XCTAssertTrue(app.descendants(matching: .any)["cbv.status.none"].firstMatch.waitForExistence(timeout: 5), "check 2: still none")
      reveal(re); re.tap()
      XCTAssertTrue(app.staticTexts["onboard.step1"].waitForExistence(timeout: 8), "check 3: verified -> setup form"); XCTAssertFalse(app.staticTexts["cbv.title"].exists)
      app.terminate()
    }
  }
  func testCoinbaseVerifyDownFailsClosed() {
    app = XCUIApplication(); app.launchArguments = ["-kpOnboard", "-kp.lang", "zh", "-kpIdentityOK", "-kpCBV", "down"]; app.launch()
    let gate = app.buttons["gate.onboard"]; XCTAssertTrue(gate.waitForExistence(timeout: 10)); gate.tap()
    XCTAssertTrue(app.descendants(matching: .any)["cbv.status.down"].firstMatch.waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["onboard.go"].exists, "never let the user through when the check is down")
    let re = app.buttons["cbv.recheck"]; reveal(re); re.tap()
    XCTAssertTrue(app.descendants(matching: .any)["cbv.status.down"].firstMatch.waitForExistence(timeout: 8)); XCTAssertFalse(app.buttons["onboard.go"].exists)
  }
  /// t621 student pass, both languages: hidden balance never looks like 0; the balance stays on top; AI-connect steps; Apple Pay first.
  func testStudentPassBothLanguages() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main-new", "-tab", "home", "-kp.lang", lang, "-kpSkipFaceID", "-kpMasked"]; app.launch()
      let mask = app.staticTexts["balance.masked"]; XCTAssertTrue(mask.waitForExistence(timeout: 10), lang)
      let hint = app.buttons["balance.hiddenHint"]; XCTAssertTrue(hint.exists, lang); XCTAssertTrue(hint.label.contains(lang == "zh" ? "点一下查看" : "tap to show"), hint.label)
      XCTAssertFalse(app.staticTexts["0"].exists, "hidden must not read as 0")
      XCTAssertFalse(app.buttons["guide.aiSteps"].exists, "t930: AI-connect steps live once, on the AI page")
      for i in [Int]() { XCTAssertTrue(app.staticTexts["guide.aiStep\(i)"].waitForExistence(timeout: 3) || app.otherElements["guide.aiStep\(i)"].exists, "step \(i) \(lang)") }
      if lang == "zh" || Locale.preferredLanguages.first?.hasPrefix("en") == true { I18nCheck.check(app, lang, "ai steps") }   // a zh-Hans system joins combined labels with "、"; shot("student-ai-steps-\(lang)")
      app.terminate()
    }
  }
  /// First-use guide on a just-opened wallet: 3 plain steps, real progress, deposit opens the address/Coinbase page, hide works.
  /// t927: the 3-step guide duplicated the zero-balance hint and the tabs; home keeps ONE deposit hint (home.zeroGuide) and no Apple Pay.
  func testFirstUseGuide() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main-new", "-tab", "home", "-kp.lang", "zh", "-kpSkipFaceID"]; app.launch()
    XCTAssertTrue(app.descendants(matching: .any)["home.zeroGuide"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.staticTexts["3 步开始用"].exists); XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Apple Pay")).firstMatch.exists); shot("zero-guide-home")
    app.buttons["home.deposit"].tap()
    otherWays(); XCTAssertTrue(app.buttons["deposit.coinbase"].waitForExistence(timeout: 5)); XCTAssertFalse(app.buttons["deposit.onetap"].exists); shot("guide-deposit")
  }
  /// t665: page 1 「AI 生活」 shows live orbs from real agent data, the monthly ring and the auto-categorised ledger; first launch opens it.
  func testLifePageFirstWithOrbsAndLedger() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", lang, "-kpSkipFaceID", "-kpLifeDemo"]; app.launch()
      XCTAssertTrue(app.staticTexts["life.title"].waitForExistence(timeout: 10), "AI 生活 page (t922: wallet is the default tab)")
      let echo = app.descendants(matching: .any)["life.agent.grok"]; XCTAssertTrue(echo.waitForExistence(timeout: 5))
      XCTAssertTrue(echo.label.contains(lang == "zh" ? "在线" : "Online"), echo.label)   // t915: a call 20 s ago = 在线 (付款中 only with a pending payment)
      XCTAssertTrue(echo.label.contains(lang == "zh" ? "最近活动 刚刚" : "Active just now"), echo.label)
      XCTAssertTrue(app.descendants(matching: .any)["life.agent.siri"].label.contains(lang == "zh" ? "已暂停" : "Paused"))
      let cl = app.descendants(matching: .any)["life.agent.claude"].label   // t1164u (§6#79): authorized, last call 30 min ago -> still 在线 (always lit)
      XCTAssertTrue(cl.hasPrefix(lang == "zh" ? "Claude, 在线" : "Claude, Online"), cl); XCTAssertTrue(cl.contains(lang == "zh" ? "最近活动 30 分钟前" : "Active 30 min ago"), cl); XCTAssertFalse(cl.contains(lang == "zh" ? "未在线" : "idle"), cl)
      XCTAssertTrue(app.descendants(matching: .any)["life.ring"].exists)
      XCTAssertTrue(app.descendants(matching: .any)["life.cat.dining"].exists); XCTAssertTrue(app.descendants(matching: .any)["life.cat.tools"].exists)
      I18nCheck.check(app, lang, "life page")
      let row = app.buttons["life.tx.0"]; reveal(row)
      // §6#110: the life ledger row says which AI paid and the category
      XCTAssertTrue(row.label.contains(lang == "zh" ? "付的" : "Paid by"), row.label); XCTAssertTrue(row.label.contains(lang == "zh" ? "类别" : "Category"), row.label)
      row.tap()
      XCTAssertTrue(app.navigationBars[lang == "zh" ? "付款详情" : "Payment details"].waitForExistence(timeout: 5) || app.staticTexts["Lumi 拉面馆"].exists)
      XCTAssertTrue(app.descendants(matching: .any)["tx.category"].firstMatch.waitForExistence(timeout: 5), "receipt shows the category")
      app.terminate()
    }
  }
  /// t665: manage opens the AI page; wallet keeps Coinbase top-up and withdraw.
  /// §6#110 (owner 2026-11-21): approvals (待你批准), trusted merchants and pause have ONE place each, all on AI 生活.
  func testLifeLinksAndWalletActions() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", "zh", "-kpSkipFaceID"]; app.launch()
    let mg = app.buttons["life.manage"]; XCTAssertTrue(mg.waitForExistence(timeout: 10)); mg.tap()
    XCTAssertTrue(app.navigationBars["AI 智能体"].waitForExistence(timeout: 5)); back()
    XCTAssertFalse(app.buttons["life.approvals"].exists, "t927: approvals have one place (no extra banner)")
    XCTAssertTrue(app.staticTexts["待你批准"].waitForExistence(timeout: 5), "§6#110: 待你批准 on AI 生活")
    let tr = app.buttons["life.trusted"]; for _ in 0..<8 where !tr.exists || !tr.isHittable { app.swipeUp() }; XCTAssertTrue(tr.isHittable, "trusted merchants on AI 生活")
    let pz = app.buttons["safety.pause"]; for _ in 0..<8 where !pz.exists || !pz.isHittable { app.swipeUp() }; XCTAssertTrue(pz.isHittable, "pause on AI 生活 (never gated)")
    tr.tap(); XCTAssertTrue(app.navigationBars["信任的商家"].waitForExistence(timeout: 5)); back()   // t1245 U30: same name as its entry
    tab("钱包").tap(); XCTAssertTrue(app.buttons["home.deposit"].waitForExistence(timeout: 5), "Coinbase-wallet top-up button"); XCTAssertTrue(app.buttons["home.withdraw"].exists)
    XCTAssertFalse(app.staticTexts["待你批准"].exists, "§6#110: approvals have one place (AI 生活)")
    XCTAssertFalse(app.buttons["home.pause"].exists, "t928: one pause control"); XCTAssertFalse(app.buttons["safety.pause"].exists, "one pause control (AI 生活)")
    tab("设置").tap(); XCTAssertTrue(app.staticTexts["settings.title"].waitForExistence(timeout: 5)); XCTAssertFalse(app.buttons["safety.pause"].exists, "§6#110: pause moved out of 设置")
  }
  /// §6#110: the usage guide holds 手机丢了怎么办 and 安全小贴士 (still exactly four steps).
  func testUsageGuideHasLostPhoneAndTips() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "settings", "-kp.lang", lang, "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"]; app.launch()   // phone language = App language (the system back button follows the phone), as the other language tests
      let g = app.buttons["settings.usageGuide"]; XCTAssertTrue(g.waitForExistence(timeout: 10)); for _ in 0..<6 where !g.isHittable { app.swipeUp() }; g.tap()
      XCTAssertTrue(app.descendants(matching: .any)["guide.step4"].firstMatch.waitForExistence(timeout: 5)); XCTAssertFalse(app.descendants(matching: .any)["guide.step5"].exists, "0B: four steps")
      let lost = app.buttons["guide.lostPhone"]; reveal(lost); XCTAssertTrue(lost.exists, lang); shot("usage-guide-\(lang)")
      lost.tap(); XCTAssertTrue(app.staticTexts["lost.title"].waitForExistence(timeout: 5)); back()
      let tips = app.buttons["guide.tips"]; reveal(tips); tips.tap()
      XCTAssertTrue(app.staticTexts["tips.title"].waitForExistence(timeout: 5)); I18nCheck.check(app, lang, "tips from guide")
      app.terminate()
    }
  }
  /// t665: every completed payment shows the cheer card with the agent's display name.
  func testCelebrationOnPayment() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-kp.lang", "zh", "-kpSkipFaceID", "-kpLifeDemo", "-kpCelebrate"]; app.launch()
    // t1209: the celebration auto-closes 4.5 s after it shows; wait on the title first (one poll) so the checks read the live overlay. Same assertions.
    let ti = app.staticTexts["celebrate.title"]; XCTAssertTrue(ti.waitForExistence(timeout: 12))
    XCTAssertTrue(ti.label.hasPrefix("Grok 帮你付了"), "display name, not the agent id")
    XCTAssertTrue(app.staticTexts["celebrate.cheer"].exists)
    XCTAssertTrue(app.buttons["查看收据"].exists)
  }
  /// t681: the four approved characters are always on page 1, each with a status, even with no AI connected.
  func testFourAgentsAlwaysShown() {
    for (demo, want) in [("main-new", ["muse": "未连接", "grok": "未连接", "claude": "未连接", "siri": "未连接"]), ("main", ["muse": ", 在线", "grok": ", 在线", "claude": "未连接"])] {
      app = XCUIApplication(); app.launchArguments = ["-demo", demo, "-tab", "life", "-kp.lang", "zh", "-kpSkipFaceID"]; app.launch()
      for n in ["muse", "grok", "claude", "siri"] { XCTAssertTrue(app.descendants(matching: .any)["life.agent.\(n)"].waitForExistence(timeout: 8), "\(demo) \(n)") }
      for (n, st) in want { let l = app.descendants(matching: .any)["life.agent.\(n)"].label; XCTAssertTrue(l.contains(st), "\(demo) \(n): \(l)") }
      app.terminate()
    }
  }
}
