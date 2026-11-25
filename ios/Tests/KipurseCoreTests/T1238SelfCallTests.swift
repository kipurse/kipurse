import XCTest
@testable import KipurseCore

/// t1238 (decision 106): Coinbase refuses top-level owner calls ("Account owner or upgrade calls are not allowed."), so the server
/// now sends owner changes as wallet.execute(wallet, 0, addOwnerAddress/removeOwnerAtIndex(...)). The phone must check the INNER call
/// with exactly the same rules as the old top-level form, and refuse every other self-call.
final class T1238SelfCallTests: XCTestCase {
  var v: [String: Any] = [:]
  override func setUp() { v = (try? JSONSerialization.jsonObject(with: Data(BatchVectors.json.utf8))) as? [String: Any] ?? [:] }
  func calls(_ k: String) -> [[String: Any]] { (v[k] as? [[String: Any]]) ?? [] }
  func tampered(_ k: String) -> [[String: Any]] { ((v["tampered"] as? [String: Any])?[k] as? [[String: Any]]) ?? [] }
  var owner: String { v["owner"] as! String }; var wallet: String { v["wallet"] as! String }
  var x: [UInt8] { Hex.decode(v["x"] as! String)! }; var y: [UInt8] { Hex.decode(v["y"] as! String)! }
  var choice: RequestVerify.Choice { let c = v["choice"] as! [String: Any]; return .init(single: c["single"] as! String, daily: c["daily"] as! String, term: c["term"] as! String, days: c["days"] as? Int) }
  let now = Date(timeIntervalSince1970: 1_798_000_000)

  static func word(_ n: Int) -> String { String(repeating: "0", count: 64 - String(n, radix: 16).count) + String(n, radix: 16) }
  /// wallet.execute(target, value, inner) encoded like viem does.
  static func execute(target: String, value: Int = 0, inner: String) -> String {
    let i = inner.lowercased().replacingOccurrences(of: "0x", with: ""), len = i.count / 2, pad = String(repeating: "0", count: ((len + 31) / 32 * 32 - len) * 2)
    return BatchVerify.selExecute + String(repeating: "0", count: 24) + target.lowercased().dropFirst(2) + word(value) + word(96) + word(len) + i + pad
  }
  /// Turn every top-level owner change in a batch into the wallet self-call shape the new server sends.
  func wrap(_ c: [[String: Any]], target: String? = nil, value: Int = 0) -> [[String: Any]] {
    c.map { call in
      guard let to = call["to"] as? String, to.lowercased() == wallet.lowercased(), let d = call["data"] as? String,
            d.lowercased().hasPrefix(BatchVerify.selAddOwner) || d.lowercased().hasPrefix(BatchVerify.selRemoveOwner) else { return call }
      var n = call; n["data"] = Self.execute(target: target ?? wallet, value: value, inner: d); return n
    }
  }
  func setup(_ c: [[String: Any]]) -> BatchVerify.Report { BatchVerify.setup(calls: c, wallet: wallet, owner: owner, x: x, y: y, choice: choice, newWallet: true, now: now) }
  func ownerTop(_ c: [[String: Any]]) -> Int { c.filter { (($0["data"] as? String) ?? "").lowercased().hasPrefix(BatchVerify.selAddOwner) || (($0["data"] as? String) ?? "").lowercased().hasPrefix(BatchVerify.selRemoveOwner) }.count }

  func testSelfCallShapeAcceptedForOpeningEnrollRevoke() {
    let s = wrap(calls("setupNew")); XCTAssertEqual(ownerTop(s), 0); XCTAssertGreaterThan(ownerTop(calls("setupNew")), 0)
    let r = setup(s); XCTAssertTrue(r.ok, r.problems.joined(separator: "; ")); XCTAssertEqual(r.approver, (v["approver"] as! String).lowercased())
    let e = BatchVerify.enroll(calls: wrap(calls("enroll")), wallet: wallet, owner: owner, x: x, y: y, replacing: v["revokeApprover"] as? String); XCTAssertTrue(e.ok, e.problems.joined(separator: "; "))
    XCTAssertTrue(BatchVerify.revoke(calls: wrap(calls("revoke")), wallet: wallet, owner: owner, approver: v["revokeApprover"] as? String).ok)
  }
  func testOldTopLevelShapeStillChecked() {  // an older server still works the same way (and is still checked the same way)
    XCTAssertTrue(setup(calls("setupNew")).ok); XCTAssertTrue(BatchVerify.enroll(calls: calls("enroll"), wallet: wallet, owner: owner, x: x, y: y, replacing: v["revokeApprover"] as? String).ok)
  }
  func testSameRulesInsideTheSelfCall() {
    for k in ["setup_attacker_owner", "setup_other_owner_wallet", "setup_other_phone"] { XCTAssertFalse(setup(wrap(tampered(k))).ok, k) }
    for k in ["enroll_remove_owner", "enroll_other_phone"] { XCTAssertFalse(BatchVerify.enroll(calls: wrap(tampered(k)), wallet: wallet, owner: owner, x: x, y: y, replacing: v["revokeApprover"] as? String).ok, k) }
    XCTAssertFalse(BatchVerify.revoke(calls: wrap(tampered("revoke_owner")), wallet: wallet, owner: owner, approver: nil).ok, "self-call removing your Coinbase wallet")
    XCTAssertFalse(BatchVerify.revoke(calls: wrap(calls("revoke")), wallet: wallet, owner: owner, approver: "0x" + String(repeating: "2", count: 40)).ok)
  }
  func testOtherSelfCallsRefused() {
    // value inside the self-call
    XCTAssertFalse(BatchVerify.enroll(calls: wrap(calls("enroll"), value: 1), wallet: wallet, owner: owner, x: x, y: y).ok, "self-call with value")
    XCTAssertFalse(BatchVerify.revoke(calls: wrap(calls("revoke"), value: 1), wallet: wallet, owner: owner, approver: nil).ok)
    // anything else inside a self-call (e.g. an upgrade or executeBatch) is refused
    let upgrade = BatchVerify.sel("upgradeToAndCall(address,bytes)") + Self.word(0) + Self.word(64) + Self.word(0)
    var e = calls("enroll"); e.append(["to": wallet, "value": "0x0", "data": Self.execute(target: wallet, inner: upgrade)])
    XCTAssertFalse(BatchVerify.enroll(calls: e, wallet: wallet, owner: owner, x: x, y: y).ok, "upgrade inside self-call")
    let rv = [["to": wallet, "value": "0x0", "data": Self.execute(target: wallet, inner: upgrade)]] as [[String: Any]]
    XCTAssertFalse(BatchVerify.revoke(calls: rv, wallet: wallet, owner: owner, approver: nil).ok)
    // trailing junk after the padded inner call
    var j = wrap(calls("revoke")); j[0]["data"] = (j[0]["data"] as! String) + String(repeating: "00", count: 32)
    XCTAssertFalse(BatchVerify.revoke(calls: j, wallet: wallet, owner: owner, approver: nil).ok, "non-canonical encoding")
    // owner change routed through execute on ANOTHER target is not a self-call and is refused
    XCTAssertFalse(BatchVerify.revoke(calls: wrap(calls("revoke"), target: "0x" + String(repeating: "3", count: 40)), wallet: wallet, owner: owner, approver: nil).ok)
  }
}
