import XCTest

/// t1214 (decision 101): the V5.4 switch screen exists ONLY in the developer/test build (KP_DEV_MIGRATION, Debug) and only on opt-in;
/// demo / screenshot runs never show it. The Release build has no such code at all (checked on the binary by the install step).
final class T1214DevMigrationUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  func launch(_ lang: String, dev: Bool) {
    app = XCUIApplication()
    app.launchArguments = ["-demo", "main", "-tab", "settings", "-kp.lang", lang, "-kpSkipFaceID", "-kpStill",
                           "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"] + (dev ? ["-kpDevMigration"] : [])
    app.launch()
  }
  func find(_ id: String) -> XCUIElement { let e = app.descendants(matching: .any)[id]; var n = 0; while !e.exists && n < 6 { app.swipeUp(); n += 1 }; return e }
  @MainActor func run(_ lang: String) {
    launch(lang, dev: false); XCTAssertTrue(app.buttons["settings.phone"].waitForExistence(timeout: 10))
    XCTAssertFalse(find("settings.devMigration").exists, "demo/screenshot runs never show the dev screen"); app.terminate()
    launch(lang, dev: true); XCTAssertTrue(app.buttons["settings.phone"].waitForExistence(timeout: 10))
    let row = find("settings.devMigration"); XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap()
    XCTAssertTrue(app.buttons["devmig.load"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", lang == "zh" ? "仅开发者测试版" : "Developer test build only")).firstMatch.exists)
  }
  @MainActor func testDevScreenZh() { run("zh") }
  @MainActor func testDevScreenEn() { run("en") }
}
