import Foundation

/// t1170 (decision 82): the owner's answer to "do you know this payee?" (a NEW payee above the AI auto limit).
/// The phone signs, after ONE Face ID: the card text bound to the choice (trust | once), the owner's on-chain approval of
/// exactly this payment (OwnerPay.toSign), and for "trust" the OwnerTrust message for exactly this payee. Each is checked here first.
public enum OwnerAsk {
  public static let modes = ["trust", "once"]
  /// The card text the phone signs: the existing approval text + "\nmode:<mode>" (a "once" signature can never become "trust").
  public static func textOK(_ signText: String, base: String, wallet: String, id: String, mode: String) -> Bool {
    guard modes.contains(mode), !wallet.isEmpty, !base.isEmpty else { return false }
    let prefix = "Kipurse allowance approval v1\nwallet:" + wallet.lowercased() + "\nid:" + id + "\n"
    return base.hasPrefix(prefix) && signText == base + "\nmode:" + mode
  }
  /// Trust part: exactly this one payee, the per-payment cap the server announced, an expiry (never permanent, at most ~1 year).
  /// t1240 (decision 110): `signer` / `merchant` are set only when the server says the merchant's order was signed by the signer it publishes on its own
  /// domain; then the trust must name exactly that ONE signer under that domain (the same Face ID also signs the V5.4 grant). Otherwise no signers.
  public static func trustProblems(_ m: OwnerTrustMessage, payee: String, single: String, signer: String? = nil, merchant: String? = nil, now: Date = Date()) -> [String] {
    var p = [String]()
    if m.payees.count != 1 || m.payees.first?.lowercased() != payee.lowercased() { p.append("trust is not for exactly this payee") }
    if let sg = signer, !sg.isEmpty {
      if m.signers.count != 1 || m.signers.first?.lowercased() != sg.lowercased() { p.append("trust must name exactly the merchant's signer") }
      if !isDomain(merchant ?? "") || m.name != (merchant ?? "").lowercased() { p.append("trust name is not the merchant's domain") }
    } else if !m.signers.isEmpty { p.append("trust must not add order signers") }
    if m.single != single { p.append("per-payment cap differs from what was shown") }
    // t1281 (decision 141 (3)): the gateway always asks for 90 days (TRUST_DEFAULTS.days, chain time); the phone refuses anything longer than
    // askTrustMaxDays (90 + one day of chain/phone clock slack), so the card can truthfully say "[zh]" before any tap.
    if let e = Double(m.expiry), e > now.timeIntervalSince1970, e < now.timeIntervalSince1970 + Double(askTrustMaxDays) * 86400 + ClockSkew.upperTolerance {} else { p.append("bad expiry") }
    return p
  }
  public static let askTrustMaxDays = 91
  /// a plain lowercase host name such as "shop.example" (what the owner sees and what the merchant id is hashed from)
  public static func isDomain(_ h: String) -> Bool {
    guard h.count >= 3, h.count <= 80, h.contains("."), h == h.lowercased() else { return false }
    return h.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") } && !h.hasPrefix(".") && !h.hasSuffix(".")
  }
  /// t1241 (decision 111 layered trust): the card / Face ID line for a merchant DOMAIN trust. The server says whether the merchant itself signs its
  /// orders (signer published on its own domain); unsigned merchants auto-pay only up to half the trust limits. nil = no domain trust offered.
  public static func domainTrustLine(domain: String?, merchantSigned: Bool?) -> (zh: String, en: String)? {
    guard let d = domain, isDomain(d) || d == "localhost" else { return nil }
    if merchantSigned == false { return ("信任 \(d) · 商家未签名，自动付额度减半", "Trust \(d) · the merchant does not sign its orders, so automatic payments get half the limits") }
    return ("信任 \(d) · 商家已签名", "Trust \(d) · the merchant signs its orders") }
  /// t1246 (decision 116 F8): the phone's OWN ceiling for a trust made from this card — the AI everyday limits the owner set and sees in the app
  /// ("[zh]"), or, when none are set, the same defaults the server uses (5 USDC per payment, 20 USDC a day). A trust above it is refused
  /// on the phone even if the server says otherwise (the server's own `phone.maxSingle/maxDaily` is no longer the only bound).
  /// t1259 (decision 129): the server closed a payment request that can no longer be paid (merchant order expired / gone). Nothing was paid.
  public static let goneZH = "这笔付款请求已经过期或不能再付（比如商家订单超过了有效期），已从列表移除，没有付款。请让 AI 重新下单。"
  public static let goneEN = "This payment request expired or can no longer be paid (for example the merchant order timed out). It was removed and nothing was paid. Ask the AI to order again."
  public static func isGone(status: Int, error: String) -> Bool { status == 410 || error == "request_gone" }
  public static let defaultTrustSingle: Int64 = 5_000_000, defaultTrustDaily: Int64 = 20_000_000
  public static func trustCeiling(saved: AISpendLimits.Saved?) -> (single: Int64, daily: Int64) {
    if let s = saved, s.single > 0, s.daily > 0 { return (s.single, s.daily) }
    return (defaultTrustSingle, defaultTrustDaily)
  }
  /// t1257 (decision 126): the chain counts amount + protocol fee against a trust's DAILY cap, so the gateway asks for the owner's daily
  /// limit plus fee headroom (abi.mjs withFeeHeadroom). Same formula here, at the highest fee the owner signed on chain (0.1%, can only
  /// go down): cap + ceil(cap * 1000 / 1e6). Per-payment caps count the merchant amount only and get no headroom.
  public static let maxFeePpm: Int64 = 1000
  public static func dailyWithFeeHeadroom(_ cap: Int64) -> Int64 { cap <= 0 ? 0 : cap + (cap * maxFeePpm + 999_999) / 1_000_000 }
  public static func trustCapProblems(_ m: OwnerTrustMessage, ceiling: (single: Int64, daily: Int64)) -> [String] {
    var p = [String]()
    guard let s = Int64(m.single), s > 0 else { return ["bad per-payment cap"] }
    guard let d = Int64(m.daily), d > 0 else { return ["bad daily cap"] }
    if s > ceiling.single { p.append("per-payment cap above the limit set on this phone") }
    if d > dailyWithFeeHeadroom(ceiling.daily) { p.append("daily cap above the limit set on this phone") }   // t1257 decision 126
    if s > d { p.append("per-payment cap above daily cap") }
    return p
  }
  /// t1246 (decision 116 F9): a push button only opens the card; this line tells the owner to check it and tap here (no Face ID from the lock screen).
  public static func pushChoiceHint(mode: String) -> (zh: String, en: String)? {
    switch mode {
    case "trust": return ("你在通知里选了「认识并信任」。先核对上面的完整地址和金额，再点下面的按钮用 Face ID 确认。", "You chose \u{201C}Trust this payee\u{201D} in the notification. Check the full address and amount above, then tap the button below to confirm with Face ID.")
    case "once": return ("你在通知里选了「只付这一次」。先核对上面的完整地址和金额，再点下面的按钮用 Face ID 确认。", "You chose \u{201C}Pay just this once\u{201D} in the notification. Check the full address and amount above, then tap the button below to confirm with Face ID.")
    default: return nil
    }
  }
  /// t1246 F8: what a trust from this card lets the AI pay automatically, shown under the trust button before any Face ID.
  public static func trustCapsLine(_ c: (single: Int64, daily: Int64)) -> (zh: String, en: String) {
    let s = MoneyText.usdc(c.single), d = MoneyText.usdc(c.daily)
    return ("信任后 AI 最多自动付：每笔 \(s)，每天 \(d)", "After trusting, the AI can pay it automatically up to \(s) per payment, \(d) a day")
  }
  /// t1281 (decision 141 (3)): the card line under "[zh]" before any tap. Only what the phone itself enforces is stated as fact: the caps are
  /// UPPER bounds (the phone refuses a trust above them) and the trust always expires within 90 days (the phone refuses one without an
  /// expiry or longer than askTrustMaxDays). The exact signed caps + expiry date are only known after ask-prepare, so they go into the Face ID prompt (trustFaceIDReason).
  public static func trustCapsCardLine(_ c: (single: Int64, daily: Int64)) -> (zh: String, en: String) {
    let s = MoneyText.usdc(c.single), d = MoneyText.usdc(c.daily)
    return ("信任后 AI 最多自动付：每笔 \(s)，每天 \(d)（另加手续费；这是上限，实际可能更低）。信任最长 90 天后自动到期，可随时撤销",
            "After trusting, the AI can pay it automatically up to \(s) per payment, \(d) a day (plus fees; upper limits, the actual ones may be lower). The trust ends on its own within 90 days and you can remove it any time")
  }
  /// t1281: the Face ID prompt of "[zh]", built from the trust message the phone has just checked and will sign (exact caps + expiry),
  /// plus, when the same Face ID signs a merchant signer grant, that the merchant's orders may use any payee address.
  public static func trustFaceIDReason(_ m: OwnerTrustMessage, grantName: String?, grantSigned: Bool?, timeZone: TimeZone = .current) -> (zh: String, en: String) {
    let s = Int64(m.single).map(MoneyText.usdc) ?? "?", d = Int64(m.daily).map(MoneyText.usdc) ?? "?"
    let exp = trustExpiryText(m.expiry, timeZone: timeZone)
    let head: (String, String)
    if let n = grantName { head = grantSigned == false ? ("信任 \(n)（商家未签名，额度减半）并付这笔", "Trust \(n) (unsigned merchant, half limits) and pay") : ("信任 \(n) 并付这笔", "Trust \(n) and pay") }
    else { head = ("认识并信任，并付这笔", "Trust this payee and pay") }
    let any = grantName == nil ? ("", "") : ("；\(grantName!) 的订单每单收款地址可以不同，都算在内", "; orders from \(grantName!) may use any payee address and all count")
    return ("\(head.0)。信任额度：每笔最多 \(s)，每天最多 \(d)，\(exp.zh)\(any.0)", "\(head.1). Trust limits: up to \(s) per payment, \(d) a day, \(exp.en)\(any.1)")
  }
  /// "[zh]" / "ends Feb 22, 2027"; RequestVerify.noExpiry (inline reusable trust) -> never ends on its own.
  public static func trustExpiryText(_ expiry: String, timeZone: TimeZone = .current) -> (zh: String, en: String) {
    if expiry == RequestVerify.noExpiry { return ("不会自动到期，可随时撤销", "no end date, you can remove it any time") }
    guard let e = Double(expiry), e > 0, e < 4_102_444_800 else { return ("到期日未知", "end date unknown") }
    let date = Date(timeIntervalSince1970: e)
    func fmt(_ f: String, _ loc: String) -> String { let x = DateFormatter(); x.locale = Locale(identifier: loc); x.timeZone = timeZone; x.dateFormat = f; return x.string(from: date) }
    return (fmt("yyyy年M月d日", "zh_CN") + "到期", "ends " + fmt("MMM d, yyyy", "en_US_POSIX"))
  }
  /// Full address in groups of 4 for the card (what the owner compares).
  public static func grouped(_ a: String) -> String {
    let h = a.hasPrefix("0x") ? String(a.dropFirst(2)) : a
    var out = [String](); var cur = ""
    for c in h { cur.append(c); if cur.count == 4 { out.append(cur); cur = "" } }
    if !cur.isEmpty { out.append(cur) }
    return "0x " + out.joined(separator: " ")
  }
}
