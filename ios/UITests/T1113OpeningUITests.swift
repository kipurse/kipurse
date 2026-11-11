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
    shot(app, "t1113-\(lang)-0-empty")
    let go = app.buttons["onboard.go"]
    reveal(app, go); XCTAssertFalse(go.isEnabled, "nothing entered")
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
