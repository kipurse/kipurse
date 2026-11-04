import Foundation

/// The phone is NOT bound to the wallet (reinstall, new or lost phone): what the user sees and where it leads.
/// Face ID approvals only need the phone to be bound; Siri payments are a separate, optional upgrade.
public enum Unbound {
  /// resumeWithFaceID() result when this phone has no key the wallet knows (no key here, or server 409 no_phone_signer / 403 not_phone_signer).
  public static let notBound = -1
  /// Wallet the user signed in to (Coinbase) but this phone isn't bound to yet: kept so the emergency page knows which wallet.
  public static let walletKey = "kp.unbound.wallet", pathKey = "kp.unbound.path"
  public static func remember(wallet: String?, path: String?) {
    guard let w = wallet, w.count == 42, w.hasPrefix("0x") else { return }
    UserDefaults.standard.set(w, forKey: walletKey); UserDefaults.standard.set(path ?? ("/t/" + w.lowercased()), forKey: pathKey)
  }
  public static func forget() { UserDefaults.standard.removeObject(forKey: walletKey); UserDefaults.standard.removeObject(forKey: pathKey) }
  public static var wallet: String? { UserDefaults.standard.string(forKey: walletKey) }
  /// The emergency page of this wallet (Coinbase wallet signature only, no phone needed). nil when no wallet is known.
  public static func emergencyURL(base: URL, wallet: String?, path: String?) -> URL? {
    guard let w = wallet, w.count == 42, w.hasPrefix("0x") else { return nil }
    let p = (path?.isEmpty == false ? path! : "/t/" + w.lowercased()).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard p.range(of: #"^t/0x[0-9a-fA-F]{40}$"#, options: .regularExpression) != nil else { return nil }
    return base.appendingPathComponent(p).appendingPathComponent("owner/emergency")
  }
  public static var cardTitle: String { T("在这台 iPhone 上开启 Face ID 批准", "Turn on Face ID approvals on this iPhone") }
  public static var cardBody: String { T("重装 App 或换了新 iPhone 后，要重新开启一次。开启后，AI 想付给新商家或超出上限时，你用 Face ID 点一下就能同意。",
                                         "After reinstalling or on a new iPhone, turn it on once more. Then when your AI wants to pay a new shop or go over your limit, one Face ID tap says yes.") }
  /// UI tests that mock the sign-in answer keep the old offline path (no server session).
  /// UI test: show the wallet home as a bound:false (read-grant) session.
  public static var debugBoundFalse: Bool { CommandLine.arguments.contains("-kpBoundFalse") }
  /// t851: "this phone can open the wallet with ONE Face ID" — decided WITHOUT touching the Secure Enclave key (so no Face ID).
  /// Saved after a successful wallet session: approver phone = no expiry; Coinbase read grant (bound:false) = 30 days, like the server.
  public static let sessionMarkKey = "kp.sessionMark.until"
  public static var sessionMarkUsable: Bool {
    let t = UserDefaults.standard.double(forKey: sessionMarkKey); return t > 0 && Date().timeIntervalSince1970 < t }
  public static func saveSessionMark(bound: Bool) {
    UserDefaults.standard.set(bound ? Date.distantFuture.timeIntervalSince1970 : Date().addingTimeInterval(30 * 86400).timeIntervalSince1970, forKey: sessionMarkKey) }
  public static func clearSessionMark() { UserDefaults.standard.removeObject(forKey: sessionMarkKey) }
  public static var loginExpiredText: String { T("这台手机需要再用 Coinbase 登录一次。", "This phone needs one more Coinbase sign-in.") }
  public static var isMockSignin: Bool { CommandLine.arguments.contains("-kpSigninMock") }
  public static var bindLabel: String { T("开启 Face ID 批准", "Turn on Face ID approvals") }
  public static var siriLabel: String { T("更新 Face ID 批准（一次，手续费用 USDC 付）", "Update Face ID approvals (one time, fee in USDC)") }
  public static var emergencyLabel: String { T("没有手机或启付打不开？", "No phone, or Kipurse is down?") }
  public static var emergencyHint: String { T("没有 iPhone 也能用：在你的 Coinbase 账户里确认，就能暂停 AI、取消等待中的付款、把钱全部提现。", "Works without your iPhone: confirm in your Coinbase account to pause AI, cancel waiting payments or withdraw everything.") }
  public static var goBind: String { T("去开启", "Turn on") }
  /// What the user sees when resuming AI payments did not work.
  public static func resumeFailText(_ code: Int) -> String {
    switch code {
    case notBound: return T("没有恢复：这台 iPhone 还没开启 Face ID 批准。先开启，再来恢复。", "Not resumed: Face ID approvals aren't on for this iPhone yet. Turn them on first, then resume.")
    case 401: return T("请先用 Face ID 打开钱包再试。", "Open your wallet with Face ID first, then try again.")
    case 0: return T("没有恢复：你取消了 Face ID，或者没连上。请再试一次。", "Not resumed: Face ID was cancelled or the connection failed. Please try again.")
    default: return T("没有恢复（\(code)），请再试一次。", "Not resumed (\(code)). Please try again.")
    }
  }
  /// Phone-signer sheet: bind (Face ID approvals) vs. the optional Siri upgrade. The URL carries kpmode=siri for the upgrade.
  public static func isSiriUpgrade(_ url: URL) -> Bool { URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains { $0.name == "kpmode" && $0.value == "siri" } ?? false }
  public static func siriURL(_ url: URL) -> URL { guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }; let q = c.queryItems ?? []; c.queryItems = q + [URLQueryItem(name: "kpmode", value: "siri")]; return c.url ?? url }
}
