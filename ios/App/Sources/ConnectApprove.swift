import SwiftUI
import KipurseCore

struct ConnectReq: Identifiable { let id: String }

/// Pending agent connection on the wallet page: opens the Face ID approval.
struct MainConnectCard: View {
  @EnvironmentObject var m: AppModel; let r: ConnectRequest
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 12) {
        Avatar(name: r.client, size: 40, symbol: AgentCard.mainnet.first { $0.id == r.kind }?.symbol ?? "link")
        VStack(alignment: .leading, spacing: 2) {
          Text(L("\(r.client) 想连接")).font(.headline)
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
  struct Info { let name, clientId, redirect, host: String; let exp: Int; var phone = false }
  enum Phase: Equatable { case loading, ready, signing, done, declined, failed(String) }
  @State private var info: Info?
  @State private var phase: Phase = .loading
  var body: some View {
    NavigationStack {
      ZStack {
        Brand.canvas.ignoresSafeArea()
        switch phase {
        case .loading: ProgressView(L("正在读取请求…"))
        case .signing: status(icon: nil, title: L("授权中…"), sub: L("正在核对手机确认")).accessibilityElement(children: .combine).accessibilityIdentifier("connect.signing")
        case .done: status(icon: "checkmark.circle.fill", title: L("授权完成"), sub: returnApp != nil ? L("正在返回 \(info?.name ?? "AI")…") : L("\(info?.name ?? "AI") 已连接，网页会自动返回它。"), color: Brand.positive).accessibilityElement(children: .combine).accessibilityIdentifier("connect.done")
        case .declined: status(icon: "xmark.circle.fill", title: L("已拒绝"), sub: L("这个 AI 没有连接。"), color: .secondary)
        case .failed(let e): VStack(spacing: 14) { status(icon: "exclamationmark.triangle.fill", title: L("没有完成"), sub: e, color: Brand.negative)
            if info != nil { BigButton(L("重试"), icon: "arrow.clockwise") { phase = .ready }.padding(.horizontal, 24).accessibilityIdentifier("connect.retry") } }
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
  func form(_ i: Info) -> some View {
    ScrollView { VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 14) { Avatar(name: i.name, size: 52, symbol: AgentCard.mainnet.first { $0.name == i.name }?.symbol)
        Text(L("\(i.name) 想连接你的钱包")).font(.title3.bold()).fixedSize(horizontal: false, vertical: true) }
      Text(T("\(i.name) 想在你设的 AI 付款上限内用这个钱包。", "\(i.name) wants to pay from this wallet within your AI payment limit.")).font(.subheadline).foregroundStyle(.secondary)
      DisclosureGroup(T("技术细节", "Technical details")) { VStack(alignment: .leading, spacing: 8) {
        LabeledContent(L("返回到"), value: i.host)
        LabeledContent(L("客户端"), value: String(i.clientId.prefix(14)))
        LabeledContent(L("有效到"), value: Date(timeIntervalSince1970: Double(i.exp)).formatted(date: .omitted, time: .shortened))
      }.padding(.top, 6) }.font(.subheadline).card(padding: 16)
      Label(L("连接后它只能申请信任新的收款方，付款能力不变；每个新收款方仍要你批准。"), systemImage: "lock.shield").font(.footnote).foregroundStyle(.secondary)
      BigButton(L("用 Face ID 批准"), icon: "faceid") { Task { await decide(true) } }.accessibilityIdentifier("connect.approve")
      BigButton(L("拒绝"), kind: .secondary) { Task { await decide(false) } }.accessibilityIdentifier("connect.decline")
    }.padding(20) }
  }
  func load() async {
    #if DEBUG
    if m.demo != nil {
      if CommandLine.arguments.contains("-kpConnectClaude") { info = Info(name: "Claude", clientId: "kpc_demo1234567890", redirect: "https://claude.ai/api/mcp/auth_callback", host: "claude.ai", exp: Int(Date().timeIntervalSince1970) + 540, phone: true) }
      else { info = Info(name: "Grok Bot", clientId: "kpc_demo1234567890", redirect: "https://www.cursor.com/agents/mcp/oauth/callback", host: "www.cursor.com", exp: Int(Date().timeIntervalSince1970) + 540) }
      phase = .ready; return }
    #endif
    guard PhoneKey.isPresent() else { phase = .failed(T("这台 iPhone 还没开启 Face ID 批准：设置 → Face ID 批准。", "Face ID approvals aren't on for this iPhone yet: Settings → Face ID approvals.")); return }
    do {
      let j = try await PhoneKey.post("oauth/phone-prepare", ["req": req.id])
      guard let name = j["name"] as? String, let cid = j["clientId"] as? String, let ru = j["redirect"] as? String, let exp = (j["exp"] as? NSNumber)?.intValue,
            (j["wallet"] as? String)?.lowercased() == PhoneTrust.mainnetWallet.lowercased() else { phase = .failed(L("服务器回应不对")); return }
      let d = ConnectApproval.digest(req: req.id, clientId: cid, name: name, redirect: ru, exp: exp, approve: true)
      guard ConnectApproval.matches(d, server: j["digest"] as? String ?? "") else {   // fields shown == fields signed
        AuthLog.record("connect-digest", NSError(domain: "kipurse.connect", code: 1, userInfo: [NSLocalizedDescriptionKey: "digest mismatch"]))
        phase = .failed(L("服务器给的内容和手机算出的不一致，已停止。")); return }
      info = Info(name: name, clientId: cid, redirect: ru, host: j["returnsTo"] as? String ?? URL(string: ru)?.host ?? "", exp: exp, phone: j["origin"] as? String == "phone"); withAnimation { phase = .ready }
    } catch { phase = .failed(error.localizedDescription) }
  }
  func decide(_ approve: Bool) async {
    guard let i = info else { return }
    #if DEBUG
    if m.demo != nil { withAnimation { phase = .signing }; try? await Task.sleep(nanoseconds: 2_500_000_000)
      if CommandLine.arguments.contains("-kpSimulateFail") { Haptics.error(); withAnimation { phase = .failed(T("这台 iPhone 的 Face ID 批准已关闭", "Face ID approvals are off for this iPhone")) }; return }
      finish(approve); return }
    #endif
    guard let k = PhoneKey.existing() else { phase = .failed(T("这台 iPhone 还没开启 Face ID 批准", "Face ID approvals aren't on for this iPhone")); return }
    let d = ConnectApproval.digest(req: req.id, clientId: i.clientId, name: i.name, redirect: i.redirect, exp: i.exp, approve: approve)
    do {
      let (r, s) = try PhoneKey.sign(d, key: k)   // Face ID
      withAnimation { phase = .signing }
      _ = try await PhoneKey.post("oauth/phone-decide", ["req": req.id, "approve": approve, "r": Hex.encode(r), "s": Hex.encode(s)])
      finish(approve)
    } catch { Haptics.error(); withAnimation { phase = .failed(error.localizedDescription) } }
  }
  /// The connection was started on THIS phone inside the AI's app: bring that app back so its sign-in page (still open) sees the approval and finishes.
  var returnApp: URL? { guard let i = info, i.phone else { return nil }; return ConnectReturn.app(host: i.host) }
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
