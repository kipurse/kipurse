import XCTest

/// t991 home UI audit: full-page screenshots of 钱包 (zh/en, light/dark) and screens opened from it. Sample demo data only.
/// Runs only when KPSHOT_DIR is set (TEST_RUNNER_KPSHOT_DIR), so the normal suite skips it.
final class HomeAuditShotsUITests: XCTestCase {
  var app: XCUIApplication!
  var dir = ""
  @MainActor func shot(_ n: String) { sleep(1); try? app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir + "/" + n + ".png")) }
  @MainActor func go(_ args: [String]) { app?.terminate(); app = XCUIApplication(); app.launchArguments = args; app.launch(); sleep(3) }
  @MainActor func tap(_ id: String) -> Bool { let b = app.descendants(matching: .any).matching(identifier: id).firstMatch; guard b.waitForExistence(timeout: 5) else { return false }; var i = 0; while !b.isHittable && i < 6 { app.swipeUp(); i += 1 }; b.tap(); sleep(2); return true }
  @MainActor func testHomeAuditShots() throws {
    guard let d = ProcessInfo.processInfo.environment["KPSHOT_DIR"], !d.isEmpty else { throw XCTSkip("screenshots only") }
    dir = d; try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    continueAfterFailure = true
    let dev = ProcessInfo.processInfo.environment["KPSHOT_DEV"] ?? "dev"
    for L in ["zh", "en"] { for C in ["Light", "Dark"] {
      let p = "\(dev)-\(L)-\(C.lowercased())-", base = ["-kp.lang", L, "-kpSkipFaceID", "-tab", "home", "-kp" + C]
      let life = ["-kp.lang", L, "-kpSkipFaceID", "-tab", "life", "-kp" + C]   // §6#110: 待你批准 (connect / approvals / AI requests / holds) lives on AI 生活
      go(["-demo", "main"] + base); shot(p + "home-0"); app.swipeUp(); shot(p + "home-1"); app.swipeUp(); shot(p + "home-2")
      go(["-demo", "main-new"] + base); shot(p + "empty-0"); app.swipeUp(); shot(p + "empty-1")
      go(["-demo", "main-connect"] + life); shot(p + "connect-0")
      go(["-demo", "main", "-kpMasked"] + base); shot(p + "masked")
      go(["-demo", "main", "-kpHold"] + life); shot(p + "hold")
      if L == "zh" || C == "Light" {
        go(["-demo", "main", "-kpApplePayMock"] + base); if tap("home.deposit") { shot(p + "deposit") }
        go(["-demo", "main"] + base); if tap("home.withdraw") { shot(p + "withdraw") }
        go(["-demo", "main"] + base); if tap("home.allActivity") { shot(p + "activity") }
        go(["-demo", "main"] + life); if tap("allow.card.pending") { shot(p + "allowances") }
        go(["-demo", "main"] + life); if tap("approve.open") { shot(p + "approve") }
      }
    } }
  }
}
