import XCTest
@testable import KipurseCore

/// t1185 (decision 85): daily on-chain operations - vault computed on the phone, setOpsPerDay accepted only to YOUR vault with YOUR number.
final class OpsCapTests: XCTestCase {
  let adapter53 = "0xb150030be35903AdEE466d7733Bf0841B667033C"
  func vec() throws -> [String: Any] {
    let u = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("t1185-ops-vector.json.txt")
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: u)) as? [String: Any]) }
  func calls(_ v: [String: Any], _ k: String) -> [[String: Any]] { let b = v[k] as! [String: Any]; return [["to": b["to"]!, "value": "0x0", "data": b["data"]!]] }
  func choice(_ ops: Int?) -> RequestVerify.Choice { RequestVerify.Choice(single: "5000000", daily: "10000000", term: "50000000", days: 30, opsPerDay: ops) }
  func now(_ v: [String: Any]) -> Date { Date(timeIntervalSince1970: Double(v["start"] as! Int) + 60) }

  func testVaultAddressComputedOnPhoneMatchesTheFactory() throws {
    let v = try vec()
    XCTAssertEqual(OpsCap.vault(wallet: v["wallet"] as! String), (v["vault"] as! String).lowercased())   // = adapter.vaultAddress on the fork rehearsal
  }
  func testAcceptsYourNumberToYourVault() throws {
    let v = try vec(); let r = RequestVerify.limitsBatch(calls: calls(v, "withOps"), wallet: v["wallet"] as! String, chainId: 8453, choice: choice(800), currentExecutor: nil, adapter: adapter53, now: now(v))
    XCTAssertTrue(r.ok, r.problems.joined(separator: "; ")); XCTAssertTrue(r.notes.contains { $0.contains("800") })
  }
  func testRefusesAnotherNumber() throws {
    let v = try vec(); let r = RequestVerify.limitsBatch(calls: calls(v, "withOps"), wallet: v["wallet"] as! String, chainId: 8453, choice: choice(500), currentExecutor: nil, adapter: adapter53, now: now(v))
    XCTAssertFalse(r.ok); XCTAssertTrue(r.problems.contains("daily operations differ from your choice"))
  }
  func testRefusesWhenYouDidNotChangeIt() throws {
    let v = try vec(); let r = RequestVerify.limitsBatch(calls: calls(v, "withOps"), wallet: v["wallet"] as! String, chainId: 8453, choice: choice(nil), currentExecutor: nil, adapter: adapter53, now: now(v))
    XCTAssertFalse(r.ok)
  }
  func testRefusesAnotherTarget() throws {
    let v = try vec(); let r = RequestVerify.limitsBatch(calls: calls(v, "otherVault"), wallet: v["wallet"] as! String, chainId: 8453, choice: choice(800), currentExecutor: nil, adapter: adapter53, now: now(v))
    XCTAssertFalse(r.ok); XCTAssertTrue(r.problems.contains("daily-operations step targets something other than your vault"))
  }
  func testRefusesMissingStep() throws {
    let v = try vec(); let r = RequestVerify.limitsBatch(calls: calls(v, "noOps"), wallet: v["wallet"] as! String, chainId: 8453, choice: choice(800), currentExecutor: nil, adapter: adapter53, now: now(v))
    XCTAssertFalse(r.ok)
  }
  func testNoOpsBatchUnchanged() throws {
    let v = try vec(); let r = RequestVerify.limitsBatch(calls: calls(v, "noOps"), wallet: v["wallet"] as! String, chainId: 8453, choice: choice(nil), currentExecutor: nil, adapter: adapter53, now: now(v))
    XCTAssertTrue(r.ok, r.problems.joined(separator: "; "))
  }
  func testParseAndState() {
    XCTAssertEqual(OpsCap.parse("500"), 500); XCTAssertNil(OpsCap.parse("0")); XCTAssertNil(OpsCap.parse("100001")); XCTAssertNil(OpsCap.parse("2.5")); XCTAssertNil(OpsCap.parse(""))
    XCTAssertEqual(OpsCap.parse("100000"), 100000); XCTAssertEqual(OpsCap.defaultPerDay, 500)
    let s = OpsCap.state(.object(["ops": .object(["supported": .bool(true), "perDayCount": .string("500"), "usedTodayCount": .string("37"), "leftCount": .string("463"), "resetsAt": .string("2026-11-19T00:00:00.000Z")])]))
    XCTAssertEqual(s?.perDay, 500); XCTAssertEqual(s?.used, 37); XCTAssertEqual(s?.left, 463); XCTAssertNotNil(s?.resetsAt)
    XCTAssertNil(OpsCap.state(.object(["ops": .object(["supported": .bool(false)])])), "older vault: row hidden")
    XCTAssertNil(OpsCap.state(.object([:])))
  }
  func testCalmWords() {
    for t in [OpsCap.explainZh, OpsCap.explainEn] { XCTAssertNil(t.range(of: "失败|错误|危险|被盗|攻击|error|fail|danger|attack|stolen", options: [.regularExpression, .caseInsensitive])) }
  }
}
