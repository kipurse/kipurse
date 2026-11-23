import XCTest
/// t771u: shots of the first-open steps and the Coinbase verify guide (normal + large text).
final class T771ShotsUITests: XCTestCase {
  var app: XCUIApplication!
  @MainActor func shot(_ n: String) { sleep(1); let a = XCTAttachment(screenshot: app.screenshot()); a.name = "t771-" + n; a.lifetime = .keepAlways; add(a) }
  @MainActor func go(_ args: [String]) { app?.terminate(); app = XCUIApplication(); app.launchArguments = args; app.launch(); sleep(3) }
  @MainActor func testShots() {
    continueAfterFailure = true
    for (tag, extra) in [("std", [String]()), ("xl", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"])] {
      go(["-kpFreshInstall", "-kp.lang", "zh"] + extra); shot(tag + "-first-open-1"); app.swipeUp(); shot(tag + "-first-open-2")
      go(["-demo", "main-new", "-tab", "home", "-kp.lang", "zh", "-kpSkipFaceID", "-kpApplePayMock", "-kpCBV", "no"] + extra)
      let d = app.descendants(matching: .any).matching(identifier: "home.deposit").firstMatch
      for _ in 0..<4 where !d.isHittable { app.swipeUp() }
      if d.waitForExistence(timeout: 3) { d.tap(); sleep(2)
        let ap = app.descendants(matching: .any).matching(identifier: "deposit.applepay").firstMatch
        for _ in 0..<4 where !ap.isHittable { app.swipeUp() }
        if ap.waitForExistence(timeout: 3) { ap.tap(); sleep(2); shot(tag + "-cbv-1"); app.swipeUp(); shot(tag + "-cbv-2")
          let nx = app.descendants(matching: .any).matching(identifier: "cbv.next1").firstMatch
          for _ in 0..<3 where !nx.isHittable { app.swipeDown() }
          if nx.exists { nx.tap(); sleep(1); shot(tag + "-cbv-step2")
            let o2 = app.descendants(matching: .any).matching(identifier: "cbv.open2").firstMatch; if o2.exists { o2.tap(); sleep(1); let l = app.staticTexts["cbv.debugOpen"]; if l.exists { XCTAssertEqual(l.label, "https://www.coinbase.com/onchain-verify") }; app.swipeUp(); shot(tag + "-cbv-step2-opened") } } } }
    }
  }
}
