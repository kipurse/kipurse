import XCTest
@testable import KipurseCore

/// t915: orbs open each AI's own app; 在线 only from a real recent call; "最近活动" from the server's last-seen time.
final class AgentPresenceT915Tests: XCTestCase {
  func testAppLinksVerified() {
    XCTAssertEqual(AgentBuy.appLink(for: "muse")?.primary.absoluteString, "https://muse.ai/chat")
    XCTAssertEqual(AgentBuy.appLink(for: "claude")?.primary.absoluteString, "https://claude.ai/new")
    XCTAssertEqual(AgentBuy.appLink(for: "grok")?.primary.scheme, "grokbot")
    XCTAssertEqual(AgentBuy.appLink(for: "siri")?.primary.absoluteString, "shortcuts://")
    for k in ["muse", "claude", "grok", "siri"] { XCTAssertEqual(AgentBuy.appLink(for: k)?.fallback?.host, "apps.apple.com", k) }
    XCTAssertNil(AgentBuy.appLink(for: "unknown"))
  }
  func testOnlineOnlyWithRealRecentCall() {
    let now = Date()
    XCTAssertEqual(AgentPhase.derive(connected: true, paused: false, allPaused: false, pendingPayments: 0, lastUsed: now.addingTimeInterval(-10), now: now), .online)
    XCTAssertEqual(AgentPhase.derive(connected: true, paused: false, allPaused: false, pendingPayments: 0, lastUsed: now.addingTimeInterval(-301), now: now), .idle)
    XCTAssertEqual(AgentPhase.derive(connected: true, paused: false, allPaused: false, pendingPayments: 0, lastUsed: nil, now: now), .idle, "authorized but never seen = not lit")
    XCTAssertEqual(AgentPhase.derive(connected: false, paused: false, allPaused: false, pendingPayments: 0, lastUsed: now, now: now), .offline)
  }
  func testLastSeenText() {
    let now = Date()
    XCTAssertNil(AgentPhase.lastSeen(nil, now: now))
    XCTAssertEqual(AgentPhase.lastSeen(now.addingTimeInterval(-20), now: now)?.zh, "最近活动 刚刚")
    XCTAssertEqual(AgentPhase.lastSeen(now.addingTimeInterval(-185), now: now)?.zh, "最近活动 3 分钟前")
    XCTAssertEqual(AgentPhase.lastSeen(now.addingTimeInterval(-7200), now: now)?.en, "Active 2 h ago")
    XCTAssertEqual(AgentPhase.lastSeen(now.addingTimeInterval(-3 * 86400), now: now)?.zh, "最近活动 3 天前")
  }
}
