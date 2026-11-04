import XCTest
@testable import KipurseCore

final class VaultCheckTests: XCTestCase {
  let w = "0x452f678f6e588069D1Aef38D3D519567aA1014A4", v = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"
  func word(_ a: String) -> String { "0x" + String(repeating: "0", count: 24) + a.lowercased().dropFirst(2) }
  func testCallData() { XCTAssertEqual(VaultCheck.callData(wallet: w), "0x1cb3d314" + String(word(w).dropFirst(2))); XCTAssertNil(VaultCheck.callData(wallet: "0x12")) }
  func testDecode() { XCTAssertEqual(VaultCheck.decode(word(v)), v.lowercased()); XCTAssertNil(VaultCheck.decode("0x")); XCTAssertNil(VaultCheck.decode(word("0x" + String(repeating: "0", count: 40))))
    XCTAssertNil(VaultCheck.decode("0x" + String(repeating: "f", count: 64))) }
  func testMatchAccepted() { XCTAssertNil(VaultCheck.problem(server: v, chain: v.lowercased())) }
  func testMismatchRefused() { XCTAssertNotNil(VaultCheck.problem(server: v, chain: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc")) }
  func testUnreadableRefused() { XCTAssertNotNil(VaultCheck.problem(server: v, chain: nil)) }
  func testNoServerVaultLeavesItToBatchVerify() { XCTAssertNil(VaultCheck.problem(server: nil, chain: nil)) }
}
