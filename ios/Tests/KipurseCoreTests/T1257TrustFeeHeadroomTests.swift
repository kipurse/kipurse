import XCTest
@testable import KipurseCore

/// t1257 (decision 126): the owner's real case — AI limits 1000 / 1000, the gateway's trust 1000 per payment / 1001 per day
/// (daily + 0.1% fee headroom, because the chain counts amount + fee per day). It must pass; anything above the headroom must not.
final class T1257TrustFeeHeadroomTests: XCTestCase {
  func msg(_ s: String, _ d: String) -> OwnerTrustMessage {
    OwnerTrustMessage(account: "0x4494cEd7F076c523B3Da8e013E6706AC4d9D3aE6", merchant: "0x" + String(repeating: "11", count: 32), name: "Kipurse Test Shop", epoch: "0",
                      payees: ["0x1768000000000000000000000000000000e9fb00"], signers: [], single: s, daily: d, expiry: "1", nonce: "0x" + String(repeating: "22", count: 32), deadline: "1")
  }
  let ceil = (single: Int64(1_000_000_000), daily: Int64(1_000_000_000))
  func testOwnersRealCasePasses() { XCTAssertEqual(OwnerAsk.trustCapProblems(msg("1000000000", "1001000000"), ceiling: ceil), []) }
  func testAboveHeadroomStillRefused() {
    XCTAssertFalse(OwnerAsk.trustCapProblems(msg("1000000000", "1001000001"), ceiling: ceil).isEmpty)
    XCTAssertFalse(OwnerAsk.trustCapProblems(msg("1000000001", "1001000000"), ceiling: ceil).isEmpty)   // per payment: no headroom
  }
  func testSameFormulaAsGateway() {
    XCTAssertEqual(OwnerAsk.dailyWithFeeHeadroom(20_000_000), 20_020_000)   // default 20 USDC -> 20.02
    XCTAssertEqual(OwnerAsk.dailyWithFeeHeadroom(1), 2)                      // ceil, like withFeeHeadroom
    XCTAssertEqual(OwnerAsk.dailyWithFeeHeadroom(0), 0)
  }
}
