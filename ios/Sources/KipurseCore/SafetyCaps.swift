import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// t1094: read the wallet safety limit the same way the server does — the spend permission's
/// Policy extraData (single, daily, term). Read-only. A failed call is unreadable; an empty
/// answer is "never set".
public enum SafetyCaps {
  /// Tests replace this. Production posts to a public Base node. Nil result means the read failed.
  public static var query: ((String) async -> Any?)?
  /// Optional operator RPC. Nil uses the public Base node.
  public static var rpc: URL?
  /// Coinbase SpendPermissionManager on Base. Same address RequestVerify uses.
  public static let manager = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad"
  /// SpendPermissionApproved(bytes32,(address,address,address,uint160,uint48,uint48,uint48,uint256,bytes))
  public static let eventTopic: String = {
    let h = Keccak.hash("SpendPermissionApproved(bytes32,(address,address,address,uint160,uint48,uint48,uint48,uint256,bytes))")
    return Hex.encode(h)
  }()

  public static func latest(account: String) async -> AILimitGate.Caps {
    let want = account.lowercased()
    guard let raw = await logs(for: want) else { return .unreadable }
    var saw = false
    var found: AILimitGate.Caps?
    for data in raw {
      guard let one = decode(data, account: want) else { continue }
      saw = true
      found = one
    }
    if let found { return found }
    return saw ? .unreadable : .unset
  }

  /// One log's data. nil = not this account. unreadable = this account but the policy bytes are bad.
  public static func decode(_ data: String, account: String) -> AILimitGate.Caps? {
    guard let b = Hex.decode(data), b.count >= 32 * 9 else { return nil }
    let who = "0x" + b[12..<32].map { String(format: "%02x", $0) }.joined()
    guard who == account.lowercased() else { return nil }
    guard let off = u64(b, 8), off >= 0, Int(off) + 32 <= b.count else { return .unreadable }
    let start = Int(off)
    guard start % 32 == 0, let n = u64(b, UInt64(start / 32)), n == 384, start + 32 + 384 <= b.count else { return .unreadable }
    let pol = Array(b[(start + 32)..<(start + 32 + 384)])
    guard let s = u64(pol, 2), let d = u64(pol, 3), let t = u64(pol, 4) else { return .unreadable }
    if s == 0 || d == 0 || t == 0 { return .unset }
    guard s <= UInt64(Int64.max), d <= UInt64(Int64.max), t <= UInt64(Int64.max) else { return .unreadable }
    return .ready(single: Int64(s), daily: Int64(d), term: Int64(t))
  }

  private static func u64(_ b: [UInt8], _ word: UInt64) -> UInt64? {
    let o = Int(word) * 32
    guard o >= 0, o + 32 <= b.count else { return nil }
    if b[o..<(o + 24)].contains(where: { $0 != 0 }) { return nil }
    var v: UInt64 = 0
    for i in 0..<8 { v = (v << 8) | UInt64(b[o + 24 + i]) }
    return v
  }

  private static func logs(for account: String) async -> [String]? {
    if let query { return await query(account) as? [String] }
    let topic = eventTopic
    let filter: [String: Any] = ["address": manager, "topics": [topic], "fromBlock": "0x0"]
    guard let url = rpc ?? URL(string: "https://mainnet.base.org") else { return nil }
    var r = URLRequest(url: url, timeoutInterval: 12); r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = try? JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": "eth_getLogs", "params": [filter]])
    guard r.httpBody != nil, let (d, resp) = try? await URLSession.shared.data(for: r), (resp as? HTTPURLResponse)?.statusCode == 200,
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], j["error"] == nil,
          let arr = j["result"] as? [[String: Any]] else { return nil }
    return arr.compactMap { $0["data"] as? String }
  }
}
