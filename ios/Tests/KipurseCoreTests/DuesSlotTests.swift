import XCTest
@testable import KipurseCore

/// t767u: new-wallet setup may end with vault.setBundlerFee(Kipurse ops, <= 0.05 USDC). Vectors come from the server builder.
final class DuesSlotTests: XCTestCase {
  var v: [String: Any] = [:]
  override func setUp() { v = (try? JSONSerialization.jsonObject(with: Data(BatchVectors.json.utf8))) as? [String: Any] ?? [:] }
  var d: [String: Any] { v["dues"] as! [String: Any] }
  func cl(_ a: Any?) -> [[String: Any]] { (a as? [[String: Any]]) ?? [] }
  var choice: RequestVerify.Choice { let c = v["choice"] as! [String: Any]; return .init(single: c["single"] as! String, daily: c["daily"] as! String, term: c["term"] as! String, days: c["days"] as? Int) }
  func setup(_ c: [[String: Any]], vault: String?) -> BatchVerify.Report {
    BatchVerify.setup(calls: c, wallet: v["wallet"] as! String, owner: v["owner"] as! String, x: Hex.decode(v["x"] as! String)!, y: Hex.decode(v["y"] as! String)!, choice: choice, newWallet: true, vault: vault, now: Date(timeIntervalSince1970: 1_798_000_000)) }
  func testDuesSetupAcceptedAndShown() {
    let r = setup(cl(d["setupNewDues"]), vault: d["vault"] as? String); XCTAssertTrue(r.ok, r.problems.joined(separator: "; "))
    XCTAssertTrue(r.notes.contains { $0.contains("0.05 USDC") }) }
  func testDuesNeedsVault() { XCTAssertFalse(setup(cl(d["setupNewDues"]), vault: nil).ok) }
  func testDuesTamperingRejected() {
    for (k, c) in d["tampered"] as! [String: Any] { XCTAssertFalse(setup(cl(c), vault: d["vault"] as? String).ok, k) } }
  func testOldSetupStillAccepted() { XCTAssertTrue(setup(cl(v["setupNew"]), vault: d["vault"] as? String).ok) }
}
