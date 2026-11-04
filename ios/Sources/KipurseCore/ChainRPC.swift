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
  public static func ethCall(_ to: String, _ data: String, agreed two: Bool = false) async -> String? {
    let p: [Any] = [["to": to, "data": data], "latest"]
    return two ? await agreed("eth_call", p) : try? await call("eth_call", p)
  }
}
