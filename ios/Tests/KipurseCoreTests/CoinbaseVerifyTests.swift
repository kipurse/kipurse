import XCTest
@testable import KipurseCore
final class CoinbaseVerifyTests: XCTestCase {
  func testOnlyOfficialCoinbaseLinks() {
    for u in CoinbaseVerify.all { XCTAssertTrue(CoinbaseVerify.isOfficial(u), u.absoluteString) }
    for s in ["http://www.coinbase.com/signup", "https://coinbase.com.evil.io/x", "https://evilcoinbase.com", "https://www.coinbase.co/onchain-verify"] {
      XCTAssertFalse(CoinbaseVerify.isOfficial(URL(string: s)!), s) }
  }
  func testStatusFailsClosed() {
    XCTAssertEqual(CoinbaseVerify.status(code: 200, json: ["verified": true]), .verified)
    XCTAssertEqual(CoinbaseVerify.status(code: 200, json: ["verified": false, "reason": "none"]), .notVerified)
    XCTAssertEqual(CoinbaseVerify.status(code: 200, json: ["verified": false, "reason": "unavailable"]), .unavailable)
    XCTAssertEqual(CoinbaseVerify.status(code: 500, json: ["verified": true]), .unavailable)
    XCTAssertEqual(CoinbaseVerify.status(code: 200, json: ["verified": "true"]), .notVerified)
    XCTAssertEqual(CoinbaseVerify.status(code: 200, json: nil), .unavailable)
  }
}
