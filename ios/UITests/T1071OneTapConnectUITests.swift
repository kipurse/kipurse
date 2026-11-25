import XCTest

/// Simulator fixture proves a single Kipurse tap chooses the full launch payload, not external authorization.
final class T1071OneTapConnectUITests: XCTestCase {
  var app: XCUIApplication!
  func launch(_ lang: String, tab: String = "life", extra: [String] = []) {
    app = XCUIApplication()
    app.launchArguments = ["-demo", "main-nomuse", "-tab", tab, "-kp.lang", lang, "-kpSkipFaceID", "-kpStill", "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"] + extra
    app.launch()
  }
  func shot(_ name: String) {
    let s = app.screenshot(); let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
    try? FileManager.default.createDirectory(atPath: "/tmp/t1071shots", withIntermediateDirectories: true)
    try? s.pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/t1071shots/\(name).png"))
  }
  func launched() -> String {
    let e = app.staticTexts["debug.launch"]; XCTAssertTrue(e.waitForExistence(timeout: 5)); return e.label
  }
  func limitsPageOpen() -> Bool {
    app.staticTexts["everyday.title"].waitForExistence(timeout: 8)
  }
  @MainActor func checkUnsetOpensBlankLimits(_ lang: String) {
    for key in ["muse", "grok", "claude", "siri"] {
      launch(lang)
      let cell = app.descendants(matching: .any)["life.agent.\(key)"]
      XCTAssertTrue(cell.waitForExistence(timeout: 10))
      let before = cell.label
      cell.tap()
      XCTAssertTrue(limitsPageOpen(), "unset AI limits open the existing limits page")
      let state = app.descendants(matching: .any)["ai.limits.state"]
      XCTAssertTrue(state.waitForExistence(timeout: 5))
      XCTAssertEqual(state.value as? String, "blank")
      XCTAssertTrue(app.descendants(matching: .any)["ai.limit.total"].waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["gas.sign"].exists)
      XCTAssertFalse(app.staticTexts["debug.launch"].exists)
      if key == "muse" { shot("t1073-blank-limits-\(lang)") }
      // The orb is not in this snapshot once the limits page is pushed. Compare it only after returning.
      app.navigationBars.buttons.element(boundBy: 0).tap()
      let again = app.descendants(matching: .any)["life.agent.\(key)"]
      XCTAssertTrue(again.waitForExistence(timeout: 5), key)
      XCTAssertEqual(again.label, before, "\(key) must not look connected")
      app.terminate()
    }
  }
  @MainActor func checkLife(_ lang: String) {
    for key in ["muse", "grok", "claude", "siri"] {
      launch(lang, extra: ["-kpAISaved", "2000000,5000000,30000000"])
      let cell = app.descendants(matching: .any)["life.agent.\(key)"]
      XCTAssertTrue(cell.waitForExistence(timeout: 10))
      if key == "muse" { shot("t1071-life-\(lang)") }
      let before = cell.label
      cell.tap() // exactly ONE tap from the existing orb; no text input
      if key == "siri" {
        XCTAssertTrue(app.buttons["gas.sign"].waitForExistence(timeout: 8) || app.staticTexts["gas.plain"].exists)
        XCTAssertFalse(app.textFields["siri.intro.single"].exists)
        XCTAssertFalse(app.buttons["siri.intro.next"].exists)
        shot("t1071-siri-approval-\(lang)")
      } else {
        let u = launched()
        if key == "muse" { XCTAssertEqual(u, "https://muse.ai/chat"); XCTAssertFalse(app.buttons["muse.copyOpen"].exists) }
        if key == "grok" { XCTAssertTrue(u.hasPrefix("grokbot://app/v1/prompt?text=")); XCTAssertTrue(u.contains("MCP")) }
        if key == "claude" {
          let parts = URLComponents(string: u)!
          XCTAssertEqual(parts.queryItems?.first { $0.name == "connectorName" }?.value, "Kipurse")
          XCTAssertTrue((parts.queryItems?.first { $0.name == "connectorUrl" }?.value ?? "").hasSuffix("/mcp"))
        }
        XCTAssertEqual(cell.label, before, "launch must not forge a connected state")
        shot("t1071-\(key)-launch-\(lang)")
      }
      app.terminate()
    }
  }
  func typeLimits(_ values: [String]) {
    let fields = app.textFields
    XCTAssertGreaterThanOrEqual(fields.count, values.count)
    for (i, text) in values.enumerated() {
      let field = fields.element(boundBy: i)
      field.tap(); field.typeText(text)
    }
  }
  /// Continue opens Muse. It does not save a policy and does not mark the AI connected.
  @MainActor func testChooseTotalThenContinueMuseWithoutGrant() {
    launch("zh")
    let cell = app.descendants(matching: .any)["life.agent.muse"]
    XCTAssertTrue(cell.waitForExistence(timeout: 10)); cell.tap()
    XCTAssertTrue(limitsPageOpen())
    XCTAssertEqual(app.descendants(matching: .any)["ai.limits.state"].value as? String, "blank")
    XCTAssertFalse(app.buttons["everyday.save"].exists)
    typeLimits(["2", "5", "30"])
    let go = app.buttons["ai.limits.continue"]
    XCTAssertTrue(go.waitForExistence(timeout: 5))
    XCTAssertTrue(go.isEnabled)
    XCTAssertEqual(app.descendants(matching: .any)["ai.limits.state"].value as? String, "chosen")
    go.tap()
    // t1254 (decision 123): first a "[zh]" page (limits not in effect yet, where Face ID comes); nothing launched until the owner taps
    XCTAssertTrue(app.staticTexts["handoff.title"].waitForExistence(timeout: 5))
    let staged = app.descendants(matching: .any)["handoff.staged"]
    XCTAssertTrue(staged.exists)
    XCTAssertTrue(app.descendants(matching: .any)["handoff.steps"].exists)
    XCTAssertFalse(app.staticTexts["debug.launch"].exists)
    app.buttons["handoff.go"].tap()
    XCTAssertEqual(launched(), "https://muse.ai/chat")
    XCTAssertFalse(app.staticTexts["connect.done"].exists)
  }
  /// t1254: "[zh]" on the "[zh]" page launches nothing and grants nothing; another outside AI (Grok) gets the same page.
  @MainActor func testHandoffLaterLaunchesNothingAndCardsGetThePage() {
    for (lang, agent) in [("zh", "life.agent.muse"), ("en", "life.agent.grok")] {
      launch(lang)
      app.descendants(matching: .any)[agent].tap()
      XCTAssertTrue(limitsPageOpen())
      typeLimits(["2", "5", "30"])
      app.buttons["ai.limits.continue"].tap()
      XCTAssertTrue(app.staticTexts["handoff.title"].waitForExistence(timeout: 5), agent)
      shot("t1254-handoff-\(lang)")
      app.buttons["handoff.later"].tap()
      XCTAssertTrue(app.staticTexts["handoff.title"].waitForNonExistence(timeout: 4))
      XCTAssertFalse(app.staticTexts["debug.launch"].exists)
      XCTAssertFalse(app.staticTexts["connect.done"].exists)
      app.terminate()
    }
  }
  /// Demo has no phone key. Continue must open the existing enrollment, keep the typed amounts, and grant nothing if canceled.
  /// This does not perform Face ID or talk to the server. Enrollment's own confirmation is separate from the spend signature.
  @MainActor func testUnenrolledSiriContinuesToEnrollmentAndCancelGrantsNothing() {
    launch("en")
    app.descendants(matching: .any)["life.agent.siri"].tap()
    XCTAssertTrue(limitsPageOpen())
    XCTAssertEqual(app.descendants(matching: .any)["ai.limits.state"].value as? String, "blank")
    typeLimits(["2", "5", "30"])
    XCTAssertEqual(app.descendants(matching: .any)["ai.limits.state"].value as? String, "chosen")
    app.buttons["ai.limits.continue"].tap()
    XCTAssertTrue(app.buttons["gas.sign"].waitForExistence(timeout: 8) || app.staticTexts["gas.plain"].exists)
    XCTAssertFalse(app.staticTexts["connect.done"].exists)
    let cancel = app.buttons["Cancel"]
    if cancel.waitForExistence(timeout: 4) { cancel.tap() } else { app.swipeDown() }
    XCTAssertTrue(app.buttons["gas.sign"].waitForNonExistence(timeout: 4))
    XCTAssertFalse(app.staticTexts["connect.done"].exists)
    XCTAssertEqual(app.descendants(matching: .any)["ai.limits.state"].value as? String, "chosen")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.descendants(matching: .any)["life.agent.siri"].tap()
    XCTAssertTrue(limitsPageOpen())
    XCTAssertEqual(app.descendants(matching: .any)["ai.limits.state"].value as? String, "chosen")
    XCTAssertFalse(app.staticTexts["connect.done"].exists)
    XCTAssertFalse(app.buttons["everyday.save"].exists)
  }
  @MainActor func testUnsetManageOpensBlankLimits() {
    for lang in ["zh", "en"] {
    for id in ["muse.connect", "agent.grok-bot", "agent.claude", "agent.siri.connect"] {
      launch(lang, tab: "agents")
      let e = app.buttons[id]
      XCTAssertTrue(e.waitForExistence(timeout: 10))
      if !e.isHittable { app.swipeUp() }
      e.tap()
      XCTAssertTrue(limitsPageOpen())
      XCTAssertEqual(app.descendants(matching: .any)["ai.limits.state"].value as? String, "blank")
      XCTAssertFalse(app.staticTexts["debug.launch"].exists)
      XCTAssertFalse(app.buttons["gas.sign"].exists)
      app.terminate()
    }
    }
  }
  /// Demo floor is about 10.05 / 12.01 / 30.03. 40 total is over that boundary. Continue stays off and the chain editor is not opened.
  @MainActor func testTotalAboveWalletBoundaryDoesNotChangeChain() {
    for lang in ["zh", "en"] {
      launch(lang)
      app.descendants(matching: .any)["life.agent.muse"].tap()
      XCTAssertTrue(limitsPageOpen())
      typeLimits(["2", "5", "40"])
      let go = app.buttons["ai.limits.continue"]
      XCTAssertTrue(go.waitForExistence(timeout: 5))
      XCTAssertFalse(go.isEnabled)
      let cost = app.staticTexts["everyday.cost"]
      XCTAssertTrue(cost.waitForExistence(timeout: 5))
      let words = lang == "zh" ? "超过钱包安全上限" : "Above the wallet safety limit"
      XCTAssertTrue(cost.label.contains(words), cost.label)
      XCTAssertFalse(app.buttons["limits.sign"].exists)
      XCTAssertFalse(app.staticTexts["debug.launch"].exists)
      XCTAssertFalse(app.staticTexts["connect.done"].exists)
      app.terminate()
    }
  }
  @MainActor func testBackFromBlankLimitsDoesNotConnect() {
    launch("en")
    app.descendants(matching: .any)["life.agent.claude"].tap()
    XCTAssertTrue(limitsPageOpen())
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertFalse(app.staticTexts["debug.launch"].waitForExistence(timeout: 2))
  }
  @MainActor func testContinueStaysDisabledUntilTotalIsEntered() {
    launch("en")
    app.descendants(matching: .any)["life.agent.grok"].tap()
    XCTAssertTrue(limitsPageOpen())
    typeLimits(["2", "5"])
    let go = app.buttons["ai.limits.continue"]
    XCTAssertTrue(go.waitForExistence(timeout: 5))
    XCTAssertFalse(go.isEnabled)
    XCTAssertFalse(app.buttons["everyday.save"].exists)
    XCTAssertFalse(app.staticTexts["debug.launch"].exists)
  }
  /// A real approve-connect link with no saved policy opens the existing blank page, then the same request.
  @MainActor func testDeepLinkUnsetOpensBlankThenSameApproval() {
    launch("en", extra: ["-openURL", "kipurse://approve-connect?id=demoGrokBotReq01"])
    XCTAssertTrue(limitsPageOpen())
    XCTAssertEqual(app.descendants(matching: .any)["ai.limits.state"].value as? String, "blank")
    XCTAssertFalse(app.buttons["connect.approve"].exists)
    XCTAssertFalse(app.staticTexts["connect.done"].exists)
    typeLimits(["2", "5", "30"])
    let go = app.buttons["ai.limits.continue"]
    XCTAssertTrue(go.waitForExistence(timeout: 5)); XCTAssertTrue(go.isEnabled); go.tap()
    let approve = app.buttons["connect.approve"]
    XCTAssertTrue(approve.waitForExistence(timeout: 8))
    XCTAssertEqual(app.buttons.matching(identifier: "connect.approve").count, 1)
    XCTAssertEqual(approve.value as? String, "demoGrokBotReq01")
    let line = app.staticTexts["connect.limits"].label
    XCTAssertTrue(line.contains("2") && line.contains("5") && line.contains("30"), line)
    XCTAssertFalse(app.staticTexts["connect.done"].exists)
    XCTAssertFalse(app.staticTexts["debug.launch"].exists)
  }
  @MainActor func testDeepLinkMissingTotalDoesNotOpenApproval() {
    launch("en", extra: ["-openURL", "kipurse://approve-connect?id=demoGrokBotReq01"])
    XCTAssertTrue(limitsPageOpen())
    typeLimits(["2", "5"])
    let go = app.buttons["ai.limits.continue"]
    XCTAssertTrue(go.waitForExistence(timeout: 5))
    XCTAssertFalse(go.isEnabled)
    XCTAssertFalse(app.buttons["connect.approve"].exists)
    XCTAssertFalse(app.staticTexts["connect.done"].exists)
  }
  @MainActor func testDeepLinkBackAndCancelGrantNothing() {
    launch("zh", extra: ["-openURL", "kipurse://approve-connect?id=demoGrokBotReq01"])
    XCTAssertTrue(limitsPageOpen())
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertFalse(app.staticTexts["connect.done"].waitForExistence(timeout: 2))
    XCTAssertFalse(app.staticTexts["debug.launch"].exists)
    app.terminate()
    launch("zh", extra: ["-openURL", "kipurse://approve-connect?id=demoGrokBotReq01"])
    XCTAssertTrue(limitsPageOpen())
    typeLimits(["2", "5", "30"])
    app.buttons["ai.limits.continue"].tap()
    XCTAssertTrue(app.buttons["connect.approve"].waitForExistence(timeout: 8))
    app.buttons["connect.close"].tap()
    XCTAssertFalse(app.staticTexts["connect.done"].waitForExistence(timeout: 2))
    XCTAssertFalse(app.staticTexts["debug.launch"].exists)
  }
  @MainActor func testUnsetLifeOpensBlankLimitsZh() { checkUnsetOpensBlankLimits("zh") }
  @MainActor func testUnsetLifeOpensBlankLimitsEn() { checkUnsetOpensBlankLimits("en") }
  @MainActor func testLifeOneTapZh() { checkLife("zh") }
  @MainActor func testLifeOneTapEn() { checkLife("en") }
  @MainActor func testManageOneTapBothLanguages() {
    for lang in ["zh", "en"] {
      for id in ["muse.connect", "agent.grok-bot", "agent.claude", "agent.siri.connect"] {
        launch(lang, tab: "agents", extra: ["-kpAISaved", "2000000,5000000,30000000"])
        let e = app.buttons[id]; XCTAssertTrue(e.waitForExistence(timeout: 10)); if !e.isHittable { app.swipeUp() }; e.tap()
        if id == "agent.siri.connect" { XCTAssertTrue(app.buttons["gas.sign"].waitForExistence(timeout: 8)) }
        else { XCTAssertFalse(launched().isEmpty); XCTAssertFalse(app.buttons["muse.copyOpen"].exists) }
        app.terminate()
      }
    }
  }
  @MainActor func testLowBalanceCannotContinueToSigning() {
    launch("en", extra: ["-kpGasGateLow"])
    let deposit = app.buttons["gas.deposit"]
    let title = app.descendants(matching: .any)["gas.depositTitle"]
    for _ in 0..<6 where !deposit.exists && !title.exists { app.swipeUp() }
    XCTAssertTrue(deposit.waitForExistence(timeout: 20) || title.waitForExistence(timeout: 3))
    XCTAssertFalse(app.buttons["gas.sign"].exists)
    XCTAssertFalse(app.webViews.firstMatch.exists)
    shot("t1071-siri-low-balance-en")
  }
  @MainActor func testAlreadyAuthorizedSiriKeepsPhrases() {
    launch("en", extra: ["-kpSiriOn", "-kpAISaved", "2000000,5000000,30000000"])
    app.descendants(matching: .any)["life.agent.siri"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["siri.noSetup"].waitForExistence(timeout: 8))
    XCTAssertFalse(app.buttons["gas.sign"].exists)
    XCTAssertFalse(app.textFields["siri.intro.single"].exists)
    shot("t1071-siri-ready-en")
  }

  /// t1157: approved with no read session. The cache an old server left lists an empty "oauth-siri" row first and no saved limits;
  /// the connect reply's limits are applied (-kpT1157Reply). Home Siri shows [zh] (not [zh]) and a tap opens the phrases, never setup.
  @MainActor func checkT1157(_ lang: String) {
    launch(lang, extra: ["-kpT1157", "-kpT1157Reply", "-kpStaleCache", "-kpSiriOn"])
    let cell = app.descendants(matching: .any)["life.agent.siri"]; XCTAssertTrue(cell.waitForExistence(timeout: 10))
    XCTAssertTrue(cell.label.hasPrefix(lang == "zh" ? "Siri, 在线" : "Siri, Online"), cell.label)   // t1164 (decision 79): connected = always lit 在线
    XCTAssertFalse(cell.label.contains(lang == "zh" ? "未连接" : "Offline"), cell.label)   // t1245 U2: English status is "Offline"
    shot("t1157-home-siri-\(lang)")
    cell.tap()
    XCTAssertTrue(app.descendants(matching: .any)["siri.noSetup"].waitForExistence(timeout: 8), "phrases sheet")
    XCTAssertFalse(app.staticTexts["everyday.title"].exists, "not the limits page")
    XCTAssertFalse(app.buttons["gas.sign"].exists)
    shot("t1157-siri-phrases-\(lang)")
    app.terminate()
  }
  @MainActor func testT1157ApprovedNoSessionSiriLitAndPhrasesZh() { checkT1157("zh") }
  @MainActor func testT1157ApprovedNoSessionSiriLitAndPhrasesEn() { checkT1157("en") }
  /// t1158 (decision 77): Siri pays like every AI — the Siri phrases page carries the owner's sentence ([zh]) and says saved
  /// (trust-list) payees inside the allowance pay with no Face ID. Text only; same page, no new controls.
  @MainActor func checkT1158(_ lang: String) {
    func has(_ t: String) -> XCUIElement { app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", t)).firstMatch }
    func scrollFind(_ t: String) -> Bool { let e = has(t); var n = 0; while !e.exists && n < 4 { app.swipeUp(); sleep(1); n += 1 }; return e.exists }
    // Home (Life) Siri -> the Siri phrases sheet
    launch(lang, extra: ["-kpSiriOn", "-kpAISaved", "2000000,5000000,30000000"])
    let cell = app.descendants(matching: .any)["life.agent.siri"]; XCTAssertTrue(cell.waitForExistence(timeout: 10)); cell.tap()
    XCTAssertTrue(app.descendants(matching: .any)["siri.noSetup"].waitForExistence(timeout: 8), "phrases sheet")
    let say = lang == "zh" ? "用 Kipurse 帮我付款" : "help me pay with Kipurse"
    XCTAssertTrue(has(say).waitForExistence(timeout: 5), say)
    XCTAssertTrue(scrollFind(lang == "zh" ? "付给已保存的收款方会直接付" : "Siri pays saved payees right away"), "sheet footer")
    XCTAssertFalse(has(lang == "zh" ? "并用 Face ID 确认" : "asks for Face ID before paying").exists, "old footer gone")
    XCTAssertFalse(app.buttons["gas.sign"].exists)
    shot("t1158-siri-sheet-\(lang)")
    app.terminate()
    // AI page Siri -> the Siri buy page (same sentences, text only)
    app = XCUIApplication(); app.launchArguments = ["-demo", "main-all", "-tab", "agents", "-kp.lang", lang, "-kpSiriOn"]; app.launch()
    let siri = app.buttons["agent.siri.on"].firstMatch; XCTAssertTrue(siri.waitForExistence(timeout: 8)); siri.tap()
    XCTAssertTrue(app.descendants(matching: .any)["siri.noSetup"].firstMatch.waitForExistence(timeout: 6))
    XCTAssertTrue(has(say).waitForExistence(timeout: 5), say)
    XCTAssertTrue(scrollFind(lang == "zh" ? "信任名单里的或付过款的" : "on your trust list or paid before"), "buy page footer")
    shot("t1158-siri-buy-\(lang)")
    app.terminate()
  }
  @MainActor func testT1158SiriPayPhrasesZh() { checkT1158("zh") }
  @MainActor func testT1158SiriPayPhrasesEn() { checkT1158("en") }

  /// t1094: three amounts filled, wallet safety caps unset — never "[zh]", Continue stays off.
  @MainActor func testFilledAmountsWithUnsetCapsShowsReason() {
    for lang in ["zh", "en"] {
      launch(lang, extra: ["-kpCapsUnset"])
      app.descendants(matching: .any)["life.agent.muse"].tap()
      XCTAssertTrue(limitsPageOpen())
      typeLimits(["1000", "1000", "10000"])
      let go = app.buttons["ai.limits.continue"]
      XCTAssertTrue(go.waitForExistence(timeout: 5))
      XCTAssertFalse(go.isEnabled)
      let cost = app.staticTexts["everyday.cost"]
      XCTAssertTrue(cost.waitForExistence(timeout: 5))
      let words = lang == "zh" ? "请先在钱包页设置钱包安全上限" : "Set the wallet safety limit on the wallet page first"
      XCTAssertTrue(cost.label.contains(words), cost.label)
      XCTAssertFalse(cost.label.contains("请输入金额"), cost.label)
      XCTAssertFalse(cost.label.contains("Enter amounts"), cost.label)
      XCTAssertFalse(app.staticTexts["debug.launch"].exists)
      app.terminate()
    }
  }
  /// t1094: three amounts filled and demo wallet caps already set and within range — Continue is enabled.
  @MainActor func testFilledAmountsWithinDemoCapsEnablesContinue() {
    launch("zh")
    app.descendants(matching: .any)["life.agent.muse"].tap()
    XCTAssertTrue(limitsPageOpen())
    typeLimits(["2", "5", "30"])
    let go = app.buttons["ai.limits.continue"]
    XCTAssertTrue(go.waitForExistence(timeout: 5))
    XCTAssertTrue(go.isEnabled)
    let cost = app.staticTexts["everyday.cost"]
    XCTAssertTrue(cost.waitForExistence(timeout: 5))
    XCTAssertTrue(cost.label.contains("不收手续费") || cost.label.contains("马上生效"), cost.label)
    XCTAssertFalse(cost.label.contains("请输入金额"), cost.label)
    app.terminate()
  }
}
