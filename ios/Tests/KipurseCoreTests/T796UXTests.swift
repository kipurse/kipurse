import XCTest
@testable import KipurseCore
final class T796UXTests: XCTestCase {
  func testPlainAmounts() { XCTAssertEqual(Beginner.plainAmount(10.05), "10"); XCTAssertEqual(Beginner.plainAmount(12.01), "12"); XCTAssertEqual(Beginner.plainAmount(30), "30"); XCTAssertEqual(Beginner.plainAmount(0.5), "0.50") }
  func testPlural() { XCTAssertEqual(Beginner.plural(1, "payment", "payments"), "1 payment"); XCTAssertEqual(Beginner.plural(3, "payment", "payments"), "3 payments") }
  func testFreeAccountUpfront() { XCTAssertTrue(Beginner.coinbaseWhyEn.hasPrefix("You need a Coinbase account (no cost to open, about 5 minutes).")); XCTAssertTrue(Beginner.coinbaseWhyZh.hasPrefix("需要一个 Coinbase 账户（开户不收费，约 5 分钟）")); XCTAssertEqual(Beginner.progress(1, zh: false), "Step 1 of 3") }
}
