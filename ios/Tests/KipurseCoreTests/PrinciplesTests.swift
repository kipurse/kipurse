import XCTest
@testable import KipurseCore
/// Fails if any owner principle changes (needs an owner decision in OWNER_HANDBOOK.md).
final class PrinciplesTests: XCTestCase {
  func testConstants() {
    XCTAssertEqual(Principles.payerFeeBps, 10); XCTAssertEqual(Principles.payerFeeCapBps, 30); XCTAssertEqual(Principles.gasMarginBps, 0)
    XCTAssertEqual(Principles.phoneUpgradeMarginPct, 0); XCTAssertEqual(Principles.phoneUpgradeMinUSDC, 0); XCTAssertEqual(Principles.holdAboveUSDC, 500)
    XCTAssertTrue(Principles.arrivedRequiresOnchainTx); XCTAssertTrue(Principles.onrampDestinationIsUserWallet)
  }
  /// t604u: USDC-only gas, locked. t603u: no preset limits, first authorization free.
  func testUSDCOnlyGas() throws {
    XCTAssertEqual(Principles.gasToken, "USDC"); XCTAssertFalse(Principles.ethGasPath); XCTAssertFalse(Principles.presetLimits); XCTAssertFalse(Principles.firstLimitsFree)
    XCTAssertTrue(Principles.kycAttestationRequired); XCTAssertFalse(Principles.depositHistoryCountsAsKyc); XCTAssertEqual(Principles.kipurseNetCostUSDC, 0); XCTAssertTrue(Principles.failedGasPaidByUser); XCTAssertTrue(Principles.onboardingGasRecouped); XCTAssertTrue(Principles.assertLocked())
    XCTAssertNil(CoinbaseIdentity.presetSetup, "no default limit authorization")
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    var all = ""
    for dir in ["App/Sources", "Sources/KipurseCore"] {
      let e = FileManager.default.enumerator(at: root.appendingPathComponent(dir), includingPropertiesForKeys: nil)
      while let u = e?.nextObject() as? URL { if u.pathExtension == "swift", u.lastPathComponent != "Principles.swift" { all += (try? String(contentsOf: u, encoding: .utf8)) ?? "" } }
    }
    for bad in Principles.forbiddenEthAsks { XCTAssertFalse(all.contains(bad), bad) }
    XCTAssertTrue(all.contains("永远不用 ETH")); XCTAssertTrue(all.contains("owner/limits/fee"))
  }
  func testArrivedNeedsTx() {
    if case .arrived = OnrampState.parse(200, ["ok": true, "state": "awaiting_payment"], secondsSinceReturn: 999) { XCTFail("arrived without tx") }
  }
  func testTextsSayActualCost() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    var all = ""
    for dir in ["App/Sources", "Sources/KipurseCore"] {
      let e = FileManager.default.enumerator(at: root.appendingPathComponent(dir), includingPropertiesForKeys: nil)
      while let u = e?.nextObject() as? URL { if u.pathExtension == "swift" { all += (try? String(contentsOf: u, encoding: .utf8)) ?? "" } }
    }
    XCTAssertFalse(all.isEmpty)
    for bad in ["直接进入 Kipurse", "直接进入你的 Kipurse", "加价 20%", "+20%", "最低 0.005", "estimate + margin", "给 AI 设零花钱", "零花钱额度", "· 每月 \\("] { XCTAssertFalse(all.contains(bad), bad) }
    XCTAssertTrue(all.contains("按实际花费"))
  }
}

final class EverydayLimitsTests: XCTestCase {
  func testFreeUnderFloorChargedAbove() {
    XCTAssertEqual(EverydayLimits.cost(single: 1, daily: 5, floorSingle: 10, floorDaily: 50), .free)
    XCTAssertEqual(EverydayLimits.cost(single: 10, daily: 50, floorSingle: 10, floorDaily: 50), .free)
    XCTAssertEqual(EverydayLimits.cost(single: 11, daily: 5, floorSingle: 10, floorDaily: 50), .floorChange(firstFree: false))
  }
  func testNeverAboveFloor() {
    XCTAssertTrue(Principles.everydayBelowFloor)
    let (a, b) = EverydayLimits.clamp(single: 99, daily: 99, floorSingle: 3, floorDaily: 7); XCTAssertEqual(a, 3); XCTAssertEqual(b, 7)
    for t in [EverydayLimits.whyZh, EverydayLimits.whyEn, EverydayLimits.paidZh, EverydayLimits.freeZh] { for f in Principles.forbiddenEthAsks { XCTAssertFalse(t.contains(f)) } }
    XCTAssertTrue(EverydayLimits.whyZh.contains("区块链上"))
  }
  func testFeeRefundCallAccepted() {
    let w = "0x1111111111111111111111111111111111111111", o = "0x2222222222222222222222222222222222222222"
    let usdc = "833589fcd6edb6e08f4c7c32d4f71b54bda02913"
    func pad(_ h: String) -> String { String(repeating: "0", count: 64 - h.count) + h }
    let inner = "a9059cbb" + pad(String(o.dropFirst(2))) + pad(String(7258, radix: 16))
    let data = "0xb61d27f6" + pad(usdc) + pad("0") + pad("60") + pad(String(inner.count / 2, radix: 16)) + inner + String(repeating: "0", count: 56)
    XCTAssertNil(RequestVerify.feeRefundProblem(["to": w, "data": data], wallet: w, owner: o))
    XCTAssertNotNil(RequestVerify.feeRefundProblem(["to": w, "data": data], wallet: w, owner: "0x3333333333333333333333333333333333333333"))
  }

  func testT787IronRulesLocked() {
    XCTAssertTrue(Principles.noPooledCustody); XCTAssertTrue(Principles.ownerSignsEveryOutflow); XCTAssertTrue(Principles.withdrawOnlyToVerifiedOwner)
    XCTAssertTrue(Principles.signPagePinRequired); XCTAssertTrue(Principles.externalAuditBeforeRealUsers)
    XCTAssertEqual(Principles.sponsorMaxPerDay, 20); XCTAssertEqual(Principles.sponsorMaxUSDPerDay, 2.0); XCTAssertEqual(Principles.sponsorMaxUSDPerOp, 0.25)
    XCTAssertEqual(SignHost.indexSHA256.count, 64); XCTAssertNotEqual(SignHost.host, SignHost.apiHost)
    XCTAssertTrue(Principles.assertLocked())
  }
}
