import XCTest

/// t1133u + t1143u: wallet address lives in the top 启付钱包 card; same eye as the balance hides it to head…tail, open shows the full two-line address; copy always copies the full address.
final class T1133WalletAddressUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  private func shot(_ n: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = n; a.lifetime = .keepAlways; add(a) }

  func run(_ lang: String) {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-kp.lang", lang, "-kpSkipFaceID", "-tab", "home"]; app.launch()
    let zh = lang == "zh"
    let cw = app.buttons["wallet.copyWallet"]; XCTAssertTrue(cw.waitForExistence(timeout: 10), lang)
    XCTAssertEqual(app.buttons.matching(identifier: "wallet.copyWallet").count, 1, "one copy entry (t930)")
    let full = (cw.value as? String) ?? ""
    XCTAssertTrue(full.hasPrefix("0x"), lang); XCTAssertEqual(full.count, 42, "whole address, not shortened")
    // the visible text is the whole address (no ellipsis), inside the card above 充值/提现
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "····")).firstMatch.exists, lang)
    let dep = app.buttons["home.deposit"]; XCTAssertTrue(dep.waitForExistence(timeout: 5))
    XCTAssertLessThan(cw.frame.maxY, dep.frame.minY, "address sits in the top card")
    XCTAssertTrue(cw.isHittable, lang)
    XCTAssertEqual(cw.label, zh ? "复制钱包地址" : "Copy wallet address")
    // old standalone row removed
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", zh ? "我的钱包地址" : "My wallet address")).firstMatch.exists, lang)
    shot("t1133-card-\(lang)")
    cw.tap()
    let copied = zh ? "钱包地址已复制" : "Wallet address copied"
    let after = app.buttons["wallet.copyWallet"]; XCTAssertTrue(after.waitForExistence(timeout: 3)); XCTAssertEqual(after.label, copied, lang)
    XCTAssertEqual((after.value as? String) ?? "", full, "copy keeps the whole address")
    shot("t1133-copied-\(lang)")
    app.terminate()
  }
  func testZh() { run("zh") }
  func testEn() { run("en") }

  /// t1143u: hidden by default (same eye as the balance): short head…tail, a11y value is not the full address; copy still copies; opening the eye shows the full 42-character address.
  func runHiddenShownCopy(_ lang: String) {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-kp.lang", lang, "-kpSkipFaceID", "-tab", "home", "-kpMasked"]; app.launch()
    let zh = lang == "zh"
    let cw = app.buttons["wallet.copyWallet"]; XCTAssertTrue(cw.waitForExistence(timeout: 10), lang)
    XCTAssertEqual(app.buttons.matching(identifier: "wallet.copyWallet").count, 1, "one copy entry (t930)")
    XCTAssertTrue(app.buttons["balance.reveal"].waitForExistence(timeout: 5), "eye starts closed")
    let hidden = (cw.value as? String) ?? ""
    XCTAssertTrue(hidden.hasPrefix("0x"), lang)
    XCTAssertTrue(hidden.contains("…"), "short form when hidden")
    XCTAssertLessThan(hidden.count, 42, "must not expose the full address while hidden")
    XCTAssertEqual(cw.label, zh ? "复制钱包地址" : "Copy wallet address")
    shot("t1143-hidden-\(lang)")
    cw.tap()
    let copied = zh ? "钱包地址已复制" : "Wallet address copied"
    let afterHidden = app.buttons["wallet.copyWallet"]
    XCTAssertTrue(afterHidden.waitForExistence(timeout: 3))
    XCTAssertEqual(afterHidden.label, copied, lang)
    XCTAssertEqual((afterHidden.value as? String) ?? "", hidden, "copy while hidden must not put the full address in the accessibility value")
    // open the same eye — address and balance are shown together
    let eye = app.buttons["balance.reveal"]; XCTAssertTrue(eye.waitForExistence(timeout: 3)); eye.tap()
    XCTAssertTrue(app.buttons["balance.hide"].waitForExistence(timeout: 5), lang)
    let shown = app.buttons["wallet.copyWallet"]
    XCTAssertTrue(shown.waitForExistence(timeout: 5))
    let full = (shown.value as? String) ?? ""
    XCTAssertTrue(full.hasPrefix("0x"), lang); XCTAssertEqual(full.count, 42, "full address when the eye is open")
    XCTAssertFalse(full.contains("…"), lang)
    let expectedShort = String(full.prefix(6)) + "…" + String(full.suffix(4))
    XCTAssertEqual(hidden, expectedShort, "hidden form is AddressDisplay.short of the same address")
    shot("t1143-shown-\(lang)")
    shown.tap()
    let afterShown = app.buttons["wallet.copyWallet"]
    XCTAssertTrue(afterShown.waitForExistence(timeout: 3))
    XCTAssertEqual(afterShown.label, copied, lang)
    XCTAssertEqual((afterShown.value as? String) ?? "", full, "copy while shown keeps the whole address")
    app.terminate()
  }
  func testHiddenShownCopyZh() { runHiddenShownCopy("zh") }
  func testHiddenShownCopyEn() { runHiddenShownCopy("en") }
}
