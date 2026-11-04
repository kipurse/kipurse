import Foundation

/// The parts of GET /api/state the app uses (kit/server.mjs API.state).
public struct WalletState {
  public let raw: JSONValue
  public init(_ raw: JSONValue) { self.raw = raw }
  public var isTestMode: Bool { raw["mode"]?.string == "TEST" }
  public var chainId: Int { Int(raw["chainId"]?.atomic ?? 0) }
  public var hasSetup: Bool { raw["setup"] != nil && raw["setup"] != .null }
  public var active: Bool { raw["setup"]?["active"]?.bool ?? false }
  public var wallet: String? { raw["setup"]?["wallet"]?.string }
  public var owner: String? { raw["setup"]?["owner"]?.string }
  public var balance: Int64 { raw["balance"]?.atomic ?? 0 }
  public var quarantined: Int64 { raw["quarantined"]?.atomic ?? 0 }
  /// Gas reserve kept in the owner's own vault (pays network fees in USDC; returned on take-everything-back).
  public var reserve: Int64 { raw["reserve"]?.atomic ?? 0 }
  public var riskZh: String { raw["riskZh"]?.string ?? L("这个钱包完全由 AI 控制，请只放少量资金。") }
  public var disclosureZh: [String] { raw["disclosure"]?["zh"]?.array.compactMap { $0.string } ?? [] }
  public var limits: [String:Int64] { var o: [String:Int64] = [:]; for k in AnswerRules.usdcKeys { if let v = raw["limits"]?[k]?.atomic { o[k] = v } }; return o }
  public var mainSingle: Int64? { raw["main"]?["single"]?.atomic }
  public var mainDaily: Int64? { raw["main"]?["daily"]?.atomic }
  public var pendingCalls: JSONValue? { raw["setup"]?["calls"] }
  public var walletDeployed: Bool { raw["walletDeployed"]?.bool ?? false }
  public var elsewhere: [JSONValue] { raw["elsewhere"]?.array ?? [] }
  public var purchases: [JSONValue] { raw["purchases"]?.array ?? [] }
  public var agents: [JSONValue] { raw["agents"]?.array ?? [] }
  /// Agent-requested trust (same flow for every AI): owner-only approve (signs in his Coinbase wallet on the kit page) or reject.
  public var trustRequests: [TrustRequest] { (raw["trustRequests"]?["pending"]?.array ?? []).compactMap(TrustRequest.init) }

  /// Everything that needs the owner's tap, as stable ids + plain Chinese text (drives notifications and the 待批准 list).
  public var approvals: [Approval] {
    var out: [Approval] = []
    for p in raw["trust"]?["pending"]?.array ?? [] { if let id = p["id"]?.string {
      out.append(.init(id: "trust:" + id, kind: .trust, serverId: id, titleZh: L("AI 想信任一个收款方"),
        bodyZh: L("\(p["subject"]?["id"]?.string ?? "")：每笔 \(AnswerRules.format(p["single"]?.atomic ?? 0)) / 每天 \(AnswerRules.format(p["daily"]?.atomic ?? 0)) USDC。理由：\(p["reason"]?.string ?? "")"))) } }
    for r in trustRequests {
      out.append(.init(id: "treq:" + r.id, kind: .trustRequest, serverId: r.id, titleZh: L("AI 请求信任收款方"),
        bodyZh: L("\(r.payee) · \(r.chainLabel) · 每笔 ≤ \(AnswerRules.format(r.single)) / 每天 ≤ \(AnswerRules.format(r.total)) USDC"))) }
    for c in raw["pending"]?["changes"]?.array ?? [] { if let id = c["id"]?.string {
      out.append(.init(id: "limits:" + id, kind: .loosenLimits, serverId: id, titleZh: L("AI 想调高上限"), bodyZh: L("需要你同意才会生效。"))) } }
    for w in raw["pending"]?["withdrawals"]?.array ?? [] { if let id = w["id"]?.string {
      out.append(.init(id: "withdraw:" + id, kind: .withdraw, serverId: id, titleZh: L("提现申请"), bodyZh: L("\(AnswerRules.format(w["amount"]?.atomic ?? 0)) USDC 转到你的钱包"))) } }
    for o in raw["oauthPending"]?.array ?? [] { if let id = o["id"]?.string {
      out.append(.init(id: "connect:" + id, kind: .connectAgent, serverId: id, titleZh: L("\(o["client"]?.string ?? "AI") 想连接你的钱包"),
        bodyZh: L("批准后它能查余额、在你设的上限内付款；信任新收款方和提现仍要你批准。来自：\(o["host"]?.string ?? "")。这个钱包完全由 AI 控制，请只放少量资金。"))) } }
    return out
  }
}

public struct Approval: Identifiable, Equatable, Hashable {
  public enum Kind: String { case trust, trustRequest, loosenLimits, withdraw, connectAgent }
  public let id: String, kind: Kind, serverId: String, titleZh: String, bodyZh: String
}

/// Which approvals are new since the last poll (for local notifications). Pure, so it is unit-tested.
public enum ApprovalDiff {
  public static func newOnes(previous: Set<String>, current: [Approval]) -> [Approval] { current.filter { !previous.contains($0.id) } }
}

/// Stable sheet identities for agent sheets (derived from server ids, never random), so periodic refreshes can't re-present a sheet.
public enum SheetIdentity {
  public static func result(_ r: JSONValue) -> String { "result:" + (r["keyId"]?.string ?? r["id"]?.string ?? "") }
  public static func manage(_ key: JSONValue) -> String { "manage:" + (key["id"]?.string ?? "") }
}

/// One pending agent trust request (kit/server.mjs state.trustRequests.pending). merchantName / reason are written by the AI: UNVERIFIED.
public struct TrustRequest: Identifiable, Equatable, Hashable {
  public let id: String, status: String, payee: String, chain: String, chainId: Int, single: Int64, total: Int64, expiresInDays: Int
  public let merchantName: String, reason: String, requestedBy: [String]
  public init?(_ j: JSONValue) {
    guard let id = j["id"]?.string, let payee = j["payee"]?.string else { return nil }
    self.id = id; self.payee = payee; status = j["status"]?.string ?? "awaiting_owner"; chain = j["chain"]?.string ?? ""
    chainId = Int(j["chainId"]?.atomic ?? 0); single = j["single"]?.atomic ?? 0; total = j["total"]?.atomic ?? 0
    expiresInDays = Int(j["expiresInDays"]?.atomic ?? 90); merchantName = j["merchantName"]?.string ?? ""; reason = j["reason"]?.string ?? ""
    requestedBy = j["requestedBy"]?.array.compactMap { $0.string } ?? []
  }
  public var chainLabel: String { chainId == 8453 ? "Base" : chainId == 84532 ? "Base Sepolia (TEST)" : chain }
}
