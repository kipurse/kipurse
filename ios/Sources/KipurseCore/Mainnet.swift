import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

/// Mainnet (real money) rules shared by the app and the unit tests. Pure functions only.
public enum Mainnet {
  /// Operator's mainnet server (Info.plist via Config/Local.xcconfig). Unconfigured -> an unroutable placeholder.
  /// The operator's server (global endpoints: wallet discovery, new-user 开通).
  public static var base: URL { Operator.server ?? URL(string: "https://kipurse.invalid")! }
  /// This user's wallet on that server (every per-user endpoint).
  public static var server: URL { let p = Operator.tenantPath; return p.isEmpty ? base : base.appendingPathComponent(String(p.dropFirst())) }
  /// What the phone signs to learn which wallet its key belongs to (must equal the gateway's find digest).
  public static func findDigest(nonce: String) -> [UInt8] {
    let text = "Kipurse find wallet v1\nnonce:\(nonce)"
    #if canImport(CryptoKit)
    return [UInt8](SHA256.hash(data: Data(text.utf8)))
    #else
    return []
    #endif
  }
  public static var mcpURL: String { server.appendingPathComponent("mcp").absoluteString }
  /// Coinbase app universal link (coinbase.com AASA lists "/send"); without the app it opens the Coinbase website. Coinbase has no
  /// documented way to prefill the address or amount, so the app copies the address first.
  public static let coinbaseSendURL = URL(string: "https://www.coinbase.com/send")!
  /// Beginner "buy USDC" path (audit #1). No Onramp key is configured yet (handbook: Apple Pay deposits need their own CDP project),
  /// so this is a plain link to Coinbase's buy page; the user buys there, then sends to the wallet address.
  public static let coinbaseBuyURL = URL(string: "https://www.coinbase.com/buy/usdc")!
  /// Display only (audit #6): a cap like 10.05 (10 + fee headroom) is shown as "10". Never used for checks.
  public static func whole(_ atomic: Int64) -> String { atomic >= 1_000_000 ? AnswerRules.format(atomic - atomic % 1_000_000) : AnswerRules.format(atomic) }
  public static let maxTermAtomic: Int64 = 1_000_000_000_000   // 1,000,000 USDC, same as the server

  /// What the phone signs to erase all of this user's server records (must equal gateway eraseDigest()).
  public static func eraseDigest(wallet: String = PhoneTrust.mainnetWallet, nonce: String) -> [UInt8] {
    let text = "Kipurse erase all my data v1\nwallet:\(wallet.lowercased())\nnonce:\(nonce)"
    #if canImport(CryptoKit)
    return [UInt8](SHA256.hash(data: Data(text.utf8)))
    #else
    return []
    #endif
  }
  /// What the phone's Secure Enclave key signs to open a READ-ONLY session (must equal gateway sessionDigest()).
  public static func sessionDigest(wallet: String = PhoneTrust.mainnetWallet, nonce: String) -> [UInt8] {
    let text = "Kipurse read-only session v1\nwallet:\(wallet.lowercased())\nnonce:\(nonce)"
    #if canImport(CryptoKit)
    return [UInt8](SHA256.hash(data: Data(text.utf8)))
    #else
    return []
    #endif
  }
  public static func validNonce(_ n: String) -> Bool { n.count == 48 && n.allSatisfy { "0123456789abcdef".contains($0) } }

  /// Owner-chosen caps: nil = OK, else a short Chinese reason (mirrors the server's checkLimits).
  public static func limitsError(single: String, daily: String, term: String, days: String) -> String? {
    if [single, daily, term].contains(where: AnswerRules.looksMisgrouped) { return L(AnswerRules.badGroupingHint) }
    guard let s = AnswerRules.parseUSDC(single), s > 0 else { return L("每笔要填大于 0 的数") }
    guard let d = AnswerRules.parseUSDC(daily), d > 0 else { return L("每天要填大于 0 的数") }
    guard let t = AnswerRules.parseUSDC(term), t > 0 else { return L("总额要填大于 0 的数") }
    if s > d { return L("每笔不能大于每天") }
    if d > t { return L("每天不能大于总额") }
    if t > maxTermAtomic { return L("总额最多 1,000,000 USDC") }
    guard let n = Int(days), n >= 1, n <= 365 else { return L("期限要 1–365 天") }
    return nil
  }
  /// The public signing page for exactly these numbers.
  public static func limitsURL(single: String, daily: String, term: String, days: String) -> URL? {
    var c = URLComponents(url: server.appendingPathComponent("owner/limits"), resolvingAgainstBaseURL: false)!
    func f(_ v: String) -> String { AnswerRules.format(AnswerRules.parseUSDC(v) ?? 0) }
    c.queryItems = [.init(name: "single", value: f(single)), .init(name: "daily", value: f(daily)), .init(name: "term", value: f(term)), .init(name: "days", value: days)]
    return c.url
  }
}


/// kipurse://limits-updated?single=&daily=&term=&start=&end= — sent by the limits page once the new permission is valid ON CHAIN.
public struct LimitsUpdate: Equatable, Identifiable {
  public let single: Int64, daily: Int64, term: Int64, start: Date, end: Date
  public var id: String { "\(single)-\(daily)-\(term)-\(start.timeIntervalSince1970)" }
  public init(single: Int64, daily: Int64, term: Int64, start: Date, end: Date) { self.single = single; self.daily = daily; self.term = term; self.start = start; self.end = end }
  public static func parse(_ url: URL) -> LimitsUpdate? {
    guard url.scheme == "kipurse", url.host == "limits-updated", let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
    func n(_ k: String) -> Int64? { q.first { $0.name == k }?.value.flatMap { Int64($0) } }
    guard let s = n("single"), let d = n("daily"), let t = n("term"), let a = n("start"), let b = n("end"), s > 0, s <= d, d <= t, a > 0, b > a, b - a <= 365 * 86400 else { return nil }
    return LimitsUpdate(single: s, daily: d, term: t, start: Date(timeIntervalSince1970: TimeInterval(a)), end: Date(timeIntervalSince1970: TimeInterval(b)))
  }
}
/// A limits change the owner has signed and submitted, not on chain yet (server state "limitsPending" or kipurse://limits-pending).
public struct LimitsPending: Equatable {
  public let single: Int64, daily: Int64, term: Int64, days: Int?, since: Int64, failed: Bool
  public init(single: Int64, daily: Int64, term: Int64, days: Int?, since: Int64, failed: Bool) { self.single = single; self.daily = daily; self.term = term; self.days = days; self.since = since; self.failed = failed }
  public init?(_ j: JSONValue?) {
    guard let j, let s = j["single"]?.atomic, let d = j["daily"]?.atomic, let t = j["term"]?.atomic, let since = j["since"]?.atomic else { return nil }
    self.init(single: s, daily: d, term: t, days: j["days"]?.atomic.map { Int($0) }, since: since, failed: j["failed"]?.bool ?? false)
  }
  public static func parse(_ url: URL) -> LimitsPending? {
    guard url.scheme == "kipurse", url.host == "limits-pending", let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
    var o: [String: JSONValue] = ["since": .string(String(Int64(Date().timeIntervalSince1970)))]
    for i in q where ["single", "daily", "term", "days"].contains(i.name) { if let v = i.value, Int64(v) != nil { o[i.name] = .string(v) } }
    return LimitsPending(.object(o))
  }
}
public extension Mainnet {
  /// "2026-10-21 23:08" in the phone's own time zone.
  static func localTime(_ d: Date, zone: TimeZone = .current) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = zone; f.dateFormat = "yyyy-MM-dd HH:mm"; return f.string(from: d)
  }
  static func termRange(_ a: Date, _ b: Date, zone: TimeZone = .current) -> String { "\(localTime(a, zone: zone)) – \(localTime(b, zone: zone))" }
}

/// One USDC balance change from the on-chain ledger (server "ledger", newest first).
public struct LedgerRow: Identifiable, Equatable {
  public let tx: String, t: Date, account: String, kind: String, delta: Int64, balance: Int64?, zh: String
  /// AI payment order record (optional): what, who, the user's own words, budget, trial-only flag.
  public var orderItem: String? = nil, orderMerchant: String? = nil, orderQuote: String? = nil, orderBudget: String? = nil, orderTrial: Bool = false, orderTier: String? = nil, orderSource: String? = nil, payeeName: String? = nil, payeeAddress: String? = nil
  public var id: String { tx + account }
  public var isVault: Bool { account == "vault" }
  /// The owner's own Coinbase wallet (signature network fees): shown, but not part of the wallet balance.
  public var isOwner: Bool { account == "owner" }
  public init?(_ j: JSONValue) {
    guard let tx = j["tx"]?.string, tx.hasPrefix("0x"), let t = j["t"]?.atomic, let d = j["delta"]?.atomic else { return nil }
    let b = j["balance"]?.atomic; if b == nil && j["account"]?.string != "owner" { return nil }
    self.tx = tx; self.t = Date(timeIntervalSince1970: TimeInterval(t)); account = j["account"]?.string ?? "wallet"; kind = j["kind"]?.string ?? ""; delta = d; balance = b; zh = j["zh"]?.string ?? ""
    if let o = j["order"] { orderItem = o["item"]?.string.flatMap { $0.isEmpty ? nil : $0 }; orderMerchant = o["merchant"]?.string.flatMap { $0.isEmpty ? nil : $0 }; orderQuote = o["user_request"]?.string.flatMap { $0.isEmpty ? nil : $0 }; orderBudget = o["max_price"]?.string.flatMap { $0.isEmpty ? nil : $0 }; orderTrial = o["tier"]?.string == "stranger"; orderTier = o["tier"]?.string; orderSource = o["source"]?.string; payeeName = o["payeeName"]?.string.flatMap { $0.isEmpty ? nil : $0 }; payeeAddress = o["payee"]?.string }
  }
  /// "+10" / "−0.02673"
  public var signedShort: String { (delta >= 0 ? "+" : "−") + AnswerRules.short(delta >= 0 ? delta : -delta) }
  public var signed: String { (delta >= 0 ? "+" : "−") + AnswerRules.format(delta >= 0 ? delta : -delta) }
  public func url(explorer: String = "https://basescan.org") -> URL? { URL(string: "\(explorer)/tx/\(tx)") }
  /// Incoming transfer under 0.01 USDC (or zero): typical address poisoning. Hidden by default; never a payee source.
  public var suspicious: Bool { kind == "deposit" && delta < AddressCheck.dustAtomic }
}

/// Address-trust helpers (server is the authority; the phone only shows it clearly).
public extension AddressCheck {
  static let dustAtomic: Int64 = 10_000 // 0.01 USDC
  /// "0x" + 10 groups of 4 hex chars.
  public static func groups(_ a: String) -> [String] { guard a.hasPrefix("0x"), a.count == 42 else { return [a] }; let h = Array(a.dropFirst(2)); return stride(from: 0, to: 40, by: 4).map { String(h[$0..<$0+4]) } }
  /// Indexes (0-9) of the 4-char groups that differ (case-insensitive).
  public static func diffGroups(_ a: String, _ b: String) -> [Int] { let x = groups(a.lowercased()), y = groups(b.lowercased()); guard x.count == 10, y.count == 10 else { return [] }; return (0..<10).filter { x[$0] != y[$0] } }
  /// Same first 4 and last 4 hex chars, different full address.
  public static func isLookalike(_ a: String, _ b: String) -> Bool { let x = a.lowercased().dropFirst(2), y = b.lowercased().dropFirst(2); return x.count == 40 && y.count == 40 && x != y && x.prefix(4) == y.prefix(4) && x.suffix(4) == y.suffix(4) }
}

/// AI agents (not chatbots) verified to add a remote MCP server by URL with OAuth. Tap = copy the exact line for that agent.
public struct AgentCard: Identifiable, Equatable {
  public let id: String, name: String, symbol: String, copy: String, hintZh: String, hintEn: String
  /// app: custom scheme that launches the agent's iOS app (needs LSApplicationQueriesSchemes); open: universal link / web page.
  /// prefill: the link itself puts `copy` into the agent's composer (verified docs) -> no paste needed.
  public let app: URL?, open: URL, fallback: URL?, prefill: Bool
  static func q(_ s: String) -> String { var cs = CharacterSet.urlQueryAllowed; cs.remove(charactersIn: "&+=?#"); return s.addingPercentEncoding(withAllowedCharacters: cs) ?? s }
  /// Computed on every use: the MCP URL depends on the wallet path (/t/<wallet>), known only after sign-in.
  public static var mainnet: [AgentCard] {
    let grok = "Add this MCP server: \(Mainnet.mcpURL)"
    return [
      AgentCard(id: "grok-bot", name: "Grok", symbol: "bolt.horizontal", copy: grok,
                hintZh: "已在 Grok 里填好，点发送", hintEn: "Filled in Grok — tap send",  // i18n-ok: paired zh/en or zh-only data
                app: URL(string: "grokbot://app/v1/prompt?text=" + q(grok)), open: URL(string: "https://apps.apple.com/app/id6794501026")!, fallback: nil, prefill: true),
      AgentCard(id: "claude", name: "Claude", symbol: "asterisk", copy: Mainnet.mcpURL,
                hintZh: "已在 Claude 打开添加连接器，链接也已复制", hintEn: "Opened Claude's Add connector — link also copied",  // i18n-ok: paired zh/en or zh-only data
                app: nil, open: URL(string: "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Kipurse&connectorUrl=" + q(Mainnet.mcpURL).replacingOccurrences(of: ":", with: "%3A").replacingOccurrences(of: "/", with: "%2F"))!, fallback: nil, prefill: true),
    ]
  }
  /// Server kinds that are this card. The gateway names a claude.ai / Claude app / Claude Desktop OAuth client "claude-desktop"
  /// (kit/oauth.mjs mapClient); its agent id is "oauth-claude-desktop".
  public var kinds: [String] { id == "claude" ? ["claude", "claude-desktop"] : [id] }
  public func matches(_ a: JSONValue) -> Bool {
    let ids = [a["id"]?.string, a["kind"]?.string].compactMap { $0 }
    return ids.contains { k in kinds.contains(k) || kinds.contains { "oauth-" + $0 == k } }
  }
  /// Server records for this card (not revoked), connected ones first.
  public func records(in s: WalletState) -> [JSONValue] {
    s.agents.filter { matches($0) && !($0["revoked"]?.bool ?? false) }.sorted { ($0["connected"]?.bool ?? false) && !($1["connected"]?.bool ?? false) }
  }
  /// Real status: an OAuth agent of this kind with a live token on the server.
  public func connected(in s: WalletState) -> Bool { records(in: s).contains { $0["connected"]?.bool ?? false } }
  /// Authorized on the server but the AI never finished the token exchange (no live token).
  public func unfinished(in s: WalletState) -> Bool { !connected(in: s) && !records(in: s).isEmpty }
  /// Most recent use across this card's records (ISO string), nil = never.
  public func lastUsed(in s: WalletState) -> String? { records(in: s).compactMap { $0["lastUsed"]?.string }.max() }
  public static func known(_ a: JSONValue) -> Bool {
    a["id"]?.string == "muse" || a["kind"]?.string == "muse" || mainnet.contains { $0.matches(a) }
  }
}

public extension WalletState {
  var isMainnet: Bool { raw["mode"]?.string == "MAIN" }
  var capSingle: Int64? { raw["caps"]?["single"]?.atomic }
  var capDaily: Int64? { raw["caps"]?["daily"]?.atomic }
  var capTerm: Int64? { raw["caps"]?["term"]?.atomic }
  /// t679: limits the owner signed in the authorization (Policy.maxNetworkFee / maxFeePpm), from the gateway status.
  var capMaxNetworkFee: Int64? { raw["caps"]?["maxNetworkFee"]?.atomic }
  var capFeePpm: Int64? { raw["caps"]?["maxFeePpm"]?.atomic }
  /// Protocol fee for an amount at the signed rate, rounded up exactly like the contract (default 0.1%).
  func protocolFee(_ amount: Int64) -> Int64 { let ppm = capFeePpm ?? 1000; return (amount * ppm + 999_999) / 1_000_000 }
  /// Permission window in whole days (start..end from the chain), nil when unknown.
  var capDays: Int? { guard let a = raw["caps"]?["start"]?.atomic, let b = raw["caps"]?["end"]?.atomic, b > a else { return nil }; return Int((b - a + 43_200) / 86_400) }
  var capStart: Date? { raw["caps"]?["start"]?.atomic.map { Date(timeIntervalSince1970: TimeInterval($0)) } }
  var limitsPending: LimitsPending? { LimitsPending(raw["limitsPending"]) }
  var ledger: [LedgerRow] { (raw["ledger"]?.array ?? []).compactMap(LedgerRow.init) }
  var capEnd: Date? { raw["caps"]?["end"]?.atomic.map { Date(timeIntervalSince1970: TimeInterval($0)) } }
  var serverSpentToday: Int64? { raw["spent"]?["today"]?.atomic }
  var serverSpentTerm: Int64? { raw["spent"]?["term"]?.atomic }
  /// Muse (agent id / kind "muse"): connected on the server that answered, and when it last used the wallet.
  var muse: (connected: Bool, lastUsed: String?) {
    let a = agents.first { $0["id"]?.string == "muse" || $0["kind"]?.string == "muse" }
    guard let a, !(a["revoked"]?.bool ?? false) else { return (false, nil) }
    return (a["connected"]?.bool ?? true, a["lastUsed"]?.string)
  }
}

/// A pending agent connection (OAuth) the enrolled phone can approve with Face ID (gateway oauth pendingList()).
public struct ConnectRequest: Identifiable, Equatable {
  public let id: String, client: String, kind: String, host: String, exp: Double
  public init?(_ j: JSONValue) { guard let id = j["id"]?.string, ConnectApproval.validId(id) else { return nil }
    self.id = id; client = j["client"]?.string ?? "AI"; kind = j["kind"]?.string ?? ""; host = j["host"]?.string ?? ""; exp = Double(j["exp"]?.atomic ?? 0) }
}
public extension WalletState {
  var connectRequests: [ConnectRequest] { (raw["connectRequests"]?.array ?? []).compactMap(ConnectRequest.init) }
  func liveConnectRequests(now: Date = Date()) -> [ConnectRequest] { connectRequests.filter { $0.exp == 0 || $0.exp > now.timeIntervalSince1970 } }
}
/// What the phone key signs to approve / reject ONE connection (must equal gateway connectText / connectDigest). The phone builds it itself.
public enum ConnectApproval {
  /// Server digest ("0x…" or bare hex, any case) equals the one the phone computed itself.
  public static func matches(_ d: [UInt8], server: String) -> Bool {
    let mine = Hex.encode(d).lowercased(); var theirs = server.lowercased(); if !theirs.hasPrefix("0x") { theirs = "0x" + theirs }
    return d.count == 32 && mine == theirs
  }
  public static func validId(_ s: String) -> Bool { s.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil }
  public static func text(wallet: String = PhoneTrust.mainnetWallet, req: String, clientId: String, name: String, redirect: String, exp: Int, approve: Bool) -> String {
    "Kipurse approve connection v1\nwallet:\(wallet.lowercased())\nreq:\(req)\nclient:\(clientId)\nname:\(name)\nredirect:\(redirect)\nexp:\(exp)\naction:\(approve ? "approve" : "reject")"
  }
  public static func digest(req: String, clientId: String, name: String, redirect: String, exp: Int, approve: Bool, wallet: String = PhoneTrust.mainnetWallet) -> [UInt8] {
    let t = text(wallet: wallet, req: req, clientId: clientId, name: name, redirect: redirect, exp: exp, approve: approve)
    #if canImport(CryptoKit)
    return [UInt8](SHA256.hash(data: Data(t.utf8)))
    #else
    return []
    #endif
  }
}
