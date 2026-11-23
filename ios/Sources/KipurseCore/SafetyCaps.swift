import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// t1094: read the wallet safety limit the same way the server does — the spend permission's
/// Policy extraData (single, daily, term). Read-only. A failed call is unreadable; an empty
/// answer is "never set".
/// t1129u: the old read asked one public node for every approval since block 0 (always refused, so the wallet page could
/// never show the limit) and decoded the event without its leading ABI offset word (real logs never matched). Now:
/// newest-first chunked scan of SpendPermissionApproved/Revoked with a saved cursor + last found approval, real ABI layout,
/// and the permission window (start/end) for the 钱包安全上限 row.
public enum SafetyCaps {
  /// Tests replace this. Production scans public Base nodes. Nil result means the read failed.
  public static var query: ((String) async -> Any?)?
  /// Optional operator RPC. Nil uses the public Base nodes.
  public static var rpc: URL?
  /// Coinbase SpendPermissionManager on Base. Same address RequestVerify uses.
  public static let manager = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad"
  static let tupleSig = "(address,address,address,uint160,uint48,uint48,uint48,uint256,bytes)"
  /// SpendPermissionApproved(bytes32,(address,address,address,uint160,uint48,uint48,uint48,uint256,bytes))
  public static let eventTopic: String = "0x" + Hex.encode(Keccak.hash("SpendPermissionApproved(bytes32," + tupleSig + ")")).replacingOccurrences(of: "0x", with: "")
  public static let revokedTopic: String = "0x" + Hex.encode(Keccak.hash("SpendPermissionRevoked(bytes32," + tupleSig + ")")).replacingOccurrences(of: "0x", with: "")

  public struct Read: Equatable {
    public let caps: AILimitGate.Caps, start: Int64?, end: Int64?
    public init(caps: AILimitGate.Caps, start: Int64? = nil, end: Int64? = nil) { self.caps = caps; self.start = start; self.end = end }
  }

  public static func latest(account: String) async -> AILimitGate.Caps { await read(account: account).caps }

  public static func read(account: String) async -> Read {
    let want = account.lowercased()
    if let query {
      guard let raw = await query(want) as? [String] else { return Read(caps: .unreadable) }
      return pick(raw, account: want)
    }
    return await scan(account: want)
  }

  /// Pure: the last decodable approval for this account wins.
  static func pick(_ raw: [String], account want: String) -> Read {
    var saw = false
    var found: Read?
    for data in raw {
      guard let one = decode(data, account: want) else { continue }
      saw = true
      if case .unreadable = one { continue }
      let w = window(data, account: want)
      found = Read(caps: one, start: w?.start, end: w?.end)
    }
    if let found { return found }
    return Read(caps: saw ? .unreadable : .unset)
  }

  /// Word offset of the SpendPermission tuple inside the log data: real logs start with the ABI offset word (0x20);
  /// older test fixtures encode the tuple directly.
  static func base(_ b: [UInt8]) -> Int? {
    guard b.count >= 32 else { return nil }
    if let first = u64(b, 0), first == 32, b.count >= 32 * 10 { return 1 }
    return 0
  }

  /// One log's data. nil = not this account. unreadable = this account but the policy bytes are bad.
  public static func decode(_ data: String, account: String) -> AILimitGate.Caps? {
    guard let b = Hex.decode(data), let w0 = base(b), b.count >= 32 * (9 + w0) else { return nil }
    let ao = (w0 * 32)
    let who = "0x" + b[(ao + 12)..<(ao + 32)].map { String(format: "%02x", $0) }.joined()
    guard who == account.lowercased() else { return nil }
    guard let off = u64(b, UInt64(w0 + 8)), Int(off) % 32 == 0 else { return .unreadable }
    let start = ao + Int(off)
    guard start + 32 <= b.count, let n = u64(b, UInt64(start / 32)), n == 384, start + 32 + 384 <= b.count else { return .unreadable }
    let pol = Array(b[(start + 32)..<(start + 32 + 384)])
    guard let s = u64(pol, 2), let d = u64(pol, 3), let t = u64(pol, 4) else { return .unreadable }
    if s == 0 || d == 0 || t == 0 { return .unset }
    guard s <= UInt64(Int64.max), d <= UInt64(Int64.max), t <= UInt64(Int64.max) else { return .unreadable }
    return .ready(single: Int64(s), daily: Int64(d), term: Int64(t))
  }

  /// Permission start / end (unix seconds) of one log for this account.
  public static func window(_ data: String, account: String) -> (start: Int64, end: Int64)? {
    guard let b = Hex.decode(data), let w0 = base(b), b.count >= 32 * (9 + w0) else { return nil }
    let ao = w0 * 32
    let who = "0x" + b[(ao + 12)..<(ao + 32)].map { String(format: "%02x", $0) }.joined()
    guard who == account.lowercased(), let s = u64(b, UInt64(w0 + 5)), let e = u64(b, UInt64(w0 + 6)), s > 0, e > s,
          s <= UInt64(Int64.max), e <= UInt64(Int64.max) else { return nil }
    return (Int64(s), Int64(e))
  }

  private static func u64(_ b: [UInt8], _ word: UInt64) -> UInt64? {
    let o = Int(word) * 32
    guard o >= 0, o + 32 <= b.count else { return nil }
    if b[o..<(o + 24)].contains(where: { $0 != 0 }) { return nil }
    var v: UInt64 = 0
    for i in 0..<8 { v = (v << 8) | UInt64(b[o + 24 + i]) }
    return v
  }

  // MARK: chain scan (read-only)

  /// Saved per account: blocks already scanned (newest / oldest) and the newest permission event seen for it.
  public struct Memo: Codable, Equatable {
    public var newest: Int64, oldest: Int64
    public var data: String?, revoked: Bool, block: Int64, li: Int64
  }
  public static var store: UserDefaults = .standard
  static func key(_ a: String) -> String { "kp.safetycaps.memo.v1." + a.lowercased() }
  public static func memo(_ a: String) -> Memo? { store.data(forKey: key(a)).flatMap { try? JSONDecoder().decode(Memo.self, from: $0) } }
  static func save(_ m: Memo, _ a: String) { if let d = try? JSONEncoder().encode(m) { store.set(d, forKey: key(a)) } }
  public static let maxCalls = 30

  static var nodes: [URL] {
    var out: [URL] = []
    for n in [rpc].compactMap({ $0 }) + ChainRPC.nodes where !out.contains(n) { out.append(n) }
    return out
  }

  /// Newest permission event for `account` in [from, to] (nil = read failed, .none = no event for this account).
  static func events(_ account: String, from: Int64, to: Int64) async -> (ok: Bool, best: (data: String, revoked: Bool, block: Int64, li: Int64)?) {
    let params: [Any] = [["address": manager, "fromBlock": "0x" + String(from, radix: 16), "toBlock": "0x" + String(to, radix: 16),
                          "topics": [[eventTopic, revokedTopic]]]]
    guard let raw = try? await ChainRPC.callAny("eth_getLogs", params, nodes: nodes) else { return (false, nil) }
    let arr = (raw as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
    var best: (data: String, revoked: Bool, block: Int64, li: Int64)?
    for l in arr {
      guard let d = l["data"] as? String, let t0 = (l["topics"] as? [String])?.first?.lowercased(),
            let b = Hex.decode(d), let w0 = base(b), b.count >= 32 * (w0 + 1) else { continue }
      let ao = w0 * 32
      let who = "0x" + b[(ao + 12)..<(ao + 32)].map { String(format: "%02x", $0) }.joined()
      guard who == account else { continue }
      let bn = ChainLedger.hexInt(l["blockNumber"]) ?? 0, li = ChainLedger.hexInt(l["logIndex"]) ?? 0
      if let cur = best, (cur.block, cur.li) >= (bn, li) { continue }
      best = (d, t0 == revokedTopic.lowercased(), bn, li)
    }
    return (true, best)
  }

  static func scan(account: String) async -> Read {
    guard FeatureSwitch.chainRead.on else { return Read(caps: .unreadable) }
    guard let latestHex = try? await ChainRPC.call("eth_blockNumber", [], nodes: nodes),
          let latest = Int64(String(latestHex.dropFirst(2)), radix: 16) else { return fromMemo(memo(account), account) ?? Read(caps: .unreadable) }
    var m = memo(account) ?? Memo(newest: latest, oldest: latest + 1, data: nil, revoked: false, block: 0, li: 0)
    var calls = 0
    let chunk: Int64 = 50_000
    func take(_ e: (data: String, revoked: Bool, block: Int64, li: Int64)) {
      guard (e.block, e.li) > (m.block, m.li) || (m.data == nil && !m.revoked) else { return }
      if e.revoked {
        // Only a revoke of the permission we show (or with nothing shown yet) clears it; revoking an older one changes nothing.
        guard m.data == nil || m.data?.lowercased() == e.data.lowercased() else { return }
        m.data = nil; m.revoked = true
      } else { m.data = e.data; m.revoked = false }
      m.block = e.block; m.li = e.li
    }
    // 1) new blocks since the last read (oldest first so the cursor never skips a gap).
    while m.newest < latest && calls < maxCalls {
      let from = m.newest + 1, to = min(latest, from + chunk - 1); calls += 1
      let r = await events(account, from: from, to: to)
      guard r.ok else { break }
      if let e = r.best { take(e) }
      m.newest = to
    }
    // 2) nothing found yet: walk back (newest first) until an event or the floor.
    if m.data == nil && !m.revoked {
      while m.oldest > ChainLedger.floorBlock && calls < maxCalls {
        let to = m.oldest - 1, from = max(ChainLedger.floorBlock, to - chunk + 1); calls += 1
        let r = await events(account, from: from, to: to)
        guard r.ok else { break }
        m.oldest = from
        if let e = r.best { take(e); break }
      }
    }
    save(m, account)
    if let r = fromMemo(m, account) { return r }
    // Scanned all the way to the floor and never saw a permission for this wallet: really never set.
    return Read(caps: m.oldest <= ChainLedger.floorBlock ? .unset : .unreadable)
  }

  static func fromMemo(_ m: Memo?, _ account: String) -> Read? {
    guard let m else { return nil }
    if m.revoked { return Read(caps: .unset) }
    guard let d = m.data else { return nil }
    return pick([d], account: account)
  }
}
