import XCTest
@testable import KipurseCore

/// t1259 (decision 129): a closed (expired / unpayable) request shows a plain reason, never a bare "422".
final class T1259AskGoneTests: XCTestCase {
  func testGoneIsRecognised() {
    XCTAssertTrue(OwnerAsk.isGone(status: 410, error: "request_gone"))
    XCTAssertTrue(OwnerAsk.isGone(status: 410, error: ""))
    XCTAssertFalse(OwnerAsk.isGone(status: 409, error: "already_handled"))
    XCTAssertFalse(OwnerAsk.isGone(status: 422, error: "not_payable"))
  }
  func testTextSaysNothingPaidAndOrderAgain() {
    XCTAssertTrue(OwnerAsk.goneZH.contains("没有付款") && OwnerAsk.goneZH.contains("重新下单") && OwnerAsk.goneZH.contains("已从列表移除"))
    XCTAssertTrue(OwnerAsk.goneEN.contains("nothing was paid"))
  }
  func testAppReloadsTheListOnGone() throws {
    let s = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/KipurseCoreTests/T1259AskGoneTests.swift", with: "App/Sources/AllowancesView.swift"), encoding: .utf8)
    XCTAssertTrue(s.contains("if OwnerAsk.isGone(status: c, error: Self.s(j[\"error\"])) { await load(); return T(OwnerAsk.goneZH, OwnerAsk.goneEN) }"))
  }
}
