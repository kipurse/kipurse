import XCTest
@testable import KipurseCore

/// t1114 (decision 60): the opening fee is charged separately from the user's Base account, on top of the deposit — never "taken from this deposit".
final class T1114FeeNoteTests: XCTestCase {
  private func hasChinese(_ s: String) -> Bool { s.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) || (0x3000...0x303F).contains($0.value) || (0xFF00...0xFFEF).contains($0.value) } }
  func testFeeNoteExactWording() {
    let q = UsdcGas.feeNote(quotedUSDC: "0.064182")
    XCTAssertEqual(q.zh, "开通手续费约 0.064182 USDC（按实际网络费），在充值之外另从你的 Coinbase 钱包（Base 账户）扣，不从这次充值里扣；Kipurse 不出这笔钱。")
    XCTAssertEqual(q.en, "Opening fee about 0.064182 USDC (actual network cost), charged separately from your Coinbase wallet (Base account) on top of your deposit, not taken out of this deposit. Kipurse does not pay it.")
    let w = UsdcGas.feeNote(quotedUSDC: nil)
    XCTAssertEqual(w.zh, "开通手续费按实际网络费，在充值之外另从你的 Coinbase 钱包（Base 账户）扣，不从这次充值里扣；Kipurse 不出这笔钱。")
    XCTAssertEqual(w.en, "Opening fee is the actual network cost, charged separately from your Coinbase wallet (Base account) on top of your deposit, not taken out of this deposit. Kipurse does not pay it.")
    XCTAssertFalse(w.zh.contains("0."), "no invented number before the quote loads")
  }
  func testNoOldDeductedFromDepositClaim() {
    let all = [UsdcGas.feeNote(quotedUSDC: "0.064182"), UsdcGas.feeNote(quotedUSDC: nil)].flatMap { [$0.zh, $0.en] }
      + [UsageGuide.steps[1].detailZh, UsageGuide.steps[1].detailEn, UsageGuide.openingFeeNoticeZh, UsageGuide.openingFeeNoticeEn]
    for s in all {
      XCTAssertFalse(s.contains("从你这次充值里扣") || s.contains("，从这次充值里扣"), s)
      XCTAssertFalse(s.contains(", taken from this deposit") || s.contains("cost from this deposit"), s)
      XCTAssertTrue(s.contains("另从你的 Coinbase 钱包（Base 账户）扣") || s.contains("charged separately from your Coinbase wallet (Base account)"), s)
      for b in ["ETH", "免费", "垫付", "赞助"] { XCTAssertFalse(s.contains(b), "\(b) in \(s)") }
    }
    for s in [UsdcGas.feeNoteEn, UsdcGas.feeNote(quotedUSDC: "0.064182").en, UsageGuide.steps[1].detailEn, UsageGuide.openingFeeNoticeEn] { XCTAssertFalse(hasChinese(s), s) }
  }
  func testOpeningButtonIsBilingualInSource() throws {
    let src = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("App/Sources/MainnetViews.swift"))
    XCTAssertTrue(src.contains(#"T("充值并开通", "Deposit and open")"#))
    XCTAssertTrue(src.contains(#"T("正在准备…", "Preparing…")"#))
    XCTAssertFalse(src.contains(#"L("充值并开通")"#), "L() has no English entry for 充值并开通")
  }
}
