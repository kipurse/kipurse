import Foundation

/// t1266 (fix 1): the phone parses the allowance text it signs (gateway mandates.mjs proposalText / askText) and builds the card lines
/// from THAT text, never from the server's separate "human" lines. Format (byte-exact, one field per line):
///   Kipurse allowance approval v1
///   wallet:<lowercase wallet>
///   id:<proposal id>
///   items:<JSON.stringify(normalized items)>
///   [chain:<chainId>\ntoken:<lowercase token>]   (t1181u scope)
///   [mode:trust|once]                             (askText only)
/// Anything else (extra / missing / reordered lines, another wallet or id, another network or token) -> nil = refuse.
public enum AllowanceText {
  public static let header = "Kipurse allowance approval v1"
  public struct Parsed {
    public let wallet: String, id: String
    public let items: [[String: Any]]
    public let chainId: Int?, token: String?, mode: String?
  }
  /// Parse a sign text. `mode` lines are only accepted when `allowMode` (the ask card's per-choice text).
  public static func parse(_ text: String, allowMode: Bool = false) -> Parsed? {
    let lines = text.components(separatedBy: "\n")
    guard lines.count >= 4, lines[0] == header, lines[1].hasPrefix("wallet:"), lines[2].hasPrefix("id:"), lines[3].hasPrefix("items:") else { return nil }
    let wallet = String(lines[1].dropFirst(7)), id = String(lines[2].dropFirst(3)), json = String(lines[3].dropFirst(6))
    guard wallet == wallet.lowercased(), BatchVerify.addrBytes(wallet) != nil, !id.isEmpty, id.count <= 80, !id.contains(where: { $0.isWhitespace }) else { return nil }
    guard let d = json.data(using: .utf8), let arr = (try? JSONSerialization.jsonObject(with: d)) as? [Any], !arr.isEmpty, arr.count <= 12 else { return nil }
    var items = [[String: Any]]()
    for x in arr { guard let o = x as? [String: Any] else { return nil }; items.append(o) }
    var rest = Array(lines.dropFirst(4)); var chain: Int? = nil, token: String? = nil, mode: String? = nil
    if rest.count >= 2, rest[0].hasPrefix("chain:"), rest[1].hasPrefix("token:") {
      guard let c = Int(rest[0].dropFirst(6)), c > 0 else { return nil }
      let t = String(rest[1].dropFirst(6)); guard t == t.lowercased(), BatchVerify.addrBytes(t) != nil else { return nil }
      chain = c; token = t; rest.removeFirst(2)
    }
    if allowMode, rest.count == 1, rest[0].hasPrefix("mode:") { mode = String(rest[0].dropFirst(5)); guard OwnerAsk.modes.contains(mode!) else { return nil }; rest.removeFirst() }
    guard rest.isEmpty else { return nil }
    return Parsed(wallet: wallet, id: id, items: items, chainId: chain, token: token, mode: mode)
  }
  /// The text is for THIS wallet + this request id, and (when scoped) for USDC on Base.
  public static func problems(_ p: Parsed, wallet: String, id: String) -> [String] {
    var out = [String]()
    if wallet.isEmpty || p.wallet != wallet.lowercased() { out.append("not this wallet") }
    if p.id != id { out.append("not this request") }
    if let c = p.chainId, String(c) != PhoneTrust.chainId { out.append("not Base") }
    if let t = p.token, t != RequestVerify.usdc.lowercased() { out.append("not USDC") }
    if (p.chainId == nil) != (p.token == nil) { out.append("bad scope") }
    for i in p.items where !knownKinds.contains(s(i["kind"])) { out.append("unknown item kind"); break }
    return out
  }
  static let knownKinds: Set<String> = ["agent_limits", "allowance", "recurring", "one_off"]

  // MARK: values
  static func s(_ v: Any?) -> String { if let x = v as? String { return x }; if let n = v as? NSNumber { return n.stringValue }; return "" }
  static func atomic(_ v: Any?) -> Int64? { let t = s(v); guard !t.isEmpty, t.allSatisfy({ $0.isASCII && $0.isNumber }), t.count <= 18 else { return nil }; return Int64(t) }
  static func usdc(_ v: Any?) -> String { atomic(v).map(AnswerRules.format) ?? "?" }
  static func short(_ a: String) -> String { a.count > 12 ? String(a.prefix(6)) + "…" + String(a.suffix(4)) : a }
  static func name(_ v: Any?) -> String? { let t = DisplaySafe.merchant(s(v), max: 40); return t.isEmpty ? nil : t }

  // MARK: lines shown on the card (what is signed, nothing else)
  /// One line per signed item. `payeeSwap` (a warning only) may come from the server: it can only add caution.
  public static func lines(_ p: Parsed, payeeSwap: Bool = false) -> [String] { p.items.map { line($0, payeeSwap: payeeSwap) } }
  static func purposeName(_ k: String) -> (String, String) {
    switch k { case "daily": return ("日常", "Everyday"); case "study": return ("学习", "Study"); case "promo": return ("宣传推广", "Promotion"); case "dev": return ("开发", "Development")
    case "work": return ("工作", "Work"); case "subscription": return ("订阅续费", "Subscriptions"); case "transfer": return ("转账给熟人", "Friends & family")
    case "all": return ("AI 付款上限", "AI payment limit"); default: return ("其他", "Other") }
  }
  static func line(_ i: [String: Any], payeeSwap: Bool) -> String {
    let kind = s(i["kind"])
    let (pz, pe) = purposeName(s(i["purpose"]))
    switch kind {
    case "agent_limits":
      let who = name(i["agentId"]) ?? "AI"
      let sg = i["single"].flatMap { atomic($0) }.map(AnswerRules.format)
      let dz = atomic(i["daily"]).map(AnswerRules.format), mz = atomic(i["monthly"]).map(AnswerRules.format)
      let resume = (i["resume"] as? Bool) == true
      return T("\(who)：\(sg.map { "每笔最多 \($0)，" } ?? "")每天最多 \(dz ?? "不限")，每月最多 \(mz ?? "不限") USDC\(resume ? "，并恢复付款" : "")",
               "\(who): \(sg.map { "up to \($0) per payment, " } ?? "")up to \(dz ?? "no limit") a day, \(mz ?? "no limit") a month\(resume ? ", payments back on" : "")")
    case "recurring":
      let r = i["recurring"] as? [String: Any] ?? [:]
      let every = s(r["every"]), ez = ["day": "天", "week": "周", "month": "月", "year": "年"][every] ?? "月"
      let pa = s(r["payee"]), nm = name(r["name"])
      return T("\(pz)：每\(ez)自动付 \(short(pa))\(nm.map { "（AI 说是“\($0)”，未核实）" } ?? "")，最多 \(usdc(r["amount"])) USDC；涨价或换收款方会再问你",
               "\(pe): pay \(short(pa))\(nm.map { " (the AI calls it \"\($0)\", not verified)" } ?? "") up to \(usdc(r["amount"])) USDC every \(every.isEmpty ? "month" : every); a higher price or another payee asks you again")
    case "one_off":
      let o = i["oneOff"] as? [String: Any] ?? [:]
      let pa = s(o["payee"]).isEmpty ? ((i["payees"] as? [String])?.first ?? "") : s(o["payee"])
      let target = pa.isEmpty ? (name(o["host"]) ?? "?") : short(pa)
      let ai = name(o["aiName"]).map { T("。AI 说它是“\($0)”，未核实", ". The AI calls it \"\($0)\" (not verified)") } ?? ""
      let swap = payeeSwap ? T("。注意：你以前批准的同名收款方不是这个地址，可能是冒充", ". Warning: the payee with this name you approved before has a DIFFERENT address, this may be an impostor") : ""
      let note = name(o["note"])
      if (o["dup"] as? Bool) == true {   // t1280 (§6#140): suspected duplicate purchase - the flag is in the signed text
        return T("⚠️ 疑似重复购买：10 分钟内已经给 \(target) 付过同样的 \(usdc(i["single"])) USDC（\(note.map { "用途：\($0)" } ?? pz)）。这次还没付，确实要再买一次才点「再付一次」",
                 "⚠️ Possible duplicate: \(usdc(i["single"])) USDC already went to \(target) in the last 10 minutes (\(note.map { "for: \($0)" } ?? pe)). Nothing has been paid for this one; tap \"Pay again\" only if you really want a second one")
      }
      return T("⚠️ 新收款方 \(target)，付 \(usdc(i["single"])) USDC（\(note.map { "用途：\($0)" } ?? pz)）。AI 可能被骗，确认是你要付的人再批准", "⚠️ NEW payee \(target), \(usdc(i["single"])) USDC (\(note.map { "for: \($0)" } ?? pe)). The AI could be tricked: approve only if you mean to pay them") + ai + swap
    default:
      if s(i["purpose"]) == "all" {
        return T("AI 付款上限：每笔最多 \(usdc(i["single"]))，每天 \(usdc(i["daily"]))，总额 \(usdc(i["monthly"])) USDC", "AI payment limit: up to \(usdc(i["single"])) per payment, \(usdc(i["daily"])) a day, \(usdc(i["monthly"])) total (USDC)")
      }
      let payees = (i["payees"] as? [String] ?? []).map(short), hosts = (i["hosts"] as? [String] ?? []).compactMap { name($0) }
      let only = (payees + hosts).isEmpty ? "" : T("，只限 ", ", only ") + (payees + hosts).joined(separator: T("、", ", "))
      return T("\(pz)：每笔最多 \(usdc(i["single"]))，每天 \(usdc(i["daily"]))，每月 \(usdc(i["monthly"])) USDC", "\(pe): up to \(usdc(i["single"])) per payment, \(usdc(i["daily"])) a day, \(usdc(i["monthly"])) a month USDC") + only
    }
  }

  // MARK: t1281 (handbook §6#141 ③): the signed-but-hidden terms, shown under the card lines
  /// One extra row on an approval card. `id` is the row kind: site / payee / replaces / remember / expires (UI id allow.detail.<id>).
  public struct Detail: Equatable { public let id: String, zh: String, en: String
    public init(id: String, zh: String, en: String) { self.id = id; self.zh = zh; self.en = en } }
  /// Built ONLY from the signed items (the same parsed text the card lines come from), never from server free text:
  /// - site: hosts[] (recurring / allowance) and oneOff.host even when a payee is named. The gateway (mandates.mjs match) counts a host hit
  ///   for ANY payee on that site, so the row says so.
  /// - payee: every full payee address (recurring.payee, oneOff.payee, payees[]), grouped in 4s like the new-payee card.
  /// - replaces: the earlier approval this one replaces. remember: one-off with a payee (owner_payee on approval). expires: expiresInDays.
  /// A new-payee ask card (oneOff.ask) gets none: it pays one payment only (no grant is made from these fields) and its own rows already
  /// show the full address; agent_limits items have none of these fields.
  public static func details(_ p: Parsed) -> [Detail] {
    var out = [Detail]()
    for i in p.items {
      let kind = s(i["kind"])
      guard ["recurring", "one_off", "allowance"].contains(kind) else { continue }
      let o = i["oneOff"] as? [String: Any], r = i["recurring"] as? [String: Any]
      if (o?["ask"] as? Bool) == true { continue }
      // payees named in the signed item (lowercase, valid addresses only, no repeats)
      var payees = [String]()
      for a in [s(r?["payee"]), s(o?["payee"])] + ((i["payees"] as? [Any]) ?? []).map({ s($0) }) {
        let x = a.lowercased(); if BatchVerify.addrBytes(x) != nil, !payees.contains(x) { payees.append(x) } }
      var hosts = [String]()
      for h in ((i["hosts"] as? [Any]) ?? []).map({ s($0) }) + [s(o?["host"])] { let x = h.lowercased(); if isHost(x), !hosts.contains(x) { hosts.append(x) } }
      for a in payees { out.append(Detail(id: "payee", zh: "收款地址：" + OwnerAsk.grouped(a), en: "Payee address: " + OwnerAsk.grouped(a))) }
      for h in hosts {
        let also = payees.isEmpty ? ("", "") : ("（不只上面的收款地址）", " (not only the payee address above)")
        out.append(Detail(id: "site", zh: "按网站：只要是 \(h) 上的收款方都算\(also.0)", en: "By site: any payee on \(h) counts\(also.1)"))
      }
      let rep = s(i["replaces"])
      if !rep.isEmpty, !(i["replaces"] is NSNull) {
        let safe = rep.count <= 40 && rep.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
        out.append(Detail(id: "replaces", zh: "会替换你之前批准的一项" + (safe ? "（\(short(rep))）" : ""), en: "Replaces one you approved before" + (safe ? " (\(short(rep)))" : "")))
      }
      if kind == "one_off", let o, !s(o["payee"]).isEmpty, let rem = o["remember"] as? Bool {
        out.append(rem ? Detail(id: "remember", zh: "批准后记住这个收款方，以后它不算新收款方", en: "After approval this payee is remembered and no longer counts as new")
                       : Detail(id: "remember", zh: "不记住这个收款方，只付这一次", en: "This payee is not remembered: this payment only"))
      }
      // t1281 review: approving a recurring item / an allowance with payees also remembers those payees as yours (gateway mandates
      // approve inserts owner_payee) - say so; and a plain overall limit replaces the current one (ONE LIMIT)
      if (kind == "recurring" && !s(r?["payee"]).isEmpty) || (kind == "allowance" && !payees.isEmpty) {
        out.append(Detail(id: "remember", zh: "批准后记住这些收款方，以后它们不算新收款方", en: "After approval these payees are remembered and no longer count as new"))
      }
      if kind == "allowance", payees.isEmpty, hosts.isEmpty, ((i["agents"] as? [Any]) ?? []).isEmpty {
        out.append(Detail(id: "overall", zh: "批准后会代替你现在的 AI 花钱总上限", en: "After approval this replaces your current overall AI spending limit"))
      }
      if let v = validity(i["expiresInDays"]) {
        out.append(kind == "one_off" ? Detail(id: "expires", zh: "只能用一次，\(v.zh)内有效", en: "Single use, valid for \(v.en)")
                                     : Detail(id: "expires", zh: "有效 \(v.zh)", en: "Valid for \(v.en)"))
      }
    }
    return out
  }
  /// a host as the gateway normalizes it (/^[a-z0-9.-]{3,253}$/ after lowercasing)
  static func isHost(_ h: String) -> Bool { h.count >= 3 && h.count <= 253 && h.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "." || $0 == "-") } }
  /// expiresInDays (gateway: 1/24 ... 366) -> "90 天" / "90 days"; under a day in hours. Anything else -> nil (row not shown).
  static func validity(_ v: Any?) -> (zh: String, en: String)? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let d = n.doubleValue; guard d.isFinite, d > 0, d <= 366 else { return nil }
    if d >= 1 { let k = Int(d.rounded()); return ("\(k) 天", k == 1 ? "1 day" : "\(k) days") }
    let h = max(1, Int((d * 24).rounded())); return ("\(h) 小时", h == 1 ? "1 hour" : "\(h) hours")
  }

  // MARK: the new-payee card
  /// The server's ask summary (payee + amount) must be exactly the ONE signed one-off ask item.
  /// t1280: the signed one-off ask is a suspected duplicate (only "pay again" / decline are offered).
  public static func askIsDup(_ p: Parsed) -> Bool { ((p.items.first?["oneOff"] as? [String: Any])?["dup"] as? Bool) == true }
  public static func askMatches(_ p: Parsed, payee: String, amount: String) -> Bool {
    guard p.items.count == 1, let i = p.items.first, s(i["kind"]) == "one_off", let o = i["oneOff"] as? [String: Any], (o["ask"] as? Bool) == true else { return false }
    return s(o["payee"]).lowercased() == payee.lowercased() && !payee.isEmpty && atomic(i["single"]).map(String.init) == amount
  }

  // MARK: drafts the owner typed
  /// Every signed field must equal what the owner typed (AgentLimits.item drafts). Unknown kinds or extra fields -> false.
  public static func draftMatches(_ p: Parsed, typed: [[String: Any]]) -> Bool {
    guard p.items.count == typed.count, !typed.isEmpty else { return false }
    for (sg, ty) in zip(p.items, typed) {
      guard s(ty["kind"]) == "agent_limits", s(sg["kind"]) == "agent_limits" else { return false }
      guard Set(sg.keys).isSubset(of: ["kind", "agentId", "daily", "monthly", "single", "resume"]) else { return false }
      guard s(sg["agentId"]) == s(ty["agentId"]), !s(ty["agentId"]).isEmpty else { return false }
      func typedAtomic(_ k: String) -> Int64?? { guard let v = ty[k] else { return .some(nil) }; guard let a = AgentLimits.atomic(s(v)) else { return .none }; return .some(a) }
      func signedAtomic(_ k: String) -> Int64?? { guard let v = sg[k], !(v is NSNull) else { return .some(nil) }; guard let a = atomic(v) else { return .none }; return .some(a) }
      for k in ["single", "daily", "monthly"] {
        guard let t = typedAtomic(k), let g = signedAtomic(k), t == g else { return false }
      }
      let tr = (ty["resume"] as? Bool) ?? false, gr = (sg["resume"] as? Bool) ?? false
      guard tr == gr else { return false }
    }
    return true
  }
}
