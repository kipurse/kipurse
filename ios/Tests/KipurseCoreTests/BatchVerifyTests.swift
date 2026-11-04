import XCTest
@testable import KipurseCore

/// t621 #1: the phone decodes every server-built Coinbase wallet batch. Vectors are built by the SAME server code as production.
final class BatchVerifyTests: XCTestCase {
  var v: [String: Any] = [:]
  override func setUp() { v = (try? JSONSerialization.jsonObject(with: Data(BatchVectors.json.utf8))) as? [String: Any] ?? [:] }
  func calls(_ k: String) -> [[String: Any]] { (v[k] as? [[String: Any]]) ?? [] }
  func tampered(_ k: String) -> [[String: Any]] { ((v["tampered"] as? [String: Any])?[k] as? [[String: Any]]) ?? [] }
  var owner: String { v["owner"] as! String }; var wallet: String { v["wallet"] as! String }
  var x: [UInt8] { Hex.decode(v["x"] as! String)! }; var y: [UInt8] { Hex.decode(v["y"] as! String)! }
  var choice: RequestVerify.Choice { let c = v["choice"] as! [String: Any]; return .init(single: c["single"] as! String, daily: c["daily"] as! String, term: c["term"] as! String, days: c["days"] as? Int) }
  let now = Date(timeIntervalSince1970: 1_798_000_000)
  func setup(_ c: [[String: Any]]) -> BatchVerify.Report { BatchVerify.setup(calls: c, wallet: wallet, owner: owner, x: x, y: y, choice: choice, newWallet: true, now: now) }

  func testPredictedWalletMatchesFactory() { XCTAssertEqual(BatchVerify.predictWallet(owner: owner), wallet.lowercased()) }
  func testNewUserSetupAccepted() { let r = setup(calls("setupNew")); XCTAssertTrue(r.ok, r.problems.joined(separator: "; ")); XCTAssertEqual(r.approver, (v["approver"] as! String).lowercased()) }
  func testSetupTamperingRejected() {
    for k in ["setup_attacker_owner", "setup_other_owner_wallet", "setup_other_phone", "setup_extra_transfer", "setup_eth"] { XCTAssertFalse(setup(tampered(k)).ok, k) }
    var c = choice; c.single = "1000000"; XCTAssertFalse(BatchVerify.setup(calls: calls("setupNew"), wallet: wallet, owner: owner, x: x, y: y, choice: c, newWallet: true, now: now).ok, "caps differ from choice")
    XCTAssertFalse(BatchVerify.setup(calls: calls("setupNew"), wallet: "0x" + String(repeating: "1", count: 40), owner: owner, x: x, y: y, choice: choice, newWallet: true, now: now).ok, "wrong wallet")
  }
  func testEnrollAcceptedAndTamperingRejected() {
    let r = BatchVerify.enroll(calls: calls("enroll"), wallet: wallet, owner: owner, x: x, y: y); XCTAssertTrue(r.ok, r.problems.joined(separator: "; "))
    for k in ["enroll_remove_owner", "enroll_refund_attacker", "enroll_refund_big", "enroll_other_phone"] { XCTAssertFalse(BatchVerify.enroll(calls: tampered(k), wallet: wallet, owner: owner, x: x, y: y).ok, k) }
  }
  func testRevoke() {
    XCTAssertTrue(BatchVerify.revoke(calls: calls("revoke"), wallet: wallet, owner: owner, approver: v["revokeApprover"] as? String).ok)
    XCTAssertFalse(BatchVerify.revoke(calls: tampered("revoke_owner"), wallet: wallet, owner: owner, approver: nil).ok)
    XCTAssertFalse(BatchVerify.revoke(calls: calls("revoke"), wallet: wallet, owner: owner, approver: "0x" + String(repeating: "2", count: 40)).ok)
  }
  func testCommitmentMatchesServerAndPage() {
    let c = v["commit"] as! [String: Any]
    XCTAssertEqual(BatchVerify.canonical(chainId: 8453, from: c["from"] as! String, calls: c["calls"] as! [[String: Any]]), c["canon"] as? String)
    XCTAssertEqual(BatchVerify.commitment(chainId: 8453, from: c["from"] as! String, calls: c["calls"] as! [[String: Any]]), c["hex"] as? String)
    let u = BatchVerify.committedURL(URL(string: "https://example.org/onboard/new?id=1")!, chainId: 8453, from: owner, calls: calls("setupNew"))!
    XCTAssertEqual(u.fragment, "vh=" + (c["hex"] as! String)); XCTAssertEqual(URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "1")
    XCTAssertNotEqual(BatchVerify.commitment(chainId: 8453, from: owner, calls: tampered("setup_eth")), c["hex"] as? String)
  }
}
