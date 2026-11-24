import XCTest
@testable import KipurseCore

/// t1266: the phone verifies everything it signs / opens / switches to itself. Pure-logic tests for every rule added in t1266.
final class T1266PhoneVerifiesTests: XCTestCase {
  let wallet = "0xef6b64eb64a7f28215b0b97d51a2008458bf0deb"
  let usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  override func setUp() { Operator.demoWallet = nil }

  // MARK: fix 1 - the allowance text is parsed on the phone
  func text(_ items: String, wallet w: String? = nil, id: String = "apr_0123456789ab", scope: Bool = true, mode: String? = nil) -> String {
    "Kipurse allowance approval v1\nwallet:\(w ?? wallet)\nid:\(id)\nitems:\(items)" + (scope ? "\nchain:8453\ntoken:\(usdc)" : "") + (mode.map { "\nmode:\($0)" } ?? "")
  }
  let agentItems = #"[{"kind":"agent_limits","agentId":"siri","daily":"10000000","monthly":null,"single":"2000000","resume":true}]"#
  func testParseAndCheckTheSignedText() throws {
    let p = try XCTUnwrap(AllowanceText.parse(text(agentItems)))
    XCTAssertEqual(p.wallet, wallet); XCTAssertEqual(p.id, "apr_0123456789ab"); XCTAssertEqual(p.chainId, 8453); XCTAssertEqual(p.token, usdc); XCTAssertNil(p.mode)
    XCTAssertEqual(AllowanceText.problems(p, wallet: wallet.uppercased().replacingOccurrences(of: "0X", with: "0x"), id: "apr_0123456789ab"), [])
    XCTAssertFalse(AllowanceText.problems(p, wallet: "0x0000000000000000000000000000000000000001", id: "apr_0123456789ab").isEmpty, "another wallet")
    XCTAssertFalse(AllowanceText.problems(p, wallet: wallet, id: "apr_other").isEmpty, "another request")
    XCTAssertFalse(AllowanceText.problems(p, wallet: "", id: "apr_0123456789ab").isEmpty, "no wallet on the phone")
    // unscoped (older server) is still a valid text; another network or token is not
    XCTAssertEqual(AllowanceText.problems(try XCTUnwrap(AllowanceText.parse(text(agentItems, scope: false))), wallet: wallet, id: "apr_0123456789ab"), [])
    let other = text(agentItems).replacingOccurrences(of: "chain:8453", with: "chain:1")
    XCTAssertFalse(AllowanceText.problems(try XCTUnwrap(AllowanceText.parse(other)), wallet: wallet, id: "apr_0123456789ab").isEmpty, "another network")
    let tok = text(agentItems).replacingOccurrences(of: usdc, with: "0x1111111111111111111111111111111111111111")
    XCTAssertFalse(AllowanceText.problems(try XCTUnwrap(AllowanceText.parse(tok)), wallet: wallet, id: "apr_0123456789ab").isEmpty, "another token")
    // malformed texts are refused outright
    XCTAssertNil(AllowanceText.parse(text(agentItems) + "\nextra:1"), "extra line")
    XCTAssertNil(AllowanceText.parse(text(agentItems, mode: "trust")), "mode only on the ask choice text")
    XCTAssertNotNil(AllowanceText.parse(text(agentItems, mode: "trust"), allowMode: true))
    XCTAssertNil(AllowanceText.parse(text(agentItems, mode: "all"), allowMode: true), "unknown mode")
    XCTAssertNil(AllowanceText.parse(text("[]")), "no items")
    XCTAssertNil(AllowanceText.parse(text("not json")))
    XCTAssertNil(AllowanceText.parse(text(agentItems, wallet: wallet.uppercased())), "the gateway writes the wallet lowercase")
    XCTAssertNil(AllowanceText.parse("Kipurse allowance approval v2\nwallet:\(wallet)\nid:x\nitems:\(agentItems)"))
    let unknown = try XCTUnwrap(AllowanceText.parse(text(#"[{"kind":"raise_everything","single":"1"}]"#)))
    XCTAssertFalse(AllowanceText.problems(unknown, wallet: wallet, id: "apr_0123456789ab").isEmpty, "an item kind the phone can't show")
  }
  func testCardLinesComeFromTheSignedItems() throws {
    let p = try XCTUnwrap(AllowanceText.parse(text(agentItems)))
    let l = AllowanceText.lines(p)
    XCTAssertEqual(l.count, 1)
    XCTAssertTrue(l[0].contains("siri"))
    XCTAssertTrue(l[0].contains("2") && l[0].contains("10"), l[0])
    XCTAssertTrue(l[0].contains("恢复付款") || l[0].contains("payments back on"), l[0])
    let ask = #"[{"kind":"one_off","purpose":"other","label":null,"single":"30000000","daily":"30000000","monthly":"30000000","payees":["0x1212121212121212121212121212121212123434"],"hosts":[],"agents":[],"recurring":null,"oneOff":{"payee":"0x1212121212121212121212121212121212123434","host":null,"amount":"30000000","idem":null,"remember":true,"aiName":"Desk Shop","ask":true,"note":"standing desk"},"expiresInDays":1,"replaces":null}]"#
    let pa = try XCTUnwrap(AllowanceText.parse(text(ask)))
    let la = AllowanceText.lines(pa, payeeSwap: true)[0]
    XCTAssertTrue(la.contains("0x1212…3434") && la.contains("30"), la)
    XCTAssertTrue(la.contains("Desk Shop"), "the AI's name is shown as unverified")
    XCTAssertTrue(la.contains("冒充") || la.contains("impostor"), "a payee-swap warning may only add caution")
    // the server's separate ask summary must be exactly the signed item
    XCTAssertTrue(AllowanceText.askMatches(pa, payee: "0x1212121212121212121212121212121212123434", amount: "30000000"))
    XCTAssertFalse(AllowanceText.askMatches(pa, payee: "0x9999999999999999999999999999999999993434", amount: "30000000"), "swapped payee")
    XCTAssertFalse(AllowanceText.askMatches(pa, payee: "0x1212121212121212121212121212121212123434", amount: "3000000"), "other amount")
    XCTAssertFalse(AllowanceText.askMatches(p, payee: "0x1212121212121212121212121212121212123434", amount: "30000000"), "not an ask item")
    // overall limit line
    let all = #"[{"kind":"allowance","purpose":"all","label":null,"single":"5000000","daily":"20000000","monthly":"100000000","payees":[],"hosts":[],"agents":[],"recurring":null,"oneOff":null,"expiresInDays":365,"replaces":null}]"#
    let lall = AllowanceText.lines(try XCTUnwrap(AllowanceText.parse(text(all))))[0]
    XCTAssertTrue(lall.contains("5") && lall.contains("20") && lall.contains("100"), lall)
  }
  func testOwnerDraftMustEqualWhatWasTyped() throws {
    let p = try XCTUnwrap(AllowanceText.parse(text(agentItems)))
    let typed = AgentLimits.item(agentId: "siri", single: "2", daily: "10", monthly: nil, resume: true)
    XCTAssertTrue(AllowanceText.draftMatches(p, typed: [typed]))
    XCTAssertFalse(AllowanceText.draftMatches(p, typed: [AgentLimits.item(agentId: "siri", single: "2", daily: "11", monthly: nil, resume: true)]), "other daily")
    XCTAssertFalse(AllowanceText.draftMatches(p, typed: [AgentLimits.item(agentId: "siri", single: "1", daily: "10", monthly: nil, resume: true)]), "other single")
    XCTAssertFalse(AllowanceText.draftMatches(p, typed: [AgentLimits.item(agentId: "siri", single: "2", daily: "10", monthly: nil, resume: false)]), "resume added by the server")
    XCTAssertFalse(AllowanceText.draftMatches(p, typed: [AgentLimits.item(agentId: "claude", single: "2", daily: "10", monthly: nil, resume: true)]), "another AI")
    XCTAssertFalse(AllowanceText.draftMatches(p, typed: [AgentLimits.item(agentId: "siri", single: "2", daily: "10", monthly: "300", resume: true)]), "monthly dropped by the server")
    XCTAssertFalse(AllowanceText.draftMatches(p, typed: [typed, typed]), "item count")
    let extra = try XCTUnwrap(AllowanceText.parse(text(#"[{"kind":"agent_limits","agentId":"siri","daily":"10000000","monthly":null,"single":"2000000","resume":true,"payees":["0x1"]}]"#)))
    XCTAssertFalse(AllowanceText.draftMatches(extra, typed: [typed]), "a field the owner never typed")
    let withMonthly = try XCTUnwrap(AllowanceText.parse(text(#"[{"kind":"agent_limits","agentId":"siri","daily":"10000000","monthly":"300000000","single":"2000000","resume":false}]"#)))
    XCTAssertTrue(AllowanceText.draftMatches(withMonthly, typed: [AgentLimits.item(agentId: "siri", single: "2", daily: "10", monthly: "300", resume: false)]))
  }

  // MARK: fix 2 - signing pages
  func testOnlyKipurseSigningPagesOpen() throws {
    let h = SignHost.apiHost
    let ok = try XCTUnwrap(SignHost.signingPage(URL(string: "https://\(h)/owner/limits?single=1#vh=abc")!, serverHost: h, legacy: ""))
    XCTAssertEqual(ok.host, SignHost.host); XCTAssertTrue(ok.path.hasPrefix(SignHost.setPrefix)); XCTAssertTrue(ok.fragment?.contains("vh=abc") ?? false)
    XCTAssertNotNil(SignHost.signingPage(URL(string: "https://\(h)/t/\(wallet)/owner/withdraw?plan=1")!, serverHost: h, legacy: ""), "tenant path")
    XCTAssertNotNil(SignHost.signingPage(URL(string: "https://\(h)/phone/enroll")!, serverHost: nil, legacy: ""), "no configured server: the API host")
    XCTAssertNil(SignHost.signingPage(URL(string: "http://\(h)/owner/limits")!, serverHost: h, legacy: ""), "http")
    XCTAssertNil(SignHost.signingPage(URL(string: "https://\(h):8443/owner/limits")!, serverHost: h, legacy: ""), "port")
    XCTAssertNil(SignHost.signingPage(URL(string: "https://evil.example/owner/limits")!, serverHost: h, legacy: ""), "other host")
    XCTAssertNil(SignHost.signingPage(URL(string: "https://evil.example/owner/limits")!, serverHost: "evil.example", legacy: ""), "even if configured: not the Kipurse API host")
    XCTAssertNil(SignHost.signingPage(URL(string: "https://\(h)/owner/limits")!, serverHost: "other.example", legacy: ""), "not the configured server")
    XCTAssertNil(SignHost.signingPage(URL(string: "https://\(h)/evil")!, serverHost: h, legacy: ""), "unknown path")
    XCTAssertNil(SignHost.signingPage(URL(string: "https://user:pw@\(h)/owner/limits")!, serverHost: h, legacy: ""), "user info")
    XCTAssertNotNil(SignHost.signingPage(URL(string: "https://\(SignHost.host)\(SignHost.setPrefix)/phone/enroll#u=x")!, serverHost: h, legacy: ""), "already the shell")
    XCTAssertNil(SignHost.signingPage(URL(string: "https://\(SignHost.host)\(SignHost.setPrefix)/anything")!, serverHost: h, legacy: ""), "shell with an unknown path")
    XCTAssertNil(SignHost.signingPage(URL(string: "kipurse://done")!, serverHost: h, legacy: ""))
  }

  // MARK: fix 4 - wallet confirmed on chain
  func word(_ hex: String) -> String { "0x" + String(repeating: "0", count: 64 - hex.count) + hex }
  func pad(_ a: String) -> String { String(repeating: "0", count: 24) + a.dropFirst(2).lowercased() }
  func testWalletOnlyAfterTheChainConfirms() async {
    let owner = "0x1000000000000000000000000000000000000004", appr = "0x3000000000000000000000000000000000000003", w = "0x5000000000000000000000000000000000000005"
    let x = [UInt8](repeating: 7, count: 32), y = [UInt8](repeating: 9, count: 32)
    var reads: [String: String] = [:]
    func set(_ to: String, _ data: String, _ v: String) { reads[to.lowercased() + "|" + data.lowercased()] = v }
    set(w, "0xa2e1a8d8" + pad(owner), word("1")); set(w, "0xa2e1a8d8" + pad(appr), word("1"))
    set(appr, "0x521eb273", word(String(w.dropFirst(2)))); set(appr, "0x0c55699c", Hex.encode(x)); set(appr, "0xa56dfe4a", Hex.encode(y))
    let call: MoveFollow.Call = { to, data in reads[to.lowercased() + "|" + data.lowercased()] }
    let code: MoveFollow.Code = { _ in "0x6001" }
    let ok = await WalletVerify.confirmed(wallet: w, owner: owner, knownOwner: owner, x: x, y: y, approverHints: [appr], call: call, code: code)
    XCTAssertTrue(ok, "owner owns it and this phone's key is its approver")
    let noHint = await WalletVerify.confirmed(wallet: w, owner: owner, knownOwner: owner, x: x, y: y, approverHints: [], call: call, code: code)
    XCTAssertFalse(noHint, "no approver of this wallet holds this key, and it isn't the owner's predicted wallet")
    var x2 = x; x2[0] = 1
    let otherKey = await WalletVerify.confirmed(wallet: w, owner: owner, knownOwner: owner, x: x2, y: y, approverHints: [appr], call: call, code: code)
    XCTAssertFalse(otherKey, "another phone's key")
    let otherOwner = await WalletVerify.confirmed(wallet: w, owner: owner, knownOwner: "0x1000000000000000000000000000000000000009", x: x, y: y, approverHints: [appr], call: call, code: code)
    XCTAssertFalse(otherOwner, "not the owner this phone signed in as")
    let noCode = await WalletVerify.confirmed(wallet: w, owner: owner, knownOwner: owner, x: x, y: y, approverHints: [appr], call: call, code: { _ in nil })
    XCTAssertFalse(noCode, "can't confirm the wallet exists")
    let notOwner = await WalletVerify.confirmed(wallet: w, owner: appr, knownOwner: nil, x: x, y: y, approverHints: [], call: call, code: code)
    XCTAssertFalse(notOwner)
    // predicted wallet of the signed-in owner: accepted without a key (a returning user before Face ID approvals), only for the KNOWN owner
    let pw = KipurseV55.wallet(owner: owner)!
    set(pw, "0xa2e1a8d8" + pad(owner), word("1"))
    let pred = await WalletVerify.confirmed(wallet: pw, owner: owner, knownOwner: owner, x: nil, y: nil, call: call, code: code)
    XCTAssertTrue(pred)
    let predUnknown = await WalletVerify.confirmed(wallet: pw, owner: owner, knownOwner: nil, x: nil, y: nil, call: call, code: code)
    XCTAssertFalse(predUnknown, "a server-named owner never unlocks the predicted-address path")
    XCTAssertTrue(WalletVerify.predicted(owner: owner).contains(pw.lowercased()))
    XCTAssertTrue(WalletVerify.predicted(owner: owner).contains(BatchVerify.predictWallet(owner: owner)!.lowercased()))
  }
  func testAgreedBalance() async {
    let b = await VaultCheck.usdcBalanceAgreed(wallet, call: { _, _ in "0x" + String(repeating: "0", count: 58) + "0f4240" })
    XCTAssertEqual(b, 1_000_000)
    let none = await VaultCheck.usdcBalanceAgreed(wallet, call: { _, _ in nil })
    XCTAssertNil(none, "nodes disagree / unreachable -> unknown, never a number")
  }

  // MARK: fix 6 - first connect
  func testConnectFieldsHostAndExpiry() {
    XCTAssertTrue(ConnectApproval.safeField("Claude"))
    XCTAssertFalse(ConnectApproval.safeField("Cla\nude")); XCTAssertFalse(ConnectApproval.safeField("x\u{0007}")); XCTAssertFalse(ConnectApproval.safeField("\u{202E}evil")); XCTAssertFalse(ConnectApproval.safeField(""))
    XCTAssertEqual(ConnectApproval.returnHost(redirect: "https://claude.ai/api/mcp/auth_callback"), "claude.ai")
    XCTAssertNil(ConnectApproval.returnHost(redirect: "http://claude.ai/cb"))
    XCTAssertNil(ConnectApproval.returnHost(redirect: "https://user@claude.ai/cb"))
    XCTAssertNil(ConnectApproval.returnHost(redirect: "https://claude.ai/cb\n"))
    let now = Date(timeIntervalSince1970: 1_800_000_000), t = 1_800_000_000
    XCTAssertTrue(ConnectApproval.expOK(t + 600, now: now))
    XCTAssertFalse(ConnectApproval.expOK(t, now: now), "expired (lower bound unchanged)")
    XCTAssertTrue(ConnectApproval.expOK(t + 900 + 300, now: now), "15 min + clock-skew tolerance")
    XCTAssertFalse(ConnectApproval.expOK(t + 900 + 301, now: now))
  }
  func testFirstConnectAmountsExactlyWhatWasTyped() {
    let typed = AISpendLimits.Saved(single: 2_000_000, daily: 10_000_000, term: 50_000_000)
    let caps = AILimitGate.Caps.ready(single: 5_000_000, daily: 20_000_000, term: 100_000_000)
    XCTAssertNil(ConnectApproval.firstConnectProblem(server: typed, pending: typed, caps: caps))
    XCTAssertNotNil(ConnectApproval.firstConnectProblem(server: AISpendLimits.Saved(single: 2_000_000, daily: 10_000_000, term: 50_000_001), pending: typed, caps: caps), "server changed the total")
    XCTAssertNotNil(ConnectApproval.firstConnectProblem(server: typed, pending: nil, caps: caps), "nothing typed on this phone")
    XCTAssertNotNil(ConnectApproval.firstConnectProblem(server: typed, pending: typed, caps: .ready(single: 1_000_000, daily: 20_000_000, term: 100_000_000)), "above the wallet caps")
    XCTAssertNotNil(ConnectApproval.firstConnectProblem(server: typed, pending: typed, caps: .unreadable))
    XCTAssertEqual(AILimitGate.verdict(single: "2", daily: "10", term: "50", caps: caps), AILimitGate.verdict(single: 2_000_000, daily: 10_000_000, term: 50_000_000, caps: caps), "one rule")
  }

  // MARK: fix 7 - links any app can open
  func testDeepLinkGate() {
    XCTAssertFalse(DeepLinkGate.acceptsLimits(signingSheetOpen: false, demo: false))
    XCTAssertTrue(DeepLinkGate.acceptsLimits(signingSheetOpen: true, demo: false))
    let u = LimitsUpdate(single: 10, daily: 50, term: 200, start: Date(timeIntervalSince1970: 1), end: Date(timeIntervalSince1970: 2))
    XCTAssertTrue(DeepLinkGate.limitsOnChain(u, chain: .ready(single: 10, daily: 50, term: 200)))
    XCTAssertFalse(DeepLinkGate.limitsOnChain(u, chain: .ready(single: 10, daily: 50, term: 201)))
    XCTAssertFalse(DeepLinkGate.limitsOnChain(u, chain: .unreadable))
    XCTAssertTrue(DeepLinkGate.reviewDemoAllowed(hasState: false, inDemo: false, wallet: "", owner: nil, rememberedWallet: nil, hasSession: false))
    XCTAssertFalse(DeepLinkGate.reviewDemoAllowed(hasState: false, inDemo: false, wallet: wallet, owner: nil, rememberedWallet: nil, hasSession: false))
    XCTAssertFalse(DeepLinkGate.reviewDemoAllowed(hasState: false, inDemo: false, wallet: "", owner: "0x1000000000000000000000000000000000000004", rememberedWallet: nil, hasSession: false))
    XCTAssertFalse(DeepLinkGate.reviewDemoAllowed(hasState: false, inDemo: false, wallet: "", owner: nil, rememberedWallet: wallet, hasSession: false))
    XCTAssertFalse(DeepLinkGate.reviewDemoAllowed(hasState: false, inDemo: false, wallet: "", owner: nil, rememberedWallet: nil, hasSession: true))
    XCTAssertFalse(DeepLinkGate.reviewDemoAllowed(hasState: true, inDemo: false, wallet: "", owner: nil, rememberedWallet: nil, hasSession: false))
    XCTAssertNil(Hex.decode(DemoAddress.placeholder), "the demo placeholder is not an address anything can be sent to")
    XCTAssertEqual(DemoAddress.placeholder.count, 42)
  }

  // MARK: fix 10 - a held Face ID is bound to one request + choice
  func testHeldUnlockIsBoundToRequestAndChoice() {
    var discarded = 0
    let u = ReusableUnlock<Int>(discard: { _ in discarded += 1 }), t = Date()
    u.hold(1, at: t, tag: "a|trust")
    XCTAssertNil(u.take(now: t, userTapped: true, tag: "a|once"), "other choice"); XCTAssertEqual(discarded, 1); XCTAssertFalse(u.isHolding)
    u.hold(2, at: t, tag: "a|trust"); XCTAssertNil(u.take(now: t, userTapped: true, tag: "b|trust"), "other request")
    u.hold(3, at: t, tag: "a|trust"); XCTAssertEqual(u.take(now: t, userTapped: true, tag: "a|trust"), 3)
    u.hold(4, at: t, tag: "a|*"); XCTAssertEqual(u.take(now: t, userTapped: true, tag: "a|once"), 4, "the push path: the owner picks on the card")
    u.hold(5, at: t, tag: "a|*"); XCTAssertNil(u.take(now: t, userTapped: true, tag: "ab|once"))
    u.hold(6, at: t, tag: "a|trust"); XCTAssertNil(u.take(now: t, userTapped: false, tag: "a|trust"), "never without the owner's tap")
    u.hold(7, at: t); XCTAssertNil(u.take(now: t, userTapped: true, tag: "a|trust"), "an unbound hold is not taken by a bound approval")
    u.hold(8, at: t, tag: "a|trust"); XCTAssertNil(u.take(now: t, userTapped: true), "a bound hold is not taken by an unbound take")
  }

  // MARK: fix 11 - clock-skew tolerance on upper bounds only
  func testUpperBoundsTolerateClockSkew() {
    let now = Date(timeIntervalSince1970: 1_800_000_000), t = 1_800_000_000.0
    func msg(expiry: Double) -> OwnerTrustMessage { OwnerTrustMessage(account: wallet, merchant: "0x" + String(repeating: "1", count: 64), name: "x", epoch: "0", payees: ["0x1212121212121212121212121212121212123434"], signers: [], single: "1", daily: "1", expiry: String(Int(expiry)), nonce: "0x" + String(repeating: "2", count: 64), deadline: String(Int(t + 600))) }
    func bad(_ e: Double) -> Bool { OwnerAsk.trustProblems(msg(expiry: e), payee: "0x1212121212121212121212121212121212123434", single: "1", now: now).contains("bad expiry") }
    XCTAssertFalse(bad(t + 91 * 86400 + 200), "within tolerance")   // t1281: ask trusts are at most 90 days (+1 day slack)
    XCTAssertTrue(bad(t + 91 * 86400 + 400), "beyond tolerance")
    XCTAssertTrue(bad(t - 1), "lower bound unchanged")
    // OwnerPay deadline
    let payee = "0x1212121212121212121212121212121212123434", key = "0x" + String(repeating: "ab", count: 32)
    func pay(_ dl: Double) -> Result<[UInt8], OwnerPay.PayCheckError> {
      let a = OwnerPay.approvalDigest(account: wallet, purchaseKey: key, payee: payee, amount: "1000000", deadline: String(Int(dl)))!
      let h = PhoneTrust.walletHash(a, wallet: wallet)!
      let c = OwnerPay.Challenge(id: "x", digest: Hex.encode(h), approvalDigest: Hex.encode(a), purchaseKey: key, payee: payee, amount: "1000000", deadline: String(Int(dl)), wallet: wallet, chainId: 8453, fee: "0", newPayee: false)
      return OwnerPay.toSign(c, wallet: wallet, payee: payee, amount: 1_000_000, now: now)
    }
    if case .failure = pay(t + 3600 + 200) { XCTFail("within tolerance") }
    XCTAssertEqual(pay(t + 3600 + 400), .failure(.expired))
    XCTAssertEqual(pay(t + 5), .failure(.expired), "lower bound unchanged")
  }

  // MARK: fix 11 - the move to V5.5 can't add trusts, raise the float cap or set a foreign recovery address

  // MARK: app wiring (source checks, like the earlier t12xx wiring tests)
  func src(_ f: String) throws -> String {
    try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("App/Sources/" + f), encoding: .utf8)
  }
  func testAppWiring() throws {
    let plat = try src("Platform.swift")
    XCTAssertTrue(plat.contains("let policy: LAPolicy = .deviceOwnerAuthenticationWithBiometrics"), "the unlock context handed to the .biometryCurrentSet key is a biometrics evaluation")
    let app = try src("AppModel.swift")
    XCTAssertTrue(app.contains("let (x, y) = PhoneKey.cachedXY() else { return }"), "followMove never looks the key up (no Face ID)")
    XCTAssertFalse(app.contains("PhoneKey.cachedXY() ?? PhoneKey.existing()"))
    XCTAssertTrue(app.contains("BiometricGate.confirm(reason: reason, approval: true)"), "owner approvals: Face ID only")
    XCTAssertEqual(app.components(separatedBy: "resetWalletScopedState()").count - 1, 3, "defined once, used by sign-out and the followed move")
    let av = try src("AllowancesView.swift")
    XCTAssertTrue(av.contains("func approveAsk(_ a: ApprovalReq, mode: String, userTapped: Bool, ceiling:"), "userTapped is required")
    XCTAssertTrue(av.contains("AllowanceText.draftMatches(pt, typed: items)"))
    XCTAssertTrue(av.contains("PhoneKey.sign(d, key: k, reusesUnlock: true)"), "one approval = one Face ID")
    let res = try src("OfflineRescue.swift")
    XCTAssertTrue(res.contains("#if DEBUG\n    mockOwner = CommandLine.arguments.contains(\"-kpRescueMockOwner\")"))
    let aw = try src("Awareness.swift")
    XCTAssertFalse(aw.contains("approveById"), "a notification button never approves")
    let ps = try src("PhoneSigner.swift")
    XCTAssertFalse(ps.contains("kp.phoneMaxSingle")); XCTAssertTrue(ps.contains("OwnerAsk.trustCapProblems(om, ceiling: ceil0)"))
    let mv = try src("MainnetViews.swift")
    XCTAssertFalse(mv.contains("canEvaluatePolicy(.deviceOwnerAuthentication, error"), "everyday limits: Face ID only")
    XCTAssertTrue(mv.contains("WalletVerify.confirmed(wallet: w"))
  }
}
