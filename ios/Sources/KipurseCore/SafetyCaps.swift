import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// t1094: read the wallet safety limit the same way the server does — the spend permission's
/// Policy extraData (single, daily, term). Read-only. A failed call is unreadable; an empty
/// answer is "never set".
/// t1129: the old read asked one public node for every approval since block 0 (always refused, so the wallet page could
/// never show the limit) and decoded the event without its leading ABI offset word (real logs never matched). Now:
/// newest-first chunked scan of SpendPermissionApproved/Revoked with a saved cursor + last found approval, real ABI layout,
/// and the permission window (start/end) for the [zh] row.
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
  // t1282 (decision 156, owner card t1282s6035): FIND the newest permission event with ONE node (only one free public node can scan
  // large block ranges), then CONFIRM it: a second, different node must show that exact log in that one block, and two nodes
  // must agree on SpendPermissionManager.isValid(permission) right now. Replaces t1275 "every log scan needs two agreeing nodes"
  // (no two free nodes can scan Base's ranges any more: mainnet.base.org 429s every eth_getLogs, base.llamarpc.com is down).

  /// Saved per account: blocks already scanned (newest / oldest), the newest permission event seen, and whether a second node
  /// has confirmed that event's block (done once; isValid is re-checked on two nodes every read).
  public struct Memo: Codable, Equatable {
    public var newest: Int64, oldest: Int64
    public var data: String?, revoked: Bool, block: Int64, li: Int64
    public var blockConfirmed: Bool? = nil
  }
  public static var store: UserDefaults = .standard
  static func key(_ a: String) -> String { "kp.safetycaps.memo.v3." + a.lowercased() }   // t1282: v3 = one-node find + two-node contract confirm
  public static func memo(_ a: String) -> Memo? { store.data(forKey: key(a)).flatMap { try? JSONDecoder().decode(Memo.self, from: $0) } }
  static func save(_ m: Memo?, _ a: String) {
    if let m, let d = try? JSONEncoder().encode(m) { store.set(d, forKey: key(a)) } else { store.removeObject(forKey: key(a)) }
  }
  /// t1282: forget every saved scan (public block numbers / public permission data only) when the wallet-scoped state is reset.
  public static func forgetAll() {
    for k in store.dictionaryRepresentation().keys where k.hasPrefix("kp.safetycaps.memo.") { store.removeObject(forKey: k) }
  }
  /// Find budget per read. A wallet's permission is normally found in the first few calls (newest first); a wallet that never set
  /// one walks back to ChainLedger.floorBlock once (~200 calls of 50,000 blocks), then the memo makes later reads cheap.
  public static let maxCalls = 240
  public static let chunk: Int64 = 50_000

  static var nodes: [URL] {
    var out: [URL] = []
    for n in [rpc].compactMap({ $0 }) + ChainRPC.nodes where !out.contains(n) { out.append(n) }
    return out
  }

  /// isValid((address,address,address,uint160,uint48,uint48,uint48,uint256,bytes)) selector.
  public static let selIsValid: String = String(Hex.encode(Keccak.hash("isValid(" + tupleSig + ")")).replacingOccurrences(of: "0x", with: "").prefix(8))
  /// Calldata for isValid(permission) from one event's data (the event data IS abi.encode(permission); old fixtures lack the offset word).
  public static func isValidCall(_ data: String) -> String? {
    guard let b = Hex.decode(data), let w0 = base(b) else { return nil }
    let body = data.lowercased().replacingOccurrences(of: "0x", with: "")
    return "0x" + selIsValid + (w0 == 1 ? body : String(repeating: "0", count: 62) + "20" + body)
  }

  typealias Event = (data: String, revoked: Bool, block: Int64, li: Int64)
  static func best(_ arr: [[String: Any]], _ account: String) -> Event? {
    var best: Event?
    for l in arr {
      guard let d = l["data"] as? String, let t0 = (l["topics"] as? [String])?.first?.lowercased(),
            t0 == eventTopic.lowercased() || t0 == revokedTopic.lowercased(),
            let b = Hex.decode(d), let w0 = base(b), b.count >= 32 * (w0 + 1) else { continue }
      let ao = w0 * 32
      let who = "0x" + b[(ao + 12)..<(ao + 32)].map { String(format: "%02x", $0) }.joined()
      guard who == account else { continue }
      let bn = ChainLedger.hexInt(l["blockNumber"]) ?? 0, li = ChainLedger.hexInt(l["logIndex"]) ?? 0
      if let cur = best, (cur.block, cur.li) >= (bn, li) { continue }
      best = (d, t0 == revokedTopic.lowercased(), bn, li)
    }
    return best
  }
  static func logParams(_ from: Int64, _ to: Int64) -> [Any] {
    [["address": manager, "fromBlock": "0x" + String(from, radix: 16), "toBlock": "0x" + String(to, radix: 16), "topics": [[eventTopic, revokedTopic]]]]
  }
  static func rows(_ raw: Any) -> [[String: Any]]? { (raw as? [Any]).map { $0.compactMap { $0 as? [String: Any] } } }

  /// FIND (one node): newest permission event for `account` in [from, to]. ok=false = no node could answer.
  static func events(_ account: String, from: Int64, to: Int64) async -> (ok: Bool, best: Event?, node: URL?) {
    for n in nodes {
      guard let raw = try? await ChainRPC.anyTransport(n, "eth_getLogs", logParams(from, to)), let arr = rows(raw) else { continue }
      return (true, best(arr, account), n)
    }
    return (false, nil, nil)
  }

  /// CONFIRM 1 (once per event): a node other than the finder shows the same log (data, block, index) in that single block.
  /// true = confirmed, false = a second node answered and the log is not there (the finder lied or was wrong), nil = no second node answered.
  static func blockCheck(_ m: Memo, account: String, finder: URL?) async -> Bool? {
    guard let d = m.data?.lowercased() else { return nil }
    for n in nodes where n != finder {
      guard let raw = try? await ChainRPC.anyTransport(n, "eth_getLogs", logParams(m.block, m.block)), let arr = rows(raw) else { continue }
      guard let e = best(arr, account) else { return false }
      return e.block == m.block && e.li == m.li && e.revoked == m.revoked && e.data.lowercased() == d
    }
    return nil
  }

  /// CONFIRM 2 (every read): two nodes agree on isValid(permission). nil = can't confirm.
  static func validNow(_ data: String) async -> Bool? {
    guard let c = isValidCall(data), let r = await ChainRPC.agreedFast("eth_call", [["to": manager, "data": c], "latest"], nodes: nodes) else { return nil }
    return VaultCheck.decodeBool(r)
  }

  static func scan(account: String) async -> Read {
    guard FeatureSwitch.chainRead.on else { return Read(caps: .unreadable) }
    var m = memo(account)
    var finder: URL?
    var complete = false
    if let latest = await ChainRPC.agreedHead(nodes: nodes) {   // a block both nodes have
      var cur = m ?? Memo(newest: latest, oldest: latest + 1, data: nil, revoked: false, block: 0, li: 0)
      var calls = 0
      func take(_ e: Event) {
        guard (e.block, e.li) > (cur.block, cur.li) || (cur.data == nil && !cur.revoked) else { return }
        if e.revoked {
          guard cur.data == nil || cur.data?.lowercased() == e.data.lowercased() else { return }
          cur.data = e.data; cur.revoked = true
        } else { cur.data = e.data; cur.revoked = false }
        cur.block = e.block; cur.li = e.li; cur.blockConfirmed = nil
      }
      var failed = false
      // 1) new blocks since the last read (oldest first so the cursor never skips a gap).
      while cur.newest < latest && calls < maxCalls {
        let from = cur.newest + 1, to = min(latest, from + chunk - 1); calls += 1
        let r = await events(account, from: from, to: to)
        guard r.ok else { failed = true; break }
        if let e = r.best { take(e); finder = r.node }
        cur.newest = to
      }
      // 2) nothing found yet: walk back (newest first) until an event or the floor.
      if !failed && cur.data == nil && !cur.revoked {
        while cur.oldest > ChainLedger.floorBlock && calls < maxCalls {
          let to = cur.oldest - 1, from = max(ChainLedger.floorBlock, to - chunk + 1); calls += 1
          let r = await events(account, from: from, to: to)
          guard r.ok else { failed = true; break }
          cur.oldest = from
          if let e = r.best { take(e); finder = r.node; break }
        }
      }
      m = cur; save(cur, account)
      complete = !failed && (cur.data != nil || cur.oldest <= ChainLedger.floorBlock)
    }
    guard var cur = m else { return Read(caps: .unreadable) }
    guard let d = cur.data else {
      // Searched all the way to the floor (one node) and saw no permission for this wallet: really never set.
      return Read(caps: complete && cur.oldest <= ChainLedger.floorBlock ? .unset : .unreadable)
    }
    if cur.blockConfirmed != true {
      switch await blockCheck(cur, account: account, finder: finder) {
      case .some(true): cur.blockConfirmed = true; save(cur, account)
      case .some(false): save(nil, account); return Read(caps: .unreadable)   // a second node does not see it: forget it, search again next time
      case .none: return Read(caps: .unreadable)
      }
    }
    guard let valid = await validNow(d) else { return Read(caps: .unreadable) }
    if cur.revoked { return Read(caps: valid ? .unreadable : .unset) }
    guard valid else { return Read(caps: .unset) }   // approved once, no longer in force on chain (revoked)
    return pick([d], account: account)
  }

}
