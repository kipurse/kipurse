import XCTest

/// t1113u (§6#59): no silent default limits; 充值并开通 stays disabled until all three limits are entered;
/// one added footnote states the minimum Base USDC at opening. Uses a local quote mock only; never taps 充值并开通.
final class T1113OpeningUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  private func shot(_ app: XCUIApplication, _ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
  private func reveal(_ app: XCUIApplication, _ e: XCUIElement) { for _ in 0..<10 where !e.isHittable { app.swipeUp() }; for _ in 0..<20 where !e.isHittable { app.swipeDown() } }
  private func preset(_ app: XCUIApplication, _ label: String, _ i: Int) { let e = app.buttons.matching(NSPredicate(format: "label == %@", label)).element(boundBy: i); reveal(app, e); XCTAssertTrue(e.isHittable, label); e.tap() }
  private func waitLabel(_ e: XCUIElement, _ s: String) { expectation(for: NSPredicate(format: "label CONTAINS %@", s), evaluatedWith: e); waitForExpectations(timeout: 15) }

  private func run(_ lang: String) throws {
    guard DispatchQueue.global().sync(execute: { try? String(contentsOf: URL(string: "http://127.0.0.1:18681/onboard/new/quote")!) }) != nil else { throw XCTSkip("needs the t1113 quote mock on 127.0.0.1:18681") }
    let zh = lang == "zh"
    let app = XCUIApplication()
    app.launchArguments = ["-kpOnboard", "-kpOnboardServer", "http://127.0.0.1:18681", "-kp.lang", lang, "-kpIdentityOK",
      "-AppleLanguages", zh ? "(zh-Hans)" : "(en)", "-AppleLocale", zh ? "zh_CN" : "en_US"]
    app.launch(); defer { app.terminate() }
    let gate = app.buttons["gate.onboard"]; XCTAssertTrue(gate.waitForExistence(timeout: 15)); gate.tap()
    let minBase = app.staticTexts["onboard.minBase"]; XCTAssertTrue(minBase.waitForExistence(timeout: 10))
    waitLabel(minBase, "1.064182 USDC")
    XCTAssertTrue(minBase.label.contains(zh ? "开户时你的 Coinbase 钱包（Base 账户）里至少要有约 1.064182 USDC" : "At opening your Coinbase wallet (Base account) needs at least about 1.064182 USDC"), minBase.label)
    XCTAssertFalse(minBase.label.contains("ETH"))
    // t1114u (§6#60): the fee is charged separately from the Base account, on top of the deposit; button is English in English.
    let fee = app.staticTexts["onboard.feeNote"]; XCTAssertTrue(fee.waitForExistence(timeout: 10)); waitLabel(fee, "0.064182 USDC")
    XCTAssertEqual(fee.label, zh ? "开通手续费约 0.064182 USDC（按实际网络费），在充值之外另从你的 Coinbase 钱包（Base 账户）扣，不从这次充值里扣；Kipurse 不出这笔钱。"
                                 : "Opening fee about 0.064182 USDC (actual network cost), charged separately from your Coinbase wallet (Base account) on top of your deposit, not taken out of this deposit. Kipurse does not pay it.")
    XCTAssertFalse(fee.label.contains("从你这次充值里扣") || fee.label.contains(", taken from this deposit"), fee.label)
    shot(app, "t1113-\(lang)-0-empty")
    let go = app.buttons["onboard.go"]
    reveal(app, go); XCTAssertFalse(go.isEnabled, "nothing entered")
    XCTAssertEqual(go.label, zh ? "充值并开通" : "Deposit and open")
    if !zh {
      let cjk: (String) -> Bool = { $0.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) || (0x3000...0x303F).contains($0.value) || (0xFF00...0xFFEF).contains($0.value) } }
      XCTAssertFalse(cjk(go.label), go.label); XCTAssertFalse(cjk(fee.label), fee.label); XCTAssertFalse(cjk(minBase.label), minBase.label)
      for q in [app.buttons, app.staticTexts] { for e in q.allElementsBoundByIndex where e.exists { XCTAssertFalse(cjk(e.label), "Chinese in English UI: \(e.label)") } }
    }
    preset(app, "5 USDC", 0)   // deposit
    waitLabel(minBase, "5.064182 USDC")
    reveal(app, go); XCTAssertFalse(go.isEnabled, "t1113u: deposit only, no limits -> disabled (no silent default plan)")
    shot(app, "t1113-\(lang)-1-deposit-only")
    let manual = app.buttons[zh ? "自己填" : "Enter manually"].firstMatch
    reveal(app, manual); manual.tap()
    preset(app, "2 USDC", 0)   // each payment
    reveal(app, go); XCTAssertFalse(go.isEnabled, "one limit only")
    preset(app, "20 USDC", 0)  // per day
    reveal(app, go); XCTAssertFalse(go.isEnabled, "two limits only")
    shot(app, "t1113-\(lang)-2-two-limits")
    preset(app, "200 USDC", 0) // total
    reveal(app, go); XCTAssertTrue(go.isEnabled, "all three limits + deposit + quote -> enabled")
    shot(app, "t1113-\(lang)-3-ready")
    // never tapped: no opening request is sent
  }
  func testOpeningNeedsThreeLimitsZh() throws { try run("zh") }
  func testOpeningNeedsThreeLimitsEn() throws { try run("en") }
}

/// t1185u (§6#86): the opening page states the 0.15 USDC that goes into the wallet's fee reserve (owner's money) in the existing
/// fee note and minimum line (text only, no new elements). Uses a local quote mock with vaultSeedUSDC; never taps 充值并开通.
final class T1186OpeningSeedUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  private func shot(_ app: XCUIApplication, _ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
  private func waitLabel(_ e: XCUIElement, _ s: String) { expectation(for: NSPredicate(format: "label CONTAINS %@", s), evaluatedWith: e); waitForExpectations(timeout: 15) }
  private func run(_ lang: String) throws {
    guard DispatchQueue.global().sync(execute: { try? String(contentsOf: URL(string: "http://127.0.0.1:18682/onboard/new/quote")!) }) != nil else { throw XCTSkip("needs the t1186 quote mock on 127.0.0.1:18682") }
    let zh = lang == "zh"; let app = XCUIApplication()
    app.launchArguments = ["-kpOnboard", "-kpOnboardServer", "http://127.0.0.1:18682", "-kp.lang", lang, "-kpIdentityOK", "-AppleLanguages", zh ? "(zh-Hans)" : "(en)", "-AppleLocale", zh ? "zh_CN" : "en_US"]
    app.launch(); defer { app.terminate() }
    let gate = app.buttons["gate.onboard"]; XCTAssertTrue(gate.waitForExistence(timeout: 15)); gate.tap()
    let fee = app.staticTexts["onboard.feeNote"]; XCTAssertTrue(fee.waitForExistence(timeout: 10)); waitLabel(fee, "0.15 USDC")
    XCTAssertTrue(fee.label.hasSuffix(zh ? "另放 0.15 USDC 到你钱包的手续费备用金，用来付 AI 付款的手续费。钱还是你的，取回时一起退给你。"
                                         : "Plus 0.15 USDC into your wallet's fee reserve to cover network fees for AI payments. It is still your money and comes back when you withdraw."), fee.label)
    let minBase = app.staticTexts["onboard.minBase"]; XCTAssertTrue(minBase.exists); waitLabel(minBase, "1.214182 USDC")
    XCTAssertTrue(minBase.label.contains(zh ? "手续费备用金 0.15 USDC（还是你的钱）" : "fee reserve 0.15 USDC (still your money)"), minBase.label)
    for t in [fee.label, minBase.label] { XCTAssertNil(t.range(of: "失败|错误|危险|被盗|error|fail|danger|stolen|ETH", options: [.regularExpression, .caseInsensitive]), t) }
    shot(app, "t1186-\(lang)-opening-seed")
    let go = app.buttons["onboard.go"]; for _ in 0..<10 where !go.isHittable { app.swipeUp() }; XCTAssertFalse(go.isEnabled, "nothing entered yet")
    shot(app, "t1186-\(lang)-opening-seed-bottom")
  }
  func testOpeningShowsFeeReserveZh() throws { try run("zh") }
  func testOpeningShowsFeeReserveEn() throws { try run("en") }
}
