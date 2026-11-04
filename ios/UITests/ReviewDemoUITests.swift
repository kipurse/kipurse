import XCTest

/// App Review path: a fresh install with no account opens the built-in demo (no sign-in, no server, no chain).
/// Runs in Release too. Set KP_SHOTS=<dir> to save App Store screenshots of each screen.
final class ReviewDemoUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  @MainActor func shot(_ app: XCUIApplication, _ name: String) {
    let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a)
    if let dir = ProcessInfo.processInfo.environment["KP_SHOTS"] ?? (FileManager.default.fileExists(atPath: "/tmp/kp-shots") ? "/tmp/kp-shots" : nil) {
      try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(UIScreen.main.nativeBounds.height)-\(name).png"))
    }
  }
  @MainActor func testReviewerDemoPath() {
    for lang in ["en", "zh"] {
      let app = XCUIApplication(); app.launchArguments = ["-kp.lang", lang]; app.launch()
      let demo = app.buttons["gate.demo"]; XCTAssertTrue(demo.waitForExistence(timeout: 15), "demo button on the first screen")
      shot(app, "\(lang)-1-welcome")
      demo.tap()
      let w = app.buttons.matching(identifier: "creditcard.fill").firstMatch; if w.waitForExistence(timeout: 10) { w.tap() }   // t800: demo opens on AI 生活; wallet is the second page
      XCTAssertTrue(app.buttons["home.deposit"].waitForExistence(timeout: 10), "demo wallet opens")
      XCTAssertTrue(app.staticTexts["demo.banner"].exists || app.otherElements["demo.banner"].exists || app.descendants(matching: .any)["demo.banner"].exists, "persistent demo banner")
      XCTAssertTrue(app.buttons["demo.exit"].exists, "exit demo button")
      sleep(1); shot(app, "\(lang)-2-home")
      for (i, icon) in ["sparkles", "gearshape.fill"].enumerated() { let b = app.buttons.matching(identifier: icon).firstMatch;   // t930: settings = the one 设置 tab
      XCTAssertTrue(b.waitForExistence(timeout: 5)); b.tap(); sleep(1); shot(app, "\(lang)-\(i + 3)-\(icon == "cpu.fill" ? "agents" : "settings")") }
      XCTAssertTrue(app.buttons["demo.exit"].exists, "banner still there on other screens"); app.buttons["demo.exit"].tap()
      XCTAssertTrue(app.buttons["gate.demo"].waitForExistence(timeout: 10), "exit demo goes back to sign-in")
      app.terminate()
    }
  }
}
