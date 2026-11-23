import XCTest
@testable import KipurseCore

/// t899: Siri has its own owner-set allowance like other AIs; inside it no Face ID, over it Face ID (server ask_owner).
final class SiriAllowanceT899Tests: XCTestCase {
  func testAtomicParsing() {
    XCTAssertEqual(AgentLimits.atomic("1.5"), 1_500_000); XCTAssertEqual(AgentLimits.atomic("20"), 20_000_000); XCTAssertEqual(AgentLimits.atomic("0,25"), 250_000)
    XCTAssertEqual(AgentLimits.atomic("1000000"), 1_000_000_000_000, "large caps allowed (owner 2026-10-25)")
    XCTAssertNil(AgentLimits.atomic("0")); XCTAssertNil(AgentLimits.atomic("-1")); XCTAssertNil(AgentLimits.atomic("abc")); XCTAssertNil(AgentLimits.atomic("1.1234567")); XCTAssertNil(AgentLimits.atomic(""))
  }
  func testAllowanceEditableValidation() {
    XCTAssertNil(AgentLimits.problem(single: "2", daily: "10", zh: true))
    XCTAssertNil(AgentLimits.problem(single: "5", daily: "5", zh: false))
    XCTAssertNotNil(AgentLimits.problem(single: "6", daily: "5", zh: true))
    XCTAssertNotNil(AgentLimits.problem(single: "", daily: "5", zh: false))
  }
  func testDraftItemIsAgentLimitsForSiri() {
    let i = AgentLimits.item(agentId: "siri", single: "2", daily: "10", monthly: "300", resume: false)
    XCTAssertEqual(i["kind"] as? String, "agent_limits"); XCTAssertEqual(i["agentId"] as? String, "siri"); XCTAssertEqual(i["single"] as? String, "2"); XCTAssertEqual(i["daily"] as? String, "10"); XCTAssertEqual(i["monthly"] as? String, "300"); XCTAssertNil(i["resume"])
    XCTAssertNil(AgentLimits.item(agentId: "siri", single: "2", daily: "50", monthly: "30", resume: true)["monthly"], "old monthly below new daily is dropped")
    XCTAssertEqual(AgentLimits.item(agentId: "siri", single: "2", daily: "5", monthly: nil, resume: true)["resume"] as? Bool, true, "resume a paused Siri")
  }
  func testWithinAllowanceNoFaceID() {
    XCTAssertFalse(AgentLimits.needsFaceID(["decision": "can_pay", "state": "paid"]))
    XCTAssertEqual(SiriAgentAnswer.text(["decision": "can_pay"], zh: true), "付好了。")
  }
  func testOverAllowanceFaceID() {
    let over: [String: Any] = ["decision": "ask_owner", "reason": "AGENT_SINGLE_CAP"]
    XCTAssertTrue(AgentLimits.needsFaceID(over)); XCTAssertTrue(SiriAgentAnswer.text(over, zh: true).contains("Face ID"))
    XCTAssertTrue(AgentLimits.needsFaceID(["decision": "ask_owner", "reason": "AGENT_DAILY_CAP"]))
    XCTAssertFalse(AgentLimits.needsFaceID(["decision": "refuse", "reason": "AGENT_STOPPED"]), "paused Siri refuses; owner resumes in app with Face ID")
  }
}
