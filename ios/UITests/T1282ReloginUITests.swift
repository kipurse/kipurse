// SPDX-License-Identifier: Apache-2.0
import XCTest

/// t1282 (decision 156): after [zh] → [zh] (no server session, no cache, real Base chain) the wallet page never shows a placeholder 0,
/// [zh] resolves instead of "[zh]" forever, and [zh] shows the wallet's real movements.
/// Needs TEST_RUNNER_KP_LIVE_WALLET (read-only public chain reads); skipped otherwise.
final class T1282ReloginUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  func testReloginRealChain() throws {
    guard let w = ProcessInfo.processInfo.environment["KP_LIVE_WALLET"], w.count == 42 else { throw XCTSkip("set TEST_RUNNER_KP_LIVE_WALLET") }
    let app = XCUIApplication(); app.launchArguments = ["-kp.lang", "zh", "-kpSkipFaceID", "-tab", "home", "-kpReloginWallet", w]; app.launch()
    func shot(_ n: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = n; a.lifetime = .keepAlways; add(a) }
    let masked = app.descendants(matching: .any)["balance.masked"]
    if masked.waitForExistence(timeout: 15) { masked.tap() }
    let amount = app.descendants(matching: .any)["balance.amount"], loading = app.descendants(matching: .any)["balance.loading"]
    var sawLoading = false, shown = "", t0 = Date()
    var balanceAt = -1.0
    while Date().timeIntervalSince(t0) < 60 {
      if loading.exists { sawLoading = true }
      if amount.exists {
        shown = amount.label
        XCTAssertFalse(shown.hasPrefix("0 ") || shown == "0" || shown.hasPrefix("0.00") || shown.hasPrefix("$0"), "never a placeholder 0: \(shown)")
        if balanceAt < 0 { balanceAt = Date().timeIntervalSince(t0); shot("t1282-balance") }
        break
      }
      usleep(150_000)
    }
    print("KPUI balance=\(shown) sawLoading=\(sawLoading) after=\(balanceAt)s")
    XCTAssertTrue(shown.contains("7.72"), "real balance shown: \(shown)")
    let limit = app.descendants(matching: .any)["wallet.totalLimit"]
    XCTAssertTrue(limit.waitForExistence(timeout: 10))
    t0 = Date(); var lt = limit.label
    while Date().timeIntervalSince(t0) < 90 && lt.contains("正在读取") { usleep(500_000); lt = limit.label }
    print("KPUI limit=\(lt) after=\(Date().timeIntervalSince(t0))s")
    XCTAssertTrue(lt.contains("每笔"), "safety limit resolves: \(lt)")
    shot("t1282-limit")
    t0 = Date(); let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'ledger.item' OR (identifier BEGINSWITH 'ledger.row.' AND NOT identifier ENDSWITH '.explorer')"))   // t1285: rows carry ledger.row.N
    while Date().timeIntervalSince(t0) < 120 && rows.count < 2 { usleep(1_000_000) }
    print("KPUI records=\(rows.count) after=\(Date().timeIntervalSince(t0))s labels=\((0..<min(rows.count, 4)).map { rows.element(boundBy: $0).label })")
    XCTAssertGreaterThanOrEqual(rows.count, 2, "records: the deposit (+8.071551 with its 0.15 fee) and the 0.2002 payment")
    shot("t1282-records")
    app.terminate()
  }
}
