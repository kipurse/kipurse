import XCTest
@testable import KipurseCore
final class WrongTokenTests: XCTestCase {
  func testParseKeepsOnlyKnownNonZero() {
    let j = #"{"wallet":"0x1","owner":"0x2","stray":[{"sym":"USDT","amount":"3500000","shown":"3.5"},{"sym":"ETH","amount":"0","shown":"0"},{"sym":"USDC","amount":"5","shown":"5"},{"sym":"ETH","amount":"2000000000000000","shown":"0.002"}]}"#
    let s = WrongToken.parse(Data(j.utf8)); XCTAssertEqual(s.map(\.sym), ["USDT", "ETH"]); XCTAssertEqual(s[0].shown, "3.5")
    XCTAssertEqual(WrongToken.parse(Data("{}".utf8)), []); XCTAssertEqual(WrongToken.parse(Data("x".utf8)), [])
  }
  func testURLAndDemo() {
    XCTAssertEqual(WrongToken.url(base: URL(string: "https://pay.kipurse.com")!, wallet: "0xabc")?.absoluteString, "https://pay.kipurse.com/deposit?w=0xabc&stray=1")
    XCTAssertEqual(WrongToken.demo("USDT:3.5,BAD:1,ETH:0.002").map(\.sym), ["USDT", "ETH"])
    XCTAssertTrue(WrongToken.notice(StrayToken(sym: "USDT", amount: "1", shown: "3.5")).contains("3.5 USDT"))
  }
}
