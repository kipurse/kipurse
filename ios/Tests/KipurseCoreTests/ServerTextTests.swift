import XCTest
@testable import KipurseCore

final class ServerTextTests: XCTestCase {
  override func tearDown() { Loc.override = nil }
  func testKnownCodesFollowLanguage() {
    Loc.override = "zh"; XCTAssertEqual(ServerText.text(code: "not_owner"), "这个确认不是来自钱包主人的账户，什么都没改。")
    Loc.override = "en"; XCTAssertEqual(ServerText.text(code: "not_owner"), "That signature isn't from this wallet's owner. Nothing changed.")
  }
  func testNoMixedLanguageAndNoRawDetail() {
    for lang in ["zh", "en"] { Loc.override = lang
      for (c, _) in ServerText.map {
        let t = ServerText.text(code: c)
        let cjk = t.range(of: #"\p{Han}"#, options: .regularExpression) != nil
        XCTAssertEqual(cjk, lang == "zh", "\(lang) \(c): \(t)")
      }
      let u = ServerText.text(code: "signature is not from the wallet owner", status: 401)
      XCTAssertFalse(u.contains("signature is not"), "raw server text never shown")
      XCTAssertEqual(u.range(of: #"\p{Han}"#, options: .regularExpression) != nil, lang == "zh")
    }
  }
  func testUnknownCodeKeepsShortReference() {
    Loc.override = "en"; XCTAssertTrue(ServerText.text(code: "weird_code", status: 500).hasSuffix(" (weird_code)"))
    Loc.override = "zh"; XCTAssertTrue(ServerText.text(code: nil, status: 503).hasSuffix("（503）"))
  }
}
