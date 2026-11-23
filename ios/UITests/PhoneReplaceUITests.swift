import XCTest

/// t843: no local Face ID key + server says approvals are on elsewhere -> offer "turn on for this phone" (replaces the old one), never a dead end.
final class PhoneReplaceUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  func run(_ lang: String, button: String, note: String) {
    let app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-kp.lang", lang, "-AppleLanguages", "(\(lang))", "-kpSkipFaceID", "-kpMockPhoneActive", "YES", "-tab", "settings"]; app.launch()
    let cell = app.descendants(matching: .any)["settings.phone"].firstMatch
    for _ in 0..<6 where !cell.exists { app.swipeUp() }
    XCTAssertTrue(cell.waitForExistence(timeout: 8), "Face ID approvals row"); cell.tap()
    let b = app.buttons["phone.replace"]; XCTAssertTrue(b.waitForExistence(timeout: 8), "enable-on-this-phone button"); XCTAssertTrue(b.label.contains(button), b.label)
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", note)).firstMatch.exists, note)
    XCTAssertFalse(app.descendants(matching: .any)["phone.keyMissing"].exists, "old dead-end text gone")
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "ETH")).firstMatch.exists, "no ETH wording")
  }
  func testReplaceOfferedZh() { run("zh-Hans", button: "在这台手机开启", note: "自动失效") }
  func testReplaceOfferedEn() { run("en", button: "Turn on for this phone", note: "automatically retires") }
}
