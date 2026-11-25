import Foundation
/// Owner t1010/t1011/t1012 (handbook 0B, locked): the 4-step [zh]. Order is welded: Coinbase verified -> deposit opens the
/// account -> whole-wallet total limit -> connect AI agents one by one. No Face ID before a balance; a zero balance never blocks browsing.
/// t1125 (decision 64): the wallet safety limits are filled in AT opening (decision 59) and the first Face ID key rides in the opening batch (decision 44).
public enum UsageGuide {
  public struct Step: Equatable { public let n: Int; public let zh: String; public let en: String; public let detailZh: String; public let detailEn: String }
  public static let steps: [Step] = [
    Step(n: 1, zh: "Coinbase 开户 + 实名认证", en: "Open a Coinbase account and verify",
         detailZh: "注册 Coinbase 并完成实名认证，由 Coinbase 替我们完成 KYC。只有带 Coinbase 链上认证的实名账号才能连接启付；没实名的会被拒绝，并一步步教你：注册 → 实名 → 链上验证地址 → 回到启付。",
         detailEn: "Sign up at Coinbase and complete its identity check; Coinbase does the KYC for us. Only Coinbase Verified accounts can connect to Kipurse. Unverified accounts are refused and shown the steps: sign up, verify, verify your address onchain, come back."),
    Step(n: 2, zh: "充值开户", en: "Deposit to open your account",
         detailZh: "选金额充值，充值成功就是开户成功。开通手续费按实际网络费，在充值之外另从你的 Coinbase 钱包（Base 账户）扣，不从这次充值里扣，确认前会显示金额；Kipurse 不出这笔钱。",
         detailEn: "Pick an amount to deposit — that opens your account. Opening fee is the actual network cost, charged separately from your Coinbase wallet (Base account) on top of your deposit, not taken out of it; you see the amount before confirming. Kipurse does not pay it."),
    Step(n: 3, zh: "设置钱包安全上限", en: "Set wallet safety limits",
         detailZh: "开户时就要自己填好钱包安全上限（每笔、每天、总额），三项都填好才能开户，和开户同一次确认、一起收费。开户后要改，到钱包页「钱包安全上限」修改，每次修改的网络费从启付钱包余额扣。",
         detailEn: "Fill in your wallet safety limits (per payment, per day, total) when you open: opening needs all three, and they are set in the same confirmation and fee as opening. To change them later, use Wallet safety limits on the Wallet tab; each change's network fee comes from your Kipurse wallet balance."),
    Step(n: 4, zh: "逐个连接 AI", en: "Connect your AIs one by one",
         detailZh: "最后一个一个连接你的 AI。第一次连接时，先在 AI 生活页设好 AI 花钱上限（修改不收手续费）；每次连接都由你用 Face ID 批准。Face ID 批准在开户时已经一起开好、一起收费；重装或换手机后再开启，要从启付钱包付一笔实际网络费（确认前显示实时报价）。",
         detailEn: "Last, connect your AIs one at a time. The first time, set your AI spending limits on the AI Life tab (changing them costs nothing); you approve each connection with Face ID. Face ID approvals are turned on and paid for as part of opening; turning them on again after a reinstall or new phone takes one actual network fee from your Kipurse wallet (a live quote before you confirm)."),
  ]
  /// t1248: on-chain wallet safety limits are in force (all three positive). Unreadable / still-loading is not "set".
  public static func limitsSet(_ s: WalletState) -> Bool { if case .ready = s.capRead { return true }; return false }
  /// Opened: deployed, already has on-chain limits, or has a deposit balance. A login shell (address only, no caps, no balance) is not open.
  public static func walletOpen(_ s: WalletState) -> Bool { s.walletDeployed || limitsSet(s) || s.balance > 0 || s.capStart != nil }
  /// Non-revoked agents the server lists as connected (`connected: false` is out; a missing flag follows state.agents and counts as listed).
  public static func agentsConnected(_ s: WalletState) -> Int {
    s.agents.filter { !($0["revoked"]?.bool ?? false) && ($0["connected"]?.bool ?? true) }.count
  }
  /// The step the user is on now (1...4), or 5 when everything is done. Strict order: a later step never shows as current before an earlier one is done.
  /// t1248: an already-open wallet implies step 1 (opening requires Coinbase verification). Limits set at opening keep step 3 done even if the balance later returns to 0.
  public static func current(verified: Bool, walletOpen: Bool, limitsSet: Bool, agentsConnected: Int) -> Int {
    if !verified && !walletOpen { return 1 }
    if !walletOpen { return 2 }
    if !limitsSet { return 3 }
    if agentsConnected == 0 { return 4 }
    return 5
  }
  public static func current(verified: Bool, balance: Double, limitsSet: Bool, agentsConnected: Int) -> Int {
    current(verified: verified, walletOpen: balance > 0 || limitsSet, limitsSet: limitsSet, agentsConnected: agentsConnected)
  }
  public static func current(state: WalletState?, verified: Bool) -> Int {
    guard let s = state else { return verified ? 2 : 1 }
    return current(verified: verified, walletOpen: walletOpen(s), limitsSet: limitsSet(s), agentsConnected: agentsConnected(s))
  }
  /// 0B step 2: AI payments are refused at a zero balance (nothing is paid).
  public static func aiPaymentAllowed(balance: Double) -> Bool { balance > 0 }
  /// 0A item 2 / 0B: Face ID setup is only offered once there is a balance.
  public static func offerFaceID(balance: Double) -> Bool { balance > 0 }
  public static let openingFeeNoticeZh = "开通手续费按实际网络费，在充值之外另从你的 Coinbase 钱包（Base 账户）扣，不从这次充值里扣，请先充值；已有余额也要先完成 Coinbase 实名再连接。"
  public static let openingFeeNoticeEn = "Opening fee is the actual network cost, charged separately from your Coinbase wallet (Base account) on top of your deposit — please deposit first. Finish Coinbase verification before connecting, even if you already have a balance."
  public static let zeroBalanceRefusalZh = "没有付款：钱包还没有余额。使用 AI 付款必须先充值，充值成功就是开户成功。"
  public static let zeroBalanceRefusalEn = "Not paid: your wallet has no balance yet. AI payments need a deposit first; a successful deposit opens your account."
}
