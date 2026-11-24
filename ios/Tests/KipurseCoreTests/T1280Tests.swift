// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import KipurseCore

/// t1280: the phone binds every SpendPermission policy field the server builds (Q2), the permission a limit change replaces (Q3),
/// the trust epoch (Q4, read on chain) and refuses an enroll removal it did not ask for (L1).
final class T1280Tests: XCTestCase {
  // ---- fixtures ----
  let wallet = "0x515010c2e41F98CdDd76B819EE69DC832c0939B6", owner = "0x4242b022A8296cB18B0E0b1Cb9879C518170A718"
  let choice = RequestVerify.Choice(single: "1000000000", daily: "3000000000", term: "50000000000", days: 365)
  let at = Date(timeIntervalSince1970: 1_794_527_010)
  static func file(_ n: String) -> URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(n) }
  func json(_ n: String) throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.file(n))) as? [String: Any]) }
  func check(_ j: [String: Any]) -> RequestVerify.LimitsReply { RequestVerify.limitsReply(j, wallet: wallet, owner: owner, choice: choice, now: at) }

  // ---- policy word editing (extraData = length 0x180 + 12 words) ----
  static let anchor = String(repeating: "0", count: 61) + "180"
  /// Character offsets of word 0 of every policy in a hex string.
  static func policies(_ hex: String) -> [Int] {
    let s = Array(hex.lowercased()), a = Array(anchor); var out = [Int](), i = 0
    while i + 64 + 12 * 64 <= s.count {
      if Array(s[i..<(i + 64)]) == a, s[(i + 64)..<(i + 64 + 24)].allSatisfy({ $0 == "0" }) { out.append(i + 64); i += 64 + 12 * 64 } else { i += 1 }
    }
    return out
  }
  static func w(_ n: UInt64) -> String { let h = String(n, radix: 16); return String(repeating: "0", count: 64 - h.count) + h }
  static func wa(_ a: String) -> String { String(repeating: "0", count: 24) + a.lowercased().dropFirst(2) }
  static func set(_ hex: String, policy k: [Int], word i: Int, to v: String) -> String {
    var s = Array(hex); let offs = policies(hex)
    for p in k { let o = offs[p] + i * 64; s.replaceSubrange(o..<(o + 64), with: Array(v)) }
    return String(s)
  }
  // (the tests against the operator's live /owner/limits/prepare reply and V5.5 move plan run only in the private tree: their fixtures are not published)

  func testPolicyFormulaUnit() {
    let tpl = RequestVerify.templatePolicy
    func pol(_ f: (inout [String]) -> Void) -> [String] { var p = ["0x" + String(repeating: "1", count: 40)] + Array(tpl.dropFirst()); p[2] = "5000000"; p[3] = "20000000"; p[4] = "100000000"; f(&p); return p }
    XCTAssertEqual(RequestVerify.policyProblems(pol { _ in }, old: nil, single: "5000000", daily: "20000000"), [])
    // choice below the template: sub-caps follow the choice
    XCTAssertEqual(RequestVerify.policyProblems(pol { $0[5] = "50000"; $0[7] = "50000" }, old: nil, single: "50000", daily: "20000000"), [])
    XCTAssertFalse(RequestVerify.policyProblems(pol { $0[9] = KipurseV55.registryV2.lowercased() }, old: nil, single: "5000000", daily: "20000000").isEmpty, "V5.2-V5.4 opening: template registry only")
    XCTAssertEqual(RequestVerify.policyProblems(pol { $0[9] = KipurseV55.registryV2.lowercased() }, old: nil, single: "5000000", daily: "20000000", v55: true), [])
    XCTAssertEqual(RequestVerify.policyCeilingProblems(pol { $0[10] = "1000"; $0[11] = "50000" }), [])
    XCTAssertEqual(RequestVerify.policyCeilingProblems(pol { $0[10] = "1001" }).count, 1)
    XCTAssertEqual(RequestVerify.policyCeilingProblems(pol { $0[11] = "50001" }).count, 1)
    XCTAssertEqual(RequestVerify.policyCeilingProblems(pol { $0[1] = "0x" + String(repeating: "2", count: 40) }).count, 1)
    XCTAssertEqual(RequestVerify.policyCeilingProblems(pol { $0[9] = "0x" + String(repeating: "3", count: 40) }).count, 1)
    XCTAssertEqual(RequestVerify.merchantRegistry, "0x26c707ccbd569624CF31F5c574d4Fdf7E3f23998".lowercased())
  }

  // MARK: Q2 (c) - opening (no revoke): template constants and min(template, choice)
  var bv: [String: Any] { (try? JSONSerialization.jsonObject(with: Data(BatchVectors.json.utf8))) as? [String: Any] ?? [:] }
  func setup(_ calls: [[String: Any]]) -> BatchVerify.Report {
    let v = bv, c = v["choice"] as! [String: Any]
    return BatchVerify.setup(calls: calls, wallet: v["wallet"] as! String, owner: v["owner"] as! String, x: Hex.decode(v["x"] as! String)!, y: Hex.decode(v["y"] as! String)!,
                             choice: .init(single: c["single"] as! String, daily: c["daily"] as! String, term: c["term"] as! String, days: c["days"] as? Int), newWallet: true, now: Date(timeIntervalSince1970: 1_798_000_000))
  }
  func testOpeningUsesTheTemplate() {
    let calls = (bv["setupNew"] as! [[String: Any]]).map { $0.compactMapValues { $0 as? String } }
    XCTAssertTrue(setup(calls).ok, setup(calls).problems.joined(separator: "; "))
    let idx = calls.firstIndex { Self.policies($0["data"] as? String ?? "").count == 2 }!
    for (i, v, why) in [(5, Self.w(99_999), "openSingle"), (8, Self.w(5_005_001), "verifiedDaily"), (9, Self.wa(RequestVerify.zeroAddress), "registry"),
                        (10, Self.w(999), "maxFeePpm"), (11, Self.w(40_000), "maxNetworkFee"), (1, Self.wa(owner), "guardian")] {
      var c = calls; c[idx]["data"] = Self.set(c[idx]["data"] as! String, policy: [0, 1], word: i, to: v)
      XCTAssertFalse(setup(c).ok, why)
    }
  }

  // MARK: Q3 - a later change replaces exactly one permission, and it must be live on chain
  func testChangeWithoutRevokeRefused() throws {
    let v = try json("t1185-ops-vector.json.txt"), b = v["noOps"] as! [String: Any]
    let calls: [[String: Any]] = [["to": b["to"]!, "value": "0x0", "data": b["data"]!]]
    let ch = RequestVerify.Choice(single: "5000000", daily: "10000000", term: "50000000", days: 30), now = Date(timeIntervalSince1970: Double(v["start"] as! Int) + 60)
    let w = v["wallet"] as! String, ad = "0xb150030be35903AdEE466d7733Bf0841B667033C"
    XCTAssertTrue(RequestVerify.limitsBatch(calls: calls, wallet: w, chainId: 8453, choice: ch, currentExecutor: nil, adapter: ad, now: now).ok, "opening shape on its own")
    let r = RequestVerify.limitsBatch(calls: calls, wallet: w, chainId: 8453, choice: ch, currentExecutor: nil, adapter: ad, now: now, requireRevoke: true)
    XCTAssertTrue(r.problems.contains("a limit change must replace exactly your current permission")); XCTAssertNil(r.revokeArgs)
    XCTAssertFalse(RequestVerify.limitsPrepared(calls: calls, wallet: w, chainId: 8453, choice: ch, owner: nil, walletPays: false, now: now).ok)
  }


  // MARK: Q4 - the trust epoch is read on chain
  func testTrustEpochFromChain() async {
    let acc = "0x" + String(repeating: "a", count: 40), mer = "0x" + String(repeating: "b", count: 64), trust = KipurseSuite.v55.trust
    var seen: (String, String)?
    func rec(_ epoch: UInt64) -> RequestVerify.ChainCall { { to, d in seen = (to, d); return "0x" + Self.w(epoch) + Self.w(1_900_000_000) + Self.w(1) + Self.w(5) + Self.w(20) } }
    var ok = await PhoneTrust.chainEpochMatches(account: acc, merchant: mer, epoch: "3", trust: trust, call: rec(3)); XCTAssertTrue(ok)
    XCTAssertEqual(seen?.0, trust); XCTAssertEqual(seen?.1, BatchVerify.sel("trustOf(address,bytes32)") + Self.wa(acc) + String(repeating: "b", count: 64))
    ok = await PhoneTrust.chainEpochMatches(account: acc, merchant: mer, epoch: "2", trust: trust, call: rec(3)); XCTAssertFalse(ok, "server epoch is stale (untrusted since)")
    ok = await PhoneTrust.chainEpochMatches(account: acc, merchant: mer, epoch: "4", trust: trust, call: rec(3)); XCTAssertFalse(ok)
    ok = await PhoneTrust.chainEpochMatches(account: acc, merchant: mer, epoch: "3", trust: trust, call: { _, _ in nil }); XCTAssertFalse(ok, "no agreed read")
    ok = await PhoneTrust.chainEpochMatches(account: acc, merchant: mer, epoch: "03", trust: trust, call: rec(3)); XCTAssertFalse(ok, "non-canonical number")
    ok = await PhoneTrust.chainEpochMatches(account: "0x12", merchant: mer, epoch: "3", trust: trust, call: rec(3)); XCTAssertFalse(ok)
  }

  // MARK: L1 (reverted in t1280 after review): after "forget my data" the server removes a DEAD key with replaces = nil - that must still enroll;
  // with replaces set, only that signer may go; the Coinbase owner / SPM / the new approver are never removable
  func testEnrollRemovalNeedsReplacing() {
    let v = bv; let calls = v["enroll"] as! [[String: Any]], old = v["revokeApprover"] as! String
    func enroll(_ r: String?) -> BatchVerify.Report { BatchVerify.enroll(calls: calls, wallet: v["wallet"] as! String, owner: v["owner"] as! String, x: Hex.decode(v["x"] as! String)!, y: Hex.decode(v["y"] as! String)!, replacing: r) }
    XCTAssertTrue(enroll(old).ok, enroll(old).problems.joined(separator: "; "))
    XCTAssertTrue(enroll(nil).ok, "re-enabling Face ID after forget (dead key removed, replaces = nil): " + enroll(nil).problems.joined(separator: "; "))
    XCTAssertFalse(enroll("0x" + String(repeating: "4", count: 40)).ok, "a different old signer")
  }

  // MARK: t1280 duplicate-purchase card - cross-test: this text was produced by the gateway (test/t1280-reaudit.test.mjs, mode once)
  static let dupSignText = """
Kipurse allowance approval v1
wallet:0xc44cf075a58df30b7c63b114cdf6784376009e0b
id:apr_bb7f1b12515e
items:[{"kind":"one_off","purpose":"daily","label":null,"single":"1000000","daily":"1000000","monthly":"30000000","payees":["0x3444aa8ed2716e0f60483e02dec8edab7b2e94d3"],"hosts":[],"agents":[],"recurring":null,"oneOff":{"payee":"0x3444aa8ed2716e0f60483e02dec8edab7b2e94d3","host":null,"amount":"1000000","idem":null,"remember":false,"aiName":"Shop","ask":true,"note":"desk lamp","dup":true},"expiresInDays":1,"replaces":null}]
chain:84532
token:0x036cbd53842c5426634e7929541ec2318f3dcf7e
mode:once
"""
  func testDuplicateCardFromServerText() {
    guard let p = AllowanceText.parse(Self.dupSignText, allowMode: true) else { return XCTFail("parse") }
    XCTAssertTrue(AllowanceText.askIsDup(p))
    XCTAssertTrue(AllowanceText.askMatches(p, payee: "0x3444aa8ed2716e0f60483e02dec8edab7b2e94d3", amount: "1000000"))
    let line = AllowanceText.lines(p).first ?? ""
    XCTAssertTrue(line.contains("疑似重复购买") || line.contains("Possible duplicate"), line)
    XCTAssertFalse(line.contains("新收款方") || line.contains("NEW payee"), line)
    // without the signed flag it is the ordinary new-payee card
    guard let q = AllowanceText.parse(Self.dupSignText.replacingOccurrences(of: ",\"dup\":true", with: ""), allowMode: true) else { return XCTFail("parse2") }
    XCTAssertFalse(AllowanceText.askIsDup(q))
  }
}
