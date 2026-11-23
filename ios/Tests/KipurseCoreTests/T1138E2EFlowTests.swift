import XCTest
@testable import KipurseCore

/// t1138u (§6#70): the app's OWN client checks run on the REAL replies of the production server code (release under test),
/// recorded by the end-to-end flow matrix on a local Base-mainnet fork with throwaway keys (t1138-matrix.e2e.mjs).
/// Each test = one app guard on one real server reply. Fixture: t1138-e2e-fixtures.json.txt (written by the matrix run).
final class T1138E2EFlowTests: XCTestCase {
  static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  lazy var fx: [String: Any] = {
    guard let d = try? Data(contentsOf: Self.dir.appendingPathComponent("t1138-e2e-fixtures.json.txt")),
          let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return [:] }
    return j }()
  lazy var fxv: JSONValue = {
    guard let d = try? Data(contentsOf: Self.dir.appendingPathComponent("t1138-e2e-fixtures.json.txt")) else { return .null }
    return (try? JSONDecoder().decode(JSONValue.self, from: d)) ?? .null }()
  func obj(_ k: String) throws -> [String: Any] { guard let o = fx[k] as? [String: Any] else { throw XCTSkip("fixture \(k) missing") }; return o }
  func val(_ k: String) throws -> JSONValue { guard let v = fxv[k], v != .null else { throw XCTSkip("fixture \(k) missing") }; return v }
  func hexBytes(_ s: String) -> [UInt8] { Hex.decode(s) ?? [] }
  func calls(_ a: Any?) -> [[String: Any]] { (a as? [[String: Any]]) ?? [] }
  func strCalls(_ a: Any?) -> [[String: String]] { calls(a).map { $0.compactMapValues { $0 as? String } } }
  func state(_ k: String) throws -> WalletState { WalletState(try val(k)) }
  func wallet(_ u: String) throws -> String { (try obj(u + ".confirm"))["wallet"] as! String }
  func owner(_ u: String) throws -> String { (try obj(u + ".confirm"))["owner"] as! String }
  /// t1197u (§6#92): the phone uses THIS wallet's suite (remembered at opening / detected from its on-chain vault). Pin it like the app does.
  @discardableResult func pinSuite(_ u: String) throws -> KipurseSuite {
    let w = try wallet(u), v = try state(u + ".stateAfterOpen").raw["vault"]?["address"]?.string
    let s = try XCTUnwrap(KipurseSuite.forVault(v, wallet: w), "\(u): server vault is not one of this wallet's Kipurse vaults"); KipurseSuite.pin(s); return s }
  override func tearDown() { KipurseSuite.pin(nil); super.tearDown() }
  func testNewWalletsAreOnV53() throws { for u in ["U1", "U2"] { XCTAssertEqual(try pinSuite(u), .v53, u) } }

  // MARK: opening (OnboardFlow.start + verifiedPage)
  func testOpeningQuoteParses() throws { XCTAssertNotNil(Onboard.Quote(try val("U1.quote"))) }
  func testOpeningBatchPassesThePhoneChecks() throws {
    for u in ["U1", "U2"] {
      let st = try obj(u + ".start"), pr = try obj(u + ".prepare"); let res = pr["res"] as! [String: Any], ch = pr["choice"] as! [String: String]
      let w = res["wallet"] as! String, o = (pr["req"] as! [String: Any])["owner"] as! String
      if let po = res["owner"] as? String { XCTAssertEqual(po.lowercased(), o.lowercased()) }
      let choice = RequestVerify.Choice(single: String(AnswerRules.parseUSDC(ch["single"]!) ?? 0), daily: String(AnswerRules.parseUSDC(ch["daily"]!) ?? 0), term: String(AnswerRules.parseUSDC(ch["term"]!) ?? 0), days: Int(ch["days"]!))
      let c = BatchVerify.calls(try val(u + ".prepare")["res"]?["calls"]) ?? []
      XCTAssertFalse(c.isEmpty, u)
      let newWallet = !((res["existing"] as? Bool) ?? false)
      let rep = BatchVerify.setup(calls: c, wallet: w, owner: o, x: hexBytes(pr["x"] as! String), y: hexBytes(pr["y"] as! String), choice: choice, newWallet: newWallet, vault: res["vault"] as? String)
      XCTAssertTrue(rep.ok, "\(u) setup: \(rep.problems)")
      let ugs = UsdcGas.split(c, wallet: w, vault: res["vault"] as? String); XCTAssertTrue(ugs.problems.isEmpty, "\(u) usdc: \(ugs.problems)")   // t1197u: as verifiedPage (with the server vault)
      XCTAssertFalse(newWallet && ugs.feeRepaid == 0 && ugs.approved == 0, "\(u) opening must pay the fee in USDC in this confirmation")
      if ugs.deposit != 0 { XCTAssertEqual(ugs.deposit, Onboard.depositAtomic(pr["deposit"] as! String) ?? 0, u) }
      let url = URL(string: ((st["res"] as! [String: Any])["url"] as! String))!
      XCTAssertNotNil(BatchVerify.committedURL(url, chainId: BatchVerify.chainId(try val(u + ".prepare")["res"]?["chainId"]) ?? 8453, from: o, calls: c), u)
      let cf = try obj(u + ".confirm"); XCTAssertEqual(cf["ok"] as? Bool, true); XCTAssertEqual((cf["wallet"] as! String).lowercased(), w.lowercased())
    }
  }
  // MARK: phone session
  func testSessionChallengeDigestMatchesThePhone() throws {
    let c = try obj("U1.sessionChallenge"); let n = c["nonce"] as! String
    XCTAssertTrue(Mainnet.validNonce(n))
    XCTAssertEqual(Hex.encode(Mainnet.sessionDigest(wallet: try wallet("U1"), nonce: n)).lowercased(), (c["digest"] as! String).lowercased())
  }
  // MARK: 记录 / 上限 display after each step
  func testStateAfterOpeningShowsBalanceLimitsAndNoAIYet() throws {
    let st = try state("U1.stateAfterOpen")
    XCTAssertEqual(st.raw["balance"]?.string, "20000000")
    XCTAssertNil(AISpendLimits.saved(st.raw), "AI limits are not confirmed at opening")
    if case .ready(let s, let d, let t, _) = WalletLimitsLine.state(st) { XCTAssertEqual([s, d, t], [5_000_000, 20_000_000, 100_000_000]) } else { XCTFail("上限 row not ready: \(WalletLimitsLine.state(st))") }
  }
  func testRecordsShowDepositWithdrawAndFees() throws {
    let dep = try state("U1.stateAfterDeposit"); XCTAssertTrue(dep.ledger.contains { $0.delta == 30_000_000 }, "deposit row: \(dep.ledger.map { $0.delta })")
    let wd = try state("U1.stateAfterWithdraw.amount 1.5"); let row = wd.ledger.first { $0.delta == -1_500_000 }
    XCTAssertNotNil(row, "withdraw row: \(wd.ledger.map { ($0.delta, $0.fee ?? -1) })")
    let page = try obj("U1.withdrawPagePrepare.amount 1.5"); let fee = Int64((page["res"] as! [String: Any])["fee"] as? String ?? "0") ?? 0
    if fee > 0 { XCTAssertEqual(row?.fee, fee, "the withdraw row shows the wallet-paid fee") }
    XCTAssertEqual(wd.raw["balance"]?.string, String(48_500_000))
    XCTAssertFalse(wd.ledger.contains { $0.zh.contains("0xf14e") }, "no row may say money went to the fee address: \(wd.ledger.map { $0.zh })")
    let lim = try state("U1.stateAfterLimits"); let fr = lim.ledger.first { $0.kind == "walletfee" }
    XCTAssertNotNil(fr, "limits change shows as a network-fee row: \(lim.ledger.map { ($0.kind, $0.zh) })"); XCTAssertEqual(fr?.fee, fr.map { -$0.delta })
  }
  func testLimitsLineAfterSafetyLimitChange() throws {
    let st = try state("U1.stateAfterLimits")
    if case .ready(let s, let d, let t, _) = WalletLimitsLine.state(st) { XCTAssertEqual([s, d, t], [8_000_000, 30_000_000, 150_000_000]) } else { XCTFail("上限 row not ready: \(WalletLimitsLine.state(st))") }
  }
  // MARK: withdraw (WithdrawView)
  func testWithdrawPlansPassThePhoneChecks() throws {
    for l in ["amount 1.5", "all"] {
      let p = try obj("U1.withdrawPrepare." + l), res = p["res"] as! [String: Any], amt = Int64((p["req"] as! [String: Any])["amount"] as! String)!
      XCTAssertTrue(WithdrawAmount.preparedMatches(prepared: UInt64(res["amount"] as! String)!, confirmed: amt), l)
      XCTAssertNil(OwnerExit.verifyAnyPlan(calls: strCalls(res["calls"]), wallet: res["wallet"] as! String, owner: p["owner"] as! String, planOwner: res["owner"] as! String, vault: res["vault"] as? String, amount: UInt64(amt)), l)
      let pg = try obj("U1.withdrawPagePrepare." + l), pres = pg["res"] as! [String: Any]
      XCTAssertEqual(pres["feeFrom"] as? String, "wallet", l)
      XCTAssertNil(OwnerExit.verifyAnyPlan(calls: strCalls(pres["calls"]), wallet: pres["wallet"] as! String, owner: pg["owner"] as! String, planOwner: pres["owner"] as! String, vault: pres["vault"] as? String, amount: UInt64(amt)), "page plan \(l)")
      let cf = (try obj("U1.withdrawConfirm." + l))["app"] as! [String: Any]; XCTAssertEqual(cf["ok"] as? Bool, true, "the app's own poll (its plan id) sees success: \(l)")
    }
  }
  // MARK: wallet safety limits (LimitsFee.load + verifyThenSign)
  func testLimitsFeeAndPlanPassThePhoneChecks() throws {
    try pinSuite("U1")
    let f = (try obj("U1.limitsFee"))["res"] as! [String: Any]
    XCTAssertEqual(f["gasToken"] as? String, Principles.gasToken); XCTAssertEqual(f["feeFrom"] as? String, UsdcGas.feeFrom)
    let p = try obj("U1.limitsPrepare"); var res = p["res"] as! [String: Any]
    // the fork server runs with publicBase http://fork.invalid; production serves the same path from the app's fixed host
    if let pm = res["pm"] as? String, pm.hasPrefix("http://fork.invalid/"), let h = URL(string: RequestVerify.limitsPaymasterPrefix)?.host { res["pm"] = "https://" + h + pm.dropFirst("http://fork.invalid".count) }
    let rep = RequestVerify.limitsReply(res, wallet: p["wallet"] as! String, owner: p["owner"] as? String, choice: .init(single: "8000000", daily: "30000000", term: "150000000", days: 90))
    XCTAssertTrue(rep.result.ok, "\(rep.result.problems)"); XCTAssertNotNil(rep.from)
  }
  // MARK: Face ID revoke + post-opening enable
  func testRevokePlanPassesThePhoneChecks() throws {
    try pinSuite("U1")
    let p = try obj("U1.revokePlan"), r = p["res"] as! [String: Any]
    let rep = BatchVerify.revoke(calls: calls(r["calls"]), wallet: r["wallet"] as! String, owner: r["owner"] as! String, approver: r["approver"] as? String); XCTAssertTrue(rep.ok, "\(rep.problems)")
  }
  func testPostOpeningEnrollPassesThePhoneChecksAndFeeCap() throws {
    try pinSuite("U1")
    let p = try obj("U1.enroll"), r = p["res"] as! [String: Any]
    XCTAssertNil(EnrollFee.problem(r, owner: r["owner"] as! String))
    let rep = BatchVerify.enroll(calls: calls(r["calls"]), wallet: r["wallet"] as! String, owner: r["owner"] as! String, x: hexBytes(p["x"] as! String), y: hexBytes(p["y"] as! String), replacing: nil)
    XCTAssertTrue(rep.ok, "\(rep.problems)")
    let q = (try obj("U1.enrollQuote"))["res"] as! [String: Any]; XCTAssertLessThanOrEqual(Int64(q["fee"] as! String)!, 50_000, "t1128u: <= 0.05 USDC")
  }
  // MARK: AI connect (in-app oauth/first and AI-initiated) + AI limits
  func checkFirstConnect(_ u: String, _ label: String) throws {
    let p = try obj("\(u).\(label).phonePrepare"), j = p["res"] as! [String: Any]
    XCTAssertTrue(ConnectApproval.acceptsFirstConnect(j["mode"] as? String))
    let w = try wallet(u); XCTAssertEqual((j["wallet"] as! String).lowercased(), w.lowercased())
    let exp = (j["exp"] as! NSNumber).intValue
    func d(_ a: Bool) -> [UInt8] { ConnectApproval.firstDigest(wallet: w, clientId: j["clientId"] as! String, agent: j["name"] as! String, request: j["req"] as! String, redirect: j["redirect"] as! String,
      single: Int64(j["single"] as! String)!, daily: Int64(j["daily"] as! String)!, total: Int64(j["total"] as! String)!, nonce: j["nonce"] as! String, exp: exp, approve: a) }
    XCTAssertTrue(ConnectApproval.matches(d(true), server: j["digest"] as! String), "\(u) approve digest")
    XCTAssertTrue(ConnectApproval.matches(d(false), server: j["rejectDigest"] as! String), "\(u) reject digest")
    let dd = (try obj("\(u).\(label).phoneDecide"))["res"] as! [String: Any]; XCTAssertTrue(ConnectApproval.finishedDecision(dd["status"] as? String, approve: true))
    let s = AISpendLimits.saved(try state("\(u).stateAfter.\(label)").raw)
    XCTAssertEqual(s?.single, 2_000_000); XCTAssertEqual(s?.daily, 5_000_000); XCTAssertEqual(s?.term, 20_000_000)
  }
  func testInAppConnect() throws { let f = (try obj("U1.oauthFirst"))["res"] as! [String: Any]; XCTAssertEqual(f["mode"] as? String, "first"); XCTAssertTrue(ConnectApproval.validId(f["req"] as! String)); try checkFirstConnect("U1", "inAppConnect") }
  func testAIInitiatedConnect() throws { try checkFirstConnect("U2", "aiInitiatedConnect") }
  func testAILimitChangeIsReadBackByTheApp() throws {
    let p = try obj("U2.everydayPost"); XCTAssertEqual(p["status"] as? Int, 200, "POST everyday \(p)")
    let s = AISpendLimits.saved(try state("U2.stateAfterLimitChange").raw)
    XCTAssertEqual(s?.single, 4_000_000); XCTAssertEqual(s?.daily, 8_000_000); XCTAssertEqual(s?.term, 30_000_000)
  }
  // MARK: trusted payee approved with Face ID (PhoneApproveTrustSheet)
  func testTrustApprovalHashesMatchThePhone() throws {
    try pinSuite("U2")
    let r = (try obj("U2.trustPhonePrepare"))["res"] as! [String: Any], m = r["message"] as! [String: Any], ph = r["phone"] as! [String: Any]
    func s(_ k: String) -> String { if let v = m[k] as? String { return v }; if let n = m[k] as? NSNumber { return n.stringValue }; return "" }
    let om = OwnerTrustMessage(account: s("account"), merchant: s("merchant"), name: s("name"), epoch: s("epoch"), payees: m["payees"] as? [String] ?? [], signers: m["signers"] as? [String] ?? [],
      single: s("single"), daily: s("daily"), expiry: s("expiry"), nonce: s("nonce"), deadline: s("deadline"))
    let w = try wallet("U2")
    XCTAssertEqual(PhoneTrust.problems(om, wallet: w, maxSingle: ph["maxSingle"] as? String ?? "0", maxDaily: ph["maxDaily"] as? String ?? "0"), [])
    XCTAssertEqual(RequestVerify.trust(om, wallet: w, localMaxSingle: nil, localMaxDaily: nil, now: Date(timeIntervalSince1970: (Double(s("deadline")) ?? 0) - 60)), [])   // t1139: judge at the recorded request time (the fixture deadline is 1 h after the run)
    let d = try XCTUnwrap(PhoneTrust.digest(om)); XCTAssertEqual(Hex.encode(d).lowercased(), (r["digest"] as! String).lowercased())
    XCTAssertEqual(Hex.encode(try XCTUnwrap(PhoneTrust.walletHash(d, wallet: w))).lowercased(), (fx["U2.trustReplaySafeHash"] as! String).lowercased(), "the hash the phone signs = wallet.replaySafeHash on chain")
    XCTAssertEqual(((try obj("U2.trustPhoneSign"))["status"] as? Int), 200)
  }
  // MARK: Siri pay + Siri balance source
  func testSiriPayAndBalance() throws {
    XCTAssertEqual((try obj("U1.siriSubmit"))["status"] as? Int, 200)
    let st = try state("U1.stateAfterSiriPay"); XCTAssertNotNil(st.raw["balance"]?.string)
  }
  // MARK: offline rescue (ChainRescue.plan on the fork's real balances). Writes the call for the matrix run to send.
  func testRescuePlanFromForkBalances() throws {
    let f = Self.dir.appendingPathComponent("t1138-rescue-in.json.txt")
    guard let d = try? Data(contentsOf: f), let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let b = j["b"] as? [String: Any] else { throw XCTSkip("no rescue input") }
    let bal = ChainRescue.Balances(wallet: Int64(b["wallet"] as! String)!, vault: Int64(b["vault"] as! String)!, vaultReserved: Int64(b["vaultReserved"] as! String)!, float: Int64(b["float"] as! String)!,
                                   vaultAddress: b["vaultAddress"] as? String, floatAddress: b["floatAddress"] as? String)
    let p = try ChainRescue.plan(wallet: j["wallet"] as! String, owner: j["owner"] as! String, recordedOwner: j["owner"] as? String, adapter: j["adapter"] as! String, usdc: j["usdc"] as! String, b: bal)
    XCTAssertEqual(p.amount, bal.takeNow); XCTAssertFalse(ChainRescue.preview(p).isEmpty)
    let out: [String: Any] = ["call": ["to": p.call.to, "data": p.call.data], "amount": String(p.amount), "steps": p.steps.map { ["to": $0.to, "label": $0.label] }]
    try JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: "/tmp/t1138-rescue-out.json"))
  }
}
