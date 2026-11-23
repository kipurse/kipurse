import XCTest

/// t665 v6 two-page redesign screenshots ("rd-<lang>-<name>"). Sample demo data only.
final class V6ShotsUITests: XCTestCase {
  var app: XCUIApplication!
  @MainActor func shot(_ n: String, wait: UInt32 = 1) { sleep(wait); let a = XCTAttachment(screenshot: app.screenshot()); a.name = "rd-" + n; a.lifetime = .keepAlways; add(a) }
  @MainActor func go(_ args: [String], wait: UInt32 = 3) { app?.terminate(); app = XCUIApplication(); app.launchArguments = args; app.launch(); sleep(wait) }
  @MainActor func tap(_ id: String) -> Bool { let b = app.descendants(matching: .any).matching(identifier: id).firstMatch; guard b.waitForExistence(timeout: 5) else { return false }; var i = 0; while !b.isHittable && i < 6 { app.swipeUp(); i += 1 }; b.tap(); sleep(1); return true }
  @MainActor func testV6Shots() {
    continueAfterFailure = true
    let langs = (ProcessInfo.processInfo.environment["RD_LANGS"] ?? "zh").split(separator: ",").map(String.init)
    for L in langs {
      let p = L + "-", base = ["-demo", "main", "-kp.lang", L, "-kpSkipFaceID", "-kpLifeDemo"]
      go(base + ["-tab", "life"]); shot(p + "page1"); app.swipeUp(); shot(p + "page1-s1")
      go(base + ["-tab", "life", "-kpCelebrate"], wait: 0)
      let c = app.buttons[L == "zh" ? "查看收据" : "View receipt"]; _ = c.waitForExistence(timeout: 8); RunLoop.current.run(until: Date().addingTimeInterval(0.7)); shot(p + "celebration", wait: 0)
      RunLoop.current.run(until: Date().addingTimeInterval(0.6)); shot(p + "celebration-b", wait: 0)
      go(base + ["-tab", "home"]); shot(p + "page2"); app.swipeUp(); shot(p + "page2-s1"); app.swipeUp(); shot(p + "page2-s2")
      go(base + ["-tab", "life"]); if tap("life.tx.0") { shot(p + "receipt") }
      go(base + ["-tab", "agents"]); shot(p + "agents")
      go(base + ["-tab", "settings"]); shot(p + "settings")
      go(base + ["-tab", "settings"]); if tap("settings.phone") { shot(p + "faceid-approvals") }
      go(["-demo", "main", "-tab", "home", "-kp.lang", L, "-kpApplePayMock", "-kpCBV", "later"]); if tap("home.deposit") { shot(p + "deposit"); if tap("deposit.applepay") { shot(p + "applepay-needs-verify") } }
      go(base + ["-tab", "home"]); if tap("home.withdraw") { shot(p + "withdraw") }
      go(["-demo", "main", "-kp.lang", L, "-kpSkipFaceID", "-tab", "life"]); shot(p + "page1-realdemo")
      go(["-demo", "main-new", "-kp.lang", L, "-kpSkipFaceID", "-tab", "life"]); shot(p + "page1-empty")
      go(base + ["-tab", "life", "-kpLight"]); shot(p + "page1-light")
      go(["-demo", "main-nomuse", "-kp.lang", L, "-kpSkipFaceID", "-tab", "life"]); shot(p + "muse-offline")
      go(base + ["-tab", "life"]); RunLoop.current.run(until: Date().addingTimeInterval(1.1)); shot(p + "muse-lit-b", wait: 0)
    }
  }
}
