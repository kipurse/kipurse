import XCTest
@testable import KipurseCore

/// t1245 (§6#115): one money display rule, the pending badge count and the AI-limit hint gate.
final class T1245UIAuditTests: XCTestCase {
  func testAmountsAlwaysTwoDecimals() {
    XCTAssertEqual(MoneyText.amount(18_500_000), "18.50")
    XCTAssertEqual(MoneyText.amount(0), "0.00")
    XCTAssertEqual(MoneyText.amount(14_304_957), "14.30")
    XCTAssertEqual(MoneyText.amount(30_030_000), "30.03")
    XCTAssertEqual(MoneyText.amount(9_995_000), "10.00")   // half up
    XCTAssertEqual(MoneyText.amount(10_000), "0.01")
    XCTAssertEqual(MoneyText.amount(4_999), "<0.01")       // tiny never reads as 0
    XCTAssertEqual(MoneyText.amount(1), "<0.01")
    XCTAssertEqual(MoneyText.amount(-3_200_000), "-3.20")
    XCTAssertEqual(MoneyText.usdc(18_500_000), "18.50 USDC")
    XCTAssertEqual(MoneyText.signed(12_300_000), "+12.30")
    XCTAssertEqual(MoneyText.signed(-30_000), "−0.03")
  }
  func testFeesUnderOneCentKeepSixDecimals() {
    XCTAssertEqual(MoneyText.fee(3_451), "0.003451")
    XCTAssertEqual(MoneyText.fee(3_000), "0.003")
    XCTAssertEqual(MoneyText.fee(100), "0.0001")
    XCTAssertEqual(MoneyText.fee(21_373), "0.02")       // >= 0.01 alone: 2 decimals
    XCTAssertEqual(MoneyText.fee(0), "0.00")
    XCTAssertEqual(MoneyText.feeUSDC(3_451), "0.003451 USDC")
  }
  func testFeesAreConsistentWithinAPage() {
    let page = MoneyText.FeeStyle.page([21_373, 3_451, 0])
    XCTAssertEqual(page, .micro)
    XCTAssertEqual(MoneyText.fee(21_373, style: page), "0.021373")
    XCTAssertEqual(MoneyText.fee(3_451, style: page), "0.003451")
    XCTAssertEqual(MoneyText.fee(20_000, style: page), "0.02")   // never fewer than 2 decimals
    let big = MoneyText.FeeStyle.page([21_373, 50_000])
    XCTAssertEqual(big, .cents)
    XCTAssertEqual(MoneyText.fee(21_373, style: big), "0.02")
    XCTAssertEqual(MoneyText.FeeStyle.page([]), .cents)
  }
  func testReceiptHeaderAndRowAgree() {
    // TxDetail: the header and the 金额 row use the same helper, so 18.5 never shows as both "18.50 USDC" and "$18.5".
    let a: Int64 = 18_500_000
    XCTAssertEqual("−" + MoneyText.usdc(a), "−18.50 USDC")
    XCTAssertEqual(MoneyText.usdc(a), "18.50 USDC")
  }
  func testPendingBadgeCountsEveryWaitingItem() {
    // main-hold demo: 1 new merchant + 1 allowance request + 1 hold = 3 (was 1).
    XCTAssertEqual(PendingBadge.count(approvals: 1, allowanceRequests: 1, connectRequests: 0, holds: 1, isMainnet: true, active: true), 3)
    // connect request only (main-connect): badge shows it (was none).
    XCTAssertEqual(PendingBadge.count(approvals: 0, allowanceRequests: 0, connectRequests: 1, holds: 0, isMainnet: true, active: false), 1)
    // allowance request only (main-new): badge shows it.
    XCTAssertEqual(PendingBadge.count(approvals: 0, allowanceRequests: 2, connectRequests: 0, holds: 0, isMainnet: true, active: true), 2)
    // the block hides allowance requests and holds on a wallet that is not active / not mainnet, so the badge does too.
    XCTAssertEqual(PendingBadge.count(approvals: 1, allowanceRequests: 2, connectRequests: 3, holds: 4, isMainnet: false, active: true), 1)
    XCTAssertEqual(PendingBadge.count(approvals: 0, allowanceRequests: 2, connectRequests: 1, holds: 4, isMainnet: true, active: false), 1)
    XCTAssertEqual(PendingBadge.count(approvals: 0, allowanceRequests: 0, connectRequests: 0, holds: 0, isMainnet: true, active: true), 0)
  }
  func testAILimitHintWaitsForInput() {
    XCTAssertFalse(AILimitGate.showsLine(single: "", daily: "", term: ""))
    XCTAssertFalse(AILimitGate.showsLine(single: " ", daily: "", term: ""))
    XCTAssertTrue(AILimitGate.showsLine(single: "2", daily: "", term: ""))
    XCTAssertTrue(AILimitGate.showsLine(single: "", daily: "", term: "", attempted: true))
  }
}

final class T1245LimitTermTests: XCTestCase {
  func testCurrentTermDays() {
    let a = Date(timeIntervalSince1970: 1_768_435_200)   // 2026-01-15
    XCTAssertEqual(LimitTerm.days(start: a, end: a.addingTimeInterval(365 * 86_400)), 365)
    XCTAssertEqual(LimitTerm.days(start: a, end: a.addingTimeInterval(90 * 86_400 + 3_600)), 90)
    XCTAssertNil(LimitTerm.days(start: a, end: a.addingTimeInterval(800 * 86_400)))
    XCTAssertNil(LimitTerm.days(start: nil, end: a))
    XCTAssertNil(LimitTerm.days(start: a, end: a))
  }
}

final class T1245WalletLimitRowTests: XCTestCase {
  func testExpiredLimitSaysSo() {
    Loc.override = "zh"; defer { Loc.override = nil }
    let past = Date(timeIntervalSince1970: 1_776_211_200)   // 2026-04-15
    let now = Date(timeIntervalSince1970: 1_795_000_000)     // 2026-11
    let st = WalletLimitsLine.State.ready(single: 1_000_000, daily: 5_000_000, term: 30_030_000, end: past)
    XCTAssertTrue(WalletLimitsLine.expired(st, now: now))
    XCTAssertEqual(WalletLimitsLine.rowText(st, now: now), "已过期，点这里续期")
    let live = WalletLimitsLine.State.ready(single: 1_000_000, daily: 5_000_000, term: 30_030_000, end: now.addingTimeInterval(86_400))
    XCTAssertFalse(WalletLimitsLine.expired(live, now: now))
    XCTAssertTrue(WalletLimitsLine.rowText(live, now: now, zone: TimeZone(identifier: "UTC")!).hasPrefix("每笔 1 · 每天 5 · 总额 30.03 USDC"))
    XCTAssertFalse(WalletLimitsLine.expired(.unset, now: now))
  }
}
