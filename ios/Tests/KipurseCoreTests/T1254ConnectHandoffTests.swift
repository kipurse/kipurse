import XCTest
@testable import KipurseCore

/// t1254 (handbook §6#123): the 「下一步」 page wording. It must say the limits are NOT in effect yet and that Face ID in Kipurse is the
/// last step, for Muse and for every other outside AI.
final class T1254ConnectHandoffTests: XCTestCase {
  func testStagedSaysNotInEffect() {
    let s = ConnectHandoff.staged(single: 2_000_000, daily: 5_000_000, term: 30_000_000)
    XCTAssertTrue(s.contains("2") && s.contains("5") && s.contains("30"), s)
    XCTAssertTrue(s.contains("还没生效") || s.contains("not in effect"), s)
  }
  func testEveryKindEndsWithFaceIDInKipurse() {
    for k in [ConnectHandoff.Kind.muse, .prefill, .paste] {
      let st = ConnectHandoff.steps("Muse", kind: k)
      XCTAssertGreaterThanOrEqual(st.count, 4)
      XCTAssertTrue(st.last!.contains("Face ID"), st.last!)
      XCTAssertTrue(st.last!.contains("才生效") || st.last!.contains("Only then"), st.last!)
      XCTAssertTrue(st.contains { $0.contains("登录链接") || $0.contains("sign-in link") })
    }
    XCTAssertTrue(ConnectHandoff.steps("Muse", kind: .muse)[1].contains("粘贴") || ConnectHandoff.steps("Muse", kind: .muse)[1].contains("Paste"))
  }
  func testButtonNamesTheApp() {
    XCTAssertTrue(ConnectHandoff.button("Grok", kind: .prefill).contains("Grok"))
    XCTAssertTrue(ConnectHandoff.button("Muse", kind: .muse).contains("Muse"))
  }
}
