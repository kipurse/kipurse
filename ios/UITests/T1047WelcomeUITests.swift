import XCTest
import UIKit

final class T1047WelcomeUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }
  private func launch(_ lang: String, extra: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-kpFreshInstall", "-kp.lang", lang, "-kpOnboard", "-kpSigninMock", "new", "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"] + extra
    app.launch()
    XCTAssertTrue(app.buttons["cb.signin"].waitForExistence(timeout: 15))
    return app
  }
  private func layout(_ lang: String, reduced: Bool = false) {
    let app = launch(lang, extra: reduced ? ["-kpReduceMotion"] : [])
    defer { app.terminate() }
    let title = app.staticTexts["cb.title"], signup = app.buttons["cb.register"], signin = app.buttons["cb.signin"], demo = app.buttons["gate.demo"]
    let hero = app.descendants(matching: .any).matching(identifier: "cb.hero").firstMatch
    XCTAssertTrue(hero.exists)
    // t1049: the hero describes the shared purse and real agents, never a robot stand-in.
    XCTAssertFalse(hero.label.lowercased().contains("robot"))
    XCTAssertFalse(hero.label.contains("机器人"))
    XCTAssertTrue(hero.label.contains(lang == "zh" ? "Muse、Grok、Claude、Siri 环绕共用一个琉璃钱包" : "Muse, Grok, Claude and Siri orbit one shared glass purse"))
    XCTAssertGreaterThan(hero.frame.width, 250)
    XCTAssertGreaterThan(hero.frame.height, 170)
    XCTAssertEqual(hero.value as? String, reduced ? "still" : "animated")
    XCTAssertEqual(title.label, lang == "zh" ? "启付" : "Kipurse")
    XCTAssertTrue(signup.isHittable); XCTAssertTrue(signin.isHittable); XCTAssertFalse(demo.exists)
    XCTAssertGreaterThan(signup.frame.minY, app.frame.height * 0.60)
    XCTAssertGreaterThan(signup.frame.minY, hero.frame.maxY - 1)
    XCTAssertGreaterThan(hero.frame.minY, title.frame.maxY)
    XCTAssertGreaterThan(signin.frame.minY, signup.frame.maxY)
    XCTAssertLessThan(signin.frame.maxY, app.frame.maxY - 12)
    XCTAssertEqual(app.scrollViews.count, 0, "normal welcome must not be scroll-bound")
    I18nCheck.check(app, lang, "welcome")
    let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "t1049-\(lang)-\(reduced ? "still" : "animated")"; shot.lifetime = .keepAlways; add(shot)
    if !reduced {
      signup.tap()
      XCTAssertTrue(app.staticTexts["reg.title"].waitForExistence(timeout: 5))
      app.buttons["reg.back"].tap()
      XCTAssertTrue(signin.waitForExistence(timeout: 5))
      XCTAssertFalse(demo.exists)
      XCTAssertFalse(app.descendants(matching: .any).matching(identifier: "demo.banner").firstMatch.exists)
    }
  }
  func testChineseBottomActionsAndNavigation() { layout("zh") }
  func testEnglishBottomActionsAndNavigation() { layout("en") }
  func testChineseReduceMotionStillHero() { layout("zh", reduced: true) }
  func testEnglishReduceMotionStillHero() { layout("en", reduced: true) }
  private func state(_ lang: String, phase: String) {
    let app = launch(lang, extra: ["-kpLandingPhase", phase]); defer { app.terminate() }
    let id = phase == "waiting" ? "cb.pair" : "cb.failed"
    let text = app.staticTexts[id]
    XCTAssertTrue(text.waitForExistence(timeout: 5))
    if phase == "waiting" { XCTAssertEqual(text.label, "123456") }
    else { XCTAssertTrue(app.buttons["cb.retry"].isHittable) }
    XCTAssertTrue(app.buttons["cb.register"].isHittable)
    XCTAssertTrue(app.buttons["cb.signin"].isHittable)
    let demo = app.buttons["gate.demo"]
    XCTAssertFalse(demo.exists)
    I18nCheck.check(app, lang, phase)
  }
  func testChinesePairingUsable() { state("zh", phase: "waiting") }
  func testEnglishPairingUsable() { state("en", phase: "waiting") }
  func testChineseFailureUsable() { state("zh", phase: "failed") }
  func testEnglishFailureUsable() { state("en", phase: "failed") }
  private func largeText(_ lang: String) {
    let app = launch(lang, extra: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL", "-kpReduceMotion"])
    defer { app.terminate() }
    XCTAssertTrue(app.scrollViews.firstMatch.exists, "accessibility text uses scrolling instead of clipping")
    for id in ["cb.register", "cb.signin"] {
      let button = app.buttons[id]
      for _ in 0..<10 where !button.isHittable { app.swipeUp() }
      XCTAssertTrue(button.isHittable, id)
    }
    XCTAssertFalse(app.buttons["gate.demo"].exists)
    I18nCheck.check(app, lang, "accessibility welcome")
  }
  func testChineseAccessibilityTextControlsReachable() { largeText("zh") }
  func testEnglishAccessibilityTextControlsReachable() { largeText("en") }

  // t1048: verify rendered behavior, not just the accessibility state marker.
  private func heroPixels(_ app: XCUIApplication) -> Data? {
    let hero = app.descendants(matching: .any).matching(identifier: "cb.hero").firstMatch
    let image = app.screenshot().image
    let r = hero.frame.insetBy(dx: 3, dy: 3)
    let pixelRect = CGRect(x: r.minX * image.scale, y: r.minY * image.scale,
                           width: r.width * image.scale, height: r.height * image.scale)
    guard let crop = image.cgImage?.cropping(to: pixelRect) else { XCTFail("hero crop unavailable"); return nil }
    return UIImage(cgImage: crop).pngData()
  }
  func testChineseReducedHeroPixelsAreStatic() {
    let app = launch("zh", extra: ["-kpReduceMotion"]); defer { app.terminate() }
    let before = heroPixels(app)
    Thread.sleep(forTimeInterval: 0.6)
    XCTAssertNotNil(before)
    XCTAssertEqual(before, heroPixels(app), "Reduce Motion must be a fully static render")
  }
  func testEnglishAnimatedHeroPixelsChange() {
    let app = launch("en"); defer { app.terminate() }
    let before = heroPixels(app)
    Thread.sleep(forTimeInterval: 0.6)
    XCTAssertNotNil(before)
    XCTAssertNotEqual(before, heroPixels(app), "Official AI icons, orbit depth and glass caustics must animate")
  }

}
