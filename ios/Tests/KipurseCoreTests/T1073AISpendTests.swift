import XCTest
@testable import KipurseCore

/// t1075/t1076: the reported owner has no AI total. Chain 10/50/200 is not a selection.
/// A complete single/daily/total row can be reused. A row without a total cannot.
final class T1073AISpendTests: XCTestCase {
  func object(_ j: [String: JSONValue]) -> JSONValue { .object(j) }
  func testUnsetFloorIsNotASelection() {
    let raw = object([
      "caps": object(["single": .string("10000000"), "daily": .string("50000000"), "term": .string("200000000")]),
      "everyday": object(["single": .string("10000000"), "daily": .string("50000000"), "custom": .bool(false), "at": .null])
    ])
    XCTAssertNil(AISpendLimits.saved(raw))
    XCTAssertNil(AISpendLimits.saved(object(["caps": object(["single": .string("10000000"), "daily": .string("50000000"), "term": .string("200000000")])])))
  }
  func testSingleAndDailyWithoutTotalDoNotAuthorize() {
    let raw = object([
      "caps": object(["term": .string("200000000")]),
      "everyday": object(["single": .string("2500000"), "daily": .string("7000000"), "custom": .bool(true), "authorized": .bool(true), "at": .number(1_710_000_000_000)])
    ])
    XCTAssertNil(AISpendLimits.saved(raw))
    XCTAssertNil(AISpendLimits.parseList("2500000,7000000"))
  }
  func testExplicitTotalIsKeptAndIsNotTheFloor() {
    let raw = object([
      "caps": object(["single": .string("10000000"), "daily": .string("50000000"), "term": .string("200000000")]),
      "everyday": object([
        "single": .string("2500000"), "daily": .string("7000000"), "term": .string("15000000"),
        "requestedSingle": .string("2500000"), "requestedDaily": .string("7000000"), "requestedTerm": .string("15000000"),
        "custom": .bool(true), "authorized": .bool(true), "at": .number(1_710_000_000_000)
      ])
    ])
    XCTAssertEqual(AISpendLimits.saved(raw), AISpendLimits.Saved(single: 2_500_000, daily: 7_000_000, term: 15_000_000))
    XCTAssertEqual(AISpendLimits.parseList("2500000,7000000,15000000"), AISpendLimits.Saved(single: 2_500_000, daily: 7_000_000, term: 15_000_000))
  }
  func testBeginnerLimitCopyDoesNotInventAFee() {
    XCTAssertEqual(EverydayLimits.aiTitleZh, "AI 花钱上限")
    XCTAssertEqual(EverydayLimits.aiTitleEn, "AI spending limits")
    XCTAssertEqual(EverydayLimits.aiExplainZh, "所有 AI 共用，每笔、每天、总共最多花多少；免费修改")
    XCTAssertFalse(EverydayLimits.aiExplainEn.isEmpty)
    XCTAssertEqual(EverydayLimits.walletTitleZh, "钱包安全上限")
    XCTAssertEqual(EverydayLimits.walletTitleEn, "Wallet safety limits")
    XCTAssertEqual(EverydayLimits.aboveWalletZh, "超过钱包安全上限，请调低金额或修改安全上限")
    XCTAssertFalse(EverydayLimits.walletExplainZh.contains("0.007"))
    XCTAssertFalse(EverydayLimits.walletExplainEn.contains("0.007"))
    XCTAssertFalse(EverydayLimits.whyZh.contains("0.007"))
    XCTAssertFalse(EverydayLimits.paidZh.contains("0.007"))
  }
  func testOldGatewayAndUnfinishedDecisionGrantNothing() {
    XCTAssertFalse(ConnectApproval.acceptsFirstConnect(nil))
    XCTAssertFalse(ConnectApproval.acceptsFirstConnect("reuse"))
    XCTAssertFalse(ConnectApproval.acceptsFirstConnect(""))
    XCTAssertTrue(ConnectApproval.acceptsFirstConnect("first"))
    XCTAssertTrue(ConnectApproval.finishedDecision("approved", approve: true))
    XCTAssertTrue(ConnectApproval.finishedDecision("denied", approve: false))
    XCTAssertFalse(ConnectApproval.finishedDecision("approved", approve: false))
    XCTAssertFalse(ConnectApproval.finishedDecision("denied", approve: true))
    XCTAssertFalse(ConnectApproval.finishedDecision(nil, approve: true))
    XCTAssertFalse(ConnectApproval.finishedDecision("error", approve: true))
  }
  func testFirstConnectStatementBindsAmountsAndIsNotTheReuseStatement() {
    let text = ConnectApproval.firstText(wallet: "0xAB", clientId: "kpc_1", agent: "Siri", request: "req1", redirect: "https://kipurse.com/connect/Siri", single: 2_500_000, daily: 7_000_000, total: 15_000_000, nonce: "n1", exp: 1_700_000_000, approve: true)
    XCTAssertEqual(text, "Kipurse approve first connection v1\nwallet:0xab\nclient:kpc_1\nagent:Siri\nrequest:req1\nredirect:https://kipurse.com/connect/Siri\nsingle:2500000\ndaily:7000000\ntotal:15000000\naction:approve\nnonce:n1\nexp:1700000000")
    XCTAssertNotEqual(text, ConnectApproval.text(wallet: "0xAB", req: "req1", clientId: "kpc_1", name: "Siri", redirect: "https://kipurse.com/connect/Siri", exp: 1_700_000_000, approve: true))
  }

  /// t1076 / t1129: a wallet/chain caps change is not an AI everyday policy. The AI card must not treat caps as saved limits.
  func testChainCapsAreNotDisplayedAsEverydayPolicy() {
    func object(_ d: [String: JSONValue]) -> JSONValue { .object(d) }
    let caps = object(["single": .string("10000000"), "daily": .string("50000000"), "term": .string("200000000"),
                       "start": .string("1792642081"), "end": .string("1824178081")])
    XCTAssertNil(AISpendLimits.saved(object(["caps": caps])), "chain caps alone are not a policy — the AI card stays blank")
    let everyday = object([
      "single": .string("2500000"), "daily": .string("7000000"), "term": .string("15000000"),
      "requestedSingle": .string("2500000"), "requestedDaily": .string("7000000"), "requestedTerm": .string("15000000"),
      "custom": .bool(true), "authorized": .bool(true), "at": .number(1_710_000_000_000)
    ])
    let both = object(["caps": caps, "everyday": everyday])
    XCTAssertEqual(AISpendLimits.saved(both), AISpendLimits.Saved(single: 2_500_000, daily: 7_000_000, term: 15_000_000),
                   "after a chain caps update, the saved AI policy is still what the card should show")
  }
}
