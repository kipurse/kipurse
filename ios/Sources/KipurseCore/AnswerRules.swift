// Swift port of src/v5/answer-rules.mjs (same rules, same plain-Chinese messages). Amounts are USDC base units (1 USDC = 1_000_000).
import Foundation

public enum AnswerRules {
  public static let termMinDays = 1, termMaxDays = 365            // KipurseAdapterV5: period <= 365 days
  public static let termPresets = [30, 90, 180, 365]
  public static let largeUSDC: Int64 = 100                         // warning only, never a block
  public static let usdcKeys = ["perPayment","perDay","termTotal","unrecognizedPerPayment","unrecognizedPerDay","depositDailyLimit"]
  public static let nameZh: [String:String] = ["termDays":L("授权天数"),"perPayment":L("每笔上限"),"perDay":L("每天上限"),"termTotal":L("整个期间上限"),
    "unrecognizedPerPayment":L("陌生收款方每笔上限"),"unrecognizedPerDay":L("陌生收款方每天上限"),"depositDailyLimit":L("每天充值上限"),"withdraw":L("提现金额")]

  /// "1.5" -> 1_500_000. Fullwidth digits OK. Only '.' (or 。．) is the decimal point. ',' '，' or a space may group thousands,
  /// but ONLY as strict 3-digit groups ("1,000" / "12,345.67" / "1 000 000"); "3,5" is rejected (never silently 35 or 3.5).
  public static func parseUSDC(_ raw: String) -> Int64? {
    var s = String(raw.trimmingCharacters(in: .whitespaces).map { c -> Character in
      if c == "。" || c == "．" { return "." }  // i18n-ok: paired zh/en or zh-only data
      if c == "，" || c == "\u{00A0}" || c == "\u{3000}" { return c == "，" ? "," : " " }  // i18n-ok: paired zh/en or zh-only data
      if let v = c.unicodeScalars.first?.value, (0xFF10...0xFF19).contains(v) { return Character(UnicodeScalar(v - 0xFEE0)!) }
      return c })
    if s.hasPrefix(".") { s = "0" + s }
    let parts = s.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count <= 2, var whole = parts.first.map(String.init), !whole.isEmpty else { return nil }
    if whole.contains(",") || whole.contains(" ") {
      let sep: Character = whole.contains(",") ? "," : " "
      if sep == "," && whole.contains(" ") { return nil }
      let g = whole.split(separator: sep, omittingEmptySubsequences: false)
      guard let first = g.first, (1...3).contains(first.count), g.dropFirst().allSatisfy({ $0.count == 3 }) else { return nil }
      whole = g.joined()
    }
    guard whole.count <= 12, whole.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
    var frac = parts.count == 2 ? String(parts[1]) : ""
    guard frac.count <= 6, frac.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
    frac = frac.padding(toLength: 6, withPad: "0", startingAt: 0)
    guard let w = Int64(whole), let f = Int64(frac) else { return nil }
    return w * 1_000_000 + f
  }
  /// Bad comma/space grouping (e.g. "3,5"): the clear hint to show instead of guessing.
  public static let badGroupingHint = "金额格式不对：小数点请用「.」，例如 3.5"  // i18n-ok: paired zh/en or zh-only data
  public static func looksMisgrouped(_ raw: String) -> Bool {
    let t = raw.trimmingCharacters(in: .whitespaces)
    return (t.contains(",") || t.contains("，") || t.contains(" ")) && parseUSDC(t) == nil  // i18n-ok: paired zh/en or zh-only data
  }

  public static func usdcError(_ key: String, _ raw: String?) -> String? {
    let n = nameZh[key] ?? key
    guard let raw = raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return L("\(n)：请填写一个数字") }
    let t = raw.trimmingCharacters(in: .whitespaces)
    if t.hasPrefix("-") { return L("\(n)：不能是负数") }  // i18n-ok: paired zh/en or zh-only data
    if let dot = t.replacingOccurrences(of: "。", with: ".").firstIndex(of: "."),  // i18n-ok: paired zh/en or zh-only data
       t.distance(from: dot, to: t.endIndex) - 1 > 6, t[t.index(after: dot)...].allSatisfy({ $0.isNumber || $0 == " " }) { return L("\(n)：USDC 最多 6 位小数") }
    if looksMisgrouped(t) { return L("\(n)：") + L(badGroupingHint) }
    guard let v = parseUSDC(t) else { return L("\(n)：请只填数字，比如 5 或 0.5") }
    if v <= 0 { return L("\(n)：必须大于 0") }
    return nil
  }

  public static func termError(_ raw: String?) -> String? {
    guard let s = raw?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return L("授权天数：请选一个或自己填天数") }
    guard s.allSatisfy({ $0.isASCII && $0.isNumber }), let d = Int(s) else { return L("授权天数：请填整数天，比如 60") }
    if d < termMinDays || d > termMaxDays { return L("授权天数：合约只允许 \(termMinDays) 到 \(termMaxDays) 天") }
    return nil
  }

  public struct Issue: Equatable { public let key: String; public let zh: String }
  public struct Result { public let errors: [Issue]; public let warnings: [String]; public let values: [String:Int64]; public var ok: Bool { errors.isEmpty } }

  /// Same as checkAnswersZh: field errors, ordering rules, large-amount warning. `partial` only checks filled answers.
  public static func check(_ a: [String:String], partial: Bool = false) -> Result {
    var errors: [Issue] = [], v: [String:Int64] = [:]
    func has(_ k: String) -> Bool { !(a[k]?.trimmingCharacters(in: .whitespaces).isEmpty ?? true) }
    if has("termDays") || !partial { if let e = termError(a["termDays"]) { errors.append(.init(key: "termDays", zh: e)) } else { v["termDays"] = Int64(a["termDays"]!.trimmingCharacters(in: .whitespaces)) } }
    for k in usdcKeys { if !has(k) && partial { continue }
      if let e = usdcError(k, a[k]) { errors.append(.init(key: k, zh: e)) } else { v[k] = parseUSDC(a[k]!) } }
    func le(_ x: String, _ y: String, _ key: String, _ zh: String) { if let a = v[x], let b = v[y], a > b { errors.append(.init(key: key, zh: zh)) } }
    le("perPayment","perDay","perPayment",L("每笔上限不能大于每天上限"))
    le("perDay","termTotal","perDay",L("每天上限不能大于整个期间上限"))
    le("unrecognizedPerPayment","perPayment","unrecognizedPerPayment",L("陌生收款方每笔上限不能大于每笔上限"))
    le("unrecognizedPerDay","perDay","unrecognizedPerDay",L("陌生收款方每天上限不能大于每天上限"))
    le("unrecognizedPerPayment","unrecognizedPerDay","unrecognizedPerPayment",L("陌生收款方每笔上限不能大于陌生收款方每天上限"))
    let big = usdcKeys.filter { (v[$0] ?? 0) > largeUSDC * 1_000_000 }.compactMap { nameZh[$0] }
    let warnings = big.isEmpty ? [] : [L("金额较大（\(big.joined(separator: "、")) 超过 \(largeUSDC) USDC）。AI 只能在你设的额度内花钱，建议先放少量试试。")]
    return Result(errors: errors, warnings: warnings, values: v)
  }

  /// Later limit changes (gateway keys) against current limits and the on-chain main caps (base units).
  public static func checkLimitChange(_ ch: [String:String], current: [String:Int64], mainSingle: Int64?, mainDaily: Int64?) -> Result {
    var errors: [Issue] = [], v: [String:Int64] = [:]
    for (k, x) in ch { if let e = usdcError(k, x) { errors.append(.init(key: k, zh: e)) } else { v[k] = parseUSDC(x) } }
    let m = current.merging(v) { $1 }
    if let s = mainSingle, let x = m["unrecognizedPerPayment"], x > s { errors.append(.init(key: "unrecognizedPerPayment", zh: L("陌生收款方每笔上限不能大于链上每笔上限（要更高需重新确认）"))) }
    if let d = mainDaily, let x = m["unrecognizedPerDay"], x > d { errors.append(.init(key: "unrecognizedPerDay", zh: L("陌生收款方每天上限不能大于链上每天上限（要更高需重新确认）"))) }
    if let p = m["unrecognizedPerPayment"], let d = m["unrecognizedPerDay"], p > d { errors.append(.init(key: "unrecognizedPerPayment", zh: L("陌生收款方每笔上限不能大于陌生收款方每天上限"))) }
    let warnings = v.values.contains { $0 > largeUSDC * 1_000_000 } ? [L("金额较大。AI 只能在你设的额度内花钱，建议先放少量试试。")] : []
    return Result(errors: errors, warnings: warnings, values: v)
  }

  /// ppm -> "0.1%" (t679).
  public static func percent(ppm: Int64) -> String { var t = String(format: "%.4f", Double(ppm) / 10_000); while t.hasSuffix("0") { t.removeLast() }; if t.hasSuffix(".") { t.removeLast() }; return t + "%" }
  /// Display with at least 2 decimals (18.5 -> "18.50", 14.10322 stays exact). Display only; parsing/limits use format().
  public static func format2(_ atomic: Int64) -> String {
    var t = format(atomic); guard !t.contains("e") else { return t }
    if let d = t.firstIndex(of: ".") { let n = t.distance(from: d, to: t.endIndex) - 1; if n < 2 { t += String(repeating: "0", count: 2 - n) } } else { t += ".00" }
    return t
  }
  /// t800 display only: plain whole amount for limits ("10", "12"); under 1 keeps 2 decimals.
  public static func plain(_ atomic: Int64) -> String { atomic >= 1_000_000 ? "\((atomic + 500_000) / 1_000_000)" : short(atomic) }
  /// t800 display only: at most 2 decimals, rounded ("14.10322" -> "14.10", "10" stays "10"); tiny non-zero -> "<0.01".
  public static func short(_ atomic: Int64) -> String {
    if atomic % 1_000_000 == 0 { return format(atomic) }
    if atomic > 0 && atomic < 5_000 { return "<0.01" }
    let c = (atomic + 5_000) / 10_000; return "\(c / 100)." + String(format: "%02lld", c % 100)
  }
  public static func format(_ atomic: Int64) -> String {
    let w = atomic / 1_000_000, f = atomic % 1_000_000
    if f == 0 { return "\(w)" }
    var fs = String(format: "%06lld", f); while fs.hasSuffix("0") { fs.removeLast() }
    return "\(w).\(fs)"
  }
}

/// Withdrawal destination check in plain Chinese (client side; the server checks again, incl. token contracts on chain).
public enum AddressCheck {
  public static func error(_ raw: String, wallet: String? = nil) -> String? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.lowercased().hasPrefix("ethereum:") { s = String(s.dropFirst(9)) }
    if let at = s.firstIndex(of: "@") { s = String(s[..<at]) }
    if s.isEmpty { return L("请填收款地址") }
    if !s.hasPrefix("0x") && (s.hasPrefix("bc1") || s.hasPrefix("T") || s.count >= 25) { return L("这不是 Base 地址（看起来是别的链的地址）。请在 Coinbase 或 Base App 里选「USDC · Base 网络」再复制") }
    let hex = s.dropFirst(2)
    if !s.hasPrefix("0x") || hex.count != 40 || !hex.allSatisfy({ $0.isHexDigit }) { return L("地址格式不对：Base 地址以 0x 开头，一共 42 位。请复制粘贴或扫码") }
    if let w = wallet, w.lowercased() == s.lowercased() { return L("这是 Kipurse 钱包自己的地址，请填你在 Coinbase 或 Base App 里的地址") }
    return nil
  }
  public static func normalized(_ raw: String) -> String {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines); if s.lowercased().hasPrefix("ethereum:") { s = String(s.dropFirst(9)) }
    if let at = s.firstIndex(of: "@") { s = String(s[..<at]) }; return s
  }
}
