import Foundation

/// t821: the phone reads Base directly from public nodes, never through Kipurse. Primary first (Info.plist KipurseChainRPC,
/// else mainnet.base.org), then two independent public backups. A failing / slow node is skipped (5 s).
public enum ChainRPC {
  public static let backups = [URL(string: "https://base-rpc.publicnode.com")!, URL(string: "https://base.llamarpc.com")!]
  public static var nodes: [URL] {
    var out = [GasCheck.rpc ?? VaultCheck.publicRPC]
    for b in [VaultCheck.publicRPC] + backups where !out.contains(b) { out.append(b) }
    return out
  }
  public typealias Transport = (URL, String, [Any]) async throws -> String
  /// Tests swap this; production posts JSON-RPC with a 5 s timeout.
  public static var transport: Transport = { url, method, params in
    var r = URLRequest(url: url, timeoutInterval: 5); r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": method, "params": params])
    let (d, resp) = try await URLSession.shared.data(for: r)
    guard (resp as? HTTPURLResponse)?.statusCode == 200, let j = try JSONSerialization.jsonObject(with: d) as? [String: Any], let v = j["result"] as? String else { throw URLError(.badServerResponse) }
    return v
  }
  public typealias AnyTransport = (URL, String, [Any]) async throws -> Any
  /// Same nodes / timeout as `transport`, but returns any JSON-RPC result (eth_getLogs needs an array).
  public static var anyTransport: AnyTransport = { url, method, params in
    var r = URLRequest(url: url, timeoutInterval: 8); r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": method, "params": params])
    let (d, resp) = try await URLSession.shared.data(for: r)
    guard (resp as? HTTPURLResponse)?.statusCode == 200,
          let j = try JSONSerialization.jsonObject(with: d) as? [String: Any],
          j["error"] == nil, let v = j["result"] else { throw URLError(.badServerResponse) }
    return v
  }
  /// First node that answers with a JSON result (string, array, or object).
  public static func callAny(_ method: String, _ params: [Any], nodes: [URL] = nodes) async throws -> Any {
    var last: Error = URLError(.cannotConnectToHost)
    for n in nodes { do { return try await anyTransport(n, method, params) } catch { last = error } }
    throw last
  }

  /// First node that answers.
  public static func call(_ method: String, _ params: [Any], nodes: [URL] = nodes) async throws -> String {
    var last: Error = URLError(.cannotConnectToHost)
    for n in nodes { do { return try await transport(n, method, params) } catch { last = error } }
    throw last
  }
  /// Two different nodes must give the same answer (a single lying / stale node can't show a wrong balance). nil = can't confirm.
  public static func agreed(_ method: String, _ params: [Any], nodes: [URL] = nodes) async -> String? {
    var first: String?
    for n in nodes {
      guard let v = try? await transport(n, method, params) else { continue }
      if let f = first { return f.lowercased() == v.lowercased() ? f : nil }
      first = v
    }
    return nil
  }
  /// t1275: same rule as `agreed` for any JSON result (eth_getLogs arrays): the first two nodes that answer must give the same
  /// `canon` form (nil from `canon` = not comparable = can't confirm). Returns the first node's raw result, nil = can't confirm.
  public static func agreedAny(_ method: String, _ params: [Any], nodes: [URL] = nodes, canon: (Any) -> String?) async -> Any? {
    var first: (raw: Any, key: String)?
    for n in nodes {
      guard let v = try? await anyTransport(n, method, params) else { continue }
      guard let k = canon(v) else { return nil }
      if let f = first { return f.key == k ? f.raw : nil }
      first = (v, k)
    }
    return nil
  }
  /// t1275: eth_getLogs results reduced to what the phone reads (block, log index, topics, data), order-free, lowercased.
  public static func logsCanon(_ v: Any) -> String? {
    guard let arr = v as? [Any] else { return nil }
    var rows = [String]()
    for x in arr { guard let l = x as? [String: Any] else { return nil }
      let t = (l["topics"] as? [String] ?? []).map { $0.lowercased() }.joined(separator: ",")
      rows.append([l["blockNumber"] as? String ?? "", l["logIndex"] as? String ?? "", t, (l["data"] as? String ?? "").lowercased()].joined(separator: "|").lowercased()) }
    return rows.sorted().joined(separator: "\n")
  }
  /// t1275: the newest block BOTH of the first two answering nodes have (the lower of their two heads). nil = can't confirm.
  public static func agreedHead(nodes: [URL] = nodes) async -> Int64? {
    var first: Int64?
    for n in nodes {
      guard let h = try? await transport(n, "eth_blockNumber", []), h.hasPrefix("0x"), let v = Int64(String(h.dropFirst(2)), radix: 16), v > 0 else { continue }
      if let f = first { return min(f, v) }
      first = v
    }
    return nil
  }
  public static func ethCall(_ to: String, _ data: String, agreed two: Bool = false) async -> String? {
    let p: [Any] = [["to": to, "data": data], "latest"]
    return two ? await agreed("eth_call", p) : try? await call("eth_call", p)
  }
}
