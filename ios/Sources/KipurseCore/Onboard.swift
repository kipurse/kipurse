import Foundation

/// One-time setup ("开通"): ONE Coinbase wallet signature, ONE atomic batch, ONE network fee paid by the owner's own Coinbase wallet
/// (USDC via its gas sponsor, or ETH). Covers the AI spend permission + caps, the phone approver (Face ID + Siri) and removal of dead
/// phone approvers. Pure parsing / validation shared by the app and the unit tests.
public enum Onboard {
  /// Operator switch (Info.plist KipurseOnboard = YES). Off in production builds until the owner approves.
  public static var enabled: Bool { Operator.str("KipurseOnboard") == "YES" }
  /// What the app shows on the single fee page (GET /onboard/quote).
  public struct Quote: Equatable {
    public let feeUSDC: String, gas: Int64, payer: String, payerCanPayUSDC: Bool?, payerCanPayEth: Bool, sponsoredByKipurse: Bool, signatures: Int
    /// Kipurse pays ONLY this first new-wallet onboarding (server-gated gas sponsor); everything else stays user-paid.
    public let sponsored: Bool
    public init?(_ j: JSONValue?) {
      guard let j, let fee = j["feeUSDC"]?.string, let gas = j["gas"]?.atomic else { return nil }
      feeUSDC = fee; self.gas = gas; self.payer = j["payer"]?.string ?? ""   // a new, unfunded Coinbase wallet may have no payer yet
      if case .bool(let b)? = j["payerCanPayUSDC"] { payerCanPayUSDC = b } else { payerCanPayUSDC = nil }
      payerCanPayEth = j["payerCanPayEth"]?.bool ?? false; sponsoredByKipurse = j["sponsoredByKipurse"]?.bool ?? true
      signatures = Int(j["signatures"]?.atomic ?? 0); sponsored = j["sponsored"]?.bool ?? false
    }
    /// Never accept a quote that claims someone else pays or that needs more than one signature.
    public var acceptable: Bool { signatures == 1 && (!sponsoredByKipurse || sponsored) }
    public var canPay: Bool { sponsored || payerCanPayEth || (payerCanPayUSDC ?? false) }
  }
  /// POST /onboard/start body (amounts as decimal USDC strings, like the limits page).
  /// owner: the Coinbase wallet the user just signed in with; the server refuses a signing page connected to any other account.
  public static func startBody(x: [UInt8], y: [UInt8], single: String, daily: String, term: String, days: String, owner: String? = nil) -> [String: String] {
    func f(_ v: String) -> String { AnswerRules.format(AnswerRules.parseUSDC(v) ?? 0) }
    var b = ["x": Hex.encode(x), "y": Hex.encode(y), "single": f(single), "daily": f(daily), "term": f(term), "days": days]
    if let owner, CoinbaseIdentity.isAddress(owner) { b["owner"] = owner }
    return b
  }
  /// The steps the one signature performs, in plain words (also listed on the signing page).
  public static func steps(removes: Int, siri: Bool) -> [String] {
    var s = [L("设置 AI 花钱上限"), siri ? L("这台 iPhone 成为确认人（Face ID 批准、Siri 付款）") : L("这台 iPhone 成为确认人（Face ID 批准）")]
    if removes > 0 { s.append(L("移除 \(removes) 个作废的旧手机确认人")) }
    return s
  }
}
