import XCTest
/// t934: the Terms of Service link exists exactly once (Settings → Help), next to the privacy policy.
final class T934SecurityUITests: XCTestCase {
  func testTermsLinkOnceInSettings() {
    continueAfterFailure = false
    let app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "settings", "-kp.lang", "zh"]; app.launch()
    XCTAssertTrue(app.navigationBars["设置"].waitForExistence(timeout: 8))
    let t = app.descendants(matching: .any).matching(identifier: "settings.terms")
    for _ in 0..<8 where !t.firstMatch.exists || !t.firstMatch.isHittable { app.swipeUp() }
    XCTAssertTrue(t.firstMatch.exists, "Terms link in Settings")
    XCTAssertEqual(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ AND (elementType == %d OR elementType == %d)", "服务条款", XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.link.rawValue)).count, 1, "exactly one Terms entry")
  }
}
