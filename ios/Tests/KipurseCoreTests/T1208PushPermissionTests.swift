import XCTest
@testable import KipurseCore

/// t1208u / handbook §6#94: the app asks iOS for notification permission once a mainnet session / bound wallet exists, never in demo,
/// never again after iOS decided; registers with APNs after a grant; uploads a new token only with a session.
final class T1208PushPermissionTests: XCTestCase {
  func testAsksOnceWhenSessionOrWalletAndUndecided() {
    XCTAssertTrue(PushPermission.shouldAsk(status: .notDetermined, hasSession: true, walletBound: false, demo: false))
    XCTAssertTrue(PushPermission.shouldAsk(status: .notDetermined, hasSession: false, walletBound: true, demo: false))
  }
  func testNeverAsksWithoutAccountInDemoOrAfterDecision() {
    XCTAssertFalse(PushPermission.shouldAsk(status: .notDetermined, hasSession: false, walletBound: false, demo: false))
    XCTAssertFalse(PushPermission.shouldAsk(status: .notDetermined, hasSession: true, walletBound: true, demo: true))
    for s in [PushPermission.Status.denied, .authorized, .provisional, .ephemeral] {
      XCTAssertFalse(PushPermission.shouldAsk(status: s, hasSession: true, walletBound: true, demo: false), "\(s)")
    }
  }
  func testRegistersOnlyAfterGrant() {
    XCTAssertTrue(PushPermission.shouldRegister(status: .authorized, demo: false))
    XCTAssertTrue(PushPermission.shouldRegister(status: .provisional, demo: false))
    XCTAssertFalse(PushPermission.shouldRegister(status: .denied, demo: false))
    XCTAssertFalse(PushPermission.shouldRegister(status: .notDetermined, demo: false))
    XCTAssertFalse(PushPermission.shouldRegister(status: .authorized, demo: true))
  }
  func testUploadsNewTokenOnlyWithSession() {
    XCTAssertTrue(PushPermission.shouldUpload(token: "ab12", lastSent: nil, hasSession: true))
    XCTAssertTrue(PushPermission.shouldUpload(token: "ab12", lastSent: "old", hasSession: true))
    XCTAssertFalse(PushPermission.shouldUpload(token: "ab12", lastSent: "ab12", hasSession: true))
    XCTAssertFalse(PushPermission.shouldUpload(token: "ab12", lastSent: nil, hasSession: false))
    XCTAssertFalse(PushPermission.shouldUpload(token: nil, lastSent: nil, hasSession: true))
    XCTAssertFalse(PushPermission.shouldUpload(token: "", lastSent: nil, hasSession: true))
  }
  /// Source guard: the mainnet session path and app launch both call ensurePermission; the only prompt is the iOS system one.
  func testAppWiresThePermissionRequest() throws {
    let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("App/Sources")
    let push = try String(contentsOf: app.appendingPathComponent("PushBridge.swift"), encoding: .utf8)
    let main = try String(contentsOf: app.appendingPathComponent("MainnetViews.swift"), encoding: .utf8)
    XCTAssertTrue(push.contains("requestAuthorization(options: [.alert, .sound, .badge])"))
    XCTAssertTrue(push.contains("Task { await PushBridge.ensurePermission() }"), "launch path")
    XCTAssertTrue(main.contains("Task { await PushBridge.ensurePermission() }"), "new mainnet session path")
    XCTAssertTrue(push.contains("PushPermission.shouldUpload("))
    XCTAssertTrue(push.contains("CommandLine.arguments.contains(\"-wipeSelfTest\")"), "UI test launches (-demo, -kp*, -wipeSelfTest) never see the system prompt")
  }
}
