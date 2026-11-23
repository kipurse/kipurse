import XCTest

/// Offline demo fixtures only: never presses Coinbase confirmation or saves limits.
final class T1056LimitsUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  private func shot(_ app: XCUIApplication, _ name: String) {
    let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
  }
  private func reveal(_ app: XCUIApplication, _ e: XCUIElement) {
    for _ in 0..<18 where !e.isHittable { app.swipeUp(); usleep(300_000) }   // t1209: let each scroll settle before re-checking
    var n = 0; while !e.isHittable && n < 6 { usleep(500_000); n += 1 }   // t1209: let scroll / keyboard animation settle under load (max 3 s); same assertion
    XCTAssertTrue(e.isHittable)
  }
  private func check(_ lang: String, ai: Bool = false) {
    let app = XCUIApplication()
    app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang,
      "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"]
    app.launch(); defer { app.terminate() }
    let tab = app.tabBars.buttons.element(boundBy: ai ? 0 : 1)
    XCTAssertTrue(tab.waitForExistence(timeout: 15)); tab.tap()
    let link = app.buttons[ai ? "life.aiLimit" : "wallet.totalLimit"]
    XCTAssertTrue(link.waitForExistence(timeout: 8))
    let title = ai ? (lang == "zh" ? "AI 花钱上限" : "AI spending limits") : (lang == "zh" ? "钱包安全上限" : "Wallet safety limits")
    XCTAssertTrue(link.label.contains(title))
    XCTAssertFalse(link.label.contains("设置 AI 总限额") || link.label.contains("Set AI total limit") || link.label.contains("设置钱包总限额") || link.label.contains("Set wallet total limit"))
    reveal(app, link); link.tap()
    XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 8))
    let titles = ai ? (lang == "zh" ? ["日常每笔最多", "日常每天最多"] : ["Everyday per payment", "Everyday per day"]) :
      (lang == "zh" ? ["每笔最多", "每天最多", "总额最多", "有效期"] : ["Per payment", "Per day", "Total", "Valid for"])
    // Localized titles are the existing AmountPicker title; enumerate fields in visual order
    // to also cover validity's number-pad, not just currency's decimal-pad.
    XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 8))
    for index in titles.indices {
      let field = app.textFields.element(boundBy: index)
      reveal(app, field); field.tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
      let done = app.buttons.matching(identifier: "amount.done")
      XCTAssertTrue(done.firstMatch.waitForExistence(timeout: 5))
      XCTAssertEqual(done.count, 1, "Only the focused AmountPicker may contribute Done")
      XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", lang == "zh" ? "完成" : "Done")).count, 1)
      if !ai && index == 2 {
        let current = field.value as? String ?? ""
        if !current.isEmpty { field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        field.typeText("100000")
        shot(app, "t1056-\(lang)-keyboard")
      }
      done.firstMatch.tap()
      XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
      XCTAssertEqual(app.buttons.matching(identifier: "amount.done").count, 0)
    }
    if !ai {
      // Scroll back to total's card, then verify its six examples and custom value.
      let total = app.textFields.element(boundBy: 2)
      for _ in 0..<4 where !total.isHittable { app.swipeDown() }
      for value in ["1000", "5000", "10000", "50000", "100000", "500000"] {
        let b = app.buttons.matching(NSPredicate(format: "label == %@", value + " USDC")).allElementsBoundByIndex
        XCTAssertFalse(b.isEmpty, "total preset \(value)")
      }
      XCTAssertTrue((total.value as? String)?.contains("100000") == true)
      // One downward swipe places daily's largest examples above the total ladder.
      app.swipeDown()
      shot(app, "t1056-\(lang)-presets")
    }
    I18nCheck.check(app, lang, "t1056 limits")
  }
  func testChineseWalletSingleDoneAndPresets() { check("zh") }
  func testEnglishWalletSingleDoneAndPresets() { check("en") }
  func testChineseEverydaySingleDone() { check("zh", ai: true) }
  func testEnglishEverydaySingleDone() { check("en", ai: true) }
}
