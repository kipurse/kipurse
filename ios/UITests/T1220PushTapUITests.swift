import XCTest

/// t1220u (§6#96): the owner tapped the server's "AI payment request" push (kind=mandate, KP_MANDATE) and the App closed.
/// Same notification content as the server, tapped from the Home screen like on the phone: the App must stay open, show the
/// AI payments page with the waiting request, and AI 生活 (§6#110: where 「待你批准」 now lives) must show the card (zh + en).
final class T1220PushTapUITests: XCTestCase {
  var app: XCUIApplication!
  let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
  override func setUp() { continueAfterFailure = false }
  func shot(_ name: String) { let a = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
  @MainActor func run(_ lang: String, noSession: Bool = false) {
    app = XCUIApplication()
    app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", lang, "-kpSkipFaceID", "-kpStill", "-kpPushTapTest",
                           "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"] + (noSession ? ["-kpNoSession"] : [])
    app.launch()
    // the system asks for notification permission once per install (allow it, like the owner did)
    let al = sb.alerts.firstMatch
    if al.waitForExistence(timeout: 3) { for t in ["Allow", "允许"] where al.buttons[t].exists { al.buttons[t].tap(); break } }
    if !noSession { XCTAssertTrue(app.descendants(matching: .any)["allow.card.pending"].waitForExistence(timeout: 10), "AI 生活 shows the waiting AI request") } else { sleep(2) }
    XCUIDevice.shared.press(.home)
    let title = lang == "zh" ? "AI 请求付款" : "AI payment request"
    let banner = sb.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
    XCTAssertTrue(banner.waitForExistence(timeout: 30), "the push banner shows"); shot("\(lang)-banner")
    banner.tap()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "tapping the push opens the App")
    sleep(3)
    XCTAssertEqual(app.state, .runningForeground, "the App did not close after the tap")
    XCTAssertTrue(app.buttons["allow.close"].waitForExistence(timeout: 8), "the AI payments page opened"); shot("\(lang)-after-tap")
    XCTAssertTrue(app.buttons["allow.pending.approve"].exists, "the waiting request is on that page (approve needs Face ID; not tapped)")
    if noSession { XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "shop.example")).firstMatch.exists, "the request from the push is listed") }
    app.buttons["allow.close"].tap()
    XCTAssertTrue(app.descendants(matching: .any)["allow.card.pending"].waitForExistence(timeout: 8), "AI 生活 still shows 待你批准")
    XCTAssertTrue(app.descendants(matching: .any)["life.pending.title"].exists); XCTAssertTrue(app.staticTexts["life.title"].exists, "the tap lands on AI 生活"); shot("\(lang)-life")
    app.terminate()
  }
  @MainActor func testTapMandatePushZh() { run("zh") }
  @MainActor func testTapMandatePushEn() { run("en") }
  /// The owner's case: no live server session (opening the App never asks for Face ID, 0A#2). The request must still be
  /// listed from the push, on the page the tap opens and on AI 生活 under 「待你批准」.
  @MainActor func testTapMandatePushNoSessionZh() { run("zh", noSession: true) }
  @MainActor func testTapMandatePushNoSessionEn() { run("en", noSession: true) }
}
