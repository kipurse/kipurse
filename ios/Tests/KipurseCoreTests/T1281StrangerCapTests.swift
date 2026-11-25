// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import KipurseCore

/// t1281 (owner decision decision 141 (1)): the stranger sub-limit is the owner's own choice ([zh] ___, default = the
/// normal limits). The phone computes the SAME formula as the server (owner rule 0A#10): every vector in t1281-stranger-caps.json.txt
/// (written by gw test/t1281-stranger-cap.test.mjs from the server's subCaps) must give exactly the server's result here.
final class T1281StrangerCapTests: XCTestCase {
  static func file(_ n: String) -> URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent(n) }
  func json(_ n: String) throws -> [String: Any] { try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.file(n))) as? [String: Any]) }
  /// A 12-word policy around the given base sub-caps (only [5]...[8] matter for subCaps).
  static func base(_ b: [String: String]) -> [String] { ["", RequestVerify.zeroAddress, "", "", "", b["openSingle"]!, b["openDaily"]!, b["verifiedSingle"]!, b["verifiedDaily"]!, RequestVerify.merchantRegistry, "1000", "50000"] }

  func testCrossTestWithServerVectors() throws {
    let vs = try XCTUnwrap(json("t1281-stranger-caps.json.txt")["vectors"] as? [[String: Any]])
    XCTAssertGreaterThanOrEqual(vs.count, 18)
    var kinds = Set<String>()
    for v in vs {
      let name = v["name"] as? String ?? "?", b = try XCTUnwrap(v["base"] as? [String: String]), c = try XCTUnwrap(v["choice"] as? [String: String]), server = try XCTUnwrap(v["server"] as? [String: String])
      XCTAssertEqual(server, v["expect"] as? [String: String], "fixture is internally consistent: \(name)")
      let r = RequestVerify.subCaps(single: c["single"]!, daily: c["daily"]!, openSingle: c["openSingle"], openDaily: c["openDaily"], base: Self.base(b))
      if let e = server["error"] {
        XCTAssertNil(r.caps, name); XCTAssertEqual(r.error, e, name); kinds.insert(e)
        XCTAssertEqual(RequestVerify.strangerChoiceError(single: c["single"]!, daily: c["daily"]!, openSingle: c["openSingle"], openDaily: c["openDaily"]), e, name)
      } else {
        XCTAssertNil(r.error, name)
        XCTAssertEqual(r.caps, RequestVerify.SubCaps(openSingle: server["openSingle"]!, openDaily: server["openDaily"]!, verifiedSingle: server["verifiedSingle"]!, verifiedDaily: server["verifiedDaily"]!), name)
        kinds.insert(c["openSingle"] == nil ? "legacy" : "explicit")
      }
    }
    for k in ["legacy", "explicit", "stranger_single_above_single", "stranger_daily_above_daily", "stranger_single_zero", "stranger_daily_zero", "stranger_single_above_stranger_daily", "stranger_incomplete", "bad_stranger_amount"] {
      XCTAssertTrue(kinds.contains(k), "vector kind \(k) covered") }
  }

  // MARK: policyProblems with an explicit owner choice
  let tpl = RequestVerify.templatePolicy
  func pol(_ f: (inout [String]) -> Void) -> [String] { var p = ["0x" + String(repeating: "1", count: 40)] + Array(tpl.dropFirst()); p[2] = "5000000"; p[3] = "20000000"; p[4] = "100000000"; f(&p); return p }

  func testExplicitMustBeExactlyTheOwnersNumbers() {
    // default "same as normal": open = main
    let same = pol { $0[5] = "5000000"; $0[6] = "20000000" }
    XCTAssertEqual(RequestVerify.policyProblems(same, old: nil, single: "5000000", daily: "20000000", openSingle: "5000000", openDaily: "20000000"), [])
    // the legacy template value is NOT accepted when the owner chose something else (an older formula can't sneak in)
    XCTAssertEqual(RequestVerify.policyProblems(pol { _ in }, old: nil, single: "5000000", daily: "20000000", openSingle: "5000000", openDaily: "20000000"), ["the limits for new payees differ from what you chose"])
    // custom lower
    XCTAssertEqual(RequestVerify.policyProblems(pol { $0[5] = "1000000"; $0[6] = "3000000" }, old: nil, single: "5000000", daily: "20000000", openSingle: "1000000", openDaily: "3000000"), [])
    XCTAssertFalse(RequestVerify.policyProblems(pol { $0[5] = "1000001"; $0[6] = "3000000" }, old: nil, single: "5000000", daily: "20000000", openSingle: "1000000", openDaily: "3000000").isEmpty)
    // limit change: an explicit raise above the old stranger caps (the old min() ratchet) is exactly what the owner chose
    let old = pol { _ in }
    XCTAssertEqual(RequestVerify.policyProblems(pol { $0[2] = "50000000"; $0[3] = "100000000"; $0[5] = "20000000"; $0[6] = "60000000"; $0[7] = "2000000"; $0[8] = "5005000" }, old: old, single: "50000000", daily: "100000000", openSingle: "20000000", openDaily: "60000000"), [])
    // verified sub-caps stay the server formula min(base, choice)
    XCTAssertFalse(RequestVerify.policyProblems(pol { $0[5] = "5000000"; $0[6] = "20000000"; $0[7] = "5000000" }, old: nil, single: "5000000", daily: "20000000", openSingle: "5000000", openDaily: "20000000").isEmpty)
    // an invalid owner choice is refused, never clamped
    XCTAssertEqual(RequestVerify.policyProblems(pol { $0[5] = "5000000"; $0[6] = "20000000" }, old: nil, single: "5000000", daily: "20000000", openSingle: "5000001", openDaily: "20000000"), ["your limits for new payees are not valid (stranger_single_above_single)"])
    // the contract rule on the policy itself: stranger words never above the main words
    XCTAssertTrue(RequestVerify.policyProblems(pol { $0[5] = "6000000"; $0[6] = "20000000" }, old: nil, single: "5000000", daily: "20000000", openSingle: "6000000", openDaily: "20000000").contains("a limit for new payees is above your main limit"))
    // legacy (no explicit values): exactly the T1280 behaviour
    XCTAssertEqual(RequestVerify.policyProblems(pol { _ in }, old: nil, single: "5000000", daily: "20000000"), [])
    XCTAssertEqual(RequestVerify.policyProblems(pol { $0[5] = "5000000"; $0[6] = "20000000" }, old: nil, single: "5000000", daily: "20000000"), ["a sub-cap differs from Kipurse's standard sub-caps"])
  }

  func testAppValidationMirrorsTheServer() {
    XCTAssertNil(Mainnet.strangerError(single: "5", daily: "20", openSingle: "5", openDaily: "20"))
    XCTAssertNil(Mainnet.strangerError(single: "5", daily: "20", openSingle: "0.1", openDaily: "0.2002"))
    XCTAssertNotNil(Mainnet.strangerError(single: "5", daily: "20", openSingle: "6", openDaily: "20"))
    XCTAssertNotNil(Mainnet.strangerError(single: "5", daily: "20", openSingle: "1", openDaily: "21"))
    XCTAssertNotNil(Mainnet.strangerError(single: "5", daily: "20", openSingle: "0", openDaily: "1"))
    XCTAssertNotNil(Mainnet.strangerError(single: "5", daily: "20", openSingle: "3", openDaily: "2"))
    XCTAssertNotNil(Mainnet.strangerError(single: "5", daily: "20", openSingle: "", openDaily: "2"))
    // the signing page shows them; nil keeps the URL exactly as before
    XCTAssertFalse(Mainnet.limitsURL(single: "2", daily: "5", term: "50", days: "90")?.absoluteString.contains("open") ?? true)
    XCTAssertTrue(Mainnet.limitsURL(single: "2", daily: "5", term: "50", days: "90", openSingle: "0.5", openDaily: "2")?.absoluteString.hasSuffix("&openSingle=0.5&openDaily=2") ?? false)
  }
}
