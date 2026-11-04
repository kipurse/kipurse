import XCTest
/// t820 OUTAGE DRILL (test-only, simulation): run with KIPURSE_MAINNET_SERVER=https://kipurse.invalid so every Kipurse
/// server / sign-host request fails like a real outage. No mocks of the result, no signing, no money.
final class T820OutageDrillUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = true }
  func dump(_ tag: String) {
    // t927: read one snapshot (elements can vanish while a web sheet opens; per-index lookups then fail)
    var t: [String] = [], b: [String] = []
    func walk(_ e: XCUIElementSnapshot) { if e.elementType == .staticText, !e.label.isEmpty, t.count < 40 { t.append(e.label) }; if e.elementType == .button, b.count < 30 { b.append("\(e.identifier)|\(e.label)") }; e.children.forEach(walk) }
    if let snap = try? app.snapshot() { walk(snap) }
    print("T820DRILL[\(tag)] TEXTS=\(t) BUTTONS=\(b)")
  }
  func testDrillFreshLaunchAndSignIn() {
    app = XCUIApplication(); app.launchArguments = ["-kpFreshInstall", "-kp.lang", "zh"]; app.launch()
    let s = app.buttons["cb.signin"]; let ok = s.waitForExistence(timeout: 15); dump("launch"); print("T820DRILL[launch] signinButton=\(ok)")
    guard ok else { return }
    s.tap(); sleep(12); dump("signin-after-tap")
  }
  func testDrillEmergencyRealOutage() {
    app = XCUIApplication(); app.launchArguments = ["-kpIdentityOK", "-kpUnbound", "-kp.lang", "zh"]; app.launch()
    // t821: with the server down the gate shows the calm card + on-chain exit instead of the server emergency page.
    let g = app.buttons["offline.guide"]; let gok = g.waitForExistence(timeout: 20); dump("unbound-home"); print("T820DRILL[unbound] offlineGuide=\(gok)")
    XCTAssertTrue(gok || app.buttons["unbound.emergency"].exists, "t821: an exit is reachable (offline guide if the server is down, otherwise the welcome emergency link)"); if gok { return }
    let e = app.buttons["unbound.emergency"]; let ok = e.waitForExistence(timeout: 15)
    guard ok else { return }
    e.tap(); let c = app.buttons["emergency.continue"]; if c.waitForExistence(timeout: 5) { c.tap() }
    let off = app.buttons["emergency.retry"].waitForExistence(timeout: 12); dump("emergency"); print("T820DRILL[emergency] offlineFallback=\(off)")
  }
  func testDrillBindPhone() {
    app = XCUIApplication(); app.launchArguments = ["-kpIdentityOK", "-kpUnbound", "-kp.lang", "zh"]; app.launch()
    let b = app.buttons["unbound.bind"]; guard b.waitForExistence(timeout: 15) else { dump("bind-missing"); return }
    b.tap(); sleep(10); dump("bind-after-tap")
  }
  /// t821 after-fix: real wallet address (public, read-only chain reads; nothing signed), server unreachable.
  func testDrillT821BalanceAndExit() {
    app = XCUIApplication(); app.launchArguments = ["-kpIdentityOK", "-kpUnboundWallet", "0x1111111111111111111111111111111111111111", "-kp.lang", "zh"]; app.launch()
    let t = app.staticTexts["offline.text"]; let calm = t.waitForExistence(timeout: 20); print("T820DRILL[t821-calm] \(calm) \(calm ? t.label : "")")
    let bal = app.staticTexts["chain.balance"]; let b = bal.waitForExistence(timeout: 30); print("T820DRILL[t821-balance] \(b) \(b ? bal.label : "")"); dump("t821-offline-card")
    let g = app.buttons["offline.guide"]; guard g.waitForExistence(timeout: 5) else { print("T820DRILL[t821-guide] false"); return }
    g.tap(); let guide = app.otherElements["rescue.guide"].waitForExistence(timeout: 8) || app.staticTexts["离线提现指南（启付停了也能用）"].waitForExistence(timeout: 3)
    print("T820DRILL[t821-guide] \(guide)")
    let p = app.buttons["rescue.prepare"]; if p.waitForExistence(timeout: 5) { p.tap() }
    let note = app.staticTexts["rescue.note"]; let pv = app.otherElements["rescue.preview"]
    _ = note.waitForExistence(timeout: 30) || pv.waitForExistence(timeout: 1)
    print("T820DRILL[t821-prepare] note=\(note.exists ? note.label : "-") preview=\(pv.exists)"); dump("t821-guide")
    let sp = app.buttons["rescue.stopPrepare"]; if sp.exists { sp.tap(); let s = app.staticTexts["rescue.stopPreview"].waitForExistence(timeout: 30); print("T820DRILL[t821-stopPreview] \(s)") }
    XCTAssertTrue(calm && b && guide)
  }
}
