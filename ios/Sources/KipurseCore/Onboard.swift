import Foundation

/// One-time setup ("[zh]"): ONE Coinbase wallet signature, ONE atomic batch, ONE network fee paid by the owner's own Coinbase wallet
/// (USDC same-tx repay; never ETH). Covers deposit + AI spend permission + caps; phone Face ID key is NOT required at opening (0A.1). Removal of dead
/// phone approvers. Pure parsing / validation shared by the app and the unit tests.
public enum Onboard {
  /// Operator switch (Info.plist KipurseOnboard = YES). Off in production builds until the owner approves.
  public static var enabled: Bool { Operator.str("KipurseOnboard") == "YES" }
  /// What the app shows on the single fee page (GET /onboard/quote).
  public struct Quote: Equatable {
    public let feeUSDC: String, gas: Int64, payer: String, payerCanPayUSDC: Bool?, payerCanPayEth: Bool, sponsoredByKipurse: Bool, signatures: Int
    /// Kipurse pays ONLY this first new-wallet onboarding (server-gated paymaster); everything else stays user-paid.
    public let sponsored: Bool
    /// Option A (t1020): the user pays the network fee in USDC via Coinbase's fee paymaster (server feePaidBy = user_usdc).
    public let userPaysUSDC: Bool
    public init?(_ j: JSONValue?) {
      guard let j, let fee = j["feeUSDC"]?.string, let gas = j["gas"]?.atomic else { return nil }
      feeUSDC = fee; self.gas = gas; self.payer = j["payer"]?.string ?? ""   // a new, unfunded Coinbase wallet may have no payer yet
      if case .bool(let b)? = j["payerCanPayUSDC"] { payerCanPayUSDC = b } else { payerCanPayUSDC = nil }
      payerCanPayEth = j["payerCanPayEth"]?.bool ?? false; sponsoredByKipurse = j["sponsoredByKipurse"]?.bool ?? true
      signatures = Int(j["signatures"]?.atomic ?? 0); sponsored = j["sponsored"]?.bool ?? false; userPaysUSDC = j["feePaidBy"]?.string == "user_usdc"
      // t1185 (decision 86): 0.15 USDC into the wallet's fee reserve (owner's money), shown only within 0.10..0.20
      if let v = j["vaultSeedUSDC"]?.atomic, v >= Int64(UsdcGas.vaultSeedMin), v <= Int64(UsdcGas.vaultSeedMax) { vaultSeed = UInt64(v) } else { vaultSeed = nil }
    }
    /// t1185 (decision 86): atomic USDC the opening moves into the wallet's fee reserve (nil = older server, none).
    public let vaultSeed: UInt64?
    /// Never accept a quote that claims someone else pays or that needs more than one signature.
    public var acceptable: Bool { signatures == 1 && (userPaysUSDC || (!sponsoredByKipurse || sponsored)) }
    public var canPay: Bool { sponsored || userPaysUSDC || payerCanPayEth || (payerCanPayUSDC ?? false) }
  }
  /// 0A.1 / t1008 / t1022: opening needs no Face ID; the user pays the opening fee in USDC in the same confirmation as the deposit. Never [zh].
  /// t1026: fee note shows the quoted actual network fee when available.
  public static var feeNote: String { feeNote(quoted: nil) }
  public static func feeNote(quoted: String?) -> String { let n = UsdcGas.feeNote(quotedUSDC: quoted); return T(n.zh, n.en) }
  public static func feeNote(quoted: String?, seed: UInt64?) -> String { let n = UsdcGas.feeNote(quotedUSDC: quoted, seed: seed); return T(n.zh, n.en) }
  /// The start button never depends on the user's balance (no "[zh]" dead end before a wallet even exists).
  public static func canStart(_ q: Quote?) -> Bool { guard let q else { return false }; return q.acceptable && (q.sponsored || q.userPaysUSDC) }
  /// Opening deposit (t1008: deposit = opening): decimal USDC -> atomic (6 dp); at least 1 USDC so the deposit clearly covers the opening fee.
  public static func depositAtomic(_ s: String) -> UInt64? { guard let v = AnswerRules.parseUSDC(s), v >= 1_000_000, v <= 1_000_000_000_000 else { return nil }; return UInt64(v) }
  /// t1113 (decision 59): opening needs the user's own three limits (no silent default plan) plus a valid deposit and an acceptable quote.
  public static func canOpen(quote: Quote?, starting: Bool, deposit: String, limitsError: String?) -> Bool {
    !starting && canStart(quote) && depositAtomic(deposit) != nil && limitsError == nil
  }
  /// t1113: the least USDC the user's Base account must hold at opening, mirroring the server (/onboard/new/prepare refuses
  /// when balance < opening fee + deposit). Fee = live quote (opening + first wallet safety limits + Face ID key). Deposit = the
  /// amount typed, or the app's 1 USDC minimum when empty/too small. nil fee -> words only (never an invented number).
  public static func minBaseAtomic(quoted: String?, deposit: String, seed: UInt64? = nil) -> Int64? {
    guard let q = quoted, let fee = AnswerRules.parseUSDC(q), fee > 0 else { return nil }
    return fee + Int64(depositAtomic(deposit) ?? 1_000_000) + Int64(seed ?? 0)
  }
  public static func minBaseNoteText(quoted: String?, deposit: String, seed: UInt64?) -> (zh: String, en: String) {
    guard let s = seed, s > 0, let total = minBaseAtomic(quoted: quoted, deposit: deposit, seed: s), let q = quoted else { return minBaseNoteText(quoted: quoted, deposit: deposit) }
    let dep = AnswerRules.format(Int64(depositAtomic(deposit) ?? 1_000_000)), t = AnswerRules.format(total), r = AnswerRules.format(Int64(s))
    return ("开户时你的 Coinbase 钱包（Base 账户）里至少要有约 \(t) USDC：开通手续费约 \(q) USDC（含首次钱包安全上限和 Face ID 钥匙）+ 充值 \(dep) USDC（最少 1 USDC）+ 手续费备用金 \(r) USDC（还是你的钱）。",
            "At opening your Coinbase wallet (Base account) needs at least about \(t) USDC: opening fee about \(q) USDC (includes the first wallet safety limits and the Face ID key) + deposit \(dep) USDC (minimum 1 USDC) + fee reserve \(r) USDC (still your money).")
  }
  public static func minBaseNote(quoted: String?, deposit: String, seed: UInt64?) -> String { let n = minBaseNoteText(quoted: quoted, deposit: deposit, seed: seed); return T(n.zh, n.en) }
  public static func minBaseNoteText(quoted: String?, deposit: String) -> (zh: String, en: String) {
    let dep = AnswerRules.format(Int64(depositAtomic(deposit) ?? 1_000_000))
    guard let total = minBaseAtomic(quoted: quoted, deposit: deposit), let q = quoted else {
      return ("开户时你的 Coinbase 钱包（Base 账户）里至少要有：开通手续费（含首次钱包安全上限和 Face ID 钥匙）+ 充值金额（最少 1 USDC）。",
              "At opening your Coinbase wallet (Base account) needs at least: the opening fee (includes the first wallet safety limits and the Face ID key) + your deposit (minimum 1 USDC).")
    }
    let t = AnswerRules.format(total)
    return ("开户时你的 Coinbase 钱包（Base 账户）里至少要有约 \(t) USDC：开通手续费约 \(q) USDC（含首次钱包安全上限和 Face ID 钥匙）+ 充值 \(dep) USDC（最少 1 USDC）。",
            "At opening your Coinbase wallet (Base account) needs at least about \(t) USDC: opening fee about \(q) USDC (includes the first wallet safety limits and the Face ID key) + deposit \(dep) USDC (minimum 1 USDC).")
  }
  public static func minBaseNote(quoted: String?, deposit: String) -> String { let n = minBaseNoteText(quoted: quoted, deposit: deposit); return T(n.zh, n.en) }
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
    var s = [L("充值开户（手续费从这次充值里扣）"), L("设置 AI 花钱上限（开通后也能改）")]
    if removes > 0 { s.append(L("移除 \(removes) 个作废的旧手机确认人")) }
    return s
  }
}
