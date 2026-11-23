import XCTest
@testable import KipurseCore

final class T1044LostPhoneRecoveryTests: XCTestCase {
  private var root: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }
  private func guide(_ link: String? = nil) throws -> RecoveryGuide {
    var r: [String: JSONValue] = ["wallet": .string("0x1111111111111111111111111111111111111111"), "owner": .string("0x2222222222222222222222222222222222222222"), "chainId": .number(8453)]
    if let link { r["rescueUrl"] = .string(link) }
    return try XCTUnwrap(RecoveryGuide(recovery: .object(r)))
  }
  func testPrimaryStepsUseAnotherDeviceAndSameCoinbaseWalletWithoutAppControls() {
    let old = Loc.override; defer { Loc.override = old }
    for lang in ["zh", "en"] {
      Loc.override = lang
      XCTAssertEqual(LostPhoneRecovery.steps.count, 5)
      XCTAssertTrue(LostPhoneRecovery.steps[0].contains(lang == "zh" ? "另一部手机" : "another phone"))
      XCTAssertTrue(LostPhoneRecovery.steps[1].contains(lang == "zh" ? "同一个 Coinbase 钱包" : "same Coinbase wallet"))
      XCTAssertTrue(LostPhoneRecovery.steps[2].contains(lang == "zh" ? "不从启付余额扣" : "not your Kipurse balance"))
      XCTAssertTrue(LostPhoneRecovery.steps[4].contains(lang == "zh" ? "钱只能回到你本人" : "only go back to you"))
      let s = LostPhoneRecovery.steps.joined()
      for banned in ["Face ID", "检查并准备", "Check and prepare", "ETH", "paymaster", "Base Account"] { XCTAssertFalse(s.contains(banned), banned) }
    }
  }
  func testPublicHomepageAutomaticallyFindsWalletWithoutSavedLinks() {
    let old = Loc.override; defer { Loc.override = old }
    for lang in ["zh", "en"] {
      Loc.override = lang
      XCTAssertTrue(LostPhoneRecovery.steps[3].contains("https://kipurse.github.io/rescue/"))
      XCTAssertTrue(LostPhoneRecovery.steps[3].contains(lang == "zh" ? "自动找到" : "automatically finds"))
      XCTAssertTrue(LostPhoneRecovery.publicPageNote.contains(lang == "zh" ? "不用截图" : "do not need"))
    }
  }
  func testLocalAppControlsAreCollapsedBackupAndSettingsHasOneGuide() throws {
    let s = try String(contentsOf: root.appendingPathComponent("App/Sources/OfflineRescue.swift"), encoding: .utf8)
    XCTAssertTrue(s.contains("@State private var showAppFallback = false"))
    let fold = try XCTUnwrap(s.range(of: "DisclosureGroup(LostPhoneRecovery.appFallbackTitle"))
    let balance = try XCTUnwrap(s.range(of: "if FeatureSwitch.chainRead.on { ChainBalanceRow()"))
    let controls = try XCTUnwrap(s.range(of: "if FeatureSwitch.chainRescue.on {", range: fold.lowerBound..<s.endIndex))
    XCTAssertLessThan(fold.lowerBound, balance.lowerBound)
    XCTAssertLessThan(fold.lowerBound, controls.lowerBound)
    let settings = try String(contentsOf: root.appendingPathComponent("App/Sources/Screens.swift"), encoding: .utf8)
    XCTAssertTrue(settings.contains("settings.lostPhone")); XCTAssertFalse(settings.contains("settings.rescueGuide"))
    XCTAssertFalse(settings.contains("LostPhoneRecovery.subtitle"))   // t1057u: no grey subtitle under the Settings row
    XCTAssertFalse(settings.contains("settings.copyWallet"))   // t1058u
    let card = try String(contentsOf: root.appendingPathComponent("App/Sources/LifeTab.swift"), encoding: .utf8)
    XCTAssertTrue(card.contains("wallet.copyWallet")); XCTAssertFalse(settings.contains("wallet.copyWallet"))   // t1133u: copy lives only in the top card
    XCTAssertFalse(settings.contains("T(\"我的钱包地址\""))   // t1133u: standalone row removed
    XCTAssertFalse(card.contains("shortAddr4"))   // t1133u: card shows the full address
  }
  func testDeletionPDFUsesSameInstructionsPreservesFullLinkAndEnglishHasNoChinese() throws {
    let old = Loc.override; defer { Loc.override = old }
    let link = "https://example.org/rescue/#to=0x111&data=0x1234&owner=0x222"
    for lang in ["zh", "en"] {
      Loc.override = lang
      let g = try guide(link)
      XCTAssertTrue(g.simpleMethods[0].works)
      XCTAssertEqual(Array(g.simpleMethods[0].steps.prefix(5)), LostPhoneRecovery.steps)
      XCTAssertTrue(g.text.hasPrefix(LostPhoneRecovery.title))
      XCTAssertTrue(g.text.contains(link))
      XCTAssertFalse(g.text.contains(lang == "zh" ? "也可以填你 Coinbase 的 USDC 地址" : "you can also enter your Coinbase"))
      if lang == "en" { XCTAssertNil(g.text.range(of: "[\u{4e00}-\u{9fff}]", options: .regularExpression)) }
    }
  }
  func testNoSavedLinkStillHasWorkingPublicRecovery() throws {
    let old = Loc.override; defer { Loc.override = old }; Loc.override = "zh"
    let g = try guide()
    XCTAssertTrue(g.simpleMethods[0].works)
    XCTAssertTrue(g.simpleMethods[0].steps.contains(LostPhoneRecovery.publicPageNote))
    XCTAssertTrue(g.text.contains(LostPhoneRecovery.publicPageNote))
  }
}
