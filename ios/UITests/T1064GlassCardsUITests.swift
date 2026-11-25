import XCTest

/// t1064: all cards use shared premium glass — smoke life / wallet / settings + screenshots.
final class T1064GlassCardsUITests: XCTestCase {
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
    try? FileManager.default.createDirectory(atPath: "/tmp/t1064shots", withIntermediateDirectories: true)
    try? s.pngRepresentation.write(to: URL(fileURLWithPath: "/tmp/t1064shots/\(name).png"))
  }

  @MainActor func testGlassCardsLifeWalletSettingsZh() {
    executionTimeAllowance = 180
    launch(["-demo", "main", "-tab", "life", "-kp.lang", "zh", "-kpSkipFaceID", "-kpLifeDemo"])
    XCTAssertTrue(app.staticTexts["life.title"].waitForExistence(timeout: 12))
    // t1065: month · AI-online eyebrow gone
    XCTAssertFalse(app.descendants(matching: .any)["life.online"].exists, "life.online eyebrow must be removed")
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "在线打理")).firstMatch.exists)
    sleep(1); shot("t1064-life-zh")
    app.terminate()

    launch(["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpSkipFaceID"])
    // wallet tab may be tagged home or wallet
    let bal = app.descendants(matching: .any)["balance.label"]
    let bal2 = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "启付")).firstMatch
    XCTAssertTrue(bal.waitForExistence(timeout: 10) || bal2.waitForExistence(timeout: 4), "wallet balance")
    sleep(1); shot("t1064-wallet-zh")
    app.terminate()

    launch(["-demo", "main", "-tab", "settings", "-kp.lang", "zh", "-kpSkipFaceID"])
    let settings = app.navigationBars.matching(NSPredicate(format: "identifier CONTAINS[c] %@ OR label CONTAINS %@", "设置", "设置")).firstMatch
    let gear = app.tabBars.buttons.matching(NSPredicate(format: "label CONTAINS %@", "设置")).firstMatch
    XCTAssertTrue(settings.waitForExistence(timeout: 8) || gear.waitForExistence(timeout: 4) || app.staticTexts["安全小贴士"].waitForExistence(timeout: 4) || app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "手机丢了")).firstMatch.waitForExistence(timeout: 4), "settings visible")
    sleep(1); shot("t1064-settings-zh")
    app.terminate()
  }

  @MainActor func testGlassCardsLifeWalletSettingsEn() {
    executionTimeAllowance = 180
    launch(["-demo", "main", "-tab", "life", "-kp.lang", "en", "-kpSkipFaceID", "-kpLifeDemo"])
    XCTAssertTrue(app.staticTexts["life.title"].waitForExistence(timeout: 12))
    XCTAssertFalse(app.descendants(matching: .any)["life.online"].exists, "life.online eyebrow must be removed")
    XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "ON DUTY")).firstMatch.exists)
    sleep(1); shot("t1064-life-en")
    app.terminate()

    launch(["-demo", "main", "-tab", "home", "-kp.lang", "en", "-kpSkipFaceID"])
    let bal = app.descendants(matching: .any)["balance.label"]
    XCTAssertTrue(bal.waitForExistence(timeout: 10), "wallet balance en")
    sleep(1); shot("t1064-wallet-en")
    app.terminate()

    launch(["-demo", "main", "-tab", "settings", "-kp.lang", "en", "-kpSkipFaceID"])
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Safety")).firstMatch.waitForExistence(timeout: 8)
      || app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "Lost")).firstMatch.waitForExistence(timeout: 4)
      || app.tabBars.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "Settings")).firstMatch.waitForExistence(timeout: 4),
      "settings en")
    sleep(1); shot("t1064-settings-en")
    app.terminate()
  }
}
