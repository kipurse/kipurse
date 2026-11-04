import XCTest
@testable import KipurseCore
final class T968FeeReceiptTests: XCTestCase {
  func testExactReceipt() {
    let r = FeeReceipt(["token": "USDC", "paidFrom": "wallet_balance", "amount": "1000000", "protocolFee": "1000", "networkFee": "1234", "total": "1002234"])!
    XCTAssertEqual(r.rows(zh: true).last?.1, "1.002234 USDC"); XCTAssertEqual(r.rows(zh: false)[1].1, "0.001 USDC")
  }
  func testRejectsInconsistentOrForeign() {
    XCTAssertNil(FeeReceipt(["token": "USDC", "paidFrom": "wallet_balance", "amount": "1", "protocolFee": "1", "networkFee": "0", "total": "5"]))
    XCTAssertNil(FeeReceipt(["token": "USDC", "paidFrom": "card", "amount": "1", "protocolFee": "0", "networkFee": "0", "total": "1"]))
    XCTAssertNil(FeeReceipt(nil))
  }
  func testPreviewNeverGuessesNetworkCost() {
    let r = FeeReceipt(["token": "USDC", "paidFrom": "wallet_balance", "amount": "250000", "protocolFee": "250", "networkFee": "0", "total": "250250", "networkFeeAtPayment": true])!
    XCTAssertEqual(r.rows(zh: true).count, 3); XCTAssertEqual(r.rows(zh: true)[2].1, "按实际成本，付款时显示")
  }
  func testWording() {
    let all = [true, false].flatMap { z in FeeReceipt(["token": "USDC", "paidFrom": "wallet_balance", "amount": "1", "protocolFee": "1", "networkFee": "1", "total": "3"])!.rows(zh: z).flatMap { [$0.0, $0.1] } }
    for w in ["免费", "垫付", "赞助", "free", "sponsor"] { XCTAssertFalse(all.joined().lowercased().contains(w), w) }
  }
  func testDisputeLabels() {
    XCTAssertEqual(DisputeState.label(state: "merchant_overdue", status: "open", zh: true), "商家超过 7 天没有退款")
    XCTAssertEqual(DisputeState.label(state: nil, status: "refunded", zh: false), "Fully refunded")
  }
}
