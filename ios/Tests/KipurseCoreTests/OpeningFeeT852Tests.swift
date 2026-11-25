import XCTest
@testable import KipurseCore
final class OpeningFeeT852Tests: XCTestCase {
  func testFixedOpeningFeeCopy() {
    XCTAssertTrue(Beginner.openingFeeZh.contains("Coinbase 钱包（Base 账户）")); XCTAssertTrue(Beginner.openingFeeZh.contains("不从这次充值里扣")); XCTAssertFalse(Beginner.openingFeeZh.contains("0.03"))   // t1125: opening fee comes from Coinbase, not the Kipurse wallet
     for w in ["垫付", "赞助", "免费"] { XCTAssertFalse(Beginner.openingFeeZh.contains(w), w) }   // t922 owner rule
    for s in [Beginner.openingFeeZh, Beginner.openingFeeEn] { XCTAssertFalse(s.contains("每笔最多")); XCTAssertFalse(s.contains("ETH")); XCTAssertFalse(s.contains("until repaid")) }
  }
}
