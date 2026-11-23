import XCTest
@testable import KipurseCore
/// t1128u (§6#66): the restored post-opening enroll is accepted ONLY in the wallet-pays shape (fee <= 0.05 to Kipurse's fee address,
/// from the Kipurse wallet), checked on a batch the t1128 server tree actually built.
final class T1128EnrollFeeTests: XCTestCase {
  private var fx: [String: [String: Any]] {
    let u = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/t1128-enroll-fixtures.json")
    return (try! JSONSerialization.jsonObject(with: Data(contentsOf: u))) as! [String: [String: Any]]
  }
  private let owner = "0x1da2d5293bd418ab06d16890f17711302c7e74f6", wallet = "0x5e4c116dd45edc2dbed826be8b97a72499d03fc8"
  private let x = Hex.decode("6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296")!, y = Hex.decode("4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5")!
  func testServerWalletPaysBatchPassesBothChecks() {
    let r = fx["walletPays"]!
    XCTAssertNil(EnrollFee.problem(r, owner: owner))
    let rep = BatchVerify.enroll(calls: r["calls"] as! [[String: Any]], wallet: wallet, owner: owner, x: x, y: y); XCTAssertTrue(rep.ok, rep.problems.joined(separator: "; "))
  }
  /// Same commitment the live sign page (phone-enroll.v2.js, KPVH) recomputes: box page sim printed vh 3b7ebb32…d117 for this batch.
  func testAppCommitmentMatchesLivePageCanon() {
    let r = fx["walletPays"]!
    let u = BatchVerify.committedURL(URL(string: "https://sign.kipurse.com/v11/phone/enroll?id=x")!, chainId: 8453, from: r["owner"] as! String, calls: r["calls"] as! [[String: Any]])
    XCTAssertEqual(u?.fragment, "vh=3b7ebb325a92a00843ce51baa4ce1e97fee0d94d529dcd2a108a33899733d117")
  }
  func testOwnerFrontedShapeIsRefused() {
    XCTAssertNotNil(EnrollFee.problem(fx["ownerFronted"]!, owner: owner))
    var r = fx["walletPays"]!; r["walletPays"] = false; XCTAssertNotNil(EnrollFee.problem(r, owner: owner))
    r = fx["walletPays"]!; r["feeTo"] = owner; XCTAssertNotNil(EnrollFee.problem(r, owner: owner))
  }
  func testOverCapAndMismatchedQuoteAreRefused() {
    var r = fx["walletPays"]!; r["fee"] = "50001"; XCTAssertNotNil(EnrollFee.problem(r, owner: owner))
    r = fx["walletPays"]!; r["fee"] = "35401"; XCTAssertNotNil(EnrollFee.problem(r, owner: owner), "batch fee must equal the quote")
  }
  func testOpeningKeyIsFree() { XCTAssertNil(EnrollFee.problem(["fee": "0", "calls": [] as [Any]], owner: owner)) }
}
