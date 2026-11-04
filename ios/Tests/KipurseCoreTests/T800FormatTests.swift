import XCTest
@testable import KipurseCore

final class T800FormatTests: XCTestCase {
  func testPlainLimits() {
    XCTAssertEqual(AnswerRules.plain(10_050_000), "10"); XCTAssertEqual(AnswerRules.plain(12_012_000), "12"); XCTAssertEqual(AnswerRules.plain(30_030_000), "30")
    XCTAssertEqual(AnswerRules.plain(1_000_000), "1"); XCTAssertEqual(AnswerRules.plain(250_000), "0.25")
  }
  func testShortActivity() {
    XCTAssertEqual(AnswerRules.short(14_103_220), "14.10"); XCTAssertEqual(AnswerRules.short(26_730), "0.03"); XCTAssertEqual(AnswerRules.short(10_000_000), "10")
    XCTAssertEqual(AnswerRules.short(1_200), "<0.01"); XCTAssertEqual(AnswerRules.short(14_129_950), "14.13"); XCTAssertEqual(AnswerRules.short(0), "0")
  }
}
