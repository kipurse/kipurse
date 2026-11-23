import XCTest
@testable import KipurseCore

/// t1238 (handbook §6#109, owner chose ①): after the owner's wallet is moved to a NEW key-seat wallet on V5.4, the phone must (a) compute the
/// same new wallet and seat as the server did, from the owner's Coinbase account alone, and (b) treat the new wallet as V5.4 only when the
/// server's vault is exactly that wallet's V5.4 vault AND the vault has code on chain. Addresses are from the Base-fork rehearsal
/// (work/t1214/deploy/t1238-move-seat-fork-report.json), built by the server's move-seat.mjs; in this public repo the owner and every derived address are synthetic (never used on chain).
final class T1238MovedWalletTests: XCTestCase {
  let owner = "0x4242b022A8296cB18B0E0b1Cb9879C518170A718"
  let newWallet = "0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb", seat = "0x962034cF95b144e5eA4aE34b20DceF3fc077B924", vault54 = "0x96E8f9fd545F409cD9C3A2Dc73c3E51C2b28AFc5"
  override func tearDown() { UserDefaults.standard.removeObject(forKey: "kp.suite." + newWallet.lowercased()); KipurseSuite.pin(nil) }

  func testPhoneComputesTheMovedWalletLikeTheServer() {
    XCTAssertEqual(KeySeat.address(owner: owner, trust: KipurseSuite.v54.trust), seat.lowercased())
    XCTAssertEqual(KeySeat.predictWallet(owner: owner, trust: KipurseSuite.v54.trust), newWallet.lowercased())
    XCTAssertEqual(KipurseSuite.v54.vault(wallet: newWallet), vault54.lowercased())
  }
  func testNewWalletIsV54OnlyWithItsOwnV54VaultOnChain() async {
    UserDefaults.standard.removeObject(forKey: "kp.suite." + newWallet.lowercased())
    // vault has no code yet -> stays V5.2 (safe default)
    let s0 = await KipurseSuite.detect(wallet: newWallet, serverVault: vault54, code: { _ in "0x" })
    XCTAssertEqual(s0, .v52)
    // a different vault from the server -> V5.2
    let s1 = await KipurseSuite.detect(wallet: newWallet, serverVault: "0x" + String(repeating: "9", count: 40), code: { _ in "0x60" })
    XCTAssertEqual(s1, .v52)
    // its own V5.4 vault with code -> V5.4, remembered
    let s2 = await KipurseSuite.detect(wallet: newWallet, serverVault: vault54, code: { _ in "0x6080" })
    XCTAssertEqual(s2, .v54); XCTAssertEqual(KipurseSuite.stored(wallet: newWallet), .v54)
  }
  func testSeatChecksUseTheMovedWalletsSeat() {
    // with the moved wallet's suite active, a new phone for this wallet must target exactly this seat
    KipurseSuite.pin(.v54)
    XCTAssertEqual(KeySeat.address(owner: owner, trust: BatchVerify.trust), seat.lowercased())
  }
}
