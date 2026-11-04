import XCTest
@testable import KipurseCore

final class OnboardTests: XCTestCase {
  func j(_ s: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }
  func testQuoteParsesForkResponse() {
    let q = Onboard.Quote(j(#"{"gas":"2300000","gasPriceWei":"6000000","feeWei":"13801000000000","feeUSDC":"0.033176","payer":"0x2222000000000000000000000000000000002222","payerEthWei":"0","payerUSDC":"5000000","payerCanPayEth":false,"payerCanPayUSDC":true,"sponsoredByKipurse":false,"signatures":1,"transactions":1}"#))
    XCTAssertEqual(q?.feeUSDC, "0.033176"); XCTAssertEqual(q?.gas, 2_300_000); XCTAssertEqual(q?.acceptable, true); XCTAssertEqual(q?.canPay, true)
  }
  func testRejectsSponsoredOrMultiSignature() {
    XCTAssertEqual(Onboard.Quote(j(#"{"gas":"1","feeUSDC":"0.01","payer":"0x1","sponsoredByKipurse":true,"signatures":1}"#))?.acceptable, false)
    XCTAssertEqual(Onboard.Quote(j(#"{"gas":"1","feeUSDC":"0.01","payer":"0x1","sponsoredByKipurse":false,"signatures":2}"#))?.acceptable, false)
    // sponsored first onboarding: accepted, no funds needed; "sponsored" without one signature is still refused
    let sp = Onboard.Quote(j(#"{"gas":"1","feeUSDC":"0.03","payer":"","payerCanPayEth":false,"payerCanPayUSDC":false,"sponsoredByKipurse":true,"sponsored":true,"signatures":1}"#))
    XCTAssertEqual(sp?.acceptable, true); XCTAssertEqual(sp?.canPay, true); XCTAssertEqual(sp?.sponsored, true)
    XCTAssertEqual(Onboard.Quote(j(#"{"gas":"1","feeUSDC":"0.03","payer":"","sponsoredByKipurse":true,"sponsored":true,"signatures":2}"#))?.acceptable, false)
    XCTAssertNil(Onboard.Quote(j(#"{"feeUSDC":"0.01"}"#)))
  }
  func testCannotPayWhenNoUSDCAndNoETH() {
    XCTAssertEqual(Onboard.Quote(j(#"{"gas":"1","feeUSDC":"0.03","payer":"0x1","payerCanPayEth":false,"payerCanPayUSDC":false,"sponsoredByKipurse":false,"signatures":1}"#))?.canPay, false)
  }
  func testStartBodyAndSteps() {
    let b = Onboard.startBody(x: [UInt8](repeating: 1, count: 32), y: [UInt8](repeating: 2, count: 32), single: "2", daily: "5", term: "50", days: "90")
    XCTAssertEqual(b["single"], "2"); XCTAssertEqual(b["term"], "50"); XCTAssertEqual(b["x"]?.count, 66)
    XCTAssertEqual(Onboard.steps(removes: 2, siri: true).count, 3); XCTAssertEqual(Onboard.steps(removes: 0, siri: false).count, 2)
    XCTAssertFalse(Onboard.enabled, "off unless the operator sets KipurseOnboard = YES")
  }
  /// Sponsored setup copy must say Kipurse pays and the user pays $0, in both languages (owner saw "you pay" on a sponsored setup).
  func testSponsoredFeeCopyTranslated() {
    for zh in ["这一笔手续费由 Kipurse 代付，你付 $0。只需要签一次名（Face ID）。", "你付 $0",
               "账户已删除，钱没有被删除：USDC 一直在链上你自己的智能钱包里，只有你自己的 Coinbase 账户能控制。",
               "你没有在链上撤销授权。删除后我们的执行密钥会被销毁，没人能再用它付款；授权会在到期日自动失效。想更彻底，之后按「离线提现指南」撤销授权（要付一点手续费）。"] {
      XCTAssertNotEqual(Loc.english(zh), zh, zh)
    }
    XCTAssertTrue(Loc.english("这一笔手续费由 Kipurse 代付，你付 $0。只需要签一次名（Face ID）。").contains("Kipurse pays"))
  }
  /// One-page setup: the sign-in status carries the wallet opened on the same page -> straight into the app; anything else -> old path.
  func testOpenedOnSignIn() {
    let o = "0x1000000000000000000000000000000000000003", w = "0x000000000000000000000000000000000000dEaD"
    let done = CoinbaseIdentity.Result(j(#"{"state":"done","result":"new","owner":"\#(o)","wallet":null,"setup":{"state":"done","wallet":"\#(w)"}}"#))!
    XCTAssertEqual(CoinbaseIdentity.openedOnSignIn(done), w)
    let pending = CoinbaseIdentity.Result(j(#"{"state":"done","result":"new","owner":"\#(o)","wallet":null,"setup":{"state":"prepared","wallet":null}}"#))!
    XCTAssertNil(CoinbaseIdentity.openedOnSignIn(pending)); XCTAssertEqual(pending.setupState, "prepared")
    let none = CoinbaseIdentity.Result(j(#"{"state":"done","result":"new","owner":"\#(o)","wallet":null}"#))!
    XCTAssertNil(CoinbaseIdentity.openedOnSignIn(none)); XCTAssertNil(none.setupState)
    let bad = CoinbaseIdentity.Result(j(#"{"state":"done","result":"new","owner":"\#(o)","wallet":null,"setup":{"state":"done","wallet":"nope"}}"#))!
    XCTAssertNil(CoinbaseIdentity.openedOnSignIn(bad))
    XCTAssertNil(CoinbaseIdentity.presetSetup)   // t603u: no default limit authorization
  }
}
