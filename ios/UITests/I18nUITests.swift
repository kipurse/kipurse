import XCTest

/// Owner rule: the app follows the iPhone language. English -> zero Chinese characters on any screen; Chinese -> no "中文 / English" duplicates.
/// Sweeps the main screens (demo data) + sign-in + new-user onboarding in both languages and saves screenshots to /tmp/kp-i18n.
final class I18nUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = true; try? FileManager.default.createDirectory(atPath: "/tmp/kp-i18n", withIntermediateDirectories: true) }
  static let cjk = try! NSRegularExpression(pattern: "[\\u3000-\\u303F\\u3400-\\u9FFF\\uFF00-\\uFFEF]")
  static func hasCJK(_ s: String) -> Bool { cjk.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil }
  /// Data the user typed / AI agents wrote (names, merchant text) is shown as-is; everything else must be in the screen language.
  static let userData = ["测试店"]
  func labels() -> [String] {
    var out: [String] = []
    for q in [app.staticTexts, app.buttons, app.textFields, app.switches, app.links] {
      for e in q.allElementsBoundByIndex where e.exists { out.append(e.label); if let v = e.placeholderValue { out.append(v) } }
    }
    return out.filter { !$0.isEmpty }
  }
  func check(_ lang: String, _ where_: String) {
    let ls = labels()
    if lang == "en" {
      // "、" is the separator iOS itself uses when combining accessibility labels on a Chinese-language device; not app text.
      let bad = ls.map { $0.replacingOccurrences(of: "\u{3001}", with: ", ") }.filter { s in Self.hasCJK(s) && !Self.userData.contains(where: { s.contains($0) }) }
      XCTAssertEqual(bad, [], "\(where_): Chinese on an English screen")
    } else {
      let bad = ls.filter { s in Self.hasCJK(s) && (s.contains(" / ") || s.range(of: "[\\u4E00-\\u9FFF][^\\n]*\\n[A-Z][a-z]+ [a-z]+ [a-z]+", options: .regularExpression) != nil)
        && s.range(of: "[A-Za-z]{3,} [a-z]{3,} [a-z]{3,}", options: .regularExpression) != nil }
      XCTAssertEqual(bad, [], "\(where_): bilingual text on a Chinese screen")
      XCTAssertTrue(ls.contains(where: Self.hasCJK), "\(where_): Chinese screen shows no Chinese")
    }
  }
  func shot(_ name: String) {
    let s = app.screenshot(); let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
    try? s.pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/kp-i18n/\(name).png"))
  }
  func launch(_ args: [String]) {   // t803: the phone's own language too (system back button), as on a real phone where kp.lang = system language
    var a = args; if let i = a.firstIndex(of: "-kp.lang"), i + 1 < a.count { let l = a[i + 1] == "zh" ? "zh-Hans" : "en"; a += ["-AppleLanguages", "(\(l))", "-AppleLocale", l == "en" ? "en_US" : "zh_CN"] }
    app = XCUIApplication(); app.launchArguments = a; app.launch() }

  func testScreensFollowLanguage() {
    executionTimeAllowance = 1500   // t800
    for lang in ["en", "zh"] {
      for (demo, tab) in [("main-new", "home"), ("main", "home"), ("main", "agents"), ("main", "settings"), ("main-all", "agents"), ("main-empty", "home"), ("main-connect", "home")] {
        launch(["-demo", demo, "-tab", tab, "-kp.lang", lang, "-kpSkipFaceID"])
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10) || app.buttons.firstMatch.waitForExistence(timeout: 5))
        sleep(1); check(lang, "\(demo)/\(tab)")
        if tab == "settings" { for _ in 0..<3 { app.swipeUp(); check(lang, "\(demo)/\(tab) scrolled") } }
        if demo == "main-new" { shot("home-guide-\(lang)") }
        app.terminate()
      }
    }
  }
}

/// Shared language checks for UI tests.
enum I18nCheck {
  static func check(_ app: XCUIApplication, _ lang: String, _ w: String) {
    var ls: [String] = []
    for q in [app.staticTexts, app.buttons, app.textFields] { for e in q.allElementsBoundByIndex where e.exists { ls.append(e.label) } }
    if lang == "en" { XCTAssertEqual(ls.filter(I18nUITests.hasCJK), [], "\(w): Chinese on an English screen") }
    else { XCTAssertTrue(ls.contains(where: I18nUITests.hasCJK), "\(w): no Chinese"); XCTAssertEqual(ls.filter { I18nUITests.hasCJK($0) && $0.contains(" / ") && $0.range(of: "[A-Za-z]{3,} [a-z]{3,} [a-z]{3,}", options: .regularExpression) != nil }, [], "\(w): bilingual") }
  }
}
