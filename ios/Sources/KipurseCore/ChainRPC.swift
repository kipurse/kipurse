import Foundation

/// t821: the phone reads Base directly from public nodes, never through Kipurse. Operator node first (Info.plist KipurseChainRPC,
/// empty in normal builds), then four independent free, keyless public nodes. A failing / slow node is skipped (5 s).
/// t1282 (decision 156, owner t1283 / t1284): mainnet.base.org (429 on every eth_getLogs) and base.llamarpc.com (525, down) removed.
/// Tested 2026-11-25 from the owner's network: each 10/10 balance reads (7.721351 USDC), 10/10 heads, 5/5 one-block logs, ~0.25 s.
/// Only publicnode scans 50,000-block ranges (dRPC max 100, Nodies max 50, Bware single block), so it is first; the others
/// confirm (two-node eth_call, one-block log check). Coinbase CDP's node is a later step (needs a free client key from the owner).
public enum ChainRPC {
  public static let publicNodes = [URL(string: "https://base-rpc.publicnode.com")!,          // Allnodes
                                   URL(string: "https://base.drpc.org")!,                      // dRPC
                                   URL(string: "https://base-public.nodies.app")!,             // Nodies
                                   URL(string: "https://base-mainnet.public.blastapi.io")!]    // Bware Labs
  public static var backups: [URL] { Array(publicNodes.dropFirst()) }
  /// t1285 (decision 156): the PRIMARY node is Coinbase CDP Node (Base mainnet), supplied at build time as KIPURSE_CHAIN_RPC in the
  /// gitignored Config/Local.xcconfig (-> Info.plist KipurseChainRPC -> GasCheck.rpc). The free nodes are backups, asked in parallel.
  public static var primary: URL? { GasCheck.rpc }
  public static var nodes: [URL] {
    var out: [URL] = primary.map { [$0] } ?? []
    for b in publicNodes where !out.contains(b) { out.append(b) }
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
    // t1285: asked in parallel; the first two nodes that answer decide (the lower head: a block both have).
    await withTaskGroup(of: Int64?.self) { g in
      for n in nodes { g.addTask { guard let h = try? await transport(n, "eth_blockNumber", []), h.hasPrefix("0x"), let v = Int64(String(h.dropFirst(2)), radix: 16), v > 0 else { return nil }; return v } }
      var first: Int64?
      for await v in g { guard let v else { continue }; if let f = first { g.cancelAll(); return min(f, v) }; first = v }
      return nil
    }
  }

  /// t1285 (decision 156): every node at once; the FIRST valid answer wins (the balance shows as fast as the fastest node answers,
  /// a slow / rate-limited / down node never holds it up). `valid` rejects empty / malformed answers. nil = no node answered.
  public static func race(_ method: String, _ params: [Any], nodes: [URL] = nodes, valid: @escaping @Sendable (String) -> Bool = { $0.hasPrefix("0x") && $0.count > 2 }) async -> String? {
    let paramsBox = ParamsBox(params)
    return await withTaskGroup(of: String?.self) { g in
      for n in nodes { g.addTask { guard let v = try? await transport(n, method, paramsBox.params), valid(v) else { return nil }; return v } }
      for await v in g { if let v { g.cancelAll(); return v } }
      return nil
    }
  }
  /// t1285: all nodes at once; returns as soon as TWO different nodes gave the same answer (nil = no two agreed).
  public static func agreedFast(_ method: String, _ params: [Any], nodes: [URL] = nodes) async -> String? {
    let paramsBox = ParamsBox(params)
    return await withTaskGroup(of: String?.self) { g in
      for n in nodes { g.addTask { try? await transport(n, method, paramsBox.params) } }
      var seen: [String: Int] = [:]
      for await v in g { guard let v else { continue }; let k = v.lowercased(); seen[k, default: 0] += 1; if seen[k]! >= 2 { g.cancelAll(); return v } }
      return nil
    }
  }
  final class ParamsBox: @unchecked Sendable { let params: [Any]; init(_ p: [Any]) { params = p } }
  public static func ethCall(_ to: String, _ data: String, agreed two: Bool = false) async -> String? {
    let p: [Any] = [["to": to, "data": data], "latest"]
    return two ? await agreedFast("eth_call", p) : try? await call("eth_call", p)   // t1285: parallel, first two agreeing
  }
}
