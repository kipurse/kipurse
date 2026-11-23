import XCTest

/// t1062/t1063: AI 生活 top four glass beads — horizontal alignment + connected FX fixture + welcome bead recipe.
final class T1062BeadsUITests: XCTestCase {
  var app: XCUIApplication!
  func launch(_ args: [String]) {
    var a = args
    if let i = a.firstIndex(of: "-kp.lang"), i + 1 < a.count {
      let l = a[i + 1] == "zh" ? "zh-Hans" : "en"
      a += ["-AppleLanguages", "(\(l))", "-AppleLocale", l == "en" ? "en_US" : "zh_CN"]
    }
    app = XCUIApplication(); app.launchArguments = a; app.launch()
  }
  func shot(_ name: String) {
    let s = app.screenshot(); let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
    try? FileManager.default.createDirectory(atPath: "/tmp/t1062shots", withIntermediateDirectories: true)
    try? s.pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/t1062shots/\(name).png"))
  }

  /// Demo main has Grok online (connected) among four agents — assert cells exist and capture aligned row.
  @MainActor func testLifeBeadsAlignedWithConnectedFixture() {
    executionTimeAllowance = 180
    for lang in ["zh", "en"] {
      launch(["-demo", "main", "-tab", "life", "-kp.lang", lang, "-kpSkipFaceID", "-kpLifeDemo"])
      XCTAssertTrue(app.staticTexts["life.title"].waitForExistence(timeout: 12), "life title \(lang)")
      var cellFrames: [CGRect] = []
      var logoFrames: [CGRect] = []
      for n in ["muse", "grok", "claude", "siri"] {
        let e = app.descendants(matching: .any)["life.agent.\(n)"]
        XCTAssertTrue(e.waitForExistence(timeout: 8), "\(lang) \(n)")
        cellFrames.append(e.frame)
        let logo = app.descendants(matching: .any)["agent.logo.\(n)"]
        XCTAssertTrue(logo.waitForExistence(timeout: 5), "\(lang) logo \(n)")
        logoFrames.append(logo.frame)
      }
      // Bead centers (logo midY / midX gaps) — authoritative for visual row neatness
      let mids = logoFrames.map(\.midY)
      let midDelta = (mids.max() ?? 0) - (mids.min() ?? 0)
      XCTAssertLessThanOrEqual(midDelta, 1.5, "\(lang) logo midY delta \(midDelta) logos=\(logoFrames)")
      let logoXs = logoFrames.map(\.midX).sorted()
      let logoGaps = zip(logoXs, logoXs.dropFirst()).map { $1 - $0 }
      if let gmin = logoGaps.min(), let gmax = logoGaps.max() {
        XCTAssertLessThanOrEqual(gmax - gmin, 8.0, "\(lang) unequal logo gaps \(logoGaps)")
      }
      // Cell accessibility frames can grow slightly for the lit bead's halo; do not gate on cell.minY
      XCTAssertEqual(cellFrames.count, 4)
      // Grok is online in main demo — accessibility must say Online / 在线
      let grok = app.descendants(matching: .any)["life.agent.grok"].label
      XCTAssertTrue(grok.contains(lang == "zh" ? "在线" : "Online"), "connected fixture grok: \(grok)")
      sleep(1)
      shot("t1062-life-\(lang)")
      app.terminate()
    }
  }

  /// Reduce Motion: life page still loads; no crash; beads present (static path).
  @MainActor func testLifeBeadsReduceMotionStill() {
    executionTimeAllowance = 120
    launch(["-demo", "main", "-tab", "life", "-kp.lang", "zh", "-kpSkipFaceID", "-kpStill", "-kpLifeDemo"])
    XCTAssertTrue(app.staticTexts["life.title"].waitForExistence(timeout: 12))
    for n in ["muse", "grok", "claude", "siri"] {
      XCTAssertTrue(app.descendants(matching: .any)["life.agent.\(n)"].waitForExistence(timeout: 6), n)
    }
    sleep(1); shot("t1062-life-zh-reducemotion")
    app.terminate()
  }
}
