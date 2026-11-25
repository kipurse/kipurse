import XCTest

final class T1043RescueCopyUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  func testChineseOfflineGuideExplainsSpareUSDC() { check("zh") }
  func testEnglishOfflineGuideExplainsSpareUSDC() { check("en") }

  private func check(_ lang: String) {
    let app = XCUIApplication()
    let systemLang = lang == "zh" ? "zh-Hans" : "en"
    app.launchArguments = ["-demo", "main", "-tab", "settings", "-kp.lang", lang, "-kpSkipFaceID", "-AppleLanguages", "(\(systemLang))", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"]
    app.launch(); defer { app.terminate() }
    let entry = app.descendants(matching: .any).matching(identifier: "settings.lostPhone").firstMatch
    XCTAssertTrue(entry.waitForExistence(timeout: 12))
    for _ in 0..<10 where !entry.isHittable { app.swipeUp() }
    XCTAssertTrue(entry.isHittable)
    entry.tap()
    let heading = app.staticTexts["lost.title"].firstMatch
    XCTAssertTrue(heading.waitForExistence(timeout: 8))
    XCTAssertEqual(heading.label, lang == "zh" ? "手机丢了怎么办" : "Lost your phone?")
    XCTAssertTrue(heading.isHittable)
    let first = app.descendants(matching: .any).matching(identifier: "lost.step1").firstMatch
    XCTAssertTrue(first.exists)
    let feeStep = app.descendants(matching: .any).matching(identifier: "lost.step3").firstMatch
    for _ in 0..<6 where !feeStep.isHittable { app.swipeUp() }
    let explanation = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", lang == "zh" ? "不从启付余额扣" : "not from your Kipurse balance")).firstMatch
    XCTAssertTrue(explanation.exists)
    let fee = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", lang == "zh" ? "大约 1 美元就够" : "about $1 is enough")).firstMatch
    XCTAssertTrue(fee.exists)
    XCTAssertTrue(fee.label.contains(lang == "zh" ? "不到 0.01 美元" : "under $0.01"))
    I18nCheck.check(app, lang, "t1044 no-App guide fee copy")
    let fallback = app.descendants(matching: .any).matching(identifier: "rescue.appFallback").firstMatch
    for _ in 0..<10 where !fallback.isHittable { app.swipeUp() }
    XCTAssertTrue(fallback.isHittable)
    XCTAssertFalse(app.buttons["rescue.prepare"].exists, "App-only controls must start folded")
    let gap = app.staticTexts["lost.publicPageNote"]
    XCTAssertTrue(gap.exists)
    let fourth = app.descendants(matching: .any).matching(identifier: "lost.step4").firstMatch
    XCTAssertTrue(fourth.exists)
    let auto = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", lang == "zh" ? "页面会自动找到" : "page automatically finds")).firstMatch
    XCTAssertTrue(auto.exists)
    // t1245 (decision 115 U39): the address now sits on its own line under this step (never split after "https://"); same URL.
    let url = app.descendants(matching: .any).matching(identifier: "lost.url").firstMatch
    XCTAssertTrue(url.exists); XCTAssertTrue(url.label.contains("https://kipurse.github.io/rescue/"), url.label)
    for banned in ["之前保存", "完整链接", "截图", "PDF", "saved earlier", "complete recovery link"] { XCTAssertFalse(auto.label.contains(banned)) }
    I18nCheck.check(app, lang, "t1045 automatic no-backup recovery and folded backup")
  }
}
