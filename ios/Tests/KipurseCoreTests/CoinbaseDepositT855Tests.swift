import XCTest
@testable import KipurseCore
final class CoinbaseDepositT855Tests: XCTestCase {
  func testSendPageIsCoinbaseHttps() {
    XCTAssertEqual(Mainnet.coinbaseSendURL.scheme, "https"); XCTAssertEqual(Mainnet.coinbaseSendURL.host, "www.coinbase.com"); XCTAssertEqual(Mainnet.coinbaseSendURL.path, "/send")
  }
}
