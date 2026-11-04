import XCTest
@testable import KipurseCore

final class BeginnerTests: XCTestCase {
  func testNoPresetSelected() { XCTAssertNil(Beginner.initialSelection) }
  func testThreePlansOrderedAndConsistent() {
    for u in Beginner.Use.allCases { for v in Beginner.Spend.allCases {
      let p = Beginner.plans(use: u, spend: v); XCTAssertEqual(p.map(\.key), ["cautious", "normal", "roomy"])
      for x in p { XCTAssertLessThanOrEqual(x.single, x.daily); XCTAssertLessThanOrEqual(x.daily, x.term); XCTAssertGreaterThan(x.single, 0) }
      XCTAssertLessThan(p[0].daily, p[2].daily) } }
  }
  func testLabelsNeverMonthly() {
    let all = Beginner.useZh + Beginner.spendZh + Beginner.plans(use: .shopping, spend: .mid).map(\.zh)
    for t in all { XCTAssertFalse(t.contains("每月"), t) }
  }
  func testCurrencyAndCoinbaseWording() {
    XCTAssertEqual(Beginner.currencyZh, "USDC（美元稳定币）"); XCTAssertEqual(Beginner.currencyEn, "USDC (US dollar stablecoin)")
    XCTAssertTrue(Beginner.coinbaseWhyZh.contains("用 Coinbase 做身份认证，保护你的钱"))
    XCTAssertTrue(Beginner.coinbaseWhyZh.contains("必须")); XCTAssertTrue(Beginner.coinbaseWhyZh.contains("不收集你的证件"))
    XCTAssertTrue(Beginner.noAccountStepsZh.joined().contains("必须"))
    XCTAssertEqual(Beginner.signUpURL.host, "www.coinbase.com")
  }
  func testNoEthWordingInLocalization() {
    for (k, v) in Loc.en { XCTAssertFalse(k.contains("USDC 或 ETH") || v.contains("USDC or ETH"), k)
      for f in Principles.forbiddenEthAsks { XCTAssertFalse(k.contains(f), k) } }
  }
  func testPlainWordsInLocalization() {
    for k in Loc.en.keys { XCTAssertFalse(k.contains("签名"), k); XCTAssertFalse(k.contains("网络费"), k) }
  }
}

final class AddressDisplayTests: XCTestCase {
  let a = "0x1111aB12cD34eF5600112233445566778899" + "bEEF"
  func testOwnShortByDefault() { XCTAssertEqual(AddressDisplay.own(a), "0x1111…bEEF"); XCTAssertFalse(AddressDisplay.own(a).contains("aB12")) }
  func testOwnFullOnlyWhenRevealed() { XCTAssertTrue(AddressDisplay.own(a, revealed: true).replacingOccurrences(of: " ", with: "") == a) }
  func testPayeeAlwaysFull() { XCTAssertEqual(AddressDisplay.payee(a).replacingOccurrences(of: " ", with: ""), a); XCTAssertFalse(AddressDisplay.payee(a).contains("…")) }
}

final class SafetyTipsTests: XCTestCase {
  func testNineTipsBothLanguagesCalm() {
    XCTAssertEqual(SafetyTips.zh.count, 11); XCTAssertEqual(SafetyTips.en.count, 11); XCTAssertTrue(SafetyTips.zh[9].contains("keys.coinbase.com")); XCTAssertTrue(SafetyTips.en[10].contains("Coinbase")); XCTAssertFalse((SafetyTips.zh + SafetyTips.en).joined().contains("Apple Pay"))   // t927: deposit only from Coinbase
    for t in SafetyTips.zh + SafetyTips.en { for f in Principles.forbiddenEthAsks { XCTAssertFalse(t.contains(f), t) } }
    XCTAssertTrue(SafetyTips.zh[2].contains("恢复短语")); XCTAssertTrue(SafetyTips.zh[7].contains("USDC（美元稳定币）"))
    XCTAssertFalse(SafetyTips.zh[0].contains("Face ID"), "AI may pay within limits without Face ID: don't claim otherwise")
  }
}
