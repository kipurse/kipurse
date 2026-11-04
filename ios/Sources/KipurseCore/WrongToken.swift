import Foundation

/// Coins that are NOT USDC but arrived in the Kipurse wallet on Base (server: GET /deposit?w=<wallet>&stray=1).
/// The AI can't spend them (its spend permission is USDC-only). The owner can send them back, only to his own Coinbase
/// account, from the deposit page (one Coinbase popup; he pays the network fee).
public struct StrayToken: Equatable, Identifiable, Sendable {
  public let sym: String; public let amount: String; public let shown: String
  public var id: String { sym }
  public init(sym: String, amount: String, shown: String) { self.sym = sym; self.amount = amount; self.shown = shown }
}
public enum WrongToken {
  public static let detected = ["ETH", "USDT", "WETH", "DAI", "cbBTC"]
  public static func url(base: URL, wallet: String) -> URL? {
    var c = URLComponents(url: base.appendingPathComponent("deposit"), resolvingAgainstBaseURL: false); c?.queryItems = [URLQueryItem(name: "w", value: wallet), URLQueryItem(name: "stray", value: "1")]; return c?.url }
  public static func parse(_ data: Data) -> [StrayToken] {
    guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let a = o["stray"] as? [[String: Any]] else { return [] }
    return a.compactMap { d in
      guard let s = d["sym"] as? String, detected.contains(s), let amt = d["amount"] as? String, let v = Decimal(string: amt), v > 0, let sh = d["shown"] as? String else { return nil }
      return StrayToken(sym: s, amount: amt, shown: sh) } }
  /// DEBUG/demo: "USDT:3.5,ETH:0.002"
  public static func demo(_ spec: String) -> [StrayToken] {
    spec.split(separator: ",").compactMap { p in let x = p.split(separator: ":"); guard x.count == 2, detected.contains(String(x[0])) else { return nil }
      return StrayToken(sym: String(x[0]), amount: "1", shown: String(x[1])) } }
  public static func notice(_ t: StrayToken) -> String {
    T("收到了 \(t.shown) \(t.sym)，不能用于 AI 支付，可一键退回你的 Coinbase 账户。", "Received \(t.shown) \(t.sym). It can’t be used for AI payments; you can send it back to your Coinbase account in one tap.") }
}
