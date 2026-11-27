import XCTest
@testable import KipurseCore

/// t1139 (decision 71, owner decision t1139 option a): resume after an emergency stop also lifts the ON-CHAIN pause with ONE Coinbase (Base Account)
/// confirmation; network fee from the Kipurse wallet's USDC; the app says "[zh]" only after the chain says not paused.
/// Fixture: the REAL 202 /safety/resume reply from the end-to-end matrix on a local Base fork (throwaway keys), and the #vh the built
/// resume.v1.js page accepted for it (page-sim-resume-t1139.mjs).
final class T1139ResumeTests: XCTestCase {
  static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  func fixture() throws -> (reply: [String: Any], wallet: String, owner: String, vh: String) {
    guard let d = try? Data(contentsOf: Self.dir.appendingPathComponent("t1139-resume-fixture.json.txt")),
          let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], var r = j["reply"] as? [String: Any] else { throw XCTSkip("no fixture") }
    // the fork server runs with publicBase http://fork.invalid; production serves the same paths from pay.kipurse.com
    for k in ["pm", "url"] { if let s = r[k] as? String, s.hasPrefix("http://fork.invalid/") { r[k] = "https://pay.kipurse.com/" + s.dropFirst("http://fork.invalid/".count) } }
    return (r, j["wallet"] as! String, j["owner"] as! String, j["vh"] as! String)
  }
  func testRealForkReplyPassesAndCommitsToTheBatchThePageAccepted() throws {
    let f = try fixture(); let rep = RequestVerify.resumeReply(f.reply, wallet: f.wallet, owner: f.owner)
    XCTAssertTrue(rep.result.ok, "\(rep.result.problems)"); XCTAssertEqual(rep.calls.count, 2); XCTAssertEqual(rep.id, f.reply["id"] as? String)
    XCTAssertEqual(rep.fee.map { String($0) }, (f.reply["fee"] as? [String: Any])?["usdc"] as? String)
    XCTAssertLessThan(rep.fee ?? .max, RequestVerify.limitsFeeCapAtomic)
    XCTAssertEqual(BatchVerify.commitment(chainId: 8453, from: f.owner, calls: rep.calls), f.vh, "the App commits to exactly the batch the page sends")
    let u = try XCTUnwrap(BatchVerify.committedURL(try XCTUnwrap(rep.url), chainId: 8453, from: f.owner, calls: rep.calls))
    XCTAssertEqual(u.host, SignHost.host); XCTAssertEqual(u.path, "/v13/t/\(f.wallet.lowercased())/safety/resume")
    XCTAssertTrue(u.absoluteString.contains("vh=" + f.vh), u.absoluteString)
  }
  func testTamperedRepliesAreRefusedBeforeAnyPageOpens() throws {
    let f = try fixture()
    func refused(_ name: String, owner: String? = nil, _ mut: (inout [String: Any]) -> Void) {
      var r = f.reply; mut(&r); let rep = RequestVerify.resumeReply(r, wallet: f.wallet, owner: owner ?? f.owner)
      XCTAssertFalse(rep.result.ok, name); XCTAssertNil(rep.url, name); XCTAssertNil(rep.from, name); XCTAssertTrue(rep.calls.isEmpty, name) }
    func setCall(_ r: inout [String: Any], _ i: Int, _ k: String, _ v: Any) { var c = r["calls"] as! [[String: Any]]; c[i][k] = v; r["calls"] = c }
    let calls = f.reply["calls"] as! [[String: Any]]; let d0 = calls[0]["data"] as! String, d1 = calls[1]["data"] as! String
    let z56 = String(repeating: "0", count: 56)
    refused("setPaused(true)") { setCall(&$0, 1, "data", String(d1.dropLast(57)) + "1" + z56) }
    refused("another contract") { setCall(&$0, 1, "data", d1.replacingOccurrences(of: "65d2ce04da7ace81e7c4ab08712509282745ec84", with: String(repeating: "1", count: 40))) }
    refused("fee to someone else") { setCall(&$0, 0, "data", d0.replacingOccurrences(of: "82ecf6e2f76ee100e4676dabe193bca6bcab64fd", with: String(repeating: "2", count: 40))) }
    refused("fee above the cap") { setCall(&$0, 0, "data", String(d0.dropLast(56 + 64)) + String(repeating: "0", count: 60) + "2710" + z56) }
    refused("fee differs from the quote") { var fe = $0["fee"] as! [String: Any]; fe["usdc"] = String(Int(fe["usdc"] as! String)! + 1); $0["fee"] = fe }
    refused("limits sponsor route (lw-)") { $0["pm"] = ($0["pm"] as! String).replacingOccurrences(of: "id=ur-", with: "id=lw-") }
    refused("sponsor id for another plan") { $0["pm"] = RequestVerify.resumePaymasterPrefix + String(repeating: "0", count: 24) }
    refused("page on another host") { $0["url"] = ($0["url"] as! String).replacingOccurrences(of: "pay.kipurse.com", with: "evil.example") }
    refused("another page") { $0["url"] = ($0["url"] as! String).replacingOccurrences(of: "/safety/resume", with: "/owner/limits") }
    refused("sent from another account") { $0["from"] = "0x" + String(repeating: "e", count: 40) }
    refused("signer is not my Base Account") { $0["owner"] = "0x" + String(repeating: "e", count: 40) }
    refused("another wallet") { $0["wallet"] = "0x" + String(repeating: "3", count: 40) }
    refused("three calls") { $0["calls"] = calls + [calls[1]] }
    refused("unpause only (no fee leg)") { $0["calls"] = [calls[1]] }
    refused("swapped order") { $0["calls"] = [calls[1], calls[0]] }
    refused("not a 202 resume plan") { $0["state"] = nil }
    refused("fee not from the wallet") { $0["feeFrom"] = "kipurse_wallet_relay" }
    refused("ETH on the unpause step") { setCall(&$0, 1, "value", "0x1") }
    refused("not Base") { $0["chainId"] = 1 }
    refused("other trust field") { $0["trust"] = "0x" + String(repeating: "4", count: 40) }
    refused("no Base Account on this phone", owner: "") { _ in }
  }
  func testUnpauseCallIsSetPausedFalseOnKipurseTrust() {
    XCTAssertEqual(BatchVerify.sel("setPaused(bool)"), "0x16c38b3c")
    let d = RequestVerify.unpauseCallData; XCTAssertEqual(d.count, 2 + 8 + 64 * 4 + 128)
    XCTAssertTrue(d.contains(String(BatchVerify.trust.dropFirst(2)))); XCTAssertTrue(d.hasSuffix("16c38b3c" + String(repeating: "0", count: 64 + 56)))
  }
  func testSignSetV12RoutesResumeOnly() {
    let w = "0x527b741eb13732322eb7a9547029f8645970dce4"
    let u = SignHost.route(URL(string: "https://pay.kipurse.com/t/\(w)/safety/resume?plan=0c634fb1625b4cb17fc12c94")!)
    XCTAssertEqual(u.host, SignHost.host); XCTAssertEqual(u.path, "/v13/t/\(w)/safety/resume")
    XCTAssertTrue(SignHost.moved.contains("/safety/resume")); XCTAssertEqual(SignHost.setPrefix, "/v13"); XCTAssertEqual(SignHost.previousPrefix, "/v12")
    XCTAssertEqual(SignHost.indexSHA256, "ddde94acce2897aa2d8b4997680b2bbbea2a60f6f12aa83ea5e682cf488250a3")
    for p in ["safety/status", "safety/stop", "safety/holds"] { let s = URL(string: "https://pay.kipurse.com/t/\(w)/\(p)")!; XCTAssertEqual(SignHost.route(s), s) }
  }
  func testNotResumedYetTextIsItsOwn() {
    XCTAssertNotEqual(Unbound.resumeFailText(202), Unbound.resumeFailText(999)); XCTAssertNotEqual(Unbound.resumeFailText(202), Unbound.resumeFailText(0))
  }
  /// The App says "[zh]" only on a 200 from Face ID (server read chain not paused) or after the server confirmed the on-chain unpause.
  func testAppSaysResumedOnlyAfterTheChainSaysSo() throws {
    let src = try String(contentsOf: Self.dir.appendingPathComponent("../../App/Sources/SafetyPanel.swift"), encoding: .utf8)
    XCTAssertTrue(src.contains("if r.ok { Haptics.success(); pause = nil; msg = T(\"已恢复 AI 付款。\""))
    XCTAssertTrue(src.contains("if c == 200 { return (true, 200, nil) }")); XCTAssertTrue(src.contains("return box.done ? (true, 200, nil) : (false, 202, nil)"))
    XCTAssertTrue(src.contains("if await SafetyPanel.resumeConfirm(id) { box.done = true"))
    let scr = try String(contentsOf: Self.dir.appendingPathComponent("../../App/Sources/Screens.swift"), encoding: .utf8)
    XCTAssertTrue(scr.contains("let r = await SafetyPanel.resumeFlow(m) { _ in }; if r.ok { Haptics.success(); msg = L(\"已恢复 AI 付款。\")"))
    XCTAssertFalse(scr.contains("SafetyPanel.resumeWithFaceID(); if c == 200"))
  }
}
