import XCTest
@testable import KipurseCore

/// t934 security verification (client side). The server and contracts enforce; these pin what the phone shows and signs.
final class T934SecurityTests: XCTestCase {
  func st(_ j: String) throws -> WalletState { WalletState(try JSONDecoder().decode(JSONValue.self, from: Data(j.utf8))) }

  // MARK: Pause AI payments — one switch stops every AI, Siri included
  func testGlobalPauseGreysEveryAgentIncludingSiri() {
    let now = Date()
    for (connected, pending, last) in [(true, 2, now), (true, 0, now), (true, 0, nil as Date?)] {
      let p = AgentPhase.derive(connected: connected, paused: false, allPaused: true, pendingPayments: pending, lastUsed: last, now: now)
      XCTAssertEqual(p, .paused, "allPaused must win over online/paying")
      _ = connected
    }
  }
  func testSiriNeverSkipsConfirmWhileAIPaused() throws {
    let caps = #""caps":{"single":"5000000","daily":"20000000"}"#
    XCTAssertTrue(SiriSkip.inside(1_000_000, try st("{\(caps)}")))
    XCTAssertFalse(SiriSkip.inside(1_000_000, try st("{\(caps),\"paused\":true}")), "global pause (bool)")
    XCTAssertFalse(SiriSkip.inside(1_000_000, try st("{\(caps),\"paused\":{\"active\":true}}")), "global pause (object)")
    XCTAssertFalse(SiriSkip.inside(1_000_000, try st("{\(caps),\"agents\":[{\"id\":\"siri\",\"kind\":\"siri\",\"paused\":true}]}")), "Siri itself paused")
    XCTAssertTrue(SiriSkip.inside(1_000_000, try st("{\(caps),\"paused\":{\"active\":false}}")))
  }
  func testPausedServerAnswerSaysNothingMoved() {
    XCTAssertEqual(SiriAgentAnswer.text(["decision": "rejected", "reason": "agent_paused"], zh: false), "Not paid. No money moved.")
    XCTAssertFalse(AgentLimits.needsFaceID(["decision": "rejected"]))
  }
  func testWithdrawStillBuildsWhilePaused() {
    // The owner's withdraw batch has no pause input at all: pausing AI can never block it.
    let w = "0x1000000000000000000000000000000000000001", o = "0x1000000000000000000000000000000000000002"
    let b = OwnerExit.withdrawBatch(wallet: w, owner: o, vault: nil, amount: 1_000_000)
    XCTAssertEqual(b?.count, 1); XCTAssertEqual(b?.first?.to, w)
    XCTAssertTrue(b?.first?.data.lowercased().contains(String(o.dropFirst(2)).lowercased()) ?? false, "money goes only to the owner")
  }

  // MARK: Caps
  func testAllowanceInputRules() {
    XCTAssertNil(AgentLimits.problem(single: "0.25", daily: "2", zh: false))
    XCTAssertNotNil(AgentLimits.problem(single: "3", daily: "2", zh: false), "per payment > per day")
    XCTAssertNotNil(AgentLimits.problem(single: "0", daily: "2", zh: false))
    XCTAssertNotNil(AgentLimits.problem(single: "0.0000001", daily: "2", zh: false), "> 6 decimals")
    XCTAssertNotNil(AgentLimits.problem(single: "-1", daily: "2", zh: false))
    XCTAssertEqual(AgentLimits.atomic("0.25"), 250_000); XCTAssertEqual(AgentLimits.atomic("2"), 2_000_000)
  }
  func testSiriSkipRespectsBothCaps() throws {
    let s = try st(#"{"caps":{"single":"250000","daily":"2000000"},"spent":{"today":"1900000"}}"#)
    XCTAssertTrue(SiriSkip.inside(100_000, s)); XCTAssertFalse(SiriSkip.inside(100_001, s)); XCTAssertFalse(SiriSkip.inside(250_001, try st(#"{"caps":{"single":"250000","daily":"2000000"}}"#)))
  }

  // MARK: New payee / phishing payee -> Face ID, and the phone refuses a swapped payee
  func testNewPayeeNeedsFaceID() {
    XCTAssertTrue(AgentLimits.needsFaceID(["decision": "ask_owner", "reason": "new_payee"]))
    XCTAssertFalse(AgentLimits.needsFaceID(["decision": "can_pay"]))
    let c = OwnerPay.Challenge(["id": "a", "digest": "0x00", "approvalDigest": "0x00", "purchaseKey": "0x" + String(repeating: "1", count: 64), "payee": "0x1000000000000000000000000000000000000003",
                                "amount": "10000", "deadline": "1792700000", "wallet": "0x1000000000000000000000000000000000000001", "chainId": 8453, "newPayee": true])
    XCTAssertEqual(c?.newPayee, true)
  }
  func testPhoneRefusesSwappedPayeeAmountWalletAndStaleDeadline() {
    let w = "0x1000000000000000000000000000000000000001", p = "0x1000000000000000000000000000000000000003", evil = "0x1000000000000000000000000000000000000666"
    let now = Date(timeIntervalSince1970: 1792699700)
    let c = OwnerPay.Challenge(id: "a", digest: "0x00", approvalDigest: "0x00", purchaseKey: "0x" + String(repeating: "1", count: 64), payee: evil, amount: "10000",
                               deadline: "1792700000", wallet: w, chainId: 8453, fee: "10", newPayee: true)
    XCTAssertEqual(try? OwnerPay.toSign(c, wallet: w, payee: p, amount: 10000, now: now).get(), nil)
    if case .failure(let e) = OwnerPay.toSign(c, wallet: w, payee: p, amount: 10000, now: now) { XCTAssertEqual(e, .wrongPayee) } else { XCTFail() }
    var c2 = c; c2.payee = p
    if case .failure(let e) = OwnerPay.toSign(c2, wallet: w, payee: p, amount: 9999, now: now) { XCTAssertEqual(e, .wrongAmount) } else { XCTFail() }
    if case .failure(let e) = OwnerPay.toSign(c2, wallet: evil, payee: p, amount: 10000, now: now) { XCTAssertEqual(e, .wrongWallet) } else { XCTFail() }
    if case .failure(let e) = OwnerPay.toSign(c2, wallet: w, payee: p, amount: 10000, now: Date(timeIntervalSince1970: 1792700000)) { XCTAssertEqual(e, .expired) } else { XCTFail() }
    if case .failure(let e) = OwnerPay.toSign(c2, wallet: w, payee: p, amount: 10000, now: now) { XCTAssertEqual(e, .digestMismatch, "server digest that the phone can't recompute is refused") } else { XCTFail() }
    var c3 = c2; c3.chainId = 1
    if case .failure(let e) = OwnerPay.toSign(c3, wallet: w, payee: p, amount: 10000, now: now) { XCTAssertEqual(e, .wrongChain, "replay on another chain") } else { XCTFail() }
  }
}
