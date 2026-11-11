import XCTest
@testable import KipurseCore

/// t1104: the ACTUAL live /owner/limits/prepare reply for the owner's Kipurse wallet 0x7398 (1000 / 3000 / 50000 USDC, 365 days),
/// fetched read-only 2026-11-10 22:27 CST, fed to the App's real check (RequestVerify.limitsPrepared, the function MainnetViews calls).
final class T1104LivePrepareTests: XCTestCase {
  let wallet = "0x7398CB7f7654ae8B06E9706d5aB31c92f91E39B6", owner = "0xD88af8e8A56fb6F5F630e1fF1C61030207C9A718"
  let choice = RequestVerify.Choice(single: "1000000000", daily: "3000000000", term: "50000000000", days: 365)
  let at = Date(timeIntervalSince1970: 1_794_371_300)   // 2026-11-11 04:28:20 UTC, just after the plan was made
  func live() throws -> [String: Any] {
    let f = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("t1104-prepare-live-0x7398.json.txt")
    return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: f)) as? [String: Any])
  }
  func testLiveWalletPaysBatchPassesTheAppCheck() throws {
    let j = try live(); let calls = try XCTUnwrap(j["calls"] as? [[String: Any]])
    XCTAssertEqual(j["feeFrom"] as? String, UsdcGas.feeFrom); XCTAssertEqual((j["wallet"] as? String)?.lowercased(), wallet.lowercased())
    XCTAssertEqual(calls.count, 2)
    let r = RequestVerify.limitsPrepared(calls: calls, wallet: wallet, chainId: j["chainId"] as? Int ?? 0, choice: choice, owner: owner, walletPays: true, now: at)
    XCTAssertTrue(r.ok, r.problems.joined(separator: "; "))
    // the sign page's #vh: from = the Kipurse wallet, all calls exactly as sent (verified against limits.v2.js kpVHCanon in node)
    let from = UsdcGas.limitsSender(owner: owner, wallet: j["wallet"] as! String, fromWallet: true)
    XCTAssertEqual(BatchVerify.commitment(chainId: 8453, from: from, calls: calls), "276561e0a98e3716a8a0b28a2566172bd949091bb58a744d05985d8c35b2a831" as String?)
  }
  func testBuild50PathReproducesTheOwnersStop() throws {
    let calls = try XCTUnwrap(try live()["calls"] as? [[String: Any]])
    XCTAssertEqual(UsdcGas.split(calls, wallet: wallet).problems, ["USDC approval is not for the Coinbase fee paymaster or is above 0.25 USDC"])
    // the same batch WITHOUT feeFrom=kipurse_wallet keeps the old rules and is still refused
    XCTAssertFalse(RequestVerify.limitsPrepared(calls: calls, wallet: wallet, chainId: 8453, choice: choice, owner: owner, walletPays: false, now: at).ok)
  }
  func approve(_ spender: String, _ amount: UInt64) -> [String: Any] {
    ["to": RequestVerify.usdc, "value": "0x0", "data": "0x095ea7b3" + String(repeating: "0", count: 24) + spender.lowercased().dropFirst(2) + String(format: "%064llx", amount)]
  }
  func testWalletPaysStillRefusesAnythingElse() throws {
    let calls = try XCTUnwrap(try live()["calls"] as? [[String: Any]]); let cap = calls[1]
    let ok = { (c: [[String: Any]]) in RequestVerify.limitsPrepared(calls: c, wallet: self.wallet, chainId: 8453, choice: self.choice, owner: self.owner, walletPays: true, now: self.at).ok }
    XCTAssertTrue(ok([approve(UsdcGas.erc20Paymaster, 50_000), cap]))
    XCTAssertTrue(ok([approve("0x6666666666667849C56F2850848CE1C4DA65C68B", 1), cap]), "address case does not matter")
    XCTAssertFalse(ok([approve(UsdcGas.erc20Paymaster, 50_001), cap]), "above 0.05 USDC")
    XCTAssertFalse(ok([approve(UsdcGas.erc20Paymaster, 0), cap]), "zero")
    XCTAssertFalse(ok([approve(UsdcGas.paymaster, 8271), cap]), "CDP paymaster is not the wallet-pays spender")
    XCTAssertFalse(ok([approve("0x000000000000000000000000000000000000dEaD", 8271), cap]))
    XCTAssertFalse(ok([cap, calls[0]]), "order")
    XCTAssertFalse(ok([cap]), "approve missing"); XCTAssertFalse(ok(calls + [calls[0]]), "extra call")
    var eth = calls[0]; eth["value"] = "0x1"; XCTAssertFalse(ok([eth, cap]), "sends ETH")
    let other = RequestVerify.Choice(single: "1000000000", daily: "3000000000", term: "60000000000", days: 365)
    XCTAssertFalse(RequestVerify.limitsPrepared(calls: calls, wallet: wallet, chainId: 8453, choice: other, owner: owner, walletPays: true, now: at).ok, "caps must match the choice")
    XCTAssertFalse(RequestVerify.limitsPrepared(calls: calls, wallet: "0x000000000000000000000000000000000000dEaD", chainId: 8453, choice: choice, owner: owner, walletPays: true, now: at).ok, "other wallet")
  }
  func testOldApproveRuleUnchanged() {
    let w = "0x1111111111111111111111111111111111111111"
    XCTAssertTrue(UsdcGas.split([approve(UsdcGas.paymaster, 250_000)], wallet: w).problems.isEmpty)
    XCTAssertFalse(UsdcGas.split([approve(UsdcGas.paymaster, 250_001)], wallet: w).problems.isEmpty)
    XCTAssertFalse(UsdcGas.split([approve(UsdcGas.erc20Paymaster, 8271)], wallet: w).problems.isEmpty, "Pimlico approve only on the wallet-pays path")
  }
}
