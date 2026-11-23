import XCTest
@testable import KipurseCore

final class AddressTrustTests: XCTestCase {
  let a = "0x5A17C3e9c3e9c3e9C3E9c3e9C3e9C3e9C3E9b04d", look = "0x5A1700000000000000000000000000000000b04d"
  func testGroupsAndDiff() {
    XCTAssertEqual(AddressCheck.groups(a).count, 10); XCTAssertEqual(AddressCheck.groups(a).first, "5A17")
    XCTAssertEqual(AddressCheck.diffGroups(a, look), [1, 2, 3, 4, 5, 6, 7, 8]); XCTAssertEqual(AddressCheck.diffGroups(a, a.lowercased()), [])
  }
  func testLookalike() {
    XCTAssertTrue(AddressCheck.isLookalike(a, look)); XCTAssertFalse(AddressCheck.isLookalike(a, a.lowercased()))
    XCTAssertFalse(AddressCheck.isLookalike(a, "0x1111000000000000000000000000000000002222"))
  }
  func testDustRowSuspicious() {
    func row(_ d: String, _ k: String = "deposit") -> LedgerRow? { LedgerRow(.object(["tx": .string("0xab"), "t": .number(1), "kind": .string(k), "delta": .string(d), "balance": .string("1")])) }
    XCTAssertEqual(row("1")?.suspicious, true); XCTAssertEqual(row("0")?.suspicious, true); XCTAssertEqual(row("9999")?.suspicious, true)
    XCTAssertEqual(row("10000")?.suspicious, false); XCTAssertEqual(row("-1", "payment")?.suspicious, false)
  }
  func testOrderRecordParsed() {
    let o: JSONValue = .object(["item": .string("coffee"), "merchant": .string("Blue Cafe"), "user_request": .string("buy me a coffee"), "max_price": .string("1.5"), "tier": .string("stranger"), "payeeName": .string("Blue Cafe"), "payee": .string("0x5A17C3e9c3e9c3e9C3E9c3e9C3e9C3e9C3E9b04d")])
    let r = LedgerRow(.object(["tx": .string("0xab"), "t": .number(1), "kind": .string("payment"), "delta": .string("-500000"), "balance": .string("1"), "order": o]))
    XCTAssertEqual(r?.orderItem, "coffee"); XCTAssertEqual(r?.orderQuote, "buy me a coffee"); XCTAssertEqual(r?.orderBudget, "1.5"); XCTAssertEqual(r?.orderTrial, true); XCTAssertEqual(r?.orderTier, "stranger"); XCTAssertEqual(r?.payeeName, "Blue Cafe")
    let n = LedgerRow(.object(["tx": .string("0xab"), "t": .number(1), "kind": .string("payment"), "delta": .string("-1"), "balance": .string("1")]))
    XCTAssertNil(n?.orderItem); XCTAssertEqual(n?.orderTrial, false)
  }
}
