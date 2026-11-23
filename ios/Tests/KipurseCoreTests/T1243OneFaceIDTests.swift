import XCTest
@testable import KipurseCore

/// t1243 (handbook §6#113): sign-in + approval share ONE Face ID only after the owner taps the button on the full card, within 60 s, once;
/// a new APNs token replaces this phone's previous one (one push per phone).
final class T1243OneFaceIDTests: XCTestCase {
  let t0 = Date(timeIntervalSince1970: 1_800_000_000)
  func testReuseOnlyAfterATapWithinTheWindow() {
    XCTAssertTrue(UnlockReuse.allows(evaluatedAt: t0, now: t0.addingTimeInterval(5), userTapped: true))
    XCTAssertTrue(UnlockReuse.allows(evaluatedAt: t0, now: t0.addingTimeInterval(60), userTapped: true))
    XCTAssertFalse(UnlockReuse.allows(evaluatedAt: t0, now: t0.addingTimeInterval(60.5), userTapped: true), "older than 60 s -> a new Face ID")
    XCTAssertFalse(UnlockReuse.allows(evaluatedAt: t0, now: t0.addingTimeInterval(1), userTapped: false), "never without the owner's tap on the card (lock screen / automatic paths)")
    XCTAssertFalse(UnlockReuse.allows(evaluatedAt: t0, now: t0.addingTimeInterval(-1), userTapped: true), "clock went backwards -> no reuse")
    XCTAssertFalse(UnlockReuse.allows(evaluatedAt: t0, now: t0.addingTimeInterval(90), userTapped: true, window: 600), "a caller can't widen the 60 s window")
  }
  func testSingleUseAndDiscard() {
    var discarded: [String] = []
    let u = ReusableUnlock<String>(discard: { discarded.append($0) })
    XCTAssertNil(u.take(now: t0, userTapped: true), "nothing held (session existed) -> normal Face ID")
    u.hold("ctx1", at: t0)
    XCTAssertEqual(u.take(now: t0.addingTimeInterval(10), userTapped: true), "ctx1")
    XCTAssertNil(u.take(now: t0.addingTimeInterval(11), userTapped: true), "single use")
    XCTAssertEqual(discarded, [], "a taken context is the caller's to invalidate")
    u.hold("ctx2", at: t0)
    XCTAssertNil(u.take(now: t0.addingTimeInterval(1), userTapped: false))
    XCTAssertEqual(discarded, ["ctx2"], "a refused take discards (invalidates) it")
    XCTAssertFalse(u.isHolding)
  }
  func testExpiresAfterTheWindowAndHoldReplaces() {
    var discarded: [String] = []
    let u = ReusableUnlock<String>(discard: { discarded.append($0) })
    u.hold("a", at: t0); u.hold("b", at: t0)
    XCTAssertEqual(discarded, ["a"], "a newer sign-in replaces (and invalidates) the older one")
    XCTAssertFalse(u.expire(now: t0.addingTimeInterval(30)))
    XCTAssertTrue(u.isHolding)
    XCTAssertTrue(u.expire(now: t0.addingTimeInterval(61)))
    XCTAssertEqual(discarded, ["a", "b"]); XCTAssertFalse(u.isHolding)
    u.hold("c", at: t0)
    XCTAssertNil(u.take(now: t0.addingTimeInterval(61), userTapped: true)); XCTAssertEqual(discarded.last, "c")
  }
  func testReplacedToken() {
    let old = String(repeating: "a1", count: 32), new = String(repeating: "b2", count: 32), w = "0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb"
    XCTAssertEqual(PushPermission.replacedToken(lastSent: PushPermission.sentKey(token: old, wallet: w), newToken: new), old)
    XCTAssertEqual(PushPermission.replacedToken(lastSent: old, newToken: new), old, "apps <= 80 stored the bare token")
    XCTAssertNil(PushPermission.replacedToken(lastSent: PushPermission.sentKey(token: new, wallet: w), newToken: new), "same token (new wallet) -> nothing to replace")
    XCTAssertNil(PushPermission.replacedToken(lastSent: nil, newToken: new))
    XCTAssertNil(PushPermission.replacedToken(lastSent: "zz|" + w, newToken: new), "only a real APNs token")
  }
  func testAppWiring() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let push = try String(contentsOf: root.appendingPathComponent("App/Sources/PushBridge.swift"), encoding: .utf8)
    XCTAssertTrue(push.contains("PushPermission.replacedToken(lastSent:"), "the upload sends the previous token as replaces")
    let av = try String(contentsOf: root.appendingPathComponent("App/Sources/AllowancesView.swift"), encoding: .utf8)
    XCTAssertTrue(av.contains("signInUnlock.take(now: Date(), userTapped: userTapped, tag: tag)"), "approveAsk reuses the sign-in Face ID only via the rule (t1266: bound to id + choice)")
    // t1246 (§6#116 F9): the push-action path no longer signs at all — it only opens the card (see T1246F8F9Tests); every approveAsk is a tap.
    XCTAssertFalse(av.contains("approveAsk(a, mode: p.mode"), "the push-action path never signs")
  }
}
