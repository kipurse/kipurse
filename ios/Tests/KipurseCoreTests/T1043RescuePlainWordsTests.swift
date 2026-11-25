import XCTest
@testable import KipurseCore

final class T1043RescuePlainWordsTests: XCTestCase {
  private var root: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }

  func testGuideExplainsTwoBalancesAndSpareUSDCWithoutJargon() throws {
    let old = Loc.override; defer { Loc.override = old }
    for lang in ["zh", "en"] {
      Loc.override = lang
      let s = ([LostPhoneRecovery.intro, LostPhoneRecovery.feeNote] + LostPhoneRecovery.steps).joined(separator: "\n")
      for phrase in lang == "zh" ? ["大约 1 美元就够", "不到 0.01 美元", "不从启付余额扣", "不是要花掉整整 1 美元", "网络选 Base"] : ["about $1 is enough", "under $0.01", "not from your Kipurse balance", "do not spend the whole $1", "Base network"] { XCTAssertTrue(s.contains(phrase), phrase) }
      for jargon in ["链上", "区块链", "on-chain", "blockchain", "Base Account", "paymaster", "ETH"] { XCTAssertFalse(s.contains(jargon), jargon) }
    }
  }

  func testPreviewAndMissingMoneyExplainWhichWalletPaysInBothLanguages() throws {
    let saved = Loc.override; defer { Loc.override = saved }
    let owner = "0x2222222222222222222222222222222222222222"
    let p = try ChainRescue.plan(wallet: "0x1111111111111111111111111111111111111111", owner: owner, recordedOwner: owner, b: .init(wallet: 1_000_000, vault: 0))
    let estimate = GasCheck.estimate(kind: .other, gasPriceWei: 6_000_000, ethUSD: 4000, balanceUSDC: 0)
    for lang in ["zh", "en"] {
      Loc.override = lang
      let preview = ChainRescue.preview(p).joined(separator: "\n")
      let missing = ChainRescue.gasMissingText(estimate)
      XCTAssertTrue(preview.contains(lang == "zh" ? "从你的 Coinbase 钱包扣，不从启付余额扣" : "from your Coinbase wallet, not from your Kipurse balance"))
      XCTAssertTrue(missing.contains(lang == "zh" ? "启付余额不能替它付" : "Your Kipurse balance cannot pay it"))
      XCTAssertTrue(missing.contains(lang == "zh" ? "大约 1 美元就够" : "about $1 is enough"))
      XCTAssertTrue(missing.contains(GasCheck.dollars(estimate.missingUSDC)))
      for jargon in ["ETH", "Base Account", "paymaster", "链上"] { XCTAssertFalse((preview + missing).contains(jargon)) }
    }
  }

  func testSettingsMentionsSpareUSDC() throws {
    // t1057: Settings row no longer shows LostPhoneRecovery.subtitle; spare-USDC wording stays on the property / guide page.
    let s = try String(contentsOf: root.appendingPathComponent("App/Sources/Screens.swift"), encoding: .utf8)
    XCTAssertFalse(s.contains("LostPhoneRecovery.subtitle"))
    XCTAssertTrue(s.contains("settings.lostPhone"))
    let old = Loc.override; defer { Loc.override = old }; Loc.override = "zh"
    XCTAssertTrue(LostPhoneRecovery.subtitle.contains("Coinbase 钱包需留一点 USDC")); Loc.override = "en"
    XCTAssertTrue(LostPhoneRecovery.subtitle.contains("keep a little USDC in your Coinbase wallet"))
  }
}
