import XCTest
@testable import KipurseCore

/// t1161 (decision 78): every AI's home bead is honest — [zh] only after a real call in the last 5 min, on the row the AI really used;
/// Siri intents mark Siri used (read-only marker, throttled, never faked).
final class T1161BeadTests: XCTestCase {
  private func j(_ o: Any) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: o)) }
  private let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
  private func ago(_ s: Double, _ now: Date) -> String { iso.string(from: now.addingTimeInterval(-s)) }
  private func phase(_ rows: [[String: Any]], _ name: String, _ now: Date) -> (String?, AgentPhase) {
    let a = AgentMatch.pick(rows.map(j), name: name)
    return (a?["id"]?.string, AgentPhase.derive(connected: a?["connected"]?.bool ?? false, paused: a?["paused"]?.bool ?? false, allPaused: false,
                                                 pendingPayments: 0, lastUsed: AgentMatch.lastUsed(a?["lastUsed"]), now: now))
  }
  func testEachAgentOnlineNowIdleAfterSixMinutes() {
    let now = Date()
    let rows: (Double) -> [[String: Any]] = { s in [
      ["id": "muse", "name": "Muse", "kind": "muse", "connected": true, "lastUsed": self.ago(s, now)],
      ["id": "grok-bot", "name": "Grok Bot", "kind": "grok-bot", "connected": true, "lastUsed": self.ago(s, now)],
      ["id": "oauth-claude-desktop", "name": "Claude", "kind": "claude-desktop", "connected": true, "lastUsed": self.ago(s, now)],
      ["id": "siri", "name": "Siri", "kind": "siri", "connected": true, "lastUsed": self.ago(s, now)]] }
    for n in ["Muse", "Grok", "Claude", "Siri"] {
      XCTAssertEqual(phase(rows(5), n, now).1, .online, n)
      XCTAssertEqual(phase(rows(299), n, now).1, .online, n)
      XCTAssertEqual(phase(rows(360), n, now).1, .online, "t1164: 6 min ago still lit " + n)
      XCTAssertEqual(phase(rows(86400 * 40), n, now).1, .online, n)
    }
  }
  func testTheRowReallyUsedWinsOverAStaleDuplicate() {
    let now = Date()
    let grok: [[String: Any]] = [["id": "grok", "name": "Grok", "kind": "grok", "connected": true, "lastUsed": ago(86400, now)],
                                 ["id": "grok-bot", "name": "Grok Bot", "kind": "grok-bot", "connected": true, "lastUsed": ago(10, now)]]
    XCTAssertEqual(phase(grok, "Grok", now).0, "grok-bot"); XCTAssertEqual(phase(grok, "Grok", now).1, .online)
    let claude: [[String: Any]] = [["id": "claude", "name": "Claude", "kind": "claude", "connected": false, "lastUsed": ago(5, now)],
                                   ["id": "oauth-claude-desktop", "name": "Claude", "kind": "claude-desktop", "connected": true, "lastUsed": ago(30, now)]]
    XCTAssertEqual(phase(claude, "Claude", now).0, "oauth-claude-desktop", "a disconnected row never lights the bead")
    let claudeNever: [[String: Any]] = [["id": "claude", "name": "Claude", "kind": "claude", "connected": false, "lastUsed": ago(86400, now)],
                                        ["id": "oauth-claude-desktop", "name": "Claude", "kind": "claude-desktop", "connected": true]]
    XCTAssertEqual(phase(claudeNever, "Claude", now).0, "oauth-claude-desktop", "t1164: connected-but-never-used beats an old disconnected exact row")
    XCTAssertEqual(phase(claudeNever, "Claude", now).1, .online)
    XCTAssertEqual(phase([["id": "oauth-siri", "name": "Siri", "kind": "custom", "connected": true]], "Siri", now).0, nil, "the hidden oauth-siri record never counts")
    let muse: [[String: Any]] = [["id": "oauth-muse", "name": "Muse", "kind": "muse", "connected": true, "lastUsed": ago(20, now)],
                                 ["id": "muse", "name": "Muse", "kind": "muse", "connected": true, "lastUsed": ago(4000, now)]]
    XCTAssertEqual(phase(muse, "Muse", now).1, .online)
    let siri: [[String: Any]] = [["id": "oauth-siri", "name": "Siri", "kind": "custom", "connected": false],
                                 ["id": "siri", "name": "Siri", "kind": "siri", "connected": true, "lastUsed": ago(3, now)]]
    XCTAssertEqual(phase(siri, "Siri", now).0, "siri"); XCTAssertEqual(phase(siri, "Siri", now).1, .online)
    XCTAssertEqual(phase([["id": "GROK-BOT", "name": "GROK BOT", "kind": "Grok-Bot", "connected": true, "lastUsed": ago(1, now)]], "Grok", now).1, .online, "case-insensitive")
  }
  func testNeverFakeOnline() {
    let now = Date()
    XCTAssertEqual(phase([["id": "grok-bot", "name": "Grok Bot", "connected": false, "lastUsed": ago(1, now)]], "Grok", now).1, .offline, "expired / revoked = 未连接 even if just used")
    XCTAssertEqual(phase([["id": "grok-bot", "name": "Grok Bot", "connected": true]], "Grok", now).1, .online, "t1164: never used but connected = lit")
    XCTAssertEqual(phase([["id": "muse", "name": "Muse", "connected": true, "revoked": true, "lastUsed": ago(1, now)]], "Muse", now).0, nil)
    XCTAssertEqual(AgentPhase.derive(connected: true, paused: false, allPaused: false, pendingPayments: 0, lastUsed: now.addingTimeInterval(60), now: now), .online, "server clock 1 min ahead")
    XCTAssertEqual(AgentPhase.derive(connected: true, paused: false, allPaused: false, pendingPayments: 0, lastUsed: now.addingTimeInterval(3600), now: now), .online, "t1164: lastUsed no longer matters")
  }
  func testLastUsedParsesServerFormats() {
    XCTAssertNotNil(AgentMatch.lastUsed(.string("2026-11-17T16:40:12.345Z")))
    XCTAssertNotNil(AgentMatch.lastUsed(.string("2026-11-17T16:40:12Z")))
    XCTAssertEqual(AgentMatch.lastUsed(.number(1_795_400_000_000))?.timeIntervalSince1970, 1_795_400_000)
    XCTAssertNil(AgentMatch.lastUsed(.null)); XCTAssertNil(AgentMatch.lastUsed(.string("x")))
  }
  func testSiriSeenMarkerRule() {
    let now = Date()
    XCTAssertEqual(SiriSeenRule.path, "siri/allowances", "the existing read-only route that the server counts as Siri use")
    XCTAssertFalse(SiriSeenRule.shouldMark(hasSession: false, last: nil, now: now), "no phone session: nothing to send (never faked)")
    XCTAssertTrue(SiriSeenRule.shouldMark(hasSession: true, last: nil, now: now))
    XCTAssertFalse(SiriSeenRule.shouldMark(hasSession: true, last: now.addingTimeInterval(-10), now: now), "throttled")
    XCTAssertTrue(SiriSeenRule.shouldMark(hasSession: true, last: now.addingTimeInterval(-31), now: now))
    XCTAssertTrue(SiriSeenRule.throttle < AgentPhase.onlineWindow && SiriSeenRule.timeout <= 5)
    XCTAssertTrue(SiriSeenRule.marked(status: 200)); XCTAssertFalse(SiriSeenRule.marked(status: 401)); XCTAssertFalse(SiriSeenRule.marked(status: nil))
  }
  func testEverySiriIntentMarksSiriFirstAndTheHomeRefreshes() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    for f in ["App/Assistant/AssistantIntents.swift", "App/Assistant/AssistantPayIntents.swift"] {
      let src = try String(contentsOf: root.appendingPathComponent(f), encoding: .utf8)
      let performs = src.components(separatedBy: "\n").filter { $0.contains("func perform() async throws") }
      XCTAssertFalse(performs.isEmpty)
      for l in performs { XCTAssertTrue(l.contains("{ await SiriSeen.mark();"), "\(f): \(l)") }
    }
    let intents = try String(contentsOf: root.appendingPathComponent("App/Assistant/AssistantIntents.swift"), encoding: .utf8)
    XCTAssertTrue(intents.contains("MainnetSession.authedPost(SiriSeenRule.path, [:], timeout: SiriSeenRule.timeout)"))
    XCTAssertTrue(intents.contains("NotificationCenter.default.post(name: AssistantHooks.siriUsed"))
    let model = try String(contentsOf: root.appendingPathComponent("App/Sources/AppModel.swift"), encoding: .utf8)
    XCTAssertTrue(model.contains("forName: AssistantHooks.siriUsed") && model.contains("await self?.refresh()"))
    let pay = try String(contentsOf: root.appendingPathComponent("App/Assistant/AssistantPayIntents.swift"), encoding: .utf8)
    XCTAssertFalse(pay.contains("authedPost(\"siri/allowances\""), "the marker is the only allowances call and it never pays")
  }
}
