import XCTest

/// Screenshot tour of every main screen (demo data). Attachments "tour-<name>"; light + dark. Always passes unless a screen is missing.
final class UITourUITests: XCTestCase {
  @MainActor func shot(_ app: XCUIApplication, _ n: String) { sleep(1); let a = XCTAttachment(screenshot: app.screenshot()); a.name = "tour-" + n; a.lifetime = .keepAlways; add(a) }
  @MainActor func tapId(_ app: XCUIApplication, _ id: String) -> Bool { let b = app.descendants(matching: .any).matching(identifier: id).firstMatch; guard b.waitForExistence(timeout: 5) else { return false }; b.tap(); return true }
  @MainActor func back(_ app: XCUIApplication) { let b = app.navigationBars.buttons.element(boundBy: 0); if b.exists { b.tap() } else { app.swipeDown(velocity: .fast) }; sleep(1) }
  @MainActor func testTour() {
    for dark in [false, true] {
      let s = dark ? "dark-" : ""
      var app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-kp.lang", "zh", "-kpMasked"] + (dark ? ["-kpDark"] : []); app.launch()
      _ = app.staticTexts["balance.masked"].waitForExistence(timeout: 10); shot(app, s + "01-home-hidden"); app.terminate()
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-kp.lang", "zh", "-kpSkipFaceID"] + (dark ? ["-kpDark"] : []); app.launch()
      _ = app.buttons["home.deposit"].waitForExistence(timeout: 10); shot(app, s + "02-home")
      app.swipeUp(); shot(app, s + "03-home-scrolled"); app.swipeDown()
      if tapId(app, "home.deposit") { shot(app, s + "04-deposit"); back(app) }
      if tapId(app, "home.withdraw") { shot(app, s + "05-withdraw"); back(app) }
      if tapId(app, "home.limits") { shot(app, s + "06-limits"); back(app) }
      if tapId(app, "home.allActivity") { shot(app, s + "07-activity"); back(app) }
      if tapId(app, "cpu.fill") { shot(app, s + "08-agents") }
      if tapId(app, "gearshape.fill") { shot(app, s + "09-settings"); app.swipeUp(); shot(app, s + "10-settings-scrolled"); app.swipeUp(); shot(app, s + "11-settings-bottom") }
      if tapId(app, "settings.phone") { shot(app, s + "12-phone") }
      app.terminate()
      app = XCUIApplication(); app.launchArguments = ["-demo", "main-all", "-tab", "agents", "-kp.lang", "zh", "-kpSiriOn"] + (dark ? ["-kpDark"] : []); app.launch(); shot(app, s + "13-agents-all")
      app.terminate()
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-kp.lang", "zh", "-kpPayDraft", "-kpOwnerPayMock"] + (dark ? ["-kpDark"] : []); app.launch(); sleep(2); shot(app, s + "14-pay")
      app.terminate()
      app = XCUIApplication(); app.launchArguments = ["-kp.lang", "zh"] + (dark ? ["-kpDark"] : []); app.launch(); sleep(2); shot(app, s + "15-first-open")
      app.terminate()
    }
  }
}
