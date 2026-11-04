import XCTest
@testable import KipurseCore

/// t821: server-free rescue. Expected calldata = `cast calldata` output (Foundry) for the same inputs; the same bytes were
/// executed on a local fork of Base mainnet (anvil, block 53312124) from the Coinbase wallet owner: success, all USDC to the owner.
final class T821RescueTests: XCTestCase {
  let W = "0x1111111111111111111111111111111111111111", V = "0x2222222222222222222222222222222222222222", O = "0x3333333333333333333333333333333333333333"
  let castTwo = "0x34fcd5be00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000435faa41600000000000000000000000000000000000000000000000000000000000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000007a120000000000000000000000000000000000000000000000000000000000"
  let castThree = "0x34fcd5be000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000001c000000000000000000000000005320bed08309f66316f7d73e2d0be110400fbb20000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000242847ba43000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000435faa41600000000000000000000000000000000000000000000000000000000000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000007a120000000000000000000000000000000000000000000000000000000000"
  let castStop = "0x89625b57000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000020000000000000000000000000f85210b21cc50302f477ba56686d2019dc9b67ad"

  func testPlanMatchesFoundryAndForkRun() throws {
    let b = ChainRescue.Balances(wallet: 3_000_000, vault: 5_000_000, vaultAddress: V)
    let p = try ChainRescue.plan(wallet: W, owner: O, recordedOwner: O, b: b)
    XCTAssertEqual(p.amount, 8_000_000); XCTAssertEqual(p.call.to, W); XCTAssertEqual(p.call.data, castTwo)
  }
  func testPlanWithFloat() throws {
    let b = ChainRescue.Balances(wallet: 3_000_000, vault: 4_000_000, float: 1_000_000, vaultAddress: V, floatAddress: "0xf9ba29c95f7218adf91ff0af18f877d92568bf53")
    XCTAssertEqual(try ChainRescue.plan(wallet: W, owner: O, recordedOwner: nil, b: b).call.data, castThree)
  }
  func testDestinationIsLockedToOwner() {
    let b = ChainRescue.Balances(wallet: 1, vault: 0)
    XCTAssertThrowsError(try ChainRescue.plan(wallet: W, owner: "0x1111111111111111111111111111111111111111", recordedOwner: O, b: b)) { XCTAssertEqual($0 as? ChainRescue.Refusal, .notYourAccount) }
    XCTAssertThrowsError(try ChainRescue.plan(wallet: W, owner: W, recordedOwner: nil, b: b))
    XCTAssertThrowsError(try ChainRescue.plan(wallet: W, owner: "0x12", recordedOwner: nil, b: b))
    XCTAssertThrowsError(try ChainRescue.plan(wallet: W, owner: O, recordedOwner: O, b: ChainRescue.Balances(wallet: 0, vault: 0))) { XCTAssertEqual($0 as? ChainRescue.Refusal, .nothingToTake) }
  }
  func testReservedStaysAndIsExplained() throws {
    let b = ChainRescue.Balances(wallet: 1_000_000, vault: 2_000_000, vaultReserved: 500_000, vaultAddress: V)
    XCTAssertEqual(b.total, 3_000_000); XCTAssertEqual(b.takeNow, 2_500_000); XCTAssertEqual(b.pending, 500_000)
    XCTAssertEqual(try ChainRescue.plan(wallet: W, owner: O, recordedOwner: O, b: b).amount, 2_500_000)
  }
  func testStopAIMatchesFoundry() { XCTAssertEqual(ChainRescue.stopAI(wallet: W, spmIndex: 1)?.data, castStop) }
  func testPreviewPlainWords() throws {
    let p = try ChainRescue.plan(wallet: W, owner: O, recordedOwner: O, b: ChainRescue.Balances(wallet: 3_000_000, vault: 5_000_000, vaultAddress: V))
    let s = ChainRescue.preview(p).joined(separator: "\n")
    XCTAssertTrue(s.contains("8") && s.contains("0x3333"), s); XCTAssertFalse(s.contains("0x34fcd5be"))
  }
  func testRPCFailoverAndAgreement() async {
    let a = URL(string: "https://a.example")!, b = URL(string: "https://b.example")!, c = URL(string: "https://c.example")!
    let saved = ChainRPC.transport; defer { ChainRPC.transport = saved }
    ChainRPC.transport = { u, _, _ in if u == a { throw URLError(.cannotConnectToHost) }; return u == b ? "0x01" : "0x01" }
    let v = try? await ChainRPC.call("eth_call", [], nodes: [a, b, c]); XCTAssertEqual(v, "0x01")
    let g = await ChainRPC.agreed("eth_call", [], nodes: [a, b, c]); XCTAssertEqual(g, "0x01")
    ChainRPC.transport = { u, _, _ in u == b ? "0x01" : "0x02" }
    let bad = await ChainRPC.agreed("eth_call", [], nodes: [b, c]); XCTAssertNil(bad, "two nodes disagree -> show nothing")
    ChainRPC.transport = { _, _, _ in throw URLError(.timedOut) }
    let none = await ChainRPC.agreed("eth_call", [], nodes: [a, b]); XCTAssertNil(none)
  }
  func testNodeOrder() {
    let n = ChainRPC.nodes.map(\.host!)
    XCTAssertTrue(n.contains("base-rpc.publicnode.com") && n.contains("base.llamarpc.com"))
    XCTAssertEqual(Set(n).count, n.count)
    XCTAssertLessThan(n.firstIndex(of: "base-rpc.publicnode.com")!, n.firstIndex(of: "base.llamarpc.com")!)
  }
  func testSwitchesDefaultOn() { for f in FeatureSwitch.allCases { XCTAssertTrue(f.on, f.rawValue) } }
}
