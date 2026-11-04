import Foundation

/// Text Siri / Apple Intelligence speaks for Kipurse (pure, unit-tested). Read-only: built from the server's real state.
public enum SiriAnswers {
  public struct Payee: Equatable, Codable { public let address: String; public let name: String
    public init(address: String, name: String) { self.address = address; self.name = name } }
  static func day(_ d: Date, zh: Bool) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: zh ? "zh_CN" : "en_US"); f.dateFormat = zh ? "yyyy年M月d日" : "MMM d, yyyy"; return f.string(from: d)
  }
  public static func balance(_ s: WalletState, zh: Bool = true) -> String {
    var t = zh ? "Kipurse 余额 \(AnswerRules.format(s.balance)) USDC" : "Kipurse balance: \(AnswerRules.format(s.balance)) USDC"
    if let a = s.capSingle, let b = s.capDaily {
      t += zh ? "。每笔最多 \(AnswerRules.format(a))，每天最多 \(AnswerRules.format(b)) USDC" : ". Up to \(AnswerRules.format(a)) per payment, \(AnswerRules.format(b)) USDC per day"
      if let e = s.capEnd { t += zh ? "，到 \(day(e, zh: true)) 结束" : ", until \(day(e, zh: false))" }
    }
    return t + (zh ? "。" : ".")
  }
  public static func activity(_ s: WalletState, zh: Bool = true, limit: Int = 3) -> String {
    let rows = s.ledger.filter { !$0.isOwner }.prefix(limit)
    guard !rows.isEmpty else { return zh ? "最近没有余额变动。" : "No recent balance changes." }
    // i18n-ok below: server ledger text is Chinese, spoken only in zh
    let parts = rows.map { r in "\(r.signed) USDC" + (r.zh.isEmpty || !zh ? "" : "（\(r.zh)）") }
    return (zh ? "最近 \(rows.count) 笔：" : "Last \(rows.count): ") + parts.joined(separator: zh ? "；" : "; ") + (zh ? "。" : ".")
  }
  /// Recipients the wallet already paid (real payees from the server's purchases). Siri can only pick from these.
  public static func payees(_ s: WalletState) -> [Payee] {
    var seen = Set<String>(), out: [Payee] = []
    for p in s.purchases {
      guard let a = p["payee"]?.string, a.hasPrefix("0x"), a.count == 42, !seen.contains(a.lowercased()) else { continue }
      seen.insert(a.lowercased()); out.append(Payee(address: a, name: p["merchant"]?.string ?? "\(a.prefix(6))…\(a.suffix(4))"))
    }
    return out
  }
  /// USDC text -> atomic (6 decimals), nil if invalid.
  public static func atomic(_ amount: Double) -> Int64? { guard amount > 0, amount.isFinite, amount < 1e9 else { return nil }; return Int64((amount * 1_000_000).rounded()) }
  /// Checked before the confirmation screen opens; the chain still enforces the caps.
  public static func payProblem(_ amount: Int64, _ s: WalletState, zh: Bool = true) -> String? {
    if amount > s.balance { return zh ? "余额不够（\(AnswerRules.format(s.balance)) USDC）。" : "Not enough balance (\(AnswerRules.format(s.balance)) USDC)." }
    if let c = s.capSingle, amount > c { return zh ? "超过每笔上限 \(AnswerRules.format(c)) USDC。" : "Over the per-payment limit of \(AnswerRules.format(c)) USDC." }
    if let d = s.capDaily { let left = max(0, d - (s.serverSpentToday ?? 0)); if amount > left { return zh ? "今天只剩 \(AnswerRules.format(left)) USDC 额度。" : "Only \(AnswerRules.format(left)) USDC left today." } }
    return nil
  }
}
