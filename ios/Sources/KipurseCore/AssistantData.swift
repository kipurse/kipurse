import Foundation

/// What Siri / Apple Intelligence / Spotlight may know about the wallet (pure, open source, unit-tested).
/// Rules: only SAVED payees (already paid, or the owner's own Coinbase wallet); entity ids are salted hashes, never addresses;
/// display text carries a nickname and the last 4 characters only; balances are never part of any indexed value.
public enum AssistantData {
  public struct Payee: Equatable, Codable, Hashable {
    public let id: String          // "p_" + salted hash (stable per install; the address never leaves the app as an id)
    public let address: String     // kept in memory / local cache only; never indexed, never spoken
    public let label: String       // nickname > "我的 Coinbase 钱包" > merchant name > "收款方"
    public let last4: String
    public let isOwner: Bool
    public var display: String { "\(label) …\(last4)" }
    public init(id: String, address: String, label: String, last4: String, isOwner: Bool) { self.id = id; self.address = address; self.label = label; self.last4 = last4; self.isOwner = isOwner }
  }
  public struct Payment: Equatable, Codable, Hashable {
    public let id: String          // "y_" + salted hash of purchaseKey/txHash
    public let payeeId: String, payeeLabel: String, last4: String
    public let amount: Int64, date: Date?, settled: Bool
    public let txHash: String?     // local only (view annotation lookup); never indexed
    public var title: String { "\(AnswerRules.format(amount)) USDC → \(payeeLabel) …\(last4)" }
  }
  public static let ownerLabelZh = "我的 Coinbase 钱包", ownerLabelEn = "My Coinbase wallet"  // i18n-ok: paired zh/en or zh-only data

  public static func isAddress(_ s: String) -> Bool { s.count == 42 && s.hasPrefix("0x") && s.dropFirst(2).allSatisfy(\.isHexDigit) }
  public static func last4(_ a: String) -> String { String(a.suffix(4)) }
  public static func opaqueId(_ prefix: String, _ value: String, salt: String) -> String {
    prefix + Hex.encode(Array(Keccak.hash(salt + "|" + value.lowercased()).prefix(10))).dropFirst(2)
  }

  /// Saved payees: the owner's own account first (always payable by the owner), then every address the wallet paid before.
  public static func payees(_ s: WalletState?, owner: String?, nicknames: [String: String], salt: String, zh: Bool = true) -> [Payee] {
    var seen = Set<String>(), out: [Payee] = []
    func add(_ a: String, _ name: String?, own: Bool) {
      let k = a.lowercased(); guard isAddress(a), !seen.contains(k) else { return }; seen.insert(k)
      let nick = nicknames[k].flatMap(validNickname)
      let label = nick ?? (own ? (zh ? ownerLabelZh : ownerLabelEn) : (name.flatMap(safeName) ?? (zh ? "收款方" : "Payee")))
      out.append(Payee(id: opaqueId("p_", a, salt: salt), address: a, label: label, last4: last4(a), isOwner: own))
    }
    if let o = owner { add(o, nil, own: true) }
    for p in s?.purchases ?? [] { if let a = p["payee"]?.string { add(a, p["merchantName"]?.string ?? p["merchant"]?.string, own: a.lowercased() == owner?.lowercased()) } }
    return out
  }
  public static func payments(_ s: WalletState?, payees: [Payee], salt: String, limit: Int = 20) -> [Payment] {
    let byAddr = Dictionary(payees.map { ($0.address.lowercased(), $0) }, uniquingKeysWith: { a, _ in a })
    var out: [Payment] = []
    for (i, p) in (s?.purchases ?? []).enumerated() {
      guard let a = p["payee"]?.string, let pe = byAddr[a.lowercased()], let amt = p["amount"]?.atomic, amt > 0 else { continue }
      let key = p["purchaseKey"]?.string ?? p["txHash"]?.string ?? "\(i)"
      let st = (p["state"]?.string ?? "").lowercased()
      out.append(Payment(id: opaqueId("y_", key, salt: salt), payeeId: pe.id, payeeLabel: pe.label, last4: pe.last4, amount: amt, date: date(p["createdAt"]),
                         settled: ["settled", "paid", "confirmed", "done"].contains(st), txHash: p["txHash"]?.string))
    }
    out.sort { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    return Array(out.prefix(limit))
  }
  /// "repeat my last payment": newest settled payment to a still-saved payee.
  public static func lastRepeatable(_ p: [Payment]) -> Payment? { p.first { $0.settled } }

  /// Siri text -> saved payees. Untrusted: matches only labels / last 4; a pasted address only matches an already-saved payee.
  public static func match(_ q: String, _ list: [Payee]) -> [Payee] {
    let s = q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(); guard !s.isEmpty, s.count <= 64 else { return [] }
    if isAddress(s) { return list.filter { $0.address.lowercased() == s } }
    if ["我", "我自己", "自己", "我的", "me", "myself", "my account", "my base", "base account", "我的账户", "我的钱包"].contains(where: { s == $0 || (s.count > 2 && $0.count > 2 && s.contains($0)) }) {  // i18n-ok: paired zh/en or zh-only data
      let o = list.filter(\.isOwner); if !o.isEmpty { return o } }
    let tail = s.hasPrefix("…") || s.hasPrefix("...") ? String(s.drop { $0 == "…" || $0 == "." }) : s
    let direct = list.filter { $0.label.lowercased().contains(s) || s.contains($0.label.lowercased()) || (tail.count == 4 && $0.last4.lowercased() == tail) }
    if !direct.isEmpty { return direct }
    // t952 A3: nickname / fuzzy match — filler words dropped, then pinyin (with or without tones) or pinyin initials ("xw" -> 小王).
    let q = fuzzyKey(s); guard q.count >= 2 else { return [] }
    return list.filter { p in let k = fuzzyKey(p.label.lowercased()); guard !k.isEmpty else { return false }
      return k.contains(q) || q.contains(k) || pinyin(p.label) == pinyin(q) || (q.allSatisfy(\.isASCII) && (pinyin(p.label).contains(q) || initials(p.label) == q)) }
  }
  static let fillers = ["付给", "转给", "打给", "付钱给", "给", "付", "转", "的", "那个", "pay ", "to ", "the "]  // i18n-ok: zh-only data
  /// Lowercased, filler words, spaces and punctuation removed.
  public static func fuzzyKey(_ raw: String) -> String {
    var s = raw.lowercased(); for f in fillers { s = s.replacingOccurrences(of: f, with: "") }
    return String(s.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(Character.init))
  }
  /// Toneless pinyin, no spaces ("小王" -> "xiaowang"); ASCII passes through.
  public static func pinyin(_ raw: String) -> String {
    let m = NSMutableString(string: fuzzyKey(raw)); CFStringTransform(m, nil, kCFStringTransformToLatin, false); CFStringTransform(m, nil, kCFStringTransformStripDiacritics, false)
    return (m as String).lowercased().replacingOccurrences(of: " ", with: "")
  }
  /// Pinyin initials ("小王" -> "xw").
  public static func initials(_ raw: String) -> String {
    let m = NSMutableString(string: fuzzyKey(raw)); CFStringTransform(m, nil, kCFStringTransformToLatin, false); CFStringTransform(m, nil, kCFStringTransformStripDiacritics, false)
    return (m as String).lowercased().split(separator: " ").compactMap(\.first).map(String.init).joined()
  }
  /// Nickname the owner chose (Siri may set it, still untrusted): 1–24 visible chars, no addresses / long hex, no control chars.
  public static func validNickname(_ raw: String) -> String? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (1...24).contains(s.count), !s.contains("0x"), s.range(of: "[0-9a-fA-F]{8,}", options: .regularExpression) == nil,
          !s.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || CharacterSet.newlines.contains($0) }) else { return nil }
    return s
  }
  /// Merchant names come from AI agents (unverified): shorten, and never let them carry an address.
  static func safeName(_ n: String) -> String? { validNickname(String(n.prefix(24))) }

  /// Everything a Spotlight item may contain. Tests assert no address, no balance.
  public static func indexText(_ p: Payee) -> [String] { [p.label, "…" + p.last4, "Kipurse"] + [pinyin(p.label), initials(p.label)].filter { !$0.isEmpty && $0 != p.label.lowercased() } }
  public static func indexText(_ p: Payment) -> [String] { [p.title, "Kipurse"] }

  public enum PayCheck: Equatable { case ok(Payee, Int64), unknownPayee, badAmount, problem(String) }
  /// The same checks as the app; the server and the chain still enforce the caps on top.
  public static func checkPay(payeeId: String, amount: Double, payees: [Payee], state: WalletState?, zh: Bool = true) -> PayCheck {
    guard let p = payees.first(where: { $0.id == payeeId }) else { return .unknownPayee }
    guard let a = SiriAnswers.atomic(amount), a >= 10_000 else { return .badAmount }   // ≥ 0.01 USDC
    if let s = state, let e = SiriAnswers.payProblem(a, s, zh: zh) { return .problem(e) }
    return .ok(p, a)
  }
  static func date(_ v: JSONValue?) -> Date? {
    switch v {
    case .number(let n)?: return Date(timeIntervalSince1970: n > 1e12 ? n / 1000 : n)
    case .string(let s)?: if let n = Double(s) { return date(.number(n)) }; return ISO8601DateFormatter().date(from: s)
    default: return nil
    }
  }
}
