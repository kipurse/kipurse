import XCTest
@testable import KipurseCore

/// t1197 (decision 92): new wallets on V5.3, 0x5150 and older wallets stay on V5.2 - the phone picks the suite per wallet.
final class T1197SuiteTests: XCTestCase {
  let W = "0x0eBd05A4a2226a59790600a54129f4b0E90fC817", v53 = "0xe635ab8852c3cb3b2125d3cb45018657ef73946b", v52 = "0x5d0136641655ad46eff24b243c3555a714f4317b"
  let owner0 = "0x515010c2e41F98CdDd76B819EE69DC832c0939B6", owner0Vault = "0x08FdA35764ea7999E69f644688552ff91b277d42"
  override func setUp() { KipurseSuite.pin(nil); for w in [W, owner0] { UserDefaults.standard.removeObject(forKey: "kp.suite." + w.lowercased()) } }
  override func tearDown() { setUp() }

  func testPublishedAddresses() {
    XCTAssertEqual(KipurseSuite.v52.adapter.lowercased(), "0x05320bed08309f66316f7d73e2d0be110400fbb2")
    XCTAssertEqual(KipurseSuite.v52.trust, "0x65d2ce04da7ace81e7c4ab08712509282745ec84")
    XCTAssertEqual(KipurseSuite.v53.adapter.lowercased(), "0xb150030be35903adee466d7733bf0841b667033c")
    XCTAssertEqual(KipurseSuite.v53.trust, "0xda1dcc6677f352ba551feb8ca0f39d46b41535c3")
    XCTAssertEqual(KipurseSuite.v53.factory, "0x34d9bdc9e10815fb6913af5bc0daad7e53dbd57d")
  }
  func testVaultsComputedOnThePhone() {
    XCTAssertEqual(KipurseSuite.v53.vault(wallet: W), v53); XCTAssertEqual(KipurseSuite.v52.vault(wallet: W), v52)
    XCTAssertEqual(KipurseSuite.v52.vault(wallet: owner0), owner0Vault.lowercased(), "the owner's live V5.2 vault")
    XCTAssertEqual(KipurseSuite.forVault(v53, wallet: W), .v53); XCTAssertEqual(KipurseSuite.forVault(v52, wallet: W), .v52)
    XCTAssertNil(KipurseSuite.forVault("0x1111111111111111111111111111111111111111", wallet: W)); XCTAssertNil(KipurseSuite.forVault(nil, wallet: W))
    XCTAssertEqual(UsdcGas.vaults(wallet: W), [v52, v53])
  }
  func testOwnerWalletStaysV52() async {
    var asked = 0
    let s = await KipurseSuite.detect(wallet: owner0, serverVault: owner0Vault, code: { _ in asked += 1; return "0x6080" })
    XCTAssertEqual(s, .v52); XCTAssertEqual(asked, 0, "a V5.2 vault never even asks the chain"); XCTAssertNil(KipurseSuite.stored(wallet: owner0))
  }
  func testV53OnlyWhenItsVaultHasCode() async {
    let none = await KipurseSuite.detect(wallet: W, serverVault: v53, code: { _ in "0x" }); XCTAssertEqual(none, .v52); XCTAssertNil(KipurseSuite.stored(wallet: W))
    let fail = await KipurseSuite.detect(wallet: W, serverVault: v53, code: { _ in nil }); XCTAssertEqual(fail, .v52)
    let other = await KipurseSuite.detect(wallet: W, serverVault: "0x1111111111111111111111111111111111111111", code: { _ in "0x6080" }); XCTAssertEqual(other, .v52)
    let yes = await KipurseSuite.detect(wallet: W, serverVault: v53, code: { _ in "0x6080" }); XCTAssertEqual(yes, .v53); XCTAssertEqual(KipurseSuite.stored(wallet: W), .v53)
    let again = await KipurseSuite.detect(wallet: W, serverVault: v52, code: { _ in "0x6080" }); XCTAssertEqual(again, .v53, "a remembered suite never flips")
  }
  func testDefaultsFollowTheActiveSuite() {
    XCTAssertEqual(PhoneTrust.mainnetAdapter, KipurseSuite.v52.adapter, "no wallet / unknown wallet = V5.2 (0x5150 unchanged)")
    XCTAssertEqual(BatchVerify.trust, KipurseSuite.v52.trust)
    KipurseSuite.pin(.v53)
    XCTAssertEqual(PhoneTrust.mainnetAdapter, KipurseSuite.v53.adapter); XCTAssertEqual(BatchVerify.trust, KipurseSuite.v53.trust)
    KipurseSuite.pin(nil); XCTAssertEqual(PhoneTrust.mainnetAdapter, KipurseSuite.v52.adapter)
  }
  func testTrustDigestDiffersPerSuite() {
    let m = OwnerTrustMessage(account: W, merchant: "0x" + String(repeating: "ab", count: 32), name: "shop", epoch: "1", payees: ["0x00000000000000000000000000000000000c0ffe"], signers: [],
                              single: "1000000", daily: "2000000", expiry: "1900000000", nonce: "0x" + String(repeating: "01", count: 32), deadline: "1900000000")
    let a = PhoneTrust.digest(m, adapter: KipurseSuite.v52.adapter), b = PhoneTrust.digest(m, adapter: KipurseSuite.v53.adapter)
    XCTAssertNotNil(a); XCTAssertNotNil(b); XCTAssertNotEqual(a, b, "a V5.2 signature can never be replayed on V5.3 and vice versa")
  }
  /// The REAL resume reply of a NEW (V5.3) wallet from the fork matrix: accepted only with the V5.3 trust; on V5.2 it is "another contract".
  func testRealV53ResumeReplyNeedsTheV53Trust() throws {
    let u = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("t1138-e2e-fixtures.json.txt")
    guard let d = try? Data(contentsOf: u), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let sr = j["U2.safetyResume"] as? [String: Any],
          var r = (sr["resume"] as? [String: Any])?["res"] as? [String: Any], let w = sr["wallet"] as? String, let o = sr["owner"] as? String else { throw XCTSkip("no fixture") }
    for k in ["pm", "url"] { if let s = r[k] as? String, s.hasPrefix("http://fork.invalid/") { r[k] = "https://pay.kipurse.com/" + s.dropFirst("http://fork.invalid/".count) } }
    KipurseSuite.pin(.v53); let ok = RequestVerify.resumeReply(r, wallet: w, owner: o); XCTAssertTrue(ok.result.ok, "\(ok.result.problems)"); XCTAssertEqual(ok.calls.count, 2)
    KipurseSuite.pin(.v52); XCTAssertFalse(RequestVerify.resumeReply(r, wallet: w, owner: o).result.ok, "a V5.2 phone view refuses a V5.3 batch")
  }
}
