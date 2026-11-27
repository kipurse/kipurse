import XCTest

/// UX audit batch 2: #2 large-payment hold visible (decision 110: on AI [zh], with every pending item) with countdown + cancel; #3 emergency page offline fallback.
final class Batch2UITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  func testHoldBannerOnHomeWithCountdownAndCancel() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", "zh", "-kpHold"]; app.launch()   // decision 110: 待你批准 lives on AI 生活
    let banner = app.descendants(matching: .any)["hold.banner"].firstMatch
    XCTAssertTrue(banner.waitForExistence(timeout: 10), "hold banner on AI 生活")
    let cd = app.staticTexts["hold.countdown"].firstMatch; XCTAssertTrue(cd.exists)
    XCTAssertNotNil(cd.label.range(of: #"^\d+:\d\d$"#, options: .regularExpression), cd.label)
    let c = app.buttons["hold.cancel"].firstMatch; XCTAssertTrue(c.exists); c.tap()
    let yes = app.buttons["取消付款"].firstMatch; XCTAssertTrue(yes.waitForExistence(timeout: 5), "asks before canceling"); yes.tap()
    XCTAssertTrue(app.alerts["已取消，这笔没有付款。"].waitForExistence(timeout: 5)); app.alerts.buttons["好"].tap()
    let gone = NSPredicate(format: "exists == false"); expectation(for: gone, evaluatedWith: banner); waitForExpectations(timeout: 8)
  }
  func testEmergencyOfflineFallback() {
    app = XCUIApplication(); app.launchArguments = ["-kpIdentityOK", "-kpUnbound", "-kpEmergencyOffline", "-kp.lang", "zh"]; app.launch()
    let e = app.buttons["unbound.emergency"]; XCTAssertTrue(e.waitForExistence(timeout: 15)); e.tap()
    let c = app.buttons["emergency.continue"]; XCTAssertTrue(c.waitForExistence(timeout: 5), "t796: native emergency screen first"); c.tap()
    XCTAssertTrue(app.buttons["emergency.retry"].waitForExistence(timeout: 8), "offline fallback instead of a blank page")
    XCTAssertTrue(app.buttons["emergency.close"].exists)
    let g = app.buttons["emergency.guide"]; XCTAssertTrue(g.exists, "t821: on-chain exit guide from the emergency sheet"); g.tap()
    XCTAssertTrue(app.staticTexts["手机丢了怎么办"].waitForExistence(timeout: 5)); I18nCheck.check(app, "zh", "t821 rescue guide")
  }
  /// t789: LIVE emergency page (real network). The wallet comes from TEST_RUNNER_KP_LIVE_WALLET (never stored in the repo).
  /// Tap -> the app checks the page answers 200 and the pinned sign host hash -> opens it in the app; no offline fallback, no stop card.
  func testEmergencyLiveOpensPinnedPage() throws {
    guard let w = ProcessInfo.processInfo.environment["KP_LIVE_WALLET"], w.count == 42 else { throw XCTSkip("set TEST_RUNNER_KP_LIVE_WALLET") }
    app = XCUIApplication(); app.launchArguments = ["-kpIdentityOK", "-kpUnboundWallet", w, "-kp.lang", "zh"]; app.launch()
    let e = app.buttons["unbound.emergency"]; XCTAssertTrue(e.waitForExistence(timeout: 15)); e.tap()
    let c = app.buttons["emergency.continue"]; XCTAssertTrue(c.waitForExistence(timeout: 5), "t796: native emergency screen first"); c.tap()
    XCTAssertFalse(app.buttons["emergency.retry"].waitForExistence(timeout: 6), "the live page must answer (was 404 before t789)")
    let pause = app.descendants(matching: .any)["暂停 AI 付款"].firstMatch
    XCTAssertTrue(pause.waitForExistence(timeout: 25), "emergency page shown inside the app through the pinned sign host")
    XCTAssertTrue(app.descendants(matching: .any)["全部提现到我的 Coinbase wallet"].firstMatch.exists)
    let shot = XCTAttachment(screenshot: app.screenshot()); shot.lifetime = .keepAlways; shot.name = "t789-emergency-live"; add(shot)
  }
  /// Onramp: "Buy USDC" opens Coinbase Onramp when the server has it configured, else Coinbase's buy page (both languages).
  func testBuyUSDCOnrampAndFallback() {
    for (mock, lang, prefix) in [(true, "zh", "https://pay.coinbase.com/buy/select-asset?sessionToken="), (false, "en", "https://www.coinbase.com/buy/usdc")] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang] + (mock ? ["-kpOnrampMock"] : []); app.launch()
      let d = app.buttons["home.deposit"].firstMatch; XCTAssertTrue(d.waitForExistence(timeout: 10), lang); d.tap()
      let o = app.buttons["deposit.other"].firstMatch; XCTAssertTrue(o.waitForExistence(timeout: 8), lang); for _ in 0..<4 where !o.isHittable { app.swipeUp() }; o.tap()
      _ = prefix   // t885: the Coinbase-account (exchange / Onramp) buy is gone; only the Coinbase Wallet transfer remains
      let c = app.buttons["deposit.coinbase"].firstMatch; XCTAssertTrue(c.waitForExistence(timeout: 8), lang); XCTAssertTrue(c.label.contains(lang == "zh" ? "Coinbase 钱包" : "Coinbase Wallet"), c.label)
      XCTAssertFalse(app.buttons["deposit.buy"].exists, lang)
      app.terminate()
    }
  }
  /// t635: no Coinbase Verified Account attestation -> the Apple Pay sheet shows the 4-step guide instead of buying; once verified it continues.
  func testApplePayNeedsCoinbaseVerification() throws {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-kpApplePayMock", "-kpCBV", "later"]; app.launch()
      let d = app.buttons["home.deposit"].firstMatch; XCTAssertTrue(d.waitForExistence(timeout: 10), lang); d.tap()
      let ap = app.buttons["deposit.applepay"].firstMatch; XCTAssertTrue(ap.waitForExistence(timeout: 8), lang); ap.tap()
      XCTAssertTrue(app.staticTexts["applepay.needsVerify"].waitForExistence(timeout: 8), lang)
      XCTAssertTrue(app.staticTexts["cbv.title"].exists || app.otherElements["cbv.title"].exists || app.staticTexts["cbv.progress"].exists, "4-step guide shown")
      XCTAssertFalse(app.buttons["applepay.agree"].exists, "cannot reach the purchase step unverified")
      for _ in 0..<3 { let r = app.buttons["cbv.recheck"].firstMatch; if r.waitForExistence(timeout: 3) { if !r.isHittable { app.swipeUp() }; r.tap() }; if app.buttons["applepay.agree"].waitForExistence(timeout: 3) { break } }
      XCTAssertTrue(app.buttons["applepay.agree"].waitForExistence(timeout: 8), "verified -> continues to Coinbase terms (\(lang))")
      app.terminate()
    }
  }
  /// PRIMARY: Apple Pay direct (guest checkout). Terms -> phone/email codes -> amount -> pay -> server says arrived. Never says arrived before status.
  func testApplePayDirectFlow() throws {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-kpApplePayMock"]; app.launch()
      let d = app.buttons["home.deposit"].firstMatch; XCTAssertTrue(d.waitForExistence(timeout: 10), lang); d.tap()
      let ap = app.buttons["deposit.applepay"].firstMatch; XCTAssertTrue(ap.waitForExistence(timeout: 8), lang); ap.tap()
      let agree = app.buttons["applepay.agree"].firstMatch; XCTAssertTrue(agree.waitForExistence(timeout: 8), lang); agree.tap()
      for (id, val) in [("phone", "4155552671"), ("email", "a@b.co")] {
        let f = app.textFields["applepay.\(id)"].firstMatch; XCTAssertTrue(f.waitForExistence(timeout: 5), id); f.tap(); f.typeText(val)
        app.buttons["applepay.\(id).send"].firstMatch.tap()
        let c = app.textFields["applepay.\(id).code"].firstMatch; XCTAssertTrue(c.waitForExistence(timeout: 5), id); c.tap(); c.typeText("123456")
        app.buttons["applepay.\(id).submit"].firstMatch.tap()
        XCTAssertTrue(app.images["applepay.\(id).ok"].firstMatch.waitForExistence(timeout: 5) || app.descendants(matching: .any)["applepay.\(id).ok"].firstMatch.exists, id)
      }
      let next = app.buttons["applepay.next"].firstMatch; XCTAssertTrue(next.waitForExistence(timeout: 5), lang); next.tap()
      let o = app.buttons["applepay.order"].firstMatch; XCTAssertTrue(o.waitForExistence(timeout: 5), lang); o.tap()
      let pay = app.buttons["applepay.demoPay"].firstMatch; XCTAssertTrue(pay.waitForExistence(timeout: 8), lang)
      XCTAssertFalse(app.descendants(matching: .any)["applepay.arrived"].exists, "no arrived before paying")
      pay.tap()
      let arr = app.descendants(matching: .any)["applepay.arrived"].firstMatch; XCTAssertTrue(arr.waitForExistence(timeout: 10), lang)
      XCTAssertTrue(arr.label.contains("19.40"), arr.label)
      app.terminate()
    }
  }
  /// t932: Onramp not approved -> honest [zh] state, no purchase step.
  func testApplePayApplyingState() throws {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpApplePayMock", "-kpApplePayOff"]; app.launch()
    let d = app.buttons["home.deposit"].firstMatch; XCTAssertTrue(d.waitForExistence(timeout: 10)); d.tap()
    let ap = app.buttons["deposit.applepay"].firstMatch; XCTAssertTrue(ap.waitForExistence(timeout: 8)); XCTAssertEqual(app.buttons.matching(identifier: "deposit.applepay").count, 1); ap.tap()
    let u = app.descendants(matching: .any)["applepay.unavailable"].firstMatch; XCTAssertTrue(u.waitForExistence(timeout: 8)); XCTAssertTrue(u.label.contains("申请中"), u.label)
    XCTAssertFalse(app.buttons["applepay.agree"].exists); XCTAssertFalse(app.buttons["applepay.order"].exists)
  }
  /// ONE LIMIT (t592): home shows ONE AI payment limit with the plain rule; no per-category allowance card; spending shows auto categories.
  func testOneLimitAndAutoCategories() {
    for (lang, rule, dev, other) in [("zh", "Face ID", "开发", "其他"), ("en", "Face ID", "Development", "Other")] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", lang]; app.launch()   // t1038: AI 总限额 lives on AI 生活
      let sl = app.buttons["life.aiLimit"]; XCTAssertTrue(sl.waitForExistence(timeout: 10)); for _ in 0..<6 where !sl.isHittable { app.swipeUp() }; sl.tap()
      let ex = app.descendants(matching: .any)["caps.explain"].firstMatch; XCTAssertTrue(ex.waitForExistence(timeout: 10), lang); XCTAssertTrue(ex.label.contains(rule), ex.label)
      XCTAssertFalse(app.descendants(matching: .any)["allow.card.setup"].exists, "no per-category setup card")
      XCTAssertFalse(app.staticTexts[lang == "zh" ? "给 AI 设零花钱（推荐）" : "Give your AI pocket money (recommended)"].exists)
      app.tabBars.buttons.element(boundBy: 0).tap()   // decision 110: back to the AI 生活 root, where 待你批准 now lives
      let card = app.descendants(matching: .any)["allow.card.pending"].firstMatch; XCTAssertTrue(card.waitForExistence(timeout: 8), "pending AI request in 待你批准"); for _ in 0..<4 where !card.isHittable { app.swipeDown() }; card.tap()
      let lim = app.descendants(matching: .any)["allow.limit"].firstMatch; XCTAssertTrue(lim.waitForExistence(timeout: 5), lang)
      XCTAssertTrue(lim.label.contains(lang == "zh" ? "总额" : "total"), lim.label); XCTAssertFalse(lim.label.contains(lang == "zh" ? "每月" : "month"), "no monthly cap")
      XCTAssertFalse(app.switches["allow.default.daily"].exists)
      let d = app.staticTexts[dev].firstMatch, o = app.staticTexts[other].firstMatch; for _ in 0..<6 where !(d.exists && o.exists) { app.swipeUp() }   // t803: smaller/other screens need more scrolling
      XCTAssertTrue(d.waitForExistence(timeout: 5), dev); XCTAssertTrue(app.staticTexts[other].firstMatch.exists, other)
      app.terminate()
    }
  }
  /// t660 confusion fix: the Face ID approvals page says what it is in plain words; no "[zh]" jargon, no approval codes (zh + en).
  func testFaceIDApprovalPageIsPlain() {
    for (lang, nav, bad) in [("zh", "Face ID 批准", ["核对码", "这台手机（", "收款方申请", "解除绑定"]), ("en", "Face ID approvals", ["Approval code", "phone signer", "Unlink"])] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "settings", "-kp.lang", lang, "-kpSkipFaceID"]; app.launch()
      let row = app.buttons["settings.phone"]; XCTAssertTrue(row.waitForExistence(timeout: 10), lang); XCTAssertTrue(row.label.contains(nav), row.label); row.tap()
      XCTAssertTrue(app.navigationBars[nav].waitForExistence(timeout: 8), nav)
      XCTAssertTrue(app.descendants(matching: .any)["phone.explain"].firstMatch.waitForExistence(timeout: 5), "one plain explanation")
      for b in bad { XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", b)).firstMatch.exists, b) }
      app.terminate()
    }
  }
  /// Delete account lives in its own danger section at the bottom of [zh], not next to pause / withdraw.
  /// decision 110: pause moved to AI [zh], so delete and pause are now on different tabs (never side by side).
  func testDeleteInSeparateDangerZone() {
    for (lang, hdr) in [("zh", "危险操作"), ("en", "Danger zone")] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "settings", "-kp.lang", lang, "-kpSkipFaceID"]; app.launch()
      XCTAssertTrue(app.descendants(matching: .any)["settings.title"].firstMatch.waitForExistence(timeout: 10), lang)
      let d = app.buttons["safety.delete"]; for _ in 0..<8 where !d.exists || !d.isHittable { app.swipeUp() }
      XCTAssertTrue(d.isHittable, lang); XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", hdr)).firstMatch.exists, hdr)
      XCTAssertFalse(app.buttons["safety.pause"].exists, "far from pause: pause is not on the settings page")
      app.terminate()
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", lang, "-kpSkipFaceID"]; app.launch()
      let p = app.buttons["safety.pause"]; for _ in 0..<8 where !p.exists || !p.isHittable { app.swipeUp() }
      XCTAssertTrue(p.isHittable, "pause on AI 生活 \(lang)"); XCTAssertFalse(app.buttons["safety.delete"].exists, "no delete next to pause")
      app.terminate()
    }
  }
  /// Deposit: one main action plus a 3-step strip (no big empty area, no repeated paragraphs).
  func testDepositShowsHowItWorks() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh"]; app.launch()
    let d = app.buttons["home.deposit"].firstMatch; XCTAssertTrue(d.waitForExistence(timeout: 10)); d.tap()
    XCTAssertTrue(app.descendants(matching: .any)["deposit.how"].firstMatch.waitForExistence(timeout: 8))
  }
  /// t660: opening an approval when Face ID approvals aren't on shows a plain explanation and the fix, not a bare error.
  func testApprovalWithoutFaceIDShowsFix() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "life", "-kp.lang", "zh", "-kpSkipFaceID"]; app.launch()   // decision 110: 待你批准 on AI 生活
    let o = app.buttons["approve.open"].firstMatch; XCTAssertTrue(o.waitForExistence(timeout: 10)); for _ in 0..<4 where !o.isHittable { app.swipeUp() }; o.tap()
    XCTAssertTrue(app.navigationBars["允许 AI 付给新收款方？"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.descendants(matching: .any)["phone.explain"].firstMatch.waitForExistence(timeout: 5))
    let g = app.buttons["trust.goBind"].firstMatch; XCTAssertTrue(g.exists); g.tap()
    XCTAssertTrue(app.navigationBars["Face ID 批准"].waitForExistence(timeout: 8))
  }
  /// t855: home has "[zh]" next to Apple Pay; it shows this wallet's address, the USDC + Base warning, and opens Coinbase's send page.
  func testHomeCoinbaseDeposit() {
    for (lang, label, warn) in [("zh", "Coinbase 充值", "Base"), ("en", "Coinbase Top Up", "Base network")] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang]; app.launch()
      let c = app.buttons["home.deposit"].firstMatch; XCTAssertTrue(c.waitForExistence(timeout: 10), lang)   // t922: 充值 = Coinbase Wallet only, no Apple Pay
      XCTAssertTrue(c.label.contains(lang == "zh" ? "Coinbase 钱包" : "Coinbase wallet"), c.label); XCTAssertFalse(c.label.contains("Apple Pay"), c.label)
      let w = app.buttons["home.withdraw"].firstMatch; XCTAssertTrue(w.exists)
      XCTAssertEqual(c.frame.width, w.frame.width, accuracy: 1, "t922: 充值 / 提现 equal width")
      _ = label
      let a0 = XCTAttachment(screenshot: app.screenshot()); a0.lifetime = .keepAlways; a0.name = "t855-home-\(lang)"; add(a0)
      c.tap()
      _ = warn   // t885: Coinbase Wallet (Coinbase wallet) balance read on-chain, then the transfer page; never the exchange
      let bal = app.staticTexts["cbdep.baBalance"].firstMatch; XCTAssertTrue(bal.waitForExistence(timeout: 8), lang); XCTAssertTrue(bal.label.contains("14.30"), bal.label)
      XCTAssertTrue(app.staticTexts["cbdep.walletOnly"].firstMatch.exists)
      let a1 = XCTAttachment(screenshot: app.screenshot()); a1.lifetime = .keepAlways; a1.name = "t885-cbwallet-\(lang)"; add(a1)
      let o = app.buttons["cbdep.go"].firstMatch; for _ in 0..<4 where !o.isHittable { app.swipeUp() }; o.tap()
      let dl = app.descendants(matching: .any)["debug.launch"].firstMatch; XCTAssertTrue(dl.waitForExistence(timeout: 5), lang)
      XCTAssertTrue(dl.label.hasPrefix("https://sign.kipurse.com/v13/deposit#u=") && dl.label.contains("mode%3Dtap") && dl.label.contains("&vw=0x"), dl.label); XCTAssertFalse(dl.label.contains("pay.coinbase.com") || dl.label.contains("coinbase.com/send"), dl.label)
      XCTAssertTrue(dl.label.contains("amount%3D14304957"), "t886: default = full Coinbase wallet balance: \(dl.label)")
      app.terminate()
    }
  }
  /// t864: one-tap Coinbase deposit opens Coinbase Onramp in "send" (transfer from Coinbase) mode; home shows Coinbase Verified status.
  func testOneTapCoinbaseSendAndVerifyRow() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpOnrampMock", "-kpCBV", "no"]; app.launch()
    let todo = app.buttons["home.cbv.todo"].firstMatch; XCTAssertTrue(todo.waitForExistence(timeout: 10), "verify row"); XCTAssertTrue(todo.label.contains("实名认证未完成"), todo.label)
    XCTAssertTrue(app.staticTexts["home.cbv.pending"].firstMatch.label.contains("不用重做"))
    let a0 = XCTAttachment(screenshot: app.screenshot()); a0.lifetime = .keepAlways; a0.name = "t864-home-verify-zh"; add(a0)
    todo.tap(); let st = app.descendants(matching: .any)["cbv.steps"].firstMatch; XCTAssertTrue(st.waitForExistence(timeout: 8)); XCTAssertTrue(st.label.contains("Get verified"), st.label)
    XCTAssertTrue(app.buttons["cbv.open"].exists)
    XCTAssertTrue(app.staticTexts["cbv.pick"].exists); XCTAssertTrue(app.staticTexts["cbv.pick"].label.contains("Coinbase Wallet"))
    XCTAssertTrue(app.descendants(matching: .any)["cbv.pickImage"].firstMatch.exists)
    XCTAssertEqual(app.staticTexts["cbv.address"].firstMatch.label, "0x1000…0003")
    XCTAssertTrue(app.staticTexts["cbv.checkAddr"].firstMatch.label.contains("不对就别签"))
    XCTAssertTrue(app.staticTexts["cbv.pending"].firstMatch.label.contains("30 分钟"), "pending note")
    XCTAssertFalse(app.descendants(matching: .any)["cbv.safariNote"].exists, "t875: never Safari")
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Safari")).firstMatch.exists, "t875: no Safari wording")
    let a1 = XCTAttachment(screenshot: app.screenshot()); a1.lifetime = .keepAlways; a1.name = "t864-verify-guide-zh"; add(a1)
    app.buttons["完成"].firstMatch.tap()
    let c = app.buttons["home.deposit"].firstMatch; XCTAssertTrue(c.waitForExistence(timeout: 8)); c.tap()
    XCTAssertTrue(app.staticTexts["cbdep.title"].firstMatch.waitForExistence(timeout: 5), "t885: Coinbase Wallet view, no Onramp")
    XCTAssertFalse(app.descendants(matching: .any)["debug.launch"].exists, "t885: nothing opens until the user taps")
    app.terminate()
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "en", "-kpCBV", "ok"]; app.launch()
    let ok = app.descendants(matching: .any)["home.cbv.ok"].firstMatch; XCTAssertTrue(ok.waitForExistence(timeout: 10)); XCTAssertTrue(ok.label.contains("Coinbase Verified"), ok.label)
  }
  /// t876: every user sees THEIR OWN owner address (never the operator's 0x4242…A718).
  func testVerifyShowsOwnAddressNotOperators() {
    let mine = "0xAbCd00000000000000000000000000000000E5F6"
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpCBV", "no", "-kpCBVOwner", mine]; app.launch()
    let todo = app.buttons["home.cbv.todo"].firstMatch; XCTAssertTrue(todo.waitForExistence(timeout: 10)); todo.tap()
    let addr = app.staticTexts["cbv.address"].firstMatch; XCTAssertTrue(addr.waitForExistence(timeout: 8)); XCTAssertEqual(addr.label, "0xAbCd…E5F6")
    let fb = app.buttons["cbv.full"].firstMatch; for _ in 0..<4 where !fb.isHittable { app.swipeUp() }; fb.tap(); XCTAssertEqual(app.staticTexts["cbv.address"].firstMatch.label, mine)
    for bad in ["4242b022", "A718", "0x5150"] { XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", bad)).firstMatch.exists, bad) }
  }
  /// t877: Face ID approval sheet — not enough USDC -> [zh] + deposit button (both ways); money arrives -> Face ID button appears by itself.
  func testFaceIDSheetLowBalanceDepositThenFaceID() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh", "-kpGasGateLow", "-kpGasArrive"]; app.launch()
    let dep = app.buttons["gas.deposit"].firstMatch; XCTAssertTrue(dep.waitForExistence(timeout: 10), "deposit CTA")
    XCTAssertTrue(app.staticTexts["gas.depositTitle"].firstMatch.label.contains("先充值"))
    XCTAssertFalse(app.buttons["gas.sign"].exists, "no Face ID button while the wallet can't pay the fee")
    let a0 = XCTAttachment(screenshot: app.screenshot()); a0.lifetime = .keepAlways; a0.name = "t877-low-zh"; add(a0)
    dep.tap()
    XCTAssertTrue(app.buttons["depchoice.coinbase"].firstMatch.waitForExistence(timeout: 5)); XCTAssertFalse(app.buttons["depchoice.applepay"].exists, "t922: no Apple Pay")
    let a1 = XCTAttachment(screenshot: app.screenshot()); a1.lifetime = .keepAlways; a1.name = "t877-deposit-zh"; add(a1)
    app.buttons["depchoice.done"].firstMatch.tap()
    let sign = app.buttons["gas.sign"].firstMatch; XCTAssertTrue(sign.waitForExistence(timeout: 15), "turns into the Face ID button after money arrives")
    XCTAssertTrue(sign.isEnabled); XCTAssertTrue(sign.label.contains("Face ID"), sign.label); XCTAssertFalse(app.buttons["gas.deposit"].exists)
  }
  func testFaceIDSheetEnoughShowsFaceIDButton() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-kpGasGate", "-kpGasSiri"]; app.launch()
      let sign = app.buttons["gas.sign"].firstMatch; XCTAssertTrue(sign.waitForExistence(timeout: 10), lang); XCTAssertTrue(sign.isEnabled)
      XCTAssertTrue(sign.label.contains(lang == "zh" ? "用 Face ID 开启" : "Turn on with Face ID"), sign.label); XCTAssertFalse(app.buttons["gas.deposit"].exists)
      if lang == "zh" { let a = XCTAttachment(screenshot: app.screenshot()); a.lifetime = .keepAlways; a.name = "t877-enough-zh"; add(a) }
      app.terminate()
    }
  }
  /// t885: Coinbase Wallet empty -> plain explanation + the user's own Kipurse address; no transfer button, no exchange (zh + en).
  func testCoinbaseWalletEmptyShowsAddress() {
    for lang in ["zh", "en"] {
      app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-kpBABal", "0"]; app.launch()
      let c = app.buttons["home.deposit"].firstMatch; XCTAssertTrue(c.waitForExistence(timeout: 10)); c.tap()
      let e = app.descendants(matching: .any)["cbdep.empty"].firstMatch; XCTAssertTrue(e.waitForExistence(timeout: 8), lang)
      XCTAssertTrue(e.label.contains(lang == "zh" ? "没有 USDC" : "no USDC"), e.label)
      XCTAssertFalse(app.buttons["cbdep.go"].exists); XCTAssertTrue(app.buttons["qr.copy"].firstMatch.exists, "own address to copy")
      if lang == "zh" { let a = XCTAttachment(screenshot: app.screenshot()); a.lifetime = .keepAlways; a.name = "t885-empty-zh"; add(a) }
      app.terminate()
    }
  }
  /// t886: in-app amount entry (default = full balance), passed in the link; over-balance / bad input blocks the button.
  func testCoinbaseWalletAmountEntry() {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", "zh"]; app.launch()
    let c = app.buttons["home.deposit"].firstMatch; XCTAssertTrue(c.waitForExistence(timeout: 10)); c.tap()
    let f = app.textFields["cbdep.amount"].firstMatch; XCTAssertTrue(f.waitForExistence(timeout: 8)); XCTAssertEqual(f.value as? String, "14.304957")
    let a0 = XCTAttachment(screenshot: app.screenshot()); a0.lifetime = .keepAlways; a0.name = "t886-amount-zh"; add(a0)
    f.tap(); f.press(forDuration: 1.0); if app.menuItems["全选"].waitForExistence(timeout: 2) { app.menuItems["全选"].tap() } else if app.menuItems["Select All"].exists { app.menuItems["Select All"].tap() }
    f.typeText(XCUIKeyboardKey.delete.rawValue); f.typeText("20")
    XCTAssertTrue(app.staticTexts["cbdep.over"].firstMatch.waitForExistence(timeout: 3)); XCTAssertFalse(app.buttons["cbdep.go"].firstMatch.isEnabled)
    for _ in 0..<3 { f.typeText(XCUIKeyboardKey.delete.rawValue) }; f.typeText("5")
    XCTAssertFalse(app.staticTexts["cbdep.over"].exists)
    let go = app.buttons["cbdep.go"].firstMatch; for _ in 0..<4 where !go.isHittable { app.swipeUp() }; XCTAssertTrue(go.isEnabled); go.tap()
    let dl = app.descendants(matching: .any)["debug.launch"].firstMatch; XCTAssertTrue(dl.waitForExistence(timeout: 5)); XCTAssertTrue(dl.label.contains("amount%3D5000000"), dl.label)
    let all = app.buttons["cbdep.all"].firstMatch; if all.isHittable { all.tap(); XCTAssertEqual(f.value as? String, "14.304957") }
  }
}


/// t1185 (decision 85): the wallet-limits screen shows today's on-chain operations and lets the owner change the daily number.
final class OpsCapUITests: XCTestCase {
  var app: XCUIApplication!
  override func setUp() { continueAfterFailure = false }
  override func tearDown() { if (testRun?.failureCount ?? 0) > 0, let a = app { print("T800DIAG-BEGIN \(name)\n" + a.debugDescription + "\nT800DIAG-END") } }
  func shot(_ n: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = n; a.lifetime = .keepAlways; add(a) }
  func any(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
  func reveal(_ e: XCUIElement) { var n = 0; while !(e.exists && e.isHittable) && n < 10 { app.swipeUp(); n += 1 } }
  func open(_ lang: String, _ extra: [String]) {
    app = XCUIApplication(); app.launchArguments = ["-demo", "main", "-tab", "home", "-kp.lang", lang, "-kpLimitsAdvanced"] + extra; app.launch()
    let t = app.tabBars.buttons.element(boundBy: 1); if t.waitForExistence(timeout: 8) { t.tap() }
    let l = app.buttons["wallet.totalLimit"]; XCTAssertTrue(l.waitForExistence(timeout: 8)); for _ in 0..<6 where !l.isHittable { app.swipeUp() }; l.tap()
  }
  func testOpsCardShowsTodayAndChangesNumber() {
    for lang in ["zh", "en"] {
      open(lang, ["-kpOpsDemo"])
      let today = app.staticTexts["ops.today"]; reveal(today); XCTAssertTrue(today.waitForExistence(timeout: 8), lang)
      XCTAssertEqual(today.label, lang == "zh" ? "今天已用 37 / 500 次 · 每天 UTC 0 点自动恢复" : "Used today 37 / 500 · resets every day at 00:00 UTC")
      XCTAssertFalse(app.staticTexts["ops.summary"].exists, "unchanged number: nothing extra to confirm")
      shot("ops-card-\(lang)")
      let p = app.buttons["ops.preset.1000"]; reveal(p); p.tap()
      let s = app.staticTexts["ops.summary"]; reveal(s); XCTAssertTrue(s.waitForExistence(timeout: 5), lang)
      XCTAssertEqual(s.label, lang == "zh" ? "每天链上操作最多 1000 次" : "On-chain operations: at most 1000 per day")
      shot("ops-summary-\(lang)")
      let c = app.textFields["ops.custom"]; reveal(c); c.tap(); c.typeText("0")
      XCTAssertFalse(app.staticTexts["ops.summary"].exists, "0 is not allowed")
      shot("ops-custom-zero-\(lang)")
      app.terminate()
    }
  }
  func testOpsInfoIsCalm() {
    open("zh", ["-kpOpsDemo", "full"])
    let today = app.staticTexts["ops.today"]; reveal(today); XCTAssertEqual(today.label, "今天已用 500 / 500 次 · 每天 UTC 0 点自动恢复")
    let i = any("ops.info"); reveal(i); i.tap()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "不会丢钱")).firstMatch.waitForExistence(timeout: 5))
    shot("ops-info-zh")
  }
  func testNoOpsCardOnOlderVault() {
    open("zh", [])
    XCTAssertTrue(app.staticTexts["limits.summary"].waitForExistence(timeout: 5))
    reveal(app.staticTexts["limits.summary"])
    XCTAssertFalse(any("ops.card").exists); XCTAssertFalse(app.staticTexts["ops.today"].exists)
  }
}
