// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import KipurseCore

/// t1281 (handbook §6#141 ③): approval cards show the signed-but-hidden terms (site / full payee / replaces / remember / validity),
/// built only from the SIGNED text; the trust card says its caps are upper bounds and the Face ID prompt carries the exact signed terms.
/// Cross-test: t1281-card-details.json.txt was produced by the gateway's own normalizeItem + proposalText / askText (generator inside the file).
final class T1281CardDetailsTests: XCTestCase {
  static let fixture: [String: Any] = {
    let u = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("t1281-card-details.json.txt")
    return (try? JSONSerialization.jsonObject(with: Data(contentsOf: u))) as? [String: Any] ?? [:]
  }()
  var wallet: String { Self.fixture["wallet"] as? String ?? "" }
  func c(_ k: String) -> [String: String] { ((Self.fixture["cases"] as? [String: Any])?[k] as? [String: String]) ?? [:] }
  func parsed(_ k: String, _ field: String = "signText") throws -> AllowanceText.Parsed {
    let x = c(k); let p = try XCTUnwrap(AllowanceText.parse(x[field] ?? "", allowMode: field != "signText"), k)
    XCTAssertEqual(AllowanceText.problems(p, wallet: wallet, id: x["id"] ?? ""), [], k)
    return p
  }
  func ids(_ d: [AllowanceText.Detail]) -> [String] { d.map(\.id) }
  func row(_ d: [AllowanceText.Detail], _ id: String) -> AllowanceText.Detail? { d.first { $0.id == id } }
  /// owner rule: English 100% English, Chinese without "zh / en" duplicates
  func checkLanguages(_ d: [AllowanceText.Detail], file: StaticString = #filePath, line: UInt = #line) {
    for x in d { XCTAssertFalse(I18nTests.hasCJK(x.en), x.en, file: file, line: line); XCTAssertTrue(I18nTests.hasCJK(x.zh), x.zh, file: file, line: line)
      XCTAssertFalse(I18nTests.bilingual(x.zh), x.zh, file: file, line: line) }
  }

  func testFixtureIsTheGatewayOutput() {
    XCTAssertEqual(wallet, "0x1000000000000000000000000000000000000001", "the app's demo wallet, so -kpGrantDemo goes through approval()")
    XCTAssertTrue((Self.fixture["generator"] as? String ?? "").contains("proposalText"))
    XCTAssertEqual((Self.fixture["cases"] as? [String: Any])?.count, 8)
  }

  func testRecurringWithSiteShowsSiteAnyPayeeFullAddressAndValidity() throws {
    let d = AllowanceText.details(try parsed("recurringHosts"))
    XCTAssertEqual(ids(d), ["payee", "site", "remember", "expires"])
    XCTAssertEqual(row(d, "remember")?.zh, "批准后记住这些收款方，以后它们不算新收款方")   // t1281 review: the gateway remembers recurring payees on approval
    XCTAssertEqual(row(d, "payee")?.zh, "收款地址：0x 1111 1111 1111 1111 1111 1111 1111 1111 1111 2222")
    XCTAssertEqual(row(d, "payee")?.en, "Payee address: 0x 1111 1111 1111 1111 1111 1111 1111 1111 1111 2222")
    XCTAssertEqual(row(d, "site")?.zh, "按网站：只要是 notion.so 上的收款方都算（不只上面的收款地址）")
    XCTAssertEqual(row(d, "site")?.en, "By site: any payee on notion.so counts (not only the payee address above)")
    XCTAssertEqual(row(d, "expires")?.zh, "有效 90 天"); XCTAssertEqual(row(d, "expires")?.en, "Valid for 90 days")
    checkLanguages(d)
    // the card line itself never mentioned the site (that is why the detail row exists)
    XCTAssertFalse(AllowanceText.lines(try parsed("recurringHosts")).joined().contains("notion.so"))
  }

  func testRecurringReplaces() throws {
    let d = AllowanceText.details(try parsed("recurringReplaces"))
    XCTAssertEqual(ids(d), ["payee", "site", "replaces", "remember", "expires"])
    XCTAssertEqual(row(d, "replaces")?.zh, "会替换你之前批准的一项（mnd_9f…5b4a）")
    XCTAssertEqual(row(d, "replaces")?.en, "Replaces one you approved before (mnd_9f…5b4a)")
    checkLanguages(d)
  }

  func testOneOffPayeePlusHostAndRemember() throws {
    let d = AllowanceText.details(try parsed("oneOffRemember"))
    XCTAssertEqual(ids(d), ["payee", "site", "remember", "expires"])
    XCTAssertEqual(row(d, "site")?.zh, "按网站：只要是 shop.example.com 上的收款方都算（不只上面的收款地址）", "oneOff.host is shown even when a payee is named")
    XCTAssertEqual(row(d, "remember")?.zh, "批准后记住这个收款方，以后它不算新收款方")
    XCTAssertEqual(row(d, "remember")?.en, "After approval this payee is remembered and no longer counts as new")
    XCTAssertEqual(row(d, "expires")?.zh, "只能用一次，1 天内有效"); XCTAssertEqual(row(d, "expires")?.en, "Single use, valid for 1 day")
    checkLanguages(d)
    let n = AllowanceText.details(try parsed("oneOffNoRemember"))
    XCTAssertEqual(row(n, "remember")?.zh, "不记住这个收款方，只付这一次"); XCTAssertEqual(row(n, "remember")?.en, "This payee is not remembered: this payment only")
    checkLanguages(n)
  }

  func testOneOffSiteOnly() throws {
    let d = AllowanceText.details(try parsed("oneOffHostOnly"))
    XCTAssertEqual(ids(d), ["site", "expires"], "no payee -> nothing to remember (the gateway only remembers a named payee)")
    XCTAssertEqual(row(d, "site")?.zh, "按网站：只要是 course.example.org 上的收款方都算")
    XCTAssertEqual(row(d, "site")?.en, "By site: any payee on course.example.org counts")
    checkLanguages(d)
  }

  func testAllowanceReplacesAndValidity() throws {
    let p = try parsed("allowanceReplaces")
    let d = AllowanceText.details(p)
    XCTAssertEqual(ids(d), ["replaces", "overall", "expires"])
    XCTAssertEqual(row(d, "overall")?.zh, "批准后会代替你现在的 AI 花钱总上限"); XCTAssertEqual(row(d, "overall")?.en, "After approval this replaces your current overall AI spending limit")
    XCTAssertEqual(row(d, "replaces")?.zh, "会替换你之前批准的一项（mnd_0a…4e5f）")
    XCTAssertEqual(row(d, "expires")?.zh, "有效 90 天", "an AI request lasts at most 90 days (gateway propose)")
    checkLanguages(d)
    // purpose 'all' + payees/hosts: the card line returns early, the details still show the scope
    let s = AllowanceText.details(try parsed("allowanceScoped"))
    XCTAssertEqual(ids(s), ["payee", "site", "remember", "expires"])
    XCTAssertEqual(row(s, "site")?.en, "By site: any payee on api.example.dev counts (not only the payee address above)")
    XCTAssertEqual(row(s, "expires")?.en, "Valid for 30 days")
    checkLanguages(s)
  }

  func testAskCardGetsNoDuplicateRows() throws {
    for f in ["signText", "trust", "once"] {
      let p = try parsed("askTrust", f)
      XCTAssertTrue(AllowanceText.askMatches(p, payee: "0x5555555555555555555555555555555555556666", amount: "30000000"), f)
      XCTAssertEqual(AllowanceText.details(p), [], "the ask card already shows the full address; one payment only, no grant from these fields")
    }
  }

  func testOnlySignedValuesAndSafeShapes() throws {
    let base = c("oneOffRemember")["signText"] ?? ""
    // a host that is not what the gateway normalizes (other characters) is never shown; case is folded like the gateway's lc() match
    let bad = base.replacingOccurrences(of: "\"hosts\":[\"shop.example.com\"]", with: "\"hosts\":[\"Shop.Example.com\"]").replacingOccurrences(of: "\"host\":\"shop.example.com\"", with: "\"host\":\"evil<b>.com\"")
    let d = AllowanceText.details(try XCTUnwrap(AllowanceText.parse(bad)))
    XCTAssertEqual(d.filter { $0.id == "site" }.map(\.en), ["By site: any payee on shop.example.com counts (not only the payee address above)"])
    // a replaces id that is not a plain id is mentioned without the text
    let rep = (c("allowanceReplaces")["signText"] ?? "").replacingOccurrences(of: "mnd_0a1b2c3d4e5f", with: "替换 everything")
    XCTAssertEqual(row(AllowanceText.details(try XCTUnwrap(AllowanceText.parse(rep))), "replaces")?.en, "Replaces one you approved before")
    // validity: hours under a day, booleans / strings / out of range not shown
    XCTAssertEqual(AllowanceText.validity(NSNumber(value: 1.0 / 24))?.zh, "1 小时")
    XCTAssertEqual(AllowanceText.validity(NSNumber(value: 1.0 / 24))?.en, "1 hour")
    XCTAssertEqual(AllowanceText.validity(NSNumber(value: 365))?.en, "365 days")
    XCTAssertNil(AllowanceText.validity(NSNumber(value: true))); XCTAssertNil(AllowanceText.validity("90")); XCTAssertNil(AllowanceText.validity(NSNumber(value: 400)))
    // agent_limits drafts get no rows
    let ag = "Kipurse allowance approval v1\nwallet:\(wallet)\nid:apr_x\nitems:[{\"kind\":\"agent_limits\",\"agentId\":\"siri\",\"daily\":\"10000000\",\"monthly\":null,\"single\":\"2000000\",\"resume\":false}]"
    XCTAssertEqual(AllowanceText.details(try XCTUnwrap(AllowanceText.parse(ag))), [])
  }

  // MARK: trust caps
  func testTrustCardLineSaysUpperBoundsAndExpiry() {
    let l = OwnerAsk.trustCapsCardLine((5_000_000, 20_000_000))
    XCTAssertTrue(l.zh.contains("每笔 5.00 USDC") && l.zh.contains("每天 20.00 USDC") && l.zh.contains("这是上限") && l.zh.contains("最长 90 天后自动到期") && l.zh.contains("手续费"), l.zh)
    XCTAssertTrue(l.en.contains("upper limits") && l.en.contains("within 90 days"), l.en)
    XCTAssertFalse(I18nTests.hasCJK(l.en)); XCTAssertFalse(I18nTests.bilingual(l.zh))
  }

  func om(single: String = "5000000", daily: String = "20020000", expiry: String = "1803297600") -> OwnerTrustMessage {
    OwnerTrustMessage(account: wallet, merchant: "0x" + String(repeating: "ab", count: 32), name: "Desk Shop 0x5555…6666", epoch: "0", payees: ["0x5555555555555555555555555555555555556666"], signers: [],
                      single: single, daily: daily, expiry: expiry, nonce: "0x" + String(repeating: "01", count: 32), deadline: "1800000000")
  }
  func testFaceIDReasonCarriesExactSignedTerms() {
    let utc = TimeZone(identifier: "UTC")!
    let r = OwnerAsk.trustFaceIDReason(om(), grantName: nil, grantSigned: nil, timeZone: utc)
    XCTAssertEqual(r.zh, "认识并信任，并付这笔。信任额度：每笔最多 5.00 USDC，每天最多 20.02 USDC，2027年2月22日到期")
    XCTAssertEqual(r.en, "Trust this payee and pay. Trust limits: up to 5.00 USDC per payment, 20.02 USDC a day, ends Feb 22, 2027")
    let g = OwnerAsk.trustFaceIDReason(om(), grantName: "shop.example", grantSigned: true, timeZone: utc)
    XCTAssertTrue(g.zh.hasPrefix("信任 shop.example 并付这笔。") && g.zh.hasSuffix("；shop.example 的订单每单收款地址可以不同，都算在内"), g.zh)
    XCTAssertTrue(g.en.hasSuffix("; orders from shop.example may use any payee address and all count"), g.en)
    let h = OwnerAsk.trustFaceIDReason(om(), grantName: "shop.example", grantSigned: false, timeZone: utc)
    XCTAssertTrue(h.zh.hasPrefix("信任 shop.example（商家未签名，额度减半）并付这笔"), h.zh)
    let n = OwnerAsk.trustFaceIDReason(om(expiry: RequestVerify.noExpiry), grantName: nil, grantSigned: nil, timeZone: utc)
    XCTAssertTrue(n.zh.hasSuffix("不会自动到期，可随时撤销") && n.en.hasSuffix("no end date, you can remove it any time"))
    for x in [r, g, h, n] { XCTAssertFalse(I18nTests.hasCJK(x.en), x.en); XCTAssertFalse(I18nTests.bilingual(x.zh), x.zh) }
  }

  // MARK: the app wiring (source asserts; the UI test T1281CardDetailsUITests shows the rows)
  func testAppUsesSignedTextForDetailsAndFaceID() throws {
    let v = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/KipurseCoreTests/T1281CardDetailsTests.swift", with: "App/Sources/AllowancesView.swift"), encoding: .utf8)
    XCTAssertTrue(v.contains("details = AllowanceText.details(pt)"), "details from the same parsed signed text as the lines")
    XCTAssertTrue(v.contains("accessibilityIdentifier(\"allow.detail.\" + $0.element.id)"))
    XCTAssertTrue(v.contains("OwnerAsk.trustCapsCardLine(cap)"))
    // the Face ID text is built after every trust check, from the checked message
    let sp = try XCTUnwrap(v.range(of: "PhoneTrust.signerProblems(om, grantVerified:")), fr = try XCTUnwrap(v.range(of: "OwnerAsk.trustFaceIDReason(om, grantName: grantName, grantSigned: grantSigned)"))
    let fid = try XCTUnwrap(v.range(of: "localizedReason: mode == \"trust\" ? (trustReason ?? "))
    XCTAssertTrue(sp.lowerBound < fr.lowerBound && fr.lowerBound < fid.lowerBound)
    XCTAssertTrue(v.contains("let cap = SignedLimitsStore.ceiling(m)")); XCTAssertFalse(v.contains("userTapped: false"))
    for l in v.components(separatedBy: "\n") where l.contains("st.approveAsk(") { XCTAssertTrue(l.contains("BigButton("), l) }
  }

  /// t1281: the card promises "at most 90 days"; the phone refuses an ask trust longer than that (server: 90 days, chain time).
  func testAskTrustLongerThan90DaysRefused() {
    let payee = "0x1212121212121212121212121212121212121212", now = Date()
    func m(_ days: Double) -> OwnerTrustMessage { OwnerTrustMessage(account: "0x" + String(repeating: "aa", count: 20), merchant: "0x" + String(repeating: "ab", count: 32), name: "x", epoch: "0", payees: [payee], signers: [], single: "2000000", daily: "5005000", expiry: String(Int(now.timeIntervalSince1970 + days * 86400)), nonce: "0x" + String(repeating: "cd", count: 32), deadline: "1") }
    XCTAssertFalse(OwnerAsk.trustProblems(m(90), payee: payee, single: "2000000", now: now).contains("bad expiry"))
    XCTAssertTrue(OwnerAsk.trustProblems(m(120), payee: payee, single: "2000000", now: now).contains("bad expiry"))
    XCTAssertTrue(OwnerAsk.trustProblems(m(365), payee: payee, single: "2000000", now: now).contains("bad expiry"))
  }
}
