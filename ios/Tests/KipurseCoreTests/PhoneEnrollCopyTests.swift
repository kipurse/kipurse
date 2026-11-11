import XCTest
@testable import KipurseCore

final class PhoneEnrollCopyTests: XCTestCase {
  override func tearDown() { Loc.override = nil }

  private func http(_ code: String, status: Int) -> NSError {
    ServerText.error(["error": code], status: status)
  }

  func testOnlyRealNetworkErrorsUseTheNetworkSentence() {
    Loc.override = "zh"
    for c in [NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorDNSLookupFailed] {
      XCTAssertEqual(PhoneEnrollCopy.line(NSError(domain: NSURLErrorDomain, code: c)), PhoneEnrollCopy.networkZH, "\(c)")
    }
    XCTAssertNotEqual(PhoneEnrollCopy.line(URLError(.cancelled)), PhoneEnrollCopy.networkZH)
    XCTAssertEqual(PhoneEnrollCopy.line(URLError(.cancelled)), "你取消了，没有开启")
  }

  func testFaceIDCancelAndBiometricFailure() {
    Loc.override = "zh"
    let cancel = NSError(domain: "com.apple.LocalAuthentication", code: -2)
    let failed = NSError(domain: "com.apple.LocalAuthentication", code: -1)
    XCTAssertEqual(PhoneEnrollCopy.line(cancel), PhoneEnrollCopy.faceIDZH)
    XCTAssertEqual(PhoneEnrollCopy.line(failed), PhoneEnrollCopy.faceIDZH)
    let keyCancel = NSError(domain: "NSOSStatusErrorDomain", code: -128)
    XCTAssertEqual(PhoneEnrollCopy.line(keyCancel), PhoneEnrollCopy.faceIDZH)
  }

  func testSecureEnclaveAndAppAttest() {
    Loc.override = "zh"
    XCTAssertEqual(PhoneEnrollCopy.line(NSError(domain: "NSOSStatusErrorDomain", code: -50)), PhoneEnrollCopy.secureKeyZH)
    XCTAssertEqual(PhoneEnrollCopy.line(NSError(domain: "com.apple.devicecheck.error", code: 1)), PhoneEnrollCopy.attestZH)
    XCTAssertEqual(PhoneEnrollCopy.line(http("app_attest_required", status: 403)), PhoneEnrollCopy.attestZH)
  }

  func testServerCodes() {
    Loc.override = "zh"
    XCTAssertEqual(PhoneEnrollCopy.line(http("needs_usdc", status: 400)), PhoneEnrollCopy.usdcZH)
    XCTAssertEqual(PhoneEnrollCopy.line(http("bad_key", status: 400)), PhoneEnrollCopy.badKeyZH)
    XCTAssertEqual(PhoneEnrollCopy.line(http("no_price", status: 400)), PhoneEnrollCopy.noPriceZH)
    XCTAssertEqual(PhoneEnrollCopy.line(http("unauthorized", status: 401)), PhoneEnrollCopy.loginZH)
    XCTAssertEqual(PhoneEnrollCopy.line(http("anything", status: 401)), PhoneEnrollCopy.loginZH)
    XCTAssertEqual(PhoneEnrollCopy.line(http("failed", status: 500)), PhoneEnrollCopy.serverZH)
    XCTAssertEqual(PhoneEnrollCopy.line(NSError(domain: "kipurse", code: 503, userInfo: [NSLocalizedDescriptionKey: "raw"])), PhoneEnrollCopy.serverZH)
    let unknown = http("weird_code", status: 400)
    XCTAssertEqual(PhoneEnrollCopy.line(unknown), unknown.localizedDescription)
    XCTAssertNotEqual(PhoneEnrollCopy.line(unknown), PhoneEnrollCopy.networkZH)
  }

  func testEnglishNetworkLine() {
    Loc.override = "en"
    XCTAssertEqual(PhoneEnrollCopy.line(URLError(.notConnectedToInternet)), PhoneEnrollCopy.networkEN)
    XCTAssertEqual(PhoneEnrollCopy.line(http("needs_usdc", status: 400)), "The Kipurse wallet doesn't have enough USDC for the setup fee.")
  }
}
