import XCTest
@testable import KipurseCore

/// Reinstall / new phone: the bind card, the no-phone emergency page and the resume message never dead-end.
final class UnboundTests: XCTestCase {
  let w = "0x2000000000000000000000000000000000000002"
  func testEmergencyURLIsTheWalletsOwnPage() {
    let b = URL(string: "https://example.test")!
    XCTAssertEqual(Unbound.emergencyURL(base: b, wallet: w, path: nil)?.absoluteString, "https://example.test/t/\(w)/owner/emergency")
    XCTAssertEqual(Unbound.emergencyURL(base: b, wallet: w, path: "/t/\(w)")?.absoluteString, "https://example.test/t/\(w)/owner/emergency")
    XCTAssertNil(Unbound.emergencyURL(base: b, wallet: nil, path: nil))
    XCTAssertNil(Unbound.emergencyURL(base: b, wallet: "0x12", path: nil))
    XCTAssertNil(Unbound.emergencyURL(base: b, wallet: w, path: "/../evil"), "never a path the server didn't give")
  }
  func testResumeMessageNamesTheRealProblem() {
    for zh in [true, false] {
      Loc.override = zh ? "zh" : "en"; defer { Loc.override = nil }
      let t = Unbound.resumeFailText(Unbound.notBound)
      XCTAssertTrue(t.contains(zh ? "还没开启" : "aren't on"), t)
      XCTAssertFalse(t.contains(zh ? "需要用 Face ID 确认" : "Face ID confirmation is needed"), "old misleading text")
      XCTAssertNotEqual(Unbound.resumeFailText(0), t)
    }
  }
  func testLabelsSplitBindAndSiri() {
    for zh in [true, false] {
      Loc.override = zh ? "zh" : "en"; defer { Loc.override = nil }
      XCTAssertEqual(Unbound.bindLabel, zh ? "开启 Face ID 批准" : "Turn on Face ID approvals")
      XCTAssertEqual(Unbound.siriLabel, zh ? "更新 Face ID 批准（一次，手续费用 USDC 付）" : "Update Face ID approvals (one time, fee in USDC)")
      XCTAssertEqual(GasCheck.Kind.phoneUpgrade.title, Unbound.bindLabel)
      XCTAssertTrue(GasCheck.phoneSignerWhat.contains(zh ? "不需要开通 Siri" : "needs Siri"))
      XCTAssertTrue(GasCheck.phoneSiriWhat.contains(zh ? "不升级也不影响 Face ID" : "Face ID still works"))
    }
    let u = URL(string: "https://example.test/phone/enroll?id=abc")!
    XCTAssertFalse(Unbound.isSiriUpgrade(u)); XCTAssertTrue(Unbound.isSiriUpgrade(Unbound.siriURL(u)))
    XCTAssertTrue(Unbound.siriURL(u).absoluteString.contains("id=abc"))
  }
}
