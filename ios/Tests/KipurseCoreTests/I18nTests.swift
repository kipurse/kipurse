import XCTest
@testable import KipurseCore

/// Owner rule: English system -> 100% English (zero CJK); Chinese system -> Chinese only, no "zh / en" duplicates.
final class I18nTests: XCTestCase {
  static let cjk = try! NSRegularExpression(pattern: "[\\u3000-\\u303F\\u3400-\\u9FFF\\uFF00-\\uFFEF]")
  static func hasCJK(_ s: String) -> Bool { cjk.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil }
  /// "中文 / English" style: a CJK part and a Latin sentence part separated by " / " or a newline.
  static func bilingual(_ s: String) -> Bool {
    for sep in [" / ", "\n"] { let parts = s.components(separatedBy: sep); if parts.count > 1, parts.contains(where: hasCJK),
      parts.contains(where: { !hasCJK($0) && $0.range(of: "[A-Za-z]{3,} [A-Za-z]{3,}", options: .regularExpression) != nil }) { return true } }
    return false }
  func testEveryLKeyHasEnglish() {
    let bad = I18nKeys.L.filter { Self.hasCJK(Loc.english($0)) }
    XCTAssertEqual(bad, [], "L() keys without an English translation:\n" + bad.joined(separator: "\n"))
  }
  func testTEnglishHasNoCJK() {
    let bad = I18nKeys.T.filter { Self.hasCJK($0.1) }.map { $0.1 }
    XCTAssertEqual(bad, [])
  }
  func testDictionaryEnglishHasNoCJK() {
    let bad = Loc.en.values.filter { Self.hasCJK($0) }
    XCTAssertEqual(bad, [])
  }
  /// Regenerate with: python3 ../tools/i18n_scan.py . > /tmp/scan.json && python3 ../tools/gen_i18n_test.py /tmp/scan.json Tests/KipurseCoreTests/I18nKeys.swift
  func testNoRawChineseLiterals() { XCTAssertEqual(I18nKeys.raw, []) }
  func testEnglishRendersOfCoreTextHaveNoCJK() {
    Loc.override = "en"; defer { Loc.override = nil }
    var out: [String] = []
    for k in AnswerRules.usdcKeys { for raw in ["", "-1", "abc", "3,5", "1.1234567"] { out.append(AnswerRules.usdcError(k, raw) ?? "") } }
    out += [AnswerRules.termError("") ?? "", AnswerRules.termError("x") ?? "", AnswerRules.termError("999") ?? "", AddressCheck.error("") ?? "", AddressCheck.error("bc1qxyz") ?? "", AddressCheck.error("0x12") ?? ""]
    out += AnswerRules.check(["perPayment": "10", "perDay": "5", "termTotal": "1", "termDays": "30"]).errors.map(\.zh)
    let bad = out.filter(Self.hasCJK); XCTAssertEqual(bad, [])
  }
  func testServerPagesGetLang() {
    Loc.override = "en"; defer { Loc.override = nil }
    XCTAssertEqual(Loc.withLang(URL(string: "https://pay.kipurse.com/signin?x=1&lang=zh")!).absoluteString, "https://pay.kipurse.com/signin?x=1&lang=en")
    XCTAssertEqual(Loc.withLang(URL(string: "http://10.0.0.5:8787/a")!, servers: ["http://10.0.0.5:8787"]).absoluteString, "http://10.0.0.5:8787/a?lang=en")
    XCTAssertEqual(Loc.withLang(URL(string: "https://keys.coinbase.com/x")!).absoluteString, "https://keys.coinbase.com/x")
    Loc.override = "zh"; XCTAssertTrue(Loc.withLang(URL(string: "https://pay.kipurse.com/d")!).absoluteString.hasSuffix("lang=zh"))
  }
  func testChineseHasNoBilingualDuplicates() {
    let bad = (I18nKeys.L + I18nKeys.T.map { $0.0 }).filter(Self.bilingual)
    XCTAssertEqual(bad, [], "zh strings that also carry English:\n" + bad.joined(separator: "\n"))
  }
}
