import XCTest
@testable import KipurseCore

final class T1045NoBackupRecoveryTests: XCTestCase {
  func testFourthStepIsAutomaticAndNeverRequiresAnyBackup() {
    let old = Loc.override; defer { Loc.override = old }
    for lang in ["zh", "en"] {
      Loc.override = lang
      let fourth = LostPhoneRecovery.steps[3]
      XCTAssertTrue(fourth.contains("https://kipurse.github.io/rescue/"))
      XCTAssertTrue(fourth.contains(lang == "zh" ? "自动找到" : "automatically finds"))
      for banned in ["之前保存", "完整链接", "PDF", "截图", "saved earlier", "complete link"] { XCTAssertFalse(fourth.contains(banned)) }
    }
  }
  func testDeletionNeedsNoRescueFragmentAndOptionalLinkIsOnlyAppendix() throws {
    let old = Loc.override; defer { Loc.override = old }; Loc.override = "zh"
    let r: JSONValue = .object(["wallet": .string("0x1111111111111111111111111111111111111111"), "owner": .string("0x2222222222222222222222222222222222222222"), "chainId": .number(8453)])
    let g = try XCTUnwrap(RecoveryGuide(recovery: r))
    XCTAssertNil(g.rescueUrl)
    XCTAssertTrue(g.simpleMethods[0].works)
    XCTAssertEqual(g.simpleMethods[0].steps, LostPhoneRecovery.steps + [LostPhoneRecovery.publicPageNote])
    XCTAssertFalse(g.text.contains("需已保存"))
    XCTAssertFalse(g.text.contains("首页还不能"))
  }
  func testAppURLFallbackIsBarePublicRecoveryPage() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let source = try String(contentsOf: root.appendingPathComponent("App/Sources/AppModel.swift"), encoding: .utf8)
    XCTAssertTrue(source.contains("rescueUrl.isEmpty ? \"https://kipurse.github.io/rescue/\" : rescueUrl"))
    XCTAssertFalse(source.contains("这台设备还没有完整取回链接"))
  }
}
