import XCTest
@testable import KipurseCore
final class OpeningFeeT852Tests: XCTestCase {
  func testFixedOpeningFeeCopy() {
    XCTAssertTrue(Beginner.openingFeeZh.contains("从启付钱包余额扣")); for w in ["垫付", "赞助", "免费"] { XCTAssertFalse(Beginner.openingFeeZh.contains(w), w) }   // t922 owner rule
    for s in [Beginner.openingFeeZh, Beginner.openingFeeEn] { XCTAssertFalse(s.contains("每笔最多")); XCTAssertFalse(s.contains("ETH")); XCTAssertFalse(s.contains("until repaid")) }
  }
}
