import XCTest
@testable import KipurseCore
final class UsdcGasT1020Tests: XCTestCase {
  let W = "0x00000000000000000000000000000000000bee01"
  func call(_ sel: String, _ addr: String, _ amt: UInt64) -> [String: Any] {
    let a = String(repeating: "0", count: 24) + addr.dropFirst(2).lowercased(); let v = String(repeating: "0", count: 48) + String(format: "%016llx", amt)
    return ["to": UsdcGas.usdc, "value": "0x0", "data": sel + a + v]
  }
  func testFeeRepayAndDepositAccepted() {
    let s = UsdcGas.split([call("0xa9059cbb", UsdcGas.feeTo, 50_000), call("0xa9059cbb", W, 1_000_000), ["to": W, "data": "0x"]], wallet: W)
    XCTAssertTrue(s.problems.isEmpty, "\(s.problems)"); XCTAssertEqual(s.feeRepaid, 50_000); XCTAssertEqual(s.deposit, 1_000_000); XCTAssertEqual(s.rest.count, 1)
  }
  func testRefusesOtherSpenderOverCapOtherRecipientLateUSDC() {
    XCTAssertFalse(UsdcGas.split([call("0x095ea7b3", "0x000000000000000000000000000000000000dead", 1)], wallet: W).problems.isEmpty)
    XCTAssertFalse(UsdcGas.split([call("0xa9059cbb", UsdcGas.feeTo, 250_001)], wallet: W).problems.isEmpty)
    XCTAssertFalse(UsdcGas.split([call("0xa9059cbb", "0x000000000000000000000000000000000000dead", 5)], wallet: W).problems.isEmpty)
    XCTAssertFalse(UsdcGas.split([["to": W, "data": "0x"], call("0xa9059cbb", UsdcGas.feeTo, 1)], wallet: W).problems.isEmpty)
  }
  func testFeeNoteWording() {
    for w in ["免费", "垫付", "赞助"] { XCTAssertFalse(UsdcGas.feeNoteZh.contains(w)) }
    XCTAssertTrue(UsdcGas.feeNoteZh.contains("不从这次充值里扣")); XCTAssertTrue(UsdcGas.feeNoteZh.contains("实际网络费") || UsdcGas.feeNoteZh.contains("USDC")); XCTAssertFalse(UsdcGas.feeNoteZh.contains("0.05"))
  }
}
final class OpeningDepositT1020Tests: XCTestCase {
  func testDepositAmount() { XCTAssertEqual(Onboard.depositAtomic("5"), 5_000_000); XCTAssertEqual(Onboard.depositAtomic("1.5"), 1_500_000); XCTAssertNil(Onboard.depositAtomic("0.5")); XCTAssertNil(Onboard.depositAtomic("")) }
  func testFeeNoteSaysUserPaysUSDC() {
    let n = UsdcGas.feeNote(quotedUSDC: "0.0444")
    XCTAssertTrue(n.zh.contains("0.0444") && n.zh.contains("实际网络费"), n.zh)
    XCTAssertTrue(n.en.contains("0.0444") && n.en.contains("actual network"), n.en)
    let fallback = UsdcGas.feeNote(quotedUSDC: nil)
    XCTAssertTrue(fallback.zh.contains("实际网络费") && fallback.zh.contains("在充值之外另从你的 Coinbase 钱包（Base 账户）扣"))   // t1114
    XCTAssertFalse(fallback.zh.contains("0.05"))
    for w in ["免费", "垫付", "赞助"] { XCTAssertFalse(n.zh.contains(w)); XCTAssertFalse(fallback.zh.contains(w)) }
  }
}
final class WithdrawUsdcGasT1020Tests: XCTestCase {
  let W = "0x00000000000000000000000000000000000bee01", O = "0x00000000000000000000000000000000000000a1"
  func approve(_ spender: String, _ amt: UInt64) -> [String: String] {
    ["to": UsdcGas.usdc, "value": "0x0", "data": "0x095ea7b3" + String(repeating: "0", count: 24) + spender.dropFirst(2).lowercased() + String(repeating: "0", count: 48) + String(format: "%016llx", amt)]
  }
  func feeRepay(_ amt: UInt64) -> [String: String] {
    ["to": UsdcGas.usdc, "value": "0x0", "data": "0xa9059cbb" + String(repeating: "0", count: 24) + UsdcGas.feeTo.dropFirst(2) + String(repeating: "0", count: 48) + String(format: "%016llx", amt)]
  }
  func testFeeRepayPlusPlainWithdrawAccepted() {
    let body = OwnerExit.withdrawBatch(wallet: W, owner: O, vault: nil, amount: 5_000_000)!.map { ["to": $0.to, "data": $0.data, "value": "0x0"] }
    // leading approve (old erc20 path) still accepted by verifier
    XCTAssertNil(OwnerExit.verifyAnyPlan(calls: [approve(UsdcGas.paymaster, 250_000)] + body, wallet: W, owner: O, planOwner: O, vault: nil, amount: 5_000_000))
  }
  func testApproveToOtherOrTwiceRefused() {
    let body = OwnerExit.withdrawBatch(wallet: W, owner: O, vault: nil, amount: 5_000_000)!.map { ["to": $0.to, "data": $0.data, "value": "0x0"] }
    XCTAssertNotNil(OwnerExit.verifyAnyPlan(calls: [approve(O, 1)] + body, wallet: W, owner: O, planOwner: O, vault: nil, amount: 5_000_000))
  }
}
