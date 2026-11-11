import XCTest
@testable import KipurseCore

/// t906: the Face ID enrollment fee is paid by the Kipurse wallet (USDC) to the fixed Kipurse ops address while gas is sponsored.
/// The Coinbase wallet only signs. The fee recipient may be the owner (old flow) or RequestVerify.duesTo, nobody else, max 0.05 USDC, once.
final class EnrollWalletPaysT906Tests: XCTestCase {
  var v: [String: Any] = [:]
  override func setUp() { v = (try? JSONSerialization.jsonObject(with: Data(BatchVectors.json.utf8))) as? [String: Any] ?? [:] }
  func calls(_ k: String) -> [[String: Any]] { (v[k] as? [[String: Any]]) ?? [] }
  var owner: String { v["owner"] as! String }; var wallet: String { v["wallet"] as! String }
  var x: [UInt8] { Hex.decode(v["x"] as! String)! }; var y: [UInt8] { Hex.decode(v["y"] as! String)! }
  func swapFee(_ c: [[String: Any]], to rcpt: String) -> [[String: Any]] {
    let o = String(owner.lowercased().dropFirst(2)), r = String(rcpt.lowercased().dropFirst(2))
    return c.map { var m = $0; if let d = (m["data"] as? String)?.lowercased(), d.hasPrefix("0xb61d27f6") { m["data"] = d.replacingOccurrences(of: o, with: r) }; return m }
  }
  func feeCall(_ c: [[String: Any]]) -> [String: Any]? { c.first { (($0["data"] as? String)?.lowercased().hasPrefix("0xb61d27f6")) ?? false } }
  func testFeeToKipurseOpsAccepted() {
    let base = calls("enroll"); XCTAssertNotNil(feeCall(base), "vector has a fee step")
    let r = BatchVerify.enroll(calls: swapFee(base, to: RequestVerify.duesTo), wallet: wallet, owner: owner, x: x, y: y); XCTAssertTrue(r.ok, r.problems.joined(separator: "; "))
  }
  func testFeeToAnyoneElseRejected() {
    let r = BatchVerify.enroll(calls: swapFee(calls("enroll"), to: "0x" + String(repeating: "5", count: 40)), wallet: wallet, owner: owner, x: x, y: y)
    XCTAssertFalse(r.ok); XCTAssertTrue(r.problems.contains("fee refund goes to someone else"), r.problems.joined(separator: "; "))
  }
  func testTwoFeePaymentsRejected() {
    var c = swapFee(calls("enroll"), to: RequestVerify.duesTo); c.append(feeCall(c)!)
    let r = BatchVerify.enroll(calls: c, wallet: wallet, owner: owner, x: x, y: y); XCTAssertFalse(r.ok); XCTAssertTrue(r.problems.contains("more than one fee payment"))
  }
  func testOtherFlowsStillOwnerOnly() {
    XCTAssertNotNil(RequestVerify.feeRefundProblem(feeCall(swapFee(calls("enroll"), to: RequestVerify.duesTo))!, wallet: wallet, owner: owner), "limits/setup refunds stay owner-only")
  }
  func testSignSetIsV9() { XCTAssertEqual(SignHost.setPrefix, "/v9"); XCTAssertEqual(SignHost.previousPrefix, "/v8") }
}
