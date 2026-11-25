import XCTest
@testable import KipurseCore

/// t1214 (decision 100/#102): the kind-5 signer-trust grant digest the phone signs (same vector as the forked V5.4 contract) and the
/// phone's V5.2 -> V5.4 switch after the owner-signed migration (and back after a rollback).
final class T1214V54Tests: XCTestCase {
  let owner0 = "0x515010c2e41F98CdDd76B819EE69DC832c0939B6", v52Vault = "0x08FdA35764ea7999E69f644688552ff91b277d42", v54Vault = "0x4B1597a46600fbD610f07229F6396881a2edF075"
  let mer = "0xf3359a17b890db508d338776aef0b63976930f9f0b7ba21f16ab1ce41dc8c8a3", signer = "0xaDB2f2C49F31D59Bc46959818e5c445e1c01aCB8"
  override func setUp() { KipurseSuite.pin(nil); UserDefaults.standard.removeObject(forKey: "kp.suite." + owner0.lowercased()) }
  override func tearDown() { setUp() }
  var grant: OwnerSignerTrustMessage { OwnerSignerTrustMessage(account: owner0, merchant: mer, name: "shop.example", epoch: "1", signers: [signer], single: "6000000", daily: "12012000",
                                                               expiry: "1799971200", nonce: "0x" + String(repeating: "11", count: 32), deadline: "1799971200") }
  func testSignerTrustDigestMatchesTheContract() {
    XCTAssertEqual(KipurseSuite.v54.adapter, "0x99D8dFEC40023F53F6e451f9afFF7Efc223B7Aaa")
    let d = PhoneTrust.signerTrustDigest(grant).map { Hex.encode($0).lowercased() }
    XCTAssertEqual(d.map { $0.hasPrefix("0x") ? String($0.dropFirst(2)) : $0 }, "fd21ab612553164c605f5f7a8fb5f73d7c44d924f331dad1371f33e539bdf214")
    XCTAssertNotEqual(PhoneTrust.signerTrustDigest(grant, adapter: KipurseSuite.v52.adapter).map { Hex.encode($0) }, d, "bound to the V5.4 adapter")
    var none = grant; none.signers = []; XCTAssertNil(PhoneTrust.signerTrustDigest(none), "a grant without a signer is never signed")
  }
  func testGrantMustMatchTheCard() {
    let card = OwnerTrustMessage(account: owner0, merchant: mer, name: "shop.example", epoch: "0" /* t1240: the grant (epoch 1) is for the epoch AFTER this trust lands */, payees: ["0x5Ee0000000000000000000000000000000005Ee0"], signers: [signer],
                                 single: "6000000", daily: "12012000", expiry: "1799971200", nonce: "0x" + String(repeating: "22", count: 32), deadline: "1799971200")
    XCTAssertEqual(PhoneTrust.signerTrustProblems(grant, card: card, wallet: owner0), [])
    var sameEpoch = card; sameEpoch.epoch = "1"; XCTAssertFalse(PhoneTrust.signerTrustProblems(grant, card: sameEpoch, wallet: owner0).isEmpty, "t1240: a grant for the current epoch dies when the trust lands")
    var g = grant; g.single = "6000001"; XCTAssertFalse(PhoneTrust.signerTrustProblems(g, card: card, wallet: owner0).isEmpty)
    g = grant; g.signers = ["0x0000000000000000000000000000000000000bad"]; XCTAssertFalse(PhoneTrust.signerTrustProblems(g, card: card, wallet: owner0).isEmpty)
    g = grant; g.deadline = "1900000000"; XCTAssertFalse(PhoneTrust.signerTrustProblems(g, card: card, wallet: owner0).isEmpty)
    XCTAssertFalse(PhoneTrust.signerTrustProblems(grant, card: card, wallet: "0x0eBd05A4a2226a59790600a54129f4b0E90fC817").isEmpty)
  }
  func testV54VaultComputedOnThePhone() { XCTAssertEqual(KipurseSuite.v54.vault(wallet: owner0), v54Vault.lowercased()); XCTAssertFalse(KipurseSuite.all.contains(.v54), "never offered to new wallets") }
  func testSwitchToV54OnlyWhenItsVaultHasCodeAndBack() async {
    let before = await KipurseSuite.detect(wallet: owner0, serverVault: v52Vault, code: { _ in "0x6080" }); XCTAssertEqual(before, .v52)
    let noCode = await KipurseSuite.detect(wallet: owner0, serverVault: v54Vault, code: { _ in "0x" }); XCTAssertEqual(noCode, .v52); XCTAssertNil(KipurseSuite.stored(wallet: owner0))
    let other = await KipurseSuite.detect(wallet: owner0, serverVault: "0x1111111111111111111111111111111111111111", code: { _ in "0x6080" }); XCTAssertEqual(other, .v52)
    let yes = await KipurseSuite.detect(wallet: owner0, serverVault: v54Vault, code: { _ in "0x6080" }); XCTAssertEqual(yes, .v54); XCTAssertEqual(KipurseSuite.stored(wallet: owner0), .v54)
    XCTAssertEqual(KipurseSuite.active == .v54 || Operator.wallet.lowercased() != owner0.lowercased(), true)
    let back = await KipurseSuite.detect(wallet: owner0, serverVault: v52Vault, code: { _ in "0x6080" }); XCTAssertEqual(back, .v52, "after the owner's rollback"); XCTAssertEqual(KipurseSuite.stored(wallet: owner0), .v52)
  }
}
