// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import KipurseCore

/// t1286 (decision 157): after [zh] → [zh] must come back at once (per-wallet copy) or, without it,
/// fast and complete from the chain (birth block + parallel windows).
final class T1286RecordsKeptTests: XCTestCase {
  var saved: (@Sendable (URL, String, [Any]) async throws -> String)!
  var savedAny: ChainRPC.AnyTransport!
  var suite: UserDefaults!
  override func setUp() {
    saved = ChainRPC.transport; savedAny = ChainRPC.anyTransport
    suite = UserDefaults(suiteName: "t1286-\(UUID().uuidString)")!; ChainLedger.store = suite; ChainLedger.forgetAll()
  }
  override func tearDown() { ChainRPC.transport = saved; ChainRPC.anyTransport = savedAny; ChainLedger.store = .standard }
  let w = "0x4494ced7f076c523b3da8e013e6706ac4d9d3ae6"

  func row(_ kind: String, _ delta: Int64, _ t: Date, account: String = "wallet") -> JSONValue {
    .object(["tx": .string("0x" + String(repeating: "a", count: 64)), "t": .string(String(Int64(t.timeIntervalSince1970))), "kind": .string(kind),
             "delta": .string(String(delta)), "account": .string(account), "balance": .string("0")])
  }
  func testMonthSpendCountsOnlyThisMonthsWalletPayments() {
    var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "America/Chicago")!
    let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 26, hour: 7))!
    let nov22 = cal.date(from: DateComponents(year: 2026, month: 11, day: 22, hour: 17, minute: 53))!
    let oct30 = cal.date(from: DateComponents(year: 2026, month: 10, day: 30, hour: 12))!
    let rows = [row("payment", -200200, nov22), row("deposit", 7921551, nov22), row("withdraw", -1_000_000, nov22),
                row("walletfee", -50_000, nov22), row("payment", -300_000, oct30), row("payment", -10_000, nov22, account: "owner")]
    XCTAssertEqual(ChainLedger.monthSpend(rows: rows, now: now, calendar: cal), 200200, "only this month's wallet payments (amount + fee)")
    XCTAssertEqual(ChainLedger.payments(rows: rows).count, 2)
  }
  func testBirthBinarySearchAndKept() async {
    let born: Int64 = 60_956_411
    let lock = NSLock(); var calls = 0
    ChainRPC.transport = { _, m, p in
      guard m == "eth_getCode", let h = p.last as? String, let b = Int64(h.dropFirst(2), radix: 16) else { throw URLError(.badServerResponse) }
      lock.lock(); calls += 1; lock.unlock()
      return b >= born ? "0x6080" : "0x"
    }
    let b = await ChainLedger.birth(wallet: w, head: 62_540_014)
    XCTAssertEqual(b, born); XCTAssertLessThanOrEqual(calls, 26, "binary search, not a block-by-block walk")
    ChainRPC.transport = { _, _, _ in throw URLError(.badServerResponse) }
    let again = await ChainLedger.birth(wallet: w, head: 62_540_100); XCTAssertEqual(again, born, "kept per wallet: no second search")
    ChainLedger.forgetAll()
    let afterSignOut = await ChainLedger.birth(wallet: w, head: 62_540_100); XCTAssertEqual(afterSignOut, born, "a public fact: survives sign-out")
  }
  func testBirthUnknownWhenNodesCannotAnswerOldState() async {
    ChainRPC.transport = { _, m, p in
      if m == "eth_getCode", let h = p.last as? String, h == "0x" + String(62_540_014, radix: 16) { return "0x6080" }
      throw URLError(.badServerResponse) }
    let b = await ChainLedger.birth(wallet: w, head: 62_540_014); XCTAssertNil(b)
    XCTAssertNil(suite.object(forKey: ChainLedger.birthKey(w)), "nothing kept when unknown")
  }
  /// Fake chain: head 62.54M, born 60.96M, the real 3 transfers (2 rows). First scan must find both in ONE step.
  func fakeChain() {
    let head: Int64 = 62_540_014, born: Int64 = 60_956_411
    let pad = ChainLedger.topicAddress(w)!
    let wallet = w
    func log(_ b: Int64, _ tx: String, _ from: String, _ to: String, _ amt: Int64) -> [String: Any] {
      ["topics": [ChainLedger.transferTopic, ChainLedger.topicAddress(from)!, ChainLedger.topicAddress(to)!], "transactionHash": tx,
       "data": "0x" + String(repeating: "0", count: 64 - String(amt, radix: 16).count) + String(amt, radix: 16),
       "blockNumber": "0x" + String(b, radix: 16), "logIndex": "0x" + String(b % 7 + (amt == 150_000 ? 1 : 0), radix: 16),
       "blockTimestamp": "0x" + String(1_795_000_000 + b / 5, radix: 16)]
    }
    let tx1 = "0x00943e1f35" + String(repeating: "1", count: 54), tx2 = "0xe35ce44f67" + String(repeating: "2", count: 54)
    let logs = [log(born, tx1, "0xef6b64eb64a7f28215b0b97d51a2008458bf0deb", wallet, 8_071_551),
                log(born, tx1, wallet, "0xea304e4a74abc3a4cc4ec621452c1e4896c14e27", 150_000),
                log(61_006_087, tx2, wallet, "0x53f99af228a165a312ed4a7e47447a9137dbf03e", 200_200)]
    ChainRPC.transport = { _, m, p in
      if m == "eth_blockNumber" { return "0x" + String(head, radix: 16) }
      if m == "eth_getCode", let h = p.last as? String, let b = Int64(h.dropFirst(2), radix: 16) { return b >= born ? "0x6080" : "0x" }
      throw URLError(.badServerResponse) }
    ChainRPC.anyTransport = { _, m, p in
      guard m == "eth_getLogs", let q = p.first as? [String: Any], let fs = q["fromBlock"] as? String, let ts = q["toBlock"] as? String,
            let f = Int64(fs.dropFirst(2), radix: 16), let t = Int64(ts.dropFirst(2), radix: 16), let tp = q["topics"] as? [Any] else { throw URLError(.badServerResponse) }
      if t - f + 1 > 50_000 { throw URLError(.badServerResponse) }
      let wantTo = (tp[2] as? String) == pad
      return logs.filter { l in
        let b = Int64((l["blockNumber"] as! String).dropFirst(2), radix: 16)!; let x = l["topics"] as! [String]
        return b >= f && b <= t && (wantTo ? x[2] == pad : x[1] == pad)
      } as [Any]
    }
  }
  func testFirstScanFindsEveryMovementInOneStep() async {
    fakeChain()
    let rows = await ChainLedger.update(wallet: w, owner: nil, existing: [], endingBalance: 7_721_351)
    XCTAssertEqual(rows?.count, 2, "both rows (deposit-with-fee tx and the payment) in the FIRST step")
    XCTAssertEqual(rows?.map { $0["delta"]?.atomic ?? 0 }.sorted(), [-200_200, 7_921_551])
    XCTAssertEqual(ChainLedger.monthSpend(rows: rows ?? [], now: Date(timeIntervalSince1970: TimeInterval(1_795_000_000 + 61_006_087 / 5))), 200_200)
    let c = ChainLedger.cursor(w)
    XCTAssertEqual(c?.newest, 62_540_014); XCTAssertEqual(c?.oldest, 60_956_411 - ChainLedger.preBirthMargin, "fast pass starts a day before birth")
    XCTAssertFalse(ChainLedger.complete(wallet: w), "older blocks down to the floor still follow in later rounds")
  }
  func testParallelWindowsStopAtTheFirstFailedWindow() async {
    fakeChain()
    let pad = ChainLedger.topicAddress(w)!
    let inner = ChainRPC.anyTransport
    ChainRPC.anyTransport = { u, m, p in
      if let q = p.first as? [String: Any], let fs = q["fromBlock"] as? String, Int64(fs.dropFirst(2), radix: 16) == 61_100_000 { throw URLError(.timedOut) }
      return try await inner(u, m, p)
    }
    var budget = 80
    let r = await ChainLedger.collectParallel(wallet: w, pad: pad, usdc: VaultCheck.usdc, fromBlock: 60_900_000, toBlock: 61_499_999, chunk: 50_000, nodes: ChainRPC.publicNodes, budget: &budget)
    XCTAssertEqual(r?.scannedTo, 61_099_999, "contiguous up to the failed window only")
    XCTAssertEqual(r?.transfers.count, 3)
  }
  func testAppKeepsThePerWalletCopyAcrossSignOut() throws {
    let base = #filePath.replacingOccurrences(of: "Tests/KipurseCoreTests/T1286RecordsKeptTests.swift", with: "App/Sources/")
    let app = try String(contentsOfFile: base + "AppModel.swift"), cache = try String(contentsOfFile: base + "OfflineRescue.swift")
    let signOut = app.components(separatedBy: "func signOut() {")[1].components(separatedBy: "\n  }\n")[0]
    XCTAssertFalse(signOut.contains("LedgerCache.wipe()"), "退出登录 / 换账户 keeps this wallet's records")
    XCTAssertTrue(app.contains("MainnetSession.clear(); LedgerCache.wipe(); resetWalletScopedState(); state = nil"), "a followed wallet move still forgets everything")
    XCTAssertTrue(cache.contains("static func slot(_ w: String) -> URL"), "one copy per wallet address")
    XCTAssertTrue(cache.contains("guard CacheGuard.usable(cachedWallet: ws.wallet, current: w) else { return nil }"), "never another wallet's copy")
    XCTAssertTrue(cache.contains("f.lastPathComponent.hasPrefix(\"kp-ledger.\")"), "清空本机 / 删除账户 removes every wallet's copy")
    let platform = try String(contentsOfFile: base + "Platform.swift")
    XCTAssertTrue(platform.contains("LedgerCache.wipe()   // t821"), "LocalWipe still removes the copies")
    let life = try String(contentsOfFile: base + "LifeTab.swift")
    XCTAssertTrue(life.contains("txs.isEmpty ? ChainLedger.monthSpend(rows: raw[\"ledger\"]?.array ?? [], now: now)"))
  }
  func testCacheGuardNeverShowsAnotherWallet() {
    XCTAssertFalse(CacheGuard.usable(cachedWallet: w, current: "0x" + String(repeating: "1", count: 40)))
    XCTAssertTrue(CacheGuard.usable(cachedWallet: w, current: w.uppercased().replacingOccurrences(of: "0X", with: "0x")))
  }
}
