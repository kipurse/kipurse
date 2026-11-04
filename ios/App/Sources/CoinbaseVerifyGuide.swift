import SwiftUI
import KipurseCore

/// t625u: one beginner flow, big buttons, before a NEW wallet can be opened. The server decides (exact attestation check);
/// the app only guides and re-checks. Links: official Coinbase pages only.
@MainActor final class CBVerifyModel: ObservableObject {
  @Published var status: CoinbaseVerify.Status = .checking
  @Published var step = CBVerifyModel.savedStep { didSet { if !CBVerifyModel.testing { UserDefaults.standard.set(step, forKey: "kp.cbvStep") } } }   // 0 account, 1 identity, 2 on-chain verify, 3 back here
  @Published var lastChecked: Date?
  static var mockChecks = 0
  static var ownerFallback: String?
  static var testing: Bool {
    #if DEBUG
    return CommandLine.arguments.contains("-kpCBV")
    #else
    return false
    #endif
  }
  static var savedStep: Int { testing ? 0 : min(max(UserDefaults.standard.integer(forKey: "kp.cbvStep"), 0), 3) }
  /// Only NEW wallets are gated; existing wallets (re-setup, withdraw, stop) never are.
  static var applies: Bool {
    #if DEBUG
    if CommandLine.arguments.contains("-kpCBV") { return true }   // UI tests: simulate a new user
    #endif
    return OnboardAPI.isNew
  }
  /// The Coinbase wallet to check: the one chosen for a new wallet, else the existing wallet's owner (t635u: purchases need it too).
  static var owner: String? {
    if let o = UserDefaults.standard.string(forKey: CoinbaseIdentity.ownerKey), CoinbaseIdentity.isAddress(o) { return o }
    if let o = Operator.ownerAccount, CoinbaseIdentity.isAddress(o) { return o }
    if let o = ownerFallback, CoinbaseIdentity.isAddress(o) { return o }   // t864: home status uses the wallet's owner from state
    return nil
  }
  func check(countMock: Bool = true) async {
    status = .checking
    #if DEBUG
    if let i = CommandLine.arguments.firstIndex(of: "-kpCBV"), i + 1 < CommandLine.arguments.count {
      try? await Task.sleep(nanoseconds: 400_000_000)
      let mode = CommandLine.arguments[i + 1]
      if countMock { Self.mockChecks += 1 }; let after = Self.mockChecks
      status = mode == "ok" ? .verified : mode == "down" ? .unavailable : (mode == "later" && after >= 3 ? .verified : .notVerified)
      lastChecked = Date(); return
    }
    if UserDefaults.standard.string(forKey: "kpOnboardServer") != nil { status = .verified; return }   // simulator onboarding mock
    #endif
    guard let owner = Self.owner, var c = URLComponents(url: Mainnet.base.appendingPathComponent("onboard/new/verified"), resolvingAgainstBaseURL: false) else { status = .unavailable; return }
    c.queryItems = [URLQueryItem(name: "owner", value: owner)]
    var code = 0; var j: [String: Any]?
    if let u = c.url, let (d, r) = try? await URLSession.shared.data(from: u) { code = (r as? HTTPURLResponse)?.statusCode ?? 0; j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] }
    status = CoinbaseVerify.status(code: code, json: j); lastChecked = Date()
  }
}

struct CBVerifyGuide: View {
  @ObservedObject var v: CBVerifyModel
  @Environment(\.scenePhase) private var phase
  @State private var lastOpen = ""
  @State private var copied = false
  @State private var showWhy = false
  @AppStorage("kp.cbvRemindLater") private var remindLater = false
  @ScaledMetric(relativeTo: .headline) private var badge: CGFloat = 32
  static var ownerAddress: String? {
    #if DEBUG
    if let i = CommandLine.arguments.firstIndex(of: "-kpCBVOwner"), i + 1 < CommandLine.arguments.count { return CommandLine.arguments[i + 1] }   // t876 tests: another user's address
    if CommandLine.arguments.contains("-kpCBV") { return "0x1000000000000000000000000000000000000003" }
    #endif
    return CBVerifyModel.owner
  }
  struct Step { let title: String; let body: String; let button: String?; let url: URL? }
  static var steps: [Step] { [
    Step(title: T("有 Coinbase 账户吗？", "Have a Coinbase account?"), body: T("没有的话先免费注册一个。已经有就直接点「下一步」。", "If not, sign up first (free). Already have one? Tap Next."),
         button: T("打开 Coinbase 注册", "Open Coinbase sign-up"), url: CoinbaseVerify.signupURL),
    Step(title: T("在 Coinbase 完成身份验证", "Verify your identity on Coinbase"), body: T("打开 Coinbase 官方验证页，用你的 Coinbase 账户登录。如果还没验证过身份，页面会带你上传证件。这一步由 Coinbase 做，启付看不到你的任何证件和资料。", "Open Coinbase's official verification page and sign in with your Coinbase account. If you haven't verified your identity yet, it walks you through uploading your ID. Coinbase does this; Kipurse never sees your ID or details."),
         button: T("打开 Coinbase 官方验证页", "Open Coinbase's verification page"), url: CoinbaseVerify.onchainVerifyURL),   // t771u: was a help article
    Step(title: T("在 Coinbase 链上验证你的地址", "Verify your address on Coinbase (on-chain)"), body: T("在同一个页面：用 Coinbase 登录 → 点 Get verified → 连接你登录启付用的同一个钱包 → 签一次（不花钱）的验证（不花钱）。完成后回到启付，点「我已验证，重新检查」。", "On the same page: sign in with Coinbase → tap Get verified → connect the same wallet you use for Kipurse → sign the free verification (costs nothing). Then come back to Kipurse and tap “I verified, check again”."),
         button: T("打开 Coinbase 链上验证", "Open Coinbase Onchain Verify"), url: CoinbaseVerify.onchainVerifyURL),
    Step(title: T("回到启付", "Come back to Kipurse"), body: T("回来后启付会自动重新检查。通过后就能开通。", "When you come back, Kipurse checks again by itself. Once it passes you can open your wallet."),
         button: nil, url: nil)] }
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(T("先完成 Coinbase 认证", "Verify with Coinbase first")).font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbv.title")
      Button { Haptics.tap(); withAnimation(Brand.spring) { showWhy.toggle() } } label: { Label(T("为什么要这一步？", "Why this step?"), systemImage: "info.circle").font(.subheadline.weight(.semibold)) }.accessibilityIdentifier("cbv.whyButton")
      if showWhy {
        Text(T("Coinbase 只在链上给你一个“已验证”标记。启付看不到你的姓名和证件，也没有邮箱和密码。这样可以防止有人冒用别人的身份开钱包。一个验证只能开一个启付钱包。", "Coinbase only puts a public “verified” mark on-chain. Kipurse never sees your name or ID, and has no email or password. This stops anyone opening a wallet with someone else's identity. One verification opens one Kipurse wallet.")).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(14).background(Brand.accentSoft, in: RoundedRectangle(cornerRadius: 14, style: .continuous)).transition(.opacity.combined(with: .move(edge: .top))).accessibilityIdentifier("cbv.whyText")
      }
      ProgressView(value: Double(min(v.step, 3)), total: 3).tint(Brand.accent)
      Text(T("第 \(min(v.step + 1, 4)) 步，共 4 步", "Step \(min(v.step + 1, 4)) of 4")).font(.footnote.weight(.semibold)).foregroundStyle(Brand.accent).accessibilityIdentifier("cbv.progress")
      VStack(alignment: .leading, spacing: 10) { ForEach(Array(Self.steps.enumerated()), id: \.offset) { i, s in row(i, s) } }
      statusLine
      BigButton(v.status == .checking ? T("正在检查…", "Checking…") : T("我已验证，重新检查", "I verified, check again"), icon: "arrow.clockwise", disabled: v.status == .checking) {
        Haptics.tap(); Task { await v.check() } }.accessibilityIdentifier("cbv.recheck")
      Button { Haptics.tap(); remindLater = true } label: { Text(remindLater ? T("好的，下次打开启付时会再提醒你。进度已保存。", "OK, we'll remind you next time you open Kipurse. Your progress is saved.") : T("稍后再做，下次提醒我", "Do it later, remind me next time")).font(.subheadline) }
        .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityIdentifier("cbv.later")
      #if DEBUG
      if !lastOpen.isEmpty { Text(lastOpen).font(.caption2).accessibilityIdentifier("cbv.debugOpen") }
      #endif
    }.padding(.horizontal, 4)
    .animation(Brand.spring, value: v.step)
    .onChange(of: phase) { p in if p == .active && v.status != .verified { Task { await v.check() } } }   // back from Coinbase: re-check by itself
  }
  @ViewBuilder func row(_ i: Int, _ s: Step) -> some View {
    let done = i < v.step, now = i == v.step
    let r = HStack(alignment: .top, spacing: 12) {
      ZStack { Circle().fill(done ? AnyShapeStyle(Brand.positive) : now ? AnyShapeStyle(LinearGradient(colors: [Brand.accentHi, Brand.accent], startPoint: .top, endPoint: .bottom)) : AnyShapeStyle(Brand.accentSoft)).frame(width: badge, height: badge).shadow(color: now ? Brand.accent.opacity(0.45) : .clear, radius: 8, y: 3)
        if done { Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(.white).kBounce(v.step) } else { Text("\(i + 1)").font(.subheadline.bold()).foregroundStyle(now ? .white : Brand.accent) } }
      VStack(alignment: .leading, spacing: 6) {
        Text(s.title).font(.headline).foregroundStyle(now || done ? Color.primary : Color.secondary).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).accessibilityIdentifier("cbv.step\(i + 1)")
        if now {
          Text(s.body).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          if let b = s.button, let u = s.url, CoinbaseVerify.isOfficial(u) {
            BigButton(b, icon: "arrow.up.forward.app") { Haptics.tap(); open(u) }.accessibilityIdentifier("cbv.open\(i + 1)") }
          if i == 2 { VerifyWalletHelp(address: Self.ownerAddress) }   // t866: red-circled Coinbase Wallet + address check
          if i < 3 { Button { Haptics.tap(); withAnimation { v.step = i + 1 } } label: { Text(T("我做完了，下一步", "Done, next step")).font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity) }
            .buttonStyle(.bordered).controlSize(.large).tint(Brand.accent).accessibilityIdentifier("cbv.next\(i + 1)") }
        }
      }
    }
    // t771u: each step is its own clearly separated row (no crowding), at any text size
    if now { r.card(padding: 16) } else { r.padding(.vertical, 12).padding(.horizontal, 16).frame(maxWidth: .infinity, alignment: .leading).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14)) }
  }
  @ViewBuilder var statusLine: some View {
    switch v.status {
    case .checking: Label(T("正在检查 Coinbase 验证…", "Checking Coinbase verification…"), systemImage: "hourglass").font(.subheadline).accessibilityIdentifier("cbv.status.checking")
    case .verified: Label(T("已通过 Coinbase 验证", "Coinbase verification passed"), systemImage: "checkmark.seal.fill").foregroundStyle(Brand.positive).font(.subheadline.weight(.semibold)).accessibilityIdentifier("cbv.status.ok")
    case .notVerified: Label(T("还没查到验证。完成上面的步骤后点下面的按钮。", "No verification found yet. Finish the steps above, then tap the button below."), systemImage: "info.circle").foregroundStyle(Brand.caution).font(.subheadline).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbv.status.none")
    case .unavailable: Label(T("暂时查不了（网络问题），没有开通、没有扣钱。请稍后再点重新检查。", "Can't check right now (network). Nothing was opened or charged. Please tap check again in a moment."), systemImage: "wifi.exclamationmark").foregroundStyle(Brand.negative).font(.subheadline).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbv.status.down")
    }
  }
  func open(_ u: URL) {
    #if DEBUG
    if CommandLine.arguments.contains("-kpCBV") { lastOpen = u.absoluteString; return }
    #endif
    // t875 (LOCKED, owner): Coinbase verification ALWAYS opens in the in-app browser, never Safari/external, in every version.
    if u.host?.contains("coinbase.com") == true, u.path.contains("onchain-verify") { InApp.open(u, banner: VerifyWalletHelp.banner(Self.ownerAddress)) }
    else { InApp.open(u) }
  }
}


/// t866: what to pick on Coinbase's "关联钱包" page (red circle on Coinbase Wallet) + the address to check before signing.
/// t876: `address` is ALWAYS the signed-in user's own owner (Coinbase wallet) address; unknown/invalid -> the address box is hidden (never someone else's).
struct VerifyWalletHelp: View {
  let address: String?
  @State private var full = false; @State private var copied = false
  static func short(_ a: String) -> String { a.count > 12 ? String(a.prefix(6)) + "…" + String(a.suffix(4)) : a }
  static var pendingNote: String { T("签名后 Coinbase 可能要 30 分钟左右才生效，页面显示「正在验证/待处理」不用重做，启付会自动检查。", "After you sign, Coinbase can take about 30 minutes to take effect. If the page shows \u{201C}Verifying/Pending\u{201D}, you don't need to redo it; Kipurse checks automatically.") }
  static func banner(_ a: String?) -> String {
    guard let a, CoinbaseIdentity.isAddress(a) else { return T("选 Coinbase Wallet", "Pick Coinbase Wallet") }
    return bannerWith(a) }
  static func bannerWith(_ a: String) -> String { T("选 Coinbase Wallet · 核对地址 \(short(a))", "Pick Coinbase Wallet · check address \(short(a))") }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(T("选这个：Coinbase Wallet", "Pick this one: Coinbase Wallet")).font(.headline).foregroundStyle(Color(red: 1, green: 0.3, blue: 0.3)).accessibilityIdentifier("cbv.pick")
      Image("verify-wallet-pick").resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.white.opacity(0.12), lineWidth: 1))
        .accessibilityLabel(T("Coinbase 关联钱包页面，红圈圈出 Coinbase Wallet", "Coinbase connect-wallet page with Coinbase Wallet circled in red")).accessibilityIdentifier("cbv.pickImage")
      if let address, CoinbaseIdentity.isAddress(address) {
      VStack(alignment: .leading, spacing: 8) {
        Text(T("要验证的地址（你的 Coinbase 钱包）", "Address to verify (your Coinbase wallet)")).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
        Text(full ? address : Self.short(address)).font(full ? .callout.monospaced().weight(.semibold) : .system(size: 28, weight: .bold, design: .monospaced))
          .textSelection(.enabled).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbv.address")
        HStack(spacing: 10) {
          Button { withAnimation { full.toggle() } } label: { Label(full ? T("收起", "Collapse") : T("显示完整地址", "Show full address"), systemImage: full ? "chevron.up" : "chevron.down") }.buttonStyle(.bordered).accessibilityIdentifier("cbv.full")
          Button { UIPasteboard.general.string = address; Haptics.success(); copied = true } label: { Label(copied ? T("已复制", "Copied") : T("复制", "Copy"), systemImage: copied ? "checkmark" : "doc.on.doc") }.buttonStyle(.bordered).accessibilityIdentifier("cbv.copy")
        }
        Label(T("连上后先核对地址是不是这个，对了再签名；不对就别签。", "After connecting, first check the address is this one. Sign only if it matches; if not, don't sign."), systemImage: "exclamationmark.shield.fill")
          .font(.subheadline.weight(.semibold)).foregroundStyle(Brand.caution).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbv.checkAddr")
        Text(VerifyWalletHelp.pendingNote).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbv.pending")
      }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Brand.caution.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Brand.caution.opacity(0.35), lineWidth: 1))
      }
    }
  }
}
