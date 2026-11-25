import XCTest

/// t1068: AI [zh] root titles share one Y (top-aligned).
final class T1068TitleAlignUITests: XCTestCase {
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
    try? FileManager.default.createDirectory(atPath: "/tmp/t1068shots", withIntermediateDirectories: true)
    try? s.pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/t1068shots/\(name).png"))
  }
  func titleMinY(_ id: String, timeout: TimeInterval = 12) -> CGFloat {
    let el = app.staticTexts[id]
    XCTAssertTrue(el.waitForExistence(timeout: timeout), "missing \(id)")
    return el.frame.minY
  }

  @MainActor func testRootTitlesAlignedZh() {
    executionTimeAllowance = 180
    launch(["-demo", "main", "-tab", "life", "-kp.lang", "zh", "-kpSkipFaceID", "-kpLifeDemo"])
    let lifeY = titleMinY("life.title")
    sleep(1); shot("t1068-life-zh")
    app.terminate()

    launch(["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpSkipFaceID"])
    let walletY = titleMinY("wallet.title")
    sleep(1); shot("t1068-wallet-zh")
    app.terminate()

    launch(["-demo", "main", "-tab", "settings", "-kp.lang", "zh", "-kpSkipFaceID"])
    let settingsY = titleMinY("settings.title")
    // settings still usable (list rows)
    XCTAssertTrue(
      app.staticTexts["安全小贴士"].waitForExistence(timeout: 4)
      || app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "手机丢了")).firstMatch.waitForExistence(timeout: 4)
      || app.tabBars.buttons.matching(NSPredicate(format: "label CONTAINS %@", "设置")).firstMatch.exists,
      "settings body visible")
    sleep(1); shot("t1068-settings-zh")
    app.terminate()

    XCTAssertEqual(lifeY, walletY, accuracy: 2.0, "life vs wallet title Y: \(lifeY) vs \(walletY)")
    XCTAssertEqual(lifeY, settingsY, accuracy: 2.0, "life vs settings title Y: \(lifeY) vs \(settingsY)")
    XCTAssertEqual(walletY, settingsY, accuracy: 2.0, "wallet vs settings title Y: \(walletY) vs \(settingsY)")
  }

  @MainActor func testRootTitlesAlignedEn() {
    executionTimeAllowance = 180
    launch(["-demo", "main", "-tab", "life", "-kp.lang", "en", "-kpSkipFaceID", "-kpLifeDemo"])
    let lifeY = titleMinY("life.title")
    sleep(1); shot("t1068-life-en")
    app.terminate()

    launch(["-demo", "main", "-tab", "home", "-kp.lang", "en", "-kpSkipFaceID"])
    let walletY = titleMinY("wallet.title")
    sleep(1); shot("t1068-wallet-en")
    app.terminate()

    launch(["-demo", "main", "-tab", "settings", "-kp.lang", "en", "-kpSkipFaceID"])
    let settingsY = titleMinY("settings.title")
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Safety")).firstMatch.waitForExistence(timeout: 4)
      || app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Lost")).firstMatch.waitForExistence(timeout: 4)
      || app.tabBars.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Settings")).firstMatch.exists,
      "settings en body")
    sleep(1); shot("t1068-settings-en")
    app.terminate()

    XCTAssertEqual(lifeY, walletY, accuracy: 2.0, "en life vs wallet: \(lifeY) vs \(walletY)")
    XCTAssertEqual(lifeY, settingsY, accuracy: 2.0, "en life vs settings: \(lifeY) vs \(settingsY)")
  }
}
