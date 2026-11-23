import XCTest
@testable import KipurseCore

/// t1027 / handbook 0A.2 / 0B: cold launch goes straight to the wallet; Face ID only for balance+action (pay / withdraw / add agent).
final class T1027NoFaceIDOnLaunchTests: XCTestCase {
  func testShellWalletHomeNeedsNoSession() {
    let s = WalletState.shell(wallet: "0x2000000000000000000000000000000000000002", owner: "0x1000000000000000000000000000000000000003")
    XCTAssertEqual(s.wallet?.lowercased(), "0x2000000000000000000000000000000000000002")
    XCTAssertEqual(s.balance, 0)
  }

  func testHandbookForbidsFaceIDBeforeBalanceActions() {
    // Locked product rule (the owner's decision log 0A.2 / 0B): opening the app never requires Face ID;
    // Face ID is only when there is a balance AND the user does pay / withdraw / add-agent.
    XCTAssertFalse(LaunchBiometricPolicy.faceIDRequiredOnColdLaunch)
    XCTAssertEqual(LaunchBiometricPolicy.faceIDActions, ["pay_approval", "withdraw", "add_agent"])
  }
}
