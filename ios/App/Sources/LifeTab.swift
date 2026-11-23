import SwiftUI
import PassKit
import KipurseCore

// MARK: - t681 「AI 生活」 + 「钱包」, rebuilt to match the approved v5 mockups (m.html colours / sizes).

/// Mockup colours.
enum MK {
  static let bg = Color(hex: 0x05040C), eyebrow = Color(hex: 0xA78BFA), link = Color(hex: 0xA78BFA)
  static let green = Color(hex: 0x34FFB0), cyan = Color(hex: 0x67E8F9), rowLine = Color.white.opacity(0.063)
  static let dim = Color.white.opacity(0.44), legend = Color.white.opacity(0.73)
}

/// Page background: three soft colour pools on near-black (m.html .bg). Light look keeps the system canvas.
struct MockBG: View {
  @Environment(\.colorScheme) private var cs
  var body: some View {
    if cs == .light { Brand.canvas.ignoresSafeArea() } else {
      GeometryReader { g in
        let w = g.size.width, h = g.size.height
        ZStack {
          MK.bg
          Ellipse().fill(RadialGradient(colors: [Color(hex: 0x5B2CFF).opacity(0.33), .clear], center: .center, startRadius: 0, endRadius: w * 0.6)).frame(width: w * 1.2, height: h * 0.8).position(x: w * 0.15, y: h * 0.05)
          Ellipse().fill(RadialGradient(colors: [Color(hex: 0x00E0FF).opacity(0.16), .clear], center: .center, startRadius: 0, endRadius: w * 0.5)).frame(width: w, height: h * 0.7).position(x: w * 0.95, y: h * 0.2)
          Ellipse().fill(RadialGradient(colors: [Color(hex: 0xFF2D95).opacity(0.16), .clear], center: .center, startRadius: 0, endRadius: w * 0.7)).frame(width: w * 1.4, height: h * 0.8).position(x: w * 0.5, y: h)
        }
      }.ignoresSafeArea()
    }
  }
}

/// t1066u: life/wallet glass shells share KPGlass clear chrome (transparent + purple→cyan neon). Default radius 24.
struct Glass: ViewModifier {
  var radius: CGFloat = 24
  @Environment(\.accessibilityReduceTransparency) private var rt
  @Environment(\.colorScheme) private var cs
  func body(content: Content) -> some View {
    let sh = RoundedRectangle(cornerRadius: radius, style: .continuous)
    let dark = cs == .dark
    content
      .background { KPGlass.fill(sh, dark: dark, rt: rt) }
      .overlay(KPGlass.rim(sh, dark: dark, intense: true))
      .shadow(color: KPGlass.glow(dark: dark), radius: dark ? 18 : 10, y: dark ? 8 : 4)
  }
}
extension View { func glass(_ r: CGFloat = 24) -> some View { modifier(Glass(radius: r)) } }

// MARK: Agents — the four approved characters, always shown; state from real agent data.

struct LifeAgent: Identifiable { let id: String, name: String, phase: AgentPhase, hue: Int; var lastUsed: Date? = nil }

extension WalletState {
  var allAIPaused: Bool { if let b = raw["paused"]?.bool { return b }; return raw["paused"]?["active"]?.bool ?? false }
  static let fourAgents = ["Muse", "Grok", "Claude", "Siri"]   // t693: the owner's four real agents (Grok = Grok Bot) on the original orb characters (no brand art)
  /// Live agent for one of the four names: id, kind or name contains the key ("grok" matches "Grok Bot" / "grok-bot").
  /// t1157u: exact id/kind first, connected first (AgentMatch); a never-connected "oauth-siri" row no longer hides the real Siri row.
  func liveAgent(for name: String) -> JSONValue? { AgentMatch.pick(liveAgents, name: name) }
  /// Muse / Grok / Claude / Siri in fixed order. A character is matched to a live agent by id, kind or name;
  /// with no match it shows 未连接 (grey). Status never comes from anything but real agent data.
  func lifeAgents(now: Date = Date()) -> [LifeAgent] {
    let txs = self.txs
    return Self.fourAgents.map { n in
      let key = n.lowercased()
      guard let a = liveAgent(for: n) else {
        return LifeAgent(id: key, name: n, phase: .offline, hue: Orb.hue(n)) }
      let id = a["id"]?.string ?? key, kind = a["kind"]?.string ?? ""
      let mine = txs.filter { [id.lowercased(), kind.lowercased(), key].contains($0.agent.lowercased()) }
      let ph = AgentPhase.derive(connected: a["connected"]?.bool ?? false, paused: a["paused"]?.bool ?? false, allPaused: allAIPaused,
                                 pendingPayments: mine.filter(\.pending).count, lastUsed: Tx.parseDate(a["lastUsed"]), now: now)
      return LifeAgent(id: key, name: n, phase: ph, hue: Orb.hue(n), lastUsed: Tx.parseDate(a["lastUsed"]))
    }
  }
  func category(_ t: Tx) -> LifeCategory {
    let j = purchases.first { ($0["purchaseKey"]?.string ?? "") == t.id }
    return LifeCategory.classify(merchant: t.merchantName, reason: j?["reason"]?.string, explicit: j?["category"]?.string)
  }
  func agentName(_ t: Tx) -> String {
    let n = liveAgents.first { [$0["id"]?.string, $0["kind"]?.string].contains(t.agent) }?["name"]?.string ?? t.agent
    return Self.fourAgents.first { n.lowercased().contains($0.lowercased()) } ?? n
  }
  func spentThisMonth(now: Date = Date()) -> Int64 { txs.filter { !$0.failed && ($0.date.map { Calendar.current.isDate($0, equalTo: now, toGranularity: .month) } ?? false) }.reduce(0) { $0 + $1.amount } }
}

/// Original orb character (m.html .orb): radial body, per-character texture, specular highlight, glowing eyes.
/// Online: breathing glow. Paying: conic ring spins. Paused / not connected: grey. Reduce Motion: still.
struct Orb: View {
  /// (highlight, mid, deep, glow) — the v5 characters (orange rays, teal lines, blue grid, violet) for Muse, Grok, Claude, Siri, then two extra originals for other AIs.
  static let palettes: [[UInt32]] = [[0xFFD29A, 0xFF7A45, 0x7A1F3D, 0xFF8A5B], [0xB6FFE4, 0x19C39A, 0x053B3A, 0x34E3B0], [0xE6F4FF, 0x4F8DFF, 0x2A2F8F, 0x8AB8FF],
                                     [0xF5D0FF, 0xA855F7, 0x2E0A4F, 0xD58BFF], [0xFFF1B0, 0xF5B524, 0x6B3A06, 0xFFD60A], [0xFFD0DE, 0xF0457A, 0x5A0F2E, 0xFF6B9A]]
  static func hue(_ name: String) -> Int {
    if let i = WalletState.fourAgents.firstIndex(where: { name.lowercased().contains($0.lowercased()) }) { return i }
    return 4 + abs(name.lowercased().unicodeScalars.reduce(0) { $0 &+ Int($1.value) * 31 }) % 2
  }
  let phase: AgentPhase; var hue = 0; var size: CGFloat = 66; var still = false
  @Environment(\.accessibilityReduceMotion) private var rmEnv; private var rm: Bool { rmEnv || KPStill.on }
  /// t690: only a lit orb (online / paying) moves; not connected or paused = completely static. Reduce Motion = static.
  var live: Bool { !still && phase.animates(reduceMotion: rm) }
  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 30, paused: !live)) { tl in
      let t = live ? tl.date.timeIntervalSinceReferenceDate : 0
      let p = Orb.palettes[hue % Orb.palettes.count].map { Color(hex: $0) }
      let grey = phase == .paused || phase == .offline
      let b = (sin(t * 2 * .pi / 2.4) + 1) / 2
      let blink = live && t.truncatingRemainder(dividingBy: 4) > 3.6 && t.truncatingRemainder(dividingBy: 4) < 3.8
      let d = size * 58 / 66
      ZStack {
        if phase == .paying {
          Circle().strokeBorder(AngularGradient(colors: [Color(hex: 0x00E0FF), Color(hex: 0xA855F7), Color(hex: 0xFF2D95), .clear, .clear], center: .center, angle: .degrees(t * 240)), lineWidth: size * 0.05)
            .frame(width: size + 6, height: size + 6)
        }
        ZStack {
          Circle().fill(RadialGradient(stops: [.init(color: p[0], location: 0), .init(color: p[1], location: 0.45), .init(color: p[2], location: 1)], center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: d * 0.75))
          texture(d)
          Ellipse().fill(RadialGradient(colors: [.white.opacity(0.8), .clear], center: .center, startRadius: 0, endRadius: d * 0.19)).frame(width: d * 0.38, height: d * 0.26).position(x: d * (0.18 + 0.19), y: d * (0.10 + 0.13))
          HStack(spacing: d * 0.32 - size * 6 / 66) {
            ForEach(0..<2, id: \.self) { _ in RoundedRectangle(cornerRadius: 3).fill(.white).frame(width: size * 6 / 66, height: size * 9 / 66 * (blink ? 0.15 : 1)).shadow(color: .white, radius: 3) }
          }.position(x: d / 2, y: d * 0.45 + size * 4.5 / 66)
        }
        .frame(width: d, height: d).clipShape(Circle())
        .opacity(grey ? 0.9 : 1)   // t1029: keep brand colour when unbound
      }
      .frame(width: size, height: size)
      .shadow(color: grey ? .clear : (phase == .paying ? MK.cyan : p[3]).opacity(0.9), radius: grey ? 0 : (phase == .paying ? 10 : (live ? 4 + b * 8 : 8)))
      .shadow(color: grey || hue % Orb.palettes.count != 2 ? .clear : Color(hex: 0xA78BFA).opacity(0.55), radius: grey ? 0 : (live ? 10 + b * 6 : 12))
    }
    .accessibilityHidden(true)
  }
  @ViewBuilder func texture(_ d: CGFloat) -> some View {
    switch hue % Orb.palettes.count {
    case 0: Circle().fill(AngularGradient(stops: (0..<12).flatMap { i -> [Gradient.Stop] in let a = Double(3 * i) / 36, b = Double(3 * i + 1) / 36, c = Double(3 * i + 3) / 36; return [.init(color: .white.opacity(0.094), location: a), .init(color: .white.opacity(0.094), location: b), .init(color: .clear, location: b), .init(color: .clear, location: c)] }, center: .center))
    case 1: VStack(spacing: d * 0.1 - 2) { Rectangle().fill(.white.opacity(0.25)).frame(height: 2); Rectangle().fill(.white.opacity(0.44)).frame(height: 2); Rectangle().fill(.white.opacity(0.19)).frame(height: 2) }
        .padding(.horizontal, d * 0.1).position(x: d / 2, y: d * 0.62)
    case 2: Canvas { c, s in var p = Path(); var x: CGFloat = 0; while x < s.width { p.addRect(CGRect(x: x, y: 0, width: 1, height: s.height)); p.addRect(CGRect(x: 0, y: x, width: s.width, height: 1)); x += 8 }; c.fill(p, with: .color(.white.opacity(0.08))) }
    default: EmptyView()
    }
  }
}

/// t915: open that AI's own app (universal link / scheme), or its App Store page when it can't be opened.
@MainActor func openAgentApp(_ key: String) {
  if key.lowercased() == "siri" { NotificationCenter.default.post(name: .kpShowSiri, object: nil); return }   // t922: Siri has no app; show how to talk to it (no Shortcuts)
  guard let l = AgentBuy.appLink(for: key) else { return }
  UIApplication.shared.open(l.primary, options: [:]) { ok in if !ok, let f = l.fallback { UIApplication.shared.open(f) } }
}

struct OrbAgentCell: View {
  let a: LifeAgent
  var body: some View {
    TimelineView(.periodic(from: .now, by: 30)) { ctx in cell(ctx.date) }
  }
  @ViewBuilder func cell(_ now: Date) -> some View {
    let seen = AgentPhase.lastSeen(a.lastUsed, now: now)
    VStack(spacing: 0) {
      // t1062: fixed bead slot = AgentLogo outer frame (size+22) so connected halo never shifts Y
      AgentLogo(name: a.name, phase: a.phase, size: 58)
        .frame(width: 80, height: 80, alignment: .center)
        .padding(.bottom, 7)
      Text(a.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
      HStack(spacing: 4) { Circle().fill(color).frame(width: 6, height: 6); Text(T(a.phase.zh, a.phase.en)).font(.system(size: 10.5, weight: .medium)).lineLimit(1).minimumScaleFactor(0.85) }.foregroundStyle(color).padding(.top, 1).padding(.horizontal, 4)   // t1245 U2
      // Always reserve one caption line so status rows stay neat under the aligned beads
      Group {
        if let s = seen, a.phase != .offline {
          Text(T(s.zh, s.en)).font(.system(size: 9.5)).foregroundStyle(.white.opacity(0.5)).lineLimit(1).minimumScaleFactor(0.8)
        } else {
          Text(" ").font(.system(size: 9.5)).opacity(0)
        }
      }.frame(height: 13).padding(.top, 1)
    }
    .frame(maxWidth: .infinity, alignment: .top)
    .accessibilityElement(children: .ignore).accessibilityLabel("\(a.name), \(T(a.phase.zh, a.phase.en))\(seen.map { ", " + T($0.zh, $0.en) } ?? "")").accessibilityIdentifier("life.agent.\(a.id)")
  }
  var color: Color { switch a.phase { case .online: return MK.green; case .paying: return MK.cyan; case .paused, .idle, .offline: return .white.opacity(0.33) } }
}

/// Whole-dollar display for the summary ($486), like the mockup; rows keep two decimals.
func dollars(_ a: Int64) -> String { let v = Double(a) / 1_000_000; return (v >= 100 || v == v.rounded() ? String(Int(v.rounded())) : String(format: "%.2f", v)) + " USDC" }   // t927: one unit everywhere (USDC)

struct SpendRing: View {
  let segs: [(LifeCategory, Double, Double)]; let total: Int64
  @State private var drawn = false
  @Environment(\.accessibilityReduceMotion) private var rmEnv; private var rm: Bool { rmEnv || KPStill.on }
  var body: some View {
    ZStack {
      ForEach(segs, id: \.0) { c, a, b in
        Circle().trim(from: a, to: drawn ? b : a).stroke(Color(hex: c.hex), style: StrokeStyle(lineWidth: 10.5, lineCap: .butt)).rotationEffect(.degrees(-90))
      }.shadow(color: Color(hex: 0xBF5AF2).opacity(0.4), radius: 6)
      VStack(spacing: 0) {
        Text(T("本月支出", "This month")).font(.system(size: 11)).foregroundStyle(.white.opacity(0.53))
        Text(dollars(total)).font(.system(size: 24, weight: .heavy)).kerning(-0.5).lineLimit(1).minimumScaleFactor(0.5).modifier(RollingNumber(value: Double(total)))
      }.padding(.horizontal, 14)
    }
    .frame(width: 101, height: 101).frame(width: 112, height: 112)
    .onAppear { if rm { drawn = true } else { withAnimation(.easeOut(duration: 0.9)) { drawn = true } } }
    .accessibilityElement(children: .ignore).accessibilityLabel(T("本月支出 \(dollars(total))", "Spent this month \(dollars(total))")).accessibilityIdentifier("life.ring")
  }
}

struct LifeLedgerRow: View {
  let t: Tx; let c: LifeCategory; let agent: String
  var body: some View {
    let col = Color(hex: c.hex)
    HStack(spacing: 12) {
      Image(systemName: c.symbol).font(.system(size: 17, weight: .semibold)).foregroundStyle(col)
        .frame(width: 38, height: 38).background(col.opacity(0.13), in: RoundedRectangle(cornerRadius: KP.Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: KP.Radius.control, style: .continuous).strokeBorder(col.opacity(0.31), lineWidth: 1))
      VStack(alignment: .leading, spacing: 1) {
        Text(t.friendlyTitle).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).lineLimit(1).accessibilityIdentifier(t.unnamed ? "life.unnamed" : "")
        // §6#110 (owner 2026-11-21): which AI paid + the category, clearly visible (agent label + category chip), then address/time in grey.
        // t1245 (§6#115 U1): nothing truncated — line 2 = which AI + category chip, line 3 = address / time in grey.
        HStack(spacing: 6) {
          Text(T("\(agent) 付的", "Paid by \(agent)")).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.75)).fixedSize()
          Chip(text: T(c.zh, c.en), color: col).lineLimit(1).fixedSize()
        }.padding(.top, 2)
        let meta = (t.unnamed ? shortAddr(t.payee) : "") + (t.date.map { (t.unnamed ? " · " : "") + LifeLedgerRow.when($0) } ?? "")
        if !meta.isEmpty { Text(meta).font(.system(size: 12)).foregroundStyle(.white.opacity(0.44)).fixedSize(horizontal: false, vertical: true) }
      }
      Spacer(minLength: 6)
      VStack(alignment: .trailing, spacing: 0) {
        Text("-" + MoneyText.amount(t.amount)).font(.system(size: 15, weight: .bold).monospacedDigit()).foregroundStyle(t.failed ? .white.opacity(0.4) : .white).strikethrough(t.failed)
        if t.failed || t.pending { Chip(text: t.stateZh, color: t.stateColor) } else { Text("USDC").font(.system(size: 10, weight: .medium)).kerning(0.5).foregroundStyle(.white.opacity(0.33)) }
      }
    }.padding(.vertical, 10).padding(.horizontal, 14).contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(t.merchantName), \(T("\(agent) 付的", "Paid by \(agent)")), \(T("类别", "Category")) \(T(c.zh, c.en)), -\(MoneyText.usdc(t.amount))" + (t.failed || t.pending ? ", \(t.stateZh)" : ""))
  }
  /// Today: time. Yesterday: 昨天. Older: short date. Always in the app language.
  static func when(_ d: Date) -> String {
    let loc = Locale(identifier: Loc.isChinese ? "zh_CN" : "en_US"), cal = Calendar.current
    if cal.isDateInToday(d) { let f = DateFormatter(); f.locale = loc; f.dateFormat = "HH:mm"; return f.string(from: d) }
    if cal.isDateInYesterday(d) { return T("昨天", "Yesterday") }
    return d.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted).locale(loc))
  }
}

/// m.html h1 / eyebrow.
struct PageTitle: View {
  let eyebrow: String?; let title: String; var id: String
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let e = eyebrow { Text(e).font(.system(size: 12, weight: .bold)).kerning(2).foregroundStyle(MK.eyebrow).accessibilityIdentifier("life.online") }
      Text(title).font(KP.Typo.pageTitle).kerning(-0.6).foregroundStyle(.primary).accessibilityAddTraits(.isHeader).accessibilityIdentifier(id)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// t1068u: shared top inset for the three root-tab large titles (AI 生活 / 钱包 / 设置) so they share one Y.
enum TabRootChrome {
  static let titleTop: CGFloat = KP.Space.xs
}

struct SectionHead: View {
  let title: String; var link: String? = nil; var linkID = ""; var action: (() -> Void)? = nil
  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title).font(KP.Typo.section)
      Spacer()
      if let l = link, let a = action { Button(l) { Haptics.tap(); a() }.font(.system(size: 14, weight: .medium)).foregroundStyle(MK.link).accessibilityIdentifier(linkID) }
    }.padding(.horizontal, 2)
  }
}

struct LifeTab: View {
  @EnvironmentObject var m: AppModel
  @ObservedObject private var allow = AllowanceStore.shared   // t1245 U11: the pending block shows / hides with its lists
  @ObservedObject private var holds = HoldsStore.shared
  let s: WalletState; @Binding var tab: AppTab
  @State private var picked: Tx?
  @State private var showAll = false
  @State private var siriPhrases = false
  @State private var limitConnect: AIConnect?
  @State private var showAILimits = false
  @State private var handoff: ConnectHandoffItem?   // t1254 §6#123: 「下一步」 page before jumping to an outside AI
  var body: some View {
    let agents = s.lifeAgents()
    let txs = s.txs.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    let totals = LifeLedger.monthTotals(txs.map { LifeItem(amount: $0.amount, date: $0.date, failed: $0.failed, category: s.category($0)) }, now: Date())
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: KP.Space.sectionGap) {   // t1039u: one rhythm
          HStack(alignment: .top) {   // t1068u: top-align with 钱包/设置 titles (same Y)
            // t1065u: drop month · AI-online eyebrow; keep big title only
            PageTitle(eyebrow: nil, title: T("AI 生活", "AI Life"), id: "life.title")
            Button { Haptics.tap(); tab = .agents } label: { Image(systemName: "ellipsis").font(.system(size: 17, weight: .bold)).foregroundStyle(.white.opacity(0.6)).frame(width: 40, height: 40).background(.white.opacity(0.08), in: Circle()) }
              .accessibilityLabel(T("管理 AI", "Manage AI")).accessibilityIdentifier("life.manage").padding(.top, 2)
          }.padding(.top, TabRootChrome.titleTop)
          // t927 → §6#110 (owner 2026-11-21): approvals still have ONE place, now here on AI 生活 (the AI payments home): connect requests,
          // new-merchant trust, AI allowance requests, held payments. The tab badge points here.
          if PendingApprovalsBlock.count(s) > 0 { PendingApprovalsBlock(s: s) }   // t1245 U11: no empty block, no extra gap
          VStack(alignment: .leading, spacing: KP.Space.cardGap) {
          // t1062: equal columns, top-aligned — bead centers share one Y; captions may differ in height
          HStack(alignment: .top, spacing: 0) {
            ForEach(agents) { a in
              Button { Haptics.tap();
                if a.id == "siri" { AIConnect.begin(.siri, s: s, m: m, pending: $limitConnect, present: $showAILimits) }
                else if a.phase == .offline {
                  if a.id == "muse" { AIConnect.begin(.muse, s: s, m: m, pending: $limitConnect, present: $showAILimits) }
                  else if let c = AgentCard.mainnet.first(where: { $0.id == a.id || ($0.id == "grok-bot" && a.id == "grok") }) { AIConnect.begin(.card(c.id), s: s, m: m, pending: $limitConnect, present: $showAILimits) }
                } else { openAgentApp(a.id) }
              } label: { OrbAgentCell(a: a) }
                .buttonStyle(Pressable())
                .frame(maxWidth: .infinity, alignment: .top)
            }
          }

          summary(LifeCategory.allCases.compactMap { c in totals.first { $0.0 == c } })
          if s.isMainnet {   // t1038u: AI 总限额 lives on AI Life
            NavigationLink { MainLimitsView(s: s, scope: .ai) } label: {
              LimitEntryRow(icon: "gauge.with.dots.needle.33percent", title: T(EverydayLimits.aiTitleZh, EverydayLimits.aiTitleEn), sub: T(EverydayLimits.aiExplainZh, EverydayLimits.aiExplainEn))
            }.buttonStyle(.plain).accessibilityIdentifier("life.aiLimit")
          }
          // §6#110: new-merchant trust lives on AI 生活 — the list of merchants you trusted (new ones ask you in 待你批准 above).
          NavigationLink { TrustListView(s: s) } label: {
            LimitEntryRow(icon: "checkmark.seal.fill", title: T("信任的商家", "Trusted merchants"), sub: TrustListView.summary(s))
          }.buttonStyle(.plain).accessibilityIdentifier("life.trusted")
          }
          // §6#110 (owner 2026-11-21): 暂停 AI 付款 moved here from 设置 (one place). Same SafetyPanel, same two confirmations.
          if s.isMainnet || s.wallet != nil {
            VStack(alignment: .leading, spacing: KP.Space.headGap) {
              SectionHead(title: T("暂停 AI 付款", "Pause AI payments"))
              SafetyPanel(s: s, part: .actions).frame(maxWidth: .infinity, alignment: .leading)   // t1245 U24: one card, no glass-in-glass
            }.accessibilityElement(children: .contain).accessibilityIdentifier("life.pause")
          }
          VStack(alignment: .leading, spacing: KP.Space.headGap) {
          SectionHead(title: T("生活账本", "Life ledger"), link: txs.isEmpty ? nil : (showAll ? T("收起", "Less") : T("全部", "All")), linkID: "life.all") { withAnimation(Brand.spring) { showAll.toggle() } }
          VStack(spacing: 0) {
            if txs.isEmpty { VStack(spacing: 8) { Image(systemName: "sparkles").font(.title2).foregroundStyle(MK.eyebrow); Text(T("AI 付款的每一笔都会分类记录在这里", "Every AI payment is sorted and recorded here")).font(.subheadline).foregroundStyle(.secondary) }.frame(maxWidth: .infinity).padding(.vertical, 26) }
            let shown = Array(txs.prefix(showAll ? 200 : 4))
            ForEach(Array(shown.enumerated()), id: \.offset) { i, t in
              if i > 0 { Rectangle().fill(MK.rowLine).frame(height: 1) }
              Button { picked = t } label: { LifeLedgerRow(t: t, c: s.category(t), agent: s.agentName(t)) }.buttonStyle(.plain).accessibilityIdentifier("life.tx.\(i)")
            }
          }.glass()
          }
        }.padding(.horizontal, KP.Space.page).padding(.bottom, 132)
      }
      .background(MockBG()).refreshable { await m.refresh() }
      .toolbar(.hidden, for: .navigationBar)
      .alert(holds.msg ?? "", isPresented: Binding(get: { holds.msg != nil }, set: { if !$0 { holds.msg = nil } })) { Button(T("好", "OK")) {} }   // hold-cancel result outlives the card
      .task { await PendingApprovalsBlock.load(s) }   // t1245: the cards used to load themselves on appear; same calls, now here
      .onReceive(NotificationCenter.default.publisher(for: .kpShowSiri)) { _ in siriPhrases = true }
      .onAppear { openStagedLimits(nil) }
      .onReceive(NotificationCenter.default.publisher(for: Notification.Name("kpNeedAILimits"))) { note in
        openStagedLimits(note.object as? AIConnect)
      }
      .onChange(of: showAILimits) { open in
        if open || AIConnect.payHandedOff { AIConnect.payHandedOff = open ? AIConnect.payHandedOff : false; return }
        if AIConnect.pendingPayRequest != nil { AIConnect.pendingPayRequest = nil; AIConnect.pendingAmounts = nil }
      }
      .sheet(isPresented: $siriPhrases) { SiriPhrasesSheet().presentationDetents([.medium, .large]) }
      .navigationDestination(isPresented: Binding(get: { tab == .agents }, set: { if !$0 && tab == .agents { tab = .life } })) { AgentsTab(s: s, embedded: true, limitConnect: $limitConnect, showAILimits: $showAILimits) }
      .navigationDestination(isPresented: $showAILimits) {
        MainLimitsView(s: s, scope: .ai, connectName: limitConnect?.displayName, onAuthorized: {
          if let id = AIConnect.pendingPayRequest, ConnectApproval.validId(id), AIConnect.pendingAmounts != nil {
            AIConnect.payHandedOff = true
            AIConnect.pendingPayRequest = nil
            m.connectReq = ConnectReq(id: id)
          } else if let t = limitConnect, t != .siri { handoff = ConnectHandoffItem(target: t) }   // t1254: explain first, the owner taps to go
          else { AIConnect.resumeArmed = true; limitConnect?.launch(m) }
        })
        .sheet(item: $handoff) { h in ConnectHandoffSheet(item: h).environmentObject(m) }
      }
      .sheet(item: $picked) { t in TxDetail(t: t, explorer: s.explorer, agentName: s.agentName(t), category: s.category(t)) }
      .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in picked = nil }
    }
  }
  func openStagedLimits(_ target: AIConnect?) {
    let chosen = target ?? AIConnect.pendingLimitTarget
    guard let chosen else { return }
    limitConnect = chosen
    showAILimits = true
    AIConnect.pendingLimitTarget = nil
  }
  @ViewBuilder func summary(_ totals: [(LifeCategory, Int64)]) -> some View {
    HStack(spacing: 18) {
      SpendRing(segs: LifeLedger.ring(totals.isEmpty ? [(.other, 1)] : totals).map { totals.isEmpty ? ($0.0, 0, 0) : $0 }, total: totals.reduce(0) { $0 + $1.1 })
        .background(Circle().stroke(.white.opacity(0.07), lineWidth: 10.5).frame(width: 101, height: 101))
      VStack(spacing: 0) {
        ForEach(Array((totals.isEmpty ? LifeCategory.allCases.prefix(5).map { ($0, Int64(0)) } : Array(totals.prefix(5))).enumerated()), id: \.offset) { _, cv in
          let (c, v) = cv
          HStack(spacing: 0) { RoundedRectangle(cornerRadius: 3).fill(Color(hex: c.hex)).frame(width: 8, height: 8).padding(.trailing, 7); Text(T(c.zh, c.en)).foregroundStyle(MK.legend); Spacer(); Text(dollars(v)).fontWeight(.bold).foregroundStyle(.white) }
            .font(.system(size: 13)).padding(.vertical, 2.5)
            .accessibilityElement(children: .ignore).accessibilityLabel("\(T(c.zh, c.en)) \(dollars(v))").accessibilityIdentifier("life.cat.\(c.rawValue)")
        }
      }
    }.padding(.vertical, 16).padding(.horizontal, 18).glass()
  }
}

// MARK: - Celebration (m.html .cel): full-screen dark-teal veil, ripples, streak particles, the paying orb, rolling amount, cheer pill.

struct CelebrationView: View {
  let t: Tx; let s: WalletState; let open: () -> Void; let close: () -> Void
  @Environment(\.accessibilityReduceMotion) private var rmEnv; private var rm: Bool { rmEnv || KPStill.on }
  @State private var start = Date()
  var body: some View {
    let name = s.agentName(t), cat = s.category(t)
    TimelineView(.animation(paused: rm)) { tl in
      let ct = rm ? 1.0 : min(3, tl.date.timeIntervalSince(start))
      let k = min(1, ct / 0.55), e = 1 - pow(1 - k, 3)
      GeometryReader { g in
        let cx = g.size.width / 2, cy = g.size.height * 0.39
        ZStack {
          Rectangle().fill(.ultraThinMaterial).environment(\.colorScheme, .dark)
          RadialGradient(colors: [Color(hex: 0x0D3B33).opacity(0.93), Color(hex: 0x05040C).opacity(0.95)], center: UnitPoint(x: 0.5, y: 0.4), startRadius: 0, endRadius: g.size.height * 0.36)
          if !rm { Canvas { c, _ in
            for j in 0..<3 { let rr = max(0, ct * 1.4 - Double(j) * 0.15) * 520 / 2; let op = max(0.18, 0.6 - ct * 0.3)
              c.stroke(Path(ellipseIn: CGRect(x: cx - rr, y: cy - rr, width: rr * 2, height: rr * 2)), with: .color(MK.cyan.opacity(op)), lineWidth: 2 - Double(j) * 0.5) }
            let cols = [MK.green, MK.cyan, Color(hex: 0xA855F7), Color(hex: 0xFF2D95), Color(hex: 0xFFD60A)]
            for i in 0..<110 { let a = Double(i) * 2.399, z = Double(i % 3), d = (60 + Double((i * 53) % 260)) * e * (0.6 + z * 0.3)
              let len = (1 - k) * 40 + 6, sz = 1.5 + z * 1.5, col = cols[i % 5]
              let x = cx + cos(a) * d, y = cy + sin(a) * d + ct * ct * 40 * (z + 1)
              var cc = c; cc.opacity = (0.5 + z * 0.25) * max(0, 1 - max(0, ct - 1.8)); cc.translateBy(x: x, y: y); cc.rotate(by: .radians(a + .pi))
              cc.addFilter(.shadow(color: col, radius: 3 + z * 2))
              cc.fill(Path(roundedRect: CGRect(x: 0, y: -sz / 2, width: len, height: sz), cornerRadius: sz / 2), with: .linearGradient(Gradient(colors: [col, col.opacity(0)]), startPoint: .zero, endPoint: CGPoint(x: len, y: 0))) }
          }.allowsHitTesting(false) }
          Circle().fill(RadialGradient(colors: [MK.green.opacity(0.33), .clear], center: .center, startRadius: 0, endRadius: 65)).frame(width: 200, height: 200).position(x: cx, y: cy)
          AgentLogo(name: name, phase: .online, size: 92).scaleEffect(0.5 + 0.5 * e).position(x: cx, y: cy)
          VStack(spacing: 0) {
            Text(T("\(name) 帮你付了 \(t.merchantName)", "\(name) paid \(t.merchantName) for you")).font(.system(size: 15)).foregroundStyle(.white.opacity(0.73)).accessibilityIdentifier("celebrate.title")
            Text(String(format: "%.2f", Double(t.amount) / 1_000_000 * min(1, ct / 0.6)) + " USDC").font(.system(size: 68, weight: .heavy).monospacedDigit()).kerning(-2)
              .foregroundStyle(LinearGradient(colors: [MK.green, MK.cyan], startPoint: .leading, endPoint: .trailing)).shadow(color: MK.green.opacity(0.4), radius: 20)
              .lineLimit(1).minimumScaleFactor(0.5).accessibilityLabel(money2(t.amount))
            Text(Cheer.line(id: t.id, chinese: Loc.isChinese) + " ✦").font(.system(size: 16, weight: .bold)).foregroundStyle(Color(hex: 0xFFD60A))
              .padding(.horizontal, 20).padding(.vertical, 9)
              .background(LinearGradient(colors: [Color(hex: 0xFFD60A).opacity(0.2), Color(hex: 0xFF9F0A).opacity(0.13)], startPoint: .leading, endPoint: .trailing), in: Capsule())
              .overlay(Capsule().strokeBorder(Color(hex: 0xFFD60A).opacity(0.33), lineWidth: 1))
              .opacity(rm ? 1 : min(1, max(0, (ct - 0.4) * 4))).padding(.top, 12).accessibilityIdentifier("celebrate.cheer")
          }.frame(width: g.size.width).position(x: cx, y: cy + 82 + 75)
          Button { open() } label: { Text(T("已记入「\(cat.zh)」· 查看收据", "Filed under \(cat.en) · View receipt")).font(.system(size: 13)).foregroundStyle(.white.opacity(0.6)).padding(12) }
            .accessibilityLabel(T("查看收据", "View receipt")).position(x: cx, y: g.size.height - 110)
        }
      }
    }
    .ignoresSafeArea()
    .contentShape(Rectangle()).onTapGesture { close() }
    .onAppear { start = Date(); CelebrationHaptics.play() }
  }
}

enum CelebrationHaptics {
  static func play() {
    Haptics.success()
    if UIAccessibility.isReduceMotionEnabled { return }
    for (i, d) in [0.12, 0.22, 0.34].enumerated() { DispatchQueue.main.asyncAfter(deadline: .now() + d) { UIImpactFeedbackGenerator(style: i == 2 ? .rigid : .soft).impactOccurred(intensity: 1 - Double(i) * 0.25) } }
  }
}

// MARK: - Page 2 「钱包」 (m.html .card / .acts / limits / pause+security)

/// Balance card: Kipurse · Base·USDC, big dollars + small cents, monthly AI spend, wallet address (t1143u: same eye as the balance — hidden is head…tail, open is the full two-line address) with one-tap copy of the full address, 已保护.
/// Hidden balance never looks like 0 (dots + "已隐藏（不是 0）"); the eye and Face ID reveal are unchanged.
struct WalletCard: View {
  let s: WalletState
  @EnvironmentObject var m: AppModel
  @Environment(\.accessibilityReduceTransparency) private var rt
  @State private var copiedWallet = false
  var body: some View {
    let sh = RoundedRectangle(cornerRadius: KP.Radius.hero, style: .continuous)
    let addr = s.wallet ?? s.raw["setup"]?["wallet"]?.string ?? ""
    let parts = MoneyText.amount(s.balance).split(separator: ".", maxSplits: 1).map(String.init)   // t1245 U26: 2 decimals
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(T("启付钱包", "Kipurse wallet")).font(.system(size: 17, weight: .bold)).accessibilityIdentifier("balance.label")
        Spacer()
        BalanceEyeButton(font: .footnote).colorScheme(.dark)
      }
      if m.balanceRevealed {
        (Text(groupThousands(parts[0])).font(.system(size: 48, weight: .heavy)).kerning(-1.5)
          + Text("." + (parts.count > 1 ? parts[1] : "00") + " USDC").font(.system(size: 22, weight: .heavy)).foregroundColor(.white.opacity(0.67)))
        .lineLimit(1).minimumScaleFactor(0.5).padding(.top, 16)
        .accessibilityLabel(MoneyText.usdc(s.balance)).accessibilityIdentifier("balance.amount")
        .modifier(RollingNumber(value: Double(s.balance))).animation(Brand.spring, value: s.balance)
        HStack(spacing: 6) {   // t991: rate moved out of the crowded header
          Text(T("本月 AI 已花 \(dollars(s.spentThisMonth()))", "AI spent \(dollars(s.spentThisMonth())) this month"))
          Text("·")
          Text(T("1 USDC ≈ 1 美元", "1 USDC ≈ US$1")).accessibilityIdentifier("balance.unit")
        }.font(.system(size: 13, weight: .medium)).foregroundStyle(.white.opacity(0.72)).lineLimit(1).minimumScaleFactor(0.8)
      } else {
        Text(BalanceMask.dots).font(.system(size: 48, weight: .heavy)).padding(.top, 16).onTapGesture { Task { await m.revealBalance() } }
          .accessibilityLabel(T("余额已隐藏", "Balance hidden")).accessibilityIdentifier("balance.masked")
        Button { Task { await m.revealBalance() } } label: { Label(T("已隐藏 · 点一下查看", "Hidden · tap to show"), systemImage: "eye.slash").font(.system(size: 13, weight: .semibold)) }
          .buttonStyle(.plain).foregroundStyle(.white.opacity(0.75)).accessibilityIdentifier("balance.hiddenHint")
      }
      Spacer(minLength: 0)
      if !addr.isEmpty {   // t1143u: same eye as the balance; hidden = AddressDisplay.short on one line; open = full two-line address; copy always the full address (t930: the only place)
        HStack(alignment: .center, spacing: 10) {   // one tap anywhere on the line copies; one accessibility element (no inner 复制 text exposed)
            Text(m.balanceRevealed ? Self.twoLines(addr) : AddressDisplay.short(addr)).font(.system(size: 13, design: .monospaced)).foregroundStyle(.white.opacity(0.78))
              .multilineTextAlignment(.leading).lineLimit(m.balanceRevealed ? nil : 1).fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)
            ZStack(alignment: .trailing) {   // width fixed by the longer label so the address never re-wraps when it flips to 已复制
              Label(T("已复制", "Copied"), systemImage: "checkmark").hidden()
              Label(copiedWallet ? T("已复制", "Copied") : T("复制", "Copy"), systemImage: copiedWallet ? "checkmark" : "doc.on.doc")
            }.font(.system(size: 13, weight: .semibold)).lineLimit(1).fixedSize().foregroundStyle(.white)
        }.padding(.top, 14).contentShape(Rectangle()).transaction { $0.animation = nil }
        .onTapGesture { copyWallet(addr) }   // always the full address, hidden or shown
        .accessibilityElement(children: .ignore).accessibilityAction { copyWallet(addr) }
        .accessibilityLabel(copiedWallet ? T("钱包地址已复制", "Wallet address copied") : T("复制钱包地址", "Copy wallet address"))
        .accessibilityValue(m.balanceRevealed ? addr : AddressDisplay.short(addr)).accessibilityAddTraits(.isButton).accessibilityIdentifier("wallet.copyWallet")
      }
      HStack {
        Spacer()
        // t1245 (§6#115 U38): a wallet that is not open yet (no deposit) is grey 「未开户」, never green 「已保护」.
        let notOpen = !s.active || (s.balance == 0 && !s.ledger.contains { $0.kind == "deposit" })
        Text(s.allAIPaused ? T("● AI 已暂停", "● AI paused") : notOpen ? T("● 未开户", "● Not open yet") : T("● 已保护", "● Protected")).font(.system(size: 13))
          .foregroundStyle(s.allAIPaused ? Color(hex: 0xFF6B88) : notOpen ? Color.white.opacity(0.55) : MK.green).accessibilityIdentifier("wallet.protection")
      }.padding(.top, 8)
    }
    .foregroundStyle(.white).padding(22).frame(minHeight: 196)
    .background {
      ZStack {
        sh.fill(LinearGradient(stops: [.init(color: Color(hex: 0x1A103D), location: 0), .init(color: Color(hex: 0x3B1D8F), location: 0.45), .init(color: Color(hex: 0x0E7490), location: 1)], startPoint: .topLeading, endPoint: .bottomTrailing))
        if !rt { sh.fill(LinearGradient(stops: [.init(color: .clear, location: 0.3), .init(color: .white.opacity(0.13), location: 0.45), .init(color: .clear, location: 0.6)], startPoint: UnitPoint(x: 0, y: 0.2), endPoint: UnitPoint(x: 1, y: 0.8))); HeroSheen().clipShape(sh) }
      }
    }
    .overlay(KPGlass.rim(sh, dark: true, intense: true))
    .overlay(sh.strokeBorder(LinearGradient(colors: [.white.opacity(0.22), .clear], startPoint: .top, endPoint: .center), lineWidth: 0.8))
    .shadow(color: Color(hex: 0x5B2CFF).opacity(0.38), radius: 30, y: 24)
    .shadow(color: Color(hex: 0x22D3EE).opacity(0.12), radius: 18, y: 10)
    .accessibilityElement(children: .contain)
  }
  private func copyWallet(_ a: String) { UIPasteboard.general.string = a; Haptics.success(); copiedWallet = true }
  /// t1133u: the whole address on two even lines (21 + 21 characters), nothing left out.
  static func twoLines(_ a: String) -> String { a.count == 42 ? String(a.prefix(21)) + "\n" + String(a.suffix(21)) : a }
  func groupThousands(_ s: String) -> String { var out = ""; for (i, ch) in s.reversed().enumerated() { if i > 0 && i % 3 == 0 { out.append(",") }; out.append(ch) }; return String(out.reversed()) }
}

/// Per-agent limits card: the four characters with today's spend against the wallet's daily limit (the limit the owner signed).
/// t1245 (§6#115 U16/U17): ONE source for the AI spending limit (this page and the AI 付款和花费 sheet both use `policy`);
/// not set = one plain sentence, and each AI shows only what it spent today (no "/ 0 USDC").
struct AgentLimitsCard: View {
  let s: WalletState
  @EnvironmentObject var m: AppModel
  @ObservedObject private var allow = AllowanceStore.shared
  /// The saved AI policy; else the overall AI limit the server lists with the AI requests. nil = not set.
  @MainActor static func policy(_ s: WalletState, demo: Bool = false) -> AISpendLimits.Saved? { AIConnect.saved(in: s, demo: demo) ?? AllowanceStore.shared.overallAtomic }
  @MainActor static func policyLine(_ s: WalletState, demo: Bool = false) -> String {
    guard let g = policy(s, demo: demo) else { return T("还没设置 AI 花钱上限", "AI spending limits not set yet") }
    let single = AnswerRules.format(g.single), daily = AnswerRules.format(g.daily), total = AnswerRules.format(g.term)   // limits = the owner's own numbers, as typed
    return T("每笔 \(single) · 每天 \(daily) · 总额 \(total) USDC", "\(single) per payment · \(daily) a day · \(total) total (USDC)")
  }
  var body: some View {
    let agents = s.lifeAgents(), daily = Self.policy(s, demo: m.demo != nil)?.daily ?? 0
    VStack(spacing: 0) {
      ForEach(agents) { a in
        let spent = s.txs.filter { !$0.failed && s.agentName($0) == a.name && ($0.date.map(Calendar.current.isDateInToday) ?? false) }.reduce(Int64(0)) { $0 + $1.amount }
        let frac = daily > 0 ? min(1, Double(spent) / Double(daily)) : 0
        let col = Color(hex: Orb.palettes[a.hue][3])
        HStack(spacing: 10) {
          AgentLogo(name: a.name, phase: a.phase, size: 28)
          VStack(spacing: 5) {
            HStack { Text(a.name).font(.system(size: 14, weight: .bold)); Spacer()
              Text(a.phase == .paused ? T("已暂停", "Paused") : a.phase == .offline ? T(AgentPhase.offline.zh, AgentPhase.offline.en)
                   : daily > 0 ? T("\(MoneyText.amount(spent)) / \(AnswerRules.format(daily)) USDC 每天", "\(MoneyText.amount(spent)) / \(AnswerRules.format(daily)) USDC a day") : T("今天花了 \(MoneyText.usdc(spent))", "Spent today \(MoneyText.usdc(spent))"))
                .font(.system(size: 14)).foregroundStyle(.white.opacity(0.6)).lineLimit(1).minimumScaleFactor(0.85) }
            GeometryReader { g in ZStack(alignment: .leading) { Capsule().fill(.white.opacity(0.07)); Capsule().fill(col).frame(width: max(0, g.size.width * frac)).shadow(color: col, radius: 4) } }.frame(height: 5)
          }
        }.padding(.vertical, 6).accessibilityElement(children: .combine).accessibilityIdentifier("wallet.limit.\(a.id)")
      }
      Rectangle().fill(MK.rowLine).frame(height: 1).padding(.vertical, 6)
      VStack(alignment: .leading, spacing: 3) {
        HStack { Text(AgentLimitsCard.policyLine(s, demo: m.demo != nil)).font(.system(size: 12, weight: .semibold).monospacedDigit()).accessibilityIdentifier("caps.values")
          Spacer(); if m.limitsUpdated != nil { Label(L("已更新"), systemImage: "checkmark.circle.fill").font(.caption2.weight(.bold)).foregroundStyle(MK.green).accessibilityIdentifier("caps.updated") } }
        Text(T("今天已花 \(MoneyText.usdc(s.spentToday)) · 本期已花 \(MoneyText.usdc(s.spentTerm))", "Spent today \(MoneyText.usdc(s.spentToday)) · this term \(MoneyText.usdc(s.spentTerm))")).font(.system(size: 11).monospacedDigit()).foregroundStyle(.white.opacity(0.5)).accessibilityIdentifier("caps.spent")
        if let a = s.capStart, let e = s.capEnd { Text(Mainnet.termRange(a, e)).font(.system(size: 11).monospacedDigit()).foregroundStyle(.white.opacity(0.4)).accessibilityIdentifier("caps.term") }
        Text(T("超出上限时，发到手机用 Face ID 同意", "Over the limit? Your phone asks for Face ID")).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).accessibilityIdentifier("caps.explain")
      }.frame(maxWidth: .infinity, alignment: .leading)
    }.padding(.horizontal, 16).padding(.vertical, 8).glass()
  }
}

/// t1066u: list rows use the same clear transparent glass wash as cards (no frost blur).
struct GlassRowBG: View {
  @Environment(\.accessibilityReduceTransparency) private var rt
  @Environment(\.colorScheme) private var cs
  var body: some View {
    if rt || cs == .light { Color(uiColor: .secondarySystemGroupedBackground) }
    else {
      ZStack {
        Color.white.opacity(0.045)
        LinearGradient(
          colors: [Color.white.opacity(0.09), Color(hex: 0x7C3AED).opacity(0.06), Color.clear, Color(hex: 0x22D3EE).opacity(0.05)],
          startPoint: .topLeading, endPoint: .bottomTrailing)
      }
    }
  }
}
func money2(_ atomic: Int64) -> String { MoneyText.usdc(atomic) }   // t1245: the one money rule


/// t856: each AI's own official logo (downloaded from its brand kit, used unaltered) on a dark disc with a soft glow in its brand colour.
/// Active (online/paying): the glow breathes (and a light ring sweeps while paying). Not connected / paused: dim, grey, static.
/// The logo artwork itself is never animated or recoloured; only the glow behind it. Reduce Motion = static glow.
/// Muse (Meta): official Muse app icon from muse.ai/images/landing/brand/muse-app-icon.svg (t857).
/// t1060: shared glass bead (build-35 soft refraction rim, no hard stroke). Used by welcome orbit + AI 生活.
struct AgentGlassBead: View {
  let asset: String
  var size: CGFloat = 44
  var tilt = true
  var body: some View {
    ZStack {
      AgentGlassBead.glass(size: size)
      Image(asset).resizable().interpolation(.high).scaledToFit()
        .frame(width: size * 0.62, height: size * 0.62)
        .clipShape(Circle())
        .rotation3DEffect(tilt ? .degrees(-9) : .degrees(0), axis: (x: 0.25, y: 1, z: 0), perspective: 0.25)
        .offset(x: tilt ? -size * 0.015 : 0, y: tilt ? size * 0.025 : 0)
      Circle().fill(RadialGradient(stops: [
        .init(color: .clear, location: 0.35),
        .init(color: Color(hex: 0x111226).opacity(0.12), location: 0.62),
        .init(color: Color(hex: 0x080A18).opacity(0.65), location: 0.92),
        .init(color: MK.cyan.opacity(0.12), location: 1)
      ], center: .center, startRadius: 0, endRadius: size * 0.51))
      AgentGlassBead.reflections(size: Double(size))
    }
    .frame(width: size, height: size).clipShape(Circle())
    .mask {
      Circle().fill(RadialGradient(stops: [
        .init(color: .white, location: 0.79),
        .init(color: .white.opacity(0.82), location: 0.9),
        .init(color: .clear, location: 1)
      ], center: .center, startRadius: 0, endRadius: size * 0.5))
    }
  }
  static func glass(size: CGFloat) -> some View {
    Circle().fill(RadialGradient(stops: [
      .init(color: Color(hex: 0xB9D9EB).opacity(0.72), location: 0),
      .init(color: Color(hex: 0x5B659B).opacity(0.55), location: 0.28),
      .init(color: Color(hex: 0x292641).opacity(0.78), location: 0.62),
      .init(color: Color(hex: 0x0D142B).opacity(0.92), location: 0.85),
      .init(color: MK.cyan.opacity(0.62), location: 1)
    ], center: UnitPoint(x: 0.28, y: 0.22), startRadius: 0, endRadius: max(size * 1.02, 1)))
      .overlay {
        Circle().fill(LinearGradient(colors: [Brand.accentHi.opacity(0.16), .clear, MK.cyan.opacity(0.22)], startPoint: .topLeading, endPoint: .bottomTrailing))
      }
  }
  static func reflections(size: Double) -> some View {
    ZStack {
      Ellipse().fill(LinearGradient(colors: [.white.opacity(0.72), .white.opacity(0.08)], startPoint: .top, endPoint: .bottom))
        .frame(width: size * 0.62, height: size * 0.27)
        .rotationEffect(.degrees(-30)).blur(radius: 0.5)
        .offset(x: -size * 0.13, y: -size * 0.29)
      Ellipse().fill(.white.opacity(0.95))
        .frame(width: size * 0.18, height: size * 0.08)
        .rotationEffect(.degrees(-35)).blur(radius: 0.3)
        .offset(x: -size * 0.24, y: -size * 0.30)
      Ellipse().fill(MK.cyan.opacity(0.6))
        .frame(width: size * 0.16, height: size * 0.48)
        .rotationEffect(.degrees(38)).blur(radius: 2.4)
        .offset(x: size * 0.30, y: size * 0.13)
      Ellipse().fill(.white.opacity(0.30))
        .frame(width: size * 0.13, height: size * 0.36)
        .rotationEffect(.degrees(28)).blur(radius: 2)
        .offset(x: -size * 0.34, y: size * 0.02)
      Ellipse().fill(MK.cyan.opacity(0.48)).frame(width: size * 0.31, height: size * 0.09)
        .rotationEffect(.degrees(-25)).blur(radius: 1.7)
        .offset(x: size * 0.13, y: size * 0.33)
    }
  }
}

/// t1062/t1063: life-page (and shared) logo = EXACT welcome AgentGlassBead recipe.
/// Connected (online/paying) + motion OK → self-rotation + particle halo.
/// Offline/paused/idle or Reduce Motion → static glass bead (same as AIWalletHero).
struct AgentLogo: View {
  let name: String; let phase: AgentPhase; var size: CGFloat = 28; var still = false
  @Environment(\.accessibilityReduceMotion) private var rmEnv
  private var rm: Bool { rmEnv || KPStill.on || CommandLine.arguments.contains("-kpReduceMotion") }
  static func key(_ n: String) -> String { let l = n.lowercased(); return ["muse", "grok", "claude", "siri"].first { l.contains($0) } ?? l }
  static func asset(_ n: String) -> String? { switch key(n) { case "grok": return "agent-grok"; case "claude": return "agent-claude"; case "siri": return "agent-siri"; case "muse": return "agent-muse"; default: return nil } }
  static func glow(_ n: String) -> Color { switch key(n) { case "grok": return Color(hex: 0xE8E8FF); case "claude": return Color(hex: 0xD97757); case "siri": return Color(hex: 0x8A5CFF); case "muse": return Color(hex: 0x0082FB); default: return Color(hex: 0xFF8A5B) } }
  static func scale(_ n: String) -> CGFloat { switch key(n) { case "siri": return 0.86; case "muse": return 0.8; default: return 0.58 } }   // fallback Orb only; glass bead uses fixed 0.62 inset
  var off: Bool { phase == .offline || phase == .paused }
  /// t1062: spin/halo only when agent is lit (接通且在线/付款中); Reduce Motion / still → none
  var live: Bool { phase.isLit && !rm && !still }
  var body: some View {
    let col = AgentLogo.glow(name)
    TimelineView(.animation(minimumInterval: 1 / 20, paused: !live)) { tl in
      let t = live ? tl.date.timeIntervalSinceReferenceDate : 0
      ZStack {
        if live { ConnectedBeadHalo(size: size, time: t, color: col) }
        // Welcome-page soft cyan aura only — no hard stroke, no brand ring (t1063)
        Circle().fill(MK.cyan.opacity(live ? 0.22 : (off ? 0.08 : 0.15))).frame(width: size + 11, height: size + 11).blur(radius: 9)
        if phase == .paying && live {
          Circle().trim(from: 0, to: 0.25).stroke(col, style: StrokeStyle(lineWidth: 1.5, lineCap: .round)).rotationEffect(.degrees(t * 220)).frame(width: size + 3, height: size + 3)
        }
        if let a = AgentLogo.asset(name) {
          AgentGlassBead(asset: a, size: size, tilt: true)   // t1060/t1063: identical bead recipe as AIWalletHero
            .rotationEffect(.degrees(live ? t * 28 : 0))     // t1062: 自转 when connected
        } else {
          Orb(phase: off ? .paused : .online, hue: Orb.hue(name), size: size * 0.92, still: true)
        }
      }.frame(width: size + 22, height: size + 22)
    }.accessibilityHidden(true).accessibilityIdentifier("agent.logo.\(name.lowercased())")
  }
}

/// t1062: particle halo / glow around a connected glass bead (skipped under Reduce Motion via AgentLogo.live).
struct ConnectedBeadHalo: View {
  let size: CGFloat; let time: Double; let color: Color
  var body: some View {
    Canvas { ctx, sz in
      let c = CGPoint(x: sz.width / 2, y: sz.height / 2)
      let r = Double(size) * 0.60
      ctx.fill(Path(ellipseIn: CGRect(x: c.x - size * 0.72, y: c.y - size * 0.72, width: size * 1.44, height: size * 1.44)),
               with: .radialGradient(Gradient(colors: [color.opacity(0.28), MK.cyan.opacity(0.14), .clear]), center: c, startRadius: size * 0.28, endRadius: size * 0.78))
      for i in 0..<16 {
        let a = time * 1.55 + Double(i) * (.pi * 2 / 16)
        let wobble = 1 + 0.07 * sin(time * 2.8 + Double(i))
        let p = CGPoint(x: c.x + cos(a) * r * wobble, y: c.y + sin(a) * r * 0.94 * wobble)
        let s: CGFloat = i % 3 == 0 ? 2.8 : (i % 2 == 0 ? 1.8 : 1.2)
        let hue = (i % 2 == 0) ? MK.cyan : color
        ctx.fill(Path(ellipseIn: CGRect(x: p.x - s / 2, y: p.y - s / 2, width: s, height: s)),
                 with: .color(hue.opacity(0.45 + 0.40 * abs(sin(time * 2.2 + Double(i))))))
      }
    }
    .frame(width: size + 22, height: size + 22)
    .allowsHitTesting(false)
  }
}
