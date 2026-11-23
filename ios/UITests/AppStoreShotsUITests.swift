import XCTest

/// App Store screenshots in demo mode (sample data, no server, no chain, no testnet UI). Run on a device or simulator; the shots
/// are XCTest attachments named <lang>-<n>-<screen>.
final class AppStoreShotsUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  @MainActor func shot(_ app: XCUIApplication, _ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = "store-" + name; a.lifetime = .keepAlways; add(a) }
  @MainActor func go(_ app: XCUIApplication, _ icon: String) { let b = app.buttons.matching(identifier: icon).firstMatch; XCTAssertTrue(b.waitForExistence(timeout: 5)); b.tap(); sleep(1) }
  @MainActor func testAppStoreShots() {
    for lang in ["en", "zh"] {
      var app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-kpMasked"]; app.launch()   // t803: balance lives on 钱包 (default tab is AI 生活 since t665)
      XCTAssertTrue(app.staticTexts["balance.masked"].waitForExistence(timeout: 10)); sleep(1)
      XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] %@", "testnet")).firstMatch.exists)
      XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "测试网")).firstMatch.exists)
      shot(app, "\(lang)-1-home-hidden"); app.terminate()
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang]; app.launch()
      XCTAssertTrue(app.buttons["home.deposit"].waitForExistence(timeout: 10)); sleep(1); shot(app, "\(lang)-2-home")
      app.terminate()
      // t803: 智能体 and 设置 are pages inside the two tabs now (t665), not tab-bar icons
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "agents", "-kp.lang", lang]; app.launch(); sleep(2); shot(app, "\(lang)-3-agents")
      app.terminate()
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", lang]; app.launch()   // §6#110: pause lives on AI 生活
      let pz = app.descendants(matching: .any)["safety.pause"].firstMatch; XCTAssertTrue(pz.waitForExistence(timeout: 8)); for _ in 0..<8 where !pz.isHittable { app.swipeUp() }; shot(app, "\(lang)-4-safety")
      app.terminate()
    }
  }
}
