// SPDX-License-Identifier: Apache-2.0
import XCTest

/// t1281 (handbook §6#141 ③): grant cards show the signed-but-hidden terms under their lines — by-site scope, full payee address,
/// which approval it replaces, remember or not, validity — built through the real approval() path from gateway sign texts (-kpGrantDemo). zh/en.
final class T1281CardDetailsUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  func launch(_ lang: String) {
    app = XCUIApplication()
    app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", lang, "-kpSkipFaceID", "-kpStill", "-kpGrantDemo",
                           "-AppleLanguages", lang == "zh" ? "(zh-Hans)" : "(en)", "-AppleLocale", lang == "zh" ? "zh_CN" : "en_US"]
    app.launch()
  }
  func reveal(_ e: XCUIElement) { var n = 0; while !e.isHittable && n < 8 { app.swipeUp(); n += 1 } }
  func shot(_ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
  func rows(_ id: String) -> [String] { app.staticTexts.matching(identifier: "allow.detail." + id).allElementsBoundByIndex.map(\.label) }
  static func hasCJK(_ s: String) -> Bool { s.range(of: "[\\u3000-\\u303F\\u3400-\\u9FFF\\uFF00-\\uFFEF]", options: .regularExpression) != nil }
  @MainActor func run(_ lang: String) {
    launch(lang)
    let card = app.descendants(matching: .any)["allow.card.pending"]; XCTAssertTrue(card.waitForExistence(timeout: 10)); reveal(card); card.tap()
    let site = app.staticTexts["allow.detail.site"]; XCTAssertTrue(site.waitForExistence(timeout: 6), "the by-site row is shown")
    let zh = lang == "zh"
    let sites = rows("site"), payees = rows("payee"), reps = rows("replaces"), rem = rows("remember"), exp = rows("expires")
    XCTAssertTrue(sites.contains(zh ? "按网站：只要是 notion.so 上的收款方都算（不只上面的收款地址）" : "By site: any payee on notion.so counts (not only the payee address above)"), "\(sites)")
    XCTAssertTrue(sites.contains { $0.contains("shop.example.com") }, "oneOff.host is shown even with a payee: \(sites)")
    XCTAssertTrue(payees.contains((zh ? "收款地址：" : "Payee address: ") + "0x 1111 1111 1111 1111 1111 1111 1111 1111 1111 2222"), "\(payees)")
    XCTAssertTrue(payees.contains { $0.hasSuffix("0x 3333 3333 3333 3333 3333 3333 3333 3333 3333 4444") }, "\(payees)")
    XCTAssertEqual(reps, [zh ? "会替换你之前批准的一项（mnd_9f…5b4a）" : "Replaces one you approved before (mnd_9f…5b4a)"])
    XCTAssertEqual(rem, [zh ? "批准后记住这个收款方，以后它不算新收款方" : "After approval this payee is remembered and no longer counts as new"])
    XCTAssertTrue(exp.contains(zh ? "有效 90 天" : "Valid for 90 days"), "\(exp)")
    XCTAssertTrue(exp.contains(zh ? "只能用一次，1 天内有效" : "Single use, valid for 1 day"), "\(exp)")
    for l in sites + payees + reps + rem + exp { XCTAssertEqual(Self.hasCJK(l), zh, l); if zh { XCTAssertFalse(l.contains(" / "), l) } }
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", zh ? "不一致" : "doesn't match")).firstMatch.exists, "the fixture texts pass the phone's checks")
    shot("\(lang)-grant-details")
  }
  @MainActor func testGrantCardDetailsZh() { run("zh") }
  @MainActor func testGrantCardDetailsEn() { run("en") }
}
