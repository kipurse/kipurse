import XCTest
@testable import KipurseCore
/// Guard for handbook 0B (owner t1010u..t1024u): four steps in a welded order, wording rules.
final class UsageGuideT1010Tests: XCTestCase {
  func testFourStepsInLockedOrder() {
    XCTAssertEqual(UsageGuide.steps.map(\.n), [1, 2, 3, 4])
    XCTAssertTrue(UsageGuide.steps[0].zh.contains("实名")); XCTAssertTrue(UsageGuide.steps[1].zh.contains("充值"))
    XCTAssertTrue(UsageGuide.steps[2].zh.contains("钱包安全上限")); XCTAssertTrue(UsageGuide.steps[3].zh.contains("AI"))
    XCTAssertTrue(UsageGuide.steps[1].detailZh.contains("充值成功") || UsageGuide.steps[1].detailZh.contains("开户成功"))
  }
  func testCurrentStepStrictOrder() {
    XCTAssertEqual(UsageGuide.current(verified: false, balance: 100, limitsSet: true, agentsConnected: 3), 1)
    XCTAssertEqual(UsageGuide.current(verified: true, balance: 0, limitsSet: true, agentsConnected: 3), 2)
    XCTAssertEqual(UsageGuide.current(verified: true, balance: 5, limitsSet: false, agentsConnected: 3), 3)
    XCTAssertEqual(UsageGuide.current(verified: true, balance: 5, limitsSet: true, agentsConnected: 0), 4)
    XCTAssertEqual(UsageGuide.current(verified: true, balance: 5, limitsSet: true, agentsConnected: 1), 5)
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
