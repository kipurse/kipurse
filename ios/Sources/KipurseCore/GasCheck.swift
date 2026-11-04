import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Network-fee preflight for every transaction the USER signs with their own Coinbase wallet.
/// Rule: the user pays their own gas, in USDC, from their own Coinbase wallet (never ETH). Kipurse never pays or fronts gas
/// (the only exception is the sponsored first wallet setup, which never goes through this preflight).
/// Open-source core: no operator values compiled in. The RPC comes from Info.plist (KipurseChainRPC, from Config/Local.xcconfig
/// or the test build's flags); the address is the user's own Coinbase wallet. Nothing is stored.
public enum GasCheck {
  /// What the user is about to sign (gas units are conservative upper estimates for a Coinbase wallet smart-wallet batch).
  public enum Kind: String, CaseIterable { case phoneUpgrade, phoneRevoke, limits, other
    public var gasUnits: UInt64 {
      switch self {
      case .phoneUpgrade: return 1_300_000   // CREATE2 deploy of the phone approver + addOwnerAddress, one atomic batch
      case .phoneRevoke: return 250_000      // removeOwnerAtIndex
      case .limits: return 400_000           // limits batch
      case .other: return 500_000
      }
    }
    public var title: String {
      switch self {
      case .phoneUpgrade: return Unbound.bindLabel
      case .phoneRevoke: return T("撤销手机确认", "Revoke phone signer")
      case .limits: return T("修改上限", "Change limits")
      case .other: return T("Coinbase 确认", "Coinbase wallet signature")
      }
    }
    public static func from(url: URL) -> Kind {
      let p = url.path.lowercased()
      if p.contains("revoke") { return .phoneRevoke }
      if p.contains("phone") || p.contains("enroll") || p.contains("upgrade") { return .phoneUpgrade }
      if p.contains("limits") { return .limits }
      return .other
    }
  }
  /// Safety margin on top of the estimate (gas price can move between now and signing).
  public static let marginPercent: UInt64 = 50
  /// Small allowance for Base's L1 data fee, in wei (0.0000005 ETH).
  public static let l1AllowanceWei: UInt64 = 500_000_000_000

  public static let usdcToken = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"   // USDC on Base
  public static var rpc: URL? { Operator.str("KipurseChainRPC").flatMap(URL.init(string:)) }
  /// Preflight is on when the build configures a chain RPC (test/fork build only for now).
  public static var enabled: Bool { rpc != nil }

  /// Fees are paid in USDC (the Coinbase wallet's own USDC via Coinbase's USDC gas option); ETH is never required.
  /// When no ETH price is available a conservative $5,000/ETH is assumed so the USDC estimate errs high.
  public static let fallbackEthUSD = 5000.0
  public struct Estimate: Equatable {
    public let feeWei: Double, requiredWei: Double, balanceWei: Double, ethUSD: Double?
    public var balanceUSDC: Double = 0   // Coinbase wallet USDC, whole dollars
    public var feeUSDC: Double { feeWei / 1e18 * (ethUSD ?? GasCheck.fallbackEthUSD) }
    public var requiredUSDC: Double { requiredWei / 1e18 * (ethUSD ?? GasCheck.fallbackEthUSD) }
    public var enough: Bool { balanceUSDC >= requiredUSDC }
    public var missingUSDC: Double { max(0, requiredUSDC - balanceUSDC) }
    public var missingWei: Double { max(0, requiredWei - balanceWei) }
    public func usd(_ wei: Double) -> String? { ethUSD.map { String(format: "$%.4f", wei / 1e18 * $0) } }
  }
  public static func estimate(kind: Kind, gasPriceWei: Double, balanceWei: Double = 0, ethUSD: Double?, balanceUSDC: Double = 0) -> Estimate {
    let fee = Double(kind.gasUnits) * gasPriceWei + Double(l1AllowanceWei)
    var e = Estimate(feeWei: fee, requiredWei: fee * Double(100 + marginPercent) / 100, balanceWei: balanceWei, ethUSD: ethUSD); e.balanceUSDC = balanceUSDC; return e
  }
  /// "$0.0123" style USDC amount (4 decimals, at least $0.0001).
  public static func dollars(_ v: Double) -> String { String(format: "%.4f USDC", max(v, 0.0001)) }
  /// "0.0000123 ETH" (up to 8 significant decimals, no trailing zeros).
  public static func eth(_ wei: Double) -> String {
    var s = String(format: "%.8f", wei / 1e18); while s.hasSuffix("0") { s.removeLast() }; if s.hasSuffix(".") { s.removeLast() }
    return s + " ETH"
  }
  public static var notice: String {
    T("手续费由你自己付，用 USDC 付，不需要 ETH：从你的 Coinbase 账户里的 USDC 扣，确认窗口会显示准确金额。Kipurse 不出钱、不代付。",
      "You pay this network fee yourself, in USDC (no ETH needed), from your Coinbase account (Coinbase wallet); the signing window shows the exact amount. Kipurse pays nothing.")
  }
  public static func missingText(_ e: Estimate) -> String {
    T("你的 Coinbase 账户里 USDC 不够付手续费，还差约 \(dollars(e.missingUSDC))。先往里转一点 USDC（Base 网络）就行，不需要 ETH。",
      "Not enough USDC in your Coinbase account (Coinbase wallet) for the network fee: about \(dollars(e.missingUSDC)) short. Add a little USDC on Base; no ETH needed.")
  }

  /// /phone/status `active` says the V2 approver (owner payments / Siri) is live -> no upgrade needed.
  /// (V3 = same as V2 without the frozen phone ceiling; also Siri-capable.)
  public static func isV2(_ active: [String: Any]?) -> Bool { ["v2", "v3"].contains(active?["version"] as? String ?? "") }
  /// Server offers the one-time V3 upgrade (only when the operator turned V3 on): Siri then follows the wallet's live limits.
  public static func upgradeToV3(_ active: [String: Any]?) -> Bool { (active?["upgradeTo"] as? String) == "v3" && (active?["version"] as? String) != "v3" }

  // MARK: phone upgrade: the network fee is paid from the KIPURSE WALLET's own USDC.
  /// The owner's Coinbase wallet sends the batch (pays gas up front, own money); the same atomic batch has the Kipurse wallet send
  /// `fee` USDC back to it (server-computed at actual cost, no markup or minimum, max 0.05 USDC). Kipurse pays nothing, sponsors nothing.
  public struct UpgradeQuote: Equatable {
    public let fee: UInt64, walletUSDC: UInt64, ownerEthWei: Double, ownerGasWei: Double
    public var enough: Bool { walletUSDC >= fee }
    public var ownerCanPayEth: Bool { ownerEthWei >= ownerGasWei }
    public init(fee: UInt64, walletUSDC: UInt64, ownerEthWei: Double, ownerGasWei: Double) { self.fee = fee; self.walletUSDC = walletUSDC; self.ownerEthWei = ownerEthWei; self.ownerGasWei = ownerGasWei }
    public init?(json j: [String: Any]) {
      func s(_ k: String) -> String? { (j[k] as? String) ?? (j[k] as? NSNumber)?.stringValue }
      guard let f = s("fee").flatMap(UInt64.init), let w = s("walletUSDC").flatMap(UInt64.init), let e = s("ownerEthWei").flatMap(Double.init), let g = s("ownerGasWei").flatMap(Double.init), f <= 50_000 else { return nil }
      self.init(fee: f, walletUSDC: w, ownerEthWei: e, ownerGasWei: g)
    }
  }
  public static func usdc(_ atomic: UInt64) -> String {
    var s = String(format: "%.6f", Double(atomic) / 1e6); while s.hasSuffix("0") { s.removeLast() }; if s.hasSuffix(".") { s.removeLast() }; return s + " USDC" }
  public static var upgradeNotice: String {
    T("这是一笔链上交易，手续费按实际花费从你的启付钱包 USDC 扣，最多 0.05 USDC，只付一次。Kipurse 不收一分钱。",
      "This is an on-chain transaction. The fee is taken at actual cost from your Kipurse wallet's USDC, at most 0.05 USDC, once. Kipurse takes nothing.") }
  /// Bind (Face ID approvals): works WITHOUT the Siri upgrade.
  public static var phoneSignerWhat: String {
    T("AI 要付新收款方或超出上限时，直接在这台手机用 Face ID 批准。不需要开通 Siri。手机钥匙不能转走你的钱。",
      "When an AI wants to pay a new payee or go over your limit, you approve here with Face ID. None of this needs Siri. The phone key can't move your money.") }
  /// Optional Siri upgrade: adds voice payments on top; Face ID approvals already work without it.
  public static var phoneSiriWhat: String {
    T("这是给旧版手机确认的一次性升级，手续费用你钱包里的 USDC 付。Siri 付款不需要升级：付款上限内直接付，超出时推送到手机用 Face ID 批准。不升级也不影响 Face ID：批准新收款方、超出上限的付款、恢复 AI 付款照样能用。手机钥匙不能转走你的钱，也不能提高上限。",
      "This is a one-time upgrade for an older phone signer; the network fee is paid from your wallet's USDC. Siri payments don't need it: within your payment limit Siri pays, otherwise you get a Face ID request on this phone. Without it, Face ID still works: approving new payees, payments over the limit and resuming AI payments. The phone key can't move your money or raise your limits.") }
  public static var agentsFreeText: String {
    T("连接 Claude、Grok、Muse、Siri 不收开通费：只在我们的服务器上授权，不上区块链。",
      "Connecting Claude, Grok, Muse or Siri has no setup fee: it's only authorized on our server, nothing goes on the blockchain.") }
  public static func upgradeMissingText(_ q: UpgradeQuote) -> String {
    T("启付钱包 USDC 不够，还差 \(usdc(q.fee - min(q.fee, q.walletUSDC)))。", "Not enough USDC in your Kipurse wallet: \(usdc(q.fee - min(q.fee, q.walletUSDC))) short.") }
  public static var ownerNoGasText: String {
    T("确认窗口里会先显示从你的 Coinbase 钱包 付这笔 USDC，同一笔交易里启付钱包马上还给你；不需要 ETH。",
      "The signing window shows your Coinbase wallet paying this USDC; the same transaction pays it straight back from your Kipurse wallet. No ETH needed.") }
  public static func fetchUpgradeQuote(server: URL, id: String) async throws -> UpgradeQuote {
    var c = URLComponents(url: server.appendingPathComponent("phone/enroll/quote"), resolvingAgainstBaseURL: false)!; c.queryItems = [URLQueryItem(name: "id", value: id)]
    let (d, resp) = try await URLSession.shared.data(from: c.url!)
    let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    if let h = resp as? HTTPURLResponse, h.statusCode >= 400 { throw ServerText.error(j, status: h.statusCode, domain: "kipurse.gas") }
    guard let q = UpgradeQuote(json: j) else { throw NSError(domain: "kipurse.gas", code: 5, userInfo: [NSLocalizedDescriptionKey: T("读不到手续费报价", "Couldn't read the fee quote")]) }
    return q
  }

  // MARK: reads (eth_gasPrice + eth_getBalance on the configured RPC; ETH/USD from Coinbase's public spot price, optional)
  /// t846: the enroll id is in ?id= or, after SignHost routing, inside the shell fragment #u=<encoded /phone/enroll?id=…>.
  public static func enrollID(_ url: URL) -> String? {
    if let v = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value, !v.isEmpty { return v }
    guard let f = url.fragment else { return nil }
    for part in f.split(separator: "&") where part.hasPrefix("u=") {
      guard let inner = String(part.dropFirst(2)).removingPercentEncoding, let c = URLComponents(string: "https://x" + inner) else { continue }
      if let v = c.queryItems?.first(where: { $0.name == "id" })?.value, !v.isEmpty { return v }
    }
    return nil
  }
  public static func hexWei(_ s: String) -> Double? {
    let h = s.hasPrefix("0x") ? String(s.dropFirst(2)) : s; guard !h.isEmpty, h.count <= 64 else { return nil }
    var v = 0.0; for c in h { guard let d = c.hexDigitValue else { return nil }; v = v * 16 + Double(d) }; return v
  }
  static func call(_ rpc: URL, _ method: String, _ params: [Any]) async throws -> String {
    var r = URLRequest(url: rpc, timeoutInterval: 10); r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": method, "params": params])
    let (d, _) = try await URLSession.shared.data(for: r)
    guard let j = try JSONSerialization.jsonObject(with: d) as? [String: Any], let v = j["result"] as? String else {
      throw NSError(domain: "kipurse.gas", code: 1, userInfo: [NSLocalizedDescriptionKey: T("读不到手续费或余额（\(method)）", "Couldn't read fee or balance (\(method))")]) }
    return v
  }
  public static func ethUSD() async -> Double? {
    guard let u = URL(string: "https://api.coinbase.com/v2/prices/ETH-USD/spot"), let (d, _) = try? await URLSession.shared.data(from: u),
          let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let a = (j["data"] as? [String: Any])?["amount"] as? String else { return nil }
    return Double(a)
  }
  public static func fetch(kind: Kind, account: String) async throws -> Estimate {
    let rpc = rpc ?? VaultCheck.publicRPC   // t846: empty KIPURSE_CHAIN_RPC (normal builds) -> Base public node, same as ChainRPC
    guard account.count == 42, account.hasPrefix("0x") else {
      throw NSError(domain: "kipurse.gas", code: 3, userInfo: [NSLocalizedDescriptionKey: T("不知道你的 Coinbase 钱包 地址，无法检查余额。", "Your Coinbase wallet address is unknown; can't check the balance.")]) }
    let data = "0x70a08231" + String(repeating: "0", count: 24) + account.dropFirst(2).lowercased()
    async let gp = call(rpc, "eth_gasPrice", []); async let bal = call(rpc, "eth_call", [["to": usdcToken, "data": data], "latest"]); async let px = ethUSD()
    guard let g = hexWei(try await gp), let b = hexWei(try await bal) else { throw NSError(domain: "kipurse.gas", code: 4, userInfo: [NSLocalizedDescriptionKey: "bad rpc value"]) }
    return estimate(kind: kind, gasPriceWei: g, ethUSD: await px, balanceUSDC: b / 1e6)
  }
}
