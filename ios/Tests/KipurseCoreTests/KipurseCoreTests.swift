import XCTest
@testable import KipurseCore

final class AnswerRulesTests: XCTestCase {
  override class func setUp() { super.setUp(); TestOperator.configure() }
  func testParse() {
    XCTAssertEqual(AnswerRules.parseUSDC("1.5"), 1_500_000); XCTAssertEqual(AnswerRules.parseUSDC("0.000001"), 1)
    XCTAssertEqual(AnswerRules.parseUSDC(".5"), 500_000); XCTAssertEqual(AnswerRules.parseUSDC("３．５"), 3_500_000)
    XCTAssertEqual(AnswerRules.parseUSDC("1,000,000"), 1_000_000_000_000); XCTAssertEqual(AnswerRules.parseUSDC("1 000 000"), 1_000_000_000_000)
    XCTAssertEqual(AnswerRules.parseUSDC("1，000"), 1_000_000_000); XCTAssertEqual(AnswerRules.parseUSDC("12,345.67"), 12_345_670_000)
    XCTAssertNil(AnswerRules.parseUSDC("3,5")); XCTAssertNil(AnswerRules.parseUSDC("３，５")); XCTAssertNil(AnswerRules.parseUSDC("1,00"))
    XCTAssertNil(AnswerRules.parseUSDC("1000,000")); XCTAssertNil(AnswerRules.parseUSDC("1,000.5,0")); XCTAssertNil(AnswerRules.parseUSDC("1,000 000")); XCTAssertNil(AnswerRules.parseUSDC("1,,000"))
    XCTAssertEqual(AnswerRules.parseUSDC("１，０００"), 1_000_000_000); XCTAssertEqual(AnswerRules.parseUSDC(" 5 "), 5_000_000)
    XCTAssertEqual(AnswerRules.usdcError("perPayment", "3,5"), "每笔上限：金额格式不对：小数点请用「.」，例如 3.5")
    XCTAssertEqual(Mainnet.limitsError(single: "3,5", daily: "50", term: "500", days: "90"), "金额格式不对：小数点请用「.」，例如 3.5"); XCTAssertNil(AnswerRules.parseUSDC("1.2.3"))
    XCTAssertNil(AnswerRules.usdcError("perPayment", "1,000,000")); XCTAssertNil(Mainnet.limitsError(single: "1,000", daily: "10,000", term: "1,000,000", days: "90"))
    XCTAssertNil(AnswerRules.parseUSDC("1.0000001")); XCTAssertNil(AnswerRules.parseUSDC("-1")); XCTAssertNil(AnswerRules.parseUSDC("1e3")); XCTAssertNil(AnswerRules.parseUSDC(""))
  }
  func testFieldErrorsAreChinese() {
    XCTAssertTrue(AnswerRules.usdcError("perPayment", "")!.contains("请填写"))
    XCTAssertTrue(AnswerRules.usdcError("perPayment", "-2")!.contains("负数"))
    XCTAssertTrue(AnswerRules.usdcError("perPayment", "1.1234567")!.contains("6 位小数"))
    XCTAssertTrue(AnswerRules.usdcError("perPayment", "abc")!.contains("只填数字"))
    XCTAssertTrue(AnswerRules.usdcError("perPayment", "0")!.contains("大于 0"))
    XCTAssertNil(AnswerRules.usdcError("perPayment", "3"))
  }
  func testTerm() {
    for d in ["1","45","365"] { XCTAssertNil(AnswerRules.termError(d)) }
    XCTAssertTrue(AnswerRules.termError("366")!.contains("1 到 365")); XCTAssertTrue(AnswerRules.termError("30.5")!.contains("整数"))
  }
  let ok = ["termDays":"45","perPayment":"2.5","perDay":"5","termTotal":"20","unrecognizedPerPayment":"0.25","unrecognizedPerDay":"1","depositDailyLimit":"7.123456"]
  func testOrdering() {
    XCTAssertTrue(AnswerRules.check(ok).ok)
    func e(_ k: String, _ v: String) -> String { var a = ok; a[k] = v; return AnswerRules.check(a).errors.map(\.zh).joined(separator: "|") }
    XCTAssertTrue(e("perPayment","6").contains("每笔上限不能大于每天上限"))
    XCTAssertTrue(e("perDay","21").contains("每天上限不能大于整个期间上限"))
    XCTAssertTrue(e("unrecognizedPerPayment","3").contains("陌生收款方每笔上限不能大于每笔上限"))
    XCTAssertTrue(e("unrecognizedPerDay","6").contains("陌生收款方每天上限不能大于每天上限"))
  }
  func testWarningAndPartial() {
    XCTAssertTrue(AnswerRules.check(["termDays":"90","perPayment":"3"], partial: true).ok)
    var a = ok; a["perPayment"] = "200"; a["perDay"] = "500"; a["termTotal"] = "1000"
    let r = AnswerRules.check(a); XCTAssertTrue(r.ok); XCTAssertTrue(r.warnings[0].contains("建议先放少量试试"))
  }
  func testLimitChange() {
    let cur: [String:Int64] = ["unrecognizedPerPayment":500_000,"unrecognizedPerDay":1_000_000,"depositDailyLimit":10_000_000]
    XCTAssertTrue(AnswerRules.checkLimitChange(["unrecognizedPerPayment":"0.75"], current: cur, mainSingle: 2_000_000, mainDaily: 5_000_000).ok)
    XCTAssertTrue(AnswerRules.checkLimitChange(["unrecognizedPerPayment":"3"], current: cur, mainSingle: 2_000_000, mainDaily: 5_000_000).errors[0].zh.contains("链上每笔上限"))
  }
  func testFormat() { XCTAssertEqual(AnswerRules.format(19_789_990), "19.78999"); XCTAssertEqual(AnswerRules.format(1_000_000), "1") }
}

final class LinkAndStateTests: XCTestCase {
  override class func setUp() { super.setUp(); TestOperator.configure() }
  let code = String(repeating: "ab", count: 24)
  func testOwnerLink() {
    let l = OwnerLink.parse("https://x.trycloudflare.com/login?code=\(code)")
    XCTAssertEqual(l?.server.absoluteString, "https://x.trycloudflare.com"); XCTAssertEqual(l?.code, code)
    XCTAssertNil(OwnerLink.parse("kipurse://login?server=https%3A%2F%2Fx.example&code=\(code)"))   // t796 H1: deep-link login removed
    XCTAssertNotNil(OwnerLink.parse("http://192.168.1.20:8680/login?code=\(code)"))
    XCTAssertNil(OwnerLink.parse("http://evil.example/login?code=\(code)"))      // plain http only on LAN
    XCTAssertNil(OwnerLink.parse("https://x.example/other?code=\(code)")); XCTAssertNil(OwnerLink.parse("https://x.example/login?code=zz"))
  }
  func testCookie() {
    let ck = String(repeating: "0f", count: 32)
    XCTAssertEqual(OwnerAPI.kpCookie("kp=\(ck); HttpOnly; SameSite=Lax; Path=/"), ck); XCTAssertNil(OwnerAPI.kpCookie("other=1"))
  }
  func testApprovalsAndDiff() throws {
    let j = #"""
    {"mode":"TEST","chainId":84532,"balance":"19789990","setup":{"active":true,"wallet":"0x896E"},"main":{"single":"10000000","daily":"20000000"},
      "trust":{"pending":[{"id":"t1","subject":{"id":"0xabc"},"reason":"groceries","single":"1000000","daily":"2000000"}]},
      "pending":{"changes":[{"id":"c1"}],"withdrawals":[{"id":"w1","amount":"1500000"}]}}
    """#
    let s = WalletState(try JSONDecoder().decode(JSONValue.self, from: Data(j.utf8)))
    XCTAssertTrue(s.isTestMode); XCTAssertEqual(s.balance, 19_789_990); XCTAssertEqual(s.mainSingle, 10_000_000)
    XCTAssertEqual(s.approvals.map(\.id), ["trust:t1","limits:c1","withdraw:w1"]); XCTAssertTrue(s.approvals[2].bodyZh.contains("1.5 USDC"))
    XCTAssertEqual(ApprovalDiff.newOnes(previous: ["trust:t1"], current: s.approvals).map(\.id), ["limits:c1","withdraw:w1"])
  }
}

final class SheetIdentityTests: XCTestCase {
  override class func setUp() { super.setUp(); TestOperator.configure() }
  // Regression: the agent gallery sheet used `let id = UUID()` inside a Binding getter, so every 5 s refresh made a new identity
  // and SwiftUI dismissed + re-presented the sheet in a loop. Identities must be stable for the same server object.
  func testStableAcrossRefreshes() throws {
    let a = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"keyId":"agent-1","name":"Grok Bot"}"#.utf8))
    let b = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"keyId":"agent-1","name":"Grok Bot","note":"changed"}"#.utf8))
    XCTAssertEqual(SheetIdentity.result(a), SheetIdentity.result(a))
    XCTAssertEqual(SheetIdentity.result(a), SheetIdentity.result(b))
    let k = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"id":"agent-1","lastUsed":null}"#.utf8))
    XCTAssertEqual(SheetIdentity.manage(k), "manage:agent-1")
  }
}

final class SessionMigrationTests: XCTestCase {
  override class func setUp() { super.setUp(); TestOperator.configure() }
  func testQuickTunnelMovesToStableHost() {
    let s = OwnerSession(server: URL(string: "https://example-old-tunnel.trycloudflare.com")!, cookie: "abc", csrf: "x")
    OwnerSession.stableServer = nil; XCTAssertEqual(s.migrated(), s)        // not configured: never migrate
    OwnerSession.stableServer = URL(string: "https://kipurse.example.com"); defer { OwnerSession.stableServer = nil }
    XCTAssertEqual(s.migrated().server.absoluteString, "https://kipurse.example.com"); XCTAssertEqual(s.migrated().cookie, "abc")
    let local = OwnerSession(server: URL(string: "http://localhost:8680")!, cookie: "abc")
    XCTAssertEqual(local.migrated(), local)
  }
}

final class AccountDeletionTests: XCTestCase {
  override class func setUp() { super.setUp(); TestOperator.configure() }
  func testPhrase() {
    XCTAssertTrue(AccountDeletion.phraseOK("删除我的账户")); XCTAssertTrue(AccountDeletion.phraseOK(" 删除我的账户\n"))
    XCTAssertFalse(AccountDeletion.phraseOK("删除账户")); XCTAssertFalse(AccountDeletion.phraseOK("")); XCTAssertFalse(AccountDeletion.phraseOK("删除我的账户。"))
  }
  func testStepOrder() {
    XCTAssertEqual(AccountDeletion.Step.allCases, [.overview, .withdrawFirst, .typePhrase, .faceID, .countdown, .done])
    XCTAssertEqual(AccountDeletion.next(.typePhrase), .faceID); XCTAssertEqual(AccountDeletion.next(.done), .done)
  }
  func testGuideFromRecovery() throws {
    let j = """
    {"chainId":84532,"network":"Base Sepolia (test)","explorer":"https://sepolia.basescan.org","wallet":"0x1111111111111111111111111111111111111111","owner":"0x2222222222222222222222222222222222222222",
     "usdc":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","spendPermissionManager":"0xf85210B21cC50302F477BA56686d2019dC9b67Ad","adapter":"0x3333333333333333333333333333333333333333",
     "payerVault":"0x4444444444444444444444444444444444444444","permission":{"account":"0x1111111111111111111111111111111111111111","salt":"1"},"permissionValid":true,
     "revoke":{"to":"0x1111111111111111111111111111111111111111","data":"0x34fcd5be"},"balances":{"wallet":"250000","vault":"200000"},"rescueUrl":"https://example.org/rescue/#c=abc"}
    """
    let g = try XCTUnwrap(RecoveryGuide(recovery: try JSONDecoder().decode(JSONValue.self, from: Data(j.utf8))))
    XCTAssertEqual(g.balanceAtDeletion, 450_000); XCTAssertTrue(g.permissionStillValid)
    XCTAssertEqual(g.methods.map(\.id), ["rescue", "exit-kit", "basescan"]); XCTAssertEqual(g.simpleMethods.map(\.id), ["rescue"]); XCTAssertEqual(g.advancedMethods.count, 2)
    XCTAssertEqual(g.rescueUrl, "https://example.org/rescue/#c=abc"); XCTAssertFalse(g.simpleMethods[0].steps.joined().contains("Basescan"))
    XCTAssertTrue(g.advancedMethods.allSatisfy { $0.needsGas.contains("手续费") || $0.needsGas.contains("gas") })   // t927: no "gas" jargon
    let t = g.text
    XCTAssertTrue(t.contains("0x1111111111111111111111111111111111111111")); XCTAssertTrue(t.contains("只有你的 Coinbase 钱包 能控制"))
    XCTAssertTrue(t.contains("全部提现")); XCTAssertTrue(t.contains("https://example.org/rescue/#c=abc"))
    XCTAssertLessThan(t.range(of: "全部提现")!.lowerBound, t.range(of: "Basescan")!.lowerBound)
    XCTAssertTrue(t.contains("removeOwnerAtIndex(index=1, owner=0x000000000000000000000000f85210b21cc50302f477ba56686d2019dc9b67ad)"))
    XCTAssertTrue(t.contains("0x35faa416")); XCTAssertTrue(t.contains("0x34fcd5be")); XCTAssertTrue(t.contains("\"salt\":\"1\""))
    XCTAssertNil(RecoveryGuide(recovery: .object([:])))
    let rt = try JSONDecoder().decode(RecoveryGuide.self, from: JSONEncoder().encode(g)); XCTAssertEqual(rt, g)
  }
}

final class AddressCheckTests: XCTestCase {
  override class func setUp() { super.setUp(); TestOperator.configure() }
  func testAddressCheck() {
    XCTAssertNil(AddressCheck.error("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"))
    XCTAssertNil(AddressCheck.error(" ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453 "))
    XCTAssertNotNil(AddressCheck.error("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"))
    XCTAssertNotNil(AddressCheck.error("0x1234")); XCTAssertNotNil(AddressCheck.error(""))
    XCTAssertNotNil(AddressCheck.error("0x1111111111111111111111111111111111111111", wallet: "0x1111111111111111111111111111111111111111"))
    XCTAssertEqual(AddressCheck.normalized("ethereum:0xabc@8453"), "0xabc")
  }
}

final class TrustRequestTests: XCTestCase {
  override class func setUp() { super.setUp(); TestOperator.configure() }
  func testPendingTrustRequestBecomesAnApproval() throws {
    let j = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"mode":"TEST","trustRequests":{"pending":[{"id":"r1","status":"awaiting_owner","payee":"0x000000000000000000000000000000000000dEaD","chain":"base","chainId":8453,"single":"10050000","total":"10100000","expiresInDays":90,"merchantName":"Example Shop","reason":"vps invoice","requestedBy":["muse","claude"],"untrustedText":true}]}}"#.utf8))
    let s = WalletState(j); XCTAssertEqual(s.trustRequests.count, 1)
    let r = s.trustRequests[0]; XCTAssertEqual(r.payee, "0x000000000000000000000000000000000000dEaD"); XCTAssertEqual(r.single, 10_050_000); XCTAssertEqual(r.total, 10_100_000)
    XCTAssertEqual(r.chainLabel, "Base"); XCTAssertEqual(r.requestedBy, ["muse","claude"])
    XCTAssertEqual(s.approvals.filter { $0.kind == .trustRequest }.map(\.serverId), ["r1"])
  }
}

final class PhoneTrustTests: XCTestCase {
  override class func setUp() { super.setUp(); TestOperator.configure() }
  func testKeccakVectors() {
    XCTAssertEqual(Hex.encode(Keccak.hash([UInt8]())), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
    XCTAssertEqual(Hex.encode(Keccak.hash("fork-self")), "0x1ba60ee5d086072d27b71af2d00394bbd36810e851b215d19ad2228b177ed4e9")
  }
  /// Vector from viem hashTypedData (same formulas the fork e2e checked against the real contracts), neutral test addresses.
  func testOwnerTrustDigestAndWalletHashMatchChain() {
    let m = OwnerTrustMessage(account: "0x1000000000000000000000000000000000000001", merchant: "0x1ba60ee5d086072d27b71af2d00394bbd36810e851b215d19ad2228b177ed4e9", name: "fork-self", epoch: "0",
      payees: ["0x1000000000000000000000000000000000000003"], signers: [], single: "50000", daily: "50000", expiry: "1795227638",
      nonce: "0xf9e85b4553daea41dba8bde2d413d9ef9fc6d2c8bad11a5d8d65299aa650bd38", deadline: "1792639238")
    let d = PhoneTrust.digest(m)!; XCTAssertEqual(Hex.encode(d), "0x2177fed8a8f65839559a18a629e7c007712b648468866403718dd6b00c918197")
    XCTAssertEqual(Hex.encode(PhoneTrust.walletHash(d)!), "0x4a3471dbad1e1f6b2ca919385bcb8dd826f352692507d0d3ef5efeae405f8db3")
    XCTAssertEqual(PhoneTrust.problems(m, maxSingle: "10050000", maxDaily: "12012000"), [])
    var bad = m; bad.single = "11000000"; bad.name = "other"; XCTAssertEqual(PhoneTrust.problems(bad, maxSingle: "10050000", maxDaily: "12012000").count, 2)
  }
  func testLowS() {
    // s = n - 1 (high) -> 1
    let n1 = Hex.decode("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632550")!
    let der: [UInt8] = [0x30, 0x46, 0x02, 0x21, 0x00] + [UInt8](repeating: 0x80, count: 32) + [0x02, 0x21, 0x00] + n1
    let (r, s) = PhoneTrust.rs(fromDER: der)!; XCTAssertEqual(r, [UInt8](repeating: 0x80, count: 32)); XCTAssertEqual(s, [UInt8](repeating: 0, count: 31) + [1])
  }
}

final class MainnetTests: XCTestCase {
  override class func setUp() { super.setUp(); TestOperator.configure() }
  func testSessionDigestMatchesServer() {
    // gateway: sessionDigest('0x1000000000000000000000000000000000000001', 'ab'.repeat(24))
    XCTAssertEqual(Hex.encode(Mainnet.sessionDigest(nonce: String(repeating: "ab", count: 24))), "0xb5fdc4a95396289612ba4d06d0f9a203278d8d4cde1b3840f09b7024fd4f3498")
    XCTAssertTrue(Mainnet.validNonce(String(repeating: "ab", count: 24))); XCTAssertFalse(Mainnet.validNonce("xyz")); XCTAssertFalse(Mainnet.validNonce(String(repeating: "AB", count: 24)))
  }
  func testLimits() {
    let o = UserDefaults.standard.string(forKey: "kp.lang"); UserDefaults.standard.set("zh", forKey: "kp.lang"); defer { UserDefaults.standard.set(o, forKey: "kp.lang") }
    XCTAssertNil(Mainnet.limitsError(single: "2", daily: "5", term: "50", days: "90"))
    XCTAssertEqual(Mainnet.limitsError(single: "6", daily: "5", term: "50", days: "90"), "每笔不能大于每天")
    XCTAssertEqual(Mainnet.limitsError(single: "1", daily: "60", term: "50", days: "90"), "每天不能大于总额")
    XCTAssertEqual(Mainnet.limitsError(single: "1", daily: "2", term: "1000001", days: "90"), "总额最多 1,000,000 USDC"); XCTAssertNil(Mainnet.limitsError(single: "100000", daily: "500000", term: "1000000", days: "90"))
    XCTAssertEqual(Mainnet.limitsError(single: "1", daily: "2", term: "3", days: "400"), "期限要 1–365 天")
    XCTAssertNotNil(Mainnet.limitsError(single: "", daily: "2", term: "3", days: "30"))
    XCTAssertEqual(Mainnet.limitsURL(single: "2.50", daily: "5", term: "50", days: "90")?.absoluteString, "https://kipurse.example/owner/limits?single=2.5&daily=5&term=50&days=90")
  }
  func testStateParsing() {
    let j = try! JSONDecoder().decode(JSONValue.self, from: Data(#"{"mode":"MAIN","balance":"14100000","caps":{"single":"10050000","daily":"12012000","term":"30030000","end":"1800065520"},"spent":{"today":"10000","term":"20000"},"agents":[{"id":"muse","name":"Muse","connected":true,"lastUsed":"2026-10-22T03:00:00Z"}]}"#.utf8))
    let s = WalletState(j)
    XCTAssertTrue(s.isMainnet); XCTAssertEqual(s.balance, 14_100_000); XCTAssertEqual(s.capSingle, 10_050_000); XCTAssertEqual(s.serverSpentTerm, 20_000)
    XCTAssertTrue(s.muse.connected); XCTAssertEqual(s.muse.lastUsed, "2026-10-22T03:00:00Z")
    let none = WalletState(try! JSONDecoder().decode(JSONValue.self, from: Data(#"{"mode":"MAIN","agents":[{"id":"codex"}]}"#.utf8)))
    XCTAssertFalse(none.muse.connected)
    let off = WalletState(try! JSONDecoder().decode(JSONValue.self, from: Data(#"{"agents":[{"id":"oauth-x","kind":"muse","connected":false}]}"#.utf8)))
    XCTAssertFalse(off.muse.connected)
  }

  func testLimitsUpdatedCallback() {
    let u = URL(string: "kipurse://limits-updated?single=10000000&daily=50000000&term=200000000&start=1792642081&end=1824178081")!
    let r = LimitsUpdate.parse(u)!
    XCTAssertEqual(r.single, 10_000_000); XCTAssertEqual(r.daily, 50_000_000); XCTAssertEqual(r.term, 200_000_000)
    let chicago = TimeZone(identifier: "America/Chicago")!
    XCTAssertEqual(Mainnet.termRange(r.start, r.end, zone: chicago), "2026-10-21 23:08 – 2027-10-21 23:08")
    XCTAssertNil(LimitsUpdate.parse(URL(string: "kipurse://limits-updated?single=1&daily=2&term=3&start=100&end=\(100 + 366 * 86400)")!))   // > 365 days
    XCTAssertNil(LimitsUpdate.parse(URL(string: "kipurse://limits-updated?single=5&daily=2&term=3&start=1&end=2")!))   // single > daily
    XCTAssertNil(LimitsUpdate.parse(URL(string: "kipurse://done")!))
  }

  func testLimitsPending() {
    let st = WalletState(.object(["limitsPending": .object(["single": .string("10000000"), "daily": .string("50000000"), "term": .string("200000000"), "days": .number(365), "since": .number(1792642081), "failed": .bool(false)])]))
    XCTAssertEqual(st.limitsPending, LimitsPending(single: 10_000_000, daily: 50_000_000, term: 200_000_000, days: 365, since: 1792642081, failed: false))
    XCTAssertNil(WalletState(.object(["limitsPending": .null])).limitsPending)
    let p = LimitsPending.parse(URL(string: "kipurse://limits-pending?single=1000000&daily=2000000&term=3000000&days=30")!)
    XCTAssertEqual(p?.term, 3_000_000); XCTAssertEqual(p?.days, 30)
    XCTAssertNil(LimitsPending.parse(URL(string: "kipurse://done")!))
  }

  func testLedgerRows() {
    let st = WalletState(.object(["ledger": .array([
      .object(["tx": .string("0x737e62abaa"), "t": .number(1792643661), "account": .string("wallet"), "kind": .string("payment"), "delta": .string("-26730"), "balance": .string("14103220"), "zh": .string("AI 付款 0.01")]),
      .object(["tx": .string("0x6219df2262"), "t": .number(1792622981), "account": .string("wallet"), "kind": .string("deposit"), "delta": .string("10000000"), "balance": .string("14129950"), "zh": .string("充值")]),
      .object(["tx": .string("0x526f66df40"), "t": .number(1792642127), "account": .string("owner"), "kind": .string("ownerfee"), "delta": .string("-6111"), "balance": .null, "zh": .string("确认手续费 · 你的 Coinbase 钱包")]),
      .object(["bad": .bool(true)])])]))
    XCTAssertEqual(st.ledger.count, 3); XCTAssertTrue(st.ledger[2].isOwner); XCTAssertNil(st.ledger[2].balance); XCTAssertEqual(st.ledger[2].signed, "−0.006111"); XCTAssertEqual(st.ledger[0].signed, "−0.02673"); XCTAssertEqual(st.ledger[1].signed, "+10")
    XCTAssertEqual(st.ledger[0].url()?.absoluteString, "https://basescan.org/tx/0x737e62abaa")
  }

  func testAgentCards() {
    XCTAssertEqual(AgentCard.mainnet.map(\.id), ["grok-bot", "claude"])
    let gb = AgentCard.mainnet[0]; XCTAssertTrue(gb.prefill); XCTAssertEqual(gb.app?.scheme, "grokbot"); XCTAssertEqual(gb.app?.host, "app"); XCTAssertEqual(gb.app?.path, "/v1/prompt")
    XCTAssertEqual(URLComponents(url: gb.app!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "text" }?.value, "Add this MCP server: https://kipurse.example/mcp")
    let cl = AgentCard.mainnet[1]; XCTAssertTrue(cl.prefill); XCTAssertNil(cl.app)
    XCTAssertEqual(cl.open.absoluteString, "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Kipurse&connectorUrl=https%3A%2F%2Fkipurse.example%2Fmcp")
    let qi = URLComponents(url: cl.open, resolvingAgainstBaseURL: false)?.queryItems ?? []
    XCTAssertEqual(qi.first { $0.name == "connectorUrl" }?.value, "https://kipurse.example/mcp"); XCTAssertEqual(qi.first { $0.name == "connectorName" }?.value, "Kipurse")
    let st = WalletState(.object(["agents": .array([.object(["id": .string("claude"), "kind": .string("claude"), "connected": .bool(true)]),
                                                     .object(["id": .string("grok-bot"), "kind": .string("grok-bot"), "connected": .bool(false)])])]))
    XCTAssertTrue(cl.connected(in: st)); XCTAssertFalse(gb.connected(in: st))
    // real server shape: claude.ai OAuth client -> id oauth-claude-desktop, kind claude-desktop
    let real = WalletState(.object(["agents": .array([.object(["id": .string("oauth-claude-desktop"), "name": .string("Claude"), "kind": .string("claude-desktop"), "connected": .bool(false)])])]))
    XCTAssertFalse(cl.connected(in: real)); XCTAssertTrue(cl.unfinished(in: real)); XCTAssertTrue(AgentCard.known(real.agents[0])); XCTAssertFalse(gb.matches(real.agents[0]))
    let live = WalletState(.object(["agents": .array([.object(["id": .string("oauth-claude-desktop"), "kind": .string("claude-desktop"), "connected": .bool(true), "lastUsed": .string("2026-10-22T19:00:00Z")])])]))
    XCTAssertTrue(cl.connected(in: live)); XCTAssertEqual(cl.lastUsed(in: live), "2026-10-22T19:00:00Z")
    XCTAssertFalse(AgentCard.known(.object(["id": .string("oauth-custom"), "kind": .string("custom")])))
  }

  func testConnectApprovalDigestMatchesGateway() {
    let t = ConnectApproval.text(wallet: "0xAB", req: "r", clientId: "kpc_1", name: "Grok Bot", redirect: "https://x/cb", exp: 1700000000, approve: true)
    XCTAssertEqual(t, "Kipurse approve connection v1\nwallet:0xab\nreq:r\nclient:kpc_1\nname:Grok Bot\nredirect:https://x/cb\nexp:1700000000\naction:approve")
    // gateway test vector: connectDigest({wallet:'0xab',req:'r',clientId:'c',name:'n',redirect:'https://x',exp:1,action:'approve'})
    XCTAssertEqual(Hex.encode(ConnectApproval.digest(req: "r", clientId: "c", name: "n", redirect: "https://x", exp: 1, approve: true, wallet: "0xab")).lowercased(), "0x31a44a98e83677c26a1540c8af261e987fb98820563a679fff23c739ab07cf9d")
    XCTAssertNotEqual(ConnectApproval.digest(req: "r", clientId: "c", name: "n", redirect: "https://x", exp: 1, approve: false), ConnectApproval.digest(req: "r", clientId: "c", name: "n", redirect: "https://x", exp: 1, approve: true))
    XCTAssertTrue(ConnectApproval.validId("wvRsRNWQqtGbUNc2WKCs4ZnK")); XCTAssertFalse(ConnectApproval.validId("a/b")); XCTAssertFalse(ConnectApproval.validId("short"))
    let st = WalletState(.object(["connectRequests": .array([.object(["id": .string("wvRsRNWQqtGbUNc2WKCs4ZnK"), "client": .string("Grok Bot"), "host": .string("www.cursor.com"), "exp": .number(1)]),
                                                                .object(["id": .string("abcdefgh12"), "client": .string("Codex"), "exp": .number(4_000_000_000)])])]))
    XCTAssertEqual(st.connectRequests.count, 2); XCTAssertEqual(st.liveConnectRequests().map(\.client), ["Codex"])
  }

  func testConnectDigestSharedVectorAndCompare() {
    // same vector as gateway test/phone-connect.test.mjs (cursor:// redirect, non-ASCII name; server floors fractional expiry)
    let d = ConnectApproval.digest(req: "_cT8DHJ2gmbqFldkPBeVSx3I", clientId: "kpc_TESTCLIENT000000000000", name: "Grok Bot 助手 ✨",
                                   redirect: "cursor://anysphere.cursor-mcp/oauth/callback?x=a%20b", exp: 1792680260, approve: true)
    let v = "0x47753f67686a00f5ac2470ccdbe593ff42767c0988ba621a77c022cd0165eb4e"
    XCTAssertTrue(ConnectApproval.matches(d, server: v)); XCTAssertTrue(ConnectApproval.matches(d, server: v.uppercased().replacingOccurrences(of: "0X", with: "0x")))
    XCTAssertTrue(ConnectApproval.matches(d, server: String(v.dropFirst(2))))
    let other = ConnectApproval.digest(req: "_cT8DHJ2gmbqFldkPBeVSx3I", clientId: "kpc_TESTCLIENT000000000000", name: "Grok Bot",
                                       redirect: "cursor://anysphere.cursor-mcp/oauth/callback?x=a%20b", exp: 1792680260, approve: true)
    XCTAssertFalse(ConnectApproval.matches(other, server: v))   // a different name than displayed is refused
  }

  func testSiriAnswers() {
    let st = WalletState(.object(["balance": .string("14129950"), "caps": .object(["single": .string("10000000"), "daily": .string("50000000"), "term": .string("200000000"), "start": .string("1792645859"), "end": .string("1824181859")]),
      "spent": .object(["today": .string("48000000")]),
      "purchases": .array([.object(["payee": .string("0x1000000000000000000000000000000000000003"), "merchant": .string("Example Shop")]), .object(["payee": .string("0x1000000000000000000000000000000000000003")]), .object(["payee": .string("bad")])]),
      "ledger": .array([.object(["tx": .string("0x01"), "t": .string("1792622981"), "account": .string("wallet"), "kind": .string("pay"), "delta": .string("-1000000"), "balance": .string("14129950"), "zh": .string("付款给 Example Shop")])])]))
    let b = SiriAnswers.balance(st); XCTAssertTrue(b.hasPrefix("Kipurse 余额 14.12995 USDC")); XCTAssertTrue(b.contains("每笔最多 10")); XCTAssertTrue(b.contains("2027年10月"))
    XCTAssertEqual(SiriAnswers.activity(st), "最近 1 笔：−1 USDC（付款给 Example Shop）。")
    XCTAssertEqual(SiriAnswers.payees(st), [.init(address: "0x1000000000000000000000000000000000000003", name: "Example Shop")])   // de-duplicated, invalid dropped
    XCTAssertEqual(SiriAnswers.atomic(5), 5_000_000); XCTAssertNil(SiriAnswers.atomic(-1)); XCTAssertNil(SiriAnswers.atomic(.nan))
    XCTAssertNil(SiriAnswers.payProblem(1_000_000, st))
    XCTAssertEqual(SiriAnswers.payProblem(11_000_000, st), "超过每笔上限 10 USDC。")
    XCTAssertEqual(SiriAnswers.payProblem(3_000_000, st), "今天只剩 2 USDC 额度。")
    XCTAssertEqual(SiriAnswers.payProblem(20_000_000_000, st), "余额不够（14.12995 USDC）。")
  }
}

enum TestOperator {
  static func configure() { Operator.info = ["KipurseMainnetServer": "https://kipurse.example"]; Operator.setWallet(nil); Operator.setWallet("0x1000000000000000000000000000000000000001", path: "") }
}

final class OwnerPayTests: XCTestCase {
  override class func setUp() { super.setUp(); TestOperator.configure() }
  // vector: viem hashTypedData; approvalDigest also equals KipurseTrustV5.ownerDigest on Base mainnet (cast call, 2026-10-22)
  let W = "0x1000000000000000000000000000000000000001", P = "0x1000000000000000000000000000000000000003"
  let purchaseKeyVec = "0xe48bf0013e10cffa31b02b9fd12fd75dcec27382ecae9021abca59f6c1bb2c5a"  // public bytes32 test vector, not a private key. gitleaks:allow
  func ch(_ over: (inout OwnerPay.Challenge) -> Void = { _ in }) -> OwnerPay.Challenge {
    var c = OwnerPay.Challenge(id: "a", digest: "0xda75e89c9f14eab8dc513ed05c86e579d6a8e0fce8f175ea8681ca99292ac8c1", approvalDigest: "0x88d53bf5d10e4e465a4e7c274cae881c4098c0f6384369581a93a8843b9b8dcb",
      purchaseKey: purchaseKeyVec, payee: P, amount: "10000", deadline: "1792700000", wallet: W, chainId: 8453, fee: "10", newPayee: false); over(&c); return c }
  let at = Date(timeIntervalSince1970: 1792699700)
  func testEraseDigestMatchesServer() {
    XCTAssertEqual(Hex.encode(Mainnet.eraseDigest(nonce: String(repeating: "ab", count: 24))), "0xc81a3f94f163ecee4d7b4f4735491ccb6dd4128d4f5bc25dfc75480350f4d684")
  }
  func testApprovalDigestVector() {
    XCTAssertEqual(Hex.encode(OwnerPay.approvalDigest(account: W, purchaseKey: purchaseKeyVec, payee: P, amount: "10000", deadline: "1792700000")!), "0x88d53bf5d10e4e465a4e7c274cae881c4098c0f6384369581a93a8843b9b8dcb")
  }
  func testPhoneSignsOnlyWhatItShows() {
    guard case .success(let h) = OwnerPay.toSign(ch(), wallet: W, payee: P, amount: 10000, now: at) else { return XCTFail() }
    XCTAssertEqual(Hex.encode(h), "0xda75e89c9f14eab8dc513ed05c86e579d6a8e0fce8f175ea8681ca99292ac8c1")
    XCTAssertEqual(OwnerPay.toSign(ch(), wallet: W, payee: P, amount: 10001, now: at), .failure(.wrongAmount))
    XCTAssertEqual(OwnerPay.toSign(ch(), wallet: W, payee: W, amount: 10000, now: at), .failure(.wrongPayee))
    XCTAssertEqual(OwnerPay.toSign(ch(), wallet: P, payee: P, amount: 10000, now: at), .failure(.wrongWallet))
    XCTAssertEqual(OwnerPay.toSign(ch { $0.chainId = 1 }, wallet: W, payee: P, amount: 10000, now: at), .failure(.wrongChain))
    XCTAssertEqual(OwnerPay.toSign(ch(), wallet: W, payee: P, amount: 10000, now: Date(timeIntervalSince1970: 1792700000)), .failure(.expired))
    XCTAssertEqual(OwnerPay.toSign(ch { $0.digest = "0x" + String(repeating: "00", count: 32) }, wallet: W, payee: P, amount: 10000, now: at), .failure(.digestMismatch))
    XCTAssertEqual(OwnerPay.toSign(ch { $0.purchaseKey = "0x" + String(repeating: "11", count: 32) }, wallet: W, payee: P, amount: 10000, now: at), .failure(.digestMismatch))
  }
  func testOperatorHasNoCompiledDefaults() {
    Operator.info = [:]; Operator.setWallet(nil); defer { TestOperator.configure() }
    XCTAssertNil(Operator.server); XCTAssertEqual(Operator.wallet, ""); XCTAssertFalse(Operator.ownerPayEnabled); XCTAssertEqual(Mainnet.server.host, "kipurse.invalid")
    Operator.info = ["KipurseMainnetServer": "$(KIPURSE_MAINNET_SERVER)"]; XCTAssertNil(Operator.server)
    Operator.setWallet("0x1000000000000000000000000000000000000009"); XCTAssertEqual(PhoneTrust.mainnetWallet, "0x1000000000000000000000000000000000000009"); Operator.setWallet(nil)
  }
}

final class OwnerExitTests: XCTestCase {
  func testSelectorsAndCalldata() {
    XCTAssertEqual(Hex.encode(OwnerExit.selector("transfer(address,uint256)")), "0xa9059cbb")
    XCTAssertEqual(Hex.encode(OwnerExit.selector("execute(address,uint256,bytes)")), "0xb61d27f6")
    let d = OwnerExit.transferData(to: "0x1000000000000000000000000000000000000003", amount: 14_100_000)!
    XCTAssertEqual(d, "0xa9059cbb0000000000000000000000001000000000000000000000000000000000000003" + "0000000000000000000000000000000000000000000000000000000000d72620")
    let e = OwnerExit.executeData(to: "0x1000000000000000000000000000000000000003", amount: 1)!
    XCTAssertTrue(e.hasPrefix("0xb61d27f6000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913"))
    XCTAssertEqual((e.count - 2) / 2, 4 + 32 * 4 + 96)
    XCTAssertNil(OwnerExit.transferData(to: "0x12", amount: 1))
  }
  // vectors from the gateway's withdrawCalls (viem): the phone builds byte-identical calldata
  let W = "0x1000000000000000000000000000000000000004", O = "0x2000000000000000000000000000000000000002", V = "0x3000000000000000000000000000000000000003", X = "0x2000000000000000000000000000000000000004"
  let sweep = "0xb61d27f6000000000000000000000000300000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000435faa41600000000000000000000000000000000000000000000000000000000"
  let xfer = "0xb61d27f6000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb00000000000000000000000020000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000757e2000000000000000000000000000000000000000000000000000000000"
  func testWithdrawBatchMatchesGateway() {
    let b = OwnerExit.withdrawBatch(wallet: W, owner: O, vault: V, amount: 7_700_000)!
    XCTAssertEqual(b.map(\.data), [sweep, xfer]); XCTAssertEqual(b.map(\.to), [W, W])
    XCTAssertEqual(OwnerExit.withdrawBatch(wallet: W, owner: O, vault: nil, amount: 7_700_000)!.map(\.data), [xfer])
    XCTAssertNil(OwnerExit.withdrawBatch(wallet: W, owner: O, vault: nil, amount: 0))
  }
  func testVerifyPlanRefusesTampering() {
    let good: [[String: String]] = [["to": W, "value": "0x0", "data": sweep], ["to": W, "value": "0x0", "data": xfer]]
    XCTAssertNil(OwnerExit.verifyPlan(calls: good, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000))
    XCTAssertEqual(OwnerExit.verifyPlan(calls: good, wallet: W, owner: O, planOwner: X, vault: V, amount: 7_700_000), .notOwner, "server says another owner")
    XCTAssertEqual(OwnerExit.verifyPlan(calls: good, wallet: W, owner: X, planOwner: X, vault: V, amount: 7_700_000), .notExpected, "pays O but the phone's owner is X")
    XCTAssertEqual(OwnerExit.verifyPlan(calls: good, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_000_000), .notExpected, "amount differs from what was shown")
    XCTAssertEqual(OwnerExit.verifyPlan(calls: [good[1]], wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .badShape)
    XCTAssertEqual(OwnerExit.verifyPlan(calls: good + [good[1]], wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .badShape, "extra hidden call")
    var other = good; other[1]["to"] = X
    XCTAssertEqual(OwnerExit.verifyPlan(calls: other, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .wrongWallet)
    var valued = good; valued[1]["value"] = "0x1"
    XCTAssertEqual(OwnerExit.verifyPlan(calls: valued, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .badShape)
    let toX = OwnerExit.executeData(to: X, amount: 7_700_000)!
    XCTAssertEqual(OwnerExit.verifyPlan(calls: [good[0], ["to": W, "value": "0x0", "data": toX]], wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .notExpected, "pays a stranger")
  }
  // t789: wallet-pays withdrawal (fee <= 0.25 USDC to the fixed Kipurse address, the rest to the owner), vectors from the gateway (viem)
  let wpFee = "0xb61d27f6000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000fc0e68572cdba016c1c90a45e1792f3fe0ee345b000000000000000000000000000000000000000000000000000000000001d4c000000000000000000000000000000000000000000000000000000000", wpRest = "0xb61d27f6000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000044a9059cbb0000000000000000000000002000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000073a96000000000000000000000000000000000000000000000000000000000"
  func testWalletPaysBatchMatchesGateway() {
    XCTAssertEqual(OwnerExit.withdrawBatchWalletPays(wallet: W, owner: O, vault: V, amount: 7_700_000, fee: 120_000)!.map(\.data), [sweep, wpFee, wpRest])
    XCTAssertNil(OwnerExit.withdrawBatchWalletPays(wallet: W, owner: O, vault: V, amount: 7_700_000, fee: 250_001), "fee over 0.25 USDC")
    XCTAssertNil(OwnerExit.withdrawBatchWalletPays(wallet: W, owner: O, vault: V, amount: 100_000, fee: 100_000), "fee eats everything")
    XCTAssertEqual(OwnerExit.decodeUSDCTransfer(wpFee)?.amount, 120_000)
    XCTAssertEqual(OwnerExit.decodeUSDCTransfer(wpFee)?.to.lowercased(), OwnerExit.withdrawFeeTo.lowercased())
  }
  func testVerifyAnyPlanAcceptsOnlyTheTwoShapes() {
    let plain: [[String: String]] = [["to": W, "value": "0x0", "data": sweep], ["to": W, "value": "0x0", "data": xfer]]
    let wp: [[String: String]] = [["to": W, "value": "0x0", "data": sweep], ["to": W, "value": "0x0", "data": wpFee], ["to": W, "value": "0x0", "data": wpRest]]
    XCTAssertNil(OwnerExit.verifyAnyPlan(calls: plain, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000))
    XCTAssertNil(OwnerExit.verifyAnyPlan(calls: wp, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000))
    XCTAssertEqual(OwnerExit.walletFee(calls: wp, vault: V), 120_000); XCTAssertEqual(OwnerExit.walletFee(calls: plain, vault: V), 0)
    // fee to a stranger
    var s = wp; s[1]["data"] = OwnerExit.executeData(to: X, amount: 120_000)!
    XCTAssertEqual(OwnerExit.verifyAnyPlan(calls: s, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .feeNotToKipurse)
    // fee above 0.25 USDC
    var big = wp; big[1]["data"] = OwnerExit.executeData(to: OwnerExit.withdrawFeeTo, amount: 250_001)!; big[2]["data"] = OwnerExit.executeData(to: O, amount: 7_700_000 - 250_001)!
    XCTAssertEqual(OwnerExit.verifyAnyPlan(calls: big, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .feeTooHigh)
    // rest to a stranger
    var r = wp; r[2]["data"] = OwnerExit.executeData(to: X, amount: 7_580_000)!
    XCTAssertEqual(OwnerExit.verifyAnyPlan(calls: r, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .notExpected)
    // rest short-changed (fee + rest != amount)
    var short = wp; short[2]["data"] = OwnerExit.executeData(to: O, amount: 7_000_000)!
    XCTAssertEqual(OwnerExit.verifyAnyPlan(calls: short, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .notExpected)
    // extra hidden call, missing sweep, wrong wallet, value, other owner
    XCTAssertNotNil(OwnerExit.verifyAnyPlan(calls: wp + [wp[2]], wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000))
    XCTAssertNotNil(OwnerExit.verifyAnyPlan(calls: Array(wp.dropFirst()), wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000))
    var ww = wp; ww[2]["to"] = X
    XCTAssertEqual(OwnerExit.verifyAnyPlan(calls: ww, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .wrongWallet)
    var vv = wp; vv[1]["value"] = "0x5"
    XCTAssertEqual(OwnerExit.verifyAnyPlan(calls: vv, wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000), .badShape)
    XCTAssertEqual(OwnerExit.verifyAnyPlan(calls: wp, wallet: W, owner: O, planOwner: X, vault: V, amount: 7_700_000), .notOwner)
    // fee-first order swapped (owner first, fee second) is refused
    XCTAssertNotNil(OwnerExit.verifyAnyPlan(calls: [wp[0], wp[2], wp[1]], wallet: W, owner: O, planOwner: O, vault: V, amount: 7_700_000))
  }
}

final class MultiUserTests: XCTestCase {
  override func setUp() { super.setUp(); TestOperator.configure() }
  override func tearDown() { TestOperator.configure(); super.tearDown() }
  func testNoWalletCompiledIn() { Operator.setWallet(nil); XCTAssertEqual(Operator.wallet, ""); XCTAssertEqual(Mainnet.server, Mainnet.base); XCTAssertNil(Operator.ownerAccount) }
  func testTenantPrefixedServer() {
    Operator.setWallet(nil); Operator.setWallet("0x2000000000000000000000000000000000000002", owner: "0x1000000000000000000000000000000000000003")
    XCTAssertEqual(Mainnet.server.absoluteString, "https://kipurse.example/t/0x2000000000000000000000000000000000000002")
    XCTAssertEqual(Operator.ownerAccount, "0x1000000000000000000000000000000000000003")
    Operator.setWallet("0x2000000000000000000000000000000000000002", path: ""); XCTAssertEqual(Mainnet.server, Mainnet.base, "legacy URL space from the server")
    Operator.setWallet(nil); XCTAssertEqual(Operator.wallet, ""); XCTAssertNil(Operator.ownerAccount); XCTAssertEqual(Operator.tenantPath, "")
  }
  func testFindDigestMatchesServer() { XCTAssertEqual(Hex.encode(Mainnet.findDigest(nonce: String(repeating: "ab", count: 24))).lowercased(), "0xb6d0952584996252dba4f42ff01664a641cfbcb36d3ca19c5816a11ec1e227ef") }
}

final class CoinbaseIdentityTests: XCTestCase {
  func j(_ s: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }
  let O = "0x1000000000000000000000000000000000000003", W = "0x2000000000000000000000000000000000000002"
  func testReconnectReusesKey() {
    let r = CoinbaseIdentity.Result(j(#"{"state":"done","result":"reconnect","owner":"\#(O)","wallet":"\#(W)","path":"/t/\#(W.lowercased())"}"#))
    XCTAssertEqual(r?.outcome, .reconnect); XCTAssertEqual(r?.wallet, W); XCTAssertEqual(r?.path, "/t/" + W.lowercased()); XCTAssertTrue(CoinbaseIdentity.reusesPhoneKey(r!))
  }
  func testNewAndBindNeverReuseStaleKey() {
    let n = CoinbaseIdentity.Result(j(#"{"state":"done","result":"new","owner":"\#(O)","wallet":null}"#)); XCTAssertEqual(n?.outcome, .new); XCTAssertNil(n?.wallet); XCTAssertFalse(CoinbaseIdentity.reusesPhoneKey(n!))
    let b = CoinbaseIdentity.Result(j(#"{"state":"done","result":"bind","owner":"\#(O)","wallet":"\#(W)"}"#)); XCTAssertEqual(b?.outcome, .bind); XCTAssertFalse(CoinbaseIdentity.reusesPhoneKey(b!))
  }
  func testRejectsMalformed() {
    XCTAssertNil(CoinbaseIdentity.Result(j(#"{"state":"start"}"#)))
    XCTAssertNil(CoinbaseIdentity.Result(j(#"{"state":"done","result":"reconnect","owner":"\#(O)"}"#)), "reconnect without wallet")
    XCTAssertNil(CoinbaseIdentity.Result(j(#"{"state":"done","result":"new","owner":"\#(O)","wallet":"\#(W)"}"#)), "new with a wallet")
    XCTAssertNil(CoinbaseIdentity.Result(j(#"{"state":"done","result":"reconnect","owner":"nope","wallet":"\#(W)"}"#)))
    XCTAssertNil(CoinbaseIdentity.Result(j(#"{"state":"done","result":"steal","owner":"\#(O)","wallet":"\#(W)"}"#)))
    XCTAssertNil(CoinbaseIdentity.Result(j(#"{"state":"done","result":"reconnect","owner":"\#(O)","wallet":"\#(W)","path":"/evil"}"#))?.path)
  }
  func testFirstRunGateAndMigration() {
    let d = UserDefaults(suiteName: "kp.test.identity")!; d.removePersistentDomain(forName: "kp.test.identity")
    XCTAssertFalse(CoinbaseIdentity.verified(d), "fresh install: must sign in with Coinbase")
    CoinbaseIdentity.migrate(d, launchedBefore: false, wallet: W); XCTAssertFalse(CoinbaseIdentity.verified(d), "reinstall never trusts the leftover key")
    CoinbaseIdentity.migrate(d, launchedBefore: true, wallet: ""); XCTAssertFalse(CoinbaseIdentity.verified(d))
    CoinbaseIdentity.migrate(d, launchedBefore: true, wallet: W); XCTAssertTrue(CoinbaseIdentity.verified(d), "app update keeps a working wallet")
  }
  func testOnboardBodyCarriesSignedInOwner() {
    let b = Onboard.startBody(x: [1], y: [2], single: "1", daily: "5", term: "20", days: "90", owner: O); XCTAssertEqual(b["owner"], O)
    XCTAssertNil(Onboard.startBody(x: [1], y: [2], single: "1", daily: "5", term: "20", days: "90", owner: "bad")["owner"])
  }
}

final class SignOutStateTests: XCTestCase {
  /// After sign-out the identity flags are gone, so the first-run gate shows again and migrate() can't re-verify without a wallet.
  func testSignedOutStateNeedsCoinbaseAgain() {
    let d = UserDefaults(suiteName: "kp.test.signout")!; d.removePersistentDomain(forName: "kp.test.signout")
    d.set(true, forKey: CoinbaseIdentity.verifiedKey); XCTAssertTrue(CoinbaseIdentity.verified(d))
    for k in [CoinbaseIdentity.verifiedKey, CoinbaseIdentity.ownerKey] { d.removeObject(forKey: k) }
    CoinbaseIdentity.migrate(d, launchedBefore: true, wallet: ""); XCTAssertFalse(CoinbaseIdentity.verified(d))
  }
  func testFeeLineReadsSignedAuthorization() throws {
    XCTAssertEqual(AnswerRules.percent(ppm: 1000), "0.1%"); XCTAssertEqual(AnswerRules.percent(ppm: 3000), "0.3%"); XCTAssertEqual(AnswerRules.percent(ppm: 250), "0.025%")
    let s = WalletState(try JSONDecoder().decode(JSONValue.self, from: Data(#"{"caps":{"maxNetworkFee":"20000","maxFeePpm":"500"}}"#.utf8)))
    XCTAssertEqual(s.capMaxNetworkFee, 20_000); XCTAssertEqual(s.capFeePpm, 500); XCTAssertEqual(s.protocolFee(5_000_000), 2_500); XCTAssertEqual(s.protocolFee(1), 1)
  }
}
