import Foundation

/// t791: gateway error codes -> text in the PHONE's language (zh-Hans or English; anything else falls back to English).
/// Server "detail" strings are English-only and are never shown raw; unknown codes get a calm generic line + the code.
public enum ServerText {
  static let map: [String: (String, String)] = [
    "not_found": ("没有找到，请回到上一步再试一次。", "Not found. Go back and try again."),
    "slow_down": ("操作太频繁了，请等一分钟再试。", "Too many tries. Please wait a minute."),
    "rate_limited": ("操作太频繁了，请等一分钟再试。", "Too many tries. Please wait a minute."),
    "phone_session_required": ("请先用 Face ID 打开钱包再试。", "Open your wallet with Face ID first, then try again."),
    "invalid_session": ("登录已过期，请用 Face ID 重新打开钱包。", "Your session expired. Open your wallet with Face ID again."),
    "face_id_required": ("这一步需要 Face ID 确认。", "This step needs Face ID."),
    "not_owner": ("这个确认不是来自钱包主人的账户，什么都没改。", "That signature isn't from this wallet's owner. Nothing changed."),
    "bad_signature": ("确认没通过核对，什么都没改。", "The signature didn't check out. Nothing changed."),
    "bad_nonce": ("这一步已过期，请重新开始。", "This step expired. Please start again."),
    "challenge_expired": ("这一步已过期，请重新开始。", "This step expired. Please start again."),
    "bad_challenge": ("这一步已过期，请重新开始。", "This step expired. Please start again."),
    "expired": ("已过期，请重新开始。", "Expired. Please start again."),
    "no_phone_signer": ("这台 iPhone 还没开启 Face ID 批准。", "Face ID approvals aren't on for this iPhone yet."),
    "not_phone_signer": ("这台 iPhone 还没开启 Face ID 批准。", "Face ID approvals aren't on for this iPhone yet."),
    "phone_changed": ("Face ID 批准换了手机，请在这台 iPhone 上重新开启。", "Face ID approvals moved to another phone. Turn them on again on this iPhone."),
    "no_wallet": ("还没有找到你的钱包。", "No wallet found yet."),
    "unknown_wallet": ("还没有找到你的钱包。", "No wallet found yet."),
    "wrong_wallet": ("这不是你的钱包，已停止。", "That isn't your wallet. Stopped."),
    "wrong_destination": ("收款账户不对，已停止，没有转出任何钱。", "Wrong destination. Stopped; nothing was sent."),
    "bad_amount": ("金额不对，请重新输入。", "That amount doesn't work. Please check it."),
    "over_wallet_limits": ("超出了你设的上限。", "That's over your limits."),
    "single_above_daily": ("每笔上限不能高于每天上限。", "The per-payment limit can't be above the daily limit."),
    "daily_above_term": ("每天上限不能高于总额上限。", "The daily limit can't be above the total limit."),
    "term_too_high": ("总额上限太高了。", "The total limit is too high."),
    "not_verified": ("还没有 Coinbase 实名认证，请先完成认证。", "Coinbase verification isn't done yet. Please verify first."),
    "verify_first": ("还没有 Coinbase 实名认证，请先完成认证。", "Coinbase verification isn't done yet. Please verify first."),
    "verify_unavailable": ("暂时查不到认证状态，请稍后再试。", "Can't check verification right now. Try again later."),
    "onboard_disabled": ("新用户开通暂未开放。", "New sign-ups aren't open yet."),
    "fee_unavailable": ("暂时算不出手续费，请稍后再试。", "Can't work out the fee right now. Try again later."),
    "owner_pay_disabled": ("现在还不能这样付款。", "This kind of payment isn't available yet."),
    "owner_pay_failed": ("没有付款成功，没有扣钱。", "The payment didn't go through. Nothing was charged."),
    "needs_trusted_payee": ("这个收款方还没被你批准。", "You haven't approved this payee yet."),
    "new_payee_needs_confirm": ("新的收款方需要你用 Face ID 确认。", "A new payee needs your Face ID."),
    "bad_payee": ("收款地址不对。", "That payee address doesn't work."),
    "erase_disabled": ("删除功能暂时不可用。", "Delete isn't available right now."),
    "in_progress": ("上一步还在处理中，请稍等。", "The last step is still in progress. Please wait."),
    "unknown_plan": ("这一步已过期，请重新开始。", "This step expired. Please start again."),
    "prepare_first": ("请重新开始这一步。", "Please start this step again."),
    "start_first": ("请重新开始这一步。", "Please start this step again."),
    "applepay_unavailable": ("Apple Pay 买币暂时不可用，请用别的充值方式。", "Apple Pay isn't available right now. Use another way to add money."),
    "applepay_not_enabled": ("Apple Pay 买币暂时不可用，请用别的充值方式。", "Apple Pay isn't available right now. Use another way to add money."),
    "onramp_unreachable": ("暂时连不上 Coinbase，请稍后再试。", "Can't reach Coinbase right now. Try again later."),
    "onramp_rejected": ("Coinbase 没有接受这次购买，没有扣钱。", "Coinbase didn't accept this purchase. Nothing was charged."),
    "terms_not_accepted": ("需要先同意条款。", "Please accept the terms first."),
    "unauthorized": ("请重新登录。", "Please sign in again."),
    "invalid_token": ("请重新登录。", "Please sign in again."),
    "owner_only": ("只有钱包主人能做这一步。", "Only the wallet owner can do this."),
    "app_attest_required": ("请用官方启付 App 操作。", "Please use the official Kipurse app."),
  ]
  /// Localized text for a gateway error code (and HTTP status when there is no code).
  public static func text(code: String?, status: Int = 0) -> String {
    if let c = code?.trimmingCharacters(in: .whitespaces), let t = map[c] { return T(t.0, t.1) }
    if status == 0 && code == nil { return T("连不上网络，请稍后再试。", "Can't connect. Please try again.") }
    let tag = (code.map { $0.range(of: #"^[a-z0-9_]{1,40}$"#, options: .regularExpression) != nil ? $0 : "" } ?? "")
    let ref = tag.isEmpty ? (status > 0 ? "\(status)" : "") : tag
    return T("这一步没有完成，没有转出任何钱，也没有扣费。请稍后再试。", "That didn't go through. Nothing was sent or charged. Please try again.") + (ref.isEmpty ? "" : "（\(ref)）".replacingOccurrences(of: "（", with: Loc.isChinese ? "（" : " (").replacingOccurrences(of: "）", with: Loc.isChinese ? "）" : ")"))
  }
  /// Error to throw from an HTTP answer: never carries the server's English "detail".
  public static func error(_ j: [String: Any], status: Int, domain: String = "kipurse") -> NSError {
    NSError(domain: domain, code: status, userInfo: [NSLocalizedDescriptionKey: text(code: j["error"] as? String, status: status)])
  }
}
