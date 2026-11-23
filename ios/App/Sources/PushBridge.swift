import SwiftUI
import UIKit
import UserNotifications
import KipurseCore

/// APNs: the device token goes to the wallet server (phone session) so it can push new-payee confirmations, 10-minute holds and
/// safety pauses. Works only once the owner adds the APNs key on the server; the in-app cards are always the fallback.
final class PushAppDelegate: NSObject, UIApplicationDelegate {
  func application(_ app: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    if !LaunchFlags.has("-demo") { app.registerForRemoteNotifications(); Task { await PushBridge.ensurePermission() } }   // t1208u §6#94: ask on launch if a session / wallet exists and iOS has not decided
    #if DEBUG
    // t1220u §6#96 (tests only): post the SAME notification the server sends for an AI payment request (kind=mandate, KP_MANDATE),
    // so a UI test can tap it like the owner did. Never in Release.
    if CommandLine.arguments.contains("-kpPushTapTest") { Task { await PushBridge.debugMandateNotification() } }
    #endif
    return true
  }
  func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken t: Data) {
    let hex = t.map { String(format: "%02x", $0) }.joined(); UserDefaults.standard.set(hex, forKey: "apnsToken"); Task { await PushBridge.upload() }
  }
  func application(_ app: UIApplication, didFailToRegisterForRemoteNotificationsWithError e: Error) {}
}
enum PushBridge {
  #if DEBUG
  static func debugMandateNotification() async {
    let c = UNUserNotificationCenter.current()
    _ = try? await c.requestAuthorization(options: [.alert, .sound, .badge])
    let n = UNMutableNotificationContent()
    n.title = T("AI 请求付款 / 额度（AI 可能被骗）", "AI payment request (the AI could be tricked)")
    n.body = T("AI 请求：⚠️ 新收款方 shop.example，付 5 USDC（日常）", "AI request: ⚠️ NEW payee shop.example, 5 USDC (Everyday)")
    n.sound = .default; n.categoryIdentifier = "KP_MANDATE"; n.userInfo = ["kp": ["kind": "mandate", "approvalId": "demo-apr"]]
    try? await c.add(UNNotificationRequest(identifier: "kp-t1211-mandate", content: n, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 12, repeats: false)))
  }
  #endif
  /// t1208u / handbook §6#94: the Coinbase / mainnet flow never asked iOS for notification permission, so server pushes were received
  /// but never shown. Ask once (system prompt only, no UI change) when a mainnet session or bound wallet exists; after a grant register
  /// with APNs and upload the token. Called on launch and right after a new phone session is saved.
  static func ensurePermission() async {
    let demo = DemoGuard.active || CommandLine.arguments.contains("-demo") || CommandLine.arguments.contains("-wipeSelfTest") || CommandLine.arguments.contains(where: { $0.hasPrefix("-kp") })   // demo + UI-test launches never see the system prompt (t1275: a Release build strips these flags at launch, LaunchFlags.releaseStrip)   // demo + UI-test launches never see the system prompt
    if demo { return }
    let c = UNUserNotificationCenter.current()
    var st = status(await c.notificationSettings().authorizationStatus)
    if PushPermission.shouldAsk(status: st, hasSession: MainnetSession.load() != nil, walletBound: !Operator.wallet.isEmpty, demo: demo) {
      _ = try? await c.requestAuthorization(options: [.alert, .sound, .badge])
      st = status(await c.notificationSettings().authorizationStatus)
    }
    if PushPermission.shouldRegister(status: st, demo: demo) { await MainActor.run { UIApplication.shared.registerForRemoteNotifications() } }
    await upload()
  }
  static func status(_ s: UNAuthorizationStatus) -> PushPermission.Status {
    switch s { case .authorized: return .authorized; case .denied: return .denied; case .provisional: return .provisional; case .ephemeral: return .ephemeral; default: return .notDetermined }
  }
  static func upload() async {
    let w = Operator.wallet   // t1239 §6#109: per wallet - a moved / different wallet gets the same token uploaded again
    guard PushPermission.shouldUpload(token: UserDefaults.standard.string(forKey: "apnsToken"), lastSent: UserDefaults.standard.string(forKey: "apnsSent"), hasSession: MainnetSession.load() != nil, wallet: w),
          let t = UserDefaults.standard.string(forKey: "apnsToken") else { return }
    // t1243 (§6#113): the token this phone uploaded before leaves this wallet's list (one push per phone)
    var body: [String: Any] = ["token": t, "lang": Loc.isChinese ? "zh" : "en"]
    if let old = PushPermission.replacedToken(lastSent: UserDefaults.standard.string(forKey: "apnsSent"), newToken: t) { body["replaces"] = old }
    if let (c, _) = try? await MainnetSession.authedPost("phone/push/register", body), c == 200 { UserDefaults.standard.set(PushPermission.sentKey(token: t, wallet: w), forKey: "apnsSent") }
  }
  static let confirmCategory = "KP_PAYEE_CONFIRM", holdCategory = "KP_HOLD", anomalyCategory = "KP_ANOMALY", mandateCategory = "KP_MANDATE", askCategory = "KP_ASK", askTrust = "KP_ASK_TRUST", askOnce = "KP_ASK_ONCE", cancelHold = "KP_HOLD_CANCEL", confirmAction = "KP_CONFIRM"
  static func categories() -> [UNNotificationCategory] {
    let confirm = UNNotificationAction(identifier: confirmAction, title: T("用 Face ID 确认", "Confirm with Face ID"), options: [.authenticationRequired, .foreground])
    let cancel = UNNotificationAction(identifier: cancelHold, title: T("取消付款", "Cancel payment"), options: [.authenticationRequired, .destructive])
    let open = UNNotificationAction(identifier: Awareness.openAction, title: T("查看", "View"), options: [.foreground])
    // t1170u (§6#82): "do you know this payee?" -> opens the card; Face ID happens in the app (the AI can never approve)
    let trust = UNNotificationAction(identifier: askTrust, title: T("认识并信任", "Trust this payee"), options: [.authenticationRequired, .foreground])
    let once = UNNotificationAction(identifier: askOnce, title: T("只付这一次", "Pay just this once"), options: [.authenticationRequired, .foreground])
    return [UNNotificationCategory(identifier: confirmCategory, actions: [confirm, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: holdCategory, actions: [cancel, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: anomalyCategory, actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: mandateCategory, actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: askCategory, actions: [trust, once, open], intentIdentifiers: [])]
  }
  /// Returns true when the notification was a server push and has been handled.
  @MainActor static func route(_ info: [AnyHashable: Any], action: String, body: String = "", model: AppModel) async -> Bool {
    guard let kp = info["kp"] as? [String: Any], let kind = kp["kind"] as? String else { return false }
    AllowanceStore.shared.remember(info, body: body)   // t1220u §6#96: Home shows it under 「待你批准」 even before the server list is read
    switch kind {
    case "payee_confirm":
      if let id = kp["trustRequestId"] as? String, let u = URL(string: "kipurse://approve-trust?id=\(id)") { model.handle(url: u) }   // -> name, amount, full address, Face ID
    case "hold":
      if action == cancelHold, let id = kp["holdId"] as? String { _ = try? await MainnetSession.authedPost("safety/holds/cancel", ["id": id]) }
      else { model.pendingTab = "home" }
    case "mandate":   // AI asks for an allowance / one payment -> the list with Face ID approve
      model.pendingTab = "home"; AllowanceStore.shared.open = true; Task { await AllowanceStore.shared.load() }
    case "owner_ask":   // t1170u: open the card; t1246 F9: 认识并信任 / 只付这一次 only mark the choice on the card — the owner taps there for Face ID
      model.pendingTab = "home"; AllowanceStore.shared.open = true
      let id = kp["approvalId"] as? String; let mode = action == askTrust ? "trust" : action == askOnce ? "once" : nil
      Task { await AllowanceStore.shared.load(); if let id, let mode { AllowanceStore.shared.pendingAsk = (id, mode) } }
    case "auto_paid": model.pendingTab = "activity"   // t1241 §6#111: 已自动付 X USDC 给 <domain> -> the records
    case "merchant_paused": model.pendingTab = "home"   // t1241: auto-pay to <domain> paused -> AI 生活 (trusted merchants)
    default: model.pendingTab = "home"
    }
    return true
  }
}
