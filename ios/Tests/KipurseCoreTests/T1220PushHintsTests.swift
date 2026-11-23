import XCTest
@testable import KipurseCore

/// t1220u (§6#96): a pushed AI request (kind mandate / owner_ask) is remembered so Home can list it under 「待你批准」 without a
/// live server session; nothing else is remembered, the newest text wins, old ones drop, and the server list replaces them.
final class T1220PushHintsTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  func push(_ kind: String, _ id: String?) -> [AnyHashable: Any] { var kp: [String: Any] = ["kind": kind]; if let id { kp["approvalId"] = id }; return ["aps": ["alert": ["title": "t", "body": "b"]], "kp": kp] }
  func testServerMandatePushIsRemembered() {
    let h = PendingPushHints.hint(userInfo: push("mandate", "apr_9ac054a79d7c"), body: "AI 请求：⚠️ 新收款方 shop.example，付 5 USDC", at: now)
    XCTAssertEqual(h, PendingPushHint(id: "apr_9ac054a79d7c", kind: "mandate", text: "AI 请求：⚠️ 新收款方 shop.example，付 5 USDC", at: now.timeIntervalSince1970))
    XCTAssertEqual(PendingPushHints.hint(userInfo: push("owner_ask", "apr_x"), body: "b", at: now)?.kind, "owner_ask")
  }
  func testOtherPushesAreNot() {
    for k in ["hold", "payee_confirm", "anomaly", "tx"] { XCTAssertNil(PendingPushHints.hint(userInfo: push(k, "apr_x"), body: "b", at: now), k) }
    XCTAssertNil(PendingPushHints.hint(userInfo: push("mandate", nil), body: "b", at: now), "no id")
    XCTAssertNil(PendingPushHints.hint(userInfo: push("mandate", ""), body: "b", at: now))
    XCTAssertNil(PendingPushHints.hint(userInfo: ["approval": "a1"], body: "b", at: now))
  }
  func testMergeOnePerRequestNewestWinsOldDrop() {
    let a1 = PendingPushHint(id: "a", kind: "mandate", text: "old", at: now.timeIntervalSince1970 - 600)
    let a2 = PendingPushHint(id: "a", kind: "mandate", text: "repush", at: now.timeIntervalSince1970 - 10)
    let b = PendingPushHint(id: "b", kind: "owner_ask", text: "b", at: now.timeIntervalSince1970 - 8 * 86400)
    let m = PendingPushHints.merge([a1, b], [a2], now: now)
    XCTAssertEqual(m, [a2], "same request once (the re-push text), 8-day-old one dropped")
    XCTAssertEqual(PendingPushHints.merge([a2], [a1], now: now), [a2], "an older copy never replaces a newer one")
    let many = (0..<30).map { PendingPushHint(id: "r\($0)", kind: "mandate", text: "t", at: now.timeIntervalSince1970 - Double($0)) }
    XCTAssertEqual(PendingPushHints.merge(many, [], now: now).count, PendingPushHints.maxCount)
  }
  func testServerListWins() {
    let a = PendingPushHint(id: "a", kind: "mandate", text: "t", at: now.timeIntervalSince1970)
    let b = PendingPushHint(id: "b", kind: "mandate", text: "t", at: now.timeIntervalSince1970)
    XCTAssertEqual(PendingPushHints.extra([a, b], known: ["a"], now: now), [b])
  }
  func testRoundTrip() {
    let a = PendingPushHint(id: "a", kind: "mandate", text: "付 5 USDC", at: 1)
    XCTAssertEqual(PendingPushHints.decode(PendingPushHints.encode([a])), [a]); XCTAssertEqual(PendingPushHints.decode(nil), []); XCTAssertEqual(PendingPushHints.decode(Data("x".utf8)), [])
  }
}
