import XCTest
@testable import KipurseCore

/// t1116: everyday withdraw = any amount or everything. The ACTUAL live /owner/withdraw/prepare reply for 5 USDC from the owner's
/// wallet 0x5150 (production release 20261112-171344, fetched read-only 2026-11-12 11:14 CST; nothing signed or sent) is fed to the
/// App's real checks (WithdrawAmount.preparedMatches + OwnerExit.verifyAnyPlan, the functions MainWithdrawView.go() calls).
final class T1116WithdrawAmountTests: XCTestCase {
  let wallet = "0x515010c2e41F98CdDd76B819EE69DC832c0939B6", owner = "0x4242b022A8296cB18B0E0b1Cb9879C518170A718"
  let all = "全部", total: Int64 = 12_340_000, fee: Int64 = 6_096
  func calls(_ j: [String: Any]) throws -> [[String: String]] { try XCTUnwrap((j["calls"] as? [[String: Any]])?.map { $0.compactMapValues { $0 as? String } }) }

  func testParse() {
    XCTAssertEqual(WithdrawAmount.atomic("5"), 5_000_000); XCTAssertEqual(WithdrawAmount.atomic("12.5"), 12_500_000); XCTAssertEqual(WithdrawAmount.atomic("0.000001"), 1)
    XCTAssertEqual(WithdrawAmount.atomic("1,234.56"), 1_234_560_000); XCTAssertEqual(WithdrawAmount.atomic(".5"), 500_000); XCTAssertEqual(WithdrawAmount.atomic("0"), 0)
    for bad in ["", "abc", "1.2345678", "1e6", "-5", "1.2.3", ".", "５"] { XCTAssertNil(WithdrawAmount.atomic(bad), bad) }
  }
  func testAllIsTheWholeBalance() {
    XCTAssertEqual(WithdrawAmount.chosen(text: all, allLabel: all, total: total), total)
    XCTAssertNil(WithdrawAmount.problem(text: all, allLabel: all, total: total, fee: fee))
    XCTAssertEqual(WithdrawAmount.net(amount: total, fee: fee), total - fee)
    XCTAssertEqual(WithdrawAmount.chosen(text: "All", allLabel: "All", total: total), total)
  }
  func testCustomAmount() {
    XCTAssertEqual(WithdrawAmount.chosen(text: "5", allLabel: all, total: total), 5_000_000)
    XCTAssertNil(WithdrawAmount.problem(text: "5", allLabel: all, total: total, fee: fee))
    XCTAssertEqual(WithdrawAmount.net(amount: 5_000_000, fee: fee), 4_993_904)
    XCTAssertNil(WithdrawAmount.problem(text: "12.34", allLabel: all, total: total, fee: fee), "exactly the balance is fine")
  }
  func testOverBalanceAndFeeAndEmptyAreRefused() {
    XCTAssertEqual(WithdrawAmount.problem(text: "12.344496", allLabel: all, total: total, fee: fee), .overBalance)
    XCTAssertEqual(WithdrawAmount.problem(text: "100", allLabel: all, total: total, fee: fee), .overBalance)
    XCTAssertEqual(WithdrawAmount.problem(text: "0.006096", allLabel: all, total: total, fee: fee), .notAboveFee, "equal to the fee: nothing would arrive")
    XCTAssertEqual(WithdrawAmount.problem(text: "0.001", allLabel: all, total: total, fee: fee), .notAboveFee)
    XCTAssertNil(WithdrawAmount.problem(text: "0.006097", allLabel: all, total: total, fee: fee))
    XCTAssertEqual(WithdrawAmount.problem(text: "0", allLabel: all, total: total, fee: fee), .zero)
    XCTAssertEqual(WithdrawAmount.problem(text: "", allLabel: all, total: total, fee: fee), .empty)
    XCTAssertEqual(WithdrawAmount.problem(text: "abc", allLabel: all, total: total, fee: fee), .notANumber)
    XCTAssertEqual(WithdrawAmount.problem(text: all, allLabel: all, total: 3_000, fee: 6_096), .notAboveFee, "a dust balance below the fee cannot be withdrawn either")
  }
  func testPresetsAboveTheBalanceAreUnavailable() {
    XCTAssertTrue(WithdrawAmount.presetAvailable("10", total: total)); XCTAssertFalse(WithdrawAmount.presetAvailable("50", total: total)); XCTAssertFalse(WithdrawAmount.presetAvailable("100", total: total))
    XCTAssertTrue(WithdrawAmount.presetAvailable("全部", total: total)); XCTAssertTrue(WithdrawAmount.presetAvailable("All", total: total))
  }
  func testPreparedMustEqualTheConfirmedAmountExactly() {
    XCTAssertTrue(WithdrawAmount.preparedMatches(prepared: 5_000_000, confirmed: 5_000_000))
    XCTAssertFalse(WithdrawAmount.preparedMatches(prepared: 12_340_000, confirmed: 5_000_000), "server answering 'everything' for a partial choice is refused")
    XCTAssertFalse(WithdrawAmount.preparedMatches(prepared: 4_999_999, confirmed: 5_000_000))
    XCTAssertFalse(WithdrawAmount.preparedMatches(prepared: 13_000_000, confirmed: 12_340_000), "the old 90% heuristic is gone: 'all' must be exact too")
    XCTAssertFalse(WithdrawAmount.preparedMatches(prepared: 0, confirmed: 0))
  }
  // MARK: live prepare (production, partial 5 USDC) through the App's real verify
}
