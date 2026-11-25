import XCTest

/// t1116: everyday withdraw = any amount or "[zh]". Demo fixture (nothing is sent): balance = home balance, fee 0.003 USDC.
final class T1116WithdrawUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  private func open(_ lang: String) {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-kp.lang", lang, "-kpSkipFaceID", "-tab", "home"]; app.launch()
    let t = app.buttons["home.withdraw"]; XCTAssertTrue(t.waitForExistence(timeout: 10)); t.tap()
    XCTAssertTrue(app.buttons["withdraw.go"].waitForExistence(timeout: 8))
  }
  private func shot(_ n: String) {
    let a = XCTAttachment(screenshot: app.screenshot()); a.name = n; a.lifetime = .keepAlways; add(a)
    let dir = "/tmp/t1116shots"; try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let dev = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "sim"
    try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/\(dev)-\(n).png"))
  }
  private func type(_ s: String) {
    let f = app.textFields["withdraw.custom"]; reveal(f); f.tap()
    if let v = f.value as? String, !v.isEmpty, v != f.placeholderValue { f.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: v.count)) }
    f.typeText(s)
  }
  private func reveal(_ e: XCUIElement) { for _ in 0..<6 where !e.isHittable { app.swipeUp() } }
  private func done() { let d = app.buttons["amount.done"]; if d.exists && d.isHittable { d.tap() } }
  private func label(_ id: String) -> String { app.descendants(matching: .any)[id].firstMatch.label }

  func run(_ L: String) {
    open(L); let zh = L == "zh"
    // default = [zh] / All, like before: amount = the whole balance, [zh] = balance − fee
    XCTAssertTrue(app.buttons["withdraw.all"].isSelected)
    XCTAssertTrue(label("withdraw.amount").contains("14.1"), label("withdraw.amount"))
    XCTAssertTrue(app.staticTexts["withdraw.net"].exists); XCTAssertTrue(app.buttons["withdraw.go"].isEnabled)
    XCTAssertFalse(app.buttons["withdraw.preset.50"].isEnabled, "preset above the balance is unavailable"); XCTAssertFalse(app.buttons["withdraw.preset.100"].isEnabled)
    XCTAssertTrue(app.buttons["withdraw.preset.10"].isEnabled)
    XCTAssertTrue(app.staticTexts["withdraw.fee"].exists); XCTAssertTrue(app.descendants(matching: .any)["withdraw.to"].exists)
    I18nCheck.check(app, L, "t1116 withdraw all"); shot("\(L)-1-all")
    // custom 5 -> [zh] 4.997
    type("5"); done()
    XCTAssertTrue(label("withdraw.amount").contains("5 USDC"), label("withdraw.amount")); XCTAssertFalse(app.buttons["withdraw.all"].isSelected)
    XCTAssertTrue(app.staticTexts["withdraw.net"].label.contains("4.997"), app.staticTexts["withdraw.net"].label)
    I18nCheck.check(app, L, "t1116 withdraw custom"); shot("\(L)-2-custom-5")
    // more than the balance -> button off + plain reason
    type("99999"); done()
    XCTAssertTrue(app.staticTexts["withdraw.amountProblem"].waitForExistence(timeout: 3)); XCTAssertFalse(app.buttons["withdraw.go"].isEnabled); XCTAssertFalse(app.staticTexts["withdraw.net"].exists)
    XCTAssertTrue(app.staticTexts["withdraw.amountProblem"].label.contains(zh ? "超过了钱包余额" : "more than your wallet balance"))
    I18nCheck.check(app, L, "t1116 withdraw over"); shot("\(L)-3-over-balance")
    // at / below the network fee -> off
    type("0.003"); done()
    XCTAssertTrue(app.staticTexts["withdraw.amountProblem"].label.contains(zh ? "网络手续费" : "network fee")); XCTAssertFalse(app.buttons["withdraw.go"].isEnabled)
    I18nCheck.check(app, L, "t1116 withdraw fee"); shot("\(L)-4-below-fee")
    type("0"); done(); XCTAssertFalse(app.buttons["withdraw.go"].isEnabled)
    // preset 10 -> confirm dialog shows 10, done shows 10
    let ten = app.buttons["withdraw.preset.10"]; reveal(ten); ten.tap()
    XCTAssertTrue(label("withdraw.amount").contains("10 USDC")); XCTAssertTrue(app.staticTexts["withdraw.net"].label.contains("9.997"))
    let go = app.buttons["withdraw.go"]; reveal(go); XCTAssertTrue(go.isEnabled); go.tap()
    let c = app.buttons["withdraw.confirm"].firstMatch; XCTAssertTrue(c.waitForExistence(timeout: 5))
    let msg = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "10 USDC")).firstMatch
    XCTAssertTrue(msg.exists, "confirmation shows the chosen amount, not everything"); shot("\(L)-5-confirm-10"); c.tap()
    XCTAssertTrue(app.descendants(matching: .any)["withdraw.done"].waitForExistence(timeout: 8)); XCTAssertTrue(app.staticTexts["withdraw.doneAmount"].label.hasPrefix("10 USDC"), app.staticTexts["withdraw.doneAmount"].label)
    shot("\(L)-6-done-10")
  }
  func testZh() { run("zh") }
  func testEn() { run("en") }
  /// [zh] again after a custom amount: back to the whole balance; confirm shows the whole balance.
  func testAllAfterCustom() {
    open("zh"); type("2"); done(); let all = app.buttons["withdraw.all"]; reveal(all); all.tap()
    XCTAssertTrue(all.isSelected); XCTAssertTrue(label("withdraw.amount").contains("14.1"))
    let go = app.buttons["withdraw.go"]; reveal(go); go.tap(); XCTAssertTrue(app.buttons["withdraw.confirm"].firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "14.1")).firstMatch.exists); shot("zh-7-confirm-all")
  }
}
