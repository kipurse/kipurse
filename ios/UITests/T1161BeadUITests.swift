import XCTest

/// t1164 (decision 79): every connected AI bead (Muse / Grok / Claude / Siri) is always lit [zh] — just used, used 6 min ago, or never used —
/// also with duplicate / renamed rows; a disconnected AI shows [zh]·[zh] never appears.
final class T1161BeadUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  func launch(_ lang: String, ages: String, extra: [String] = []) {
    app = XCUIApplication()
    app.launchArguments = ["-demo", "main-nomuse", "-tab", "life", "-kp.lang", lang, "-kpSkipFaceID", "-kpStill", "-kpBeadAges", ages,
                           "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"] + extra
    app.launch()
  }
  func label(_ key: String) -> String {
    let e = app.descendants(matching: .any)["life.agent.\(key)"]; XCTAssertTrue(e.waitForExistence(timeout: 12), key); return e.label
  }
  let names = ["muse": "Muse", "grok": "Grok", "claude": "Claude", "siri": "Siri"]
  func check(_ lang: String, lit: [String], off: [String] = []) {
    let on = lang == "zh" ? "在线" : "Online", no = lang == "zh" ? "未连接" : "Offline", idle = lang == "zh" ? "未在线" : "idle"
    for k in lit { let l = label(k); XCTAssertTrue(l.hasPrefix("\(names[k]!), \(on)"), "\(k) should be lit: \(l)"); XCTAssertFalse(l.contains(idle), l) }
    for k in off { let l = label(k); XCTAssertTrue(l.hasPrefix("\(names[k]!), \(no)"), "\(k) should be 未连接: \(l)") }
  }
  @MainActor func run(_ lang: String) {
    let all = ["muse", "grok", "claude", "siri"]
    launch(lang, ages: "muse=0,grok=360,claude=0,siri=360"); check(lang, lit: all); app.terminate()
    launch(lang, ages: "muse=360,grok=0,claude=360,siri=0"); check(lang, lit: all); app.terminate()
    launch(lang, ages: "none"); check(lang, lit: all); app.terminate()   // connected, never used
    launch(lang, ages: "muse=360,grok=360,claude=360,siri=360", extra: ["-kpBeadOff"]); check(lang, lit: [], off: all)
  }
  @MainActor func testT1161BeadsZh() { run("zh") }
  @MainActor func testT1161BeadsEn() { run("en") }
}
