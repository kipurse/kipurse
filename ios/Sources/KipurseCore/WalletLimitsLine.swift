import Foundation

/// t1129: the [zh] row on the wallet page shows the limit that is in force ON CHAIN (or the server's copy of it),
/// never only the generic fee explanation. Read-only; the fee explanation stays on the change page.
public enum WalletLimitsLine {
  public enum State: Equatable {
    case loading, unreadable, unset
    case ready(single: Int64, daily: Int64, term: Int64, end: Date?)
  }

  public static func state(_ s: WalletState) -> State {
    switch s.capRead {
    case .ready(let a, let b, let c): return .ready(single: a, daily: b, term: c, end: s.capEnd)
    case .unset: return .unset
    case .unreadable:
      #if DEBUG
      if CommandLine.arguments.contains("-kpCapsUnreadable") { return .unreadable }
      #endif
      // No answer yet (no caps, no failure flag): the chain read is still running.
      if s.raw["capsUnreadable"]?.bool == true || (s.raw["caps"] != nil && s.raw["caps"] != .null) { return .unreadable }
      return .loading
    }
  }

  public static func day(_ d: Date, zone: TimeZone = .current) -> String { String(Mainnet.localTime(d, zone: zone).prefix(10)) }

  public static func text(_ st: State, zone: TimeZone = .current) -> String {
    switch st {
    case .loading: return T("正在读取…", "Reading…")
    case .unreadable: return T("暂时读不到，请稍后再试", "Can't read it right now. Try again later.")
    case .unset: return T("还没有设置", "Not set yet")
    case .ready(let s, let d, let t, let end):
      // t1245 (decision 115 U20): the exact numbers, the same as the limit page and its input boxes (30.03 stays 30.03).
      let base = T("每笔 \(AnswerRules.format(s)) · 每天 \(AnswerRules.format(d)) · 总额 \(AnswerRules.format(t)) USDC",
                   "Per payment \(AnswerRules.format(s)) · per day \(AnswerRules.format(d)) · total \(AnswerRules.format(t)) USDC")
      guard let end else { return base }
      return base + T(" · 到 \(day(end, zone: zone))", " · until \(day(end, zone: zone))")
    }
  }
  /// t1245 (decision 115 U38): the limit's end date has passed (it no longer protects anything until renewed).
  public static func expired(_ st: State, now: Date = Date()) -> Bool {
    if case .ready(_, _, _, let end?) = st { return end <= now }
    return false
  }
  /// The home row: an expired limit says so first (shown in red) instead of an old "[zh]" date.
  public static func rowText(_ st: State, now: Date = Date(), zone: TimeZone = .current) -> String {
    expired(st, now: now) ? T("已过期，点这里续期", "Expired. Tap here to renew") : text(st, zone: zone)
  }
}
