import XCTest
@testable import KipurseCore

/// t1185 (decision 86): opening moves 0.15 USDC of the owner's own money into his wallet's fee reserve (vault), last step, once.
final class T1186VaultSeedTests: XCTestCase {
  let W = "0x0eBd05A4a2226a59790600a54129f4b0E90fC817", v53 = "0xe635ab8852c3cb3b2125d3cb45018657ef73946b", v52 = "0x5d0136641655ad46eff24b243c3555a714f4317b"
  func transfer(_ to: String, _ amt: UInt64) -> [String: Any] {
    let a = String(to.lowercased().dropFirst(2)); let v = String(amt, radix: 16)
    return ["to": UsdcGas.usdc, "value": "0x0", "data": "0xa9059cbb" + String(repeating: "0", count: 24) + a + String(repeating: "0", count: 64 - v.count) + v] }
  let other: [String: Any] = ["to": "0x0ebd05a4a2226a59790600a54129f4b0e90fc817", "value": "0x0", "data": "0x12345678"]
  func testPhoneComputesBothSuites() {   // V5.3 = fork adapter.vaultAddress; V5.2 = live Base adapter 0x0532…FbB2 vaultAddress (read 2026-11-18)
    XCTAssertEqual(UsdcGas.vaults(wallet: W), [v52, v53]) }
  func testSeedAcceptedLastOnce() {
    for v in [v52, v53] { let s = UsdcGas.split([transfer(UsdcGas.feeTo, 60_000), other, transfer(v, 150_000)], wallet: W, vault: v)
      XCTAssertEqual(s.problems, []); XCTAssertEqual(s.vaultSeed, 150_000); XCTAssertEqual(s.feeRepaid, 60_000); XCTAssertEqual(s.rest.count, 1) } }
  func testSeedRefused() {
    let x = "0x2222222222222222222222222222222222222222"
    XCTAssertFalse(UsdcGas.split([transfer(UsdcGas.feeTo, 60_000), other, transfer(x, 150_000)], wallet: W, vault: x).problems.isEmpty, "not this wallet's vault")
    XCTAssertFalse(UsdcGas.split([transfer(UsdcGas.feeTo, 60_000), other, transfer(v53, 150_000)], wallet: W, vault: v52).problems.isEmpty, "not the server's vault")
    XCTAssertFalse(UsdcGas.split([transfer(UsdcGas.feeTo, 60_000), other, transfer(v53, 150_000)], wallet: W, vault: nil).problems.isEmpty, "no vault known")
    XCTAssertFalse(UsdcGas.split([transfer(UsdcGas.feeTo, 60_000), other, transfer(v53, 250_000)], wallet: W, vault: v53).problems.isEmpty, "above 0.20")
    XCTAssertFalse(UsdcGas.split([transfer(UsdcGas.feeTo, 60_000), other, transfer(v53, 50_000)], wallet: W, vault: v53).problems.isEmpty, "below 0.10")
    XCTAssertFalse(UsdcGas.split([transfer(UsdcGas.feeTo, 60_000), other, transfer(v53, 150_000), other], wallet: W, vault: v53).problems.isEmpty, "not last")
    XCTAssertFalse(UsdcGas.split([transfer(UsdcGas.feeTo, 60_000), other, transfer(v53, 150_000), transfer(v53, 150_000)], wallet: W, vault: v53).problems.isEmpty, "twice")
  }
  func testNoSeedStillFine() { let s = UsdcGas.split([transfer(UsdcGas.feeTo, 60_000), other], wallet: W, vault: v53); XCTAssertEqual(s.problems, []); XCTAssertEqual(s.vaultSeed, 0) }
  func testQuoteAndTexts() {
    let q = Onboard.Quote(.object(["feeUSDC": .string("0.064182"), "gas": .string("4100000"), "feePaidBy": .string("user_usdc"), "signatures": .string("1"), "vaultSeedUSDC": .string("150000")]))
    XCTAssertEqual(q?.vaultSeed, 150_000)
    XCTAssertNil(Onboard.Quote(.object(["feeUSDC": .string("0.06"), "gas": .string("1"), "vaultSeedUSDC": .string("900000")]))?.vaultSeed, "outside 0.10..0.20 is never shown")
    let n = UsdcGas.feeNote(quotedUSDC: "0.064182", seed: 150_000)
    XCTAssertTrue(n.zh.hasSuffix("另放 0.15 USDC 到你钱包的手续费备用金，用来付 AI 付款的手续费。钱还是你的，取回时一起退给你。"), n.zh)
    XCTAssertTrue(n.en.hasSuffix("Plus 0.15 USDC into your wallet's fee reserve to cover network fees for AI payments. It is still your money and comes back when you withdraw."), n.en)
    XCTAssertEqual(UsdcGas.feeNote(quotedUSDC: "0.064182", seed: nil).zh, UsdcGas.feeNote(quotedUSDC: "0.064182").zh, "older server: unchanged")
    XCTAssertEqual(Onboard.minBaseAtomic(quoted: "0.064182", deposit: "5", seed: 150_000), 5_214_182)
    let m = Onboard.minBaseNoteText(quoted: "0.064182", deposit: "5", seed: 150_000)
    XCTAssertTrue(m.zh.contains("至少要有约 5.214182 USDC") && m.zh.contains("手续费备用金 0.15 USDC（还是你的钱）"), m.zh)
    XCTAssertEqual(Onboard.minBaseNoteText(quoted: "0.064182", deposit: "5", seed: nil).zh, Onboard.minBaseNoteText(quoted: "0.064182", deposit: "5").zh)
    for t in [n.zh, n.en, m.zh, m.en] { XCTAssertNil(t.range(of: "失败|错误|危险|被盗|攻击|error|fail|danger|attack|stolen|ETH", options: [.regularExpression, .caseInsensitive]), t) }
  }
}
