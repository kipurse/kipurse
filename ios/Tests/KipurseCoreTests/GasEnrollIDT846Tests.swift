import XCTest
@testable import KipurseCore
final class GasEnrollIDT846Tests: XCTestCase {
  func testQueryID() { XCTAssertEqual(GasCheck.enrollID(URL(string: "https://a.b/phone/enroll?id=abc")!), "abc") }
  func testShellFragmentID() {
    let u = SignHost.shellURL(for: URL(string: "https://\(SignHost.apiHost)/phone/enroll?id=xyz9")!, fragment: "vh=0x1", lang: "zh")
    if let u { XCTAssertEqual(GasCheck.enrollID(u), "xyz9") }
    XCTAssertEqual(GasCheck.enrollID(URL(string: "https://s.h/phone/enroll#u=%2Fphone%2Fenroll%3Fid%3Dq1%26lang%3Dzh&vh=0x1")!), "q1")
  }
  func testNoID() { XCTAssertNil(GasCheck.enrollID(URL(string: "https://a.b/phone/enroll")!)) }
}
