// SPDX-License-Identifier: Apache-2.0
import XCTest
@testable import KipurseCore

/// t1282 (decision 156, owner t1276–t1282; cards t1282s6035 / t1283 / t1284): after [zh] → [zh] the wallet page showed 0 USDC,
/// [zh] stayed "[zh]" and [zh] was empty although the wallet held 7.721351 USDC with 3 movements.
/// Transfer fixtures use a synthetic wallet with the SAME shape as the real history (blocks 60,956,411 / 61,006,087, head 62,372,567).
final class T1282ReloginTests: XCTestCase {
  let A = "0x515010c2e41f98cddd76b819ee69dc832c0939b6"   // public permission fixture account (T1129)
  let approved = "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000515010c2e41f98cddd76b819ee69dc832c0939b600000000000000000000000005320bed08309f66316f7d73e2d0be110400fbb2000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000000000000000174876e8000000000000000000000000000000000000000000000000000000000001e13380000000000000000000000000000000000000000000000000000000006af66209000000000000000000000000000000000000000000000000000000006cd79589000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000180000000000000000000000000ec477db93a09327b986acf016143d44ab06f3f590000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003b9aca0000000000000000000000000000000000000000000000000000000002540be400000000000000000000000000000000000000000000000000000000174876e80000000000000000000000000000000000000000000000000000000000000186a00000000000000000000000000000000000000000000000000000000000030e0800000000000000000000000000000000000000000000000000000000001e848000000000000000000000000000000000000000000000000000000000004c5ec800000000000000000000000026c707ccbd569624cf31f5c574d4fdf7e3f2399800000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000000c350"
  let W = "0x5eed00000000000000000000000000000000c0a9", O = "0x5eed0000000000000000000000000000000000aa"
  let F = "0x00000000000000000000000000000000000000ff"
  var savedT: ChainRPC.Transport!, savedAny: ChainRPC.AnyTransport!, suite: UserDefaults!
  override func setUp() { savedT = ChainRPC.transport; savedAny = ChainRPC.anyTransport
    suite = UserDefaults(suiteName: "t1282-\(UUID().uuidString)"); SafetyCaps.store = suite; ChainLedger.store = suite; SafetyCaps.query = nil }
  override func tearDown() { ChainRPC.transport = savedT; ChainRPC.anyTransport = savedAny; SafetyCaps.store = .standard; ChainLedger.store = .standard; Loc.override = nil }
  let one = "0x" + String(repeating: "0", count: 63) + "1", zero = "0x" + String(repeating: "0", count: 64)
  func head(_ h: Int64) -> String { "0x" + String(h, radix: 16) }
  var permLog: [String: Any] { ["topics": [SafetyCaps.eventTopic], "data": approved, "blockNumber": "0x3614a0d", "logIndex": "0x54"] }
  func logsFor(_ p: [Any], at block: Int64, _ log: [String: Any]) -> [Any] {
    let f = p[0] as! [String: Any]
    let from = ChainLedger.hexInt(f["fromBlock"])!, to = ChainLedger.hexInt(f["toBlock"])!
    return (from...to).contains(block) ? [log] : []
  }

  // MARK: (1) no placeholder 0
  func testShellBalanceIsUnknownUntilRead() {
    let shell = WalletState.shell(wallet: W, owner: O)
    XCTAssertFalse(shell.balanceKnown, "the shell's 0 is a placeholder")
    XCTAssertTrue(shell.withBalance(7_721_351).balanceKnown)
    XCTAssertEqual(shell.withBalance(7_721_351).balance, 7_721_351)
    XCTAssertTrue(shell.withBalance(0).balanceKnown, "a real 0 read from the chain is shown as 0")
    XCTAssertTrue(WalletState(.object(["balance": .string("5")])).balanceKnown, "server states are real balances")
    XCTAssertFalse(shell.withLedger([]).withEveryday(.object([:])).balanceKnown, "other merges keep it unknown")
  }

  // MARK: (2) node list
  func testNodeListFreeKeylessFourProviders() {
    XCTAssertEqual(ChainRPC.nodes.map { $0.host! }, ["base-rpc.publicnode.com", "base.drpc.org", "base-public.nodies.app", "base-mainnet.public.blastapi.io"])
    XCTAssertEqual(VaultCheck.publicRPC.host, "base-rpc.publicnode.com")
    for n in ChainRPC.nodes { XCTAssertEqual(n.scheme, "https"); XCTAssertNil(n.query, "no keys in the URL") }
  }

  // MARK: (3) safety cap: one-node find + second-node block check + two-node isValid
  func testIsValidCallIsTheEventData() {
    XCTAssertEqual(SafetyCaps.selIsValid, "7fae20b5")
    XCTAssertEqual(SafetyCaps.isValidCall(approved), "0x7fae20b5" + approved.dropFirst(2))
  }
  func testFoundAndConfirmedShowsTheCap() async {
    let lock = NSLock(); var callsByNode: [String: Int] = [:]   // t1285: nodes are asked in parallel
    ChainRPC.transport = { u, m, p in
      if m == "eth_blockNumber" { return self.head(56_750_000) }
      if m == "eth_call" { lock.lock(); callsByNode[u.host!, default: 0] += 1; lock.unlock(); return self.one }
      throw URLError(.badServerResponse) }
    var finderCalls = 0, checkCalls = 0
    ChainRPC.anyTransport = { u, m, p in
      guard m == "eth_getLogs" else { throw URLError(.badServerResponse) }
      if u == ChainRPC.nodes[0] { finderCalls += 1; return self.logsFor(p, at: 56_707_597, self.permLog) }
      let f = p[0] as! [String: Any]; XCTAssertEqual(f["fromBlock"] as? String, f["toBlock"] as? String, "second node checks ONE block")
      checkCalls += 1; return self.logsFor(p, at: 56_707_597, self.permLog) }
    let r = await SafetyCaps.read(account: A)
    XCTAssertEqual(r.caps, .ready(single: 1_000_000_000, daily: 10_000_000_000, term: 100_000_000_000))
    XCTAssertEqual(finderCalls, 1); XCTAssertEqual(checkCalls, 1)
    XCTAssertGreaterThanOrEqual(callsByNode.count, 2, "isValid agreed by two different nodes (asked in parallel)")
    XCTAssertEqual(SafetyCaps.memo(A)?.blockConfirmed, true)
    // next read: no new log scan for old blocks and no second block check; isValid is asked again
    let r2 = await SafetyCaps.read(account: A)
    XCTAssertEqual(r2.caps, r.caps); XCTAssertEqual(checkCalls, 1)
  }
  func testNotValidAnyMoreIsUnset() async {
    ChainRPC.transport = { _, m, _ in if m == "eth_blockNumber" { return self.head(56_750_000) }; if m == "eth_call" { return self.zero }; throw URLError(.badServerResponse) }
    ChainRPC.anyTransport = { _, _, p in self.logsFor(p, at: 56_707_597, self.permLog) }
    let r = await SafetyCaps.read(account: A)
    XCTAssertEqual(r.caps, .unset)
  }
  func testIsValidDisagreeIsUnreadable() async {
    ChainRPC.transport = { u, m, _ in
      if m == "eth_blockNumber" { return self.head(56_750_000) }
      if m == "eth_call" { if u == ChainRPC.nodes[0] { return self.one }; if u == ChainRPC.nodes[1] { return self.zero }; throw URLError(.timedOut) }
      throw URLError(.badServerResponse) }
    ChainRPC.anyTransport = { _, _, p in self.logsFor(p, at: 56_707_597, self.permLog) }
    let r = await SafetyCaps.read(account: A)
    XCTAssertEqual(r.caps, .unreadable)
  }
  func testSecondNodeDifferentLogIsRejected() async {
    ChainRPC.transport = { _, m, _ in if m == "eth_blockNumber" { return self.head(56_750_000) }; if m == "eth_call" { return self.one }; throw URLError(.badServerResponse) }
    var other = permLog; other["logIndex"] = "0x55"
    ChainRPC.anyTransport = { u, _, p in self.logsFor(p, at: 56_707_597, u == ChainRPC.nodes[0] ? self.permLog : other) }
    let r = await SafetyCaps.read(account: A)
    XCTAssertEqual(r.caps, .unreadable); XCTAssertNil(SafetyCaps.memo(A))
  }
  func testNoSecondNodeAnswerIsUnreadable() async {
    ChainRPC.transport = { _, m, _ in if m == "eth_blockNumber" { return self.head(56_750_000) }; if m == "eth_call" { return self.one }; throw URLError(.badServerResponse) }
    ChainRPC.anyTransport = { u, _, p in if u == ChainRPC.nodes[0] { return self.logsFor(p, at: 56_707_597, self.permLog) }; throw URLError(.timedOut) }
    let r = await SafetyCaps.read(account: A)
    XCTAssertEqual(r.caps, .unreadable)
    XCTAssertNotNil(SafetyCaps.memo(A), "found event kept (unconfirmed) and confirmed next time")
    XCTAssertNotEqual(SafetyCaps.memo(A)?.blockConfirmed, true)
  }
  func testNeverSetScansToFloorOnceThenUnset() async {
    ChainRPC.transport = { _, m, _ in if m == "eth_blockNumber" { return self.head(62_372_567) }; throw URLError(.badServerResponse) }
    var calls = 0
    ChainRPC.anyTransport = { u, _, _ in calls += 1; return [] as [Any] }
    let r = await SafetyCaps.read(account: A)
    XCTAssertEqual(r.caps, .unset)
    XCTAssertLessThanOrEqual(calls, SafetyCaps.maxCalls)
    let again = calls
    let r2 = await SafetyCaps.read(account: A)
    XCTAssertEqual(r2.caps, .unset); XCTAssertLessThanOrEqual(calls - again, 1, "memo: later reads only scan new blocks")
  }
  func testRealDepthFoundWithinOneRead() async {
    // the owner's permission was 1,416,156 blocks below the head: must be found in ONE read (budget 240 × 50,000)
    ChainRPC.transport = { _, m, _ in if m == "eth_blockNumber" { return self.head(62_372_567) }; if m == "eth_call" { return self.one }; throw URLError(.badServerResponse) }
    var log = permLog; log["blockNumber"] = "0x" + String(60_956_411, radix: 16)
    ChainRPC.anyTransport = { _, _, p in self.logsFor(p, at: 60_956_411, log) }
    let r = await SafetyCaps.read(account: A)
    XCTAssertEqual(r.caps, .ready(single: 1_000_000_000, daily: 10_000_000_000, term: 100_000_000_000))
  }

  // MARK: (4) failed read → "[zh]", never "[zh]" forever
  func testFailedReadShowsUnreadableNotLoading() {
    Loc.override = "zh"
    let shell = WalletState.shell(wallet: W, owner: O)
    XCTAssertEqual(WalletLimitsLine.state(shell), .loading, "before the first read")
    let failed = CapsSource.merged(shell, chain: SafetyCaps.Read(caps: .unreadable))
    XCTAssertEqual(WalletLimitsLine.state(failed), .unreadable)
    XCTAssertEqual(WalletLimitsLine.text(WalletLimitsLine.state(failed)), "暂时读不到，请稍后再试")
    let ready = CapsSource.merged(shell, chain: SafetyCaps.Read(caps: .ready(single: 1, daily: 2, term: 3)))
    XCTAssertEqual(WalletLimitsLine.state(CapsSource.merged(ready, chain: SafetyCaps.Read(caps: .unreadable))), WalletLimitsLine.state(ready), "a good value is kept")
    let fixed = CapsSource.merged(failed, chain: SafetyCaps.Read(caps: .ready(single: 1, daily: 2, term: 3)))
    XCTAssertEqual(WalletLimitsLine.state(fixed), .ready(single: 1, daily: 2, term: 3, end: nil), "a later good read replaces it")
  }

  // MARK: (5) records: time-based look-back, bounded rounds to the floor, cursor forgotten on sign-out
  func testLookbackIsSizedInTime() {
    XCTAssertEqual(ChainLedger.blocksPerDay, 432_000)
    XCTAssertGreaterThanOrEqual(ChainLedger.lookbackBlocks, 3 * 432_000)
    // rounds × calls per round cover head → floor of today's chain with 50,000-block chunks (2 topic calls per chunk)
    let chunks = (62_372_567 - ChainLedger.floorBlock) / 50_000 + 1
    XCTAssertGreaterThanOrEqual(Int64(ChainLedger.maxRounds * ChainLedger.maxLogCalls), 2 * chunks + 2 * 30)
  }
  func transferLog(_ block: Int64, _ li: Int64, from: String, to: String, _ amount: Int64) -> [String: Any] {
    func pad(_ a: String) -> String { "0x" + String(repeating: "0", count: 24) + a.dropFirst(2) }
    return ["topics": [ChainLedger.transferTopic, pad(from), pad(to)], "data": "0x" + String(repeating: "0", count: 64 - String(amount, radix: 16).count) + String(amount, radix: 16),
            "blockNumber": "0x" + String(block, radix: 16), "logIndex": "0x" + String(li, radix: 16), "transactionHash": "0x" + String(block, radix: 16) + String(li), "blockTimestamp": "0x6900"]
  }
  func installHistory(head h: Int64) -> [[String: Any]] {
    let logs = [transferLog(60_956_411, 1, from: O, to: W, 8_071_551), transferLog(60_956_411, 2, from: W, to: F, 150_000), transferLog(61_006_087, 1, from: W, to: F, 200_200)]
    ChainRPC.transport = { _, m, _ in if m == "eth_blockNumber" { return self.head(h) }; throw URLError(.badServerResponse) }
    ChainRPC.anyTransport = { _, m, p in
      guard m == "eth_getLogs" else { throw URLError(.badServerResponse) }
      let f = p[0] as! [String: Any]; let t = f["topics"] as! [Any]
      let from = ChainLedger.hexInt(f["fromBlock"])!, to = ChainLedger.hexInt(f["toBlock"])!
      guard to - from < 50_000 else { throw URLError(.badServerResponse) }
      return logs.filter { l in
        let b = ChainLedger.hexInt(l["blockNumber"])!; let tp = l["topics"] as! [String]
        let fromOK = (t[1] as? String).map { $0 == tp[1] } ?? true, toOK = (t[2] as? String).map { $0 == tp[2] } ?? true
        return (from...to).contains(b) && fromOK && toOK } as [Any] }
    return logs
  }
  func testRoundsReachTheFloorAndFindAllThree() async {
    _ = installHistory(head: 62_372_567)
    var rows: [JSONValue] = []
    var rounds = 0
    for _ in 0..<ChainLedger.maxRounds {
      rounds += 1
      guard let r = await ChainLedger.update(wallet: W, owner: O, existing: rows, endingBalance: 7_721_351) else { XCTFail("read failed"); break }
      rows = r
      if ChainLedger.complete(wallet: W) { break }
    }
    XCTAssertTrue(ChainLedger.complete(wallet: W), "reached the floor in \(rounds) rounds")
    XCTAssertLessThanOrEqual(ChainLedger.cursor(W)!.oldest, ChainLedger.floorBlock)
    XCTAssertEqual(rows.count, 3, "all 3 movements: +8.071551, -0.15, -0.2002")
    let deltas = Set(rows.compactMap { $0["delta"]?.atomic })
    XCTAssertEqual(deltas, [8_071_551, -150_000, -200_200], "the exact three movements")
    XCTAssertEqual(deltas.reduce(0, +), 7_721_351, "they add up to the balance")
  }
  func testUnanswerableOldRangeKeepsNewerProgress() async {
    _ = installHistory(head: 62_372_567)
    let inner = ChainRPC.anyTransport
    ChainRPC.anyTransport = { u, m, p in
      let f = p[0] as! [String: Any]
      if ChainLedger.hexInt(f["fromBlock"])! < 53_735_270 { throw URLError(.timedOut) }   // like the real free node on old history
      return try await inner(u, m, p) }
    var rows0: [JSONValue] = []
    for _ in 0..<ChainLedger.maxRounds { rows0 = await ChainLedger.update(wallet: W, owner: O, existing: rows0, endingBalance: 7_721_351) ?? rows0 }
    XCTAssertEqual(rows0.count, 3)
    ChainLedger.forgetAll()
    // a 50,000-block range on old history times out but 10,000 works: the walk continues with the smaller chunk
    ChainRPC.anyTransport = { u, m, p in
      let f = p[0] as! [String: Any]
      if ChainLedger.hexInt(f["fromBlock"])! < 55_000_000, ChainLedger.hexInt(f["toBlock"])! - ChainLedger.hexInt(f["fromBlock"])! >= 10_000 { throw URLError(.timedOut) }
      return try await inner(u, m, p) }
    var rows: [JSONValue] = []
    for _ in 0..<ChainLedger.maxRounds { rows = await ChainLedger.update(wallet: W, owner: O, existing: rows, endingBalance: 7_721_351) ?? rows }
    XCTAssertEqual(rows.count, 3, "every movement newer than the unanswerable range is shown")
    XCTAssertLessThan(ChainLedger.cursor(W)!.oldest, 55_000_000, "kept walking past the slow region with 10,000-block chunks")
  }
  func testSignOutForgetsCursorSoOldMovementsComeBack() async {
    _ = installHistory(head: 62_372_567)
    var rows: [JSONValue] = []
    for _ in 0..<ChainLedger.maxRounds { rows = await ChainLedger.update(wallet: W, owner: O, existing: rows, endingBalance: 7_721_351) ?? rows; if ChainLedger.complete(wallet: W) { break } }
    XCTAssertFalse(rows.isEmpty)
    // the bug: shown rows wiped on sign-out, cursor kept -> the next scan only reads new blocks and finds nothing
    let kept = await ChainLedger.update(wallet: W, owner: O, existing: [], endingBalance: 7_721_351) ?? []
    XCTAssertTrue(kept.isEmpty, "with the old cursor kept, nothing comes back (the owner's empty 记录)")
    ChainLedger.forgetAll(); SafetyCaps.forgetAll()
    XCTAssertNil(ChainLedger.cursor(W))
    var again: [JSONValue] = []
    for _ in 0..<ChainLedger.maxRounds { again = await ChainLedger.update(wallet: W, owner: O, existing: again, endingBalance: 7_721_351) ?? again; if ChainLedger.complete(wallet: W) { break } }
    XCTAssertEqual(again.count, rows.count, "after forgetting, every movement is found again")
  }
  func testForgetAllClearsOnlyScanState() {
    suite.set(Data("{}".utf8), forKey: "kp.chainledger.cursor.v2.0xabc"); suite.set(Data("{}".utf8), forKey: "kp.safetycaps.memo.v3.0xabc")
    suite.set(Data("{}".utf8), forKey: "kp.safetycaps.memo.v2.0xabc"); suite.set("keep", forKey: "kp.other")
    ChainLedger.forgetAll(); SafetyCaps.forgetAll()
    XCTAssertNil(suite.object(forKey: "kp.chainledger.cursor.v2.0xabc")); XCTAssertNil(suite.object(forKey: "kp.safetycaps.memo.v3.0xabc"))
    XCTAssertNil(suite.object(forKey: "kp.safetycaps.memo.v2.0xabc")); XCTAssertEqual(suite.string(forKey: "kp.other"), "keep")
  }

  // MARK: app wiring (source guards: SwiftPM does not build the app target)
  func root(_ f: String) throws -> String { try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(f), encoding: .utf8) }
  func testAppWiring() throws {
    let am = try root("App/Sources/AppModel.swift"), card = try root("App/Sources/LifeTab.swift"), simple = try root("App/Sources/SimpleMode.swift")
    XCTAssertTrue(am.contains("ChainLedger.forgetAll(); SafetyCaps.forgetAll()"), "sign-out / move reset forgets the scan state")
    XCTAssertTrue(am.contains("for round in 0..<ChainLedger.maxRounds") && am.contains("ChainLedger.cursor(w)?.oldest == before?.oldest"), "records scanned in bounded rounds, stopping when a node limit stops progress")
    XCTAssertTrue(am.contains("next = next.withBalance(v); state = next"), "balance shown before the records / limits reads")
    XCTAssertTrue(card.contains("m.balanceRevealed && !s.balanceKnown") && card.contains("\"balance.loading\""), "加载中 instead of 0")
    XCTAssertTrue(simple.contains("s.balanceKnown ? AnswerRules.format(s.balance) : T(\"加载中\""))
  }
}

// t1285 (decision 156): primary CDP + parallel backups; per-wallet last balance.
final class T1285PrimaryRaceTests: XCTestCase {
  var saved: (@Sendable (URL, String, [Any]) async throws -> String)!
  override func setUp() { saved = ChainRPC.transport }
  override func tearDown() { ChainRPC.transport = saved }
  let w = "0x4494ced7f076c523b3da8e013e6706ac4d9d3ae6"
  func bal(_ v: Int) -> String { "0x" + String(repeating: "0", count: 64 - String(v, radix: 16).count) + String(v, radix: 16) }

  func testRaceFirstValidWinsDespiteSlowAndBrokenNodes() async {
    let n = ChainRPC.publicNodes
    ChainRPC.transport = { u, _, _ in
      if u == n[0] { try await Task.sleep(nanoseconds: 3_000_000_000); return "0x" + String(repeating: "0", count: 64) }
      if u == n[1] { throw URLError(.badServerResponse) }   // rate-limited
      if u == n[2] { return "0x" }                           // empty / malformed: not valid
      try await Task.sleep(nanoseconds: 50_000_000); return self.bal(7721351) }
    let t0 = Date(); let v = await VaultCheck.usdcBalanceFast(w)
    XCTAssertEqual(v, 7721351); XCTAssertLessThan(Date().timeIntervalSince(t0), 1.0, "a slow node never holds the balance up")
  }
  func testRaceAllFailIsNil() async {
    ChainRPC.transport = { _, _, _ in throw URLError(.timedOut) }
    let v = await VaultCheck.usdcBalanceFast(w); XCTAssertNil(v)
  }
  func testAgreedFastNeedsTwoSame() async {
    let n = ChainRPC.publicNodes
    ChainRPC.transport = { u, _, _ in u == n[0] ? "0xaa" : (u == n[1] ? "0xbb" : (u == n[2] ? "0xbb" : "0xcc")) }
    let r = await ChainRPC.agreedFast("eth_call", []); XCTAssertEqual(r, "0xbb")
    ChainRPC.transport = { u, _, _ in if u == n[0] { return "0xaa" }; if u == n[1] { return "0xbb" }; throw URLError(.timedOut) }
    let r2 = await ChainRPC.agreedFast("eth_call", []); XCTAssertNil(r2, "two different answers never agree")
  }
  func testAgreedFastDoesNotWaitForDeadNode() async {
    let n = ChainRPC.publicNodes
    ChainRPC.transport = { u, _, _ in if u == n[0] { try await Task.sleep(nanoseconds: 4_000_000_000) }; return "0x01" }
    let t0 = Date(); let r = await ChainRPC.agreedFast("eth_call", [])
    XCTAssertEqual(r, "0x01"); XCTAssertLessThan(Date().timeIntervalSince(t0), 1.0)
  }
  func testPrimaryComesFirstWhenSupplied() {
    // no key in the repo: without KIPURSE_CHAIN_RPC the list is the free backups only
    XCTAssertEqual(ChainRPC.nodes.first, ChainRPC.primary ?? ChainRPC.publicNodes[0])
    XCTAssertFalse(ChainRPC.publicNodes.contains { $0.absoluteString.contains("developer.coinbase.com") }, "never a key in source")
  }
  func testLastBalancePerWallet() {
    let d = UserDefaults(suiteName: "t1285.lastbal")!; d.removePersistentDomain(forName: "t1285.lastbal"); LastBalance.store = d
    defer { LastBalance.store = .standard }
    LastBalance.save(w, 7721351)
    XCTAssertEqual(LastBalance.load(w.uppercased().replacingOccurrences(of: "0X", with: "0x")), 7721351)
    XCTAssertNil(LastBalance.load("0x" + String(repeating: "1", count: 40)), "never another wallet's number")
    let sh = WalletState.shell(wallet: w, owner: nil).withCachedBalance(7721351)
    XCTAssertTrue(sh.balanceKnown); XCTAssertTrue(sh.balanceRefreshing); XCTAssertEqual(sh.balance, 7721351)
    let fresh = sh.withBalance(7721351); XCTAssertFalse(fresh.balanceRefreshing)
  }
  func testAppWiringCache() throws {
    let src = try String(contentsOfFile: #filePath.replacingOccurrences(of: "Tests/KipurseCoreTests/T1282ReloginTests.swift", with: "App/Sources/AppModel.swift"))
    XCTAssertTrue(src.contains("if let v = LastBalance.load(w) { sh = sh.withCachedBalance(v) }"))
    XCTAssertTrue(src.contains("VaultCheck.usdcBalanceFast(w)"))
    XCTAssertTrue(src.contains("!s.balanceRefreshing, let w = s.wallet"), "a cached number is never re-saved as fresh")
  }
}
