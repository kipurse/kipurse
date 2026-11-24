// SPDX-License-Identifier: Apache-2.0
import XCTest

/// t1280b (§6#140, owner: 「重复购买的卡片也改成专门提示」): a suspected-duplicate card says so and offers only
/// 「再付一次」 + 「拒绝」 — never 「认识并信任」 / 「只付这一次」 (zh/en).
final class T1280DupCardUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  func launch(_ lang: String) {
    app = XCUIApplication()
    app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", lang, "-kpSkipFaceID", "-kpStill", "-kpDupDemo",
                           "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"]
    app.launch()
  }
  func reveal(_ e: XCUIElement) { var n = 0; while !e.isHittable && n < 8 { app.swipeUp(); n += 1 } }
  func shot(_ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
  @MainActor func run(_ lang: String, choice: String) {
    launch(lang)
    let card = app.descendants(matching: .any)["allow.card.pending"]; XCTAssertTrue(card.waitForExistence(timeout: 10)); reveal(card); card.tap()
    let again = app.buttons["allow.ask.again"], no = app.buttons["allow.pending.reject"]
    XCTAssertTrue(again.waitForExistence(timeout: 6)); XCTAssertTrue(no.exists)
    XCTAssertTrue(again.label.contains(lang == "zh" ? "再付一次" : "Pay again"), again.label)
    XCTAssertFalse(app.buttons["allow.ask.trust"].exists, "a duplicate card never offers trust")
    XCTAssertFalse(app.buttons["allow.ask.once"].exists); XCTAssertFalse(app.buttons["allow.pending.approve"].exists)
    let body = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", lang == "zh" ? "疑似重复购买" : "Possible duplicate")).firstMatch
    XCTAssertTrue(body.exists, "the card says it looks like a duplicate"); shot("\(lang)-dup-card")
    (choice == "again" ? again : no).tap()
    XCTAssertTrue(again.waitForNonExistence(timeout: 5)); shot("\(lang)-dup-\(choice)")
  }
  @MainActor func testDupCardAgainZh() { run("zh", choice: "again") }
  @MainActor func testDupCardDeclineEn() { run("en", choice: "reject") }
}
