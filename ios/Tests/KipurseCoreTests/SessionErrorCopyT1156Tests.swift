import XCTest
@testable import KipurseCore

/// t1156 (decision 75): session-save failures say what really happened; the network sentence only for real network errors.
final class SessionErrorCopyT1156Tests: XCTestCase {
  override func tearDown() { Loc.override = nil }
  let la = "com.apple.LocalAuthentication"
  func testFaceIDOffAndInvalidatedKeyReuseFaceIDNotice() {
    XCTAssertEqual(SessionErrorCopy.kind(NSError(domain: la, code: -6)), .faceID(.faceIDOff))
    XCTAssertEqual(SessionErrorCopy.kind(NSError(domain: "CryptoTokenKit", code: -3)), .faceID(.keyInvalid))
    Loc.override = "zh"; XCTAssertEqual(SessionErrorCopy.text(.faceID(.faceIDOff)), FaceIDNotice.offZH)
  }
  func testNoApprovalKeyCopyZhEn() {
    Loc.override = "zh"; XCTAssertEqual(SessionErrorCopy.text(.noApprovalKey), "这台 iPhone 还没开启 Face ID 批准。请到 设置 › Face ID 批准 开启。这次没有保存，也没有扣钱。")
    Loc.override = "en"; XCTAssertTrue(SessionErrorCopy.text(.noApprovalKey).contains("Settings › Face ID approvals"))
  }
  func testCancelIsCalmNotNetwork() {
    for c in [-1, -2, -4, -9] { XCTAssertEqual(SessionErrorCopy.kind(NSError(domain: la, code: c)), .cancelled, "\(c)") }
    XCTAssertEqual(SessionErrorCopy.kind(NSError(domain: "NSOSStatusErrorDomain", code: -128)), .cancelled)
    Loc.override = "zh"; let t = SessionErrorCopy.text(.cancelled)
    XCTAssertTrue(t.contains("没有保存，也没有扣钱")); XCTAssertFalse(t.contains("暂时连不上"))
  }
  func testOnlyRealNetworkAndServerErrorsSayCantConnect() {
    Loc.override = "zh"
    XCTAssertEqual(SessionErrorCopy.kind(URLError(.notConnectedToInternet)), .network)
    XCTAssertEqual(SessionErrorCopy.kind(URLError(.timedOut)), .network)
    XCTAssertEqual(SessionErrorCopy.kind(ServerText.error(["error": "error"], status: 500)), .network)
    XCTAssertEqual(SessionErrorCopy.text(.network), "暂时连不上，请稍后再试。")
    XCTAssertNotEqual(SessionErrorCopy.kind(NSError(domain: la, code: -6)), .network)
  }
}

final class SessionRefreshT1156Tests: XCTestCase {
  final class Box { var session = false; var signIns = 0; var sends = 0; var clears = 0; var replies: [Int] = [] ; var signInError: Error? }
  func run(_ b: Box) async throws -> Int {
    try await SessionRefresh.post(hasSession: { b.session }, signIn: { b.signIns += 1; if let e = b.signInError { throw e }; b.session = true },
      clear: { b.clears += 1; b.session = false }, send: { b.sends += 1; return (b.replies.isEmpty ? 200 : b.replies.removeFirst(), [:]) }).0
  }
  func testNoSessionSignsInOnceThenSends() async throws {
    let b = Box(); let c = try await run(b)
    XCTAssertEqual(c, 200); XCTAssertEqual(b.signIns, 1); XCTAssertEqual(b.sends, 1)
  }
  func testValidSessionDoesNotPromptFaceID() async throws {
    let b = Box(); b.session = true; _ = try await run(b)
    XCTAssertEqual(b.signIns, 0); XCTAssertEqual(b.sends, 1)
  }
  func testServer401RefreshesOnceAndRetriesOnce() async throws {
    let b = Box(); b.session = true; b.replies = [401, 401]
    let c = try await run(b)
    XCTAssertEqual(c, 401); XCTAssertEqual(b.signIns, 1); XCTAssertEqual(b.clears, 1); XCTAssertEqual(b.sends, 2, "never more than two POSTs")
  }
  func testFaceIDFailureSendsNothing() async {
    let b = Box(); b.signInError = NSError(domain: "com.apple.LocalAuthentication", code: -6)
    do { _ = try await run(b); XCTFail("must throw") } catch { XCTAssertEqual(SessionErrorCopy.kind(error), .faceID(.faceIDOff)) }
    XCTAssertEqual(b.sends, 0, "nothing sent when the session Face ID fails")
  }
  func testOtherErrorsPassThroughUnchanged() async throws {
    let b = Box(); b.session = true; b.replies = [400]; let c = try await run(b); XCTAssertEqual(c, 400); XCTAssertEqual(b.signIns, 0)
  }
}
