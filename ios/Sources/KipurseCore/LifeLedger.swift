import Foundation

/// t665 "[zh]": auto-categorised life ledger + per-agent live state. Pure logic, no network, no money movement.
public enum LifeCategory: String, CaseIterable, Codable, Sendable {
  case dining, travel, subscription, shopping, tools, other
  public var zh: String { ["dining": "餐饮", "travel": "出行", "subscription": "订阅", "shopping": "购物", "tools": "工具", "other": "其他"][rawValue]! }  // i18n-ok: paired zh/en
  public var en: String { ["dining": "Food", "travel": "Travel", "subscription": "Subscriptions", "shopping": "Shopping", "tools": "Tools", "other": "Other"][rawValue]! }
  public var symbol: String { ["dining": "fork.knife", "travel": "car.fill", "subscription": "play.rectangle.fill", "shopping": "bag.fill", "tools": "wrench.and.screwdriver.fill", "other": "square.grid.2x2.fill"][rawValue]! }
  /// Original palette (hex), no brand colours.
  public var hex: UInt32 { ["dining": 0xFF9F0A, "travel": 0x2DD4BF, "subscription": 0xBF5AF2, "shopping": 0xFF375F, "tools": 0x0A84FF, "other": 0x8E8E93][rawValue]! }

  // Order matters: tools before shopping ("Example Shop — VPS" is a tool), subscription before tools.
  static let rules: [(LifeCategory, [String])] = [
    (.dining, ["restaurant", "cafe", "café", "coffee", "food", "ramen", "noodle", "pizza", "burger", "sushi", "kitchen", "bakery", "bistro", "deli", "grill", "tea", "lunch", "dinner", "breakfast", "delivery", "eats", "takeout", "餐", "面", "饭", "咖啡", "外卖", "茶", "食"]),
    (.travel, ["uber", "lyft", "ride", "taxi", "cab", "airline", "flight", "air ", "hotel", "train", "rail", "metro", "transit", "parking", "fuel", "gas station", "bike", "scooter", "booking", "trip", "hostel", "travel", "出行", "旅行", "民宿", "车票", "打车", "机票", "酒店", "高铁", "地铁", "停车"]),
    (.subscription, ["subscription", "subscribe", "monthly", "membership", "premium", "music", "stream", "video", "sound", "radio", "podcast", "news", "订阅", "会员", "月费", "年费"]),
    (.tools, ["vps", "api", "cloud", "server", "hosting", "domain", "gpu", "compute", "token", "credits", "saas", "dev", "software", "storage", "database", "proxy", "工具", "云", "服务器", "域名", "算力"]),
    (.shopping, ["store", "shop", "market", "mall", "outlet", "boutique", "goods", "buy", "book", "textbook", "bookstore", "购物", "教材", "课本", "书店", "书", "商店", "商城", "超市"]),
  ]

  /// Classify one payment. An explicit server/agent category wins; else keywords from merchant name + reason.
  public static func classify(merchant: String?, reason: String? = nil, explicit: String? = nil) -> LifeCategory {
    if let e = explicit?.lowercased(), let c = LifeCategory(rawValue: e) { return c }
    let text = " " + [reason ?? "", merchant ?? ""].joined(separator: " ").lowercased() + " "
    // reason first: it says what was bought; then merchant
    for part in [" " + (reason ?? "").lowercased() + " ", text] where part.trimmingCharacters(in: .whitespaces) != "" {
      let words = camelWords(part == text ? [reason ?? "", merchant ?? ""].joined(separator: " ") : (reason ?? ""))
      for (c, keys) in rules where keys.contains(where: { k in matches(k, part, words) }) { return c }
    }
    return .other
  }
  /// t690: English keys match at a word start ("tea" no longer hits "team"/"steam", "air " no longer hits "repair", "api" not "rapid",
  /// "cab" not "vocabulary"); multi-word and CJK keys match as substrings.
  /// ASCII words, also split at camel-case humps ("CityRide" -> city, ride), lowercased.
  static func camelWords(_ raw: String) -> [String] {
    var out: [String] = [], cur = "", prevLower = false
    for ch in raw {
      if ch.isASCII && (ch.isLetter || ch.isNumber) {
        if ch.isUppercase && prevLower && !cur.isEmpty { out.append(cur.lowercased()); cur = "" }
        cur.append(ch); prevLower = ch.isLowercase
      } else { if !cur.isEmpty { out.append(cur.lowercased()) }; cur = ""; prevLower = false }
    }
    if !cur.isEmpty { out.append(cur.lowercased()) }
    return out
  }
  static func matches(_ k: String, _ text: String, _ words: [String]) -> Bool {
    let key = k.trimmingCharacters(in: .whitespaces)
    if key.contains(" ") || !key.allSatisfy(\.isASCII) { return text.contains(k) }
    return words.contains { $0.hasPrefix(key) }
  }
}

public struct LifeItem: Equatable, Sendable {
  public let amount: Int64; public let date: Date?; public let failed: Bool; public let category: LifeCategory
  public init(amount: Int64, date: Date?, failed: Bool, category: LifeCategory) { self.amount = amount; self.date = date; self.failed = failed; self.category = category }
}

public enum LifeLedger {
  /// Totals per category for the calendar month containing `now` (failed payments excluded), biggest first, zeros dropped.
  public static func monthTotals(_ items: [LifeItem], now: Date, calendar: Calendar = .current) -> [(LifeCategory, Int64)] {
    var t: [LifeCategory: Int64] = [:]
    for i in items where !i.failed { guard let d = i.date, calendar.isDate(d, equalTo: now, toGranularity: .month) else { continue }; t[i.category, default: 0] += i.amount }
    return LifeCategory.allCases.compactMap { c in t[c].flatMap { $0 > 0 ? (c, $0) : nil } }.sorted { $0.1 > $1.1 }
  }
  /// Ring segments as (category, start, end) fractions 0…1.
  public static func ring(_ totals: [(LifeCategory, Int64)]) -> [(LifeCategory, Double, Double)] {
    let sum = Double(totals.reduce(0) { $0 + $1.1 }); guard sum > 0 else { return [] }
    var a = 0.0; return totals.map { c, v in let b = a + Double(v) / sum; defer { a = b }; return (c, a, b) }
  }
}

/// What an agent's orb shows. Derived only from real agent data (connected / paused flags, pending payments, last use).
/// t1157: which live agent row a home character (Muse / Grok / Claude / Siri) shows. An exact id/kind match ("siri") beats a name that
/// merely contains it ("oauth-siri"), and a connected row beats a not-connected one. Revoked rows never count.
public enum AgentMatch {
  public static func pick(_ agents: [JSONValue], name: String) -> JSONValue? {
    let key = name.lowercased()
    // t1164: "oauth-siri" is the empty first-connect record the server hides since t1157 (stateAgents skips it); never match it.
    let live = agents.filter { !($0["revoked"]?.bool ?? false) && ($0["id"]?.string ?? "").lowercased() != "oauth-siri" }
    let hits = live.filter { a in [a["id"]?.string, a["kind"]?.string, a["name"]?.string].compactMap { $0?.lowercased() }.contains { $0.contains(key) } }
    let exact = hits.filter { a in [a["id"]?.string, a["kind"]?.string].compactMap { $0?.lowercased() }.contains(key) }
    // t1161 (decision 78): one AI can have several rows (an old key "grok" and the OAuth "grok-bot"; "oauth-claude-desktop" and a "claude" key).
    // The bead follows the row the AI is really using. t1164 (decision 79, connected = always lit): a connected row always beats a
    // disconnected one (an old disconnected duplicate must not make a connected AI look [zh]); among connected rows the most
    // recent real call (lastUsed) wins; then exact id/kind (t1157).
    func rank(_ a: JSONValue) -> (Int, Double, Int) {
      let on = a["connected"]?.bool == true
      return (on ? 1 : 0, on ? (lastUsed(a["lastUsed"])?.timeIntervalSince1970 ?? -1) : -1,
              exact.contains(where: { $0["id"]?.string == a["id"]?.string && $0["kind"]?.string == a["kind"]?.string }) ? 1 : 0)
    }
    return hits.enumerated().max { l, r in let x = rank(l.element), y = rank(r.element); return x != y ? x < y : l.offset > r.offset }?.element
  }
  /// Server lastUsed: ISO-8601 with or without fractional seconds (JS toISOString), or epoch seconds / ms.
  public static func lastUsed(_ v: JSONValue?) -> Date? {
    switch v {
    case .number(let n)?: return Date(timeIntervalSince1970: n > 1e12 ? n / 1000 : n)
    case .string(let s)?:
      if let n = Double(s) { return lastUsed(.number(n)) }
      let f = ISO8601DateFormatter(); if let d = f.date(from: s) { return d }
      f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: s)
    default: return nil
    }
  }
}

public enum AgentPhase: String, Sendable { case online, paying, paused, idle, offline
  public var zh: String { ["online": "在线", "paying": "付款中", "paused": "已暂停", "idle": "已授权·未在线", "offline": "未连接"][rawValue]! }  // i18n-ok: paired zh/en
  public var en: String { ["online": "Online", "paying": "Paying", "paused": "Paused", "idle": "Authorized · idle", "offline": "Offline"][rawValue]! }   // t1245 U2: short enough for the four-column orb row
  /// t1245 (decision 115 U37): the ONE not-connected line for AI [zh] (same status word; the agents list adds how to finish).
  public static func offlineLine(unfinished: Bool) -> (zh: String, en: String) {
    unfinished ? ("未连接 · 还没连完，点“连接”继续", "Offline · tap Connect to finish") : ("未连接", "Offline")  // i18n-ok: paired zh/en
  }
  public static let payingWindow: TimeInterval = 90
  /// t878: [zh] (the AI may have disconnected on its side).
  public static let clockSkew: TimeInterval = 120   // t1161: tolerated server-ahead-of-phone clock difference
  public static let onlineWindow: TimeInterval = 300   // t915: 在线 = a real authenticated call (MCP / Siri API) in the last 5 min
  /// t690: lit = connected and working (online / paying). Only lit orbs animate; unlit orbs are fully static.
  /// t915: "[zh]" from the server's last-seen time; nil when the server never saw a call.
  public static func lastSeen(_ l: Date?, now: Date) -> (zh: String, en: String)? {
    guard let l else { return nil }; let s = max(0, now.timeIntervalSince(l))
    if s < 60 { return ("最近活动 刚刚", "Active just now") }  // i18n-ok: paired zh/en
    if s < 3600 { let m = Int(s / 60); return ("最近活动 \(m) 分钟前", "Active \(m) min ago") }  // i18n-ok: paired zh/en
    if s < 86400 { let h = Int(s / 3600); return ("最近活动 \(h) 小时前", "Active \(h) h ago") }  // i18n-ok: paired zh/en
    let d = Int(s / 86400); return ("最近活动 \(d) 天前", "Active \(d) d ago")  // i18n-ok: paired zh/en
  }
  public var isLit: Bool { self == .online || self == .paying }
  public func animates(reduceMotion: Bool) -> Bool { isLit && !reduceMotion }
  public static func derive(connected: Bool, paused: Bool, allPaused: Bool, pendingPayments: Int, lastUsed: Date?, now: Date) -> AgentPhase {
    if !connected { return .offline }
    if paused || allPaused { return .paused }
    if pendingPayments > 0 { return .paying }
    // t1161 (decision 78): a server clock a little ahead of the phone (lastUsed slightly "in the future") is still a call just now.
    // t1164 (decision 79, owner 2026-11-17 12:02 CT): no more [zh]·[zh] — a connected / authorized AI is always lit ([zh]) with the
    // existing online animation, whether or not it was used recently. lastUsed only feeds the "[zh]" text. Only a truly
    // disconnected / expired / revoked AI is [zh]. (.idle stays in the enum for old data but is never derived.)
    _ = lastUsed; _ = now
    return .online
  }
}

/// Short cheer line after a completed payment (rotates by payment id so it's stable per payment).
public enum Cheer {
  static let zh = ["搞定，又省心一次", "AI 帮你办好了", "完美成交", "这一笔，稳", "交给 AI，放心"]  // i18n-ok: paired zh/en
  static let en = ["Done — one less thing", "Your AI handled it", "Smooth payment", "Nailed it", "Handled for you"]
  public static func line(id: String, chinese: Bool) -> String { let i = abs(id.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }) % zh.count; return chinese ? zh[i] : en[i] }
}
