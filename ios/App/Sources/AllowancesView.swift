import SwiftUI
import UserNotifications
import CryptoKit
import LocalAuthentication
import KipurseCore

/// ONE LIMIT (owner 2026-10-27 t592u): the wallet's AI payment limit (home card) is the ONLY limit. This screen shows the AI's
/// requests (approve with Face ID), approved renewals, the per-AI stop buttons and spending sorted AUTOMATICALLY into
/// categories (日常/学习/宣传推广/开发/工作/其他). Categories are labels only, never limits. Approving = the phone signer signs the exact request text (the server re-checks the signature).
/// Stopping an allowance or one AI only needs Face ID on the phone (it can only make things safer).
struct AllowanceItem: Identifiable { let id: String; let purpose: String; let name: String; let line: String; let leftToday: String; let leftMonth: String; let kind: String }
struct ApprovalReq: Identifiable { let id: String; let by: String; let lines: [String]; let digest: String; let signText: String; let reason: String; let userRequest: String; var ask: AskInfo? = nil; var fromPush = false; var details: [AllowanceText.Detail] = [] }   // t1281 §6#141 ③: details only from the parsed SIGNED text   // t1220u §6#96: fromPush = known only from the push (no server session yet)
/// t1170u (§6#82): "do you know this payee?" card data (new payee above the AI auto limit): full payee address + amount (base units).
struct AskInfo { let payee: String; let amount: String; var domain: String? = nil; var merchantSigned: Bool? = nil; var dup = false }   // t1280: dup only from the SIGNED text   // t1241 §6#111: trust <domain>, merchant signs or not
struct AgentCapRow: Identifiable { let id: String; let name: String; let stopped: Bool; let spentToday: String?; var single: String? = nil; var daily: String? = nil; var monthly: String? = nil }   // t899: this AI's own allowance
struct DefaultAllowance: Identifiable { var id: String { purpose }; let purpose: String; let name: String; let single: String; let daily: String; let monthly: String; var on: Bool }

@MainActor final class AllowanceStore: ObservableObject {
  static let shared = AllowanceStore()
  @Published var items: [AllowanceItem] = []
  @Published var approvals: [ApprovalReq] = []
  @Published var agents: [AgentCapRow] = []
  @Published var defaults: [DefaultAllowance] = []
  @Published var overall: String?
  /// t1245 (§6#115 U16): the same overall limit as numbers, so the sheet and the AI 花钱上限 page read ONE source.
  @Published var overallAtomic: AISpendLimits.Saved?
  @Published var loaded = false
  @Published var open = false
  @Published var reportLines: [(String, String)] = []
  @Published var reportTotal = ""
  @Published var csv = ""
  @Published var pendingAsk: (id: String, mode: String)? = nil
  @Published var focusAsk: (id: String, mode: String)? = nil   // t1246 F9: the card the push opened + the choice tapped there (shown, not signed)   // t1170u: push action 认识并信任 / 只付这一次 -> this card, Face ID in the app
  private var demoFilled = false
  /// t1220u (§6#96): requests the server pushed (kind mandate / owner_ask), kept until the server list can be read. Opening the App
  /// never asks for Face ID (0A#2), so without a live session this is the only way Home can show them under 「待你批准」.
  private static let hintsKey = "kp.pendingPushHints"
  private var hints: [PendingPushHint] { get { PendingPushHints.decode(UserDefaults.standard.data(forKey: Self.hintsKey)) } set { UserDefaults.standard.set(PendingPushHints.encode(newValue), forKey: Self.hintsKey) } }
  private(set) var lastLoadOK = false
  private var lastLoadAt = Date.distantPast
  /// t1243 (§6#113): the Face ID of a sign-in on an approval path, kept <= 60 s for the approval the owner taps next on the full card (UnlockReuse rules)
  let signInUnlock = ReusableUnlock<LAContext>(discard: { $0.invalidate() })
  func remember(_ info: [AnyHashable: Any], body: String, at: Date = Date()) {
    guard let h = PendingPushHints.hint(userInfo: info, body: body, at: at) else { return }
    hints = PendingPushHints.merge(hints, [h], now: Date()); showHints()
  }
  /// pushes still in Notification Center (the owner may open the App from its icon instead of the push)
  private func collectDelivered() async {
    let ns = await UNUserNotificationCenter.current().deliveredNotifications()
    let new = ns.compactMap { PendingPushHints.hint(userInfo: $0.request.content.userInfo, body: $0.request.content.body, at: $0.date) }
    if !new.isEmpty { hints = PendingPushHints.merge(hints, new, now: Date()) }
  }
  private func showHints() {
    let server = approvals.filter { !$0.fromPush }
    let extra = PendingPushHints.extra(hints, known: Set(server.map(\.id)), now: Date()).map {
      ApprovalReq(id: $0.id, by: "AI", lines: [$0.text], digest: "", signText: "", reason: "", userRequest: "", fromPush: true) }
    approvals = server + extra
  }
  /// t1266 (fix 8): forget everything that belonged to the wallet being left (sign-out / followed move).
  func resetWalletScoped() {
    signInUnlock.clear(); items = []; approvals = []; agents = []; defaults = []; overall = nil; overallAtomic = nil
    reportLines = []; reportTotal = ""; csv = ""; pendingAsk = nil; focusAsk = nil; hints = []
    loaded = false; lastLoadOK = false; lastLoadAt = .distantPast; demoFilled = false
  }
  /// Reload with the wallet refresh (live session only); at most every 20 s.
  func loadIfStale() async { if Date().timeIntervalSince(lastLoadAt) > 20 { await load() } }
  /// A user tap (approve / decline) may ask for Face ID; opening the App never does (0A#2).
  /// t1243 (§6#113): with the session missing / expired, ONE evaluated LAContext signs the session in and is held (<= 60 s, single use)
  /// so the approval the owner then taps on the full card reuses it instead of a second Face ID. With a session: unchanged.
  /// t1266 (fix 10): a held context is bound to `tag` ("<id>|<mode>") and only that approval may take it.
  private func ensureSession(reason: String? = nil, keepForApproval: Bool = false, tag: String? = nil) async -> Bool {
    await FaceIDUnlock.ensure()   // t1255 §6#124: Face ID locked by iOS -> passcode unlocks Face ID only (approves nothing)
    if MainnetSession.load() != nil { return true }
    let ctx = LAContext(); ctx.localizedCancelTitle = T("取消", "Cancel"); var e: NSError?
    guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e) else { ctx.invalidate(); return (try? await MainnetSession.signIn()) != nil }
    AuthLog.note("approve", "faceid-1 start")   // t1256
    guard (try? await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason ?? T("登录后查看并批准这个请求", "Sign in to review and approve this request"))) == true,
          (try? await MainnetSession.signIn(context: ctx)) != nil else { ctx.invalidate(); return false }
    PromptLog.add("session")
    guard keepForApproval else { ctx.invalidate(); return true }
    signInUnlock.hold(ctx, at: Date(), tag: tag)
    Task { @MainActor [weak self] in try? await Task.sleep(nanoseconds: UInt64((UnlockReuse.window + 1) * 1_000_000_000)); self?.signInUnlock.expire(now: Date()) }
    return true
  }
  /// A request known only from the push: sign in (one Face ID), read the server's request. Approve never signs from the push card
  /// (t1278 A1: it showed only the push text): the card re-renders from the real request and the owner approves on that full card.
  func resolvePushed(_ a: ApprovalReq, approve doApprove: Bool) async -> String? {
    if DemoGuard.active { DemoGuard.say(); return nil }
    // t1266 (fix 10/11): the sign-in Face ID is bound to THIS request; the owner has not picked trust / once yet ("|*").
    guard await ensureSession(keepForApproval: doApprove, tag: PushedApproval.heldTag(id: a.id)) else { return T("已取消。", "Canceled.") }
    await load()
    guard lastLoadOK else { signInUnlock.clear(); return T("暂时读不到这个请求，请稍后再试。", "Couldn't load this request right now. Please try again shortly.") }
    guard let real = approvals.first(where: { $0.id == a.id && !$0.fromPush }) else { signInUnlock.clear(); return T("这个请求已经处理过了，或已过期。", "This request was already handled or has expired.") }
    switch PushedApproval.next(approve: doApprove) {
    case .showFullCard:   // t1278 (A1): the card now shows the real request's own lines (or 认识并信任 / 只付这一次 / 拒绝 for §6#82); nothing signed yet.
      return nil          // the owner's tap there may reuse this sign-in's Face ID (<= 60 s, this request only; t1243 / t1266)
    case .reject:
      signInUnlock.clear()
      await reject(real); return nil
    }
  }
  /// The owner tapped Approve on a full card: reuses the Face ID of a sign-in made for THIS request in the last 60 s (push path), else asks.
  func approveTapped(_ a: ApprovalReq) async -> String? {
    await approve(a, context: signInUnlock.take(now: Date(), userTapped: true, tag: PushedApproval.approveTag(id: a.id)))
  }

  static func purposeName(_ k: String) -> String {
    switch k { case "daily": return T("日常", "Everyday"); case "study": return T("学习", "Study"); case "promo": return T("宣传推广", "Promotion"); case "dev": return T("开发", "Development")
    case "work": return T("工作", "Work"); case "subscription": return T("订阅续费", "Subscriptions"); case "transfer": return T("转账给熟人", "Friends & family")
    case "other": return T("其他", "Other"); case "all": return T("AI 付款上限", "AI payment limit"); default: return k }
  }
  private static func s(_ v: Any?) -> String { if let x = v as? String { return x }; if let n = v as? NSNumber { return n.stringValue }; return "" }
  /// Owner 2026-10-27 14:23: no monthly cap; the limit is per payment / per day / TOTAL.
  static func limitLine(single: String, daily: String, total: String) -> String { let p = { (x: String) in Double(x).map(Beginner.plainAmount) ?? x }; let single = p(single), daily = p(daily), total = p(total); return T("每笔 \(single) · 每天 \(daily) · 总额 \(total) USDC", "\(single) per payment · \(daily) a day · \(total) total (USDC)") }
  private static func usdc(_ atomic: Any?) -> String { AnswerRules.format(Int64(s(atomic)) ?? 0) }
  private static func human(_ v: Any?) -> String { let h = v as? [String: Any]; return T(s(h?["zh"]), s(h?["en"])) }
  static func approval(_ p: [String: Any]) -> ApprovalReq? {
    guard let id = p["id"] as? String, let d = p["digest"] as? String, let t = p["signText"] as? String else { return nil }
    let lines = (p["items"] as? [[String: Any]] ?? []).map { human($0["human"]) }
    let by = s(p["by"]).replacingOccurrences(of: "agent:", with: "")
    let ak = p["ask"] as? [String: Any]; var ask = ak.flatMap { a -> AskInfo? in let pa = s(a["payee"]), am = s(a["amount"]), dm = s(a["trustDomain"]); return pa.isEmpty || am.isEmpty ? nil : AskInfo(payee: pa, amount: am, domain: dm.isEmpty ? nil : dm, merchantSigned: a["merchantSigned"] as? Bool) }
    // t1266 (fix 1): the card shows what the phone will SIGN, parsed from signText on the phone (never the server's separate lines).
    var shown = lines, details = [AllowanceText.Detail]()
    if let pt = AllowanceText.parse(t), AllowanceText.problems(pt, wallet: Operator.wallet, id: id).isEmpty, ask.map({ AllowanceText.askMatches(pt, payee: $0.payee, amount: $0.amount) }) ?? true {
      let swap = (p["items"] as? [[String: Any]] ?? []).contains { (($0["human"] as? [String: Any])?["payeeSwap"] as? Bool) == true }   // a warning can only add caution
      shown = AllowanceText.lines(pt, payeeSwap: swap)
      ask?.dup = AllowanceText.askIsDup(pt)
      details = AllowanceText.details(pt)   // t1281 (§6#141 ③): site / full payee / replaces / remember / validity, from the same signed text
    } else { shown = [T("服务器给的内容和手机算出的不一致，不能批准。", "Server data doesn't match what the phone computed. This can't be approved.")]; ask = nil }
    return ApprovalReq(id: id, by: by == "owner" ? T("你自己", "You") : by, lines: shown, digest: d, signText: t, reason: s(p["reason"]), userRequest: s(p["user_request"]), ask: ask, details: details)
  }
  func parse(_ j: [String: Any]) {
    items = (j["allowances"] as? [[String: Any]] ?? []).compactMap { m in
      guard let id = m["id"] as? String else { return nil }; let u = m["usage"] as? [String: Any]
      return AllowanceItem(id: id, purpose: Self.s(m["purpose"]), name: Self.purposeName(Self.s(m["purpose"])), line: Self.human(m["human"]), leftToday: Self.s(u?["leftToday"]), leftMonth: Self.s(u?["leftMonth"]), kind: Self.s(m["kind"])) }
    approvals = (j["proposals"] as? [[String: Any]] ?? []).compactMap(Self.approval)
    agents = (j["agents"] as? [[String: Any]] ?? []).compactMap { a in guard let id = a["id"] as? String else { return nil }
      return AgentCapRow(id: id, name: Self.s(a["name"]).isEmpty ? id : Self.s(a["name"]), stopped: a["stopped"] as? Bool ?? false, spentToday: a["spentToday"] as? String, single: a["single"] as? String, daily: a["daily"] as? String, monthly: a["monthly"] as? String) }
    if let o = j["overall"] as? [String: Any] { overall = Self.limitLine(single: Self.usdc(o["single"]), daily: Self.usdc(o["daily"]), total: Self.usdc(o["total"] ?? o["monthly"]))
      if let a = Int64(Self.s(o["single"])), let b = Int64(Self.s(o["daily"])), let t = Int64(Self.s(o["total"] ?? o["monthly"])), a > 0, b > 0, t > 0 { overallAtomic = AISpendLimits.Saved(single: a, daily: b, term: t) } else { overallAtomic = nil }
    } else { overall = nil; overallAtomic = nil }
    defaults = (j["defaults"] as? [[String: Any]] ?? []).map { d in DefaultAllowance(purpose: Self.s(d["purpose"]), name: Self.purposeName(Self.s(d["purpose"])), single: Self.s(d["single"]), daily: Self.s(d["daily"]), monthly: Self.s(d["monthly"]), on: d["on"] as? Bool ?? false) }
    loaded = true
  }
  func load() async {
    #if DEBUG
    if DemoGuard.active && CommandLine.arguments.contains("-kpNoSession") { await collectDelivered(); showHints(); loaded = true; return }   // tests: Home without a live session
    #endif
    if DemoGuard.active { if !demoFilled { demo() }; return }
    lastLoadAt = Date()
    guard let (c, j) = try? await SafetyPanel.get("safety/mandates"), c == 200 else { lastLoadOK = false; await collectDelivered(); showHints(); return }
    lastLoadOK = true; hints = []   // the server list is the truth again
    parse(j)
  }
  func loadReport() async {
    if DemoGuard.active { reportTotal = "7"; reportLines = [(Self.purposeName("promo"), "3"), (Self.purposeName("dev"), "2.3"), (Self.purposeName("study"), "1.2"), (Self.purposeName("other"), "0.5")]; csv = "date,category,item,amount_usdc\n"; return }
    guard let (c, j) = try? await SafetyPanel.get("safety/report?period=month&format=csv"), c == 200 else { return }
    reportTotal = Self.s(j["total"]); csv = Self.s(j["csv"])
    if let c = j["byCategory"] as? [[String: Any]] { reportLines = c.map { (Self.purposeName(Self.s($0["purpose"])), Self.s($0["amount"])) } }
    else { reportLines = (j["byPurpose"] as? [[String: Any]] ?? []).map { (Self.s($0["purposeName"]), Self.s($0["amount"])) } }
  }
  /// The phone checks that what it shows is what it signs: SHA-256(signText) == digest, and (t1266 fix 1) the text parses on the phone,
  /// names THIS wallet and this request, is for USDC on Base, and holds only item kinds the phone can show.
  static func verified(_ a: ApprovalReq) -> [UInt8]? {
    let d = [UInt8](SHA256.hash(data: Data(a.signText.utf8)))
    guard Hex.encode(d).lowercased() == a.digest.lowercased(), let p = AllowanceText.parse(a.signText), AllowanceText.problems(p, wallet: Operator.wallet, id: a.id).isEmpty else { return nil }
    if let ask = a.ask, !AllowanceText.askMatches(p, payee: ask.payee, amount: ask.amount) { return nil }
    return d
  }
  /// Face ID (Secure Enclave key) -> signature -> server. Returns an error text or nil.
  /// t1266 (fix 11): ONE Face ID per approval: the evaluated biometrics-only context signs the session (if it expired) AND the approval.
  /// `context`: an already evaluated, request-bound context (the push path's sign-in, <= 60 s, UnlockReuse); consumed here.
  func approve(_ a: ApprovalReq, context held: LAContext? = nil) async -> String? {
    if DemoGuard.active { held?.invalidate(); DemoGuard.say(); approvals.removeAll { $0.id == a.id }; return nil }
    guard let d = Self.verified(a) else { held?.invalidate(); return T("服务器给的内容和手机算出的不一致，已停止。", "Server data doesn't match what the phone computed. Stopped.") }
    guard PhoneKey.isPresent() else { held?.invalidate(); return T("这台 iPhone 还没开启 Face ID 批准：设置 → Face ID 批准。", "Face ID approvals aren't on for this iPhone yet: Settings → Face ID approvals.") }
    let ctx: LAContext
    if let held { ctx = held } else {
      await FaceIDUnlock.ensure()   // t1255 §6#124: Face ID locked by iOS -> passcode unlocks Face ID only (approves nothing)
      let c = LAContext(); c.localizedCancelTitle = T("取消", "Cancel"); c.touchIDAuthenticationAllowableReuseDuration = 0
      PromptLog.add("approve"); AuthLog.note("approve", "faceid-1 start")
      guard (try? await c.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: T("用 Face ID 同意", "Approve with Face ID"))) == true else { c.invalidate(); return T("已取消。", "Canceled.") }
      ctx = c
    }
    defer { ctx.invalidate() }
    if MainnetSession.load() == nil { guard (try? await MainnetSession.signIn(context: ctx)) != nil else { return T("已取消。", "Canceled.") } }
    guard let k = PhoneKey.existing(context: ctx) else { return T("这台 iPhone 还没开启 Face ID 批准：设置 → Face ID 批准。", "Face ID approvals aren't on for this iPhone yet: Settings → Face ID approvals.") }
    do { let (r, s) = try PhoneKey.sign(d, key: k, reusesUnlock: true)
      let (c, _) = try await MainnetSession.authedPost("safety/mandates/approve", ["id": a.id, "r": Hex.encode(r), "s": Hex.encode(s)])
      if c == 200 { Haptics.success(); await load(); return nil }
      return c == 403 ? T("确认不对，没有生效。", "The signature didn't match. Nothing changed.") : T("没有成功（\(c)），请再试一次。", "That didn't work (\(c)). Please try again.")
    } catch { return T("已取消。", "Canceled.") }
  }
  /// t1170u (§6#82): 「认识并信任」 or 「只付这一次」. The phone re-checks every part, then ONE Face ID signs them all:
  /// the card text + choice, the on-chain approval of exactly this payment, and (trust) the trust for exactly this payee.
  /// The server then pays this request once. Returns the text to show.
  /// `userTapped`: the owner tapped the button on this full card (only then may the sign-in Face ID of the last 60 s be reused, t1243).
  /// t1266 (fix 10): required (no default); the held context is bound to (id, mode); once ask-prepare ran, EVERY refusal posts ask-cancel.
  /// t1275 (#2): `ceiling` = SignedLimitsStore.ceiling (what the owner signed on THIS phone; nil = nothing signed here -> a trust is refused).
  func approveAsk(_ a: ApprovalReq, mode: String, userTapped: Bool, ceiling: (single: Int64, daily: Int64)?) async -> String? {
    if DemoGuard.active { signInUnlock.clear(); DemoGuard.say(); approvals.removeAll { $0.id == a.id }; return nil }
    let mismatch = T("服务器给的内容和手机算出的不一致，已停止。", "Server data doesn't match what the phone computed. Stopped.")
    let tag = a.id + "|" + mode
    func early(_ t: String) -> String { signInUnlock.clear(); return t }   // before ask-prepare: nothing to cancel on the server
    guard let ask = a.ask, OwnerAsk.modes.contains(mode), Self.verified(a) != nil else { return early(mismatch) }
    if ask.dup && mode == "trust" { return early(mismatch) }   // t1280: a suspected-duplicate card never trusts
    guard PhoneKey.isPresent() else { return early(T("这台 iPhone 还没开启 Face ID 批准：设置 → Face ID 批准。", "Face ID approvals aren't on for this iPhone yet: Settings → Face ID approvals.")) }
    let why = mode == "trust" ? (ask.domain.map { T("信任 \($0) 并付这笔", "Trust \($0) and pay") } ?? T("认识并信任，并付这笔", "Trust this payee and pay")) : (ask.dup ? T("再付一次", "Pay again") : T("只付这一次", "Pay just this once"))
    guard await ensureSession(reason: why, keepForApproval: true, tag: tag) else { return early(T("已取消。", "Canceled.")) }
    // from here on the server may hold a prepared trust request for this card: every refusal cancels it (the card stays pending)
    func refuse(_ t: String) async -> String { signInUnlock.clear(); _ = try? await MainnetSession.authedPost("safety/mandates/ask-cancel", ["id": a.id]); return t }
    guard let (c, j) = try? await MainnetSession.authedPost("safety/mandates/ask-prepare", ["id": a.id, "mode": mode]) else { return await refuse(T("没有成功，请再试一次。", "That didn't work. Please try again.")) }
    if c != 200 { signInUnlock.clear() }
    if c == 409, Self.s(j["error"]) == "already_handled" { await load(); return T("这个请求已经处理过了。", "This request was already handled.") }
    if OwnerAsk.isGone(status: c, error: Self.s(j["error"])) { await load(); return T(OwnerAsk.goneZH, OwnerAsk.goneEN) }   // t1259 §6#129: closed by the server, card leaves the list
    guard c == 200 else { return await refuse(Self.s(j["detail"]).isEmpty ? T("没有成功（\(c)），请再试一次。", "That didn't work (\(c)). Please try again.") : Self.s(j["detail"])) }
    // 1) the card text + choice
    guard let sg = j["sign"] as? [String: Any], let st = sg["signText"] as? String, OwnerAsk.textOK(st, base: a.signText, wallet: Operator.wallet, id: a.id, mode: mode),
          let pst = AllowanceText.parse(st, allowMode: true), pst.mode == mode, AllowanceText.problems(pst, wallet: Operator.wallet, id: a.id).isEmpty,
          AllowanceText.askMatches(pst, payee: ask.payee, amount: ask.amount) else { return await refuse(mismatch) }
    let cd = [UInt8](SHA256.hash(data: Data(st.utf8))); guard Hex.encode(cd).lowercased() == Self.s(sg["digest"]).lowercased() else { return await refuse(mismatch) }
    // 2) the owner's on-chain approval of exactly this payee + amount
    guard var pj = j["pay"] as? [String: Any] else { return await refuse(mismatch) }; pj["id"] = a.id
    guard let ch = OwnerPay.Challenge(pj), let amt = Int64(ask.amount), case .success(let ph) = OwnerPay.toSign(ch, wallet: PhoneTrust.mainnetWallet, payee: ask.payee, amount: amt) else { return await refuse(mismatch) }
    // 3) trust: exactly this payee, the shown caps, within the phone ceiling
    var th: [UInt8]? = nil, gh: [UInt8]? = nil, grantName: String? = nil, grantSigned: Bool? = nil, trustReason: String? = nil
    if mode == "trust" {
      guard let tj = j["trust"] as? [String: Any], let m = tj["message"] as? [String: Any], let ph2 = tj["phone"] as? [String: Any] else { return await refuse(mismatch) }
      func f(_ k: String) -> String { Self.s(m[k]) }
      let om = OwnerTrustMessage(account: f("account"), merchant: f("merchant"), name: f("name"), epoch: f("epoch"), payees: m["payees"] as? [String] ?? [], signers: m["signers"] as? [String] ?? [],
        single: f("single"), daily: f("daily"), expiry: f("expiry"), nonce: f("nonce"), deadline: f("deadline"))
      // t1240 (§6#110): a merchant-signed order -> the trust names that merchant's domain + its ONE signer, and the same Face ID signs the
      // V5.4 grant (kind 5). The phone recomputes the grant from the trust it checked; anything different stops here.
      let gj = tj["signerGrant"] as? [String: Any], sgn = Self.s(tj["signer"]), mer = Self.s(tj["merchant"])
      if gj != nil, sgn.isEmpty || mer.isEmpty { return await refuse(mismatch) }
      if gj != nil, !SignerGrantDomain.ok(cardDomain: ask.domain, merchant: mer) { return await refuse(mismatch) }   // t1278 (A3): a grant only for the domain this card shows
      // t1246 (§6#116 F8): also the phone's OWN ceiling (the AI limits shown in the app, else 5 / 20 USDC) — not only the server's numbers.
      let own = OwnerAsk.trustCapProblems(om, localCeiling: ceiling)   // t1275 (#2): never the server's overall / everyday numbers alone
      if !own.isEmpty { AuthLog.note("trust-caps", "refused single=\(om.single) daily=\(om.daily) ceiling=\(ceiling.map { "\($0.single)/\($0.daily)" } ?? "none-signed-here") overall=\(overallAtomic.map { "\($0.single)/\($0.daily)" } ?? "nil") inline=\(tj["kind"] as? Int ?? 0) why=\(own.joined(separator: "; "))") }   // t1257 §6#126
      guard own.isEmpty || ceiling != nil else { return await refuse(T(SignedLimitsCopy.noneZH + "可以改选「只付这一次」。", SignedLimitsCopy.noneEN + " You can choose \u{201C}Pay just this once\u{201D} instead.")) }   // t1275 (#2)
      guard own.isEmpty else { return await refuse(T("这次信任的额度超过你在手机上设的 AI 花钱上限，已停止，没有付款。可以改选「只付这一次」。", "This trust is above the AI spending limits set on this phone, so it was stopped and nothing was paid. You can choose \u{201C}Pay just this once\u{201D} instead.")) }
      let issues = PhoneTrust.problems(om, maxSingle: Self.s(ph2["maxSingle"]), maxDaily: Self.s(ph2["maxDaily"])) + OwnerAsk.trustProblems(om, payee: ask.payee, single: Self.s(tj["single"]), signer: gj == nil ? nil : sgn, merchant: gj == nil ? nil : mer)
      guard issues.isEmpty, PhoneTrust.suiteProblems(om).isEmpty, let d = PhoneTrust.trustDigest(om), Hex.encode(d).lowercased() == Self.s(tj["digest"]).lowercased(), let h = PhoneTrust.walletHash(d) else { return await refuse(mismatch) }
      // t1280 (Q4): the epoch must be the merchant's CURRENT trust epoch, read by this phone on chain (two agreeing nodes)
      guard await PhoneTrust.chainEpochMatches(account: om.account, merchant: om.merchant, epoch: om.epoch) else { return await refuse(mismatch) }
      th = h
      if let gj, let gm = gj["message"] as? [String: Any] {
        func g(_ k: String) -> String { Self.s(gm[k]) }
        let gr = OwnerSignerTrustMessage(account: g("account"), merchant: g("merchant"), name: g("name"), epoch: g("epoch"), signers: gm["signers"] as? [String] ?? [],
          single: g("single"), daily: g("daily"), expiry: g("expiry"), nonce: g("nonce"), deadline: g("deadline"))
        guard KipurseSuite.active.signerGrants, PhoneTrust.signerTrustProblems(gr, card: om).isEmpty, let gd = PhoneTrust.signerTrustDigest(gr, adapter: KipurseSuite.active.adapter),
              Hex.encode(gd).lowercased() == Self.s(gj["digest"]).lowercased(), let gh2 = PhoneTrust.walletHash(gd) else { return await refuse(mismatch) }
        gh = gh2; grantName = mer; grantSigned = tj["merchantSigned"] as? Bool
      } else if gj != nil { return await refuse(mismatch) }
      guard PhoneTrust.signerProblems(om, grantVerified: gh != nil).isEmpty else { return await refuse(mismatch) }   // t1275 (#1): same rule on every trust path
      // t1281 (§6#141 ③): the Face ID prompt names the EXACT signed caps + expiry of the trust just checked (and the any-payee-address grant)
      let fr = OwnerAsk.trustFaceIDReason(om, grantName: grantName, grantSigned: grantSigned); trustReason = T(fr.zh, fr.en)
    }
    // ONE Face ID for every signature (the evaluated context is reused by the Secure Enclave key)
    // t1243 (§6#113): a sign-in just above (session had expired) already ran Face ID: reuse that SAME evaluated context once, only after the
    // owner's tap on this card, within 60 s (UnlockReuse) and (t1266) only for this same request + choice; otherwise exactly as before.
    let reused = signInUnlock.take(now: Date(), userTapped: userTapped, tag: tag)
    let ctx = reused ?? LAContext(); ctx.localizedCancelTitle = T("取消", "Cancel"); ctx.touchIDAuthenticationAllowableReuseDuration = 0
    defer { ctx.invalidate() }
    var unlocked = reused != nil
    await FaceIDUnlock.ensure()   // t1255 §6#124: Face ID locked by iOS -> passcode unlocks Face ID only (approves nothing)
    AuthLog.note("approve", "faceid-1 start")   // t1256
    if !unlocked { unlocked = (try? await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: mode == "trust" ? (trustReason ?? T("认识并信任，并付这笔", "Trust this payee and pay")) : T("只付这一次", "Pay just this once"))) == true }
    guard unlocked,
          let k = PhoneKey.existing(context: ctx) else { return await refuse(T("已取消。", "Canceled.")) }
    do {
      let (r, s) = try PhoneKey.sign(cd, key: k, reusesUnlock: true), (pr, ps) = try PhoneKey.sign(ph, key: k, reusesUnlock: true)
      var body: [String: Any] = ["id": a.id, "mode": mode, "r": Hex.encode(r), "s": Hex.encode(s), "pay": ["r": Hex.encode(pr), "s": Hex.encode(ps)]]
      if let th { let (tr, ts) = try PhoneKey.sign(th, key: k, reusesUnlock: true); var tb: [String: Any] = ["r": Hex.encode(tr), "s": Hex.encode(ts)]
        if let gh { let (gr, gs) = try PhoneKey.sign(gh, key: k, reusesUnlock: true); tb["signerGrant"] = ["r": Hex.encode(gr), "s": Hex.encode(gs)] }
        body["trust"] = tb }
      let (c2, j2) = try await MainnetSession.authedPost("safety/mandates/approve", body)
      await load()
      if c2 == 200, Self.s(j2["state"]) == "paid" { Haptics.success()
        // t1243 (§6#113): the server pays first and replies; the trust lands on chain a few seconds later in the background
        if mode == "trust", Self.s((j2["trust"] as? [String: Any])?["state"]) == "submitting" {
          if let n = grantName {
            if grantSigned == false { return T("✅ 已付款。信任 \(n) 正在生效，几秒后完成，之后它的订单在你的 AI 日常额度的一半内自动付，超过会先问你。", "✅ Paid. Trusting \(n) is taking effect and finishes in a few seconds; after that its orders go through automatically within half your AI everyday limits (above that you'll be asked).") }
            return T("✅ 已付款。信任 \(n) 正在生效，几秒后完成，之后它的订单在额度内自动付。", "✅ Paid. Trusting \(n) is taking effect and finishes in a few seconds; after that its orders within your limits go through automatically.") }
          return T("✅ 已付款。信任正在生效，几秒后完成，之后在你的 AI 日常额度内自动付，不再问你。", "✅ Paid. The trust is taking effect and finishes in a few seconds; after that payments within your AI everyday limits go through without asking.") }
        if mode == "trust", let n = grantName, Self.s((j2["trust"] as? [String: Any])?["signerGrant"]) == "stored" {
          if grantSigned == false { return T("✅ 已付款，并已信任 \(n)。它的订单不带商家签名，以后在你的 AI 日常额度的一半内自动付，超过会先问你；每次自动付都会通知你。", "✅ Paid and \(n) is trusted. Its orders are not signed by the merchant, so future ones go through automatically only within half your AI everyday limits (above that you'll be asked); you're notified of each one.") }
          return T("✅ 已付款，并已信任 \(n)。以后它的订单（每单收款地址可以不同）在你的 AI 日常额度内自动付，不再问你。", "✅ Paid and \(n) is trusted. Its future orders (each may use a different payee address) go through within your AI everyday limits without asking.") }
        return mode == "trust" ? T("✅ 已付款，并已加入信任名单。以后在你的 AI 日常额度内自动付，不再问你。", "✅ Paid and trusted. Future payments within your AI everyday limits go through without asking.") : T("✅ 已付款（只这一次）。下次付给它还会问你。", "✅ Paid (just this once). You'll be asked again next time.") }
      if c2 == 200 { return T("你已批准，但这笔没付成，没有多扣钱。", "You approved it, but the payment didn't go through. Nothing extra was charged.") }
      if c2 == 409 { return T("这个请求已经处理过了。", "This request was already handled.") }
      return c2 == 403 ? T("确认不对，没有生效。", "The signature didn't match. Nothing changed.") : T("没有成功（\(c2)），请再试一次。", "That didn't work (\(c2)). Please try again.")
    } catch { return await refuse(T("已取消。", "Canceled.")) }
  }
  func reject(_ a: ApprovalReq) async { if DemoGuard.active { approvals.removeAll { $0.id == a.id }; return }
    guard await ensureSession() else { return }
    _ = try? await MainnetSession.authedPost("safety/mandates/reject", ["id": a.id]); await load() }
  func revoke(_ i: AllowanceItem) async -> Bool { guard await SafetyPanel.faceID(T("停用这项自动续费", "Turn off this renewal")) else { return false }
    if DemoGuard.active { items.removeAll { $0.id == i.id }; return true }
    let ok = ((try? await MainnetSession.authedPost("safety/mandates/revoke", ["id": i.id]))?.0 ?? 0) == 200; await load(); return ok }
  func stop(_ a: AgentCapRow) async -> Bool { guard await SafetyPanel.faceID(T("停用这个 AI 的付款", "Turn off payments for this AI")) else { return false }
    if DemoGuard.active { agents = agents.map { $0.id == a.id ? AgentCapRow(id: a.id, name: a.name, stopped: true, spentToday: a.spentToday) : $0 }; return true }
    let ok = ((try? await MainnetSession.authedPost("safety/agents/stop", ["agentId": a.id]))?.0 ?? 0) == 200; await load(); return ok }
  /// t899: set one AI's own allowance (per payment + per day; Siri like every AI). ONE Face ID signs it; resume also turns a paused AI back on.
  func setAgentLimits(id: String, name: String, single: String, daily: String, resume: Bool) async -> String? {
    if let p = AgentLimits.problem(single: single, daily: daily, zh: Loc.isChinese) { return p }
    let cur = agents.first { $0.id == id }
    if DemoGuard.active { DemoGuard.say()
      let row = AgentCapRow(id: id, name: name, stopped: resume ? false : (cur?.stopped ?? false), spentToday: cur?.spentToday ?? "0", single: single, daily: daily, monthly: cur?.monthly)
      if agents.contains(where: { $0.id == id }) { agents = agents.map { $0.id == id ? row : $0 } } else { agents.append(row) }
      return nil }
    return await draftAndApprove([AgentLimits.item(agentId: id, single: single, daily: daily, monthly: cur?.monthly, resume: resume)])
  }
  /// Draft on the server (owner), then approve it with ONE Face ID.
  func draftAndApprove(_ items: [[String: Any]]) async -> String? {
    if DemoGuard.active { DemoGuard.say(); demoFilled = true
      self.items = items.map { d in let p = Self.s(d["purpose"]); return AllowanceItem(id: "demo-" + p, purpose: p, name: Self.purposeName(p), line: T("每笔最多 \(Self.s(d["single"]))，每天 \(Self.s(d["daily"]))，总额 \(Self.s(d["monthly"])) USDC", "Up to \(Self.s(d["single"])) per payment, \(Self.s(d["daily"])) a day, \(Self.s(d["monthly"])) total"), leftToday: Self.s(d["daily"]), leftMonth: Self.s(d["monthly"]), kind: "allowance") }
      if let a = agents.first(where: { $0.stopped }) { agents = agents.map { $0.id == a.id ? AgentCapRow(id: a.id, name: a.name, stopped: false, spentToday: a.spentToday) : $0 } }
      return nil }
    guard let (c, j) = try? await MainnetSession.authedPost("safety/mandates/draft", ["items": items]), c == 200, let a = Self.approval(j) else { return T("没有成功，请再试一次。", "That didn't work. Please try again.") }
    // t1266 (fix 1): every signed field must be exactly what the owner typed here; anything else is refused before Face ID.
    guard let pt = AllowanceText.parse(a.signText), AllowanceText.problems(pt, wallet: Operator.wallet, id: a.id).isEmpty, AllowanceText.draftMatches(pt, typed: items) else {
      _ = try? await MainnetSession.authedPost("safety/mandates/reject", ["id": a.id])   // our own draft that came back different: close it
      return T("服务器给的内容和你填的不一致，已停止。", "Server data doesn't match what you entered. Stopped.") }
    return await approve(a)
  }
  private func demo() {
    overall = Self.limitLine(single: "5", daily: "50", total: "500"); overallAtomic = AISpendLimits.Saved(single: 5_000_000, daily: 50_000_000, term: 500_000_000)
    let emptyDemo = CommandLine.arguments.contains("main-empty") || CommandLine.arguments.contains("empty")   // t927: an empty demo has nothing waiting
    if CommandLine.arguments.contains("-kpGrantDemo") {   // t1281 UI test only: two grant cards built through the REAL approval() path from gateway sign texts (t1281-card-details.json.txt)
      let texts = [("apr_t1281rec02", #"Kipurse allowance approval v1\#nwallet:0x1000000000000000000000000000000000000001\#nid:apr_t1281rec02\#nitems:[{"kind":"recurring","purpose":"work","label":null,"single":"12000000","daily":"12000000","monthly":"12000000","payees":["0x1111111111111111111111111111111111112222"],"hosts":["notion.so"],"agents":[],"recurring":{"payee":"0x1111111111111111111111111111111111112222","amount":"12000000","every":"month","name":"Notion"},"oneOff":null,"expiresInDays":90,"replaces":"mnd_9f8e7d6c5b4a"}]\#nchain:8453\#ntoken:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"#), ("apr_t1281one01", #"Kipurse allowance approval v1\#nwallet:0x1000000000000000000000000000000000000001\#nid:apr_t1281one01\#nitems:[{"kind":"one_off","purpose":"daily","label":null,"single":"8000000","daily":"8000000","monthly":"240000000","payees":["0x3333333333333333333333333333333333334444"],"hosts":["shop.example.com"],"agents":[],"recurring":null,"oneOff":{"payee":"0x3333333333333333333333333333333333334444","host":"shop.example.com","amount":"8000000","idem":null,"remember":true,"aiName":"Example Shop"},"expiresInDays":1,"replaces":null}]\#nchain:8453\#ntoken:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"#)]
      approvals = texts.compactMap { t in Self.approval(["id": t.0, "digest": Hex.encode([UInt8](SHA256.hash(data: Data(t.1.utf8)))), "signText": t.1, "by": "agent:Claude", "reason": "ask_owner"]) } } else
    if CommandLine.arguments.contains("-kpDupDemo") { var di = AskInfo(payee: "0x1212121212121212121212121212121212123434", amount: "900000"); di.dup = true   // t1280b UI test only: suspected-duplicate card
      approvals = [ApprovalReq(id: "demo-dup", by: "Claude", lines: [T("⚠️ 疑似重复购买：10 分钟内已经给 0x1212…3434 付过同样的 0.90 USDC（用途：coffee）。这次还没付。确实要再买一次才点「再付一次」，不需要就点「拒绝」", "⚠️ Possible duplicate purchase: 0x1212…3434 was already paid the same 0.90 USDC in the last 10 minutes (for: coffee). Nothing paid yet. Tap \"Pay again\" only if you really want a second one, otherwise \"Decline\"")], digest: "", signText: "", reason: "ask_owner", userRequest: T("帮我买杯咖啡", "Buy me a coffee"), ask: di)] } else
    if CommandLine.arguments.contains("-kpAskDemo") { approvals = [ApprovalReq(id: "demo-ask", by: "Claude", lines: [T("⚠️ 新收款方 0x1212…3434，付 30 USDC（用途：standing desk）。认识这个收款方吗？超过了 AI 自动付款上限，AI 可能被骗，确认是你要付的人再批准。AI 说它是“Desk Shop”，未核实", "⚠️ NEW payee 0x1212…3434, 30 USDC (for: standing desk). Do you know this payee? It is above the AI auto-pay limit and the AI could be tricked: approve only if you mean to pay them. The AI calls it \"Desk Shop\" (not verified)")], digest: "", signText: "", reason: "ask_owner", userRequest: T("帮我买那张升降桌", "Buy me that standing desk"), ask: AskInfo(payee: "0x1212121212121212121212121212121212123434", amount: "30000000"))] } else {
    approvals = emptyDemo ? [] : [ApprovalReq(id: "demo-apr", by: "Claude", lines: [T("只这一次：付 Example Shop 8 USDC（超出 AI 付款上限）", "One time only: pay Example Shop 8 USDC (over your AI payment limit)")], digest: "", signText: "", reason: "MANDATE_OVER_SINGLE", userRequest: T("把我的新游戏拿去竞价宣传", "Take my new game to bid for promotion"))] }
    agents = [AgentCapRow(id: "claude", name: "Claude", stopped: false, spentToday: "1.2"), AgentCapRow(id: "grok-bot", name: "Grok", stopped: false, spentToday: "0"),
              AgentCapRow(id: "siri", name: "Siri", stopped: CommandLine.arguments.contains("-kpSiriPaused"), spentToday: "0.5", single: "2", daily: "10")]
    defaults = []
    loaded = true
  }
}

/// Home card: only pending AI requests (the limit itself lives on the AI payment limit card).
/// t1245 (§6#115 U11/U12/U35/U36): same glass card + title size as the other 待你批准 cards (type shown by the icon colour only);
/// shows nothing (and takes no space) when there is no request — the parent loads the store; one short line, the question is in the sheet.
struct AllowancesCard: View {
  @ObservedObject var st = AllowanceStore.shared
  /// "新收款方 0x1212…3434，30 USDC" for a new-payee ask; otherwise the request's own first line.
  static func summary(_ a: ApprovalReq?) -> String {
    guard let a else { return "" }
    if let ask = a.ask, ask.dup, let amt = Int64(ask.amount) { return T("疑似重复购买 \(shortAddr(ask.payee))，\(MoneyText.usdc(amt))", "Possible duplicate \(shortAddr(ask.payee)), \(MoneyText.usdc(amt))") }   // t1280
    if let ask = a.ask, let amt = Int64(ask.amount) { return T("新收款方 \(shortAddr(ask.payee))，\(MoneyText.usdc(amt))", "New payee \(shortAddr(ask.payee)), \(MoneyText.usdc(amt))") }
    return a.lines.first ?? ""
  }
  var body: some View {
    if !st.approvals.isEmpty {
      Button { st.open = true } label: {
        HStack(alignment: .center, spacing: KP.Space.s) {
          PendingIcon(symbol: "hand.raised.fill", tint: Brand.caution)
          VStack(alignment: .leading, spacing: KP.Space.xxs) {
            Text(T("AI 额度申请 \(st.approvals.count) 件", st.approvals.count == 1 ? "1 AI request" : "\(st.approvals.count) AI requests")).font(KP.Typo.cardTitle)
            Text(Self.summary(st.approvals.first)).font(KP.Typo.body).foregroundStyle(.secondary).multilineTextAlignment(.leading).lineLimit(3).fixedSize(horizontal: false, vertical: true)
          }
          Spacer(minLength: 0); Image(systemName: "chevron.right").font(.footnote.weight(.bold)).foregroundStyle(.tertiary)
        }.card(padding: 18)
      }.buttonStyle(Pressable()).foregroundStyle(.primary).accessibilityIdentifier("allow.card.pending")
    }
  }
}

struct AllowancesSheet: View {
  /// t1245: server amounts ("1.2") shown with the one money rule ("1.20 USDC").
  static func usdcText(_ v: String) -> String { AnswerRules.parseUSDC(v).map { MoneyText.usdc(Int64($0)) } ?? v + " USDC" }
  @EnvironmentObject var m: AppModel
  @ObservedObject var st = AllowanceStore.shared
  @State private var msg: String?
  @State private var busy = false
  var body: some View {
    NavigationStack {
      List { Group {
        if !st.approvals.isEmpty {
          Section(T("等你同意", "Waiting for you")) {
            ForEach(st.approvals) { a in
              VStack(alignment: .leading, spacing: 6) {
                ForEach(a.lines, id: \.self) { Text($0).font(.subheadline.weight(.semibold)) }
                ForEach(Array(a.details.enumerated()), id: \.offset) { Text(T($0.element.zh, $0.element.en)).font(.caption).foregroundStyle(.secondary).textSelection(.enabled).accessibilityIdentifier("allow.detail." + $0.element.id) }   // t1281 §6#141 ③
                Text(T("申请的 AI：", "Asked by: ") + a.by).font(.caption).foregroundStyle(.secondary)
                if !a.userRequest.isEmpty { Text(T("你说的：“", "You said: \u{201C}") + a.userRequest + T("”", "\u{201D}")).font(.caption).foregroundStyle(.secondary) }
                if let ask = a.ask {   // t1170u (§6#82): new payee above the AI limit -> full address + 认识并信任 / 只付这一次 / 拒绝
                  Text(T("完整地址：", "Full address: ") + OwnerAsk.grouped(ask.payee)).font(.caption.monospaced()).textSelection(.enabled).accessibilityIdentifier("allow.ask.address")
                  if let ln = OwnerAsk.domainTrustLine(domain: ask.domain, merchantSigned: ask.merchantSigned) { Text(T(ln.zh, ln.en)).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("allow.ask.domain") }   // t1241 §6#111
                  if let f = st.focusAsk, f.id == a.id, let h = OwnerAsk.pushChoiceHint(mode: f.mode) {   // t1246 F9
                    Label(T(h.zh, h.en), systemImage: "hand.point.down.fill").font(.caption.weight(.semibold)).foregroundStyle(Brand.caution).accessibilityIdentifier("allow.ask.pushhint")
                  }
                  // t1245 (§6#115 U14/U15): brand buttons; the two lower choices share the width, same height as the main one.
                  if ask.dup {   // t1280 (§6#140, owner): suspected duplicate -> no "trust", only pay again (once) / decline
                    HStack(spacing: KP.Space.s) {
                      BigButton(T("再付一次", "Pay again"), icon: "faceid", disabled: busy) { Task { busy = true; msg = await st.approveAsk(a, mode: "once", userTapped: true, ceiling: nil); busy = false } }.accessibilityIdentifier("allow.ask.again")
                      BigButton(T("拒绝", "Decline"), kind: .danger) { Task { await st.reject(a) } }.accessibilityIdentifier("allow.pending.reject")
                    }.padding(.top, 4)
                  } else {
                  let cap = SignedLimitsStore.ceiling(m)   // t1275 (#2): only the limits signed on this phone (no copy here -> no line; a trust is refused)
                  if let cap { let capLine = OwnerAsk.trustCapsCardLine(cap)   // t1281: upper bounds + always expires; exact terms at Face ID
                  Text(T(capLine.zh, capLine.en)).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("allow.ask.caps") }   // t1246 F8
                  BigButton(T("认识并信任", "Trust this payee"), icon: "faceid", disabled: busy) { Task { busy = true; msg = await st.approveAsk(a, mode: "trust", userTapped: true, ceiling: cap); busy = false } }.accessibilityIdentifier("allow.ask.trust").padding(.top, 4)
                  HStack(spacing: KP.Space.s) {
                    BigButton(T("只付这一次", "Pay just this once"), kind: .secondary, disabled: busy) { Task { busy = true; msg = await st.approveAsk(a, mode: "once", userTapped: true, ceiling: nil); busy = false } }.accessibilityIdentifier("allow.ask.once")
                    BigButton(T("拒绝", "Decline"), kind: .danger) { Task { await st.reject(a) } }.accessibilityIdentifier("allow.pending.reject")
                  }
                  }
                } else {
                HStack(spacing: KP.Space.s) {
                  BigButton(T("拒绝", "Decline"), kind: .danger) { Task { if a.fromPush { busy = true; msg = await st.resolvePushed(a, approve: false); busy = false } else { await st.reject(a) } } }.accessibilityIdentifier("allow.pending.reject")
                    .frame(maxWidth: 120)
                  BigButton(T("用 Face ID 同意", "Approve with Face ID"), icon: "faceid", disabled: busy) { Task { busy = true; msg = a.fromPush ? await st.resolvePushed(a, approve: true) : await st.approveTapped(a); busy = false } }.accessibilityIdentifier("allow.pending.approve")
                }.padding(.top, 4)
                }
              }.padding(.vertical, 4)
            }
          }
        }
        Section { Text(AgentLimitsCard.policyLine(m.state ?? WalletState(.object([:])), demo: m.demo != nil)).font(.subheadline.monospacedDigit().weight(.semibold)).accessibilityIdentifier("allow.limit") }   // t1245 U16: same source as the AI 花钱上限 page
          header: { Text(T("AI 花钱上限", "AI spending limits")) }
          footer: { Text(T("上限内 AI 自己付；超出就发到你手机，用 Face ID 同意一次。在「AI 生活 › AI 花钱上限」里修改。骗子地址、冒充地址照样拦，10 分钟可取消和大额暂扣的规则一直有效。", "Within the limit the AI pays by itself; over it, it goes to your phone for one Face ID. Change it on the AI Life tab › AI spending limits. Scam and lookalike addresses are still blocked; the 10-minute cancel and large-payment hold always apply.")).accessibilityIdentifier("allow.limit.footer") }
        if !st.items.isEmpty {
          Section(T("你批准过的自动续费", "Renewals you approved")) {
            ForEach(st.items) { i in
              VStack(alignment: .leading, spacing: 3) { Text(i.line).font(.subheadline) }
                .swipeActions { Button(T("停用", "Turn off"), role: .destructive) { Task { _ = await st.revoke(i) } } }.accessibilityIdentifier("allow.row.\(i.purpose)")
            }
          }
        }
        if !st.agents.isEmpty {
          Section { ForEach(st.agents) { a in HStack { VStack(alignment: .leading) { Text(a.name).font(.subheadline); if let t = a.spentToday { Text(T("今天花了 \(Self.usdcText(t))", "Spent today \(Self.usdcText(t))")).font(.caption).foregroundStyle(.secondary) } }
                Spacer()
                if a.stopped { Text(T("已停用", "Off")).font(.caption.weight(.semibold)).foregroundStyle(Brand.negative).accessibilityIdentifier("allow.agent.stopped") }
                else { Button(T("停用", "Turn off"), role: .destructive) { Task { _ = await st.stop(a) } }.font(.subheadline.weight(.semibold)).foregroundStyle(Brand.negative).padding(.horizontal, 14).frame(minHeight: 36).background(Brand.negative.opacity(0.12), in: Capsule()).buttonStyle(Pressable()).accessibilityIdentifier("allow.agent.stop") } } } }
            header: { Text(T("每个 AI", "Each AI")) } footer: { Text(T("停用后这个 AI 立刻不能再付款，其他 AI 不受影响。", "A turned-off AI can't pay anymore; the others keep working.")) }
        }
        Section { 
          if st.reportLines.isEmpty { Text(T("还没有花费。", "Nothing spent yet.")).font(.caption).foregroundStyle(.secondary) }
          ForEach(st.reportLines, id: \.0) { l in LabeledContent(l.0, value: Self.usdcText(l.1)) }
          if !st.reportTotal.isEmpty { LabeledContent(T("合计", "Total"), value: Self.usdcText(st.reportTotal)).font(.subheadline.weight(.semibold)) }
          if !st.csv.isEmpty { ShareLink(item: st.csv, preview: SharePreview(T("Kipurse 花费明细.csv", "Kipurse spending.csv"))) { Label(T("导出明细（带类别和收据）", "Export (with category and receipts)"), systemImage: "square.and.arrow.up") }.accessibilityIdentifier("allow.export") }
        } header: { Text(T("本月花在哪（自动分类）", "This month (sorted automatically)")) } footer: { Text(T("类别由 AI 按用途和商家自动分，只用来看账，不限制付款。", "Categories are picked automatically from the purpose and merchant. They're only for your records and never limit a payment.")) }
      }
      .listRowBackground(GlassRowBG())
      }
      // t1245 (§6#115 U4/U14): the app's glass list on the brand background; a title that fits in English.
      .listStyle(.insetGrouped).kpSectionRhythm().scrollContentBackground(.hidden).background(MockBG()).tint(Brand.accent)
      .navigationTitle(T("AI 付款和花费", "AI spending")).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(T("完成", "Done")) { st.open = false }.bold().accessibilityIdentifier("allow.close") }
      .task { await st.load(); await st.loadReport() }
      // t1246 (§6#116 F9): a push action only OPENS this card and marks the owner's choice. Face ID and signing start only when the owner
      // taps a button here, with the full address and amount on screen (never straight from the lock screen / AI-written push text).
      .task(id: st.pendingAsk?.id ?? "") { if let p = st.pendingAsk, st.approvals.contains(where: { $0.id == p.id && $0.ask != nil }) { st.pendingAsk = nil; st.focusAsk = p } }
      .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in st.open = false }
      .alert(msg ?? "", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) { Button(T("好", "OK")) {} }
    }
  }
}
