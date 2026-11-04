import SwiftUI
import UIKit
import UserNotifications
import KipurseCore

/// APNs: the device token goes to the wallet server (phone session) so it can push new-payee confirmations, 10-minute holds and
/// safety pauses. Works only once the owner adds the APNs key on the server; the in-app cards are always the fallback.
final class PushAppDelegate: NSObject, UIApplicationDelegate {
  func application(_ app: UIApplication, didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    if !CommandLine.arguments.contains("-demo") { app.registerForRemoteNotifications() }
    return true
  }
  func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken t: Data) {
    let hex = t.map { String(format: "%02x", $0) }.joined(); UserDefaults.standard.set(hex, forKey: "apnsToken"); Task { await PushBridge.upload() }
  }
  func application(_ app: UIApplication, didFailToRegisterForRemoteNotificationsWithError e: Error) {}
}
enum PushBridge {
  static func upload() async {
    guard let t = UserDefaults.standard.string(forKey: "apnsToken"), UserDefaults.standard.string(forKey: "apnsSent") != t else { return }
    if let (c, _) = try? await MainnetSession.authedPost("phone/push/register", ["token": t, "lang": Loc.isChinese ? "zh" : "en"]), c == 200 { UserDefaults.standard.set(t, forKey: "apnsSent") }
  }
  static let confirmCategory = "KP_PAYEE_CONFIRM", holdCategory = "KP_HOLD", anomalyCategory = "KP_ANOMALY", mandateCategory = "KP_MANDATE", cancelHold = "KP_HOLD_CANCEL", confirmAction = "KP_CONFIRM"
  static func categories() -> [UNNotificationCategory] {
    let confirm = UNNotificationAction(identifier: confirmAction, title: T("用 Face ID 确认", "Confirm with Face ID"), options: [.authenticationRequired, .foreground])
    let cancel = UNNotificationAction(identifier: cancelHold, title: T("取消付款", "Cancel payment"), options: [.authenticationRequired, .destructive])
    let open = UNNotificationAction(identifier: Awareness.openAction, title: T("查看", "View"), options: [.foreground])
    return [UNNotificationCategory(identifier: confirmCategory, actions: [confirm, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: holdCategory, actions: [cancel, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: anomalyCategory, actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: mandateCategory, actions: [open], intentIdentifiers: [])]
  }
  /// Returns true when the notification was a server push and has been handled.
  @MainActor static func route(_ info: [AnyHashable: Any], action: String, model: AppModel) async -> Bool {
    guard let kp = info["kp"] as? [String: Any], let kind = kp["kind"] as? String else { return false }
    switch kind {
    case "payee_confirm":
      if let id = kp["trustRequestId"] as? String, let u = URL(string: "kipurse://approve-trust?id=\(id)") { model.handle(url: u) }   // -> name, amount, full address, Face ID
    case "hold":
      if action == cancelHold, let id = kp["holdId"] as? String { _ = try? await MainnetSession.authedPost("safety/holds/cancel", ["id": id]) }
      else { model.pendingTab = "home" }
    case "mandate":   // AI asks for an allowance / one payment -> the list with Face ID approve
      model.pendingTab = "home"; AllowanceStore.shared.open = true; Task { await AllowanceStore.shared.load() }
    default: model.pendingTab = "home"
    }
    return true
  }
}
