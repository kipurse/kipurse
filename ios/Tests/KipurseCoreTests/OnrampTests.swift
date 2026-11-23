import XCTest
@testable import KipurseCore

final class OnrampTests: XCTestCase {
  let ref = "kp-0123456789abcdef01234567"
  func testConfiguredOpensCoinbasePayWithRef() {
    let u = "https://pay.coinbase.com/buy/select-asset?sessionToken=T1&defaultNetwork=base&defaultAsset=USDC&partnerUserRef=\(ref)"
    XCTAssertEqual(OnrampReply.parse(200, ["ok": true, "url": u, "ref": ref]), .open(URL(string: u)!, ref: ref))
    XCTAssertEqual(OnrampReply.parse(200, ["ok": true, "url": u, "ref": "bad"]), .open(URL(string: u)!, ref: nil))
  }
  func testNotConfiguredFallsBackToCoinbaseBuy() {
    XCTAssertEqual(OnrampReply.parse(200, ["ok": false, "error": "onramp_not_configured", "fallbackUrl": "https://www.coinbase.com/buy/usdc"]), .fallback(OnrampReply.coinbaseBuy))
    XCTAssertEqual(OnrampReply.parse(nil, nil), .fallback(OnrampReply.coinbaseBuy))
    XCTAssertEqual(OnrampReply.parse(502, ["ok": false]), .fallback(OnrampReply.coinbaseBuy))
  }
  func testRefusesForeignOrTokenlessPages() {
    XCTAssertEqual(OnrampReply.parse(200, ["ok": true, "url": "https://evil.example/buy?sessionToken=x"]), .fallback(OnrampReply.coinbaseBuy))
    XCTAssertEqual(OnrampReply.parse(200, ["ok": true, "url": "https://pay.coinbase.com/buy/select-asset"]), .fallback(OnrampReply.coinbaseBuy))
    XCTAssertEqual(OnrampReply.parse(200, ["ok": false, "fallbackUrl": "https://evil.example"]), .fallback(OnrampReply.coinbaseBuy))
  }
  func testStatusEveryBranch() {
    XCTAssertEqual(OnrampState.parse(200, ["ok": true, "state": "arrived", "amount": "4.88", "txHash": "0xab"], secondsSinceReturn: 5), .arrived(amount: "4.88", txHash: "0xab"))
    XCTAssertEqual(OnrampState.parse(200, ["ok": true, "state": "arriving", "amount": "4.88"], secondsSinceReturn: 5), .arriving(amount: "4.88"))
    XCTAssertEqual(OnrampState.parse(200, ["ok": true, "state": "failed"], secondsSinceReturn: 5), .failed)
    XCTAssertEqual(OnrampState.parse(200, ["ok": true, "state": "wrong_destination"], secondsSinceReturn: 5), .wrongDestination)
    XCTAssertEqual(OnrampState.parse(200, ["ok": true, "state": "not_found"], secondsSinceReturn: 30), .checking)
    XCTAssertEqual(OnrampState.parse(200, ["ok": true, "state": "not_found"], secondsSinceReturn: 95), .inCoinbaseAccount)
    XCTAssertEqual(OnrampState.parse(200, ["ok": true, "state": "not_found", "maybeInCoinbaseAccount": true], secondsSinceReturn: 1), .inCoinbaseAccount)
    XCTAssertEqual(OnrampState.parse(500, nil, secondsSinceReturn: 999), .checking, "server down never claims anything")
    XCTAssertTrue(OnrampState.arrived(amount: nil, txHash: nil).isFinal); XCTAssertFalse(OnrampState.inCoinbaseAccount.isFinal)
  }
  func testApplePayHelpers() {
    XCTAssertEqual(ApplePayOnramp.validPhone("(415) 555-2671"), "+14155552671"); XCTAssertEqual(ApplePayOnramp.validPhone("+1 415 555 2671"), "+14155552671")
    XCTAssertNil(ApplePayOnramp.validPhone("123")); XCTAssertNil(ApplePayOnramp.validPhone("+86 138 0000 0000")); XCTAssertNil(ApplePayOnramp.validPhone("1155552671"))
    XCTAssertTrue(ApplePayOnramp.validEmail("a@b.co")); XCTAssertFalse(ApplePayOnramp.validEmail("nope"))
    XCTAssertNotNil(ApplePayOnramp.payURL(["url": "https://pay.coinbase.com/v2/api-onramp/apple-pay?x=1"])); XCTAssertNil(ApplePayOnramp.payURL(["url": "https://evil.example/x"])); XCTAssertNil(ApplePayOnramp.payURL(["url": "http://pay.coinbase.com/x"]))
    XCTAssertEqual(ApplePayOnramp.event(#"{"eventName":"onramp_api.commit_success"}"#), .started)
    XCTAssertEqual(ApplePayOnramp.event(["eventName": "onramp_api.polling_success"]), .done)
    XCTAssertEqual(ApplePayOnramp.event(["eventName": "onramp_api.cancel"]), .canceled)
    XCTAssertEqual(ApplePayOnramp.event(["eventName": "onramp_api.commit_error", "data": ["errorMessage": "Card declined"]]), .error("Card declined"))
    XCTAssertNil(ApplePayOnramp.event("garbage"))
    XCTAssertEqual(OnrampState.parse(200, ["ok": true, "state": "awaiting_payment"], secondsSinceReturn: 999), .checking, "unpaid order never becomes in-Coinbase")
  }
}
