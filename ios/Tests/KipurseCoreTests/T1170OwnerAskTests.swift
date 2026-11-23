import XCTest
@testable import KipurseCore

/// t1170u (§6#82): the phone only signs the owner-ask choice it shows, bound to trust | once, for exactly this payee.
final class T1170OwnerAskTests: XCTestCase {
  let w = "0x00000000000000000000000000000000000000aa"
  var base: String { "Kipurse allowance approval v1\nwallet:\(w)\nid:apr_1\nitems:[]" }
  func testModeIsBoundIntoTheSignedText() {
    XCTAssertTrue(OwnerAsk.textOK(base + "\nmode:trust", base: base, wallet: w, id: "apr_1", mode: "trust"))
    XCTAssertTrue(OwnerAsk.textOK(base + "\nmode:once", base: base, wallet: w, id: "apr_1", mode: "once"))
    XCTAssertFalse(OwnerAsk.textOK(base + "\nmode:once", base: base, wallet: w, id: "apr_1", mode: "trust"), "a once text can never be signed as trust")
    XCTAssertFalse(OwnerAsk.textOK(base + "\nmode:trust", base: base, wallet: "0x00000000000000000000000000000000000000bb", id: "apr_1", mode: "trust"), "other wallet")
    XCTAssertFalse(OwnerAsk.textOK(base + "\nmode:trust", base: base, wallet: w, id: "apr_2", mode: "trust"), "other request")
    XCTAssertFalse(OwnerAsk.textOK(base + "\nmode:trust\nmode:once", base: base, wallet: w, id: "apr_1", mode: "trust"))
    XCTAssertFalse(OwnerAsk.textOK(base + "\nmode:pay", base: base, wallet: w, id: "apr_1", mode: "pay"))
  }
  func testTrustOnlyForThisPayeeAndShownCap() {
    let payee = "0x1212121212121212121212121212121212121212"
    let exp = String(Int(Date().timeIntervalSince1970) + 90 * 86400)
    let ok = OwnerTrustMessage(account: w, merchant: "0x" + String(repeating: "ab", count: 32), name: "desk 0x1212…1212", epoch: "0", payees: [payee], signers: [], single: "2000000", daily: "5005000", expiry: exp, nonce: "0x" + String(repeating: "cd", count: 32), deadline: exp)
    XCTAssertEqual(OwnerAsk.trustProblems(ok, payee: payee, single: "2000000"), [])
    var two = ok; two.payees = [payee, "0x3434343434343434343434343434343434343434"]; XCTAssertFalse(OwnerAsk.trustProblems(two, payee: payee, single: "2000000").isEmpty)
    var other = ok; other.payees = ["0x3434343434343434343434343434343434343434"]; XCTAssertFalse(OwnerAsk.trustProblems(other, payee: payee, single: "2000000").isEmpty)
    var big = ok; big.single = "9000000"; XCTAssertFalse(OwnerAsk.trustProblems(big, payee: payee, single: "2000000").isEmpty)
    var forever = ok; forever.expiry = "99999999999"; XCTAssertFalse(OwnerAsk.trustProblems(forever, payee: payee, single: "2000000").isEmpty)
    var signer = ok; signer.signers = [payee]; XCTAssertFalse(OwnerAsk.trustProblems(signer, payee: payee, single: "2000000").isEmpty)
    XCTAssertEqual(OwnerAsk.grouped("0x12345678"), "0x 1234 5678")
  }
}
