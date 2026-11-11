import XCTest
@testable import KipurseCore

final class SignHostTests: XCTestCase {
  func testMovedPagesOpenThroughPinnedShell() {
    let u = SignHost.shellURL(for: URL(string: "https://pay.kipurse.com/onboard/new?id=ab12")!, fragment: "vh=" + String(repeating: "a", count: 64), lang: "zh")!
    XCTAssertEqual(u.host, SignHost.host); XCTAssertEqual(u.path, "/v9/onboard/new"); XCTAssertNil(u.query, "nothing about the request reaches the static host")
    XCTAssertEqual(URLComponents(url: u, resolvingAgainstBaseURL: false)?.percentEncodedFragment, "u=%2Fonboard%2Fnew%3Fid%3Dab12%26lang%3Dzh&vh=" + String(repeating: "a", count: 64))
    let t = SignHost.shellURL(for: URL(string: "https://pay.kipurse.com/t/0x1000000000000000000000000000000000000003/owner/limits?id=9")!, fragment: "vh=00", lang: "en")!
    XCTAssertTrue(t.absoluteString.contains("u=%2Ft%2F0x1000000000000000000000000000000000000003%2Fowner%2Flimits%3Fid%3D9%26lang%3Den&vh=00"))
  }
  func testShellKeepsWalletPrefixInPath() {
    let w = "0x000000000000000000000000000000000000dead"
    let u = SignHost.shellURL(for: URL(string: "https://pay.kipurse.com/t/\(w)/owner/withdraw?plan=1")!, fragment: "vh=00", lang: "zh")!
    XCTAssertEqual(u.host, SignHost.host); XCTAssertEqual(u.path, "/v9/t/\(w)/owner/withdraw"); XCTAssertNil(u.query)
    // the bundle's API base (path minus /owner/withdraw) must keep the wallet prefix, never "/" (which made "//owner/..." -> https://owner/)
    let base = u.path.replacingOccurrences(of: "/owner/withdraw", with: "").replacingOccurrences(of: "/v9", with: "")
    XCTAssertEqual(URL(string: base + "/owner/withdraw/plan", relativeTo: URL(string: "https://pay.kipurse.com")!)!.absoluteString, "https://pay.kipurse.com/t/\(w)/owner/withdraw/plan")
  }
  func testOtherPagesAndHostsUntouched() {
    XCTAssertNil(SignHost.shellURL(for: URL(string: "https://pay.kipurse.com/signin?x=1")!, fragment: "", lang: "en"))
    XCTAssertNil(SignHost.shellURL(for: URL(string: "https://evil.example/onboard?id=1")!, fragment: "", lang: "en"))
    XCTAssertNil(SignHost.shellURL(for: URL(string: "http://pay.kipurse.com/onboard?id=1")!, fragment: "", lang: "en"))
    XCTAssertNil(SignHost.shellURL(for: URL(string: "https://pay.kipurse.com:8443/onboard?id=1")!, fragment: "", lang: "en"))
  }
  func testCommittedURLUsesShellForKipurseServer() {
    let calls: [[String: Any]] = [["to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "value": "0", "data": "0x"]]
    let u = BatchVerify.committedURL(URL(string: "https://pay.kipurse.com/owner/withdraw?id=1")!, chainId: 8453, from: "0x1000000000000000000000000000000000000003", calls: calls)!
    XCTAssertTrue(SignHost.isShell(u)); XCTAssertTrue(u.fragment!.contains("&vh="))
    let d = BatchVerify.depositURL(URL(string: "https://pay.kipurse.com/deposit?w=0x1000000000000000000000000000000000000003")!, wallet: "0x1000000000000000000000000000000000000003")
    XCTAssertTrue(SignHost.isShell(d)); XCTAssertTrue(d.fragment!.hasSuffix("&vw=0x1000000000000000000000000000000000000003"))
  }
  func testPinMatchesPublishedBuildOnlyByteExact() throws {
    let f = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("signhost-index.html.txt")
    let d = try Data(contentsOf: f); XCTAssertTrue(SignHost.matchesPin(d))
    var t = d; t.append(0x20); XCTAssertFalse(SignHost.matchesPin(t)); XCTAssertFalse(SignHost.matchesPin(Data()))
  }

  // t784: route() sends every Kipurse signing page (incl. emergency + trust approval) through the pinned shell, keeps the commitment
  func testRouteT784() {
    let w = "0x000000000000000000000000000000000000dead"
    let e = SignHost.route(URL(string: "https://pay.kipurse.com/t/\(w)/owner/emergency")!)
    XCTAssertEqual(e.host, SignHost.host); XCTAssertEqual(e.path, "/v9/t/\(w)/owner/emergency"); XCTAssertNil(e.query)
    let a = SignHost.route(URL(string: "https://pay.kipurse.com/approve/trust?id=abc")!); XCTAssertEqual(a.path, "/v9/approve/trust")
    let c = SignHost.route(URL(string: "https://pay.kipurse.com/owner/withdraw?plan=1#vh=ab12")!)
    XCTAssertTrue(c.absoluteString.contains("&vh=ab12"), c.absoluteString)
    let s = URL(string: "https://kipurse-sign.example.workers.dev/v7/deposit#u=x")!; XCTAssertEqual(SignHost.route(s), s)
    let x = URL(string: "https://basescan.org/tx/0x1")!; XCTAssertEqual(SignHost.route(x), x)
    let si = URL(string: "https://pay.kipurse.com/signin?id=1")!; XCTAssertEqual(SignHost.route(si), si)
    XCTAssertEqual(SignHost.setPrefix, "/v9"); XCTAssertEqual(SignHost.previousPrefix, "/v8")
  }
  func testOnchainDecodersT784() {
    XCTAssertEqual(VaultCheck.addrCall(VaultCheck.selBalanceOf, "0x000000000000000000000000000000000000dEaD"), "0x70a08231" + String(repeating: "0", count: 24) + "000000000000000000000000000000000000dead")
    XCTAssertNil(VaultCheck.addrCall(VaultCheck.selBalanceOf, "0x12"))
    XCTAssertEqual(VaultCheck.decodeUInt("0x" + String(repeating: "0", count: 58) + "0f4240"), 1_000_000)
    XCTAssertNil(VaultCheck.decodeUInt("0x" + "f" + String(repeating: "0", count: 63)))
    XCTAssertEqual(VaultCheck.decodeBool("0x" + String(repeating: "0", count: 63) + "1"), true)
    XCTAssertEqual(VaultCheck.decodeBool("0x" + String(repeating: "0", count: 64)), false)
    XCTAssertNil(VaultCheck.decodeBool("0x" + String(repeating: "0", count: 63) + "2"))
    XCTAssertNil(VaultCheck.withdrawProblem(planAmount: 5, onchainTotal: 5))
    XCTAssertNotNil(VaultCheck.withdrawProblem(planAmount: 6, onchainTotal: 5))
    XCTAssertNotNil(VaultCheck.withdrawProblem(planAmount: 1, onchainTotal: nil))
  }
  /// t887: signing / deposit pages open on a Kipurse-owned domain; the old workers.dev host stays accepted as fallback.
  func testSignHostIsKipurseDomain() {
    XCTAssertEqual(SignHost.host, "sign.kipurse.com"); XCTAssertTrue(SignHost.host.hasSuffix(".kipurse.com"))
    let u = SignHost.route(URL(string: "https://pay.kipurse.com/deposit?w=0x1111111111111111111111111111111111111111&mode=tap&amount=5000000")!)
    XCTAssertEqual(u.host, "sign.kipurse.com"); XCTAssertFalse(u.absoluteString.contains("workers.dev"))
    XCTAssertTrue(SignHost.isShell(URL(string: "https://sign.kipurse.com/v5/deposit#u=x")!))
    XCTAssertTrue(SignHost.isShell(URL(string: "https://kipurse-sign.example.workers.dev/v7/deposit#u=x")!))
    for bad in ["https://sign.kipurse.com.evil.io/v5", "http://sign.kipurse.com/v5", "https://evilsign.kipurse.com/v5", "https://sign.kipurse.com:8443/v5"] { XCTAssertFalse(SignHost.isShell(URL(string: bad)!), bad) }
  }
  /// t888: the Coinbase-wallet transfer link carries the #vw=<own wallet> commitment (else the page's guard refuses after the Coinbase confirmation).
  func testDepositTransferLinkCarriesWalletCommitment() {
    let w = "0x1111111111111111111111111111111111111111"
    let u = BatchVerify.depositURL(URL(string: "https://pay.kipurse.com/deposit?w=\(w)&mode=tap&lang=zh&amount=5000000")!, wallet: w)
    XCTAssertEqual(u.host, "sign.kipurse.com"); XCTAssertEqual(u.path, "/v9/deposit")
    let f = u.fragment ?? ""; XCTAssertTrue(f.hasSuffix("&vw=" + w.lowercased()), f); XCTAssertTrue(f.contains("amount%3D5000000"), f); XCTAssertTrue(f.contains("mode%3Dtap"), f)
  }
}
