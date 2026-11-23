import XCTest

/// App Store screenshots (6.9", demo mode, sample data only: no server, no chain, nothing signed).
/// A tool, not a gate. Attachments are named "store26-<lang>-<n>-<screen>"; the export script copies them to AppStore/screenshots.
final class StoreShots2026UITests: XCTestCase {
  var app: XCUIApplication!
  var L = "en"
  @MainActor func shot(_ n: String) { sleep(2); let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); a.name = "store26-" + L + "-" + n; a.lifetime = .keepAlways; add(a) }
  @MainActor func go(_ tab: String, _ extra: [String] = []) {
    app?.terminate(); app = XCUIApplication()
    app.launchArguments = ["-demo", "main", "-tab", tab, "-kp.lang", L, "-kpSkipFaceID", "-kpStill",
                           "-AppleLanguages", L == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", L == "zh" ? "zh_CN" : "en_US"] + extra
    app.launch(); sleep(3)
  }
  @MainActor func el(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
  @MainActor func tap(_ id: String, scroll: Int = 8) -> Bool {
    let b = el(id); guard b.waitForExistence(timeout: 6) else { return false }
    var i = 0; while !b.isHittable && i < scroll { app.swipeUp(); i += 1 }
    guard b.isHittable else { return false }; b.tap(); sleep(2); return true
  }
  @MainActor func walk() {
    continueAfterFailure = true
    go("life", ["-kpLifeDemo"]); shot("01-ailife")
    go("life", ["-kpAskDemo"]); if tap("allow.card.pending") { shot("02-faceid-approve") }
    go("life", ["-kpHold"]); shot("03-hold")
    go("life", ["-kpLifeDemo"]); if tap("life.tx.0") { shot("04-receipt") }
    go("life"); if tap("life.aiLimit") { shot("05-limits") }
    go("life"); if tap("safety.pause") { shot("06-pause") }
    go("home"); shot("07-wallet")
    go("home"); if tap("home.withdraw") { shot("08-withdraw") }
    // reviewer-path checks (not for the store): what the plain Release demo shows
    go("life"); if tap("allow.card.pending") { shot("x-request") }
    go("life"); if tap("approve.open") { shot("x-approve") }
    go("settings"); shot("x-settings")
    app.terminate()
  }
  @MainActor func testEn() { executionTimeAllowance = 1200; L = "en"; walk() }
  @MainActor func testZh() { executionTimeAllowance = 1200; L = "zh"; walk() }
}
