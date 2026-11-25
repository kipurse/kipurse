import XCTest
@testable import KipurseCore

/// t1157: the home Siri bead reads the real (phone) Siri row, not an empty "oauth-siri" row; the connect reply's saved limits replace a stale view.
final class T1157AgentMatchTests: XCTestCase {
  private func j(_ o: Any) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: o)) }
  private let oldServer: [[String: Any]] = [["id": "oauth-siri", "name": "Siri", "kind": "custom", "connected": false],
                                            ["id": "siri", "name": "Siri", "kind": "siri", "connected": true]]
  func testOauthSiriFalseThenSiriTruePicksTheConnectedSiriRow() {
    let a = AgentMatch.pick(oldServer.map(j), name: "Siri")
    XCTAssertEqual(a?["id"]?.string, "siri")
    let ph = AgentPhase.derive(connected: a?["connected"]?.bool ?? false, paused: false, allPaused: false, pendingPayments: 0, lastUsed: nil, now: Date())
    XCTAssertNotEqual(ph, .offline, "not 未连接")
    XCTAssertEqual(ph, .online, "t1164: connected = always lit")
  }
  func testExactIdBeatsNameEvenWhenListedLater() {
    XCTAssertEqual(AgentMatch.pick([["id": "oauth-siri", "name": "Siri", "kind": "custom", "connected": true], ["id": "siri", "kind": "siri", "connected": false]].map(j), name: "Siri")?["id"]?.string, "siri")
  }
  func testNameMatchStillWorksForGrokBotAndConnectedFirst() {
    let l: [[String: Any]] = [["id": "grok", "name": "Grok", "kind": "grok", "connected": false, "revoked": true], ["id": "grok-bot", "name": "Grok Bot", "kind": "grok-bot", "connected": true]]
    XCTAssertEqual(AgentMatch.pick(l.map(j), name: "Grok")?["id"]?.string, "grok-bot", "revoked rows never count")
    XCTAssertNil(AgentMatch.pick([["id": "muse", "name": "Muse"]].map(j), name: "Siri"))
  }
  func testServerAfterFixSingleSiriRow() {
    XCTAssertEqual(AgentMatch.pick([j(["id": "siri", "name": "Siri", "kind": "siri", "connected": true])], name: "Siri")?["connected"]?.bool, true)
  }
  func testWithEverydayMakesTheSavedLimitsVisible() {
    let s = WalletState(j(["mode": "MAIN", "balance": "13235320"]))
    XCTAssertNil(AISpendLimits.saved(s.raw), "stale cache: limits look unset")
    let reply: [String: Any] = ["authorized": true, "custom": true, "at": 1795400000000, "requestedSingle": "2000000", "requestedDaily": "5000000", "requestedTerm": "30000000"]
    let n = s.withEveryday(j(reply))
    XCTAssertEqual(AISpendLimits.saved(n.raw), AISpendLimits.Saved(single: 2_000_000, daily: 5_000_000, term: 30_000_000))
    XCTAssertEqual(n.raw["balance"]?.string, "13235320", "nothing else changes")
    XCTAssertEqual(s.withEveryday(.null).raw, s.raw, "a non-object reply changes nothing")
  }
}
