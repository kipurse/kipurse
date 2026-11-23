// Awareness: a notification for every AI payment, actionable "Approve with Face ID" requests, the home-screen widget
// snapshot and the lock-screen Live Activity. Remote push (APNs) can replace the polling source later; the presentation
// code is the same (see docs/NOTIFICATIONS.md).
import SwiftUI
import UserNotifications
import WidgetKit
import KipurseCore
#if canImport(ActivityKit)
import ActivityKit
#endif

enum Awareness {
  static let approveAction = "KP_APPROVE", openAction = "KP_OPEN", approvalCategory = "KP_APPROVAL", paymentCategory = "KP_PAYMENT"
  static func registerCategories() {
    let approve = UNNotificationAction(identifier: approveAction, title: T("查看并批准", "Review and approve"), options: [.authenticationRequired, .foreground])   // t1266 (F9): opens the card, approves nothing
    let open = UNNotificationAction(identifier: openAction, title: T("查看", "View"), options: [.foreground])
    let report = UNNotificationAction(identifier: "KP_REPORT", title: T("有问题？", "Something wrong?"), options: [.foreground])
    UNUserNotificationCenter.current().setNotificationCategories(Set([
      UNNotificationCategory(identifier: approvalCategory, actions: [approve, open], intentIdentifiers: []),
      UNNotificationCategory(identifier: paymentCategory, actions: [open, report], intentIdentifiers: [])]).union(PushBridge.categories()))
  }
  /// New settled payments since last time (ids persisted so a relaunch doesn't re-notify).
  static func newPayments(_ txs: [Tx]) -> [Tx] {
    let key = "seenPayments"; let seen = Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
    let first = UserDefaults.standard.object(forKey: key) == nil
    UserDefaults.standard.set(txs.map(\.id), forKey: key)
    return first ? [] : txs.filter { !seen.contains($0.id) && !$0.failed }
  }
  static func notifyPayment(_ t: Tx) {
    let c = UNMutableNotificationContent()
    c.title = T("\(t.agent) 付了 \(money(t.amount))", "\(t.agent) paid \(money(t.amount))")
    c.body = T("付给 \(t.merchantName)。点开看收据。", "To \(t.merchantName). Tap for the receipt.")
    c.sound = .default; c.categoryIdentifier = paymentCategory; c.threadIdentifier = "payments"; c.userInfo = ["tx": t.id]
    if #available(iOS 15.0, *) { c.interruptionLevel = .active; c.relevanceScore = 0.6 }
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "pay:" + t.id, content: c, trigger: nil))
  }
  static func notifyApproval(_ a: Approval) {
    let c = UNMutableNotificationContent(); c.title = "Kipurse · " + a.titleZh; c.body = a.bodyZh; c.sound = .default
    c.categoryIdentifier = approvalCategory; c.userInfo = ["approval": a.id]
    if #available(iOS 15.0, *) { c.interruptionLevel = .timeSensitive }
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: a.id, content: c, trigger: nil))
  }
  static func publish(_ s: WalletState) {
    let today = s.txs.filter { !$0.failed && ($0.date.map(Calendar.current.isDateInToday) ?? false) }
    let last = s.txs.first { !$0.failed }
    SharedSpend.save(.init(balance: s.balance, spentToday: s.spentToday, dailyLimit: s.mainDaily ?? 0, lastAgent: last?.agent, lastAmount: last?.amount, lastAt: last?.date, paymentsToday: today.count, pending: s.approvals.count, chinese: Loc.isChinese, updated: Date()))
    WidgetCenter.shared.reloadAllTimelines()
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) { LiveSpend.update(s, today: today.count, last: last) }
    #endif
  }
  static func wipe() { SharedSpend.clear(); WidgetCenter.shared.reloadAllTimelines()
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) { LiveSpend.endAll() }
    #endif
  }
}

#if canImport(ActivityKit)
@available(iOS 16.2, *)
enum LiveSpend {
  static var enabled: Bool { UserDefaults.standard.object(forKey: "kp.live") as? Bool ?? true }
  /// One Live Activity while the AI has spent something today; ends at midnight / when nothing was spent.
  static func update(_ s: WalletState, today: Int, last: Tx?) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    let st = SpendActivityAttributes.ContentState(spentToday: s.spentToday, dailyLimit: s.mainDaily ?? 0, lastAgent: last?.agent ?? "AI", lastAmount: last?.amount ?? 0, pending: s.approvals.count, chinese: Loc.isChinese)
    let running = Activity<SpendActivityAttributes>.activities
    if !enabled || (today == 0 && s.approvals.isEmpty) { endAll(); return }
    let content = ActivityContent(state: st, staleDate: Calendar.current.startOfDay(for: Date()).addingTimeInterval(86400))
    if let a = running.first { Task { await a.update(content) } }
    else { _ = try? Activity.request(attributes: SpendActivityAttributes(title: "Kipurse"), content: content) }
  }
  static func endAll() { for a in Activity<SpendActivityAttributes>.activities { Task { await a.end(nil, dismissalPolicy: .immediate) } } }
}
#endif

/// Routes notification actions: "Approve with Face ID" opens the app and runs the normal Face ID-gated approval.
final class NotificationRouter: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NotificationRouter()
  weak var model: AppModel?
  // t1220u §6#96: the async versions of these two callbacks finished on a background thread and handed iOS its completion there;
  // UIKit then aborted the App ("closed right after tapping the push"). Completion-handler versions: the work runs on the main
  // thread and iOS is told "done" there, after the App has switched to the right page.
  func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    let info = n.request.content.userInfo, body = n.request.content.body
    Task { @MainActor in AllowanceStore.shared.remember(info, body: body); await AllowanceStore.shared.load() }   // t1220u §6#96: arrives while open -> Home card now
    done([.banner, .sound, .list])
  }
  func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    let info = r.notification.request.content.userInfo, action = r.actionIdentifier, body = r.notification.request.content.body
    Task { @MainActor in
      defer { done() }
      guard let m = self.model else { return }
      if await PushBridge.route(info, action: action, body: body, model: m) { return }
      if info["approval"] is String {
        m.pendingTab = "approvals"   // t1266 (F9 rule): a notification button only OPENS the full card; approving happens there with the full details on screen
      } else if let tx = info["tx"] as? String { m.pendingTab = "activity"; m.openTx = tx; if action == "KP_REPORT" { m.reportTx = tx } }
    }
  }
}

/// Payment success moment: check mark draws in, amount counts, receipt card slides up.
struct PaymentToast: View {
  let t: Tx; var name: String? = nil; var done: () -> Void
  @State private var drawn = false
  var body: some View {
    VStack(spacing: 14) {
      ZStack {
        Circle().fill(Brand.positive.opacity(0.15)).frame(width: 84, height: 84).scaleEffect(drawn ? 1 : 0.4)
        Image(systemName: "checkmark").font(.system(size: 38, weight: .bold)).foregroundStyle(Brand.positive).scaleEffect(drawn ? 1 : 0.2).opacity(drawn ? 1 : 0)
      }
      Text(T("\(name ?? t.agent) 付好了", "\(name ?? t.agent) paid")).font(.headline)
      Text(money2(t.amount)).font(Brand.money(38)).modifier(RollingNumber(value: drawn ? Double(t.amount) : 0))
      Text(Cheer.line(id: t.id, chinese: Loc.isChinese)).font(.subheadline.weight(.semibold))
        .foregroundStyle(LinearGradient(colors: [Color(hex: 0xA78BFA), Color(hex: 0x22D3EE)], startPoint: .leading, endPoint: .trailing)).accessibilityIdentifier("celebrate.cheer")
      HStack { Image(systemName: t.merchantVerified ? "checkmark.seal.fill" : "storefront"); Text(t.merchantName) }.font(.subheadline).foregroundStyle(t.merchantVerified ? Brand.positive : .secondary)
      Button(T("查看收据", "View receipt")) { done() }.font(.subheadline.weight(.semibold)).padding(.top, 4)
    }
    .padding(28).frame(maxWidth: 320).background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: KP.Radius.hero, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: KP.Radius.hero, style: .continuous).strokeBorder(LinearGradient(colors: [Color(hex: 0xA78BFA).opacity(0.9), Color(hex: 0x22D3EE).opacity(0.5), .clear], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1.5))
    .shadow(color: Color(hex: 0x8B5CF6).opacity(0.45), radius: 40, y: 10)
    .onAppear { withAnimation(.spring(response: 0.45, dampingFraction: 0.6)) { drawn = true } }
  }
}
