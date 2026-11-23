import XCTest
@testable import KipurseCore

/// t1158u (§6#77): Siri pays like every other AI — its own pay-only credential, trust-list names, a spoken reason when nothing can be paid.
final class SiriPayParityT1158Tests: XCTestCase {
  static let good = "ksc_" + String(repeating: "A", count: 21) + "_-" + String(repeating: "z", count: 20)
  func testCredentialFormat() {
    XCTAssertEqual(Self.good.count, 47)
    XCTAssertTrue(SiriCredRule.isValid(Self.good))
    for bad in ["", "ksc_", "kps_" + String(repeating: "A", count: 43), "ksc_" + String(repeating: "A", count: 42), "ksc_" + String(repeating: "A", count: 44),
                "ksc_" + String(repeating: "A", count: 42) + "=", " " + Self.good, Self.good + "\n", "Bearer " + Self.good] {
      XCTAssertFalse(SiriCredRule.isValid(bad), bad)
    }
  }
  func testRoutePrefersSessionThenCredential() {
    XCTAssertEqual(SiriCredRule.route(session: true, credential: true), .session)
    XCTAssertEqual(SiriCredRule.route(session: true, credential: false), .session)
    XCTAssertEqual(SiriCredRule.route(session: false, credential: true), .credential)
    XCTAssertEqual(SiriCredRule.route(session: false, credential: false), .none)
  }
  func testNotPaidIsSpokenAndSaysNoMoneyMoved() {
    for w in [SiriCredRule.NotPaid.notConnected, .revoked, .network(503)] {
      XCTAssertTrue(SiriCredRule.say(w, zh: true).hasPrefix("没付款，钱没动"))
      let en = SiriCredRule.say(w, zh: false); XCTAssertTrue(en.hasPrefix("Not paid, no money moved"))
      XCTAssertFalse(I18nTests.hasCJK(en), en)
    }
    XCTAssertTrue(SiriCredRule.say(.network(503), zh: false).contains("503"))
  }
  static func state(_ book: String) throws -> WalletState {
    let j = "{\"purchases\":[{\"payee\":\"0x1111111111111111111111111111111111111111\",\"merchant\":\"Old shop\",\"amount\":\"1000000\",\"state\":\"paid\"}],\"payeeBook\":\(book)}"
    return WalletState(try JSONDecoder().decode(JSONValue.self, from: Data(j.utf8)))
  }
  func testTrustListNamesBecomeSiriPayeesWithTheirName() throws {
    let book = """
    [{"name":"楼下咖啡店","address":"0x2222222222222222222222222222222222222222","status":"trusted"},
     {"name":"Verified Cafe","address":"0x3333333333333333333333333333333333333333","status":"verified"},
     {"name":"Brand new","address":"0x4444444444444444444444444444444444444444","status":"new"},
     {"name":"0xdeadbeefdeadbeef","address":"0x5555555555555555555555555555555555555555","status":"trusted"},
     {"name":"Bad address","address":"0x12","status":"trusted"},
     {"name":"Old shop renamed","address":"0x1111111111111111111111111111111111111111","status":"trusted"}]
    """
    let p = AssistantData.payees(try Self.state(book), owner: "0x9999999999999999999999999999999999999999", nicknames: [:], salt: "s", zh: true)
    XCTAssertEqual(p.map(\.label), ["我的 Coinbase 钱包", "楼下咖啡店", "Verified Cafe", "Old shop renamed"])   // the owner's own name wins over a merchant name from history
    XCTAssertEqual(p.map(\.bookName), [nil, "楼下咖啡店", "Verified Cafe", "Old shop renamed"])   // a "new" address, an address-like name or a bad address never becomes a Siri payee
    XCTAssertFalse(p.contains { $0.address.hasPrefix("0x4444") || $0.address.hasPrefix("0x5555") })
    XCTAssertEqual(AssistantData.match("楼下咖啡店", p).map(\.bookName), ["楼下咖啡店"])
    if case .ok(let q, let a) = AssistantData.checkPay(payeeId: p[1].id, amount: 0.5, payees: p, state: nil) { XCTAssertEqual(q.bookName, "楼下咖啡店"); XCTAssertEqual(a, 500_000) } else { XCTFail("book payee must be payable") }
    for t in p.flatMap(AssistantData.indexText) { XCTAssertFalse(t.contains("0x"), t) }   // Spotlight still never sees an address
  }
  func testOldCachedPayeesStillDecode() throws {
    let old = "[{\"id\":\"p_1\",\"address\":\"0x2222222222222222222222222222222222222222\",\"label\":\"x\",\"last4\":\"2222\",\"isOwner\":false}]"
    let p = try JSONDecoder().decode([AssistantData.Payee].self, from: Data(old.utf8))
    XCTAssertNil(p[0].bookName)
  }
  /// App Shortcuts: still ≤ 10 shortcuts (Apple's limit), the owner's sentence is a zh phrase, no zh phrase maps to two English keys.
  func testAppShortcutsZhPhrases() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let src = try String(contentsOf: root.appendingPathComponent("App/Assistant/AssistantPayIntents.swift"), encoding: .utf8)
    let body = src.components(separatedBy: "struct KipurseShortcuts").last ?? ""
    XCTAssertLessThanOrEqual(body.components(separatedBy: "AppShortcut(intent:").count - 1, 10)
    let d = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("App/Resources/AppShortcuts.xcstrings"))) as! [String: Any]
    let strings = d["strings"] as! [String: Any]
    var zh: [String: String] = [:]
    for (k, v) in strings { if let z = (((v as? [String: Any])?["localizations"] as? [String: Any])?["zh-Hans"] as? [String: Any])?["stringUnit"] as? [String: Any], let s = z["value"] as? String { XCTAssertNil(zh[s], "duplicate zh phrase \(s)"); zh[s] = k } }
    for p in ["用${applicationName}帮我付款", "${applicationName}帮我付款", "帮我用${applicationName}付款", "能用${applicationName}帮我付款吗", "让${applicationName}帮我付钱", "用${applicationName}付款"] {
      guard let k = zh[p] else { XCTFail("missing zh phrase \(p)"); continue }
      XCTAssertTrue(src.contains("\"" + k.replacingOccurrences(of: "${applicationName}", with: "\\(.applicationName)") + "\""), "phrase key not in code: \(k)")
    }
    XCTAssertTrue(body.contains("StartPaymentIntent()"))
  }
}
