import SwiftUI
import KipurseCore
import CoreImage.CIFilterBuiltins

// MARK: - Helpers

/// One payment row from /api/state purchases (engine.listPurchases).
struct Tx: Identifiable {
  let id: String, amount: Int64, payee: String, agent: String, state: String, txHash: String?, date: Date?
  var merchantRaw: String? = nil, badge = "new", contact: String? = nil, website: String? = nil
  /// Plain merchant name: registered name, "Card · <shop>" for real-world card payments, else a short address.
  var merchantName: String { if let r = merchantRaw, !r.isEmpty { let m = DisplaySafe.merchant(r); if m.isEmpty { return shortAddr(payee) }; return m.hasPrefix("card:") ? T("实体店 · ", "In store · ") + m.dropFirst(5) : m }; return shortAddr(payee) }  // t690: display-safe (no bidi / fake address / fake ✅)
  /// t691: no usable name from the agent/merchant -> a friendly title; the short address moves to the secondary line.
  var unnamed: Bool { merchantRaw.map { DisplaySafe.merchant($0).isEmpty } ?? true }
  var friendlyTitle: String { unnamed ? T("未命名收款方", "Unnamed payee") : merchantName }
  var merchantVerified: Bool { badge != "new" }
  var badgeText: String { badge == "trusted" ? T("你信任的商家", "Trusted by you") : badge == "verified" ? T("已验证商家", "Verified merchant") : T("新商家", "New shop") }
  init(_ j: JSONValue, _ i: Int) {
    merchantRaw = j["merchantName"]?.string ?? j["merchant"]?.string; badge = j["badge"]?.string ?? "new"; contact = j["merchantContact"]?.string; website = j["merchantWebsite"]?.string
    id = j["purchaseKey"]?.string ?? "p\(i)"; amount = j["amount"]?.atomic ?? 0; payee = j["payee"]?.string ?? ""
    agent = j["agent"]?.string ?? "AI"; state = j["state"]?.string ?? ""; txHash = j["txHash"]?.string
    date = Tx.parseDate(j["createdAt"])
  }
  static func parseDate(_ v: JSONValue?) -> Date? {
    switch v {
    case .number(let n)?: return Date(timeIntervalSince1970: n > 1e12 ? n / 1000 : n)
    case .string(let s)?: if let n = Double(s) { return parseDate(.number(n)) }
      return ISO8601DateFormatter().date(from: s) ?? { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.date(from: s) }()
    default: return nil
    }
  }
  var failed: Bool { ["failed", "rejected", "reverted", "expired"].contains(state.lowercased()) }
  var pending: Bool { ["pending", "submitted", "claimed", "authorized", "reserved"].contains(state.lowercased()) }
  var stateZh: String { failed ? L("失败") : pending ? L("处理中") : L("已付") }
  var stateColor: Color { failed ? Brand.negative : pending ? Brand.caution : Brand.positive }
}
extension WalletState {
  var txs: [Tx] { purchases.enumerated().map { Tx($1, $0) } }
  var spentToday: Int64 { if let v = serverSpentToday { return v }; return txs.filter { !$0.failed && ($0.date.map(Calendar.current.isDateInToday) ?? false) }.reduce(0) { $0 + $1.amount } }
  var spentTerm: Int64 { if let v = serverSpentTerm { return v }; return txs.filter { !$0.failed }.reduce(0) { $0 + $1.amount } }
  var termTotal: Int64 { if let v = capTerm { return v }; return AnswerRules.parseUSDC(raw["setup"]?["human"]?["termTotal"]?.string ?? "") ?? 0 }
  var explorer: String { raw["explorer"]?.string ?? "https://basescan.org" }
  var liveAgents: [JSONValue] { agents.filter { !($0["revoked"]?.bool ?? false) } }
}
/// Truthful agent status from lastUsed (last MCP request seen by the server). 在线 only if used within 2 minutes.
struct AgentStatus {
  let online: Bool, text: String; var lastUse = L("从未使用")
  init(_ a: JSONValue, now: Date = Date()) {
    guard let d = Tx.parseDate(a["lastUsed"]) else { online = false; text = L("已授权 · 从未使用"); return }
    let sec = max(0, now.timeIntervalSince(d)); online = sec <= 120
    let ago = sec < 60 ? L("刚刚") : sec < 3600 ? L("\(Int(sec / 60)) 分钟前") : sec < 86400 ? L("\(Int(sec / 3600)) 小时前") : L("\(Int(sec / 86400)) 天前")
    text = L("已授权 · 最近使用 \(ago)"); lastUse = L("最近使用 \(ago)")
  }
}
extension AgentStatus {
  static func ago(_ d: Date, now: Date = Date()) -> String {
    let sec = max(0, now.timeIntervalSince(d))
    return sec < 60 ? L("刚刚用过") : sec < 3600 ? L("\(Int(sec / 60)) 分钟前用过") : sec < 86400 ? L("\(Int(sec / 3600)) 小时前用过") : L("\(Int(sec / 86400)) 天前用过")
  }
}
/// Full address in groups of 4 ("0x1234 ABCD …") so a lookalike (same first/last 4) can't pass a glance. Use wherever money goes.
func fullAddr(_ a: String) -> String { AddressDisplay.full(a) }
func shortAddr(_ a: String) -> String { AddressDisplay.short(a) }

// MARK: - Onboarding (full screen, before login)

struct OnboardingView: View {
  @EnvironmentObject var m: AppModel
  @State private var scanning = false
  @State private var pasting = false
  @State private var pasted = ""
  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 28) {
          BrandMark(size: 64).padding(.top, 40)
          VStack(alignment: .leading, spacing: 10) {
            Text("Kipurse").font(.system(size: 40, weight: .bold, design: .rounded))
            Text(L("给 AI 一个有上限的钱包。你签一次名，它在规则内自己付款，每一笔都能在链上查到。"))
              .font(.title3).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          }
          VStack(alignment: .leading, spacing: 20) {
            row("desktopcomputer", L("在电脑上打开 Kipurse"), L("双击“Start Kipurse”或“Share to iPhone”。"))
            row("qrcode.viewfinder", L("扫电脑屏幕上的二维码"), L("登录码只能用一次，几分钟后失效。"))
            row("checkmark.shield", L("回答 7 个问题，签一次名"), L("之后 AI 就能在上限内付款。"))
          }
          WhySafe()
          WarnBox(text: L("AI 只能在你设的额度内花钱，建议先放少量试试。"))
          if !m.lastRemnants.isEmpty { WarnBox(text: L("退出后还有残留：\(m.lastRemnants.joined(separator: "；"))"), tone: Brand.negative) }
          if m.recovery != nil {
            Button { m.showRecovery = true } label: { Label(L("离线提现指南（已删除的账户）"), systemImage: "lifepreserver") }.font(.headline)
          }
          if pasting {
            VStack(alignment: .leading, spacing: 10) {
              TextField("https://\(AppConfig.server?.host ?? "kipurse.example.com")/login?code=…", text: $pasted).textInputAutocapitalization(.never).autocorrectionDisabled()
                .font(.callout.monospaced()).padding(14)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
              BigButton(L("登录"), kind: .secondary, disabled: OwnerLink.parse(pasted) == nil) { if let l = OwnerLink.parse(pasted) { Task { await m.login(l) } } }
            }
          }
        }.padding(.horizontal, 24).padding(.bottom, 24)
      }
      VStack(spacing: 12) {
        if m.busy { ProgressView(L("登录中…")) }
        BigButton(L("扫二维码登录"), icon: "qrcode.viewfinder") { scanning = true }
        Button(pasting ? L("收起") : L("或者粘贴登录链接（只能用一次）")) { withAnimation(Brand.spring) { pasting.toggle() } }
        Button(T("先看看演示（不用登录）", "Try the demo — no sign-in")) { m.startDemo() }.font(.subheadline.weight(.semibold))
          .font(.subheadline.weight(.medium)).tint(Brand.accent)
      }.padding(.horizontal, 24).padding(.vertical, 16).background(.bar)
    }
    .background(Brand.canvas)
    .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in scanning = false }
    .sheet(isPresented: $scanning) {
      QRScanner { s in scanning = false; if let l = OwnerLink.parse(s) { Task { await m.login(l) } } else { m.show(L("不是 Kipurse 登录码"), L("请扫电脑上 Kipurse 页面显示的二维码。")) } }.ignoresSafeArea()
    }
  }
  private func row(_ icon: String, _ t: String, _ d: String) -> some View {
    HStack(alignment: .top, spacing: 16) {
      Image(systemName: icon).font(.title2).foregroundStyle(Brand.accent).frame(width: 32)
      VStack(alignment: .leading, spacing: 2) { Text(t).font(.headline); Text(d).font(.subheadline).foregroundStyle(.secondary) }
    }
  }
}

/// "Why this is safe" — answers the skeptic before anything is asked of them.
struct WhySafe: View {
  @State private var learn = false
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(T("为什么放心", "Why this is safe")).font(.title3.bold())
      item("lock.shield.fill", T("我们碰不到你的钱", "We can't touch your money"), T("钱在只有你能控制的钱包里。Kipurse 和 AI 只能在你设的上限内付款。", "Your money sits in a wallet only you control. Kipurse and your AI can only pay within the limits you set."))
      item("gauge.with.dots.needle.33percent", T("额度只有你能改", "Only you change the allowance"), T("每笔、每天、总额度由你决定，只有你能改，改的时候要 Face ID；超出额度也要你 Face ID 同意。", "You set per-payment, daily and total allowances. Only you can change them, with Face ID; anything over needs your Face ID too."))
      item("hand.raised.fill", T("随时停止", "Stop anytime"), T("一键暂停任何 AI，或一键把钱全部提现，就算我们的服务器不在了也能提。", "Pause any AI in one tap, or take all your money back — even if our servers disappear."))
      item("chevron.left.forwardslash.chevron.right", T("代码公开", "Open source"), T("所有代码公开，任何人都能检查。", "All the code is public so anyone can check it."))
      DisclosureGroup(isExpanded: $learn) {
        VStack(alignment: .leading, spacing: 6) {
          Text(T("USDC：和美元 1:1 的数字美元，由 Circle 发行。", "USDC: a digital dollar worth exactly $1, issued by Circle.")).font(.footnote)
          Text(T("Base：Coinbase 做的网络，转账几乎免费、几秒到账。", "Base: Coinbase's network — payments settle in seconds for under a cent.")).font(.footnote)
          Text(T("确认：用 Face ID / 通行密钥确认一次，相当于给 AI 一张有额度的卡。", "Approve once: Face ID / passkey confirms the limits — like giving your AI a card with a spending cap.")).font(.footnote)
          Text(T("链上记录：每笔付款都有公开收据，谁都改不了。", "Public record: every payment has a receipt nobody can alter.")).font(.footnote)
        }.foregroundStyle(.secondary).padding(.top, 6)
      } label: { Text(T("了解更多（名词解释）", "Learn more (glossary)")).font(.subheadline.weight(.semibold)) }.tint(Brand.accent)
    }.card()
  }
  private func item(_ i: String, _ t: String, _ d: String) -> some View {
    HStack(alignment: .top, spacing: 12) { Image(systemName: i).foregroundStyle(Brand.positive).font(.title3).frame(width: 28)
      VStack(alignment: .leading, spacing: 2) { Text(t).font(.headline); Text(d).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) } }
  }
}

// MARK: - Setup flow (full screen, after login, before tabs)

struct SetupFlow: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  var body: some View {
    NavigationStack {
      Group { if s.hasSetup && !s.active && s.pendingCalls != nil { ScrollView { FundAndSign(s: s).padding(20) } } else { SetupWizard() } }
        .background(Brand.canvas)
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Menu { Button(L("退出登录"), role: .destructive) { m.logout() } } label: { Image(systemName: "ellipsis.circle") } } }
    }
  }
}

struct SetupWizard: View {
  @EnvironmentObject var m: AppModel
  @State private var ans: [String:String] = [:]
  @State private var step = 0
  @State private var err = ""
  private let qs: [(key: String, zh: String, presets: [String], unit: String)] = [
    ("termDays",L("授权多久？到期自动失效，不会自动续期。"),["30","90","180","365"],L("天")),
    ("perPayment",L("AI 每笔最多付多少？"),["1","2","5","10"],"USDC"),
    ("perDay",L("AI 每天最多花多少？（含手续费）"),["2","5","10","20"],"USDC"),
    ("termTotal",L("整个期间最多花多少？"),["10","20","50","100"],"USDC"),
    ("unrecognizedPerPayment",L("付给陌生收款方，每笔最多？"),["0.1","0.2","0.5","1"],"USDC"),
    ("unrecognizedPerDay",L("付给陌生收款方，每天最多？"),["0.2","0.5","1","2"],"USDC"),
    ("depositDailyLimit",L("每天最多接收多少充值？（超出的先冻结，不退回）"),["5","10","20","50"],"USDC")]
  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        StepProgress(current: step, total: qs.count + 1)
        Text(step < qs.count ? L("第 \(step + 1) / \(qs.count) 题") : L("最后确认")).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
      }.padding(.horizontal, 20).padding(.top, 8)
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if step < qs.count {
            let q = qs[step]
            AmountPicker(title: q.zh, presets: q.presets, unit: q.unit, isDays: q.key == "termDays", value: Binding(get: { ans[q.key] ?? "" }, set: { ans[q.key] = $0; err = "" }))
              .id(q.key).card(padding: 20)
            if !err.isEmpty { ErrorText(text: err) }
          } else {
            let r = AnswerRules.check(ans)
            VStack(spacing: 0) {
              ForEach(Array(qs.enumerated()), id: \.offset) { i, q in
                Button { step = i } label: {
                  HStack {
                    Text(q.zh.components(separatedBy: CharacterSet(charactersIn: "？?")).first ?? q.key)  // i18n-ok: zh/en question mark.font(.subheadline).foregroundStyle(.primary).multilineTextAlignment(.leading)
                    Spacer(minLength: 12)
                    Text("\(ans[q.key] ?? "") \(q.unit)").font(Brand.money(17, .semibold)).foregroundStyle(.primary)
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                  }.padding(.vertical, 12)
                }
                if i < qs.count - 1 { Divider() }
              }
            }.card(padding: 16)
            ForEach(r.errors, id: \.zh) { ErrorText(text: $0.zh) }
            ForEach(r.warnings, id: \.self) { WarnBox(text: $0) }
            WarnBox(text: L("AI 只能在你设的额度内花钱，建议先放少量试试。"), tone: Brand.negative, icon: "exclamationmark.shield.fill")
            Text(L("下一步会打开确认页面：先用 Coinbase 钱包连接（选“通行密钥 / Face ID”），在页面上勾选同意，然后点“准备”。"))
              .font(.footnote).foregroundStyle(.secondary)
          }
        }.padding(20)
      }
      VStack(spacing: 10) {
        if step < qs.count {
          let q = qs[step]
          BigButton(L("下一步"), disabled: (ans[q.key] ?? "").isEmpty) {
            let sub = Dictionary(uniqueKeysWithValues: qs.prefix(step + 1).map { ($0.key, ans[$0.key] ?? "") })
            let r = AnswerRules.check(sub, partial: true)
            if r.ok { withAnimation(Brand.spring) { step += 1 } } else { Haptics.warn(); err = r.errors.map(\.zh).joined(separator: T("；", "; ")) }
          }
        } else {
          BigButton(L("打开确认页面"), icon: "signature", disabled: !AnswerRules.check(ans).ok) { Task { await m.startSetup(answers: ans) } }
        }
      }.padding(.horizontal, 20).padding(.vertical, 12).background(.bar)
    }
    .navigationTitle(L("设置钱包")).navigationBarTitleDisplayMode(.inline)
    .toolbar { ToolbarItem(placement: .navigationBarLeading) { if step > 0 { Button { withAnimation(Brand.spring) { step -= 1; err = "" } } label: { Label(L("上一步"), systemImage: "chevron.left") } } } }
  }
}

struct FundAndSign: View {
  @EnvironmentObject var m: AppModel; let s: WalletState
  var ok: Bool { s.balance >= 200_000 }
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      VStack(alignment: .leading, spacing: 6) {
        Text(L("先充值，再确认")).font(.largeTitle.bold())
        Text(L("至少 0.2 USDC 到账后才能确认，每 5 秒自动检查。")).foregroundStyle(.secondary)
      }
      BalanceHero(balance: s.balance, status: ok ? (L("已到账，可以确认了"), Brand.positive, "checkmark.circle.fill") : (L("等待到账…"), Brand.caution, "clock"))
      if let w = s.wallet { AddressQR(address: w) }
      if !s.elsewhere.isEmpty { WarnBox(text: L("链选错了 / 地址不对：在别的网络找到了 USDC。网络要选 Base，地址填上面这个。"), tone: Brand.negative) }
      BigButton(L("确认授权（一次）"), icon: "signature", disabled: !ok) { Task { await m.openSigning(next: "/?return=kipurse") } }
      Text(L("确认在页面里完成：点页面上的“确认授权”，再用 Face ID / 通行密钥确认。")).font(.footnote).foregroundStyle(.secondary)
    }
  }
}

/// Compact first-run card on the home tab (replaces the old full-screen setup page; tabs stay visible).
struct SetupCard: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState; @Binding var sheet: String?
  var funded: Bool { s.balance >= 200_000 }
  var needsSign: Bool { s.hasSetup && s.pendingCalls != nil }
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(!needsSign ? L("先设置额度，AI 才能付款") : funded ? L("已到账，确认一次即可启用") : L("充值 0.2 USDC 开始")).font(.headline)
      if !s.elsewhere.isEmpty { Text(L("在别的网络收到了币，请用 Base。")).font(.footnote).foregroundStyle(Brand.negative) }
      if !needsSign { BigButton(L("设置额度"), icon: "slider.horizontal.3") { sheet = "setup" } }
      else if funded { BigButton(L("确认启用"), icon: "faceid") { Task { await m.openSigning(next: "/?return=kipurse") } } }
      else {
        HStack(spacing: 12) {
          BigButton(L("收款"), icon: "qrcode") { Haptics.tap(); sheet = "receive" }
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 20)
  }
}

struct MuseRow: View {
  @EnvironmentObject var m: AppModel
  /// Real status from the server that answered (mainnet: read-only phone session). Muse connects to the MAINNET wallet only.
  var st: (connected: Bool, lastUsed: String?) { m.state?.muse ?? (false, nil) }
  var onMain: Bool { m.state?.isMainnet ?? false }
  var body: some View {
    HStack(spacing: 14) {
      Avatar(name: "Muse", size: 44, symbol: "wand.and.stars")
      VStack(alignment: .leading, spacing: 3) {
        Text("Muse").font(.headline)
        if st.connected {
          HStack(spacing: 6) { Chip(text: L("已连接"), color: Brand.positive, icon: "checkmark"); if let u = Tx.parseDate(st.lastUsed.map { .string($0) }) { Text(AgentStatus.ago(u)).font(.caption).foregroundStyle(.secondary) } }
        } else if !onMain { Text(T("连的是你的启付钱包", "Connected to your Kipurse wallet")).font(.caption).foregroundStyle(.secondary) }
        else { Text(L("未连接")).font(.caption).foregroundStyle(.secondary) }
      }
      Spacer(minLength: 8)
      if !st.connected && onMain {
        if true { Button { MuseLauncher.open(m) } label: { Text(L("连接 Muse")).font(.subheadline.weight(.semibold)).padding(.horizontal, 14).padding(.vertical, 8).background(Brand.accent, in: Capsule()).foregroundStyle(.white) }.buttonStyle(.borderless).accessibilityIdentifier("muse.connect") }
      }
    }.padding(.vertical, 4).accessibilityElement(children: .contain).accessibilityIdentifier("muse.row")
  }
}

struct NetworkPill: View {
  var body: some View { Chip(text: T("正式", "Live"), color: Brand.positive) }
}

// MARK: - Tabs

/// t879: three visible tabs (AI 生活 / 钱包 / 设置). .agents is pushed inside 生活; `tab = .settings` now switches to the 设置 tab, so every old `tab = .settings` still works.
enum AppTab: Hashable { case life, home, agents, settings }
/// Wraps in a NavigationStack unless already pushed inside one.
struct EmbedStack<C: View>: View { let embedded: Bool; @ViewBuilder let content: () -> C
  var body: some View { if embedded { content() } else { NavigationStack { content() } } } }

/// Three tabs: 钱包 (approvals + balance + activity), AI 智能体, 设置. The approvals badge sits on 钱包.
struct MainTabs: View {
  @EnvironmentObject var m: AppModel
  @State private var tab: AppTab = .home   // t922: wallet first
  let s: WalletState
  var body: some View {
    TabView(selection: Binding(get: { tab == .life || tab == .agents ? AppTab.life : tab == .settings ? AppTab.settings : AppTab.home }, set: { tab = $0 })) {
      LifeTab(s: s, tab: $tab).tabItem { Label(T("AI 生活", "AI Life"), systemImage: "sparkles") }.tag(AppTab.life)
      HomeTab(s: s, tab: $tab).tabItem { Label(L("钱包"), systemImage: "creditcard.fill") }.tag(AppTab.home).badge(s.approvals.count)
      SettingsTab(s: s).tabItem { Label(L("设置"), systemImage: "gearshape.fill") }.tag(AppTab.settings)   // t879: 设置 is the third bottom tab (no back button)
    }
    .tint(Brand.accent)
    .safeAreaInset(edge: .top) { if m.serverDown && FeatureSwitch.calmBanner.on { CalmBanner() } }   // t821
    #if DEBUG
    .onAppear { if let i = CommandLine.arguments.firstIndex(of: "-tab"), i + 1 < CommandLine.arguments.count { tab = ["agents": .agents, "settings": .settings, "life": .life][CommandLine.arguments[i + 1]] ?? .home } }
    #endif
    #if DEBUG
    .task { if CommandLine.arguments.contains("-kpCelebrate"), let t = s.txs.first(where: { $0.agent == "grok-bot" }) ?? s.txs.first { try? await Task.sleep(nanoseconds: 1_500_000_000); m.celebrate = t } }   // screenshot of the payment cheer
    #endif
    .onAppear { if UserDefaults.standard.string(forKey: "openTab") != nil { tab = .home; UserDefaults.standard.removeObject(forKey: "openTab") } }
    .onChange(of: m.pendingTab) { t in if t != nil { tab = .home; m.pendingTab = nil } }
    .overlay { if let c = m.celebrate { CelebrationView(t: c, s: s, open: { m.openTx = c.id; m.pendingTab = "activity"; m.celebrate = nil }, close: { m.celebrate = nil }).transition(.opacity).task { try? await Task.sleep(nanoseconds: 4_500_000_000); withAnimation { if m.celebrate?.id == c.id { m.celebrate = nil } } } } }
    .animation(Brand.spring, value: m.celebrate?.id)
  }
}

/// Logged-in root: setup flow until the permission is active, then the tabs.
struct HomeView: View {
  @EnvironmentObject var m: AppModel
  var body: some View {
    if let s = m.state {
      MainTabs(s: s)   // t927: no separate simple mode; the app follows the system text size
    } else { ProgressView(L("连接中…")).frame(maxWidth: .infinity, maxHeight: .infinity).background(Brand.canvas) }
  }
}

// MARK: 1. 钱包

/// Hero balance: Apple Card–style indigo card, big rounded number that rolls on change, unit "USDC（美元稳定币）".
struct BalanceHero: View {
  let balance: Int64; var status: (String, Color, String)? = nil; var reserve: Int64 = 0
  @EnvironmentObject var m: AppModel
  @Environment(\.accessibilityReduceTransparency) private var rt
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 28, style: .continuous)
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(T("启付钱包余额", "Kipurse wallet balance")).font(.subheadline.weight(.semibold)).foregroundStyle(.white.opacity(0.8)).accessibilityIdentifier("balance.label")
        Spacer()
        BalanceEyeButton(font: .body).colorScheme(.dark)
      }
      if m.balanceRevealed {
        Text(AnswerRules.format2(balance)).font(Brand.money(56)).foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.4)
          .modifier(RollingNumber(value: Double(balance))).animation(Brand.spring, value: balance).accessibilityIdentifier("balance.amount")
      } else {
        Text(BalanceMask.dots).font(Brand.money(56)).foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.4)
          .onTapGesture { Task { await m.revealBalance() } }
          .accessibilityLabel(T("余额已隐藏", "Balance hidden")).accessibilityIdentifier("balance.masked")
      }
      HStack(spacing: 4) {
        if m.balanceRevealed {
          Text(T("美元（USDC）", "US dollars (USDC)")).font(.subheadline.weight(.semibold)).foregroundStyle(.white.opacity(0.85)).accessibilityIdentifier("balance.unit")
        } else {   // student pass: hidden must never look like 0
          Button { Task { await m.revealBalance() } } label: { Label(T("已隐藏 · 点一下查看", "Hidden · tap to show"), systemImage: "eye.slash").font(.subheadline.weight(.semibold)) }
            .buttonStyle(.plain).foregroundStyle(.white.opacity(0.85)).accessibilityIdentifier("balance.hiddenHint")
        }
        Spacer(minLength: 0)
        if m.balanceRevealed {
          InfoTip(title: T("关于余额", "About your balance"),
                  text: T("1 USDC ≈ 1 美元。", "1 USDC ≈ US$1.") + (reserve > 0 ? T("\n\n另有 \(AnswerRules.format(reserve)) USDC 手续费零钱，专门付转账手续费，所以你不用另外买别的币。它也是你的钱。",
                                                                          "\n\nPlus \(AnswerRules.format(reserve)) USDC fee change. It only pays transfer fees, so you never need other coins. It's still your money.") : ""),
                  id: "balance.info").colorScheme(.dark)
        }
      }
      if let st = status { Chip(text: st.0, color: st.1, icon: st.2) }
      HStack(spacing: 8) {
        BrandMark(size: 22)
        Text(T("启付", "Kipurse")).font(.footnote.weight(.bold)).foregroundStyle(.white.opacity(0.9))
        Spacer()
      }.padding(.top, 6).accessibilityHidden(true)
    }
    .padding(22).frame(maxWidth: .infinity, alignment: .leading)
    .background {
      ZStack {
        shape.fill(LinearGradient(colors: [Brand.accentHi, Brand.accent, Brand.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing))
        if !rt {
          HeroMesh().clipShape(shape)
          shape.fill(RadialGradient(colors: [.white.opacity(0.30), .clear], center: UnitPoint(x: 0.85, y: 0.0), startRadius: 0, endRadius: 240))
          shape.fill(LinearGradient(colors: [.white.opacity(0.12), .clear], startPoint: .top, endPoint: .center))
          HeroSheen().clipShape(shape)
        }
      }
    }
    .overlay(shape.strokeBorder(.white.opacity(0.22), lineWidth: 1))
    .shadow(color: Brand.accent.opacity(0.45), radius: 30, y: 14)
    .accessibilityElement(children: .contain)
  }
}

/// Digits roll when the value changes (iOS 17 numericText(value:), iOS 16 numericText()).
struct RollingNumber: ViewModifier {
  let value: Double
  func body(content: Content) -> some View {
    if #available(iOS 17, *) { content.contentTransition(.numericText(value: value)) } else { content.contentTransition(.numericText()) }
  }
}

struct HomeTab: View {
  @EnvironmentObject var m: AppModel
  @ObservedObject private var allow = AllowanceStore.shared
  let s: WalletState; @Binding var tab: AppTab
  @State private var sheet: String?
  @State private var picked: Tx?
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          HStack(alignment: .bottom) {
            PageTitle(eyebrow: nil, title: L("钱包"), id: "wallet.title")
            Spacer()   // t930: settings has ONE entry (the 设置 tab); the extra gear was removed
          }.padding(.top, 8)
          WalletCard(s: s).padding(.top, 14)
          if s.isMainnet || CommandLine.arguments.contains("-kpCBVHome") { HomeVerifyRow(ownerHint: s.owner).padding(.top, 12) }   // t864
          // t927: Face ID 批准 has ONE entry: 设置 → Face ID 批准 (home row removed)
          if s.active {
            // t922: one row, two equal buttons. 充值 only from the Coinbase Wallet / Coinbase wallet (no Apple Pay buy).
            VStack(alignment: .leading, spacing: 12) {
              if s.balance == 0 {
                VStack(alignment: .leading, spacing: 6) {
                  Label(T("第一步：先充值", "Step 1: add money"), systemImage: "arrow.down.circle.fill").font(.headline).foregroundStyle(.white)
                  Text(T("钱包现在是 0。从你的 Coinbase 钱包转入一点 USDC（$1 就够），之后才能开通 Face ID 批准和让 AI 付款。", "Your wallet is at 0. Move a little USDC (even $1) in from your Coinbase wallet first; then you can turn on Face ID approvals and let AI pay.")).font(.subheadline).foregroundStyle(.white.opacity(0.75)).fixedSize(horizontal: false, vertical: true)
                }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(Brand.accent.opacity(0.18), in: RoundedRectangle(cornerRadius: 14, style: .continuous)).accessibilityElement(children: .combine).accessibilityIdentifier("home.zeroGuide")
              }
              HStack(spacing: 10) {
                Button { Haptics.tap(); sheet = "fund" } label: {
                  Label(T("充值", "Add money"), systemImage: "arrow.down.circle.fill").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .background(LinearGradient(colors: [Color(hex: 0x3B7BFF), Color(hex: 0x0052FF)], startPoint: .top, endPoint: .bottom), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.white.opacity(0.22), lineWidth: 1))
                }.buttonStyle(Pressable()).accessibilityLabel(T("充值（从 Coinbase 钱包转入）", "Add money (from your Coinbase wallet)")).accessibilityIdentifier("home.deposit")
                Button { Haptics.tap(); sheet = "withdraw" } label: {
                  Label(T("提现", "Withdraw"), systemImage: "arrow.up.circle.fill").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .background(LinearGradient(colors: [Brand.accentHi, Brand.accentDeep], startPoint: .top, endPoint: .bottom), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.white.opacity(0.22), lineWidth: 1))
                }.buttonStyle(Pressable()).disabled(s.balance == 0).opacity(s.balance == 0 ? 0.45 : 1).accessibilityLabel(T("提现（全部转回你的 Coinbase 钱包）", "Withdraw (back to your Coinbase wallet)")).accessibilityIdentifier("home.withdraw")
              }
            }.padding(.top, 18)
          }
        VStack(alignment: .leading, spacing: 20) {
          // t927: ONE pending block (待你批准): connect requests + approvals + AI allowance requests + held payments.
          // Limits live in 设置 → 额度; pause lives in 设置 → 安全 (one place each).
          let pendingN = s.approvals.count + allow.approvals.count + (s.isMainnet ? s.liveConnectRequests().count : 0)
          VStack(alignment: .leading, spacing: 12) {
            if pendingN > 0 { Header(text: T("待你批准", "Waiting for you")).accessibilityIdentifier("home.pending.title") }
            if s.isMainnet { ForEach(s.liveConnectRequests()) { r in MainConnectCard(r: r) } }
            ForEach(s.approvals) { a in
              if a.kind == .trustRequest, let r = s.trustRequests.first(where: { $0.id == a.serverId }) {
                if s.isMainnet { MainTrustCard(r: r) } else { TrustRequestCard(r: r) }
              } else { ApprovalCard(a: a) }
            }
            if s.isMainnet && s.active { AllowancesCard() }
            if s.isMainnet && s.active { HoldsCard() }
          }.animation(Brand.spring, value: s.approvals)
          if s.isMainnet, let w = s.wallet, !m.stray.isEmpty { StrayNotice(wallet: w) }
          if !s.active { SetupCard(s: s, sheet: $sheet) }
          if s.quarantined > 0 { WarnBox(text: T("暂时冻结的钱（超出每日充值额度，AI 不能用）：\(AnswerRules.format(s.quarantined)) USDC", "Frozen for now (over your daily deposit limit, AI can't use it): \(AnswerRules.format(s.quarantined)) USDC"), icon: "lock.shield.fill") }
          if s.active {
            if s.isMainnet { LedgerSection(s: s) }
            if !s.isMainnet { VStack(alignment: .leading, spacing: 12) {
              HStack { Header(text: L("最近记录")); Spacer(); NavigationLink(L("全部")) { ActivityList(s: s) }.font(.subheadline.weight(.semibold)).accessibilityIdentifier("home.allActivity") }
              VStack(spacing: 0) {
                if s.txs.isEmpty { Text(L("还没有记录")).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 20) }
                ForEach(Array(s.txs.prefix(3).enumerated()), id: \.offset) { i, t in
                  Button { picked = t } label: { TxRow(t: t) }.foregroundStyle(.primary)
                  if i < min(3, s.txs.count) - 1 { Divider().padding(.leading, 52) }
                }
              }.card(padding: 14)
            } }
          }
        }.padding(.top, 20)
        }.padding(.horizontal, 20).padding(.bottom, 120)
      }
      .background(MockBG()).refreshable { await m.refresh() }
      .toolbar(.hidden, for: .navigationBar)
      .onChange(of: s.hasSetup) { v in if v && sheet == "setup" { sheet = nil } }
      .onChange(of: m.authOverlayShown) { v in if v && sheet == "limits" { sheet = nil } }
      .onChange(of: m.openTx) { id in if let id, let t = s.txs.first(where: { $0.id == id }) { picked = t; m.openTx = nil } }
      .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in picked = nil; sheet = nil }
      .sheet(item: $picked) { t in TxDetail(t: t, explorer: s.explorer).presentationDetents([.medium, .large]) }
      .sheet(item: Binding(get: { sheet.map { SheetID(id: $0) } }, set: { sheet = $0?.id })) { x in
        NavigationStack {
          Group {
            if x.id == "setup" { SetupWizard() }
            else if x.id == "limits" { MainLimitsView(s: s) }
            else if x.id == "withdraw" && s.isMainnet { MainWithdrawView(s: s) }
            else if x.id == "coinbase" { ScrollView { CoinbaseDepositView(s: s).padding(20) } }
            else { ScrollView { Group { if x.id == "fund" || x.id == "receive" { DepositView(s: s) } else { WithdrawFlow(s: s) } }.padding(20) } }
          }
            .background(Brand.canvas).navigationTitle(x.id == "coinbase" ? T("Coinbase 充值", "Coinbase Top Up") : x.id == "fund" || x.id == "receive" ? L("充值") : x.id == "setup" ? L("设置钱包") : x.id == "limits" ? T("额度", "Allowance") : T("提现", "Withdraw")).navigationBarTitleDisplayMode(.inline)
            .toolbar { Button(L("完成")) { sheet = nil }.accessibilityIdentifier("sheet.done") }
        }.presentationDetents([.large])
      }
    }
  }
  private func action(_ t: String, _ i: String, _ f: @escaping () -> Void) -> some View {
    Button { Haptics.tap(); f() } label: {
      VStack(spacing: 8) {
        Image(systemName: i).font(.system(size: 20, weight: .semibold)).foregroundStyle(Brand.accent)
          .frame(width: 56, height: 56).background(Brand.accentSoft, in: Circle())
        Text(t).font(.caption.weight(.medium)).foregroundStyle(.primary)
      }.frame(maxWidth: .infinity)
    }.buttonStyle(Pressable())
  }
}
struct SheetID: Identifiable { let id: String }

/// Hero: what your AI spent today, per agent — the first thing you see.
struct AISpentToday: View {
  let s: WalletState
  var today: [Tx] { s.txs.filter { !$0.failed && ($0.date.map { Calendar.current.isDateInToday($0) } ?? false) } }
  var body: some View {
    let total = today.reduce(Int64(0)) { $0 + $1.amount }
    let byAgent = Dictionary(grouping: today, by: { $0.agent }).map { ($0.key, $0.value.reduce(Int64(0)) { $0 + $1.amount }, $0.value.count) }.sorted { $0.1 > $1.1 }
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Label(T("你的 AI 今天花了", "Your AI spent today"), systemImage: "sparkles").font(.subheadline.weight(.semibold)).foregroundStyle(.white.opacity(0.9))
        Spacer()
        Text(T("\(today.count) 笔", "\(today.count) payment\(today.count == 1 ? "" : "s")")).font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.8))
      }
      Text(money(total)).font(Brand.money(40)).foregroundStyle(.white).contentTransition(.numericText()).animation(Brand.spring, value: total)
      if let lim = s.mainDaily, lim > 0 {
        ProgressView(value: Double(min(s.spentToday, lim)), total: Double(lim)).tint(.white)
        Text(T("今天还能花 \(money(max(0, lim - s.spentToday)))", "\(money(max(0, lim - s.spentToday))) left today")).font(.caption).foregroundStyle(.white.opacity(0.85))
      }
      if byAgent.isEmpty { Text(T("今天还没有付款。AI 付款时你会收到通知。", "No payments yet today. You'll get a notification for every payment.")).font(.footnote).foregroundStyle(.white.opacity(0.85)) }
      else { HStack(spacing: 8) { ForEach(byAgent.prefix(3), id: \.0) { a in
        Text("\(a.0) · \(money(a.1))").font(.caption.weight(.semibold)).padding(.horizontal, 10).padding(.vertical, 5).background(.white.opacity(0.18), in: Capsule()).foregroundStyle(.white) } } }
    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
      .background(LinearGradient(colors: [Brand.accent, Color(light: 0x7C3AED, dark: 0x6D28D9)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: Brand.radius, style: .continuous))
  }
}

struct TxRow: View {
  let t: Tx
  var body: some View {
    HStack(spacing: 12) {
      AgentLogo(name: t.agent, phase: .online, size: 30, still: true)   // list rows: static glow (performance)
      VStack(alignment: .leading, spacing: 2) {
        Text(t.agent).font(.subheadline.weight(.semibold))
        HStack(spacing: 4) { if t.merchantVerified { Image(systemName: "checkmark.seal.fill").foregroundStyle(Brand.positive) }; Text(t.merchantName).lineLimit(1) }.font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      VStack(alignment: .trailing, spacing: 3) {
        Text("−" + AnswerRules.format2(t.amount)).font(Brand.money(16, .semibold)).foregroundStyle(t.failed ? .secondary : .primary).strikethrough(t.failed)
        if t.failed || t.pending { Chip(text: t.stateZh, color: t.stateColor) }
        else if let d = t.date { Text(d, style: .time).font(.caption2).foregroundStyle(.secondary) }
      }
    }.padding(.vertical, 8).contentShape(Rectangle()).assistantRef(.payment(txHash: t.txHash ?? ""))
  }
}

struct TxDetail: View {
  @EnvironmentObject var m: AppModel
  let t: Tx; let explorer: String; var agentName: String? = nil
  var who: String { agentName ?? t.agent }
  @Environment(\.dismiss) var dismiss
  @State private var reporting = false
  var dispute: JSONValue? { (m.state?.raw["disputes"]?.array ?? []).first { $0["purchaseKey"]?.string == t.id } }
  var body: some View {
    NavigationStack {
      List { Group {
        Section {
          VStack(spacing: 10) {
            AgentLogo(name: who, phase: .online, size: 52)
            Text("−" + money2(t.amount)).font(Brand.money(34))
            Chip(text: t.stateZh, color: t.stateColor)
            Text(T("\(who) 付给 \(t.merchantName)", "\(who) paid \(t.merchantName)")).font(.subheadline).foregroundStyle(.secondary).assistantRef(.payee(address: t.payee))
          }.frame(maxWidth: .infinity).padding(.vertical, 8)
        }
        Section(T("收据", "Receipt")) {
          LabeledContent(T("商家", "Merchant")) { HStack(spacing: 4) { if t.merchantVerified { Image(systemName: "checkmark.seal.fill").foregroundStyle(Brand.positive) }; Text(t.merchantName) } }
          LabeledContent(T("商家状态", "Status"), value: t.badgeText)
          LabeledContent(T("付款的 AI", "Paid by"), value: who)
          LabeledContent(T("金额", "Amount"), value: money(t.amount))
          if let d = t.date { LabeledContent(L("时间"), value: d.formatted(date: .abbreviated, time: .shortened)) }
          if let c = t.contact { LabeledContent(T("联系商家", "Contact"), value: c) }
          if let w = t.website, let u = URL(string: w) { Link(destination: u) { Label(T("商家网站", "Merchant website"), systemImage: "safari") } }
          if let h = t.txHash, let u = URL(string: "\(explorer)/tx/\(h)") { Link(destination: u) { Label(T("公开收据（谁都改不了）", "Public receipt (can't be altered)"), systemImage: "checkmark.shield") } }
          DisclosureGroup(T("技术信息", "Technical details")) { Text(t.payee).font(.caption.monospaced()).textSelection(.enabled) }
        }
        if let d = dispute {
          Section(T("退款进度", "Refund status")) {
            LabeledContent(T("状态", "Status"), value: DisputeState.label(state: d["state"]?.string, status: d["status"]?.string, zh: Loc.isChinese))
            if let due = d["respondBy"]?.atomic, d["status"]?.string == "open" { LabeledContent(T("商家应在此前退款", "Merchant should refund by"), value: Date(timeIntervalSince1970: Double(due)).formatted(date: .abbreviated, time: .omitted)) }
            LabeledContent(T("已退回", "Refunded"), value: money(d["refunded"]?.atomic ?? 0))
            Text(T("商家把钱退回钱包后会自动显示在这里。", "When the merchant sends the money back it shows here automatically.")).font(.footnote).foregroundStyle(.secondary)
          }
        } else if !t.failed && !(m.state?.isMainnet ?? false) {
          Section { Button(role: .destructive) { reporting = true } label: { Label(T("这笔有问题 / 申请退款", "Report a problem / ask for a refund"), systemImage: "exclamationmark.bubble") } }
        }
        Section { ShareLink(item: receiptText) { Label(T("分享收据", "Share receipt"), systemImage: "square.and.arrow.up") } }
      }.listRowBackground(GlassRowBG())
      }
      .scrollContentBackground(.hidden).background(Brand.canvas)
      .navigationTitle(L("付款详情")).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(L("完成")) { dismiss() } }
      .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in reporting = false }
      .sheet(isPresented: $reporting) { ReportProblemView(t: t).presentationDetents([.large]) }
      .onAppear { if m.reportTx == t.id { reporting = true; m.reportTx = nil } }
    }
  }
  var receiptText: String { [T("Kipurse 收据", "Kipurse receipt"), "\(who) → \(t.merchantName)", money(t.amount), t.date?.formatted() ?? "", t.txHash.map { "\(explorer)/tx/\($0)" } ?? ""].joined(separator: "\n") }
}

struct ReportProblemView: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) var dismiss
  let t: Tx
  @State private var reason = "not_received"; @State private var note = ""; @State private var result: JSONValue?
  let reasons: [(String, String, String)] = [("not_received", "没收到东西", "I didn't get it"), ("wrong_amount", "金额不对", "Wrong amount"), ("duplicate", "重复扣款", "Charged twice"), ("not_as_described", "和描述不一样", "Not as described"), ("unauthorized", "我没让 AI 买这个", "I didn't want this"), ("other", "其他", "Something else")]  // i18n-ok: paired zh/en or zh-only data
  var body: some View {
    NavigationStack {
      Form {
        if let r = result {
          Section { Label(T("已提交，我们会跟踪退款", "Sent — we'll track the refund"), systemImage: "checkmark.circle.fill").foregroundStyle(Brand.positive) }
          Section(T("下一步", "What happens next")) {
            Text(T("1. 联系商家，说明问题。", "1. Contact the merchant and explain.")); Text(T("2. 把下面的退款说明发给他们（一键复制）。", "2. Send them the refund note below (one tap).")); Text(T("3. 商家退回后，这里和通知里会显示。", "3. When they refund, you'll see it here and get a notification."))
            if let c = r["merchant"]?["contact"]?.string { LabeledContent(T("商家联系方式", "Merchant contact"), value: c) }
            if let txt = r["merchantInstructions"]?.string { Button { UIPasteboard.general.string = txt; Haptics.success() } label: { Label(T("复制退款说明", "Copy refund note"), systemImage: "doc.on.doc") } }
            if Loc.isChinese == false { Text("If a merchant won't help, pause the AI that paid and keep this receipt.").font(.footnote).foregroundStyle(.secondary) }
          }
        } else {
          Section(T("出了什么问题？", "What went wrong?")) { Picker("", selection: $reason) { ForEach(reasons, id: \.0) { Text(T($0.1, $0.2)).tag($0.0) } }.pickerStyle(.inline).labelsHidden() }
          Section(T("补充（可选）", "Details (optional)")) { TextField(T("比如：店里说没收到", "e.g. the shop said it never arrived"), text: $note, axis: .vertical) }
          Section { Button(T("提交", "Send")) { Task { result = await m.reportProblem(t, reason: reason, note: note); if result != nil { Haptics.success() } } }.font(.headline) }
        }
      }.navigationTitle(T("这笔有问题", "Report a problem")).navigationBarTitleDisplayMode(.inline).toolbar { Button(L("完成")) { dismiss() } }
    }
  }
}

struct EmptyState: View {
  let icon: String, title: String, text: String
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: icon).font(.system(size: 40)).foregroundStyle(.tertiary)
      Text(title).font(.headline); if !text.isEmpty { Text(text).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center) }
    }.frame(maxWidth: .infinity).padding(.vertical, 32)
  }
}

struct ApprovalCard: View {
  @EnvironmentObject var m: AppModel; let a: Approval
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        Avatar(name: a.titleZh, size: 40, symbol: icon)
        VStack(alignment: .leading, spacing: 2) { Text(a.titleZh).font(.headline); Chip(text: kindZh, color: Brand.caution) }
      }
      Text(a.bodyZh).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 10) {
        if a.kind == .trust || a.kind == .trustRequest || a.kind == .connectAgent { BigButton(L("不同意"), kind: .secondary) { Task { await m.reject(a) } } }
        BigButton(L("同意"), icon: "faceid") { Task { await m.approve(a) } }
      }
    }.card(padding: 18).assistantRef(.approval(id: a.id)).transition(.opacity.combined(with: .move(edge: .top)))
  }
  private var icon: String { switch a.kind { case .trust, .trustRequest: return "person.badge.shield.checkmark"; case .loosenLimits: return "slider.horizontal.3"; case .withdraw: return "arrow.up.circle"; case .connectAgent: return "link.badge.plus" } }
  private var kindZh: String { switch a.kind { case .trust, .trustRequest: return L("信任收款方"); case .loosenLimits: return L("调高上限"); case .withdraw: return L("提现"); case .connectAgent: return L("连接 AI") } }
}

/// Agent trust request: the raw address is what counts (check every character); the AI's own words are labelled unverified.
/// 同意 = Face ID, then the owner page opens in Safari where his Coinbase wallet signs trustBySig; 不同意 = reject (no signature needed).
struct TrustRequestCard: View {
  @EnvironmentObject var m: AppModel; let r: TrustRequest
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        Avatar(name: r.merchantName, size: 40, symbol: "person.badge.shield.checkmark")
        VStack(alignment: .leading, spacing: 2) { Text(L("AI 请求信任收款方")).font(.headline); Chip(text: r.chainLabel, color: Brand.caution) }
      }
      VStack(alignment: .leading, spacing: 4) {
        Text(L("收款地址（逐个字符核对）")).font(.caption).foregroundStyle(.secondary)
        Text(fullAddr(r.payee)).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("trust.payee.full")
        TipLine(zh: SafetyTips.payeeZh, en: SafetyTips.payeeEn, id: "tip.payee")
      }
      Text(L("每笔最多 \(AnswerRules.format(r.single)) USDC · 每天最多 \(AnswerRules.format(r.total)) USDC · \(r.expiresInDays) 天后失效")).font(.subheadline)
      VStack(alignment: .leading, spacing: 4) {
        Text(L("AI 自己写的（未核实）")).font(.caption.bold()).foregroundStyle(Brand.caution)
        Text("\(r.merchantName) — \(r.reason)").font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Text(L("申请方：\(r.requestedBy.joined(separator: ", "))")).font(.caption2).foregroundStyle(.secondary)
      }
      HStack(spacing: 10) {
        BigButton(L("拒绝"), kind: .secondary) { Task { await m.rejectTrustRequest(r.id) } }
        BigButton(L("信任并确认"), icon: "faceid") { Task { await m.openSigning(next: "/#trust-request=\(r.id)") } }
      }
      Text(L("确认在你自己的 Coinbase 钱包 里完成；AI 永远不能自己批准。")).font(.caption2).foregroundStyle(.secondary)
    }.card(padding: 18).assistantRef(.approval(id: "treq:" + r.id)).transition(.opacity.combined(with: .move(edge: .top)))
  }
}

// MARK: 4. AI 智能体

struct AgentsTab: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  var embedded = false
  var serverNow: Date { Tx.parseDate(s.raw["serverTime"]) ?? Date() }
  var others: [JSONValue] { s.liveAgents.filter { $0["id"]?.string != "muse" && $0["kind"]?.string != "muse" } }
  @State private var copied = false
  /// Siri = free server-authorized agent (like Claude / Grok Bot / Muse): connected when this phone is bound.
  @State private var siriOn = false; @State private var siriSheet = false; @State private var siriIntro = false   // t902
  func loadSiri() async {
    if m.demo != nil { siriOn = CommandLine.arguments.contains("-kpSiriOn"); return }
    // Siri = a free, server-authorized agent: "connected" as soon as this phone is bound (any approver version, no upgrade, no fee).
    guard PhoneKey.isPresent(), let a = await PhoneKey.status(), let fp = a["fingerprint"] as? String else { siriOn = false; return }
    siriOn = PhoneKey.all().contains { PhoneKey.fingerprint($0) == fp }
  }
  @ViewBuilder var siriLine: some View {
    if siriOn {
      NavigationLink { AgentBuyView(t: AgentBuyTarget(id: "siri", name: "Siri", symbol: "waveform", kinds: ["siri"], card: nil), s: s) } label: {
      AgentLine(name: "Siri", symbol: "waveform", on: siriOn, sub: siriOn ? T("嘿 Siri，用 Kipurse 付款", "“Hey Siri, pay with Kipurse”") : T("开通 Face ID 批准后就能用", "Works once Face ID approvals are on"), action: siriOn ? nil : T("连接", "Connect"))
    }.accessibilityIdentifier("agent.siri.on")
    } else {
      Button { siriIntro = true } label: {   // t902: intro + steps first; Face ID sheet only from the last step
      AgentLine(name: "Siri", symbol: "waveform", on: siriOn, sub: siriOn ? T("嘿 Siri，用 Kipurse 付款", "“Hey Siri, pay with Kipurse”") : T("开通 Face ID 批准后就能用", "Works once Face ID approvals are on"), action: siriOn ? nil : T("连接", "Connect"))
    }.buttonStyle(.plain).accessibilityIdentifier("agent.siri.connect")
    }
  }
  func usedText(_ iso: String?) -> String {
    guard let d = Tx.parseDate(iso.map { .string($0) }) else { return L("刚连接") }
    return AgentStatus.ago(d, now: serverNow)
  }
  @ViewBuilder func museLine(_ on: Bool) -> some View {
    if on { NavigationLink { AgentBuyView(t: AgentBuyTarget(id: "muse", name: "Muse", symbol: "wand.and.stars", kinds: ["muse"], card: nil), s: s) } label: { AgentLine(name: "Muse", symbol: "wand.and.stars", on: true, sub: usedText(s.muse.lastUsed)) }.accessibilityIdentifier("muse.row") }
    else {
      Button { MuseLauncher.open(m) } label: {
        AgentLine(name: "Muse", symbol: "wand.and.stars", on: false, sub: L("未连接"), action: L("连接"))   // t922: status only from the server
      }.buttonStyle(.plain).accessibilityIdentifier("muse.connect")
    }
  }
  @ViewBuilder func cardRow(_ c: AgentCard, on: Bool) -> some View {
    if on {   // connected: the card is for BUYING, never the connect flow again
      NavigationLink { AgentBuyView(t: AgentBuyTarget(id: c.id, name: c.name, symbol: c.symbol, kinds: c.kinds, card: c), s: s) } label: {
        AgentLine(name: c.name, symbol: c.symbol, on: true, sub: usedText(c.lastUsed(in: s)), action: nil)
      }.accessibilityIdentifier("agent.\(c.id)")
    } else {
    Button { AgentLauncher.open(c, m) } label: {
      AgentLine(name: c.name, symbol: c.symbol, on: on, sub: on ? usedText(c.lastUsed(in: s)) : (c.unfinished(in: s) ? L("还没连完，点“连接”继续") : L("未连接")), action: on ? nil : L("连接"))
    }.buttonStyle(.plain).accessibilityIdentifier("agent.\(c.id)")
    }
  }
  @ViewBuilder func extraRow(_ a: JSONValue) -> some View {
    let on = a["connected"]?.bool ?? false
    if on && s.isMainnet, let id = a["id"]?.string {
      NavigationLink { AgentBuyView(t: AgentBuyTarget(id: id, name: a["name"]?.string ?? "AI", symbol: AgentGallery.symbols[a["kind"]?.string ?? ""], kinds: [id, a["kind"]?.string ?? id], card: nil), s: s) } label: {
        AgentLine(name: a["name"]?.string ?? "AI", symbol: AgentGallery.symbols[a["kind"]?.string ?? ""], on: true, sub: usedText(a["lastUsed"]?.string)) }
    } else {
    AgentLine(name: a["name"]?.string ?? "AI", symbol: AgentGallery.symbols[a["kind"]?.string ?? ""], on: on, sub: on ? usedText(a["lastUsed"]?.string) : L("还没连完，点“连接”继续"))
    }
  }
  var body: some View {
    EmbedStack(embedded: embedded) {
      List { Group {
        if s.isMainnet {
          let museOn = s.muse.connected
          let cards = AgentCard.mainnet.map { ($0, $0.connected(in: s)) }
          let extra = others.filter { !AgentCard.known($0) }
          let extraOn = extra.filter { $0["connected"]?.bool ?? false }, extraOff = extra.filter { !($0["connected"]?.bool ?? false) }
          if museOn || siriOn || cards.contains(where: { $0.1 }) || !extraOn.isEmpty {
            Section {
              if museOn { museLine(true) }
              ForEach(cards.filter { $0.1 }, id: \.0.id) { c, _ in cardRow(c, on: true) }
              ForEach(Array(extraOn.enumerated()), id: \.offset) { _, a in extraRow(a) }
              if siriOn { siriLine }
            } header: { Text(L("已连接")) }
          }
          if !museOn || cards.contains(where: { !$0.1 }) || !extraOff.isEmpty {
            Section {
              if !museOn { museLine(false) }
              ForEach(cards.filter { !$0.1 }, id: \.0.id) { c, _ in cardRow(c, on: false) }
              ForEach(Array(extraOff.enumerated()), id: \.offset) { _, a in extraRow(a) }
            } header: { Text(L("未连接")) }
          }
        } else {
          Section { MuseRow() }
          Section {
            if others.isEmpty { Text(L("没有其他 AI")).foregroundStyle(.secondary) }
            ForEach(Array(others.enumerated()), id: \.offset) { _, a in
              let name = a["name"]?.string ?? "AI", id = a["id"]?.string ?? ""
              extraRow(a).swipeActions { Button(L("断开"), role: .destructive) { Task { await m.revokeAgent(id, name) } } }
            }
          } header: { Text(L("其他 AI")) } footer: { if !others.isEmpty { Text(L("左滑断开。")) } }
        }
        if s.isMainnet {
          Section {
            if !siriOn { siriLine }
            Button { UIPasteboard.general.string = Mainnet.mcpURL; Haptics.success(); copied = true; m.toast = L("已复制，粘贴到 AI 的“连接”设置里") } label: {
              HStack { VStack(alignment: .leading, spacing: 2) { Text(L("连接其他 AI（复制连接地址）")).foregroundStyle(.primary); Text(L("复制后，粘贴到那个 AI 的“连接”设置里")).font(.caption).foregroundStyle(.secondary) }
                Spacer(); Image(systemName: copied ? "checkmark" : "doc.on.doc").foregroundStyle(Brand.accent) }
            }.accessibilityIdentifier("agents.copyMcp")
          } header: { Text(L("其他 AI")) }
        } else {
          Section { AgentGallery() } header: { Text(L("连接新的 AI")) }
        }
      }.listRowBackground(GlassRowBG())
      }
      .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Brand.canvas).refreshable { await m.refresh() }
      .animation(.snappy, value: s.agents.map { "\($0["id"]?.string ?? "")\($0["connected"]?.bool ?? false)" })
      .navigationTitle(L("AI 智能体"))
      .task { await loadSiri() }
      .onChange(of: m.phoneSignerChanged) { _ in Task { await loadSiri() } }
      .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in siriSheet = false }
      .sheet(isPresented: $siriSheet) { SiriPhrasesSheet().presentationDetents([.medium, .large]) }
      .sheet(isPresented: $siriIntro) { SiriIntroView(faceIDOn: siriOn).environmentObject(m) }
    }
  }
}

/// Connected Siri: the real AppShortcuts phrases (zh as in AppShortcuts.xcstrings, en as in Intents.swift) + open Shortcuts.
struct SiriPhrasesSheet: View {
  @Environment(\.dismiss) private var dismiss
  static var phrases: [(String, String)] {  [("用 Kipurse 付款", "Pay with Kipurse"), ("查 Kipurse 余额", "Check Kipurse balance"),  // i18n-ok: paired zh/en or zh-only data
    ("Kipurse 最近付款", "Recent Kipurse payments"), ("Kipurse 余额是多少", "What's my Kipurse balance")]  // i18n-ok: paired zh/en or zh-only data
    + (AssistantHooks.installed ? [("用 Kipurse 付给我的 Coinbase 钱包", "Pay My Coinbase wallet with Kipurse"), ("Kipurse 再付一次", "Repeat my last Kipurse payment"), ("批准 Kipurse 的请求", "Approve Kipurse request")] : []) }  // i18n-ok: paired zh/en or zh-only data
  var body: some View {
    NavigationStack {
      List {
        Section { Label(T("不用任何设置，直接对 Siri 说下面任何一句。", "No setup needed. Just say any of these to Siri."), systemImage: "waveform").font(.subheadline).accessibilityIdentifier("siri.noSetup") }
        Section { ForEach(Self.phrases, id: \.1) { z, e in
          VStack(alignment: .leading, spacing: 2) { Text(T("“嘿 Siri，\(z)”", "“Hey Siri, \(e)”")).font(.body.weight(.medium)); Text(T(e, z)).font(.caption).foregroundStyle(.secondary) } } }
          header: { Text(T("可以这样说", "Try saying")) } footer: { Text(T("付款前 Kipurse 会让你核对收款方和金额，并用 Face ID 确认。", "Kipurse shows the payee and amount and asks for Face ID before paying.")) }
      }.navigationTitle("Siri").navigationBarTitleDisplayMode(.inline).toolbar { Button(T("完成", "Done")) { dismiss() } }
    }
  }
}

/// One row style for every AI: same icon, black name, status line (green 已连接 + last use, or 未连接) and a quiet 连接 pill.
struct AgentLine: View {
  let name: String; var symbol: String? = nil; let on: Bool; let sub: String; var action: String? = nil
  var body: some View {
    HStack(spacing: 14) {
      AgentLogo(name: name, phase: on ? .online : .offline, size: 36)
      VStack(alignment: .leading, spacing: 4) {
        Text(name).font(.headline).foregroundStyle(Color.primary)
        HStack(spacing: 6) {
          if on { Chip(text: L("已连接"), color: Brand.positive, icon: "checkmark") }
          Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      Spacer(minLength: 8)
      if let action { Text(action).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.accent).padding(.horizontal, 14).padding(.vertical, 7).background(Brand.accent.opacity(0.12), in: Capsule()) }
    }.padding(.vertical, 4).contentShape(Rectangle())
  }
}

struct ConnectAI: View {
  @EnvironmentObject var m: AppModel
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let a = m.agentLink {
        Text(L("复制下面一行，发到你的电脑上给 AI（里面有这个 AI 专用的钥匙，别发给别人）。")).font(.footnote).foregroundStyle(.secondary)
        ForEach([("Codex", a["codex"]?.string), ("Claude Code", a["claudeCode"]?.string), (L("连接地址"), a["url"]?.string)], id: \.0) { n, v in
          if let v = v { BigButton(L("复制给 \(n)"), kind: .secondary, icon: "doc.on.doc") { UIPasteboard.general.string = v; Haptics.success(); m.show(L("已复制"), L("发到电脑上粘贴即可。")) } }
        }
      } else { BigButton(L("生成连接"), icon: "faceid") { Task { await m.newAgent() } } }
    }.padding(.vertical, 4)
  }
}

struct AgentGallery: View {
  @EnvironmentObject var m: AppModel
  static let symbols: [String: String] = ["codex": "terminal", "claude-code": "chevron.left.forwardslash.chevron.right", "gemini-cli": "sparkle", "antigravity": "arrow.up.circle", "grok": "bolt", "cursor": "cursorarrow.rays", "chatgpt": "bubble.left.and.bubble.right", "claude-desktop": "macwindow", "claude": "asterisk", "muse": "wand.and.stars", "apple": "apple.logo", "custom": "hammer"]
  var body: some View {
    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
      ForEach(Array(m.catalog.filter { $0["id"]?.string != "muse" }.enumerated()), id: \.offset) { _, a in
        let id = a["id"]?.string ?? "", name = a["name"]?.string ?? "", kind = a["kind"]?.string ?? ""
        let key = m.state?.liveAgents.first { $0["kind"]?.string == id }
        Button { if id == "muse" && key == nil { MuseLauncher.open(m) } else if kind == "native" || (kind == "remote" && id != "muse") { m.showAgentSheet(.result(a)) } else if let k = key { m.showAgentSheet(.manage(key: k, card: a)) } else { Task { await m.connectAgent(id, name) } } } label: {
          VStack(alignment: .leading, spacing: 8) {
            Avatar(name: name, size: 36, symbol: AgentGallery.symbols[id])
            Text(name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(2).multilineTextAlignment(.leading)
            if let k = key {
              let st = AgentStatus(k)
              Chip(text: st.online ? L("已连接 · 在线") : L("已连接"), color: Brand.positive, icon: "checkmark")
              Text(st.lastUse).font(.caption2).foregroundStyle(.secondary)
            } else { Chip(text: label(kind, a), color: color(kind, a)) }
          }.frame(maxWidth: .infinity, minHeight: 124, alignment: .topLeading).padding(12)
          .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Brand.positive.opacity(key == nil ? 0 : 0.6), lineWidth: 1.5))
        }.buttonStyle(Pressable())
      }
    }
    .padding(.vertical, 6)
    .task { await m.loadCatalog() }
    .overlay { if m.catalog.isEmpty { ProgressView() } }
    .sheet(item: $m.agentSheet) { sh in
      switch sh { case .result(let r): ConnectResultView(r: r); case .manage(let k, let c): ManageAgentView(key: k, card: c) }
    }
  }
  private func label(_ k: String, _ a: JSONValue) -> String {
    switch k { case "local": return (a["installed"]?.bool ?? false) ? L("本机 · 自动配置") : L("本机未安装")
    case "remote": return L("云端 · 复制地址即可"); case "deeplink": return L("一键安装链接"); case "native": return L("iPhone 原生"); default: return "MCP / HTTP" }
  }
  private func color(_ k: String, _ a: JSONValue) -> Color { k == "local" && !(a["installed"]?.bool ?? false) ? .secondary : k == "remote" ? Brand.caution : Brand.accent }
}

/// Manage an already-connected agent: status, reconnect (new key, old one revoked), disconnect (revoke + delete).
struct ManageAgentView: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) var dismiss
  let key: JSONValue; let card: JSONValue
  var body: some View {
    let name = card["name"]?.string ?? "AI", st = AgentStatus(key)
    NavigationStack {
      List {
        Section {
          HStack(spacing: 12) {
            Avatar(name: name, size: 48, symbol: AgentGallery.symbols[card["id"]?.string ?? ""])
            VStack(alignment: .leading, spacing: 4) { Text(name).font(.headline); Text(st.text).font(.subheadline).foregroundStyle(.secondary) }
            Spacer(); Chip(text: (key["paused"]?.bool ?? false) ? L("已暂停") : st.online ? L("在线") : L("已连接"), color: (key["paused"]?.bool ?? false) ? Brand.caution : Brand.positive)
          }.padding(.vertical, 4)
        }
        Section(L("怎么连")) { Text(card["how"]?.string ?? "").font(.subheadline) }
        Section {
          Button { let p = !(key["paused"]?.bool ?? false), kid = key["id"]?.string ?? ""; m.agentSheet = nil; Task { await m.pauseAgent(kid, name, p) } } label: { Label((key["paused"]?.bool ?? false) ? L("恢复这个 AI（可以再付款）") : L("暂停这个 AI（只能查看，不能付款）"), systemImage: (key["paused"]?.bool ?? false) ? "play.circle" : "pause.circle") }
          Button { m.agentSheet = nil; Task { try? await Task.sleep(nanoseconds: 400_000_000); await m.connectAgent(card["id"]?.string ?? "", name) } } label: { Label(L("重新连接（换一把新钥匙，旧的作废）"), systemImage: "arrow.triangle.2.circlepath") }
          Button(role: .destructive) { m.agentSheet = nil; Task { try? await Task.sleep(nanoseconds: 400_000_000); await m.revokeAgent(key["id"]?.string ?? "", name) } } label: { Label(L("断开并删除钥匙"), systemImage: "xmark.circle") }
        } footer: { Text(L("断开后钥匙立刻失效并删除；本机的 AI 会同时移除 kipurse 配置。都需要 Face ID。")) }
      }
      .navigationTitle(L("管理 \(name)")).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(L("完成")) { dismiss() } }
    }.presentationDetents([.medium, .large])
  }
}

struct ConnectResultView: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) var dismiss
  let r: JSONValue
  var body: some View {
    NavigationStack {
      List {
        if let l = r["local"] {
          Section(L("本机配置")) {
            Label(l["note"]?.string ?? "", systemImage: (l["verified"]?.bool ?? false) ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
              .foregroundStyle((l["verified"]?.bool ?? false) ? Brand.positive : Brand.caution)
          }
        }
        Section(T("看一遍怎么连（20 秒）", "Watch how (20 seconds)")) { ConnectTutorial(clientId: r["id"]?.string ?? "custom").padding(.vertical, 6) }
        if r["kind"]?.string == "remote" && r["key"] == nil {
          Section {
            if let u = m.state?.raw["mcpUrl"]?.string {
              Text(u).font(.callout.monospaced()).textSelection(.enabled)
              Button { UIPasteboard.general.string = u; Haptics.success() } label: { Label(L("复制地址"), systemImage: "doc.on.doc").font(.headline) }
            } else { Text(AppConfig.mcpURL).font(.callout.monospaced()).textSelection(.enabled)
              Button { UIPasteboard.general.string = AppConfig.mcpURL; Haptics.success() } label: { Label(L("复制地址"), systemImage: "doc.on.doc").font(.headline) } }
          } header: { Text(L("连接地址（不含钥匙，可以放心复制）")) }
          if let st = r["steps"]?.array {
            Section(L("照着做")) { ForEach(Array(st.enumerated()), id: \.offset) { i, x in Label(x.string ?? "", systemImage: "\(i + 1).circle") }.font(.subheadline) }
            fieldRows(r["fields"]?.array)
          } else {
          Section(L("三步连接")) {
            Label(L("1. 在 \(r["name"]?.string ?? T("这个 AI", "this AI")) 里添加自定义连接（Connector），粘贴上面的地址"), systemImage: "1.circle")
            Label(L("2. 它会打开 Kipurse 授权页：点“在 iPhone 上用 Kipurse App 批准”"), systemImage: "2.circle")
            Label(L("3. 在“待批准”里用 Face ID 同意，回到 AI 就连上了"), systemImage: "3.circle")
          }.font(.subheadline)
          }
          Section { Text(L("地址固定为 \(AppConfig.host)。")).font(.footnote).foregroundStyle(.secondary) }
        } else {
        Section(L("怎么连")) { Text(r["how"]?.string ?? "").font(.subheadline) }
        if let n = r["note"]?.string { Section { WarnBox(text: n) }.listRowInsets(EdgeInsets()).listRowBackground(Color.clear) }
        if let all = r["copyAll"]?.string {
          Section {
            Button { UIPasteboard.general.string = all; Haptics.success() } label: { Label(r["id"]?.string == "muse" ? L("一键复制给 Muse") : L("一键复制配置"), systemImage: "doc.on.doc.fill").font(.headline).frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
            if let k = r["key"]?.string { Button { UIPasteboard.general.string = k; Haptics.success() } label: { Label(L("复制钥匙（只在需要时）"), systemImage: "key") } }
          }
        }
        if let st = r["steps"]?.array {
          Section(L("照着做")) { ForEach(Array(st.enumerated()), id: \.offset) { i, x in Label(x.string ?? "", systemImage: "\(i + 1).circle") }.font(.subheadline) }
        }
        fieldRows(r["fields"]?.array)
        if r["copyAll"] == nil { copyRow(L("对话里发这段"), r["prompt"]?.string); copyRow(L("连接地址（含专用钥匙，别发给别人）"), r["url"]?.string) }
        if let d = r["deeplink"]?.string, let u = URL(string: d) {
          Section("Cursor") { Link(destination: u) { Label(L("在 Cursor 里安装（在装了 Cursor 的设备上打开）"), systemImage: "arrow.up.forward.app") }; copyButton(d) }
        }
        copyRow(L("本机连接地址（只在这台电脑上能用）"), r["kind"]?.string == "custom" ? r["localUrl"]?.string : nil)
        copyRow(L("HTTP 示例（curl）"), r["curl"]?.string)
        copyRow(L("开发者示例（JavaScript）"), r["sdk"]?.string)
        }
      }
      .navigationTitle(r["name"]?.string ?? L("连接")).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(L("完成")) { dismiss() } }
    }
  }
  @ViewBuilder private func fieldRows(_ f: [JSONValue]?) -> some View {
    if let f, !f.isEmpty {
      Section(L("每一栏填什么")) { ForEach(Array(f.enumerated()), id: \.offset) { _, x in
        let v = x["v"]?.string ?? ""
        HStack { VStack(alignment: .leading, spacing: 2) { Text(x["k"]?.string ?? "").font(.caption).foregroundStyle(.secondary); Text(v).font(.callout.monospaced()).lineLimit(2).truncationMode(.middle) }
          Spacer(); Button { UIPasteboard.general.string = v; Haptics.success() } label: { Image(systemName: "doc.on.doc") }.buttonStyle(.borderless) }
      } }
    }
  }
  @ViewBuilder private func copyRow(_ t: String, _ v: String?) -> some View {
    if let v = v { Section(t) { Text(v).font(.caption.monospaced()).lineLimit(6).textSelection(.enabled); copyButton(v) } }
  }
  private func copyButton(_ v: String) -> some View { Button { UIPasteboard.general.string = v; Haptics.success() } label: { Label(L("复制"), systemImage: "doc.on.doc") } }
}

// MARK: 5. 设置 / 安全

struct SettingsTab: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  var embedded = false
  @State private var copied = false
  @State private var askErase = false
  var body: some View {
    EmbedStack(embedded: embedded) {
      List { Group {
        if s.isMainnet || s.wallet != nil {
          Section { SafetyPanel(s: s, part: .actions) } header: { Text(T("安全", "Safety")) }
        }
        if s.isMainnet {
          Section { NavigationLink { MainLimitsView(s: s) } label: { Label(T("AI 额度", "AI allowance"), systemImage: "gauge.with.dots.needle.33percent") }.accessibilityIdentifier("settings.limits")
            NavigationLink { PhoneSignerView() } label: { Label(T("Face ID 批准", "Face ID approvals"), systemImage: "faceid") }.accessibilityIdentifier("settings.phone") }

        }
        Section { NavigationLink { LostPhoneGuide() } label: { Label(T("丢了手机怎么办", "Lost your phone?"), systemImage: "iphone.slash") }.accessibilityIdentifier("settings.lostPhone")
          NavigationLink { RescueGuideView() } label: { Label(RescueText.guideTitle, systemImage: "arrow.down.to.line") }.accessibilityIdentifier("settings.rescueGuide")
          NavigationLink { SafetyTipsView() } label: { Label(T("安全小贴士", "Safety tips"), systemImage: "checkmark.shield") }.accessibilityIdentifier("settings.tips") }

        Section(T("通用", "General")) {
          if let w = s.wallet {
            Button { UIPasteboard.general.string = w; Haptics.success(); copied = true } label: {
              LabeledContent(T("我的钱包地址", "My wallet address")) { HStack(spacing: 6) { Text(shortAddr(w)).font(.footnote.monospaced()); Image(systemName: copied ? "checkmark" : "doc.on.doc").foregroundStyle(Brand.accent) } }
            }.foregroundStyle(.primary).accessibilityIdentifier("settings.copyWallet")
          }
        }
        Section {
          Button { m.signOut() } label: { Label(T("退出登录 / 换账户", "Sign out / switch account"), systemImage: "rectangle.portrait.and.arrow.right") }
            .accessibilityIdentifier("settings.signout")
        } header: { Text(T("账户", "Account")) } footer: { Text(T("钱包和钱都还在，再登录就能回来。", "Your wallet and money stay. Sign in again to come back.")) }
        Section(T("帮助", "Help")) {
          Link(destination: URL(string: "https://kipurse.com/support/")!) { Label(T("帮助与客服", "Help & support"), systemImage: "questionmark.circle") }
          Link(destination: URL(string: "https://kipurse.com/privacy/")!) { Label(T("隐私政策", "Privacy policy"), systemImage: "hand.raised") }
          Link(destination: URL(string: "https://kipurse.com/terms/")!) { Label(T("服务条款", "Terms of Service"), systemImage: "doc.text") }
            .accessibilityIdentifier("settings.terms")   // t934: the only Terms link in the app
        }
        if s.isMainnet || s.wallet != nil {
          Section { SafetyPanel(s: s, part: .delete) } header: { Text(T("危险操作", "Danger zone")) } footer: { Text(T("删除后不能恢复。钱不会消失，但请先在钱包页提现。", "Can't be undone. Your money stays, but withdraw it first on the Wallet tab.")) }
        }
      }.listRowBackground(GlassRowBG())
      }
      .listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Brand.canvas).navigationTitle(L("设置"))
    }
  }
}

struct LimitsView: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  @State private var lim: [String:String] = [:]
  @State private var err = ""
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        HStack(spacing: 12) {
          stat(L("链上每笔"), s.mainSingle ?? 0); stat(L("链上每天"), s.mainDaily ?? 0)
        }
        Text(L("调低立即生效；调高要你再点一次同意；不能超过链上上限。")).font(.footnote).foregroundStyle(.secondary)
        ForEach([("unrecognizedPerPayment",L("陌生收款方每笔上限"),["0.1","0.2","0.5","1"]),("unrecognizedPerDay",L("陌生收款方每天上限"),["0.2","0.5","1","2"]),("depositDailyLimit",L("每天充值上限"),["5","10","20","50"])], id: \.0) { k, t, p in
          AmountPicker(title: L("\(t)（现在 \(AnswerRules.format(s.limits[k] ?? 0))）"), presets: p, unit: "USDC", value: Binding(get: { lim[k] ?? "" }, set: { lim[k] = $0.isEmpty ? nil : $0; err = "" })).card(padding: 18)
        }
        if !err.isEmpty { ErrorText(text: err) }
        BigButton(L("保存上限"), icon: "faceid", disabled: lim.isEmpty) {
          let r = AnswerRules.checkLimitChange(lim, current: s.limits, mainSingle: s.mainSingle, mainDaily: s.mainDaily)
          if !r.ok { Haptics.warn(); err = r.errors.map(\.zh).joined(separator: T("；", "; ")) } else { Task { await m.setLimits(lim); lim = [:] } }
        }
      }.padding(20)
    }.background(Brand.canvas).navigationTitle(L("上限"))
  }
  private func stat(_ t: String, _ v: Int64) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(t).font(.caption).foregroundStyle(.secondary)
      HStack(alignment: .firstTextBaseline, spacing: 3) { Text(AnswerRules.format(v)).font(Brand.money(22)); Text("USDC").font(.caption).foregroundStyle(.secondary) }
    }.card()
  }
}

struct TrustListView: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  var body: some View {
    let list = s.raw["trust"]?["trusted"]?.array ?? []
    List {
      Section {
        if list.isEmpty { Text(L("还没有信任的收款方")).foregroundStyle(.secondary) }
        ForEach(Array(list.enumerated()), id: \.offset) { _, t in
          let name = t["subject"]?["id"]?.string ?? t["key"]?.string ?? "", active = t["active"]?.bool ?? false
          HStack(spacing: 12) {
            Avatar(name: name, symbol: "building.2")
            VStack(alignment: .leading, spacing: 2) {
              Text(name).font(.subheadline.weight(.semibold)).lineLimit(1)
              Text(L("每笔 \(AnswerRules.format(t["single"]?.atomic ?? 0)) · 每天 \(AnswerRules.format(t["daily"]?.atomic ?? 0)) USDC")).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            Spacer(); Chip(text: active ? L("有效") : L("已过期"), color: active ? Brand.positive : .secondary)
          }
          .swipeActions { if let k = t["key"]?.string { Button(L("取消信任"), role: .destructive) { Task { await m.revokeTrust(k) } } } }
        }
      } footer: { Text(L("AI 提议信任新收款方时，会出现在“待批准”。左滑可以取消信任。")) }
    }.listStyle(.insetGrouped).navigationTitle(L("信任的收款方"))
  }
}

struct AddressQR: View {
  let address: String; var network = "Base"
  @State private var copied = false
  var body: some View {
    VStack(spacing: 16) {
      if let img = qr(address) {
        Image(uiImage: img).interpolation(.none).resizable().scaledToFit().frame(width: 200, height: 200)
          .padding(14).background(.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
          .overlay(BrandMark(size: 36).padding(3).background(.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous)))
      }
      VStack(spacing: 4) {
        Text(L("你的钱包地址（\(network)）")).font(.subheadline.weight(.semibold))
        OwnAddress(address: address, id: "qr.addr", copyable: false)
        TipLine(zh: SafetyTips.receiveZh, en: SafetyTips.receiveEn, id: "tip.receive")
      }
      BigButton(copied ? L("已复制") : L("复制地址"), kind: .secondary, icon: copied ? "checkmark" : "doc.on.doc") { UIPasteboard.general.string = address; Haptics.success(); copied = true }.accessibilityIdentifier("qr.copy")
      Text(T("请用 \(network) 网络发送 USDC", "Send USDC on the \(network) network")).font(.footnote).foregroundStyle(.secondary)
    }.frame(maxWidth: .infinity).card(padding: 20)
  }
  private func qr(_ s: String) -> UIImage? {
    let f = CIFilter.qrCodeGenerator(); f.message = Data(s.utf8); f.correctionLevel = "H"
    guard let o = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)), let cg = CIContext().createCGImage(o, from: o.extent) else { return nil }
    return UIImage(cgImage: cg)
  }
}

extension Optional where Wrapped == String { var orEmpty: String { self ?? "" } }

/// Card tap: copy the connect line, then jump straight into the agent's app (scheme if installed, else universal link / web).
enum AgentLauncher {
  @MainActor static func open(_ c: AgentCard, _ m: AppModel) {
    UIPasteboard.general.string = c.copy; Haptics.success()
    var target = c.open
    if let a = c.app, UIApplication.shared.canOpenURL(a) { target = a }
    #if DEBUG
    m.lastLaunch = target.absoluteString
    if m.demo != nil { m.toast = T(c.hintZh, c.hintEn); return }
    #endif
    UIApplication.shared.open(target) { ok in if !ok, let f = c.fallback { UIApplication.shared.open(f) } }
    m.toast = T(c.hintZh, c.hintEn)
  }
}


// MARK: - Emergency stop: one tap (Face ID session) stops every AI payment now. Server pause + on-chain pause (24 h).
struct EmergencyStopRow: View {
  @EnvironmentObject var m: AppModel
  @State private var ask = false; @State private var busy = false; @State private var msg: String?; @State private var needsBind = false
  var body: some View {
    Button(role: .destructive) { ask = true } label: { Label(busy ? L("正在停止…") : L("紧急停止所有 AI 付款"), systemImage: "hand.raised.fill") }
      .disabled(busy).accessibilityIdentifier("settings.emergencyStop")
      .confirmationDialog(L("马上停止所有 AI 付款？"), isPresented: $ask, titleVisibility: .visible) {
        Button(L("停止"), role: .destructive) { Task { await run("safety/stop") } }
        Button(L("恢复 AI 付款")) { Task { await run("safety/resume") } }
        Button(L("取消"), role: .cancel) {}
      } message: { Text(L("停止后 AI 不能再付款，链上也会暂停 24 小时。你随时可以在这里恢复；想彻底收回授权，在 Coinbase 里撤销。")) }
      .alert(msg ?? "", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
        if needsBind { Button(Unbound.goBind) { needsBind = false; m.bindSheet = true }.accessibilityIdentifier("resume.bind") }
        Button(L("好"), role: needsBind ? .cancel : nil) { needsBind = false }
      }
  }
  private func run(_ path: String) async {
    busy = true; defer { busy = false }
    if path == "safety/resume" { let c = await SafetyPanel.resumeWithFaceID(); if c == 200 { Haptics.success(); msg = L("已恢复 AI 付款。") } else { needsBind = c == Unbound.notBound; msg = Unbound.resumeFailText(c) }; return }
    do { let (c, j) = try await MainnetSession.authedPost(path, [:])
      if c == 200 { Haptics.success(); msg = path.hasSuffix("stop") ? (((j["chain"] as? [String: Any])?["paused"] as? Bool) == true ? L("已停止。链上已暂停 24 小时。") : L("已停止 AI 付款。链上暂停没有成功，可以稍后再试。")) : L("已恢复 AI 付款。") }
      else { msg = c == 401 ? L("请先用 Face ID 打开钱包再试。") : L("没有成功（\(c)），请再试一次。") }
    } catch { msg = L("请先用 Face ID 打开钱包再试。") }
  }
}


/// t855: deposit from the owner's OWN verified Coinbase account. Coinbase publishes no deep link that prefills address/asset/network,
/// so: show + copy this wallet's address (QR too), then open Coinbase's send page in the in-app browser. Works on a bound:false phone
/// (needs only the wallet address; nothing is signed). Arrival is watched by polling the balance.
struct CoinbaseDepositView: View {
  /// t885: Coinbase 充值 = ONLY the user's own Coinbase Wallet (Coinbase wallet), never the Coinbase exchange / Onramp.
  /// Reads the Coinbase wallet's USDC on-chain; the transfer page (/deposit?mode=tap, server unchanged) asks the Coinbase wallet
  /// (keys.coinbase.com popup, in-app browser) for ONE USDC.transfer to THIS user's Kipurse wallet (server-registered, never typed).
  /// The account in the popup must be the owner, else the page refuses. Kipurse signs nothing and sponsors nothing here.
  @MainActor static func oneTap(_ m: AppModel) async -> Bool { false }   // t885: the Onramp "send" (exchange) path is gone; callers open this view
  static func transferURL(wallet: String, amount: Int64? = nil) -> URL? {
    var c = URLComponents(url: Mainnet.base.appendingPathComponent("deposit"), resolvingAgainstBaseURL: false)
    c?.queryItems = [URLQueryItem(name: "w", value: wallet), URLQueryItem(name: "mode", value: "tap"), URLQueryItem(name: "lang", value: Loc.code)]
      + (amount.map { $0 > 0 ? [URLQueryItem(name: "amount", value: String($0))] : [] } ?? [])   // t886: pre-selected on the page, server caps it at the on-chain balance
    // t888: MUST carry the #vw=<own wallet> commitment, or the page's guard refuses the transfer after the Coinbase confirmation.
    return c?.url.map { BatchVerify.depositURL($0, wallet: wallet) }
  }
  /// t888: open the transfer page with nothing stacked under it (closes the local Coinbase 充值 sheet first), then watch for arrival.
  @MainActor static func openTransfer(_ m: AppModel, _ u: URL, baseline: Int64) {
    m.afterMuse {
      m.openFreePage(u) { mm in
        await mm.refresh(); let now = mm.state?.balance ?? 0
        if now > baseline { mm.toast = T("已到账 +\(AnswerRules.format(now - baseline)) USDC", "Arrived +\(AnswerRules.format(now - baseline)) USDC"); Haptics.success(); return true }
        return false
      }
    }
  }
  /// t886: "12.5" / "1,234.56" -> atomic USDC (6 decimals); nil when not a positive number.
  static func atomic(_ raw: String) -> Int64? {
    let v = raw.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "，", with: "").trimmingCharacters(in: .whitespaces)
    let parts = v.split(separator: ".", omittingEmptySubsequences: false)
    guard !v.isEmpty, parts.count <= 2, let i = Int64(parts[0].isEmpty ? "0" : String(parts[0])), parts[0].allSatisfy(\.isNumber), i < 10_000_000 else { return nil }
    var f: Int64 = 0
    if parts.count == 2 { let d = String(parts[1]); guard d.count <= 6, d.allSatisfy(\.isNumber) else { return nil }; f = Int64((d + "000000").prefix(6)) ?? 0 }
    let n = i * 1_000_000 + f; return n > 0 ? n : nil
  }
  static func plain(_ a: Int64) -> String { let f = String(format: "%06d", a % 1_000_000).replacingOccurrences(of: "0+$", with: "", options: .regularExpression); return "\(a / 1_000_000)" + (f.isEmpty ? "" : ".\(f)") }
  @EnvironmentObject var m: AppModel
  let s: WalletState
  @State private var baseline: Int64?; @State private var waiting = false; @State private var arrived: Int64?
  @State private var baBal: Int64?; @State private var loaded = false; @State private var amountText = ""
  var owner: String? {
    #if DEBUG
    if let i = CommandLine.arguments.firstIndex(of: "-kpCBVOwner"), i + 1 < CommandLine.arguments.count { return CommandLine.arguments[i + 1] }
    #endif
    return s.owner
  }
  func readBalance() async {
    #if DEBUG
    if m.demo != nil { let a = CommandLine.arguments; if let i = a.firstIndex(of: "-kpBABal"), i + 1 < a.count { baBal = Int64(a[i + 1]) } else { baBal = 14_304_957 }; loaded = true; if amountText.isEmpty, let b = baBal, b > 0 { amountText = Self.plain(b) }; return }
    #endif
    if let o = owner, CoinbaseIdentity.isAddress(o) { baBal = await VaultCheck.usdcBalance(o) } else { baBal = nil }
    loaded = true; if amountText.isEmpty, let b = baBal, b > 0 { amountText = Self.plain(b) }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if let plus = arrived {
        Label(T("已到账 +\(AnswerRules.format(plus)) USDC", "Arrived +\(AnswerRules.format(plus)) USDC"), systemImage: "checkmark.circle.fill").font(.title3.bold()).foregroundStyle(Brand.positive).accessibilityIdentifier("cbdep.arrived")
      }
      if let w = s.wallet, m.demo != nil || Operator.wallet.isEmpty || Operator.wallet.lowercased() == w.lowercased() {
        Text(T("从你的 Coinbase 钱包转入", "Move USDC in from your Coinbase Wallet")).font(.title3.bold()).accessibilityIdentifier("cbdep.title")
        Text(T("只连接你自己的 Coinbase 钱包，不连接 Coinbase 交易所。", "Only your own Coinbase Wallet (Coinbase wallet), never the Coinbase exchange."))
          .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbdep.walletOnly")
        if !loaded { HStack(spacing: 8) { ProgressView(); Text(T("正在读取你的 Coinbase 钱包余额…", "Reading your Coinbase Wallet balance…")).font(.subheadline).foregroundStyle(.secondary) }.card(padding: 16) }
        else if let b = baBal, b > 0 {
          VStack(alignment: .leading, spacing: 6) {
            Text(T("你的 Coinbase 钱包有", "Your Coinbase Wallet has")).font(.subheadline).foregroundStyle(.secondary)
            Text("\(AnswerRules.format(b)) USDC").font(Brand.money(34)).accessibilityIdentifier("cbdep.baBalance")
            if let o = owner { Text(T("钱包地址 \(o.prefix(6))…\(o.suffix(4))", "Wallet \(o.prefix(6))…\(o.suffix(4))")).font(.caption.monospaced()).foregroundStyle(.secondary).accessibilityIdentifier("cbdep.owner") }
          }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 16)
          let n = Self.atomic(amountText); let over = n.map { $0 > b } ?? false
          VStack(alignment: .leading, spacing: 8) {
            Text(T("转入多少 USDC？", "How much USDC?")).font(.headline)
            HStack(spacing: 8) {
              TextField(T("金额", "Amount"), text: $amountText).keyboardType(.decimalPad).font(.system(size: 22, weight: .semibold, design: .rounded))
                .padding(12).background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 12)).accessibilityIdentifier("cbdep.amount")
              Button(T("全部", "All")) { amountText = Self.plain(b) }.buttonStyle(.bordered).accessibilityIdentifier("cbdep.all")
            }
            if over { Text(T("超过了你 Coinbase 钱包的余额", "More than your Coinbase Wallet balance")).font(.footnote).foregroundStyle(Brand.negative).accessibilityIdentifier("cbdep.over") }
            else if n == nil && !amountText.isEmpty { Text(T("请输入像 10 或 12.5 这样的金额", "Enter an amount like 10 or 12.5")).font(.footnote).foregroundStyle(Brand.negative).accessibilityIdentifier("cbdep.bad") }
            Text(T("点下面按钮后，在 Coinbase 弹窗里用你的 Coinbase 钱包确认。钱直接进你自己的启付钱包，回到这里会自动显示到账。", "Tap below, then confirm with your Coinbase Wallet in the Coinbase popup. It goes straight into your own Kipurse wallet; come back here to see it arrive."))
              .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbdep.steps")
            BigButton(T("从 Coinbase 钱包转入", "Move in from Coinbase Wallet"), icon: "arrow.down.circle.fill", disabled: n == nil || over) {
              guard let a = n, a <= b, let u = Self.transferURL(wallet: w, amount: a) else { return }
              Haptics.tap(); waiting = true
              if m.demo != nil { m.lastLaunch = u.absoluteString } else { Self.openTransfer(m, u, baseline: m.state?.balance ?? s.balance) }
            }.accessibilityIdentifier("cbdep.go")
            Text(T("收款方固定是你自己的启付钱包，不能改。网络手续费很少，在 Coinbase 弹窗里付（可以用 USDC），启付不收费。", "The recipient is always your own Kipurse wallet and can’t be changed. The tiny network fee is paid in the Coinbase popup (USDC works); Kipurse charges nothing."))
              .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbdep.fee")
          }.card(padding: 18)
        } else {
          VStack(alignment: .leading, spacing: 8) {
            Label(baBal == nil ? T("暂时读不到你的 Coinbase 钱包余额", "Couldn’t read your Coinbase Wallet balance right now") : T("你的 Coinbase 钱包里没有 USDC", "Your Coinbase Wallet has no USDC"), systemImage: "info.circle.fill")
              .font(.headline).foregroundStyle(Brand.caution).accessibilityIdentifier("cbdep.empty")
            Text(T("可以从别的钱包把 USDC 转到下面这个你自己的启付钱包地址。只转 USDC，网络必须选 Base，选错钱会丢。", "You can send USDC from another wallet to your own Kipurse address below. USDC only, on the Base network; anything else is lost."))
              .font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbdep.warn")
            if baBal == nil { Button(T("再读一次", "Try again")) { loaded = false; Task { await readBalance() } }.accessibilityIdentifier("cbdep.retry") }
          }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 16)
          AddressQR(address: w, network: "Base")
          Button { waiting = true; Task { await m.refresh() } } label: { Label(T("我已转账，查看是否到账", "I’ve sent it — check"), systemImage: "arrow.clockwise") }.accessibilityIdentifier("cbdep.check")
        }
        if waiting && arrived == nil {
          HStack(spacing: 8) { ProgressView(); Text(T("正在等待到账…确认后回到这里会自动提示。", "Waiting… after you confirm, come back here to see it arrive.")).font(.footnote).foregroundStyle(.secondary) }.accessibilityIdentifier("cbdep.waiting")
        }
      } else { Text(L("还没有钱包地址")).foregroundStyle(.secondary) }
    }
    .onAppear { if baseline == nil { baseline = m.state?.balance ?? s.balance } }
    .task { await readBalance() }
    .task { while !Task.isCancelled { try? await Task.sleep(nanoseconds: 6_000_000_000); guard waiting, arrived == nil, m.demo == nil else { continue }
      await m.refresh(); let now = m.state?.balance ?? 0; if let b = baseline, now > b { arrived = now - b; Haptics.success(); await readBalance() } } }
  }
}


/// t857: home section header (充值 / 提现 / 限额), v5 style: brand-tinted icon + bold title.
struct HomeSectionTitle: View {
  let title: String; let icon: String; let id: String
  var body: some View {
    HStack(spacing: 8) { Image(systemName: icon).font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.accent); Text(title).font(.system(size: 20, weight: .bold)) }
      .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader).accessibilityIdentifier(id)
  }
}


/// t864: home Coinbase Verified status (the only KYC). Checked automatically; re-checked when the app comes back from Coinbase.
struct HomeVerifyRow: View {
  var ownerHint: String?
  @StateObject private var v = CBVerifyModel()
  @Environment(\.scenePhase) private var phase
  @State private var guide = false
  var body: some View {
    Group {
      switch v.status {
      case .verified:
        Label(T("Coinbase 已认证", "Coinbase Verified"), systemImage: "checkmark.seal.fill").font(.subheadline.weight(.semibold)).foregroundStyle(Brand.positive)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 10)
          .background(Brand.positive.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous)).accessibilityIdentifier("home.cbv.ok")
      case .notVerified:
        Button { Haptics.tap(); guide = true } label: {
          HStack(spacing: 10) { Image(systemName: "person.badge.shield.checkmark").foregroundStyle(Brand.caution)
            Text(T("实名认证未完成", "Identity not verified")).font(.subheadline.weight(.semibold)).foregroundStyle(.primary); Spacer()
            Text(T("去认证", "Verify")).font(.subheadline.weight(.semibold)).foregroundStyle(Brand.accent); Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.secondary) }
            .padding(.horizontal, 14).padding(.vertical, 12).background(Brand.caution.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Brand.caution.opacity(0.35), lineWidth: 1))
        }.buttonStyle(.plain).accessibilityIdentifier("home.cbv.todo")
        Text(VerifyWalletHelp.pendingNote).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4).accessibilityIdentifier("home.cbv.pending")
      default: Color.clear.frame(height: 0)
      }
    }.frame(maxWidth: .infinity)
    .task { CBVerifyModel.ownerFallback = ownerHint; await v.check(countMock: false) }
    .onChange(of: phase) { p in if p == .active { Task { await v.check(countMock: false) } } }
    .task(id: v.status == .verified) {   // t875: while unverified and this row is on screen (home visible, app active): re-check every 60 s; stops when verified / off screen
      guard v.status != .verified else { return }
      while !Task.isCancelled { try? await Task.sleep(nanoseconds: 60_000_000_000); if Task.isCancelled { break }
        if phase == .active, v.status != .verified { await v.check(countMock: false) } }
    }
    .sheet(isPresented: $guide, onDismiss: { Task { await v.check(countMock: false) } }) {
      NavigationStack { ScrollView { VStack(alignment: .leading, spacing: 14) {
        Text(T("用 Coinbase 完成实名认证（约 2 分钟）", "Get Coinbase Verified (about 2 min, free)")).font(.title3.bold())
        Text(T("启付自己不做实名认证，只看 Coinbase 的官方链上认证。", "Kipurse does no identity checks of its own; it only reads Coinbase's official on-chain verification.")).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Text(T("1. 点下面按钮，打开 Coinbase 认证页\n2. 用 Coinbase 登录，点 Get verified\n3. 连接你登录启付用的同一个钱包，签一次认证（不花钱）\n4. 回到启付，会自动重新检查", "1. Tap below to open Coinbase's verification page\n2. Sign in to Coinbase and tap Get verified\n3. Connect the same wallet you use with Kipurse and sign the free verification\n4. Come back; Kipurse re-checks automatically"))
          .font(.body).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cbv.steps")
        if v.status != .verified { VerifyWalletHelp(address: CBVerifyGuide.ownerAddress ?? ownerHint) }   // t876: the user's own address only   // t866: only for unverified users
        BigButton(T("打开 Coinbase 认证页", "Open Coinbase verification"), icon: "arrow.up.forward.app") {
          #if DEBUG
          if CommandLine.arguments.contains("-kpCBV") { return }
          #endif
          // t875 (LOCKED): in-app browser only, with the hint banner
          InApp.open(CoinbaseVerify.onchainVerifyURL, banner: VerifyWalletHelp.banner(CBVerifyGuide.ownerAddress ?? ownerHint)) }.accessibilityIdentifier("cbv.open")
        if v.status == .verified { Label(T("已认证", "Verified"), systemImage: "checkmark.seal.fill").foregroundStyle(Brand.positive) }
        Button(T("我已完成，重新检查", "I'm done, check again")) { Task { await v.check(countMock: false) } }.accessibilityIdentifier("cbv.recheck")
      }.padding(20) }.background(Brand.canvas).navigationTitle(T("实名认证", "Verification")).navigationBarTitleDisplayMode(.inline)
        .toolbar { Button(T("完成", "Done")) { guide = false } } }
    }
  }
}
