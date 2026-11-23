import Foundation

/// t1245 (§6#115, owner 「全部改」 2026-11-21): ONE money display rule for the whole app.
/// - A USDC amount (balance, payment, deposit, withdrawal, totals) always shows exactly 2 decimals ("18.50"), rounded half up;
///   a non-zero amount under 0.005 shows "<0.01" so it never looks like 0.
/// - A fee / network fee shows 2 decimals too, except when it is under 0.01: then up to 6 decimals ("0.003451").
/// - Inside one page every fee uses the same style (`FeeStyle.page`): if any fee on the page is under 0.01, all of that page's
///   fees show up to 6 decimals, otherwise all show 2.
/// Display only: parsing, limits, signing and server values keep using AnswerRules.format / exact atomic units.
public enum MoneyText {
  public static let unit = "USDC"

  /// "18.50", "0.00", "<0.01", "-3.20".
  public static func amount(_ atomic: Int64) -> String {
    if atomic < 0 { return "-" + amount(-atomic) }
    if atomic > 0 && atomic < 5_000 { return "<0.01" }
    return cents(atomic)
  }
  /// "18.50 USDC".
  public static func usdc(_ atomic: Int64) -> String { amount(atomic) + " " + unit }
  /// Signed amount for records: "+12.30" / "−0.03" (true minus sign, as the ledger rows use).
  public static func signed(_ delta: Int64) -> String { (delta >= 0 ? "+" : "−") + amount(delta >= 0 ? delta : -delta) }

  public enum FeeStyle: Equatable {
    /// 2 decimals.
    case cents
    /// Up to 6 decimals, trailing zeros trimmed, never fewer than 2 ("0.003451", "0.02", "0.021373").
    case micro
    /// The one style for every fee shown on a page.
    public static func page(_ fees: [Int64]) -> FeeStyle { fees.contains { $0 != 0 && abs($0) < 10_000 } ? .micro : .cents }
  }
  /// A single fee on its own: under 0.01 -> up to 6 decimals, otherwise 2.
  public static func fee(_ atomic: Int64) -> String { fee(atomic, style: FeeStyle.page([atomic])) }
  public static func fee(_ atomic: Int64, style: FeeStyle) -> String {
    if atomic < 0 { return "-" + fee(-atomic, style: style) }
    switch style {
    case .cents: return cents(atomic)
    case .micro:
      let w = atomic / 1_000_000
      var f = String(format: "%06lld", atomic % 1_000_000)
      while f.count > 2 && f.hasSuffix("0") { f.removeLast() }
      return "\(w).\(f)"
    }
  }
  public static func feeUSDC(_ atomic: Int64, style: FeeStyle? = nil) -> String { fee(atomic, style: style ?? FeeStyle.page([atomic])) + " " + unit }

  /// Exactly 2 decimals, rounded half up (non-negative input).
  static func cents(_ atomic: Int64) -> String {
    let c = (atomic + 5_000) / 10_000
    return "\(c / 100)." + String(format: "%02lld", c % 100)
  }
}

/// t1245 (§6#115 U9): the AI 生活 tab badge counts every pending item the 「待你批准」 block shows, with the block's own rules:
/// approvals (incl. new-merchant trust) always; connect requests on mainnet; AI allowance / ask requests and held payments on an
/// active mainnet wallet. The block header uses the same number, so badge and block never disagree.
public enum PendingBadge {
  public static func count(approvals: Int, allowanceRequests: Int, connectRequests: Int, holds: Int, isMainnet: Bool, active: Bool) -> Int {
    var n = max(0, approvals)
    if isMainnet { n += max(0, connectRequests) }
    if isMainnet && active { n += max(0, allowanceRequests) + max(0, holds) }
    return n
  }
}

/// t1245 (§6#115 U20): the wallet safety limit page opens with the validity it has now (e.g. 365 days), not a fixed 90.
public enum LimitTerm {
  /// Whole days between the on-chain start and end (rounded), only when it is a choice the page accepts (1…365).
  public static func days(start: Date?, end: Date?) -> Int? {
    guard let a = start, let b = end, b > a else { return nil }
    let d = Int((b.timeIntervalSince(a) / 86_400).rounded())
    return (1...365).contains(d) ? d : nil
  }
}
