import XCTest
@testable import KipurseCore

/// t1240 (handbook §6#110): on an owner ask, "trust" may name the merchant's ONE order signer under its domain (the server verified the signer the
/// merchant publishes); without that the trust must not add any signer (unchanged t1170 rule).
final class T1240OwnerAskSignerTests: XCTestCase {
  let payee = "0x1450e1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3b8", signer = "0xaDB2f2C49F31D59Bc46959818e5c445e1c01aCB8"
  func msg(name: String = "shop.example", signers: [String]) -> OwnerTrustMessage {
    OwnerTrustMessage(account: "0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb", merchant: "0x" + String(repeating: "a", count: 64), name: name, epoch: "0",
      payees: [payee], signers: signers, single: "5000000", daily: "20000000", expiry: String(Int(Date().timeIntervalSince1970) + 90 * 86400), nonce: "0x01", deadline: "1")
  }
  func testNoSignerAskStaysPayeeOnly() {
    XCTAssertEqual(OwnerAsk.trustProblems(msg(signers: []), payee: payee, single: "5000000"), [])
    XCTAssertTrue(OwnerAsk.trustProblems(msg(signers: [signer]), payee: payee, single: "5000000").contains("trust must not add order signers"))
  }
  func testSignedMerchantNeedsExactlyThatSignerAndDomain() {
    XCTAssertEqual(OwnerAsk.trustProblems(msg(signers: [signer]), payee: payee, single: "5000000", signer: signer, merchant: "shop.example"), [])
    let other = "0x" + String(repeating: "1", count: 40)
    XCTAssertFalse(OwnerAsk.trustProblems(msg(signers: [other]), payee: payee, single: "5000000", signer: signer, merchant: "shop.example").isEmpty)
    XCTAssertFalse(OwnerAsk.trustProblems(msg(signers: [signer, other]), payee: payee, single: "5000000", signer: signer, merchant: "shop.example").isEmpty)
    XCTAssertFalse(OwnerAsk.trustProblems(msg(name: "evil.example", signers: [signer]), payee: payee, single: "5000000", signer: signer, merchant: "shop.example").isEmpty)
    XCTAssertFalse(OwnerAsk.trustProblems(msg(signers: []), payee: payee, single: "5000000", signer: signer, merchant: "shop.example").isEmpty)
  }
  func testDomainShape() {
    XCTAssertTrue(OwnerAsk.isDomain("shop.example")); XCTAssertTrue(OwnerAsk.isDomain("shop-1.example.com"))
    XCTAssertFalse(OwnerAsk.isDomain("Shop.example")); XCTAssertFalse(OwnerAsk.isDomain("exampleshop")); XCTAssertFalse(OwnerAsk.isDomain("bid glow.ai")); XCTAssertFalse(OwnerAsk.isDomain(".ai"))
  }
}
