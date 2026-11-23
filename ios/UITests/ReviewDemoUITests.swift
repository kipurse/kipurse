import XCTest

/// t1054: the welcome page no longer offers an unauthenticated demo route.
/// Shared/Settings demo machinery is intentionally outside this welcome-only change.
final class ReviewDemoUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  @MainActor func testWelcomeHasNoReviewerDemoPath() {
    for lang in ["en", "zh"] {
      let app = XCUIApplication()
      app.launchArguments = ["-kpFreshInstall", "-kp.lang", lang]
      app.launch()
      XCTAssertTrue(app.buttons["cb.signin"].waitForExistence(timeout: 15))
      XCTAssertTrue(app.buttons["cb.register"].isHittable)
      XCTAssertFalse(app.buttons["gate.demo"].exists)
      XCTAssertFalse(app.buttons["Try the demo"].exists)
      XCTAssertFalse(app.buttons["先看看演示"].exists)
      XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "demo.banner").firstMatch.exists)
      app.buttons["cb.register"].tap()
      XCTAssertTrue(app.staticTexts["reg.title"].waitForExistence(timeout: 5))
      app.buttons["reg.back"].tap()
      XCTAssertTrue(app.buttons["cb.signin"].waitForExistence(timeout: 5))
      XCTAssertFalse(app.buttons["gate.demo"].exists)
      app.terminate()
    }
  }
}
