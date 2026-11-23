import XCTest
@testable import KipurseCore

/// t1241 (handbook §6#111): layered merchant trust on the phone. The trust part still names exactly ONE signer under the merchant's domain
/// (now Kipurse's attestor for that domain, given by the server); the card says whether the merchant itself signs (unsigned: half limits).
final class T1241LayeredTrustTests: XCTestCase {
  private let att = "0xB2EA874D9A64326925032dF4DE2654cffc581203", payee = "0x4ce264e7b3683370879153388e345da28b6f0d6e"
  private func msg(name: String, signers: [String]) -> OwnerTrustMessage {
    OwnerTrustMessage(account: "0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb", merchant: "0x" + String(repeating: "ab", count: 32), name: name, epoch: "0", payees: [payee], signers: signers,
      single: "2000000", daily: "20000000", expiry: String(Int(Date().timeIntervalSince1970) + 90 * 86400), nonce: "0x" + String(repeating: "01", count: 32), deadline: "9999999999") }
  func testAttestorSignerUnderTheDomainIsAccepted() {
    XCTAssertEqual(OwnerAsk.trustProblems(msg(name: "shop.example", signers: [att]), payee: payee, single: "2000000", signer: att, merchant: "shop.example"), [])
  }
  func testStillExactlyOneSignerAndDomainName() {
    XCTAssertFalse(OwnerAsk.trustProblems(msg(name: "shop.example", signers: [att, payee]), payee: payee, single: "2000000", signer: att, merchant: "shop.example").isEmpty)
    XCTAssertFalse(OwnerAsk.trustProblems(msg(name: "evil.example", signers: [att]), payee: payee, single: "2000000", signer: att, merchant: "shop.example").isEmpty)
    XCTAssertFalse(OwnerAsk.trustProblems(msg(name: "shop.example", signers: [payee]), payee: payee, single: "2000000", signer: att, merchant: "shop.example").isEmpty)
  }
  func testDomainTrustLine() {
    XCTAssertEqual(OwnerAsk.domainTrustLine(domain: "shop.example", merchantSigned: true)?.zh, "信任 shop.example · 商家已签名")
    XCTAssertEqual(OwnerAsk.domainTrustLine(domain: "shop.example", merchantSigned: false)?.zh, "信任 shop.example · 商家未签名，自动付额度减半")
    XCTAssertTrue(OwnerAsk.domainTrustLine(domain: "shop.example", merchantSigned: false)?.en.contains("half") == true)
    XCTAssertNil(OwnerAsk.domainTrustLine(domain: nil, merchantSigned: true))
    XCTAssertNil(OwnerAsk.domainTrustLine(domain: "Not A Domain", merchantSigned: true))
  }
}
