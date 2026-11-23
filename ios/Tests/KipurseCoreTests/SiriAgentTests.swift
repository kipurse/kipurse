import XCTest
@testable import KipurseCore

final class SiriAgentTests: XCTestCase {
  func testServerSentenceWins() { XCTAssertEqual(SiriAgentAnswer.text(["decision": "can_pay", "say_to_user": "已付 1 USDC"], zh: true), "已付 1 USDC") }
  func testFallbacks() {
    XCTAssertEqual(SiriAgentAnswer.text(["decision": "can_pay"], zh: true), "付好了。")
    XCTAssertTrue(SiriAgentAnswer.text(["decision": "ask_owner"], zh: true).contains("Face ID"))
    XCTAssertTrue(SiriAgentAnswer.text(["decision": "ask_owner"], zh: false).contains("Face ID"))
    XCTAssertEqual(SiriAgentAnswer.text(["decision": "refuse"], zh: false), "Not paid. No money moved.")
    XCTAssertEqual(SiriAgentAnswer.text([:], zh: true), "没有付款，钱没有动。")
  }

  func testSiriSkipInsideAllowanceOnly() throws {
    func st(_ j: String) throws -> WalletState { WalletState(try JSONDecoder().decode(JSONValue.self, from: Data(j.utf8))) }
    let s = try st(#"{"caps":{"single":"5000000","daily":"20000000"},"spent":{"today":"18000000"}}"#)
    XCTAssertTrue(SiriSkip.inside(1_000_000, s))
    XCTAssertTrue(SiriSkip.inside(2_000_000, s))
    XCTAssertFalse(SiriSkip.inside(2_000_001, s), "over today's remaining")
    XCTAssertFalse(SiriSkip.inside(6_000_000, try st(#"{"caps":{"single":"5000000","daily":"20000000"}}"#)), "over per-payment cap")
    XCTAssertFalse(SiriSkip.inside(1_000_000, try st(#"{}"#)), "unknown caps -> ask")
    XCTAssertFalse(SiriSkip.inside(1_000_000, nil)); XCTAssertFalse(SiriSkip.inside(0, s))
  }
}
