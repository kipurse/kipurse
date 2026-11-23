import XCTest
@testable import KipurseCore

/// t1113u (§6#59): no silent default limits at opening; the opening screen states the least USDC the Base account needs.
final class T1113OpeningTests: XCTestCase {
  let q = Onboard.Quote(.object(["feeUSDC": .string("0.064182"), "gas": .string("4100000"), "signatures": .number(1), "sponsoredByKipurse": .bool(false), "feePaidBy": .string("user_usdc")]))
  func testOpeningNeedsAllThreeLimits() {
    XCTAssertNotNil(q)
    for (s, d, t) in [("", "", ""), ("5", "", ""), ("5", "50", ""), ("", "50", "1500"), ("5", "", "1500")] {
      let e = Mainnet.limitsError(single: s, daily: d, term: t, days: "90")
      XCTAssertNotNil(e, "\(s)/\(d)/\(t)")
      XCTAssertFalse(Onboard.canOpen(quote: q, starting: false, deposit: "5", limitsError: e))
    }
    let ok = Mainnet.limitsError(single: "5", daily: "50", term: "1500", days: "90")
    XCTAssertNil(ok)
    XCTAssertTrue(Onboard.canOpen(quote: q, starting: false, deposit: "5", limitsError: ok))
    XCTAssertFalse(Onboard.canOpen(quote: q, starting: false, deposit: "", limitsError: ok), "deposit still required")
    XCTAssertFalse(Onboard.canOpen(quote: q, starting: true, deposit: "5", limitsError: ok))
    XCTAssertFalse(Onboard.canOpen(quote: nil, starting: false, deposit: "5", limitsError: ok))
  }
  func testNoSilentDefaultPlanInOpeningSource() throws {
    let src = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("App/Sources/MainnetViews.swift"))
    let start = try XCTUnwrap(src.range(of: "struct OnboardView: View")), end = try XCTUnwrap(src.range(of: "@ViewBuilder func done(", range: start.upperBound..<src.endIndex))
    let body = String(src[start.upperBound..<end.lowerBound])
    XCTAssertFalse(body.contains("Beginner.plans(use: .small, spend: .mid)"), "no automatic 一般 plan")
    XCTAssertTrue(body.contains("Onboard.canOpen("))
    XCTAssertTrue(body.contains("Onboard.minBaseNote("))
  }
  func testMinimumBaseAmountMirrorsServer() {
    XCTAssertEqual(Onboard.minBaseAtomic(quoted: "0.064182", deposit: ""), 1_064_182, "fee + 1 USDC app minimum")
    XCTAssertEqual(Onboard.minBaseAtomic(quoted: "0.064182", deposit: "0.5"), 1_064_182, "below minimum deposit -> 1 USDC")
    XCTAssertEqual(Onboard.minBaseAtomic(quoted: "0.064182", deposit: "10"), 10_064_182)
    XCTAssertNil(Onboard.minBaseAtomic(quoted: nil, deposit: "10"))
    let n = Onboard.minBaseNoteText(quoted: "0.064182", deposit: "")
    XCTAssertEqual(n.zh, "开户时你的 Coinbase 钱包（Base 账户）里至少要有约 1.064182 USDC：开通手续费约 0.064182 USDC（含首次钱包安全上限和 Face ID 钥匙）+ 充值 1 USDC（最少 1 USDC）。")
    XCTAssertEqual(n.en, "At opening your Coinbase wallet (Base account) needs at least about 1.064182 USDC: opening fee about 0.064182 USDC (includes the first wallet safety limits and the Face ID key) + deposit 1 USDC (minimum 1 USDC).")
    let w = Onboard.minBaseNoteText(quoted: nil, deposit: "")
    XCTAssertFalse(w.zh.contains("0."), "no invented number before the quote loads"); XCTAssertFalse(w.en.contains("ETH"))
    for s in [n.zh, n.en, w.zh, w.en] { XCTAssertFalse(s.contains("ETH")); XCTAssertFalse(s.contains("免费")) }
    XCTAssertFalse(n.en.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) })
  }
}
