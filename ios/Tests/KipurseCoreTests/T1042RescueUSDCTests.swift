import XCTest
@testable import KipurseCore

final class T1042RescueUSDCTests: XCTestCase {
  private var root: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }

  func testOfflineGuideHasNoETHAndKeepsDailyDistinction() throws {
    let source = try String(contentsOf: root.appendingPathComponent("App/Sources/OfflineRescue.swift"), encoding: .utf8)
    XCTAssertFalse(source.contains("ETH"))
    let old = Loc.override; defer { Loc.override = old }
    for lang in ["zh", "en"] {
      Loc.override = lang
      let copy = ([LostPhoneRecovery.intro, LostPhoneRecovery.feeNote] + LostPhoneRecovery.steps).joined(separator: "\n")
      XCTAssertFalse(copy.contains("ETH"))
      XCTAssertTrue(copy.contains(lang == "zh" ? "平时还能打开启付时" : "For everyday withdrawals"))
      XCTAssertTrue(copy.contains(lang == "zh" ? "不从启付余额扣" : "not from your Kipurse balance"))
      XCTAssertTrue(copy.contains(lang == "zh" ? "转一点 USDC" : "transfer a little USDC"))
    }
  }

  func testPreviewAndInsufficientGasAreUSDCOnlyInBothLanguages() throws {
    let old = Loc.override; defer { Loc.override = old }
    let owner = "0x2222222222222222222222222222222222222222"
    let p = try ChainRescue.plan(wallet: "0x1111111111111111111111111111111111111111", owner: owner, recordedOwner: owner, b: .init(wallet: 1_000_000, vault: 0))
    let gas = GasCheck.estimate(kind: .other, gasPriceWei: 6_000_000, ethUSD: 4000, balanceUSDC: 0)
    XCTAssertFalse(gas.enough)
    for lang in ["zh", "en"] {
      Loc.override = lang
      let preview = ChainRescue.preview(p).joined(separator: "\n")
      let missing = ChainRescue.gasMissingText(gas)
      for text in [preview, missing] { XCTAssertTrue(text.contains("USDC")); XCTAssertFalse(text.contains("ETH")) }
      XCTAssertTrue(preview.contains("0.01"))
      XCTAssertTrue(missing.contains(GasCheck.dollars(gas.missingUSDC)))
      XCTAssertTrue(missing.contains(lang == "zh" ? "已停止，没有扣钱" : "Stopped; nothing was charged"))
    }
  }

  func testUSDCPreflightBlocksBeforeOpeningSigningPage() throws {
    let s = try String(contentsOf: root.appendingPathComponent("App/Sources/OfflineRescue.swift"), encoding: .utf8)
    let begin = try XCTUnwrap(s.range(of: "private func confirm("))
    let confirm = String(s[begin.lowerBound...])
    let check = try XCTUnwrap(confirm.range(of: "guard gas.enough else"))
    let open = try XCTUnwrap(confirm.range(of: "RescuePages.firstGood"))
    XCTAssertLessThan(check.lowerBound, open.lowerBound)
    XCTAssertTrue(confirm.contains("GasCheck.fetch(kind: .other, account: owner)"))
    XCTAssertTrue(confirm.contains("ChainRescue.gasMissingText(gas); return"))
    XCTAssertTrue(confirm.contains("We cannot check your Coinbase wallet's USDC balance or the fee right now, so we stopped"))
  }

  func testRecoveryGuideLocalizationsAreUSDCOnlyExceptAdvancedExplorer() {
    for (key, value) in Loc.en where key.hasPrefix("需要：你的 Coinbase 钱包") || key.hasPrefix("不需要我们的服务器。") {
      XCTAssertTrue(key.contains("USDC")); XCTAssertTrue(value.contains("USDC"))
      XCTAssertFalse(key.contains("ETH")); XCTAssertFalse(value.contains("ETH"))
    }
  }
}
