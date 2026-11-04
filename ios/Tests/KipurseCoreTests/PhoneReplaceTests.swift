import XCTest
@testable import KipurseCore

/// t843: new phone replaces the old Face ID approver in ONE Coinbase wallet signature: add this phone first, then remove exactly the old approver.
final class PhoneReplaceTests: XCTestCase {
  var v: [String: Any] = [:]
  override func setUp() { v = (try? JSONSerialization.jsonObject(with: Data(BatchVectors.json.utf8))) as? [String: Any] ?? [:] }
  var owner: String { v["owner"] as! String }; var wallet: String { v["wallet"] as! String }
  var x: [UInt8] { Hex.decode(v["x"] as! String)! }; var y: [UInt8] { Hex.decode(v["y"] as! String)! }
  let old = "0x3000000000000000000000000000000000000003"
  func word(_ n: Int) -> [UInt8] { var b = [UInt8](repeating: 0, count: 32); var k = n; for i in (0..<32).reversed() { b[i] = UInt8(k & 0xff); k >>= 8 }; return b }
  func remove(_ a: String, index: Int = 2) -> [String: Any] {
    let d = Hex.decode(BatchVerify.selRemoveOwner)! + word(index) + word(64) + word(32) + [UInt8](repeating: 0, count: 12) + Hex.decode(a)!
    return ["to": wallet, "value": "0x0", "data": Hex.encode(d)]
  }
  var base: [[String: Any]] { ((v["enroll"] as? [[String: Any]]) ?? []).filter { BatchVerify.selector(Hex.decode(($0["data"] as? String) ?? "0x") ?? []) != BatchVerify.selRemoveOwner } }
  func addIndex(_ c: [[String: Any]]) -> Int { c.firstIndex { BatchVerify.selector(Hex.decode(($0["data"] as? String) ?? "0x") ?? []) == BatchVerify.selAddOwner }! }
  func with(_ r: [[String: Any]], before: Bool = false) -> [[String: Any]] { var c = base; let i = addIndex(c); c.insert(contentsOf: r, at: before ? i : i + 1); return c }
  func check(_ c: [[String: Any]], replacing: String? = nil) -> BatchVerify.Report { BatchVerify.enroll(calls: c, wallet: wallet, owner: owner, x: x, y: y, replacing: replacing ?? old) }

  func testReplaceAccepted() { let r = check(with([remove(old)])); XCTAssertTrue(r.ok, r.problems.joined(separator: "; ")) }
  func testRemoveBaseAccountRejected() { XCTAssertFalse(check(with([remove(owner)])).ok); XCTAssertFalse(check(with([remove(owner)]), replacing: owner).ok) }
  func testRemovePermissionManagerRejected() { XCTAssertFalse(check(with([remove(BatchVerify.spm)]), replacing: BatchVerify.spm).ok) }
  func testWrongOldKeyRejected() { XCTAssertFalse(check(with([remove("0x4000000000000000000000000000000000000004")])).ok) }
  func testTwoRemovalsRejected() { XCTAssertFalse(check(with([remove(old), remove("0x4000000000000000000000000000000000000004", index: 3)])).ok); XCTAssertFalse(check(with([remove(old), remove(old)])).ok) }
  func testNoRemovalRejected() { XCTAssertFalse(check(base).ok) }
  func testRemoveBeforeAddRejected() { XCTAssertFalse(check(with([remove(old)], before: true)).ok) }
  func testRemoveOnlyRejected() { XCTAssertFalse(check([remove(old)]).ok); XCTAssertFalse(check(base.filter { BatchVerify.selector(Hex.decode(($0["data"] as? String) ?? "0x") ?? []) != BatchVerify.selAddOwner } + [remove(old)]).ok) }
  func testETHValueRejected() { var c = with([remove(old)]); var e = c[addIndex(c) + 1]; e["value"] = "0x1"; c[addIndex(c) + 1] = e; XCTAssertFalse(check(c).ok)
    var c2 = with([remove(old)]); var a = c2[addIndex(c2)]; a["value"] = "0x5af3107a4000"; c2[addIndex(c2)] = a; XCTAssertFalse(check(c2).ok) }
  func testNonUSDCFeeRejected() {
    // fee refund pointed at a different token contract (execute(otherToken, 0, transfer(owner, fee))) must be rejected
    var c = with([remove(old)]); guard let i = c.firstIndex(where: { BatchVerify.selector(Hex.decode(($0["data"] as? String) ?? "0x") ?? []) == BatchVerify.selExecute }) else { return XCTFail("vector has no USDC refund") }
    var d = Hex.decode(c[i]["data"] as! String)!; for k in 16..<36 { d[k] = 0x77 }; var e = c[i]; e["data"] = Hex.encode(d); c[i] = e
    XCTAssertFalse(check(c).ok)
  }
}
