import XCTest
@testable import KipurseCore

/// t1246 (decision 116): F8 — the phone bounds a card trust by its OWN ceiling (the AI limits the owner set, else 5 / 20 USDC);
/// F9 — a push button only opens the card (no Face ID / signing straight from the lock screen).
final class T1246F8F9Tests: XCTestCase {
  func msg(single: String, daily: String) -> OwnerTrustMessage {
    OwnerTrustMessage(account: "0x" + String(repeating: "2", count: 40), merchant: "0x" + String(repeating: "a", count: 64), name: "shop.example", epoch: "0",
      payees: ["0x" + String(repeating: "3", count: 40)], signers: [], single: single, daily: daily, expiry: "1", nonce: "0x01", deadline: "1")
  }
  func testCeilingIsOwnersLimitsElseDefaults() {
    XCTAssertTrue(OwnerAsk.trustCeiling(saved: nil) == (5_000_000, 20_000_000))
    XCTAssertTrue(OwnerAsk.trustCeiling(saved: AISpendLimits.Saved(single: 2_000_000, daily: 10_000_000, term: 50_000_000)) == (2_000_000, 10_000_000))
  }
  func testTrustWithinCeilingPasses() {
    XCTAssertEqual(OwnerAsk.trustCapProblems(msg(single: "2000000", daily: "10000000"), ceiling: (2_000_000, 10_000_000)), [])
    XCTAssertEqual(OwnerAsk.trustCapProblems(msg(single: "1000000", daily: "5000000"), ceiling: (2_000_000, 10_000_000)), [])
  }
  func testServerCannotRaiseCapsAboveThePhone() {
    // a compromised server asks for the whole wallet limit as the daily trust cap -> refused on the phone
    XCTAssertFalse(OwnerAsk.trustCapProblems(msg(single: "2000000", daily: "500000000"), ceiling: (2_000_000, 10_000_000)).isEmpty)
    XCTAssertFalse(OwnerAsk.trustCapProblems(msg(single: "2000001", daily: "10000000"), ceiling: (2_000_000, 10_000_000)).isEmpty)
    XCTAssertFalse(OwnerAsk.trustCapProblems(msg(single: "6000000", daily: "20000000"), ceiling: OwnerAsk.trustCeiling(saved: nil)).isEmpty)
    XCTAssertFalse(OwnerAsk.trustCapProblems(msg(single: "0", daily: "1"), ceiling: (2_000_000, 10_000_000)).isEmpty)
    XCTAssertFalse(OwnerAsk.trustCapProblems(msg(single: "x", daily: "1"), ceiling: (2_000_000, 10_000_000)).isEmpty)
    XCTAssertFalse(OwnerAsk.trustCapProblems(msg(single: "3", daily: "2"), ceiling: (2_000_000, 10_000_000)).isEmpty)
  }
  func testPushHintOnlyForTheTwoChoices() {
    XCTAssertNotNil(OwnerAsk.pushChoiceHint(mode: "trust")); XCTAssertNotNil(OwnerAsk.pushChoiceHint(mode: "once")); XCTAssertNil(OwnerAsk.pushChoiceHint(mode: "x"))
    XCTAssertTrue(OwnerAsk.pushChoiceHint(mode: "trust")!.zh.contains("完整地址"))
  }
  /// F9 guard: no path from a push action to approveAsk without the owner's tap on the card.
  func testPushActionNeverStartsFaceID() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let v = try String(contentsOf: root.appendingPathComponent("App/Sources/AllowancesView.swift"), encoding: .utf8)
    let pb = try String(contentsOf: root.appendingPathComponent("App/Sources/PushBridge.swift"), encoding: .utf8)
    XCTAssertFalse(v.contains("userTapped: false"), "a push-opened card must not sign without the owner's tap")
    let task = v.components(separatedBy: "\n").filter { $0.contains(".task(id: st.pendingAsk") }
    XCTAssertEqual(task.count, 1); XCTAssertFalse(task[0].contains("approveAsk"))
    XCTAssertFalse(pb.contains("approveAsk"))
    // every approveAsk call sits inside a button action on the card
    for l in v.components(separatedBy: "\n") where l.contains("st.approveAsk(") { XCTAssertTrue(l.contains("BigButton("), l) }
  }
}
