import Foundation

/// t1094: first-connect AI spending limits. Amounts stay blank until the owner types them.
/// The red line is the first real problem, never 「请输入金额」 once all three amounts parse.
public enum AILimitGate {
  public enum Caps: Equatable {
    /// The chain read failed. Different from a wallet that has no safety limit yet.
    case unreadable
    /// The chain answered and this wallet has no positive safety limit.
    case unset
    case ready(single: Int64, daily: Int64, term: Int64)
  }
  public enum Verdict: Equatable {
    case needSingle, needDaily, needTerm
    case singleAboveDaily, dailyAboveTerm
    case unreadable, unset, over, within
  }

  public static func verdict(single: String, daily: String, term: String, caps: Caps) -> Verdict {
    guard let s = amount(single) else { return .needSingle }
    guard let d = amount(daily) else { return .needDaily }
    guard let t = amount(term) else { return .needTerm }
    if s > d { return .singleAboveDaily }
    if d > t { return .dailyAboveTerm }
    switch caps {
    case .unreadable: return .unreadable
    case .unset: return .unset
    case .ready(let cs, let cd, let ct):
      return (s > cs || d > cd || t > ct) ? .over : .within
    }
  }

  public static func allowsContinue(single: String, daily: String, term: String, caps: Caps) -> Bool {
    verdict(single: single, daily: daily, term: term, caps: caps) == .within
  }

  public static func line(single: String, daily: String, term: String, caps: Caps) -> String {
    switch verdict(single: single, daily: daily, term: term, caps: caps) {
    case .needSingle: return T("请填写每笔金额", "Enter the per-payment amount")
    case .needDaily: return T("请填写每天金额", "Enter the daily amount")
    case .needTerm: return T("请填写总额", "Enter the total")
    case .singleAboveDaily: return T("每笔不能大于每天", "Per payment can't be above per day")
    case .dailyAboveTerm: return T("每天不能大于总额", "Per day can't be above the total")
    case .unreadable: return T("还没读到钱包安全上限，请稍后再试", "Couldn't read the wallet safety limit yet. Try again.")
    case .unset: return T("请先在钱包页设置钱包安全上限", "Set the wallet safety limit on the wallet page first.")
    case .over: return T("超过钱包安全上限，请调低金额或修改安全上限", "Over the wallet safety limit. Lower the amount or change the safety limit.")
    case .within: return T("这次修改：不收手续费，马上生效", "This change: no fee, instant")
    }
  }

  private static func amount(_ s: String) -> Int64? {
    guard let n = AnswerRules.parseUSDC(s), n > 0 else { return nil }
    return n
  }
}

public extension WalletState {
  /// What the first-connect page should trust. A missing caps object is unreadable, not "never set".
  var capRead: AILimitGate.Caps {
    if raw["capsUnreadable"]?.bool == true { return .unreadable }
    if raw["capsUnset"]?.bool == true { return .unset }
    let s = raw["caps"]?["single"]?.atomic, d = raw["caps"]?["daily"]?.atomic, t = raw["caps"]?["term"]?.atomic
    guard let s, let d, let t else {
      return (raw["caps"] == nil || raw["caps"] == .null) ? .unreadable : .unset
    }
    if s <= 0 || d <= 0 || t <= 0 { return .unset }
    return .ready(single: s, daily: d, term: t)
  }
  /// Balance-only shell used when there is no phone session. Caps come from the chain read.
  static func shell(wallet: String, balance: Int64, caps: AILimitGate.Caps) -> WalletState {
    var o: [String: JSONValue] = [
      "mode": .string("MAIN"),
      "balance": .string(String(balance)),
      "setup": .object(["active": .bool(true), "wallet": .string(wallet)])
    ]
    switch caps {
    case .unreadable: o["capsUnreadable"] = .bool(true)
    case .unset: o["capsUnset"] = .bool(true)
    case .ready(let s, let d, let t):
      o["caps"] = .object(["single": .string(String(s)), "daily": .string(String(d)), "term": .string(String(t))])
    }
    return WalletState(.object(o))
  }
}
