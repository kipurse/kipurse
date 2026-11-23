import XCTest

/// t1170u (§6#82): a NEW payee above the AI auto limit -> the waiting card shows the FULL address and three buttons
/// 「认识并信任」「只付这一次」「拒绝」 (zh/en). Every other waiting card keeps the old two buttons (UI frozen otherwise).
final class T1170OwnerAskUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  func launch(_ lang: String, ask: Bool) {
    app = XCUIApplication()
    app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", lang, "-kpSkipFaceID", "-kpStill",   // §6#110: 待你批准 lives on AI 生活
                           "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"] + (ask ? ["-kpAskDemo"] : [])
    app.launch()
  }
  func reveal(_ e: XCUIElement) { var n = 0; while !e.isHittable && n < 8 { app.swipeUp(); n += 1 } }
  func shot(_ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
  func openCard() { let card = app.descendants(matching: .any)["allow.card.pending"]; _ = card.waitForExistence(timeout: 10); reveal(card); XCTAssertTrue(card.exists); card.tap() }
  @MainActor func run(_ lang: String, choice: String) {
    launch(lang, ask: true); openCard()
    let trust = app.buttons["allow.ask.trust"], once = app.buttons["allow.ask.once"], no = app.buttons["allow.pending.reject"]
    XCTAssertTrue(trust.waitForExistence(timeout: 6)); XCTAssertTrue(once.exists); XCTAssertTrue(no.exists)
    XCTAssertFalse(app.buttons["allow.pending.approve"].exists, "an ask card has no plain approve button")
    XCTAssertTrue(trust.label.contains(lang == "zh" ? "认识并信任" : "Trust this payee"), trust.label)
    XCTAssertTrue(once.label.contains(lang == "zh" ? "只付这一次" : "Pay just this once"), once.label)
    let addr = app.descendants(matching: .any)["allow.ask.address"]; XCTAssertTrue(addr.exists)
    XCTAssertTrue(addr.label.contains("0x 1212 1212 1212 1212 1212 1212 1212 1212 1212 3434"), "full address: " + addr.label)
    let body = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", lang == "zh" ? "⚠️ 新收款方 0x1212…3434" : "⚠️ NEW payee 0x1212…3434")).firstMatch
    XCTAssertTrue(body.exists, "card text starts with the payee, AI text last"); shot("\(lang)-ask-card")
    (choice == "trust" ? trust : choice == "once" ? once : no).tap()
    XCTAssertTrue(trust.waitForNonExistence(timeout: 5)); shot("\(lang)-ask-\(choice)")
  }
  @MainActor func testAskCardTrustZh() { run("zh", choice: "trust") }
  @MainActor func testAskCardOnceEn() { run("en", choice: "once") }
  @MainActor func testAskCardDeclineZh() { run("zh", choice: "reject") }
  @MainActor func testAskCardTrustEn() { run("en", choice: "trust") }
  /// The default demo (App Store / audit screenshots) is unchanged: one normal card with the old two buttons.
  @MainActor func testNormalCardUnchanged() {
    for lang in ["zh", "en"] { launch(lang, ask: false); openCard()
      XCTAssertTrue(app.buttons["allow.pending.approve"].waitForExistence(timeout: 6)); XCTAssertTrue(app.buttons["allow.pending.reject"].exists)
      XCTAssertFalse(app.buttons["allow.ask.trust"].exists); XCTAssertFalse(app.buttons["allow.ask.once"].exists); shot("\(lang)-normal-card"); app.terminate() }
  }
}
