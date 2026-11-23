import XCTest
@testable import KipurseCore
/// t1125u (handbook §6#64): each fee names its real source; no stale opening / limits / Allowances copy.
final class T1125CopyTests: XCTestCase {
  private var root: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }
  private func src(_ f: String) throws -> String { try String(contentsOf: root.appendingPathComponent(f), encoding: .utf8) }
  private func all() -> String {
    var a = ""
    for dir in ["App/Sources", "Sources/KipurseCore"] {
      let e = FileManager.default.enumerator(at: root.appendingPathComponent(dir), includingPropertiesForKeys: nil)
      while let u = e?.nextObject() as? URL { if u.pathExtension == "swift" { a += (try? String(contentsOf: u, encoding: .utf8)) ?? "" } }
    }
    return a
  }
  func testOpeningFeeIsCoinbaseNotKipurseWallet() {
    for s in [Beginner.openingFeeZh] { XCTAssertFalse(s.contains("从启付钱包余额扣")); XCTAssertFalse(s.contains("约 0.03")); XCTAssertTrue(s.contains("实际网络费")) }
    XCTAssertFalse(Beginner.openingFeeEn.contains("Kipurse wallet balance")); XCTAssertTrue(Beginner.openingFeeEn.contains("Coinbase wallet (Base account)"))
  }
  func testNoStaleCopyAnywhere() {
    let a = all()
    for bad in ["开通费约 0.03", "Setup fee about 0.03", "The setup fee (about 0.03 USDC)", "之前不用设，也不会挡住开户", "it never blocks opening",
                "在设置里改付款上限", "adjust payment limits in Settings", "新 AI 付款上限已生效", "设置 → 额度", "Settings → Allowance",
                "AI 付款上限（唯一的上限）", "your only limit", "from your Coinbase wallet at 0% markup", "paid in USDC from your Coinbase wallet with no markup",
                "设好 AI 付款上限，开启 Face ID 批准", "Payments over 20 USDC", "付款上限（开通后也能改）"] { XCTAssertFalse(a.contains(bad), bad) }
  }
  func testGuideStepThreeMatchesOpeningRule() {
    let s = UsageGuide.steps[2]
    XCTAssertTrue(s.detailZh.contains("三项都填好才能开户")); XCTAssertTrue(s.detailEn.contains("opening needs all three"))
    XCTAssertTrue(UsageGuide.steps[3].detailZh.contains("开户时已经一起开好")); XCTAssertTrue(UsageGuide.steps[3].detailZh.contains("重装或换手机后再开启，要从启付钱包付一笔实际网络费"))
  }
  func testLimitsSuccessAndAllowancesPointToRightPlace() throws {
    XCTAssertEqual(Loc.english("新的钱包安全上限已生效"), "New wallet safety limits are active")
    let al = try src("App/Sources/AllowancesView.swift")
    XCTAssertTrue(al.contains("AI 生活 › AI 花钱上限")); XCTAssertTrue(al.contains("AI Life tab › AI spending limits"))
    XCTAssertTrue(al.contains("T(EverydayLimits.aiTitleZh") || al.contains("AI 花钱上限"))
  }
  func testHelpSaysWhichFeeFromWhichBalance() throws {
    let lp = try src("App/Sources/LegalPages.swift")
    XCTAssertTrue(lp.contains("开通手续费（已含首次钱包安全上限和 Face ID 批准）：在充值之外另从你的 Coinbase 钱包（Base 账户）扣"))
    XCTAssertTrue(lp.contains("开户后再开启 Face ID 批准（重装、换手机或开户时没带）：从你的启付钱包余额扣，按实际网络费、确认前显示实时报价。只改上限不会收 Face ID 的费。"))
    XCTAssertFalse(lp.contains("开户网络费也由你用 USDC 付"))
  }
  /// t1128u (owner "允许再扣", §6#66): after opening, turning Face ID on may take ONE actual-cost fee from the Kipurse wallet (live quote, <= 0.05).
  /// No made-up number; opening copy still says the first enable rides in the opening fee; changing limits alone never charges it.
  func testFaceIDFeeAfterOpeningIsHonest() throws {
    let a = all()
    for bad in ["重新开启手续费约", "手续费约 0.03", "约 0.03 USDC", "costs about 0.03", "about 0.03 USDC", "开户后不会再为开启 Face ID 单独扣钱", "Kipurse never charges again",
                "开户后不再单独扣钱", "never again after that", "var enough: Bool { true }"] { XCTAssertFalse(a.contains(bad), bad) }
    let z = PhoneEnrollCopy.afterOpeningFeeZH
    for need in ["首次开启 Face ID 已含在开户费里", "从启付钱包付一笔实际网络费", "实时报价", "最多 0.05 USDC", "只改上限不会扣这笔钱"] { XCTAssertTrue(z.contains(need), need) }
    XCTAssertTrue(PhoneEnrollCopy.afterOpeningFeeEN.contains("live quote")); XCTAssertTrue(PhoneEnrollCopy.afterOpeningFeeEN.contains("changing limits alone never charges it"))
    for f in ["App/Sources/PhoneSigner.swift", "App/Sources/SiriIntro.swift"] { XCTAssertTrue(try src(f).contains("PhoneEnrollCopy.afterOpeningFeeZH"), f) }
    XCTAssertTrue(Unbound.cardBody.contains("实际网络费") || Unbound.cardBody.contains("actual network fee"))
    XCTAssertTrue(try src("App/Sources/SiriIntro.swift").contains("var enough: Bool { (m.state?.balance ?? 0) >= Self.maxFee }"))
    XCTAssertTrue(try src("App/Sources/PhoneSigner.swift").contains("if let e = EnrollFee.problem(r, owner: p.owner) { throw stopErr([e]) }"))
    XCTAssertTrue(Beginner.openingFeeZh.contains("Face ID 批准"), "the first Face ID enable rides in the opening fee")
  }
  func testServerStopsReadAsNoCharge() {
    Loc.override = "zh"; defer { Loc.override = nil }
    for (code, want) in [("wallet_needs_usdc", PhoneEnrollCopy.walletShortZH), ("wallet_fee_unavailable", PhoneEnrollCopy.walletUnavailableZH), ("fee_over_cap", PhoneEnrollCopy.overCapZH), ("opening_only", PhoneEnrollCopy.openingOnlyRefusedZH)] {
      let e = NSError(domain: "kipurse", code: 400, userInfo: [ServerText.errorCodeKey: code])
      XCTAssertEqual(PhoneEnrollCopy.line(e), want); XCTAssertTrue(PhoneEnrollCopy.line(e).contains("没有扣钱"), code) }
  }
}
