import XCTest
@testable import KipurseCore

/// t1239 (handbook §6#109): after the owner's wallet moved, the phone's APNs token (unchanged) must be uploaded again for the new wallet.
final class T1239PushWalletTests: XCTestCase {
  let tok = "ab12", oldW = "0x515010c2e41F98CdDd76B819EE69DC832c0939B6", newW = "0xeF6B64EB64a7f28215b0b97d51a2008458BF0dEb"
  func testSameTokenNewWalletUploadsAgain() {
    let sentOld = PushPermission.sentKey(token: tok, wallet: oldW)
    XCTAssertFalse(PushPermission.shouldUpload(token: tok, lastSent: sentOld, hasSession: true, wallet: oldW))
    XCTAssertTrue(PushPermission.shouldUpload(token: tok, lastSent: sentOld, hasSession: true, wallet: newW))
  }
  func testOldBareTokenRecordUploadsOnceForTheWallet() {
    XCTAssertTrue(PushPermission.shouldUpload(token: tok, lastSent: tok, hasSession: true, wallet: newW), "apps updated from <=80 stored the bare token")
    XCTAssertFalse(PushPermission.shouldUpload(token: tok, lastSent: PushPermission.sentKey(token: tok, wallet: newW.lowercased()), hasSession: true, wallet: newW))
  }
  func testNoSessionOrNoTokenNeverUploads() {
    XCTAssertFalse(PushPermission.shouldUpload(token: tok, lastSent: nil, hasSession: false, wallet: newW))
    XCTAssertFalse(PushPermission.shouldUpload(token: nil, lastSent: nil, hasSession: true, wallet: newW))
  }
  func testAppUsesTheWalletAwareRule() throws {
    let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("App/Sources")
    let push = try String(contentsOf: app.appendingPathComponent("PushBridge.swift"), encoding: .utf8)
    XCTAssertTrue(push.contains("hasSession: MainnetSession.load() != nil, wallet: w)"))
    XCTAssertTrue(push.contains("PushPermission.sentKey(token: t, wallet: w)"))
  }
}
