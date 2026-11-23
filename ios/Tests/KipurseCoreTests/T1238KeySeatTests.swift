import XCTest
@testable import KipurseCore

/// t1238 (handbook §6#109): the phone checks key-seat batches. Fixtures are the REAL server replies from the Base-fork matrix run with
/// KIPURSE_KEY_SEAT=1 (work/t1214/deploy/t1238-seat-matrix-ON-fixtures.json): opening (U1/U2/U3), new phone (U1.enroll), Face ID off (U1.revokePlan).
final class T1238KeySeatTests: XCTestCase {
  var f: [String: [String: Any]] = [:]
  override func setUp() {
    let u = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("t1238-seat-fixtures.json.txt")
    f = ((try? JSONSerialization.jsonObject(with: Data(contentsOf: u))) as? [String: [String: Any]]) ?? [:]
    KipurseSuite.pin(.v53)   // new wallets open on V5.3 (§6#92); the seat was built with the V5.3 trust
  }
  override func tearDown() { KipurseSuite.pin(nil) }
  func calls(_ k: String) -> [[String: Any]] { ((f[k]?["calls"] as? [[String: Any]]) ?? []).map { $0.compactMapValues { $0 as? String } } }
  func s(_ k: String, _ field: String) -> String { f[k]?[field] as! String }
  func key(_ k: String) -> ([UInt8], [UInt8]) { (Hex.decode(s(k, "x"))!, Hex.decode(s(k, "y"))!) }
  /// Same conversion the app and T1138 use: decimal USDC the user picked -> atomic strings.
  func choice(_ k: String) -> RequestVerify.Choice { let c = f[k]!["choice"] as! [String: String]
    return .init(single: String(AnswerRules.parseUSDC(c["single"]!) ?? 0), daily: String(AnswerRules.parseUSDC(c["daily"]!) ?? 0), term: String(AnswerRules.parseUSDC(c["term"]!) ?? 0), days: Int(c["days"]!)) }
  func open(_ k: String, calls c: [[String: Any]]? = nil, x: [UInt8]? = nil) -> BatchVerify.Report {
    let (kx, ky) = key(k)
    return BatchVerify.setup(calls: c ?? calls(k), wallet: s(k, "wallet"), owner: s(k, "owner"), x: x ?? kx, y: ky, choice: choice(k), newWallet: true, vault: s(k, "vault"))
  }
  func replace(_ c: [[String: Any]], _ i: Int, data: String) -> [[String: Any]] { var c = c; c[i]["data"] = data; return c }
  func idx(_ c: [[String: Any]], to: String) -> Int { c.firstIndex { ($0["to"] as? String)?.lowercased() == to.lowercased() }! }

  func testPhoneComputesTheSameSeatAndWalletAsTheServer() {
    for u in ["U1", "U2", "U3"] {
      let k = "\(u).prepare", owner = s(k, "owner")
      let seat = KeySeat.address(owner: owner, trust: KipurseSuite.v53.trust)!
      XCTAssertEqual(KeySeat.predictWallet(owner: owner, trust: KipurseSuite.v53.trust), s(k, "wallet").lowercased(), u)
      let dep = calls(k).first { ($0["to"] as? String)?.lowercased() == BatchVerify.deployer }
      XCTAssertEqual((dep?["data"] as? String)?.lowercased(), KeySeat.deployData(owner: owner, trust: KipurseSuite.v53.trust), u)
      XCTAssertNotEqual(seat, owner.lowercased())
    }
  }
  func testRealSeatOpeningsAccepted() {
    for u in ["U1", "U2", "U3"] { let r = open("\(u).prepare"); XCTAssertTrue(r.ok, "\(u): " + r.problems.joined(separator: "; "))
      XCTAssertEqual(r.approver, KeySeat.address(owner: s("\(u).prepare", "owner"), trust: KipurseSuite.v53.trust)) }
  }
  func testOpeningTamperingRefused() {
    let k = "U1.prepare", c = calls(k), w = s(k, "wallet")
    // another phone's key
    XCTAssertFalse(open(k, x: Array(repeating: 7, count: 32)).ok, "other phone")
    // wallet created with an extra / different owner
    let fi = idx(c, to: BatchVerify.factory)
    let other = KeySeat.createAccountData(owner: "0x" + String(repeating: "9", count: 40), trust: KipurseSuite.v53.trust)!
    XCTAssertFalse(open(k, calls: replace(c, fi, data: other)).ok, "other owner list")
    // an owner change sneaked in (top level and as a self-call)
    let add = BatchVerify.selAddOwner + String(repeating: "0", count: 24) + String(repeating: "a", count: 40)
    var c2 = c; c2.insert(["to": w, "value": "0x0", "data": add], at: c2.count - 1)
    XCTAssertFalse(open(k, calls: c2).ok, "addOwner top level")
    var c3 = c; c3.insert(["to": w, "value": "0x0", "data": T1238SelfCallTests.execute(target: w, inner: add)], at: c3.count - 1)
    XCTAssertFalse(open(k, calls: c3).ok, "addOwner as self-call")
    // seat code swapped (different trust baked in) or setKey removed
    let di = idx(c, to: BatchVerify.deployer)
    XCTAssertFalse(open(k, calls: replace(c, di, data: KeySeat.deployData(owner: s(k, "owner"), trust: KipurseSuite.v52.trust)!)).ok, "other seat code")
    var c4 = c; c4.removeAll { ($0["data"] as? String)?.lowercased().contains(KeySeat.selSetKey.dropFirst(2).lowercased()) == true && ($0["to"] as? String)?.lowercased() == w.lowercased() }
    XCTAssertFalse(open(k, calls: c4).ok, "phone not set")
    // the deployer step may be missing (someone else deployed the same public seat code first): still fine
    var c5 = c; c5.remove(at: di); XCTAssertTrue(open(k, calls: c5).ok, open(k, calls: c5).problems.joined(separator: "; "))
  }
  func testRealNewPhoneAcceptedAndTamperingRefused() {
    let k = "U1.enroll", (x, y) = key(k), w = s(k, "wallet"), o = s(k, "owner"), c = calls(k)
    let r = BatchVerify.enroll(calls: c, wallet: w, owner: o, x: x, y: y); XCTAssertTrue(r.ok, r.problems.joined(separator: "; "))
    XCTAssertEqual(r.approver, s(k, "approver").lowercased())
    XCTAssertNil(EnrollFee.problem(f[k]! as [String: Any], owner: o), "wallet-pays fee shape (§6#66)")
    XCTAssertFalse(BatchVerify.enroll(calls: c, wallet: w, owner: o, x: Array(repeating: 7, count: 32), y: y).ok, "another phone")
    var two = c; two.append(c[0]); XCTAssertFalse(BatchVerify.enroll(calls: two, wallet: w, owner: o, x: x, y: y).ok, "set twice / extra step")
    let seat = s(k, "approver"), clear = T1238SelfCallTests.execute(target: seat, inner: KeySeat.clearKeyData)
    XCTAssertFalse(BatchVerify.enroll(calls: replace(c, 0, data: clear), wallet: w, owner: o, x: x, y: y).ok, "clearKey is not 'use this phone'")
  }
  func testRealFaceIDOffAcceptedOnlyExactly() {
    let k = "U1.revokePlan", w = s(k, "wallet"), o = s(k, "owner"), c = calls(k)
    XCTAssertTrue(BatchVerify.revoke(calls: c, wallet: w, owner: o, approver: s(k, "approver")).ok)
    XCTAssertFalse(BatchVerify.revoke(calls: c + c, wallet: w, owner: o, approver: nil).ok, "two steps")
    let seat = s(k, "approver"), (x, y) = key("U1.enroll")
    XCTAssertFalse(BatchVerify.revoke(calls: replace(c, 0, data: T1238SelfCallTests.execute(target: seat, inner: KeySeat.setKeyData(x: x, y: y))), wallet: w, owner: o, approver: nil).ok, "setKey is not 'off'")
  }
  func testOldWalletsUnchanged() {
    // a V5.2 / old-style wallet (no seat call) still goes through the old checks: the legacy vectors pass exactly as before
    KipurseSuite.pin(nil)
    let v = (try? JSONSerialization.jsonObject(with: Data(BatchVectors.json.utf8))) as? [String: Any] ?? [:]
    let r = BatchVerify.enroll(calls: (v["enroll"] as? [[String: Any]]) ?? [], wallet: v["wallet"] as! String, owner: v["owner"] as! String, x: Hex.decode(v["x"] as! String)!, y: Hex.decode(v["y"] as! String)!)
    XCTAssertTrue(r.ok, r.problems.joined(separator: "; "))
  }
}
