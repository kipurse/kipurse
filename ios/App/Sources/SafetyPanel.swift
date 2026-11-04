import SwiftUI
import LocalAuthentication
import CryptoKit
import KipurseCore

/// Safety: pause and withdraw side by side; delete account sits apart at the bottom (audit #9). Every one needs two confirmations: a dialog, then Face ID.
///  1. Pause AI payments for 24 h / 48 h / 7 days / until I resume (server + on-chain pause; resume early any time).
///  2. Withdraw ALL USDC to your own Coinbase wallet: opens the one withdraw screen (MainWithdrawView).
///  3. Delete account (warns to withdraw first if money is left).
struct SafetyPanel: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  /// .actions = pause + withdraw tiles; .delete = the danger-zone row (shown in its own section, far below); .all = both (simple mode).
  enum Part { case all, actions, delete }
  var part: Part = .all
  @State private var askPause = false
  @State private var askResume = false
  @State private var showWithdraw = false
  @State private var askDelete = false
  @State private var askDelete2 = false
  @State private var pause: Pause?
  @State private var busy: String?
  @State private var msg: String?
  @State private var needsBind = false
  struct Pause { let until: Date?; var reason: String? = nil }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if part != .delete {
      HStack(spacing: 10) {
        tile(pause == nil ? T("暂停 AI 付款", "Pause AI payments") : T("恢复 AI 付款", "Resume AI payments"),
             pause == nil ? "pause.circle.fill" : "play.circle.fill", pause == nil ? Brand.negative : Brand.positive, "safety.pause") { if pause == nil { askPause = true } else { askResume = true } }
      }
      Text(statusLine).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("safety.status")
      // #9: delete is far from pause / withdraw, at the bottom, and asks twice (dialog, then "type-free" second alert, then Face ID)
      }
      if part == .all { Divider().padding(.top, 18) }
      if part != .actions {
      Button(role: .destructive) { askDelete = true } label: { Label(T("删除账户", "Delete account"), systemImage: "trash").font(part == .delete ? .body : .footnote).foregroundStyle(Brand.negative) }.buttonStyle(.borderless).padding(.top, part == .delete ? 0 : 6).accessibilityIdentifier("safety.delete")
      }
    }
    .padding(.vertical, 4)
    .task { if part != .delete { await loadStatus() } }
    // 1. pause: dialog (pick how long) -> Face ID
    .confirmationDialog(T("暂停 AI 付款多久？", "Pause AI payments for how long?"), isPresented: $askPause, titleVisibility: .visible) {
      Button(T("24 小时", "24 hours")) { run { await doPause("24h") } }
      Button(T("48 小时", "48 hours")) { run { await doPause("48h") } }
      Button(T("7 天", "7 days")) { run { await doPause("7d") } }
      Button(T("一直暂停，直到我恢复", "Until I resume"), role: .destructive) { run { await doPause("until_resume") } }
      Button(T("取消", "Cancel"), role: .cancel) {}
    } message: { Text(T("暂停期间，所有 AI（包括 Siri）都不能付款。你自己充值、提现不受影响。恢复要用 Face ID。", "While paused, no AI (Siri included) can pay. Your own deposits and withdrawals still work. Resuming needs Face ID.")) }
    .confirmationDialog(T("恢复 AI 付款？", "Resume AI payments?"), isPresented: $askResume, titleVisibility: .visible) {
      Button(T("恢复", "Resume")) { run { await doResume() } }
      Button(T("取消", "Cancel"), role: .cancel) {}
    } message: { Text(T("恢复后，AI 可以在你设的上限内继续付款。", "AI can pay again, within your limits.")) }
    // 2. withdraw: the one withdraw screen (amount → your account → fee → button → confirm → Face ID → Coinbase confirm)
    .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in showWithdraw = false }
    .sheet(isPresented: $showWithdraw) { NavigationStack { MainWithdrawView(s: s).toolbar { Button(T("完成", "Done")) { showWithdraw = false }.accessibilityIdentifier("withdraw.close") } } }
    // 3. delete: dialog (warns if money is left) -> Face ID -> erase
    .confirmationDialog(T("删除账户？", "Delete your account?"), isPresented: $askDelete, titleVisibility: .visible) {
      if s.balance > 0 { Button(T("先提现", "Withdraw first")) { showWithdraw = true } }
      Button(T("删除账户", "Delete account"), role: .destructive) { askDelete2 = true }.accessibilityIdentifier("safety.deleteConfirm")
      Button(T("取消", "Cancel"), role: .cancel) {}
    } message: { Text(deleteText) }
    .alert(T("真的要删除账户吗？", "Really delete your account?"), isPresented: $askDelete2) {
      Button(T("确定删除", "Delete"), role: .destructive) { run { await doDelete() } }.accessibilityIdentifier("safety.deleteConfirm2")
      Button(T("不删除", "Keep my account"), role: .cancel) {}
    } message: { Text(T("删除后这台手机的登记会清掉，不能撤销。钱包里的钱不会消失，但请先提现。", "This phone's registration is erased and can't be undone. Money in the wallet doesn't disappear, but withdraw it first.")) }
    .alert(msg ?? "", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
      if needsBind { Button(Unbound.goBind) { needsBind = false; m.bindSheet = true }.accessibilityIdentifier("resume.bind") }
      Button(T("好", "OK"), role: needsBind ? .cancel : nil) { needsBind = false }
    }
  }

  private func tile(_ t: String, _ icon: String, _ c: Color, _ id: String, _ a: @escaping () -> Void) -> some View {
    Button(action: a) {
      VStack(spacing: 8) { Image(systemName: icon).font(.title).symbolRenderingMode(.hierarchical).foregroundStyle(c); Text(t).font(.subheadline.weight(.semibold)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true).foregroundStyle(.primary) }
        .frame(maxWidth: .infinity, minHeight: 84).padding(.vertical, 8).background(c.opacity(0.12), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }.buttonStyle(.plain).disabled(busy != nil).accessibilityIdentifier(id)
  }
  private var statusLine: String {
    if let b = busy { return b }
    guard let p = pause else { return T("AI 付款正常", "AI payments are on") }
    if let w = Self.autoReason(p.reason) { return w }
    guard let u = p.until else { return T("AI 付款已暂停，直到你恢复。", "AI payments are paused until you resume them.") }
    return T("AI 付款已暂停，到 \(Self.fmt(u)) 自动恢复。", "AI payments are paused until \(Self.fmt(u)).")
  }
  private var deleteText: String {
    let base = T("会删除我们服务器上你的记录，以及这台手机上的登录和数据。链上的公开记录删不掉。", "This deletes your records on our server and the login and data on this iPhone. Public on-chain records can't be deleted.")
    return s.balance > 0 ? T("钱包里还有 \(AnswerRules.format(s.balance)) USDC，建议先提现。\n", "Your wallet still has \(AnswerRules.format(s.balance)) USDC. Withdraw it first.\n") + base : base
  }
  /// Automatic safety pause (server anomaly rules): plain reason + how to resume.
  static func autoReason(_ r: String?) -> String? {
    switch r {
    case "too_many_new_payees": return T("为了安全，AI 付款已自动暂停：1 小时内出现了 3 个以上新收款方。确认没问题后，点“恢复 AI 付款”并用 Face ID 恢复。", "AI payments were paused for safety: 3 or more new payees within an hour. If that was you, tap Resume AI payments and use Face ID.")
    case "repeated_cap_hits": return T("为了安全，AI 付款已自动暂停：AI 多次碰到付款上限。确认没问题后，点“恢复 AI 付款”并用 Face ID 恢复。", "AI payments were paused for safety: the AI hit a limit several times. If that is fine, tap Resume AI payments and use Face ID.")
    case "large_outflow": return T("为了安全，AI 付款已自动暂停：24 小时内付出的钱超过余额一半。确认没问题后，点“恢复 AI 付款”并用 Face ID 恢复。", "AI payments were paused for safety: more than half of the balance went out within 24 hours. If that is fine, tap Resume AI payments and use Face ID.")
    case "too_many_payments", "daily_payment_count", "too_many_payees": return T("为了安全，AI 付款已自动暂停：短时间内付款次数太多。确认没问题后，点“恢复 AI 付款”并用 Face ID 恢复。", "AI payments were paused for safety: too many payments in a short time. If that is fine, tap Resume AI payments and use Face ID.")
    default: return nil
    }
  }
  static func fmt(_ d: Date) -> String { let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short; return f.string(from: d) }

  private func run(_ work: @escaping () async -> Void) { Task { await work() } }
  /// Second confirmation: Face ID (or the passcode).
  static func faceID(_ reason: String) async -> Bool {
    if DemoGuard.active { DemoGuard.say(); return true }
    let c = LAContext(); var e: NSError?
    guard c.canEvaluatePolicy(.deviceOwnerAuthentication, error: &e) else { return false }
    return (try? await c.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
  }
  /// Resume AI payments = a FRESH Face ID signature (phone signer, Secure Enclave) over a one-time server challenge.
  /// The phone checks SHA-256(signText) == digest and that the text names THIS wallet before signing. Returns the HTTP code (0 = canceled / local error).
  static func resumeWithFaceID() async -> Int {
    #if DEBUG
    if CommandLine.arguments.contains("-kpResumeUnbound") { return Unbound.notBound }   // UI test: reinstall / new phone
    #endif
    if DemoGuard.active { DemoGuard.say(); return 200 }
    guard PhoneKey.isPresent() else { return Unbound.notBound }   // no phone key here: Face ID can't resume -> say so, link to binding
    guard let (c0, ch) = try? await MainnetSession.authedPost("safety/resume", [:]) else { return MainnetSession.load() == nil ? 401 : 0 }
    if c0 == 200 { return 200 }
    if c0 == 409 || c0 == 403 { return Unbound.notBound }   // no_phone_signer / not_phone_signer
    guard c0 == 428, let n = ch["nonce"] as? String, let txt = ch["signText"] as? String, let dg = ch["digest"] as? String else { return c0 }
    let d = [UInt8](SHA256.hash(data: Data(txt.utf8)))
    guard Hex.encode(d).lowercased() == dg.lowercased(), txt == "Kipurse resume v1\nwallet:" + Operator.wallet.lowercased() + "\nnonce:" + n else { return 0 }
    guard let k = PhoneKey.existing() else { return 0 }
    guard let (r, s) = try? PhoneKey.sign(d, key: k) else { return 0 }
    return (try? await MainnetSession.authedPost("safety/resume", ["nonce": n, "r": Hex.encode(r), "s": Hex.encode(s)]))?.0 ?? 0
  }
  static func get(_ path: String) async throws -> (Int, [String: Any]) {
    guard let tok = MainnetSession.load() else { throw MainnetSession.Failure.needsSignIn }
    var r = URLRequest(url: Mainnet.server.appendingPathComponent(path)); r.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); r.timeoutInterval = 30; r.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
    let (d, resp) = try await URLSession.shared.data(for: r)
    return ((resp as? HTTPURLResponse)?.statusCode ?? 0, ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any]) ?? [:])
  }
  private func parsePause(_ j: [String: Any]?) -> Pause? {
    guard let p = j else { return nil }
    let r = p["reason"] as? String
    if let u = p["until"] as? Double { return Pause(until: Date(timeIntervalSince1970: u / 1000), reason: r) }
    return Pause(until: nil, reason: r)
  }
  private func loadStatus() async {
    #if DEBUG
    if CommandLine.arguments.contains("-kpResumeUnbound") { pause = Pause(until: nil); return }
    #endif
    guard let (c, j) = try? await Self.get("safety/status"), c == 200 else { return }
    pause = parsePause(j["paused"] as? [String: Any])
  }
  private func doPause(_ d: String) async {
    guard await Self.faceID(T("暂停 AI 付款", "Pause AI payments")) else { return }
    busy = T("正在暂停…", "Pausing…"); defer { busy = nil }
    do { let (c, j) = try await MainnetSession.authedPost("safety/stop", ["duration": d])
      if c == 200 { Haptics.success(); pause = parsePause(j["server"] as? [String: Any]) ?? Pause(until: nil)
        let chain = ((j["chain"] as? [String: Any])?["paused"] as? Bool) == true
        msg = chain ? T("已暂停。链上也已暂停。", "Paused. The wallet is paused on chain too.") : T("已暂停 AI 付款。链上暂停这次没成功，会自动再试。", "AI payments are paused. The on-chain pause didn't go through this time; it will retry.") }
      else { msg = c == 401 ? T("请先用 Face ID 打开钱包再试。", "Open your wallet with Face ID first, then try again.") : T("没有成功（\(c)），请再试一次。", "That didn't work (\(c)). Please try again.") }
    } catch { msg = T("请先用 Face ID 打开钱包再试。", "Open your wallet with Face ID first, then try again.") }
  }
  private func doResume() async {
    busy = T("正在恢复…", "Resuming…"); defer { busy = nil }
    let c = await Self.resumeWithFaceID()
    if c == 200 { Haptics.success(); pause = nil; msg = T("已恢复 AI 付款。", "AI payments are back on.") }
    else { needsBind = c == Unbound.notBound; msg = Unbound.resumeFailText(c) }
  }
  private func doDelete() async {
    guard await Self.faceID(T("删除账户", "Delete account")) else { return }
    await m.eraseMainnetEverything()
  }
}

/// Payments over 20 USDC to a payee not on the trust list wait 10 minutes on the server. The owner can cancel them here.
struct HoldsCard: View {
  struct Hold: Identifiable { let id: String; let amount: Int64; let payee: String; let item: String?; let releaseAt: Date; var name: String? = nil }
  @State private var holds: [Hold] = []
  @State private var ask: Hold?
  @State private var msg: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(holds) { h in
        VStack(alignment: .leading, spacing: 6) {
          HStack { Label(T("一笔大额付款等待中", "A large payment is on hold"), systemImage: "hourglass").font(.subheadline.weight(.semibold)).foregroundStyle(.orange); Spacer()
            TimelineView(.periodic(from: .now, by: 1)) { c in Text(Self.left(h.releaseAt, now: c.date)).font(.subheadline.monospacedDigit().weight(.bold)).foregroundStyle(.orange).accessibilityIdentifier("hold.countdown") } }
          Text(T("AI 要付 \(AnswerRules.format(h.amount)) USDC", "The AI wants to pay \(AnswerRules.format(h.amount)) USDC") + (h.name.map { T(" 给 ", " to ") + $0 } ?? "") + (h.item.map { T("，买：", " for ") + $0 } ?? "")).font(.footnote)
          Text(fullAddr(h.payee)).font(.caption.monospaced()).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("hold.payee.full")
          Text(T("如果不取消，\(SafetyPanel.fmt(h.releaseAt)) 自动付款。", "If you don't cancel, it is paid at \(SafetyPanel.fmt(h.releaseAt)).")).font(.caption).foregroundStyle(.secondary)
          Button(role: .destructive) { ask = h } label: { Text(T("取消这笔付款", "Cancel this payment")).frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).tint(.red).accessibilityIdentifier("hold.cancel")
        }.padding(12).background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 14)).accessibilityElement(children: .contain).accessibilityIdentifier("hold.banner")
      }
    }
    .task { await load() }
    .confirmationDialog(T("取消这笔付款？", "Cancel this payment?"), isPresented: Binding(get: { ask != nil }, set: { if !$0 { ask = nil } }), titleVisibility: .visible) {
      Button(T("取消付款", "Cancel payment"), role: .destructive) { if let h = ask { Task { await cancel(h) } } }
      Button(T("不取消", "Keep it"), role: .cancel) {}
    } message: { Text(T("取消后不会付款，AI 会收到“已取消”。", "Nothing will be paid; the AI is told it was canceled.")) }
    .alert(msg ?? "", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) { Button(T("好", "OK")) {} }
  }
  static func left(_ t: Date, now: Date) -> String { let s = max(0, Int(t.timeIntervalSince(now))); return String(format: "%d:%02d", s / 60, s % 60) }
  private func load() async {
    #if DEBUG
    if CommandLine.arguments.contains("-kpHold") { if holds.isEmpty { holds = [Hold(id: "demo-hold", amount: 500_000_000, payee: "0x2222222222222222222222222222222222222222", item: T("年度会员", "Annual plan"), releaseAt: Date().addingTimeInterval(600), name: "Example Shop")] }; return }
    #endif
    await PushBridge.upload()
    guard let (c, j) = try? await SafetyPanel.get("safety/holds"), c == 200, let a = j["holds"] as? [[String: Any]] else { return }
    holds = a.compactMap { x in
      guard let id = x["id"] as? String, let p = x["payee"] as? String, let amt = Int64((x["amount"] as? String) ?? ""), let r = x["releaseAt"] as? Double else { return nil }
      return Hold(id: id, amount: amt, payee: p, item: x["item"] as? String, releaseAt: Date(timeIntervalSince1970: r / 1000), name: x["name"] as? String)
    }
  }
  private func cancel(_ h: Hold) async {
    #if DEBUG
    if h.id == "demo-hold" { Haptics.success(); holds.removeAll { $0.id == h.id }; msg = T("已取消，这笔没有付款。", "Canceled. Nothing was paid."); return }
    #endif
    if let (c, _) = try? await MainnetSession.authedPost("safety/holds/cancel", ["id": h.id]), c == 200 { Haptics.success(); holds.removeAll { $0.id == h.id }; msg = T("已取消，这笔没有付款。", "Canceled. Nothing was paid.") }
    else { msg = T("没有取消成功，可能已经付款或已过期，请看记录。", "Couldn't cancel. It may already be paid; check your activity."); await load() }
  }
}

