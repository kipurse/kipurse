import XCTest
@testable import KipurseCore

final class AILimitGateTests: XCTestCase {
  override func tearDown() { Loc.override = nil; SafetyCaps.query = nil }

  private func word(_ n: UInt64) -> [UInt8] {
    var b = [UInt8](repeating: 0, count: 32); var v = n
    for i in stride(from: 31, through: 24, by: -1) { b[i] = UInt8(v & 0xff); v >>= 8 }
    return b
  }
  private func addr(_ hex: String) -> [UInt8] {
    var b = [UInt8](repeating: 0, count: 32)
    b.replaceSubrange(12..<32, with: Hex.decode(hex)!)
    return b
  }
  /// SpendPermission log data: account + 384-byte policy (single, daily, term at words 2, 3, 4).
  private func log(account: String, single: UInt64, daily: UInt64, term: UInt64) -> String {
    var head = addr(account) + word(0) + word(0) + word(0) + word(0) + word(0) + word(0) + word(0)
    head += word(288)
    var pol = word(0) + word(0) + word(single) + word(daily) + word(term)
    pol += word(0) + word(0) + word(0) + word(0) + word(0) + word(0) + word(0)
    return Hex.encode(head + word(384) + pol)
  }

  func testMissingFieldOrderThenComparisons() {
    Loc.override = "zh"
    let ready = AILimitGate.Caps.ready(single: 2_000_000_000, daily: 2_000_000_000, term: 20_000_000_000)
    XCTAssertEqual(AILimitGate.line(single: "", daily: "1000", term: "10000", caps: ready), "请填写每笔金额")
    XCTAssertEqual(AILimitGate.line(single: "1000", daily: "", term: "10000", caps: ready), "请填写每天金额")
    XCTAssertEqual(AILimitGate.line(single: "1000", daily: "1000", term: "", caps: ready), "请填写总额")
    XCTAssertEqual(AILimitGate.line(single: "2000", daily: "1000", term: "10000", caps: ready), "每笔不能大于每天")
    XCTAssertEqual(AILimitGate.line(single: "1000", daily: "2000", term: "1000", caps: ready), "每天不能大于总额")
    XCTAssertFalse(AILimitGate.line(single: "1000", daily: "1000", term: "10000", caps: .unreadable).contains("请输入金额"))
  }

  func testCompleteAmountsAgainstCaps() {
    Loc.override = "zh"
    let amounts = ("1000", "1000", "10000")
    XCTAssertEqual(AILimitGate.line(single: amounts.0, daily: amounts.1, term: amounts.2, caps: .unreadable), "还没读到钱包安全上限，请稍后再试")
    XCTAssertEqual(AILimitGate.line(single: amounts.0, daily: amounts.1, term: amounts.2, caps: .unset), "请先在钱包页设置钱包安全上限")
    XCTAssertFalse(AILimitGate.allowsContinue(single: amounts.0, daily: amounts.1, term: amounts.2, caps: .unreadable))
    XCTAssertFalse(AILimitGate.allowsContinue(single: amounts.0, daily: amounts.1, term: amounts.2, caps: .unset))
    let within = AILimitGate.Caps.ready(single: 1_000_000_000, daily: 1_000_000_000, term: 10_000_000_000)
    XCTAssertTrue(AILimitGate.allowsContinue(single: amounts.0, daily: amounts.1, term: amounts.2, caps: within))
    XCTAssertEqual(AILimitGate.verdict(single: amounts.0, daily: amounts.1, term: amounts.2, caps: within), .within)
    let low = AILimitGate.Caps.ready(single: 999_000_000, daily: 1_000_000_000, term: 10_000_000_000)
    XCTAssertEqual(AILimitGate.line(single: amounts.0, daily: amounts.1, term: amounts.2, caps: low), "超过钱包安全上限，请调低金额或修改安全上限")
    XCTAssertFalse(AILimitGate.allowsContinue(single: amounts.0, daily: amounts.1, term: amounts.2, caps: low))
  }

  func testShellDistinguishesUnreadableUnsetAndReady() {
    let w = "0x1000000000000000000000000000000000000001"
    XCTAssertEqual(WalletState.shell(wallet: w, balance: 1, caps: .unreadable).capRead, .unreadable)
    XCTAssertEqual(WalletState.shell(wallet: w, balance: 1, caps: .unset).capRead, .unset)
    let ready = WalletState.shell(wallet: w, balance: 5, caps: .ready(single: 10, daily: 20, term: 30))
    XCTAssertEqual(ready.raw["caps"]?["single"]?.atomic, 10); XCTAssertEqual(ready.capRead, .ready(single: 10, daily: 20, term: 30))
    XCTAssertEqual(WalletState(.object(["caps": .object(["single": .string("0"), "daily": .string("0"), "term": .string("0")])])).capRead, .unset)
    XCTAssertEqual(WalletState(.object([:])).capRead, .unreadable)
  }

  func testLogDecodeAndQuery() async {
    let acct = "0x1000000000000000000000000000000000000001"
    let data = log(account: acct, single: 1_000_000_000, daily: 1_000_000_000, term: 10_000_000_000)
    XCTAssertEqual(SafetyCaps.decode(data, account: acct), .ready(single: 1_000_000_000, daily: 1_000_000_000, term: 10_000_000_000))
    XCTAssertNil(SafetyCaps.decode(data, account: "0x2000000000000000000000000000000000000002"))
    XCTAssertEqual(SafetyCaps.decode(log(account: acct, single: 0, daily: 1, term: 1), account: acct), .unset)
    SafetyCaps.query = { _ in [] }
    let none = await SafetyCaps.latest(account: acct)
    XCTAssertEqual(none, .unset)
    SafetyCaps.query = { _ in nil }
    let bad = await SafetyCaps.latest(account: acct)
    XCTAssertEqual(bad, .unreadable)
    SafetyCaps.query = { _ in [data] }
    let got = await SafetyCaps.latest(account: acct)
    XCTAssertEqual(got, .ready(single: 1_000_000_000, daily: 1_000_000_000, term: 10_000_000_000))
  }
}
