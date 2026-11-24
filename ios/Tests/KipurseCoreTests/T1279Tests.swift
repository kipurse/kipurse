// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import KipurseCore

/// t1279: R14 (onramp "arrived" vs. replayed old transfers), R15 (home balance never falls back to the server's), R17 (connect name).
final class T1279Tests: XCTestCase {
  let wallet = "0x00000000000000000000000000000000000000a1"
  let other = "0x00000000000000000000000000000000000000b2"
  let tx = "0x" + String(repeating: "ab", count: 32)
  func topic(_ a: String) -> String { "0x" + String(repeating: "0", count: 24) + a.dropFirst(2).lowercased() }
  func log(from: String, to: String, _ v: Int64, token: String = VaultCheck.usdc) -> [String: Any] {
    ["address": token, "topics": [OnrampChainConfirm.transferTopic, topic(from), topic(to)], "data": "0x" + String(repeating: "0", count: 48) + String(format: "%016llx", v)]
  }
  func receipt(_ logs: [[String: Any]], block: Int64 = 200, status: String = "0x1") -> [String: Any] {
    ["status": status, "blockNumber": "0x" + String(block, radix: 16), "logs": logs]
  }
  let none: OnrampChainConfirm.BalanceRead = { _ in nil }
  func confirm(typed: Int64?, shown: String? = "19.40", txHash: String? = nil, baseline: OnrampBaseline?, now: Date = Date(),
               receipt r: Any? = nil, balance: Int64? = nil) async -> Bool {
    await OnrampChainConfirm.confirmed(wallet: wallet, typed: typed, shown: shown, txHash: txHash ?? (r == nil ? nil : tx), baseline: baseline, now: now,
                                       receipt: { _ in r }, balance: { _ in balance })
  }

  // MARK: R14 tx path
  func testOldTransferBeforeBaselineBlockIsRejected() async {
    let base = OnrampBaseline(balance: 0, block: 200)
    let old = await confirm(typed: 20_000_000, baseline: base, receipt: receipt([log(from: other, to: wallet, 19_400_000)], block: 150))
    XCTAssertFalse(old, "a receipt mined before the purchase started never counts")
    let same = await confirm(typed: 20_000_000, baseline: base, receipt: receipt([log(from: other, to: wallet, 19_400_000)], block: 200))
    XCTAssertFalse(same, "the baseline block itself does not count")
    let fresh = await confirm(typed: 20_000_000, baseline: base, receipt: receipt([log(from: other, to: wallet, 19_400_000)], block: 201))
    XCTAssertTrue(fresh)
    var noBlock = receipt([log(from: other, to: wallet, 19_400_000)]); noBlock["blockNumber"] = nil
    let nb = await confirm(typed: 20_000_000, baseline: base, receipt: noBlock); XCTAssertFalse(nb, "receipt without a block number")
  }
  func testTxPathNeedsBaselineBlockAndFreshness() async {
    let r = receipt([log(from: other, to: wallet, 19_400_000)], block: 500)
    let noBlock = await confirm(typed: 20_000_000, baseline: OnrampBaseline(balance: nil, block: nil), receipt: r)
    XCTAssertFalse(noBlock, "no chain head read at start -> no tx path")
    let noBase = await confirm(typed: 20_000_000, baseline: nil, receipt: r)
    XCTAssertFalse(noBase)
    let t0 = Date()
    let stale = await confirm(typed: 20_000_000, baseline: OnrampBaseline(balance: 0, block: 100, at: t0), now: t0.addingTimeInterval(OnrampBaseline.maxAge + 1), receipt: r)
    XCTAssertFalse(stale, "an abandoned purchase's baseline is never reused")
    let future = await confirm(typed: 20_000_000, baseline: OnrampBaseline(balance: 0, block: 100, at: t0.addingTimeInterval(60)), now: t0, receipt: r)
    XCTAssertFalse(future)
  }
  func testTxPathNetAmountWithinFeeOfTyped() async {
    let base = OnrampBaseline(balance: nil, block: 100)
    let ok = await confirm(typed: 20_000_000, baseline: base, receipt: receipt([log(from: other, to: wallet, 19_000_000)]))
    XCTAssertTrue(ok, "5 % fee")
    let tooLow = await confirm(typed: 20_000_000, baseline: base, receipt: receipt([log(from: other, to: wallet, 18_900_000)]))
    XCTAssertFalse(tooLow)
    let tooHigh = await confirm(typed: 20_000_000, baseline: base, receipt: receipt([log(from: other, to: wallet, 25_000_000)]))
    XCTAssertFalse(tooHigh, "not the purchase the owner typed")
    // in and straight back out in the same tx: net 0
    let roundTrip = await confirm(typed: 20_000_000, baseline: base, receipt: receipt([log(from: other, to: wallet, 19_400_000), log(from: wallet, to: other, 19_400_000)]))
    XCTAssertFalse(roundTrip, "incoming minus outgoing in the same tx")
    let partOut = await confirm(typed: 20_000_000, baseline: base, receipt: receipt([log(from: other, to: wallet, 19_400_000), log(from: wallet, to: other, 5_000_000)]))
    XCTAssertFalse(partOut)
    let selfT = await confirm(typed: 20_000_000, baseline: base, receipt: receipt([log(from: other, to: wallet, 19_400_000), log(from: wallet, to: wallet, 9_000_000)]))
    XCTAssertTrue(selfT, "self-transfer is no net change")
    let reverted = await confirm(typed: 20_000_000, baseline: base, receipt: receipt([log(from: other, to: wallet, 19_400_000)], status: "0x0"))
    XCTAssertFalse(reverted)
  }
  func testNoTypedAmountMeansNoTxPath() async {
    let base = OnrampBaseline(balance: 1_000_000, block: 100)
    let r = receipt([log(from: other, to: wallet, 1)])
    let any = await confirm(typed: nil, shown: nil, baseline: base, receipt: r, balance: 9_000_000)
    XCTAssertFalse(any, "no amount at all -> never 'any amount > 0'")
    let txOnly = await confirm(typed: nil, shown: "19.40", baseline: base, receipt: receipt([log(from: other, to: wallet, 19_400_000)]), balance: nil)
    XCTAssertFalse(txOnly, "no typed amount -> tx path off; balance path can't read -> not arrived")
    let viaBalance = await confirm(typed: nil, shown: "19.40", baseline: base, receipt: r, balance: 20_400_000)
    XCTAssertTrue(viaBalance, "balance rose by the shown amount")
  }

  // MARK: R14 balance path
  func testBalancePathNeedsAboutTheAmount() async {
    let base = OnrampBaseline(balance: 1_000_000, block: nil)
    let small = await confirm(typed: 20_000_000, baseline: base, balance: 1_000_001)
    XCTAssertFalse(small, "rose, but nowhere near the amount (was: any > 0)")
    let enough = await confirm(typed: 20_000_000, baseline: base, balance: 20_000_000)
    XCTAssertTrue(enough, "+19.00 = 20 - 5 %")
    let short = await confirm(typed: 20_000_000, baseline: base, balance: 19_900_000)
    XCTAssertFalse(short)
    let noBal = await confirm(typed: 20_000_000, baseline: OnrampBaseline(balance: nil, block: 5), balance: 99_000_000)
    XCTAssertFalse(noBal, "no baseline balance")
    let shownOnly = await confirm(typed: nil, shown: "4.88", baseline: base, balance: 1_000_000 + 4_380_000)
    XCTAssertTrue(shownOnly, "within 0.50 of the shown amount")
    let shownShort = await confirm(typed: nil, shown: "4.88", baseline: base, balance: 1_000_000 + 4_300_000)
    XCTAssertFalse(shownShort)
  }
  func testFeeTolerance() {
    XCTAssertEqual(OnrampChainConfirm.feeTolerance(20_000_000), 1_000_000)
    XCTAssertEqual(OnrampChainConfirm.feeTolerance(5_000_000), 500_000)
    XCTAssertFalse(OnrampChainConfirm.withinFee(0, expected: 5_000_000))
    XCTAssertFalse(OnrampChainConfirm.roseEnough(now: 5, baseline: Int64.min, expected: 1))
  }
  func testReceiptCanonIncludesBlock() {
    let a = receipt([log(from: other, to: wallet, 1)], block: 10), b = receipt([log(from: other, to: wallet, 1)], block: 11)
    XCTAssertNotEqual(OnrampChainConfirm.receiptCanon(a), OnrampChainConfirm.receiptCanon(b), "two nodes must agree on the block too")
  }
  func testBaselineHeadNeedsTwoCloseNodes() async {
    let saved = ChainRPC.transport; defer { ChainRPC.transport = saved }
    var n = 0
    ChainRPC.transport = { _, m, _ in XCTAssertEqual(m, "eth_blockNumber"); n += 1; return n == 1 ? "0x64" : "0x70" }
    let h = await OnrampBaseline.agreedHeadStrict(); XCTAssertEqual(h, 0x70, "the higher of two close heads")
    n = 0; ChainRPC.transport = { _, _, _ in n += 1; return n == 1 ? "0x64" : "0x10000" }
    let far = await OnrampBaseline.agreedHeadStrict(); XCTAssertNil(far, "heads far apart -> can't confirm")
    ChainRPC.transport = { _, _, _ in throw URLError(.timedOut) }
    let b = await OnrampBaseline.read(wallet: wallet, balance: { _ in 7 }); XCTAssertNil(b.block); XCTAssertEqual(b.balance, 7)
  }

  // MARK: R15 agreed balance memory
  func state(_ bal: String, wallet w: String? = nil) -> WalletState {
    WalletState(.object(["balance": .string(bal), "setup": .object(["wallet": .string(w ?? wallet)])]))
  }
  func testServerNumberNeverReplacesAgreed() {
    var m = AgreedBalanceMemory()
    XCTAssertEqual(m.apply(to: state("999000000"), wallet: wallet).balance, 999_000_000, "first load: nothing agreed yet, server number shown")
    XCTAssertNil(m.ledgerEnd(chain: nil, wallet: wallet), "no agreed value -> ledger is not rebuilt from the server balance")
    m.record(5_000_000, wallet: wallet)
    XCTAssertEqual(m.apply(to: state("999000000"), wallet: wallet).balance, 5_000_000, "server's number never overwrites an agreed one")
    m.record(nil, wallet: wallet)   // nodes failed / disagreed
    XCTAssertEqual(m.value(for: wallet), 5_000_000, "keeps the last agreed value")
    XCTAssertEqual(m.ledgerEnd(chain: nil, wallet: wallet), 5_000_000)
    XCTAssertEqual(m.ledgerEnd(chain: 6_000_000, wallet: wallet), 6_000_000)
    m.record(6_000_000, wallet: wallet.uppercased().replacingOccurrences(of: "0X", with: "0x"))
    XCTAssertEqual(m.value(for: wallet), 6_000_000, "case-insensitive wallet")
  }
  func testAgreedBalanceIsPerWallet() {
    var m = AgreedBalanceMemory(); m.record(5_000_000, wallet: wallet)
    XCTAssertNil(m.value(for: other))
    XCTAssertEqual(m.apply(to: state("1", wallet: other), wallet: other).balance, 1, "another wallet's agreed value is never shown")
    m.record(nil, wallet: other); XCTAssertNil(m.value(for: wallet), "switching wallet starts over")
    m.record(3, wallet: wallet); m.reset(); XCTAssertNil(m.value(for: wallet))
  }
  func testDepositArrivalOnlyFromAgreedBalances() {
    XCTAssertEqual(DepositArrival.plus(baseline: 1_000_000, now: 3_000_000), 2_000_000)
    XCTAssertNil(DepositArrival.plus(baseline: nil, now: 3_000_000), "no agreed baseline")
    XCTAssertNil(DepositArrival.plus(baseline: 1_000_000, now: nil), "no agreed balance now")
    XCTAssertNil(DepositArrival.plus(baseline: 3_000_000, now: 3_000_000))
  }

  // MARK: R17 connect name
  func testConnectShownName() {
    XCTAssertEqual(ConnectBrand.shown(host: "claude.ai"), "Claude")
    XCTAssertEqual(ConnectBrand.shown(host: "evil.example"), "evil.example", "unknown host: the host, never the self-chosen name")
    XCTAssertEqual(ConnectBrand.shown(host: ""), "AI")
    XCTAssertEqual(ConnectBrand.shown(host: "claude.ai.evil.example"), "claude.ai.evil.example")
  }
}
