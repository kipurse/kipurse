import XCTest
@testable import KipurseCore

/// t1153u: approve-sheet Face ID guidance (handbook §6#74).
final class FaceIDNoticeT1153Tests: XCTestCase {
  override func tearDown() { Loc.override = nil }
  let la = "com.apple.LocalAuthentication"

  func testBiometryNotAvailableIsFaceIDOffWithSettingsGuidanceZhEn() {
    let e = NSError(domain: la, code: -6, userInfo: [NSLocalizedDescriptionKey: "生物特征对此 App 不可用。"])
    XCTAssertEqual(FaceIDNotice.from(e), .faceIDOff)
    Loc.override = "zh"; let zh = FaceIDNotice.faceIDOff.text
    XCTAssertTrue(zh.contains("设置 › Kipurse › 打开面容 ID")); XCTAssertTrue(zh.contains("没有批准，也没有扣钱")); XCTAssertFalse(zh.contains("不可用"))
    Loc.override = "en"; let en = FaceIDNotice.faceIDOff.text
    XCTAssertTrue(en.contains("Settings › Kipurse")); XCTAssertTrue(en.contains("Nothing was approved or charged"))
  }
  func testInvalidatedKeyGuidesToReEnable() {
    XCTAssertEqual(FaceIDNotice.from(domain: "CryptoTokenKit", code: -3), .keyInvalid)
    XCTAssertEqual(FaceIDNotice.from(domain: "NSOSStatusErrorDomain", code: -25300), .keyInvalid)
    Loc.override = "zh"; XCTAssertTrue(FaceIDNotice.keyInvalid.text.contains("设置 › Face ID 批准 重新开启"))
    Loc.override = "en"; XCTAssertTrue(FaceIDNotice.keyInvalid.text.contains("Settings › Face ID approvals"))
  }
  func testCancelFailureNetworkAndServerAreNotFaceIDNotices() {
    for c in [-1, -2, -3, -4, -7, -9] { XCTAssertNil(FaceIDNotice.from(domain: la, code: c), "\(c)") }   // t1255: -8 (lockout) now has its own notice (T1255FaceIDLockoutTests)
    XCTAssertNil(FaceIDNotice.from(domain: "NSOSStatusErrorDomain", code: -128))
    XCTAssertNil(FaceIDNotice.from(NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)))
    XCTAssertNil(FaceIDNotice.from(ServerText.error(["error": "connect_failed"], status: 409)))
  }
  func testEnrollCopyNoLongerCallsFaceIDOffACancel() {
    Loc.override = "zh"
    let off = NSError(domain: la, code: -6)
    XCTAssertNotEqual(PhoneEnrollCopy.line(off), PhoneEnrollCopy.faceIDZH)
    XCTAssertEqual(PhoneEnrollCopy.line(off), FaceIDNotice.offZH)
    XCTAssertEqual(PhoneEnrollCopy.line(NSError(domain: la, code: -2)), PhoneEnrollCopy.faceIDZH)
  }
  func testServerConnectFailedIsCalm() {
    Loc.override = "zh"; let zh = ServerText.text(code: "connect_failed", status: 409)
    XCTAssertTrue(zh.contains("没有保存额度，也没有扣钱")); XCTAssertFalse(zh.contains("connect_failed"))
    Loc.override = "en"; XCTAssertTrue(ServerText.text(code: "connect_failed", status: 409).contains("nothing was charged"))
  }
}
