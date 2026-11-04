import XCTest
@testable import KipurseCore

final class AssistantDataTests: XCTestCase {
  let owner = "0x1000000000000000000000000000000000000009", shop = "0x1000000000000000000000000000000000000003"
  func state(balance: String = "13951957") -> WalletState {
    WalletState(.object(["balance": .string(balance), "caps": .object(["single": .string("10050000"), "daily": .string("12012000")]),
      "purchases": .array([
        .object(["payee": .string(shop), "merchant": .string("Example Shop"), "amount": .string("5000000"), "state": .string("settled"), "purchaseKey": .string("k1"), "createdAt": .number(1_700_000_000_000), "txHash": .string("0xaa")]),
        .object(["payee": .string(owner), "amount": .string("100000"), "state": .string("settled"), "purchaseKey": .string("k2"), "createdAt": .number(1_800_000_000_000)]),
        .object(["payee": .string("0x2000000000000000000000000000000000000004"), "merchant": .string("evil 0x2000000000000000000000000000000000000004"), "amount": .string("1"), "state": .string("failed"), "purchaseKey": .string("k3")])])]))
  }
  func testOwnerFirstLabelledAndNoAddressInIdsOrText() {
    let p = AssistantData.payees(state(), owner: owner, nicknames: [:], salt: "s1")
    XCTAssertEqual(p.first?.label, "我的 Coinbase 钱包"); XCTAssertEqual(p.first?.last4, "0009"); XCTAssertTrue(p.first!.isOwner)
    XCTAssertEqual(p.count, 3)
    XCTAssertEqual(p[2].label, "收款方")   // AI-written name carrying an address is dropped
    for x in p {
      XCTAssertFalse(x.id.lowercased().contains(x.address.lowercased().dropFirst(2).prefix(12)))
      for t in AssistantData.indexText(x) + [x.display] { XCTAssertFalse(t.contains("0x")); XCTAssertNil(t.range(of: "[0-9a-fA-F]{8,}", options: .regularExpression)) }
    }
    XCTAssertNotEqual(AssistantData.payees(state(), owner: owner, nicknames: [:], salt: "s2").first?.id, p.first?.id)   // salted
  }
  func testNicknamesAndMatching() {
    let p = AssistantData.payees(state(), owner: owner, nicknames: [shop.lowercased(): "楼下咖啡店"], salt: "s")
    XCTAssertEqual(AssistantData.match("咖啡店", p).map(\.address), [shop])
    XCTAssertEqual(AssistantData.match("0003", p).map(\.address), [shop])
    XCTAssertEqual(AssistantData.match("我自己", p).map(\.address), [owner])
    XCTAssertEqual(AssistantData.match("my base account", p).map(\.address), [owner])
    XCTAssertTrue(AssistantData.match("0x9999999999999999999999999999999999999999", p).isEmpty)   // unsaved address never matches
    XCTAssertNil(AssistantData.validNickname("0xabc")); XCTAssertNil(AssistantData.validNickname("deadbeefcafe")); XCTAssertNil(AssistantData.validNickname(String(repeating: "a", count: 25)))
    XCTAssertNil(AssistantData.validNickname("a\nb")); XCTAssertEqual(AssistantData.validNickname(" 房东 "), "房东")
  }
  func testPaymentsRepeatAndNoBalanceIndexed() {
    let s = state(), p = AssistantData.payees(s, owner: owner, nicknames: [:], salt: "s")
    let y = AssistantData.payments(s, payees: p, salt: "s")
    XCTAssertEqual(y.count, 3); XCTAssertEqual(AssistantData.lastRepeatable(y)?.amount, 100000)
    for x in y { for t in AssistantData.indexText(x) { XCTAssertFalse(t.contains("13.95")); XCTAssertFalse(t.contains("0x")) } }
  }
  func testPayChecks() {
    let s = state(), p = AssistantData.payees(s, owner: owner, nicknames: [:], salt: "s")
    XCTAssertEqual(AssistantData.checkPay(payeeId: "p_unknown", amount: 1, payees: p, state: s), .unknownPayee)
    XCTAssertEqual(AssistantData.checkPay(payeeId: p[0].id, amount: 0, payees: p, state: s), .badAmount)
    XCTAssertEqual(AssistantData.checkPay(payeeId: p[0].id, amount: -3, payees: p, state: s), .badAmount)
    XCTAssertEqual(AssistantData.checkPay(payeeId: p[0].id, amount: .nan, payees: p, state: s), .badAmount)
    if case .problem = AssistantData.checkPay(payeeId: p[0].id, amount: 11, payees: p, state: s) {} else { XCTFail("over per-payment cap") }
    if case .problem = AssistantData.checkPay(payeeId: p[0].id, amount: 1, payees: p, state: state(balance: "5")) {} else { XCTFail("over balance") }
    XCTAssertEqual(AssistantData.checkPay(payeeId: p[0].id, amount: 0.1, payees: p, state: s), .ok(p[0], 100_000))
  }
}
