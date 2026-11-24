// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import KipurseCore

/// t1278: security review fixes A1-A4, A7 (pure rules in T1278Guards.swift).
final class T1278SecurityTests: XCTestCase {
  // MARK: A1 push-only card never signs from that tap
  func testPushApproveNeverSigns() {
    XCTAssertEqual(PushedApproval.next(approve: true), .showFullCard, "approve on a push-only card only re-renders the full card")
    XCTAssertEqual(PushedApproval.next(approve: false), .reject, "decline from the push stays a reject (safe)")
  }
  func testHeldSignInFaceIDOnlyForThisRequestsFullCardTap() {
    let id = "11111111-2222-3333-4444-555555555555", t0 = Date()
    var discarded = 0
    let u = ReusableUnlock<Int>(discard: { _ in discarded += 1 })
    u.hold(7, at: t0, tag: PushedApproval.heldTag(id: id))
    XCTAssertEqual(u.take(now: t0.addingTimeInterval(20), userTapped: true, tag: PushedApproval.approveTag(id: id)), 7, "the full card's tap reuses the sign-in Face ID")
    u.hold(8, at: t0, tag: PushedApproval.heldTag(id: id))
    XCTAssertNil(u.take(now: t0.addingTimeInterval(20), userTapped: true, tag: PushedApproval.approveTag(id: "other")), "another request never takes it")
    u.hold(9, at: t0, tag: PushedApproval.heldTag(id: id))
    XCTAssertNil(u.take(now: t0.addingTimeInterval(61), userTapped: true, tag: PushedApproval.approveTag(id: id)), "older than 60 s")
    u.hold(10, at: t0, tag: PushedApproval.heldTag(id: id))
    XCTAssertNil(u.take(now: t0.addingTimeInterval(5), userTapped: false, tag: PushedApproval.approveTag(id: id)), "only a tap on the full card")
    XCTAssertEqual(discarded, 3)
  }

  // MARK: A3 merchant-signer grant only for the shown domain
  func testGrantOnlyForTheDomainTheCardShows() {
    XCTAssertTrue(SignerGrantDomain.ok(cardDomain: "shop.example", merchant: "shop.example"))
    XCTAssertTrue(SignerGrantDomain.ok(cardDomain: "shop.example", merchant: "Shop.Example"), "case-insensitive host")
    XCTAssertTrue(SignerGrantDomain.ok(cardDomain: "shop.example", merchant: "shop.example."), "trailing dot")
    XCTAssertFalse(SignerGrantDomain.ok(cardDomain: nil, merchant: "shop.example"), "no domain shown -> no grant")
    XCTAssertFalse(SignerGrantDomain.ok(cardDomain: "shop.example", merchant: "evil.example"))
    XCTAssertFalse(SignerGrantDomain.ok(cardDomain: "shop.example", merchant: ""))
    XCTAssertFalse(SignerGrantDomain.ok(cardDomain: "shop.example", merchant: "shop.example.evil.example"))
    XCTAssertFalse(SignerGrantDomain.ok(cardDomain: "SHOP.EXAMPLE", merchant: "shop.example"), "a domain the card does not show (not a plain lowercase host)")
    XCTAssertTrue(SignerGrantDomain.shownNameOK("shop.example")); XCTAssertFalse(SignerGrantDomain.shownNameOK("Bid Glow")); XCTAssertFalse(SignerGrantDomain.shownNameOK(""))
  }

  // MARK: A4 "arrived" only when the phone sees it on chain
  let wallet = "0x00000000000000000000000000000000000000a1"
  func receipt(to: String, value: Int64, status: String = "0x1", token: String = VaultCheck.usdc) -> [String: Any] {
    let w = "0x" + String(repeating: "0", count: 24) + to.dropFirst(2).lowercased()
    let v = "0x" + String(repeating: "0", count: 48) + String(format: "%016llx", value)
    return ["status": status, "logs": [["address": token, "topics": [OnrampChainConfirm.transferTopic, "0x" + String(repeating: "0", count: 64), w], "data": v]]]
  }
  let tx = "0x" + String(repeating: "ab", count: 32)
  func testArrivedNeedsChainConfirmation() async {
    // t1279: confirmed() now needs a fresh baseline (block + balance) and an owner-typed amount for the tx path; see T1279Tests
    let none: OnrampChainConfirm.BalanceRead = { _ in nil }
    let base = OnrampBaseline(balance: 1_000_000, block: 100)
    func rc(_ to: String, _ v: Int64, status: String = "0x1", token: String = VaultCheck.usdc) -> [String: Any] { var r = self.receipt(to: to, value: v, status: status, token: token); r["blockNumber"] = "0x65"; return r }
    let a = await OnrampChainConfirm.confirmed(wallet: wallet, typed: 5_000_000, shown: "4.88", txHash: tx, baseline: base, receipt: { _ in rc(self.wallet, 4_880_000) }, balance: none)
    XCTAssertTrue(a, "Transfer of the amount to this wallet in the server's tx")
    let b = await OnrampChainConfirm.confirmed(wallet: wallet, typed: 5_000_000, shown: "4.88", txHash: tx, baseline: base, receipt: { _ in rc("0x00000000000000000000000000000000000000b2", 4_880_000) }, balance: none)
    XCTAssertFalse(b, "sent to another address")
    let c = await OnrampChainConfirm.confirmed(wallet: wallet, typed: 5_000_000, shown: "4.88", txHash: tx, baseline: base, receipt: { _ in rc(self.wallet, 1_000) }, balance: none)
    XCTAssertFalse(c, "far less than the amount")
    let d = await OnrampChainConfirm.confirmed(wallet: wallet, typed: 5_000_000, shown: "4.88", txHash: tx, baseline: base, receipt: { _ in rc(self.wallet, 4_880_000, status: "0x0") }, balance: none)
    XCTAssertFalse(d, "reverted tx")
    let e = await OnrampChainConfirm.confirmed(wallet: wallet, typed: 5_000_000, shown: "4.88", txHash: tx, baseline: base, receipt: { _ in rc(self.wallet, 4_880_000, token: "0x00000000000000000000000000000000000000c3") }, balance: none)
    XCTAssertFalse(e, "not USDC")
    let f = await OnrampChainConfirm.confirmed(wallet: wallet, typed: 5_000_000, shown: "4.88", txHash: tx, baseline: base, receipt: { _ in nil }, balance: none)
    XCTAssertFalse(f, "nodes disagree / unreachable")
    let g = await OnrampChainConfirm.confirmed(wallet: wallet, typed: nil, shown: "4.88", txHash: nil, baseline: base, receipt: { _ in nil }, balance: { _ in 5_800_000 })
    XCTAssertTrue(g, "balance rose by about the amount (fees out)")
    let h = await OnrampChainConfirm.confirmed(wallet: wallet, typed: nil, shown: "4.88", txHash: nil, baseline: base, receipt: { _ in nil }, balance: { _ in 1_000_000 })
    XCTAssertFalse(h, "balance did not rise")
    let i = await OnrampChainConfirm.confirmed(wallet: wallet, typed: 5_000_000, shown: "4.88", txHash: nil, baseline: nil, receipt: { _ in nil }, balance: { _ in 9_000_000 })
    XCTAssertFalse(i, "no baseline and no tx -> can't confirm")
    let j = await OnrampChainConfirm.confirmed(wallet: wallet, typed: 5_000_000, shown: "4.88", txHash: "0x12", baseline: base, receipt: { _ in rc(self.wallet, 4_880_000) }, balance: none)
    XCTAssertFalse(j, "malformed tx hash is never looked up")
  }
  func testGatedState() {
    XCTAssertEqual(OnrampState.arrived(amount: "1", txHash: nil).gated(chainConfirmed: false), .arriving(amount: "1"))
    XCTAssertFalse(OnrampState.arrived(amount: "1", txHash: nil).gated(chainConfirmed: false).isFinal, "keeps polling")
    XCTAssertEqual(OnrampState.arrived(amount: "1", txHash: nil).gated(chainConfirmed: true), .arrived(amount: "1", txHash: nil))
    XCTAssertEqual(OnrampState.failed.gated(chainConfirmed: false), .failed)
  }
  func testReceiptNeedsTwoNodesToAgree() async {
    let saved = ChainRPC.anyTransport; defer { ChainRPC.anyTransport = saved }
    var n = 0
    ChainRPC.anyTransport = { _, method, _ in XCTAssertEqual(method, "eth_getTransactionReceipt"); n += 1; return self.receipt(to: self.wallet, value: n == 1 ? 4_880_000 : 1) }
    let r = await OnrampChainConfirm.agreedReceipt(tx); XCTAssertNil(r, "two nodes disagree")
    ChainRPC.anyTransport = { _, _, _ in self.receipt(to: self.wallet, value: 4_880_000) }
    let r2 = await OnrampChainConfirm.agreedReceipt(tx); XCTAssertNotNil(r2)
  }

  // MARK: A7 two-node reads, chain caps first, rollback
  func testIsOwnerAgreed() async {
    let yes = "0x" + String(repeating: "0", count: 63) + "1"
    let a = await VaultCheck.isOwnerAgreed(wallet: wallet, address: "0x00000000000000000000000000000000000000b2", call: { _, _ in yes }); XCTAssertEqual(a, true)
    let b = await VaultCheck.isOwnerAgreed(wallet: wallet, address: "0x00000000000000000000000000000000000000b2", call: { _, _ in nil }); XCTAssertNil(b, "nodes disagree")
    let c = await VaultCheck.isOwnerAgreed(wallet: "0x12", address: "0x00000000000000000000000000000000000000b2", call: { _, _ in yes }); XCTAssertNil(c)
  }
  func state(_ caps: [String: JSONValue]?, src: String? = nil) -> WalletState {
    var o: [String: JSONValue] = ["mode": .string("MAIN"), "wallet": .string(wallet)]
    if let caps { o["caps"] = .object(caps) }
    if let src { o["capsSrc"] = .string(src) }
    return WalletState(.object(o))
  }
  func testChainCapsWinOverServer() {
    let server = state(["single": .string("50000000"), "daily": .string("500000000"), "term": .string("5000000000")])
    let chain = SafetyCaps.Read(caps: .ready(single: 5_000_000, daily: 50_000_000, term: 500_000_000), start: 1, end: 2)
    let m = CapsSource.merged(server, chain: chain)
    XCTAssertEqual(m.capRead, .ready(single: 5_000_000, daily: 50_000_000, term: 500_000_000)); XCTAssertEqual(m.raw["capsSrc"]?.string, "chain")
    XCTAssertEqual(CapsSource.merged(server, chain: SafetyCaps.Read(caps: .unset)).capRead, .unset, "chain says no permission")
    XCTAssertEqual(CapsSource.merged(m, chain: SafetyCaps.Read(caps: .unreadable)).capRead, m.capRead, "unreadable keeps the last good value")
    // the next server state keeps the last chain value of the same wallet
    let carried = CapsSource.carry(from: m, into: server)
    XCTAssertEqual(carried.capRead, .ready(single: 5_000_000, daily: 50_000_000, term: 500_000_000)); XCTAssertEqual(carried.raw["caps"]?["start"]?.atomic, 1)
    XCTAssertEqual(CapsSource.carry(from: server, into: server).capRead, server.capRead, "no chain value yet: server's")
  }
  func testRollbackNeedsAgreedCode() async {
    let w = "0x00000000000000000000000000000000000012e8"; let key = "kp.suite." + w
    defer { UserDefaults.standard.removeObject(forKey: key) }
    KipurseSuite.remember(.v54, wallet: w)
    let no = await KipurseSuite.detect(wallet: w, serverVault: KipurseSuite.v52.vault(wallet: w), code: { _ in nil })
    XCTAssertEqual(no, .v54, "nodes disagree / no code -> no rollback on the server's word")
    let empty = await KipurseSuite.detect(wallet: w, serverVault: KipurseSuite.v52.vault(wallet: w), code: { _ in "0x" })
    XCTAssertEqual(empty, .v54)
    let yes = await KipurseSuite.detect(wallet: w, serverVault: KipurseSuite.v52.vault(wallet: w), code: { _ in "0x6080" })
    XCTAssertEqual(yes, .v52)
  }

  // MARK: A5 connect card brand only from the signed return host
  func testConnectBrandOnlyFromReturnHost() {
    XCTAssertEqual(ConnectBrand.verified(host: "claude.ai"), "Claude")
    XCTAssertEqual(ConnectBrand.verified(host: "API.Claude.com."), "Claude")
    XCTAssertEqual(ConnectBrand.verified(host: "www.cursor.com"), "Grok")
    XCTAssertEqual(ConnectBrand.verified(host: "muse.ai"), "Muse")
    XCTAssertNil(ConnectBrand.verified(host: "claude.ai.evil.com"))
    XCTAssertNil(ConnectBrand.verified(host: "notclaude.ai"))
    XCTAssertNil(ConnectBrand.verified(host: "kipurse.com"))
  }
}
