// SPDX-License-Identifier: Apache-2.0
import XCTest

/// t1281 (owner decision decision 141 (1)): [zh] — the owner's own stranger limit, on the opening page and the wallet safety limits page.
/// Default ON ([zh] / Same as my normal limits); turning it off shows the two pickers ([zh]). zh + en.
/// Opening: the simulator onboarding route with no server behind it (the form renders; never taps [zh]). Limits: the offline demo
/// wallet (never taps [zh]). Nothing is signed or sent.
final class T1281StrangerCapUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  private func shot(_ app: XCUIApplication, _ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
  private func reveal(_ app: XCUIApplication, _ e: XCUIElement) {
    for _ in 0..<18 where !e.isHittable { app.swipeUp(); usleep(300_000) }
    for _ in 0..<18 where !e.isHittable { app.swipeDown(); usleep(300_000) }
    XCTAssertTrue(e.isHittable, e.identifier)
  }
  private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
  private func cjk(_ s: String) -> Bool { s.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) || (0x3000...0x303F).contains($0.value) || (0xFF00...0xFFEF).contains($0.value) } }
  private func lang(_ l: String) -> [String] { ["-kp.lang", l, "-AppleLanguages", l == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", l == "zh" ? "zh_CN" : "en_US"] }

  /// The block itself: default ON, pickers hidden; OFF shows exactly the two pickers; ON again hides them.
  private func checkBlock(_ app: XCUIApplication, prefix p: String, zh: Bool, shotName: String) {
    let card = any(app, "\(p).stranger"); reveal(app, card)
    let title = app.staticTexts["\(p).stranger.title"]; XCTAssertTrue(title.exists)
    XCTAssertEqual(title.label, zh ? "付给陌生收款方" : "Paying new payees")
    let explain = app.staticTexts["\(p).stranger.explain"]; XCTAssertTrue(explain.exists)
    XCTAssertEqual(explain.label, zh ? "陌生收款方 = 你没信任过、也不是认证商家的收款方。每天的数含手续费；所有陌生收款方共用这一个额度。"
                                     : "A new payee is one you haven't trusted and that isn't a verified merchant. The per-day amount includes fees, and all new payees share this one limit.")
    let same = app.switches["\(p).stranger.same"]; reveal(app, same)
    XCTAssertEqual(same.value as? String, "1", "default: same as the normal limits")
    XCTAssertTrue(same.label.contains(zh ? "和普通额度一样" : "Same as my normal limits"), same.label)
    XCTAssertFalse(any(app, "\(p).stranger.single").exists); XCTAssertFalse(any(app, "\(p).stranger.daily").exists)
    if !zh { for t in [title.label, explain.label, same.label] { XCTAssertFalse(cjk(t), "Chinese in English UI: \(t)") } }
    shot(app, "\(shotName)-0-default")
    // the switch knob sits at the trailing edge of the row
    same.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    let single = any(app, "\(p).stranger.single"), daily = any(app, "\(p).stranger.daily")
    XCTAssertTrue(single.waitForExistence(timeout: 5)); XCTAssertTrue(daily.exists)
    XCTAssertEqual(same.value as? String, "0")
    XCTAssertTrue(single.staticTexts[zh ? "每笔最多" : "Per payment, at most"].exists)
    XCTAssertTrue(daily.staticTexts[zh ? "每天最多（含手续费）" : "Per day, at most (fees included)"].exists)
    if !zh { for q in [app.buttons, app.staticTexts] { for e in q.allElementsBoundByIndex where e.exists { XCTAssertFalse(cjk(e.label), "Chinese in English UI: \(e.label)") } } }
    reveal(app, single); shot(app, "\(shotName)-1-own")
    reveal(app, same); same.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    XCTAssertTrue(single.waitForNonExistence(timeout: 5)); XCTAssertFalse(daily.exists)
  }

  private func opening(_ l: String) {
    let zh = l == "zh", app = XCUIApplication()
    // simulator onboarding route without a server behind it: the form renders (no quote), nothing can be sent or signed
    app.launchArguments = ["-kpOnboard", "-kpOnboardServer", "http://127.0.0.1:18699", "-kpIdentityOK"] + lang(l)
    app.launch(); defer { app.terminate() }
    let gate = app.buttons["gate.onboard"]; XCTAssertTrue(gate.waitForExistence(timeout: 15)); gate.tap()
    XCTAssertTrue(app.staticTexts["onboard.step1"].waitForExistence(timeout: 10))
    checkBlock(app, prefix: "onboard", zh: zh, shotName: "t1281-onboard-\(l)")
  }
  func testOpeningStrangerBlockZh() { opening("zh") }
  func testOpeningStrangerBlockEn() { opening("en") }

  private func limits(_ l: String) {
    let zh = l == "zh", app = XCUIApplication()
    app.launchArguments = ["-demo", "main", "-tab", "home"] + lang(l)
    app.launch(); defer { app.terminate() }
    let tab = app.tabBars.buttons.element(boundBy: 1); XCTAssertTrue(tab.waitForExistence(timeout: 15)); tab.tap()
    let link = app.buttons["wallet.totalLimit"]; XCTAssertTrue(link.waitForExistence(timeout: 8)); reveal(app, link); link.tap()
    XCTAssertTrue(app.staticTexts[zh ? "钱包安全上限" : "Wallet safety limits"].waitForExistence(timeout: 8))
    checkBlock(app, prefix: "limits", zh: zh, shotName: "t1281-limits-\(l)")
    // the summary states the stranger limit too (the existing limits.summary line is unchanged)
    let sum = app.staticTexts["limits.stranger.summary"]; reveal(app, sum)
    XCTAssertTrue(sum.label.hasPrefix(zh ? "付给陌生收款方：和普通额度一样" : "New payees: same as your normal limits"), sum.label)
    if !zh { XCTAssertFalse(cjk(sum.label), sum.label) }
    shot(app, "t1281-limits-\(l)-2-summary")
  }
  func testLimitsStrangerBlockZh() { limits("zh") }
  func testLimitsStrangerBlockEn() { limits("en") }
}
