import Foundation

/// t1037: when there is no server session yet, the wallet "[zh]" list is empty even though USDC already arrived.
/// Read USDC Transfer logs for this wallet straight from Base (same public nodes as ChainRPC) and shape them like the
/// server ledger rows the UI already shows.
/// t1129: [zh] must show EVERY real wallet movement. One row per transaction (never two rows with the same id):
///   deposit / withdraw (amount to the owner + the wallet-paid network fee, detail.fee) / walletfee (a wallet action whose only
///   USDC out is the network fee to Kipurse's fixed fee address: safety-limit change, Face ID enable…) / payment.
/// Scans incrementally with a saved block cursor (Base now makes ~5 blocks/s, so a fixed small look-back missed yesterday's
/// withdraw), merges with rows already shown (no double counting by tx) and recomputes every row's balance from the live balance.
public enum ChainLedger {
  public static let transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
  /// First scan without a cursor: ~2–5 days on Base. Older history comes from the backward cursor / server ledger.
  public static let lookbackBlocks: Int64 = 1_000_000
  /// Hard cap per refresh so a strict public RPC can't burn the phone for minutes; the cursor continues next refresh.
  public static let maxLogCalls = 40
  /// Kipurse wallets did not exist before this block (2026-10, before the first safety-limit permission). Backward scans stop here.
  public static let floorBlock: Int64 = 52_500_000
  /// Kipurse's fixed fee address (same as RequestVerify.duesTo; never changes in the app).
  public static var feeTo: String { RequestVerify.duesTo }

  public static func topicAddress(_ a: String) -> String? {
    let h = a.lowercased().replacingOccurrences(of: "0x", with: "")
    guard h.count == 40, h.allSatisfy(\.isHexDigit) else { return nil }
    return "0x" + String(repeating: "0", count: 24) + h
  }

  public struct Transfer: Equatable, Codable {
    public let tx: String, t: Int64, from: String, to: String, amount: Int64
    public var block: Int64 = 0, li: Int64 = 0
    public init(tx: String, t: Int64, from: String, to: String, amount: Int64, block: Int64 = 0, li: Int64 = 0) {
      self.tx = tx; self.t = t; self.from = from; self.to = to; self.amount = amount; self.block = block; self.li = li
    }
  }

  static func hexInt(_ v: Any?) -> Int64? {
    guard let s = v as? String, s.hasPrefix("0x") else { return nil }
    return Int64(String(s.dropFirst(2)), radix: 16)
  }

  /// Pure: one eth_getLogs entry → Transfer (nil when malformed / not a Transfer).
  public static func parseLog(_ log: [String: Any]) -> Transfer? {
    guard let topics = log["topics"] as? [String], topics.count >= 3,
          topics[0].lowercased() == transferTopic,
          let tx = log["transactionHash"] as? String, tx.hasPrefix("0x"),
          let data = log["data"] as? String else { return nil }
    let from = "0x" + topics[1].lowercased().suffix(40)
    let to = "0x" + topics[2].lowercased().suffix(40)
    let hex = data.lowercased().replacingOccurrences(of: "0x", with: "")
    guard hex.count == 64, hex.allSatisfy(\.isHexDigit),
          let amount = Int64(hex, radix: 16), amount >= 0 else { return nil }
    let t = hexInt(log["blockTimestamp"]) ?? 0
    return Transfer(tx: tx.lowercased(), t: t, from: from, to: to, amount: amount,
                    block: hexInt(log["blockNumber"]) ?? 0, li: hexInt(log["logIndex"]) ?? 0)
  }

  /// Pure: transfers → ledger JSON newest first (one row per tx), with running balances ending at `endingBalance`.
  public static func rows(transfers: [Transfer], wallet: String, owner: String?, endingBalance: Int64, feeTo: String? = ChainLedger.feeTo) -> [JSONValue] {
    rebalance(classify(transfers: transfers, wallet: wallet, owner: owner, feeTo: feeTo), endingBalance: endingBalance)
  }

  /// Pure: one row per transaction, oldest first, without balances.
  public static func classify(transfers: [Transfer], wallet: String, owner: String?, feeTo: String? = ChainLedger.feeTo) -> [JSONValue] {
    let w = wallet.lowercased(), o = owner?.lowercased(), fee = feeTo?.lowercased()
    var order: [String] = []; var by: [String: [Transfer]] = [:]
    let sorted = transfers.sorted { ($0.block, $0.li, $0.t, $0.tx) < ($1.block, $1.li, $1.t, $1.tx) }
    for tr in sorted where (tr.to == w || tr.from == w) && tr.amount > 0 {
      if by[tr.tx] == nil { order.append(tr.tx) }; by[tr.tx, default: []].append(tr)
    }
    let now = Int64(Date().timeIntervalSince1970)
    var out: [JSONValue] = []
    for tx in order {
      let xs = by[tx] ?? []
      let inSum = xs.filter { $0.to == w }.reduce(Int64(0)) { $0 + $1.amount }
      let outs = xs.filter { $0.from == w && $0.to != w }
      let outSum = outs.reduce(Int64(0)) { $0 + $1.amount }
      let delta = inSum - outSum
      guard delta != 0 else { continue }
      let feePaid = fee.map { f in outs.filter { $0.to == f }.reduce(Int64(0)) { $0 + $1.amount } } ?? 0
      let main = outs.filter { fee == nil || $0.to != fee }
      let sent = main.reduce(Int64(0)) { $0 + $1.amount }
      var kind: String, zh: String
      var detail: [String: JSONValue] = [:]
      if delta > 0 { kind = "deposit"; zh = "充值" }
      else if sent == 0 && feePaid > 0 { kind = "walletfee"; zh = "网络费（钱包操作）"; detail["fee"] = .string(String(feePaid)) }
      else if let o, !main.isEmpty, main.allSatisfy({ $0.to == o }) {
        kind = "withdraw"; zh = "提现"
        if feePaid > 0 { detail["fee"] = .string(String(feePaid)); detail["sent"] = .string(String(sent)) }
      } else {
        kind = "payment"; zh = "支出"
        if feePaid > 0 { detail["fee"] = .string(String(feePaid)) }
      }
      let t0 = xs.first?.t ?? 0
      var row: [String: JSONValue] = [
        "tx": .string(tx), "t": .string(String(t0 > 1_000_000_000 ? t0 : now)), "account": .string("wallet"),
        "kind": .string(kind), "delta": .string(String(delta)), "zh": .string(zh), "src": .string("chain"),
      ]
      if let b = xs.first?.block, b > 0 { row["block"] = .string(String(b)) }
      if !detail.isEmpty { row["detail"] = .object(detail) }
      out.append(.object(row))
    }
    return out
  }

  /// Pure: rows (any order) → newest first, every wallet row's balance recomputed backwards from the live balance.
  /// Owner-account rows (paid from the owner's own Coinbase wallet) keep their balance as is and do not change the wallet balance.
  public static func rebalance(_ rows: [JSONValue], endingBalance: Int64) -> [JSONValue] {
    func key(_ r: JSONValue) -> (Int64, Int64) { (r["t"]?.atomic ?? 0, r["block"]?.atomic ?? 0) }
    let newestFirst = rows.enumerated().sorted { a, b in
      let ka = key(a.element), kb = key(b.element)
      return ka != kb ? ka > kb : a.offset > b.offset
    }.map(\.element)
    var bal = endingBalance
    var out: [JSONValue] = []
    for r in newestFirst {
      guard case .object(var o) = r else { continue }
      let acct = o["account"]?.string ?? "wallet"
      if acct == "wallet" {
        o["balance"] = .string(String(bal))
        bal -= r["delta"]?.atomic ?? 0
      }
      out.append(.object(o))
    }
    return out
  }

  /// Pure merge: rows already shown (server ledger or cache) + fresh chain rows. A tx already present for the wallet account
  /// is never added twice; a chain-made row is replaced by a fresher chain row for the same tx (older builds split fee rows).
  public static func merge(existing: [JSONValue], chain: [JSONValue], endingBalance: Int64) -> [JSONValue] {
    func id(_ r: JSONValue) -> String { (r["tx"]?.string?.lowercased() ?? "") + "|" + (r["account"]?.string ?? "wallet") }
    let fresh = Set(chain.map(id))
    var seen = Set<String>(); var kept: [JSONValue] = []
    for r in existing {
      let k = id(r)
      let fromChain = r["src"]?.string == "chain" || ["充值", "提现", "支出"].contains(r["zh"]?.string ?? "")
      if fresh.contains(k) && fromChain { continue }          // replaced by the fresh chain row
      if seen.insert(k).inserted { kept.append(r) }            // drop duplicate ids from older builds
    }
    for r in chain where !seen.contains(id(r)) { seen.insert(id(r)); kept.append(r) }
    return rebalance(kept, endingBalance: endingBalance)
  }

  static func logs(usdc: String, fromBlock: Int64, toBlock: Int64, topics: [Any], nodes: [URL]) async -> [[String: Any]]? {
    let params: [Any] = [["address": usdc,
                          "fromBlock": "0x" + String(fromBlock, radix: 16),
                          "toBlock": "0x" + String(toBlock, radix: 16),
                          "topics": topics]]
    guard let raw = try? await ChainRPC.callAny("eth_getLogs", params, nodes: nodes) else { return nil }
    if let a = raw as? [[String: Any]] { return a }
    if let a = raw as? [Any] { return a.compactMap { $0 as? [String: Any] } }
    return nil
  }

  /// Scan [fromBlock, toBlock] oldest first. Returns transfers and the last block fully scanned (may stop early on the call budget).
  static func collect(wallet: String, pad: String, usdc: String, fromBlock: Int64, toBlock: Int64,
                      chunk: Int64, nodes: [URL], budget: inout Int) async -> (transfers: [Transfer], scannedTo: Int64)? {
    let topicSets: [[Any]] = [[transferTopic, NSNull(), pad], [transferTopic, pad, NSNull()]]
    var transfers: [Transfer] = []
    var seen = Set<String>()
    var begin = fromBlock
    var scannedTo = fromBlock - 1
    while begin <= toBlock {
      let end = min(toBlock, begin + chunk - 1)
      guard budget >= topicSets.count else { break }
      var got: [[String: Any]] = []
      for topics in topicSets {
        budget -= 1
        guard let batch = await logs(usdc: usdc, fromBlock: begin, toBlock: end, topics: topics, nodes: nodes) else {
          return scannedTo >= fromBlock ? (transfers, scannedTo) : nil // this chunk size rejected — caller shrinks
        }
        got += batch
      }
      for log in got {
        guard var tr = parseLog(log) else { continue }
        if tr.t == 0, let bn = log["blockNumber"] as? String,
           let block = try? await ChainRPC.callAny("eth_getBlockByNumber", [bn, false], nodes: nodes) as? [String: Any],
           let v = hexInt(block["timestamp"]) {
          tr = Transfer(tx: tr.tx, t: v, from: tr.from, to: tr.to, amount: tr.amount, block: tr.block, li: tr.li)
        }
        let key = tr.tx + ":" + String(tr.li) + ":" + String(tr.amount) + ":" + tr.from + ":" + tr.to
        if seen.insert(key).inserted { transfers.append(tr) }
      }
      scannedTo = end
      begin = end + 1
    }
    return (transfers, scannedTo)
  }

  /// Saved scan position per wallet (public chain positions only; no balances, no keys).
  public struct Cursor: Codable, Equatable {
    public var newest: Int64, oldest: Int64
    public init(newest: Int64, oldest: Int64) { self.newest = newest; self.oldest = oldest }
  }
  public static var store: UserDefaults = .standard
  static func cursorKey(_ w: String) -> String { "kp.chainledger.cursor.v2." + w.lowercased() }
  public static func cursor(_ w: String) -> Cursor? {
    guard let d = store.data(forKey: cursorKey(w)) else { return nil }
    return try? JSONDecoder().decode(Cursor.self, from: d)
  }
  public static func saveCursor(_ c: Cursor?, _ w: String) {
    if let c, let d = try? JSONEncoder().encode(c) { store.set(d, forKey: cursorKey(w)) } else { store.removeObject(forKey: cursorKey(w)) }
  }

  /// One incremental step: new blocks since the cursor first, then (budget left) older blocks back to `floorBlock`.
  /// Nil = couldn't read anything this time.
  public static func scanStep(wallet: String, usdc: String = VaultCheck.usdc, nodes: [URL] = ChainRPC.nodes) async -> [Transfer]? {
    guard FeatureSwitch.chainRead.on, let pad = topicAddress(wallet) else { return nil }
    guard let latestHex = try? await ChainRPC.call("eth_blockNumber", [], nodes: nodes),
          let latest = Int64(String(latestHex.dropFirst(2)), radix: 16) else { return nil }
    var cur = cursor(wallet) ?? Cursor(newest: max(floorBlock, latest - lookbackBlocks) - 1, oldest: max(floorBlock, latest - lookbackBlocks))
    var budget = maxLogCalls
    var all: [Transfer] = []
    var readSomething = false
    for chunk in [Int64(50_000), Int64(10_000), Int64(2_000), Int64(200)] {
      if cur.newest < latest {
        if let r = await collect(wallet: wallet, pad: pad, usdc: usdc, fromBlock: cur.newest + 1, toBlock: latest, chunk: chunk, nodes: nodes, budget: &budget) {
          all += r.transfers; cur.newest = max(cur.newest, r.scannedTo); readSomething = true
        } else { continue }
      }
      if cur.newest >= latest, cur.oldest > floorBlock, budget >= 2 {
        let from = max(floorBlock, cur.oldest - chunk * Int64(budget / 2))
        if let r = await collect(wallet: wallet, pad: pad, usdc: usdc, fromBlock: from, toBlock: cur.oldest - 1, chunk: chunk, nodes: nodes, budget: &budget) {
          all += r.transfers; if r.scannedTo >= cur.oldest - 1 { cur.oldest = from }; readSomething = true
        }
      }
      break
    }
    guard readSomething else { return nil }
    saveCursor(cur, wallet)
    return all
  }

  /// t1129: read new transfers and merge them into the rows already shown. Nil = nothing could be read (keep what is shown).
  public static func update(wallet: String, owner: String?, existing: [JSONValue], endingBalance: Int64,
                            usdc: String = VaultCheck.usdc, nodes: [URL] = ChainRPC.nodes) async -> [JSONValue]? {
    guard let tr = await scanStep(wallet: wallet, usdc: usdc, nodes: nodes) else { return nil }
    return merge(existing: existing, chain: classify(transfers: tr, wallet: wallet, owner: owner), endingBalance: endingBalance)
  }

  /// Fetch recent USDC transfers that touch `wallet` (in or out) without a cursor. Nil = couldn't read; [] = none in window.
  public static func recent(wallet: String, owner: String? = nil, endingBalance: Int64 = 0,
                            usdc: String = VaultCheck.usdc, nodes: [URL] = ChainRPC.nodes) async -> [JSONValue]? {
    guard FeatureSwitch.chainRead.on, let pad = topicAddress(wallet) else { return nil }
    guard let latestHex = try? await ChainRPC.call("eth_blockNumber", [], nodes: nodes),
          let latest = Int64(String(latestHex.dropFirst(2)), radix: 16) else { return nil }
    let fromBlock = max(Int64(0), latest - lookbackBlocks)
    for chunk in [Int64(50_000), Int64(10_000), Int64(2_000), Int64(200), Int64(50)] {
      var budget = maxLogCalls
      let maxSpan = chunk * Int64(maxLogCalls / 2)
      let start = max(fromBlock, latest - maxSpan + 1)
      if let r = await collect(wallet: wallet, pad: pad, usdc: usdc, fromBlock: start, toBlock: latest, chunk: chunk, nodes: nodes, budget: &budget) {
        return rows(transfers: r.transfers, wallet: wallet, owner: owner, endingBalance: endingBalance)
      }
    }
    return nil
  }
}
