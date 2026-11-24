import SwiftUI
import KipurseCore
import LocalAuthentication

struct ConnectReq: Identifiable { let id: String }

/// Pending agent connection on the wallet page: opens the Face ID approval.
struct MainConnectCard: View {
  @EnvironmentObject var m: AppModel; let r: ConnectRequest
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      // t1279 (R17): same rule as the approval sheet: name + official avatar ONLY from ConnectBrand.verified(host:); else the host
      // (else the generic "AI"). Never the AI's self-chosen name (r.client) nor the server-chosen avatar (r.kind).
      let brand = ConnectBrand.verified(host: r.host)
      let shown = ConnectBrand.shown(host: r.host)
      HStack(spacing: 12) {
        Avatar(name: shown, size: 40, symbol: brand.flatMap { b in AgentCard.mainnet.first { $0.name == b }?.symbol } ?? "link")
        VStack(alignment: .leading, spacing: 2) {
          Text(L("\(shown) 想连接")).font(.headline)
          Text(r.host).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      BigButton(L("查看并批准"), icon: "faceid") { m.connectReq = ConnectReq(id: r.id) }.accessibilityIdentifier("connect.open")
    }.card(padding: 18)
  }
}

/// Where to send the owner back after approving on the same phone (the AI app whose sign-in sheet is waiting). Allowlist only.
enum ConnectReturn {
  static func app(host: String) -> URL? {
    let h = host.lowercased()
    if h == "claude.ai" || h.hasSuffix(".claude.ai") || h == "claude.com" || h.hasSuffix(".claude.com") { return URL(string: "claude://") }
    if h == "cursor.com" || h.hasSuffix(".cursor.com") { return URL(string: "grokbot://") }
    // Muse (Meta): redirect https://muse.ai/api/hatch/oauth/callback; muse.ai/open_hatch is a Muse universal link (AASA) that just brings the app back.
    if h == "muse.ai" || h.hasSuffix(".muse.ai") { return URL(string: "https://muse.ai/open_hatch") }
    return nil
  }
}

/// kipurse://approve-connect?id=… : the enrolled phone key (Secure Enclave, Face ID) approves ONE agent connection.
/// The phone rebuilds what it signs from the fields it shows (agent, client, return address, expiry) and refuses if the server's digest differs.
struct ApproveConnectSheet: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  let req: ConnectReq
  struct Info { let name, clientId, redirect, host: String; let exp: Int; var phone = false; var nonce = ""; var modeFirst = false; var proposal: AISpendLimits.Saved? = nil }
  enum Phase: Equatable { case loading, ready, signing, done, declined, failed(String), unavailable(FaceIDNotice) }
  @State private var info: Info?
  @State private var phase: Phase = .loading
  var body: some View {
    NavigationStack {
      ZStack {
        Brand.canvas.ignoresSafeArea()
        switch phase {
        case .loading: ProgressView(L("正在读取请求…"))
        case .signing: status(icon: nil, title: L("授权中…"), sub: L("正在核对手机确认")).accessibilityElement(children: .combine).accessibilityIdentifier("connect.signing")
        case .done: status(icon: "checkmark.circle.fill", title: L("授权完成"), sub: returnApp != nil ? L("正在返回 \(doneName)…") : L("\(doneName) 已连接，网页会自动返回它。"), color: Brand.positive).accessibilityElement(children: .combine).accessibilityIdentifier("connect.done")
        case .declined: status(icon: "xmark.circle.fill", title: L("已拒绝"), sub: L("这个 AI 没有连接。"), color: .secondary)
        case .failed(let e): VStack(spacing: 14) { status(icon: "exclamationmark.triangle.fill", title: L("没有完成"), sub: e, color: Brand.negative)
            if info != nil { BigButton(L("重试"), icon: "arrow.clockwise") { phase = .ready }.padding(.horizontal, 24).accessibilityIdentifier("connect.retry") } }
        // t1153u: Face ID off for Kipurse / approval key invalidated: calm guidance, neutral style, same Retry button.
        case .unavailable(let n): VStack(spacing: 14) { status(icon: "faceid", title: n == .faceIDOff ? T("Face ID 已关闭", "Face ID is off") : n == .lockout ? T("Face ID 暂时被锁", "Face ID is locked for now") : T("需要重新开启 Face ID 批准", "Turn Face ID approvals on again"), sub: n.text, color: .secondary)
            .accessibilityElement(children: .combine).accessibilityIdentifier("connect.faceidoff")
            BigButton(n == .lockout ? T("用锁屏密码解锁 Face ID", "Unlock Face ID with passcode") : L("重试"), icon: n == .lockout ? "lock.open" : "arrow.clockwise") { Task { if n == .lockout { await FaceIDUnlock.ensure(); withAnimation { phase = info != nil ? .ready : .loading }; if info == nil { await load() } } else { await recheck() } } }.padding(.horizontal, 24).accessibilityIdentifier("connect.retry") }
        case .ready: if let i = info { form(i) }
        }
      }
      .navigationTitle(L("批准连接")).navigationBarTitleDisplayMode(.inline)
      .toolbar { if phase != .signing { Button(L("关闭")) { dismiss() }.accessibilityIdentifier("connect.close") } }
    }.task { await load() }
  }
  func status(icon: String?, title: String, sub: String, color: Color = Brand.accent) -> some View {
    VStack(spacing: 14) {
      if let icon { Image(systemName: icon).font(.system(size: 64)).foregroundStyle(color).symbolEffect(.bounce, value: phase) } else { ProgressView().controlSize(.large) }
      Text(title).font(.title2.bold()); Text(sub).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 32)
    }.transition(.opacity.combined(with: .scale))
  }
  var savedLimits: AISpendLimits.Saved? { AIConnect.saved(in: m.state ?? WalletState(.object([:])), demo: m.demo != nil) }
  func limitsLine(_ g: AISpendLimits.Saved, pending: Bool) -> String {
    let single = AnswerRules.format(g.single), daily = AnswerRules.format(g.daily), term = AnswerRules.format(g.term)
    if pending { return T("这次要确认的额度：每笔 \(single) · 每天 \(daily) · 总额 \(term) USDC。还没保存，也还没连接。", "Amounts to confirm: \(single) per payment · \(daily) per day · \(term) total USDC. Not saved and not connected yet.") }
    return T("这次使用已确认的额度：每笔 \(single) · 每天 \(daily) · 总额 \(term) USDC", "This uses your confirmed limit: \(single) per payment · \(daily) per day · \(term) total USDC")
  }
  func form(_ i: Info) -> some View {
    let grant = savedLimits
    let canApprove = grant != nil || (i.modeFirst && i.proposal != nil)
    return ScrollView { VStack(alignment: .leading, spacing: KP.Space.cardGap) {
      // t1278 A5 (§6#138, owner approved): name + official avatar ONLY from the signed return host; the AI's self-chosen name is never trusted
      let brand = ConnectBrand.verified(host: i.host)
      let shown = brand ?? i.host
      HStack(spacing: 14) { Avatar(name: shown, size: 52, symbol: brand.flatMap { b in AgentCard.mainnet.first { $0.name == b }?.symbol })
        Text(L("\(shown) 想连接你的钱包")).font(.title3.bold()).fixedSize(horizontal: false, vertical: true) }
      Label(T("连接后回到 \(i.host)", "Returns to \(i.host) after connecting"), systemImage: "arrow.uturn.backward.circle.fill")
        .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.accent).accessibilityIdentifier("connect.returnHost")
      if brand == nil, i.name != i.host { Text(T("它自称「\(i.name)」。只有你认识 \(i.host) 才批准。", "It calls itself \u{201C}\(i.name)\u{201D}. Approve only if you know \(i.host).")).font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("connect.selfName") }
      if !i.phone { Label(T("这个请求不是从这台 iPhone 发起的。不是你刚在 AI 里点的连接，就拒绝。", "This request didn't start on this iPhone. If you didn't just tap connect in your AI, decline."), systemImage: "exclamationmark.triangle.fill")
        .font(.footnote.weight(.semibold)).foregroundStyle(Brand.caution).accessibilityIdentifier("connect.notThisPhone") }
      Text(T("\(shown) 想在你设的 AI 付款上限内用这个钱包。", "\(shown) wants to pay from this wallet within your AI payment limit.")).font(.subheadline).foregroundStyle(.secondary)
      Text(grant.map { limitsLine($0, pending: false) } ?? i.proposal.map { limitsLine($0, pending: true) } ?? T("AI 花钱上限还没设置。这次不能批准。钱包安全上限不是你选的额度。", "AI spending limits are not set. This cannot be approved. The wallet safety limit is not a limit you chose."))
        .font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("connect.limits")
      DisclosureGroup(T("技术细节", "Technical details")) { VStack(alignment: .leading, spacing: 8) {
        LabeledContent(L("返回到"), value: i.host)
        LabeledContent(L("客户端"), value: String(i.clientId.prefix(14)))
        LabeledContent(L("有效到"), value: Date(timeIntervalSince1970: Double(i.exp)).formatted(date: .omitted, time: .shortened))
      }.padding(.top, 6) }.font(.subheadline).card(padding: 16)
      Label(L("连接后它只能申请信任新的收款方，付款能力不变；每个新收款方仍要你批准。"), systemImage: "lock.shield").font(.footnote).foregroundStyle(.secondary)
      BigButton(L("用 Face ID 批准"), icon: "faceid", disabled: !canApprove) { Task { await decide(true) } }.accessibilityIdentifier("connect.approve").accessibilityValue(req.id)
      BigButton(L("拒绝"), kind: .secondary) { Task { await decide(false) } }.accessibilityIdentifier("connect.decline")
    }.padding(20) }
  }
  func load() async {
    if savedLimits == nil, AIConnect.pendingAmounts == nil {
      await MainActor.run { AIConnect.openBlank(for: req.id) }
      dismiss(); return
    }
    #if DEBUG
    if m.demo != nil {
      if savedLimits == nil, let g = AIConnect.pendingAmounts {
        let claude = CommandLine.arguments.contains("-kpConnectClaude")
        let named = AIConnect.pendingAgent
        let name = named ?? (claude ? "Claude" : "Grok Bot")
        let host = named != nil ? "kipurse.com" : (claude ? "claude.ai" : "www.cursor.com")
        let redirect = named != nil ? "https://kipurse.com/connect/\(name)" : (claude ? "https://claude.ai/api/mcp/auth_callback" : "https://www.cursor.com/agents/mcp/oauth/callback")
        info = Info(name: name, clientId: "kpc_demo1234567890", redirect: redirect, host: host, exp: Int(Date().timeIntervalSince1970) + 540, phone: true, nonce: "demo", modeFirst: true, proposal: g)
      } else if CommandLine.arguments.contains("-kpConnectClaude") { info = Info(name: "Claude", clientId: "kpc_demo1234567890", redirect: "https://claude.ai/api/mcp/auth_callback", host: "claude.ai", exp: Int(Date().timeIntervalSince1970) + 540, phone: true) }
      else { info = Info(name: "Grok Bot", clientId: "kpc_demo1234567890", redirect: "https://www.cursor.com/agents/mcp/oauth/callback", host: "www.cursor.com", exp: Int(Date().timeIntervalSince1970) + 540) }
      if let n = Self.biometryPrecheck(demo: true) { phase = .unavailable(n); return }
      phase = .ready; return }
    #endif
    guard PhoneKey.isPresent() else { phase = .failed(T("这台 iPhone 还没开启 Face ID 批准：设置 → Face ID 批准。", "Face ID approvals aren't on for this iPhone yet: Settings → Face ID approvals.")); return }
    do {
      var body: [String: Any] = ["req": req.id]
      if savedLimits == nil, let g = AIConnect.pendingAmounts { body["single"] = String(g.single); body["daily"] = String(g.daily); body["total"] = String(g.term) }
      let j = try await PhoneKey.post("oauth/phone-prepare", body)
      guard let name = j["name"] as? String, let cid = j["clientId"] as? String, let ru = j["redirect"] as? String, let exp = (j["exp"] as? NSNumber)?.intValue,
            (j["wallet"] as? String)?.lowercased() == PhoneTrust.mainnetWallet.lowercased() else { phase = .failed(L("服务器回应不对")); return }
      // t1266 (fix 6): plain-text fields only; the shown / return host comes ONLY from the signed redirect URL; now < exp <= now + 15 min
      guard ConnectApproval.safeField(name, max: 80), ConnectApproval.safeField(cid, max: 128), let rhost = ConnectApproval.returnHost(redirect: ru), ConnectApproval.expOK(exp) else {
        phase = .failed(L("服务器给的内容和手机算出的不一致，已停止。")); return }
      if savedLimits == nil {
        guard ConnectApproval.acceptsFirstConnect(j["mode"] as? String), let nonce = j["nonce"] as? String,
              let single = Int64(j["single"] as? String ?? ""), let daily = Int64(j["daily"] as? String ?? ""), let total = Int64(j["total"] as? String ?? "") else {
          phase = .failed(T("这台服务器不能同时确认额度和连接，没有批准。", "This server cannot confirm the limit and the connection together. Nothing was approved.")); return }
        // t1266 (fix 6): the amounts must be EXACTLY the ones typed on this phone, and within the wallet safety limit
        if let why = ConnectApproval.firstConnectProblem(server: AISpendLimits.Saved(single: single, daily: daily, term: total), pending: AIConnect.pendingAmounts, caps: (m.state ?? WalletState(.object([:]))).capRead) {
          AuthLog.note("connect", "first amounts refused: \(why)")
          phase = .failed(T("服务器给的额度和你填的不一致，没有批准。", "The server's amounts don't match what you entered. Nothing was approved.")); return }
        let d = ConnectApproval.firstDigest(clientId: cid, agent: name, request: req.id, redirect: ru, single: single, daily: daily, total: total, nonce: nonce, exp: exp, approve: true)
        guard ConnectApproval.matches(d, server: j["digest"] as? String ?? "") else {
          AuthLog.record("connect-digest", NSError(domain: "kipurse.connect", code: 1, userInfo: [NSLocalizedDescriptionKey: "first digest mismatch"]))
          phase = .failed(L("服务器给的内容和手机算出的不一致，已停止。")); return }
        info = Info(name: name, clientId: cid, redirect: ru, host: rhost, exp: exp, phone: j["origin"] as? String == "phone", nonce: nonce, modeFirst: true, proposal: AISpendLimits.Saved(single: single, daily: daily, term: total))
      } else {
        let d = ConnectApproval.digest(req: req.id, clientId: cid, name: name, redirect: ru, exp: exp, approve: true)
        guard (j["mode"] as? String) != "first", ConnectApproval.matches(d, server: j["digest"] as? String ?? "") else {
          AuthLog.record("connect-digest", NSError(domain: "kipurse.connect", code: 1, userInfo: [NSLocalizedDescriptionKey: "digest mismatch"]))
          phase = .failed(L("服务器给的内容和手机算出的不一致，已停止。")); return }
        info = Info(name: name, clientId: cid, redirect: ru, host: rhost, exp: exp, phone: j["origin"] as? String == "phone")
      }
      if let n = Self.biometryPrecheck(demo: false) { withAnimation { phase = .unavailable(n) }; return }
      withAnimation { phase = .ready }
    } catch { phase = .failed(error.localizedDescription) }
  }
  /// t1153u: checked when the sheet opens (never shows a Face ID prompt). Only LAError -6 (Face ID off for Kipurse) is reported;
  /// "not enrolled", lockout etc. keep the existing paths.
  static func biometryPrecheck(demo: Bool) -> FaceIDNotice? {
    #if DEBUG
    if demo { return CommandLine.arguments.contains("-kpFaceIDOff") ? .faceIDOff : nil }
    #endif
    let ctx = LAContext(); var e: NSError?
    if ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e) { return nil }
    guard let e, FaceIDNotice.from(e) == .faceIDOff else { return nil }
    return .faceIDOff
  }
  func recheck() async {
    if case .unavailable(.faceIDOff) = phase, Self.biometryPrecheck(demo: m.demo != nil) != nil { return }
    withAnimation { phase = info != nil ? .ready : .loading }
    if info == nil { await load() }
  }
  func decide(_ approve: Bool) async {
    guard let i = info else { return }
    if approve && savedLimits == nil && !(i.modeFirst && i.proposal != nil) {
      withAnimation { phase = .failed(T("AI 花钱上限还没设置，没有批准。", "AI spending limits are not set. Nothing was approved.")) }
      return
    }
    #if DEBUG
    if m.demo != nil {
      if approve && CommandLine.arguments.contains("-kpSimulateFaceIDOff") { withAnimation { phase = .unavailable(.faceIDOff) }; return }   // t1153u: Secure Enclave said LAError -6
      if approve && savedLimits == nil {
        withAnimation { phase = .failed(T("服务器没有确认这次额度和连接，没有批准。", "The server did not confirm this limit or connection. Nothing was approved.")) }
        return
      }
      withAnimation { phase = .signing }; try? await Task.sleep(nanoseconds: 2_500_000_000)
      if CommandLine.arguments.contains("-kpSimulateFail") { Haptics.error(); withAnimation { phase = .failed(T("这台 iPhone 的 Face ID 批准已关闭", "Face ID approvals are off for this iPhone")) }; return }
      finish(approve); return }
    #endif
    guard PhoneKey.isPresent() else { phase = .failed(T("这台 iPhone 还没开启 Face ID 批准", "Face ID approvals aren't on for this iPhone")); return }
    guard ConnectApproval.expOK(i.exp) else { withAnimation { phase = .failed(T("这个连接请求已过期，没有批准。", "This connection request expired. Nothing was approved.")) }; return }   // t1266 (fix 6)
    let d: [UInt8]
    if approve && savedLimits == nil, let g = i.proposal {
      d = ConnectApproval.firstDigest(clientId: i.clientId, agent: i.name, request: req.id, redirect: i.redirect, single: g.single, daily: g.daily, total: g.term, nonce: i.nonce, exp: i.exp, approve: true)
    } else if !approve && savedLimits == nil, let g = i.proposal {
      d = ConnectApproval.firstDigest(clientId: i.clientId, agent: i.name, request: req.id, redirect: i.redirect, single: g.single, daily: g.daily, total: g.term, nonce: i.nonce, exp: i.exp, approve: false)
    } else {
      d = ConnectApproval.digest(req: req.id, clientId: i.clientId, name: i.name, redirect: i.redirect, exp: i.exp, approve: approve)
    }
    // t1157u: with no read session, ONE Face ID (this context) signs the approval and then the new read session, so the app reads the
    // fresh state right after 授权完成. With a session the key prompts by itself, exactly as before.
    await FaceIDUnlock.ensure()   // t1255 §6#124: Face ID locked by iOS -> passcode unlocks Face ID only (approves nothing)
    var ctx: LAContext? = nil
    defer { ctx?.invalidate() }
    do {
      if approve, MainnetSession.load() == nil {
        let c = LAContext(); c.localizedCancelTitle = L("取消"); c.touchIDAuthenticationAllowableReuseDuration = 0
        PromptLog.add("connect")
        AuthLog.note("connect", "faceid-1 start session=false")   // t1256
        _ = try await c.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: T("批准连接", "Approve connection"))
        AuthLog.note("connect", "faceid-1 ok")
        ctx = c
      }
      guard let k = PhoneKey.existing(context: ctx) else { phase = .failed(T("这台 iPhone 还没开启 Face ID 批准", "Face ID approvals aren't on for this iPhone")); return }
      let (r, s) = try PhoneKey.sign(d, key: k, reusesUnlock: ctx != nil)   // Face ID (or the context just confirmed)
      withAnimation { phase = .signing }
      let j = try await PhoneKey.post("oauth/phone-decide", ["req": req.id, "approve": approve, "r": Hex.encode(r), "s": Hex.encode(s)])
      let status = j["status"] as? String
      guard ConnectApproval.finishedDecision(status, approve: approve) else {
        withAnimation { phase = .failed(T("服务器没有同时确认额度和连接，没有批准。", "The server did not confirm the limit and the connection together. Nothing was approved.")) }
        return
      }
      if approve {
        AIConnect.pendingAmounts = nil
        if savedLimits == nil, i.modeFirst, let g = i.proposal { SignedLimitsStore.save(g, wallet: PhoneTrust.mainnetWallet) }   // t1275 (#2): exactly the amounts this Face ID signed (firstDigest), this device only
        m.applyEveryday(j["everyday"])   // t1157u: saved limits from the reply, even if the session step below fails
        if let c = j["siriCredential"] { SiriCredential.save(c) }   // t1158u: Siri's pay-only credential (only in the signed Siri approval reply)
        if let ctx { _ = try? await MainnetSession.signIn(context: ctx) }   // same confirmation, no second prompt
      }
      finish(approve)
    } catch {
      AuthLog.record("connect-decide", error)   // t1255: every Face ID failure is recorded (kp-auth.log)
      if let n = FaceIDUnlock.notice(error) { withAnimation { phase = .unavailable(n) }; return }   // t1153u: guidance, not the system's raw sentence
      Haptics.error(); withAnimation { phase = .failed(error.localizedDescription) } }
  }
  /// The connection was started on THIS phone inside the AI's app: bring that app back so its sign-in page (still open) sees the approval and finishes.
  /// t1279 (R17): the .done text names the AI only from the signed return host (verified brand, else the host), never info.name.
  var doneName: String { info.map { ConnectBrand.shown(host: $0.host) } ?? "AI" }
  var returnApp: URL? { guard let i = info, i.phone, let h = ConnectApproval.returnHost(redirect: i.redirect) else { return nil }; return ConnectReturn.app(host: h) }   // t1266: signed redirect host only
  func finish(_ approve: Bool) {
    if approve { Haptics.success() }
    withAnimation(.spring) { phase = approve ? .done : .declined }
    let back = returnApp
    Task {
      if let back { try? await Task.sleep(nanoseconds: 900_000_000)
        #if DEBUG
        if m.demo != nil { m.lastLaunch = back.absoluteString } else { await UIApplication.shared.open(back) }
        #else
        await UIApplication.shared.open(back)
        #endif
      }
      await m.refresh(); try? await Task.sleep(nanoseconds: back == nil ? 1_800_000_000 : 300_000_000); if phase == .done || phase == .declined { dismiss() } }
  }
}
