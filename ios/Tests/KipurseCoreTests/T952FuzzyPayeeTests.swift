import XCTest
@testable import KipurseCore

/// t952 A3: nickname / fuzzy payee matching for voice input. Still only saved payees; addresses only match saved ones.
final class T952FuzzyPayeeTests: XCTestCase {
  let a1 = "0x" + String(repeating: "1", count: 36) + "aaaa", a2 = "0x" + String(repeating: "2", count: 36) + "bbbb"
  var list: [AssistantData.Payee] { [.init(id: "p_1", address: a1, label: "小王", last4: "aaaa", isOwner: false), .init(id: "p_2", address: a2, label: "楼下咖啡店", last4: "bbbb", isOwner: false)] }
  func testExactStillWorks() { XCTAssertEqual(AssistantData.match("小王", list).map(\.id), ["p_1"]) }
  func testFillerWords() { XCTAssertEqual(AssistantData.match("付给小王的", list).map(\.id), ["p_1"]); XCTAssertEqual(AssistantData.match("给咖啡店", list).map(\.id), ["p_2"]) }
  func testPinyin() { XCTAssertEqual(AssistantData.match("xiao wang", list).map(\.id), ["p_1"]); XCTAssertEqual(AssistantData.match("Xiaowang", list).map(\.id), ["p_1"]) }
  func testHomophone() { XCTAssertEqual(AssistantData.match("小汪", list).map(\.id), ["p_1"], "same pinyin, different character") }
  func testInitials() { XCTAssertEqual(AssistantData.match("xw", list).map(\.id), ["p_1"]) }
  func testNoMatchAndUnsavedAddress() {
    XCTAssertTrue(AssistantData.match("老李", list).isEmpty); XCTAssertTrue(AssistantData.match("x", list).isEmpty)
    XCTAssertTrue(AssistantData.match("0x" + String(repeating: "9", count: 40), list).isEmpty, "unsaved address never matches")
  }
  func testIndexKeywords() { let k = AssistantData.indexText(list[0]); XCTAssertTrue(k.contains("xiaowang")); XCTAssertTrue(k.contains("xw")) }
}
