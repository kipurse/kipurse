import Foundation
/// t613u beginner mode: plain words, guided setup. No preset is ever selected for the user.
public enum Beginner {
  /// t796: onboarding progress, plain words (step i of 3).
  public static func progress(_ step: Int, zh: Bool) -> String { zh ? "第 \(step) 步，共 3 步" : "Step \(step) of 3" }
  /// t796: plain limit amounts (10.05 -> "10", 12.01 -> "12", 0.5 -> "0.50").
  public static func plainAmount(_ v: Double) -> String { v >= 1 ? String(Int(v.rounded())) : String(format: "%.2f", v) }
  /// t796: correct English plural.
  public static func plural(_ n: Int, _ one: String, _ many: String) -> String { "\(n) " + (n == 1 ? one : many) }
  /// t852 (owner): ONE fixed account-opening fee, the same for every user; Kipurse fronts it, taken once with the first AI payment.
  public static let openingFeeUSDC = "0.05"
  public static var openingFeeZh: String { "开通费约 0.03 USDC，从启付钱包余额扣，只扣这一次。" }
  public static var openingFeeEn: String { "The setup fee (about 0.03 USDC) comes from your Kipurse wallet balance, once only." }
  /// How Kipurse names the currency everywhere (owner decision t613u).
  public static let currencyZh = "USDC（美元稳定币）"
  public static let currencyEn = "USDC (US dollar stablecoin)"
  public static let coinbaseWhyZh = "需要一个 Coinbase 账户（开户不收费，约 5 分钟）。第 1 步（必须）：先开一个 Coinbase 账户并通过它的身份认证。用 Coinbase 做身份认证，保护你的钱。启付自己不做实名认证，也不收集你的证件。"
  public static let coinbaseWhyEn = "You need a Coinbase account (no cost to open, about 5 minutes). Step 1 (required): open a Coinbase account and pass its identity check. Coinbase verifies who you are to protect your money. Kipurse does no ID check itself and collects no ID documents."
  /// Plain steps for someone with no Coinbase account.
  public static let noAccountStepsZh = ["在 App Store 下载 Coinbase（蓝色图标）", "打开后点「注册」，用邮箱和手机号建账户", "按提示完成 Coinbase 身份认证（拍证件照片，一般几分钟）。这一步是必须的，用来保护你的钱", "回到启付，点「用 Coinbase 登录」"]
  public static let noAccountStepsEn = ["Download Coinbase from the App Store (blue icon)", "Open it and tap “Sign up” with your email and phone", "Complete Coinbase’s identity check (photo of your ID, usually a few minutes). This step is required and protects your money", "Come back to Kipurse and tap “Sign in with Coinbase”"]
  public static let signUpURL = URL(string: "https://www.coinbase.com/signup")!
  /// Words a beginner screen must not show (plain-language rule). Checked by tests.
  public static let jargonZh = ["签名", "网络费", "gas", "Gas"]

  // MARK: guided setup
  public enum Use: Int, CaseIterable { case small, shopping, big }
  public enum Spend: Int, CaseIterable { case low, mid, high }
  public struct Plan: Equatable { public let key: String; public let zh: String; public let en: String; public let single: Int; public let daily: Int; public let term: Int; public let days: Int }
  public static let useZh = ["日常小额：订阅、咖啡、外卖", "网购", "大额：机票、酒店"]
  public static let useEn = ["Small everyday: subscriptions, coffee, food", "Online shopping", "Big items: flights, hotels"]
  public static let spendZh = ["每天 10 以内", "每天 10–50", "每天 50 以上"]
  public static let spendEn = ["Under 10 a day", "10–50 a day", "Over 50 a day"]
  /// Three SUGGESTIONS (cautious / normal / roomy). The user must tap one or type their own; nothing is pre-selected.
  public static func plans(use: Use, spend: Spend) -> [Plan] {
    let d = [10, 50, 200][spend.rawValue]; let s0 = [5, 50, 500][use.rawValue]
    func mk(_ k: String, _ zh: String, _ en: String, _ f: Double) -> Plan {
      let daily = max(1, Int(Double(d) * f)); let single = max(1, min(Int(Double(s0) * f), daily))
      return Plan(key: k, zh: zh, en: en, single: single, daily: daily, term: daily * 30, days: 90) }
    return [mk("cautious", "保守", "Cautious", 0.5), mk("normal", "一般", "Normal", 1), mk("roomy", "宽松", "Roomy", 2)]
  }
  /// Initial selection is ALWAYS nil (owner forbids forced presets).
  public static let initialSelection: Int? = nil
}

/// t619u (owner decision): OWN addresses (wallet, Coinbase wallet, phone approver) are shortened by default (0x1111…bEEF);
/// full only after an explicit 显示完整地址 / 复制. PAYEE addresses are ALWAYS shown in full before a payment or trust approval.
public enum AddressDisplay {
  public static func short(_ a: String) -> String { a.count > 12 ? "\(a.prefix(6))…\(a.suffix(4))" : a }
  /// Full address, grouped in 4s for character-by-character checking (look-alike highlighting is done on top of this).
  public static func full(_ a: String) -> String { guard a.hasPrefix("0x"), a.count == 42 else { return a }; let h = Array(a.dropFirst(2)); return "0x" + stride(from: 0, to: 40, by: 4).map { String(h[$0..<$0 + 4]) }.joined(separator: " ") }
  public static func own(_ a: String, revealed: Bool = false) -> String { revealed ? full(a) : short(a) }
  public static func payee(_ a: String) -> String { full(a) }
}

/// t620u 安全小贴士. Every line is checked against the current design (see OWNER_HANDBOOK t620u).
public enum SafetyTips {
  public static let zh = [
    "你的钱包地址是公开的，就像收款用的银行账号。别人只知道地址，拿不走你的钱：钱只会在你设的上限内、或经你批准才会付出去。我们平时把地址缩短显示，是为了保护你的隐私。",
    "付款前请核对完整的收款地址。骗子会用长得很像的地址，启付会把相似的地方标出来。",
    "启付永远不会向你要密码、恢复短语、私钥或验证码。谁要，谁就是骗子。",
    "钱一直在你自己的钱包里，启付不保管。你随时可以全部提现。",
    "链上安全底线写在区块链上：就算我们的服务器或 AI 出错，花费也不会超过你的上限。",
    "在「设置 → 安全」一键「暂停 AI 付款」，所有 AI（包括 Siri）都停，你自己的充值和提现不受影响。",
    "丢了手机？看「丢了手机怎么办」。",
    "手续费一律用 USDC（美元稳定币）付，按实际网络成本，不加价。启付的服务费是每笔付款的 0.1%，付款前就会显示。",
    "身份认证由 Coinbase 完成，启付不收集你的证件。",
    "防骗：只在启付 App 里点确认。确认弹窗的网址必须是 keys.coinbase.com；启付只会打开 kipurse.com 和 coinbase.com 的页面。启付不会私信你、不会打电话、不会发链接让你“验证钱包”。",
    "充值只从你自己的 Coinbase 钱包转入 USDC。还没有 USDC？先在 Coinbase 里买，再转进来。"]
  public static let en = [
    "Your wallet address is public, like a bank account number for receiving money. Knowing it alone can't take your money: money only leaves within the limits you set or with your approval. We still show it shortened to protect your privacy.",
    "Always check the full payee address before paying. Scammers use look-alike addresses; Kipurse highlights the parts that look alike.",
    "Kipurse never asks for your password, recovery phrase, private key or verification codes. Anyone who asks is a scammer.",
    "Your money stays in your own wallet. Kipurse doesn't hold it, and you can withdraw everything at any time.",
    "The on-chain safety floor lives on the blockchain: even if our servers or an AI go wrong, spending can't go over your limits.",
    "Settings → Safety → Pause AI payments stops every AI (Siri too). Your own deposits and withdrawals still work.",
    "Lost your phone? See “Lost your phone?”.",
    "Fees are always paid in USDC (US dollar stablecoin) at the actual network cost, with no markup. Kipurse's service fee is 0.1% per payment, shown before you pay.",
    "Identity checks are done by Coinbase; Kipurse collects no ID documents.",
    "Avoid scams: only confirm inside the Kipurse app. The confirm popup must be keys.coinbase.com; Kipurse only opens kipurse.com and coinbase.com pages. Kipurse never DMs you, never calls, and never sends links to “verify your wallet”.",
    "Add money only from your own Coinbase wallet. No USDC yet? Buy it in Coinbase first, then move it in."]
  public static let receiveZh = "地址是公开的收款号码，别人知道了也拿不走你的钱。"
  public static let receiveEn = "This address is a public number for receiving money; knowing it can't take your money."
  public static let payeeZh = "请逐个字符核对完整地址，骗子会用很像的地址。"
  public static let payeeEn = "Check the full address character by character; scammers use look-alike addresses."
  public static let limitsZh = "上限写在区块链上，就算服务器或 AI 出错也不会超过。"
  public static let limitsEn = "Limits live on the blockchain; even if servers or an AI go wrong, spending can't go over them."
}
