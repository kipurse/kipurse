import XCTest
@testable import KipurseCore

/// t1253 (decision 122): the phone follows the V5.4 -> V5.5 move only on its own chain checks. Values = the owner's real move
/// (Base block 60955xxx): owner Base Account, seat V2, new wallet, and the phone key registered in the seat.
final class T1253MoveFollowTests: XCTestCase {
  let owner = "0x4242b022A8296cB18B0E0b1Cb9879C518170A718"
  let old = "0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb"
  let nw = "0x4494cEd7F076c523B3Da8e013E6706AC4d9D3aE6"
  let seat = "0x466319B0BC5Fab2b5F0Fa85c498a606C379725f2"
  let xh = "0x7b1581ef5b86eaabab85f3b66183c4ed96943103e1d1cca2e215d5005589b9c5"
  let yh = "0x26a7ca27eddcefa4bac75aec562dff1621390ccb5f1edd87da29a7f79da0db9f"
  var x: [UInt8] { Hex.decode(xh)! }
  var y: [UInt8] { Hex.decode(yh)! }
  let T = "0x" + String(repeating: "0", count: 63) + "1", F = "0x" + String(repeating: "0", count: 64)
  func w(_ a: String) -> String { "0x" + String(repeating: "0", count: 24) + a.lowercased().dropFirst(2) }

  /// A fake chain: (to, data) -> result. Overrides let a test break one fact.
  func chain(_ o: [String: String?] = [:]) -> (MoveFollow.Call, MoveFollow.Code) {
    var m: [String: String?] = [
      nw.lowercased() + "|" + MoveFollow.selIsOwnerAddress + MoveFollow.pad(owner)!: T,
      nw.lowercased() + "|" + MoveFollow.selIsOwnerAddress + MoveFollow.pad(seat)!: T,
      seat.lowercased() + "|" + MoveFollow.selWallet: w(nw),
      seat.lowercased() + "|" + MoveFollow.selX: xh,
      seat.lowercased() + "|" + MoveFollow.selY: yh,
      "code|" + nw.lowercased(): "0x6080", "code|" + seat.lowercased(): "0x6080"]
    for (k, v) in o { m[k] = v }
    let call: MoveFollow.Call = { to, data in (m[to.lowercased() + "|" + data] ?? nil) }
    let code: MoveFollow.Code = { a in (m["code|" + a.lowercased()] ?? nil) }
    return (call, code)
  }

  func testAddressesAreDerivedOnThePhone() {
    XCTAssertEqual(KipurseV55.wallet(owner: owner)?.lowercased(), nw.lowercased())
    XCTAssertEqual(KipurseV55.seat(owner: owner)?.lowercased(), seat.lowercased())
  }
  func testSwitchesWhenTheChainConfirmsEverything() async {
    let (c, k) = chain()
    let t = await MoveFollow.target(current: old, owner: owner, x: x, y: y, call: c, code: k)
    XCTAssertEqual(t?.lowercased(), nw.lowercased())
  }
  func testAlreadyOnTheNewWalletStays() async {
    let (c, k) = chain()
    let t = await MoveFollow.target(current: nw, owner: owner, x: x, y: y, call: c, code: k)
    XCTAssertNil(t)
  }
  func testAnotherPhonesKeyNeverSwitches() async {
    let (c, k) = chain([seat.lowercased() + "|" + MoveFollow.selX: "0x" + String(repeating: "11", count: 32)])
    let t = await MoveFollow.target(current: old, owner: owner, x: x, y: y, call: c, code: k)
    XCTAssertNil(t)
  }
  func testNotDeployedOrUnconfirmedNeverSwitches() async {
    for o in [["code|" + nw.lowercased(): "0x"], ["code|" + seat.lowercased(): nil as String?],
              [nw.lowercased() + "|" + MoveFollow.selIsOwnerAddress + MoveFollow.pad(seat)!: F],
              [nw.lowercased() + "|" + MoveFollow.selIsOwnerAddress + MoveFollow.pad(owner)!: nil],
              [seat.lowercased() + "|" + MoveFollow.selWallet: w(old)]] as [[String: String?]] {
      let (c, k) = chain(o)
      let t = await MoveFollow.target(current: old, owner: owner, x: x, y: y, call: c, code: k)
      XCTAssertNil(t, "\(o)")
    }
  }
  func testAnotherOwnerNeverReachesThisWallet() async {
    let (c, k) = chain()
    let t = await MoveFollow.target(current: old, owner: "0x1000000000000000000000000000000000000003", x: x, y: y, call: c, code: k)
    XCTAssertNil(t)   // different owner -> different predicted wallet, which the fake chain doesn't know
  }
  func testAppWiresItOnlyFromChainChecks() throws {
    let src = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/KipurseCoreTests/T1253MoveFollowTests.swift", with: "App/Sources/AppModel.swift"), encoding: .utf8)
    XCTAssertTrue(src.contains("MoveFollow.target(current:"))
    XCTAssertTrue(src.contains("KipurseSuite.remember(.v55, wallet: nw)"))
  }
}
