import XCTest
@testable import KipurseCore
/// Guard for handbook 0B (owner t1010..t1024): four steps in a welded order, wording rules.
final class UsageGuideT1010Tests: XCTestCase {
  func testFourStepsInLockedOrder() {
    XCTAssertEqual(UsageGuide.steps.map(\.n), [1, 2, 3, 4])
    XCTAssertTrue(UsageGuide.steps[0].zh.contains("实名")); XCTAssertTrue(UsageGuide.steps[1].zh.contains("充值"))
    XCTAssertTrue(UsageGuide.steps[2].zh.contains("钱包安全上限")); XCTAssertTrue(UsageGuide.steps[3].zh.contains("AI"))
    XCTAssertTrue(UsageGuide.steps[1].detailZh.contains("充值成功") || UsageGuide.steps[1].detailZh.contains("开户成功"))
  }
  func testCurrentStepStrictOrder() {
    XCTAssertEqual(UsageGuide.current(verified: false, balance: 100, limitsSet: true, agentsConnected: 3), 5, "open wallet with limits implies step 1 is done")
    XCTAssertEqual(UsageGuide.current(verified: false, balance: 0, limitsSet: false, agentsConnected: 0), 1)
    XCTAssertEqual(UsageGuide.current(verified: true, balance: 0, limitsSet: false, agentsConnected: 0), 2)
    // t1248: limits are set at opening, so a later 0 balance must not uncheck steps 2 and 3
    XCTAssertEqual(UsageGuide.current(verified: true, balance: 0, limitsSet: true, agentsConnected: 3), 5)
    XCTAssertEqual(UsageGuide.current(verified: true, balance: 5, limitsSet: false, agentsConnected: 3), 3)
    XCTAssertEqual(UsageGuide.current(verified: true, balance: 5, limitsSet: true, agentsConnected: 0), 4)
    XCTAssertEqual(UsageGuide.current(verified: true, balance: 5, limitsSet: true, agentsConnected: 1), 5)
  }
  func testCurrentDerivedFromWalletState() {
    func st(_ caps: Bool, balance: String, agents: [(String, Bool, Bool)] = [], deployed: Bool = false) -> WalletState {
      var o: [String: JSONValue] = ["mode": .string("MAIN"), "balance": .string(balance),
        "setup": .object(["active": .bool(true), "wallet": .string("0x1000000000000000000000000000000000000001")])]
      if deployed { o["walletDeployed"] = .bool(true) }
      if caps { o["caps"] = .object(["single": .string("10000000"), "daily": .string("50000000"), "term": .string("200000000"), "start": .string("1790000000")]) }
      o["agents"] = .array(agents.map { id, connected, revoked in
        .object(["id": .string(id), "connected": .bool(connected), "revoked": .bool(revoked)])
      })
      return WalletState(.object(o))
    }
    let shell = WalletState.shell(wallet: "0x1000000000000000000000000000000000000001")
    XCTAssertFalse(UsageGuide.walletOpen(shell)); XCTAssertFalse(UsageGuide.limitsSet(shell)); XCTAssertEqual(UsageGuide.agentsConnected(shell), 0)
    XCTAssertEqual(UsageGuide.current(state: shell, verified: true), 2, "login shell is not yet open")
    XCTAssertEqual(UsageGuide.current(state: nil, verified: false), 1)
    XCTAssertEqual(UsageGuide.current(state: nil, verified: true), 2)
    let opened = st(true, balance: "0", agents: [])   // opened with limits, later withdrew
    XCTAssertTrue(UsageGuide.walletOpen(opened)); XCTAssertTrue(UsageGuide.limitsSet(opened))
    XCTAssertEqual(UsageGuide.current(state: opened, verified: false), 4, "open+limits, no AI: step 4; step 1 implied by the open wallet")
    let done = st(true, balance: "14100000", agents: [("muse", true, false), ("claude", false, false)])
    XCTAssertEqual(UsageGuide.agentsConnected(done), 1)
    XCTAssertEqual(UsageGuide.current(state: done, verified: true), 5)
    let revokedOnly = st(true, balance: "1000", agents: [("muse", true, true)])
    XCTAssertEqual(UsageGuide.agentsConnected(revokedOnly), 0)
    XCTAssertEqual(UsageGuide.current(state: revokedOnly, verified: true), 4)
    let fundedNoCaps = st(false, balance: "5000000", agents: [("muse", true, false)])
    XCTAssertTrue(UsageGuide.walletOpen(fundedNoCaps)); XCTAssertFalse(UsageGuide.limitsSet(fundedNoCaps))
    XCTAssertEqual(UsageGuide.current(state: fundedNoCaps, verified: true), 3)
    let deployedEmpty = st(false, balance: "0", agents: [], deployed: true)
    XCTAssertTrue(UsageGuide.walletOpen(deployedEmpty))
    XCTAssertEqual(UsageGuide.current(state: deployedEmpty, verified: true), 3)
  }
  func testZeroBalanceRefusesAIAndNoFaceIDFirst() {
    XCTAssertFalse(UsageGuide.aiPaymentAllowed(balance: 0)); XCTAssertTrue(UsageGuide.aiPaymentAllowed(balance: 0.01))
    XCTAssertFalse(UsageGuide.offerFaceID(balance: 0)); XCTAssertTrue(UsageGuide.zeroBalanceRefusalZh.contains("没有付款"))
  }
  func testOpeningFeeExplainedT1018() {
    XCTAssertTrue(UsageGuide.steps[1].detailZh.contains("实际网络费")); XCTAssertTrue(UsageGuide.openingFeeNoticeZh.contains("请先充值")); XCTAssertFalse(UsageGuide.steps[1].detailZh.contains("0.05"))
  }
  func testNoBannedWordsNoETH() {
    let all = UsageGuide.steps.flatMap { [$0.zh, $0.en, $0.detailZh, $0.detailEn] } + [UsageGuide.zeroBalanceRefusalZh, UsageGuide.zeroBalanceRefusalEn, UsageGuide.openingFeeNoticeZh]
    for s in all { for w in ["免费", "垫付", "赞助", "真钱", "ETH"] { XCTAssertFalse(s.contains(w), "\(w) in \(s)") } }
  }
}
