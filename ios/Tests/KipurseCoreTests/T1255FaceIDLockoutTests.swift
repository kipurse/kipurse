import XCTest
@testable import KipurseCore

/// t1255 (handbook §6#124): Face ID locked by iOS gets its own guidance; it is never shown as "cancelled" or "approval key invalid".
final class T1255FaceIDLockoutTests: XCTestCase {
  let la = "com.apple.LocalAuthentication"
  func testLockoutMapsToLockout() {
    XCTAssertEqual(FaceIDNotice.from(domain: la, code: -8), .lockout)
    XCTAssertEqual(FaceIDNotice.from(domain: la, code: -6), .faceIDOff)
  }
  func testTokenErrorWhileLockedIsLockoutNotKeyInvalid() {
    let e = NSError(domain: "CryptoTokenKit", code: -9)
    XCTAssertEqual(FaceIDNotice.from(e), .keyInvalid)
    XCTAssertEqual(FaceIDNotice.from(e, lockedNow: true), .lockout)
  }
  func testTextSaysPasscodeOnlyUnlocksAndNothingApproved() {
    XCTAssertTrue(FaceIDNotice.lockZH.contains("锁屏密码") && FaceIDNotice.lockZH.contains("不会批准任何东西") && FaceIDNotice.lockZH.contains("没有扣钱"))
    XCTAssertTrue(FaceIDNotice.unlockReasonZH.contains("只用来解锁 Face ID"))
    XCTAssertTrue(FaceIDNotice.lockEN.contains("approves nothing"))
  }
  func testEnrollCopyNoLongerCallsLockoutCancelled() {
    let t = PhoneEnrollCopy.line(NSError(domain: la, code: -8))
    XCTAssertTrue(t.contains("锁屏密码") || t.contains("passcode"), t)
  }
  func testEveryFaceIDEntryAsksForUnlockFirst() throws {
    let root = #filePath.replacingOccurrences(of: "Tests/KipurseCoreTests/T1255FaceIDLockoutTests.swift", with: "App/Sources/")
    for f in ["AllowancesView.swift", "ConnectApprove.swift", "AppModel.swift", "MainnetViews.swift", "PhoneSigner.swift", "SafetyPanel.swift"] {
      let s = try String(contentsOfFile: root + f, encoding: .utf8)
      XCTAssertTrue(s.contains("await FaceIDUnlock.ensure()"), f)
    }
    let u = try String(contentsOfFile: root + "FaceIDUnlock.swift", encoding: .utf8)
    XCTAssertTrue(u.contains(".deviceOwnerAuthentication, localizedReason: FaceIDNotice.unlockReason"))
    XCTAssertTrue(u.contains("LAError.biometryLockout"))
  }
}
