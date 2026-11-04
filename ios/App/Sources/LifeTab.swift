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

/// m.html .glass: 160° white 8%→2% gradient, 1px white 10% border, radius 24.
struct Glass: ViewModifier {
  var radius: CGFloat = 24
  @Environment(\.accessibilityReduceTransparency) private var rt
  @Environment(\.colorScheme) private var cs
  func body(content: Content) -> some View {
    let sh = RoundedRectangle(cornerRadius: radius, style: .continuous)
    content.background {
      if rt || cs == .light { sh.fill(Color(uiColor: .secondarySystemGroupedBackground)) }
      else { sh.fill(LinearGradient(colors: [.white.opacity(0.08), .white.opacity(0.02)], startPoint: UnitPoint(x: 0.33, y: 0), endPoint: UnitPoint(x: 0.67, y: 1))) }
    }.overlay(sh.strokeBorder(.white.opacity(cs == .light ? 0 : 0.10), lineWidth: 1))
  }
}
extension View { func glass(_ r: CGFloat = 24) -> some View { modifier(Glass(radius: r)) } }

// MARK: Agents — the four approved characters, always shown; state from real agent data.

struct LifeAgent: Identifiable { let id: String, name: String, phase: AgentPhase, hue: Int; var lastUsed: Date? = nil }

extension WalletState {
  var allAIPaused: Bool { if let b = raw["paused"]?.bool { return b }; return raw["paused"]?["active"]?.bool ?? false }
  static let fourAgents = ["Muse", "Grok", "Claude", "Siri"]   // t693: the owner's four real agents (Grok = Grok Bot) on the original orb characters (no brand art)
  /// Live agent for one of the four names: id, kind or name contains the key ("grok" matches "Grok Bot" / "grok-bot").
  func liveAgent(for name: String) -> JSONValue? { let key = name.lowercased(); return liveAgents.first { a in [a["id"]?.string, a["kind"]?.string, a["name"]?.string].compactMap { $0?.lowercased() }.contains { $0.contains(key) } } }
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
  @Environment(\.accessibilityReduceMotion) private var rm
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
        .saturation(grey ? 0.28 : 1).brightness(grey ? 0.04 : 0).opacity(grey ? 0.72 : 1)
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
      AgentLogo(name: a.name, phase: a.phase, size: 58).padding(.bottom, 7)   // t860: official logo
      Text(a.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white)
      HStack(spacing: 4) { Circle().fill(color).frame(width: 6, height: 6); Text(T(a.phase.zh, a.phase.en)).font(.system(size: 10.5, weight: .medium)) }.foregroundStyle(color).padding(.top, 1)
      if let s = seen, a.phase != .offline { Text(T(s.zh, s.en)).font(.system(size: 9.5)).foregroundStyle(.white.opacity(0.5)).lineLimit(1).minimumScaleFactor(0.8).padding(.top, 1) }
    }.frame(width: 78)
    .accessibilityElement(children: .ignore).accessibilityLabel("\(a.name), \(T(a.phase.zh, a.phase.en))\(seen.map { ", " + T($0.zh, $0.en) } ?? "")").accessibilityIdentifier("life.agent.\(a.id)")
  }
  var color: Color { switch a.phase { case .online: return MK.green; case .paying: return MK.cyan; case .paused, .idle, .offline: return .white.opacity(0.33) } }
}

/// Whole-dollar display for the summary ($486), like the mockup; rows keep two decimals.
func dollars(_ a: Int64) -> String { let v = Double(a) / 1_000_000; return (v >= 100 || v == v.rounded() ? String(Int(v.rounded())) : String(format: "%.2f", v)) + " USDC" }   // t927: one unit everywhere (USDC)

struct SpendRing: View {
  let segs: [(LifeCategory, Double, Double)]; let total: Int64
  @State private var drawn = false
  @Environment(\.accessibilityReduceMotion) private var rm
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
        .frame(width: 38, height: 38).background(col.opacity(0.13), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(col.opacity(0.31), lineWidth: 1))
      VStack(alignment: .leading, spacing: 1) {
        Text(t.friendlyTitle).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).lineLimit(1).accessibilityIdentifier(t.unnamed ? "life.unnamed" : "")
        Text("\(agent) · " + (t.unnamed ? shortAddr(t.payee) : T(c.zh, c.en)) + (t.date.map { " · " + LifeLedgerRow.when($0) } ?? "")).font(.system(size: 12)).foregroundStyle(.white.opacity(0.44)).lineLimit(1)
      }
      Spacer(minLength: 6)
      VStack(alignment: .trailing, spacing: 0) {
        Text("-" + AnswerRules.format2(t.amount)).font(.system(size: 15, weight: .bold).monospacedDigit()).foregroundStyle(t.failed ? .white.opacity(0.4) : .white).strikethrough(t.failed)
        if t.failed || t.pending { Chip(text: t.stateZh, color: t.stateColor) } else { Text("USDC").font(.system(size: 10, weight: .medium)).kerning(0.5).foregroundStyle(.white.opacity(0.33)) }
      }
    }.padding(.vertical, 10).padding(.horizontal, 14).contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(t.merchantName), \(agent), \(T(c.zh, c.en)), -\(AnswerRules.format2(t.amount)) USDC" + (t.failed || t.pending ? ", \(t.stateZh)" : ""))
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
      Text(title).font(.system(size: 34, weight: .heavy)).kerning(-0.6).foregroundStyle(.primary).accessibilityAddTraits(.isHeader).accessibilityIdentifier(id)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct SectionHead: View {
  let title: String; var link: String? = nil; var linkID = ""; var action: (() -> Void)? = nil
  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title).font(.system(size: 20, weight: .bold))
      Spacer()
      if let l = link, let a = action { Button(l) { Haptics.tap(); a() }.font(.system(size: 14, weight: .medium)).foregroundStyle(MK.link).accessibilityIdentifier(linkID) }
    }.padding(.horizontal, 2).padding(.top, 18).padding(.bottom, 8)
  }
}

struct LifeTab: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState; @Binding var tab: AppTab
  @State private var picked: Tx?
  @State private var showAll = false
  @State private var siriPhrases = false
  var monthName: String { let f = DateFormatter(); f.locale = Locale(identifier: Loc.isChinese ? "zh_CN" : "en_US"); f.dateFormat = Loc.isChinese ? "MMMM" : "MMM"; return f.string(from: Date()) }
  var body: some View {
    let agents = s.lifeAgents()
    let online = agents.filter { $0.phase == .online || $0.phase == .paying }.count
    let txs = s.txs.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    let totals = LifeLedger.monthTotals(txs.map { LifeItem(amount: $0.amount, date: $0.date, failed: $0.failed, category: s.category($0)) }, now: Date())
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          HStack(alignment: .bottom) {
            PageTitle(eyebrow: T("\(monthName) · \(online) 个 AI 在线打理", "\(monthName.uppercased()) · \(online) AI ON DUTY"), title: T("AI 生活", "AI Life"), id: "life.title")
            Button { Haptics.tap(); tab = .agents } label: { Image(systemName: "ellipsis").font(.system(size: 17, weight: .bold)).foregroundStyle(.white.opacity(0.6)).frame(width: 40, height: 40).background(.white.opacity(0.08), in: Circle()) }
              .accessibilityLabel(T("管理 AI", "Manage AI")).accessibilityIdentifier("life.manage").padding(.bottom, 4)
          }.padding(.top, 6)
          if false {   // t927: approvals have ONE place (钱包 → 待你批准); the tab badge points there
            Button { Haptics.tap(); tab = .home } label: {
              HStack(spacing: 10) { Image(systemName: "bell.badge.fill").symbolRenderingMode(.multicolor); Text(T("\(s.approvals.count) 个请求等你批准", "\(s.approvals.count) request\(s.approvals.count == 1 ? "" : "s") need you")).font(.subheadline.weight(.semibold)); Spacer(); Image(systemName: "chevron.right").foregroundStyle(.white.opacity(0.4)) }
                .padding(14).glass(18)
            }.buttonStyle(Pressable()).foregroundStyle(.primary).accessibilityIdentifier("life.approvals").padding(.top, 12)
          }
          HStack(spacing: 0) { ForEach(agents) { a in Button { Haptics.tap(); openAgentApp(a.id) } label: { OrbAgentCell(a: a) }.buttonStyle(Pressable()); if a.id != agents.last?.id { Spacer(minLength: 0) } } }
            .padding(.top, 16).padding(.bottom, 14)
          summary(LifeCategory.allCases.compactMap { c in totals.first { $0.0 == c } })
          SectionHead(title: T("生活账本", "Life ledger"), link: txs.isEmpty ? nil : (showAll ? T("收起", "Less") : T("全部", "All")), linkID: "life.all") { withAnimation(Brand.spring) { showAll.toggle() } }
          VStack(spacing: 0) {
            if txs.isEmpty { VStack(spacing: 8) { Image(systemName: "sparkles").font(.title2).foregroundStyle(MK.eyebrow); Text(T("AI 付的每一笔都会自动记在这里", "Every AI payment lands here, sorted for you")).font(.subheadline).foregroundStyle(.secondary) }.frame(maxWidth: .infinity).padding(.vertical, 26) }
            let shown = Array(txs.prefix(showAll ? 200 : 4))
            ForEach(Array(shown.enumerated()), id: \.offset) { i, t in
              if i > 0 { Rectangle().fill(MK.rowLine).frame(height: 1) }
              Button { picked = t } label: { LifeLedgerRow(t: t, c: s.category(t), agent: s.agentName(t)) }.buttonStyle(.plain).accessibilityIdentifier("life.tx.\(i)")
            }
          }.glass()
        }.padding(.horizontal, 20).padding(.bottom, 32)
      }
      .background(MockBG()).refreshable { await m.refresh() }
      .toolbar(.hidden, for: .navigationBar)
      .onReceive(NotificationCenter.default.publisher(for: .kpShowSiri)) { _ in siriPhrases = true }
      .sheet(isPresented: $siriPhrases) { SiriPhrasesSheet().presentationDetents([.medium, .large]) }
      .navigationDestination(isPresented: Binding(get: { tab == .agents }, set: { if !$0 && tab == .agents { tab = .life } })) { AgentsTab(s: s, embedded: true) }
      .sheet(item: $picked) { t in TxDetail(t: t, explorer: s.explorer, agentName: s.agentName(t)) }
      .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in picked = nil }
    }
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
  @Environment(\.accessibilityReduceMotion) private var rm
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

/// Balance card: Kipurse · Base·USDC, big dollars + small cents, monthly AI spend, short address, 已保护.
/// Hidden balance never looks like 0 (dots + "已隐藏（不是 0）"); the eye and Face ID reveal are unchanged.
struct WalletCard: View {
  let s: WalletState
  @EnvironmentObject var m: AppModel
  @Environment(\.accessibilityReduceTransparency) private var rt
  var body: some View {
    let sh = RoundedRectangle(cornerRadius: 26, style: .continuous)
    let parts = AnswerRules.format2(s.balance).split(separator: ".", maxSplits: 1).map(String.init)
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(T("启付钱包", "Kipurse wallet")).font(.system(size: 17, weight: .bold)).accessibilityIdentifier("balance.label")
        Spacer()
        Text(T("1 USDC ≈ 1 美元", "1 USDC ≈ US$1")).font(.system(size: 13, weight: .bold)).foregroundStyle(.white.opacity(0.67)).accessibilityIdentifier("balance.unit")
        BalanceEyeButton(font: .footnote).colorScheme(.dark).padding(.leading, 6)
      }
      if m.balanceRevealed {
        (Text(groupThousands(parts[0])).font(.system(size: 48, weight: .heavy)).kerning(-1.5)
          + Text("." + (parts.count > 1 ? parts[1] : "00") + " USDC").font(.system(size: 22, weight: .heavy)).foregroundColor(.white.opacity(0.67)))
        .lineLimit(1).minimumScaleFactor(0.5).padding(.top, 16)
        .accessibilityLabel(AnswerRules.format2(s.balance) + " USDC").accessibilityIdentifier("balance.amount")
        .modifier(RollingNumber(value: Double(s.balance))).animation(Brand.spring, value: s.balance)
        Text(T("本月 AI 已花 \(dollars(s.spentThisMonth()))", "AI spent \(dollars(s.spentThisMonth())) this month")).font(.system(size: 13)).foregroundStyle(.white.opacity(0.67))
      } else {
        Text(BalanceMask.dots).font(.system(size: 48, weight: .heavy)).padding(.top, 16).onTapGesture { Task { await m.revealBalance() } }
          .accessibilityLabel(T("余额已隐藏", "Balance hidden")).accessibilityIdentifier("balance.masked")
        Button { Task { await m.revealBalance() } } label: { Label(T("已隐藏 · 点一下查看", "Hidden · tap to show"), systemImage: "eye.slash").font(.system(size: 13, weight: .semibold)) }
          .buttonStyle(.plain).foregroundStyle(.white.opacity(0.75)).accessibilityIdentifier("balance.hiddenHint")
      }
      Spacer(minLength: 0)
      HStack {
        Text(shortAddr4(s.wallet ?? s.raw["setup"]?["wallet"]?.string ?? "")).font(.system(size: 13)).kerning(2).foregroundStyle(.white.opacity(0.6))
        Spacer()
        Text(s.allAIPaused ? T("● AI 已暂停", "● AI paused") : T("● 已保护", "● Protected")).font(.system(size: 13)).foregroundStyle(s.allAIPaused ? Color(hex: 0xFF6B88) : MK.green)
      }
    }
    .foregroundStyle(.white).padding(22).frame(height: 200)
    .background {
      ZStack {
        sh.fill(LinearGradient(stops: [.init(color: Color(hex: 0x1A103D), location: 0), .init(color: Color(hex: 0x3B1D8F), location: 0.45), .init(color: Color(hex: 0x0E7490), location: 1)], startPoint: .topLeading, endPoint: .bottomTrailing))
        if !rt { sh.fill(LinearGradient(stops: [.init(color: .clear, location: 0.3), .init(color: .white.opacity(0.13), location: 0.45), .init(color: .clear, location: 0.6)], startPoint: UnitPoint(x: 0, y: 0.2), endPoint: UnitPoint(x: 1, y: 0.8))); HeroSheen().clipShape(sh) }
      }
    }
    .overlay(sh.strokeBorder(LinearGradient(colors: [.white.opacity(0.19), .clear], startPoint: .top, endPoint: .center), lineWidth: 1))
    .shadow(color: Color(hex: 0x5B2CFF).opacity(0.31), radius: 30, y: 24)
    .accessibilityElement(children: .contain)
  }
  func groupThousands(_ s: String) -> String { var out = ""; for (i, ch) in s.reversed().enumerated() { if i > 0 && i % 3 == 0 { out.append(",") }; out.append(ch) }; return String(out.reversed()) }
  func shortAddr4(_ a: String) -> String { a.count > 10 ? String(a.prefix(6)) + " ···· " + String(a.suffix(4)) : a }
}

/// Per-agent limits card: the four characters with today's spend against the wallet's daily limit (the limit the owner signed).
struct AgentLimitsCard: View {
  let s: WalletState
  @EnvironmentObject var m: AppModel
  var body: some View {
    let agents = s.lifeAgents(), daily = s.capDaily ?? 0
    VStack(spacing: 0) {
      ForEach(agents) { a in
        let spent = s.txs.filter { !$0.failed && s.agentName($0) == a.name && ($0.date.map(Calendar.current.isDateInToday) ?? false) }.reduce(Int64(0)) { $0 + $1.amount }
        let frac = daily > 0 ? min(1, Double(spent) / Double(daily)) : 0
        let col = Color(hex: Orb.palettes[a.hue][3])
        HStack(spacing: 10) {
          AgentLogo(name: a.name, phase: a.phase, size: 28)
          VStack(spacing: 5) {
            HStack { Text(a.name).font(.system(size: 14, weight: .bold)); Spacer()
              Text(a.phase == .paused ? T("已暂停", "Paused") : a.phase == .offline ? T("未连接", "Not connected") : "\(dollars(spent)) / \(dollars(daily)) " + T("每天", "a day")).font(.system(size: 14)).foregroundStyle(.white.opacity(0.6)) }
            GeometryReader { g in ZStack(alignment: .leading) { Capsule().fill(.white.opacity(0.07)); Capsule().fill(col).frame(width: max(0, g.size.width * frac)).shadow(color: col, radius: 4) } }.frame(height: 5)
          }
        }.padding(.vertical, 6).accessibilityElement(children: .combine).accessibilityIdentifier("wallet.limit.\(a.id)")
      }
      Rectangle().fill(MK.rowLine).frame(height: 1).padding(.vertical, 6)
      VStack(alignment: .leading, spacing: 3) {
        HStack { Text(L("每笔 \(Mainnet.whole(s.capSingle ?? 0)) · 每天 \(Mainnet.whole(s.capDaily ?? 0)) · 总额 \(Mainnet.whole(s.capTerm ?? 0)) USDC")).font(.system(size: 12, weight: .semibold).monospacedDigit()).accessibilityIdentifier("caps.values")
          Spacer(); if m.limitsUpdated != nil { Label(L("已更新"), systemImage: "checkmark.circle.fill").font(.caption2.weight(.bold)).foregroundStyle(MK.green).accessibilityIdentifier("caps.updated") } }
        Text(L("今天已花 \(AnswerRules.format(s.spentToday)) · 本期已花 \(AnswerRules.format(s.spentTerm))")).font(.system(size: 11).monospacedDigit()).foregroundStyle(.white.opacity(0.5)).accessibilityIdentifier("caps.spent")
        if let a = s.capStart, let e = s.capEnd { Text(Mainnet.termRange(a, e)).font(.system(size: 11).monospacedDigit()).foregroundStyle(.white.opacity(0.4)).accessibilityIdentifier("caps.term") }
        Text(T("超出上限时，发到手机用 Face ID 同意", "Over the limit? Your phone asks for Face ID")).font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).accessibilityIdentifier("caps.explain")
      }.frame(maxWidth: .infinity, alignment: .leading)
    }.padding(.horizontal, 16).padding(.vertical, 8).glass()
  }
}

/// Translucent row background for grouped lists (solid with Reduce Transparency / light look).
struct GlassRowBG: View {
  @Environment(\.accessibilityReduceTransparency) private var rt
  @Environment(\.colorScheme) private var cs
  var body: some View {
    if rt || cs == .light { Color(uiColor: .secondarySystemGroupedBackground) }
    else { LinearGradient(colors: [.white.opacity(0.08), .white.opacity(0.03)], startPoint: .top, endPoint: .bottom) }
  }
}
func money2(_ atomic: Int64) -> String { "\(AnswerRules.format2(atomic)) USDC" }


/// t856: each AI's own official logo (downloaded from its brand kit, used unaltered) on a dark disc with a soft glow in its brand colour.
/// Active (online/paying): the glow breathes (and a light ring sweeps while paying). Not connected / paused: dim, grey, static.
/// The logo artwork itself is never animated or recoloured; only the glow behind it. Reduce Motion = static glow.
/// Muse (Meta): official Muse app icon from muse.ai/images/landing/brand/muse-app-icon.svg (t857).
struct AgentLogo: View {
  let name: String; let phase: AgentPhase; var size: CGFloat = 28; var still = false
  @Environment(\.accessibilityReduceMotion) private var rm
  static func key(_ n: String) -> String { let l = n.lowercased(); return ["muse", "grok", "claude", "siri"].first { l.contains($0) } ?? l }
  static func asset(_ n: String) -> String? { switch key(n) { case "grok": return "agent-grok"; case "claude": return "agent-claude"; case "siri": return "agent-siri"; case "muse": return "agent-muse"; default: return nil } }
  static func glow(_ n: String) -> Color { switch key(n) { case "grok": return Color(hex: 0xE8E8FF); case "claude": return Color(hex: 0xD97757); case "siri": return Color(hex: 0x8A5CFF); case "muse": return Color(hex: 0x0082FB); default: return Color(hex: 0xFF8A5B) } }
  static func scale(_ n: String) -> CGFloat { switch key(n) { case "siri": return 0.86; case "muse": return 0.8; default: return 0.58 } }
  var off: Bool { phase == .offline || phase == .paused }
  var live: Bool { !off && !rm && !still }
  var body: some View {
    let col = AgentLogo.glow(name)
    TimelineView(.animation(minimumInterval: 1 / 20, paused: !live)) { tl in
      let t = live ? tl.date.timeIntervalSinceReferenceDate : 0
      let b = live ? (sin(t * 2 * .pi / 2.6) + 1) / 2 : 0.5
      ZStack {
        Circle().fill(col.opacity(off ? 0 : 0.18 + 0.22 * b)).frame(width: size * 1.5, height: size * 1.5).blur(radius: size * 0.28)
        Circle().fill(Color(hex: 0x14141C)).overlay(Circle().strokeBorder(col.opacity(off ? 0.12 : 0.35 + 0.3 * b), lineWidth: 1))
          .frame(width: size, height: size)
        if phase == .paying && live {
          Circle().trim(from: 0, to: 0.25).stroke(col, style: StrokeStyle(lineWidth: 1.5, lineCap: .round)).rotationEffect(.degrees(t * 220)).frame(width: size + 3, height: size + 3)
        }
        if let a = AgentLogo.asset(name) {
          Image(a).resizable().interpolation(.high).scaledToFit().frame(width: size * AgentLogo.scale(name), height: size * AgentLogo.scale(name))
            .clipShape(Circle()).saturation(off ? 0 : 1).opacity(off ? 0.45 : 1)
        } else {
          Orb(phase: off ? .paused : .online, hue: Orb.hue(name), size: size * 0.92, still: true)   // other (non-four) AIs: original orb
        }
      }.frame(width: size + 6, height: size + 6)
    }.accessibilityHidden(true).accessibilityIdentifier("agent.logo.\(name.lowercased())")
  }
}
