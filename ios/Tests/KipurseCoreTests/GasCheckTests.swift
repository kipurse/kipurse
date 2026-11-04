import XCTest
@testable import KipurseCore

final class GasCheckTests: XCTestCase {
  func testEstimateAndShortfall() {
    let e = GasCheck.estimate(kind: .phoneUpgrade, gasPriceWei: 6_000_000, balanceWei: 1e12, ethUSD: 4000)
    XCTAssertEqual(e.feeWei, 1_300_000 * 6_000_000 + 500_000_000_000)
    XCTAssertEqual(e.requiredWei, e.feeWei * 1.5)
    XCTAssertFalse(e.enough); XCTAssertEqual(e.missingWei, e.requiredWei - 1e12)
    XCTAssertTrue(GasCheck.estimate(kind: .phoneUpgrade, gasPriceWei: 6_000_000, ethUSD: nil, balanceUSDC: 1).enough); XCTAssertFalse(GasCheck.estimate(kind: .phoneUpgrade, gasPriceWei: 6_000_000, balanceWei: 1e18, ethUSD: 4000, balanceUSDC: 0).enough, "ETH never counts")
    XCTAssertTrue(GasCheck.missingText(e).contains("USDC")); XCTAssertTrue(GasCheck.missingText(e).contains("不需要 ETH"))
  }
  func testKindFromURL() {
    XCTAssertEqual(GasCheck.Kind.from(url: URL(string: "https://x/fork/phone/enroll?t=1")!), .phoneUpgrade)
    XCTAssertEqual(GasCheck.Kind.from(url: URL(string: "https://x/phone/revoke")!), .phoneRevoke)
    XCTAssertEqual(GasCheck.Kind.from(url: URL(string: "https://x/owner/limits?a=1")!), .limits)
  }
  func testFormattingAndHex() {
    XCTAssertEqual(GasCheck.eth(577e12), "0.000577 ETH"); XCTAssertEqual(GasCheck.hexWei("0x10"), 16); XCTAssertNil(GasCheck.hexWei("0xzz"))
    XCTAssertEqual(GasCheck.estimate(kind: .limits, gasPriceWei: 1e9, balanceWei: 0, ethUSD: 4000).usd(1e18), "$4000.0000")
  }
  func testOffWithoutRPCAndNoticeSaysUserPays() {
    let saved = Operator.info; defer { Operator.info = saved }
    Operator.info = [:]; XCTAssertFalse(GasCheck.enabled)
    Operator.info = ["KipurseChainRPC": "$(KIPURSE_CHAIN_RPC)"]; XCTAssertFalse(GasCheck.enabled)
    Operator.info = ["KipurseChainRPC": "https://rpc.example"]; XCTAssertTrue(GasCheck.enabled)
    XCTAssertTrue(GasCheck.notice.contains("Kipurse"))
  }
  func testUpgradeQuoteFromKipurseUSDC() {
    let q = GasCheck.UpgradeQuote(json: ["fee": "42600", "walletUSDC": "9040387", "ownerEthWei": "0", "ownerGasWei": "11800000000000"])!
    XCTAssertTrue(q.enough); XCTAssertFalse(q.ownerCanPayEth); XCTAssertEqual(GasCheck.usdc(q.fee), "0.0426 USDC")
    XCTAssertNil(GasCheck.UpgradeQuote(json: ["fee": "50001", "walletUSDC": "1", "ownerEthWei": "0", "ownerGasWei": "0"]), "above the 0.05 cap is refused")
    let low = GasCheck.UpgradeQuote(fee: 50_000, walletUSDC: 10_000, ownerEthWei: 1e15, ownerGasWei: 1e13)
    XCTAssertFalse(low.enough); XCTAssertTrue(low.ownerCanPayEth); XCTAssertTrue(GasCheck.upgradeMissingText(low).contains("0.04 USDC"))
    XCTAssertTrue(GasCheck.isV2(["version": "v2"])); XCTAssertTrue(GasCheck.isV2(["version": "v3"]))
    XCTAssertTrue(GasCheck.upgradeToV3(["version": "v2", "upgradeTo": "v3"])); XCTAssertFalse(GasCheck.upgradeToV3(["version": "v2"])); XCTAssertFalse(GasCheck.upgradeToV3(["version": "v3", "upgradeTo": "v3"])); XCTAssertFalse(GasCheck.isV2(["version": "v1"])); XCTAssertFalse(GasCheck.isV2(nil))
  }
}
