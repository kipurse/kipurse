import SwiftUI
import KipurseCore

/// t613: optional large-text simple mode (Settings switch). Home = three big buttons: [zh] .
enum SimpleMode { static let key = "kp.simpleMode" }

struct SimpleHome: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  @AppStorage(SimpleMode.key) private var simple = false
  @State private var sheet: String?
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: KP.Space.cardGap) {
          Button { Task { await m.revealBalance() } } label: {
            VStack(spacing: 6) {
              Text(T("余额", "Balance")).font(.title2.bold())
              Text(m.balanceRevealed ? AnswerRules.format(s.balance) : BalanceMask.dots).font(.system(size: 56, weight: .bold)).lineLimit(1).minimumScaleFactor(0.4).accessibilityIdentifier("simple.balance.amount")
              Text(T(Beginner.currencyZh, Beginner.currencyEn)).font(.title3).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, minHeight: 170).background(Brand.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: KP.Radius.card))
          }.buttonStyle(.plain).accessibilityIdentifier("simple.balance")
          big(T("充值", "Add money"), "plus.circle.fill", Brand.accent, "simple.topup") { sheet = "fund" }
          big(T("暂停 AI 付款", "Pause AI payments"), "pause.circle.fill", Brand.negative, "simple.pause") { sheet = "pause" }
          NavigationLink { SafetyTipsView() } label: { Label(T("安全小贴士", "Safety tips"), systemImage: "checkmark.shield").font(.title3) }.accessibilityIdentifier("simple.tips")
          NavigationLink { LostPhoneGuide() } label: { Label(T("手机丢了怎么办", "Lost your phone?"), systemImage: "iphone.slash").font(.title3) }.accessibilityIdentifier("simple.lostPhone")
          Button(T("切换到完整模式", "Switch to full mode")) { simple = false }.font(.title3).accessibilityIdentifier("simple.exit")
        }.padding(20)
      }.background(Brand.canvas).navigationTitle(T("启付", "Kipurse"))
    }
    .dynamicTypeSize(.xxxLarge)
    .sheet(item: Binding(get: { sheet.map { SheetID(id: $0) } }, set: { sheet = $0?.id })) { x in
      NavigationStack { ScrollView { Group { if x.id == "fund" { DepositView(s: s) } else { SafetyPanel(s: s) } }.padding(20) }
        .navigationTitle(x.id == "fund" ? T("充值", "Add money") : T("暂停", "Pause")) }.dynamicTypeSize(.xxxLarge)
    }
  }
  struct SheetID: Identifiable { let id: String }
  func big(_ t: String, _ icon: String, _ c: Color, _ id: String, _ a: @escaping () -> Void) -> some View {
    Button(action: a) { Label(t, systemImage: icon).font(.title.bold()).frame(maxWidth: .infinity, minHeight: 88).foregroundStyle(.white).background(c, in: RoundedRectangle(cornerRadius: KP.Radius.card)) }
      .buttonStyle(.plain).accessibilityIdentifier(id)
  }
}

/// Large-text recovery guide (free; no paid service).
struct LostPhoneGuide: View {
  var body: some View { RescueGuideView() }
}

/// No Coinbase account yet: required first step, plain steps and a clear link.
struct NoCoinbaseGuide: View {
  @Environment(\.openURL) private var openURL
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: KP.Space.cardGap) {
        Text(T("第 1 步：先开 Coinbase 账户", "Step 1: open a Coinbase account")).font(.title.bold()).accessibilityIdentifier("nocb.title")
        Text(T(Beginner.coinbaseWhyZh, Beginner.coinbaseWhyEn)).font(.title3).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("nocb.why")
        ForEach(Array(zip(Beginner.noAccountStepsZh, Beginner.noAccountStepsEn).enumerated()), id: \.offset) { i, p in
          HStack(alignment: .top, spacing: 12) { Text("\(i + 1)").font(.title2.bold()).frame(width: 40); Text(T(p.0, p.1)).font(.title3).fixedSize(horizontal: false, vertical: true) }
        }
        BigButton(T("去 Coinbase 注册", "Open Coinbase sign-up"), icon: "arrow.up.right.square") { openURL(Beginner.signUpURL) }.accessibilityIdentifier("nocb.signup")
      }.padding(20)
    }.background(Brand.canvas).dynamicTypeSize(.xxLarge)
  }
}

/// Guided setup (t1246): daily spend question only (removed what AI mostly buys), three SUGGESTED plans. Nothing pre-selected; picking fills the fields, which stay editable.
struct GuidedSetupCard: View {
  @Binding var single: String; @Binding var daily: String; @Binding var term: String; @Binding var days: String
  @State private var spend: Beginner.Spend?
  @State private var picked: Int? = Beginner.initialSelection
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(T("大概每天花多少？", "About how much a day?")).font(.headline)
      ForEach(Beginner.Spend.allCases, id: \.rawValue) { v in choice(T(Beginner.spendZh[v.rawValue], Beginner.spendEn[v.rawValue]) + " USDC", spend == v, "guided.spend\(v.rawValue)") { spend = v; picked = nil } }
      if let v = spend {
        Text(T("建议（选一个，或在下面自己填）", "Suggestions (pick one, or fill in your own below)")).font(.headline).padding(.top, 6)
        ForEach(Array(Beginner.plans(spend: v).enumerated()), id: \.offset) { i, p in
          choice(T("\(p.zh)：每笔 \(p.single) · 每天 \(p.daily) · 总额 \(p.term) USDC", "\(p.en): per payment \(p.single) · per day \(p.daily) · total \(p.term) USDC"), picked == i, "guided.plan\(i)") {
            picked = i; single = String(p.single); daily = String(p.daily); term = String(p.term); days = String(p.days) }
        }
      }
      Text(T("没有默认值：你不选，就什么都不会设置。", "No defaults: nothing is set until you choose.")).font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("guided.noDefault")
    }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 16).accessibilityElement(children: .contain).accessibilityIdentifier("guided")
  }
  func choice(_ t: String, _ on: Bool, _ id: String, _ a: @escaping () -> Void) -> some View {
    Button(action: a) { HStack { Image(systemName: on ? "largecircle.fill.circle" : "circle"); Text(t).multilineTextAlignment(.leading); Spacer() }.padding(12).frame(maxWidth: .infinity)
      .background(on ? Brand.accent.opacity(0.15) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: KP.Radius.control)) }
      .buttonStyle(.plain).accessibilityIdentifier(id).accessibilityValue(on ? "selected" : "not selected")
  }
}

/// t619: the user's OWN address (wallet, Coinbase wallet, phone approver) is shortened by default.
/// Full only after an explicit [zh] action. (Payee addresses are always shown in full elsewhere.)
struct OwnAddress: View {
  let address: String; var id: String = "own.addr"; var copyable = true
  @State private var full = false; @State private var copied = false
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(AddressDisplay.own(address, revealed: full)).font(.footnote.monospaced()).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier(id)   // t800: no textSelection so VoiceOver/UI tests see it; copy has its own button
      HStack(spacing: 14) {
        Button(full ? T("收起", "Hide") : T("显示完整地址", "Show full address")) { full.toggle() }.font(.footnote.weight(.semibold)).accessibilityIdentifier(id + ".reveal")
        if copyable { Button(copied ? T("已复制", "Copied") : T("复制", "Copy")) { UIPasteboard.general.string = address; copied = true }.font(.footnote.weight(.semibold)).accessibilityIdentifier(id + ".copy") }
      }
    }
  }
}

/// t620 / t1057: safety tips use the same KP body typography as other content pages (Legal/Help).
struct SafetyTipsView: View {
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: KP.Space.cardGap) {
        PageTitle(eyebrow: nil, title: T("安全小贴士", "Safety tips"), id: "tips.title")   // t1245 U28: same header as the other help pages
        ForEach(Array(zip(SafetyTips.zh, SafetyTips.en).enumerated()), id: \.offset) { i, p in
          HStack(alignment: .top, spacing: 12) {
            Image(systemName: "\(i + 1).circle.fill").font(.title2).symbolRenderingMode(.hierarchical).foregroundStyle(Brand.accent).accessibilityHidden(true)
            Text(T(p.0, p.1)).font(KP.Typo.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          }.frame(maxWidth: .infinity, alignment: .leading).padding(KP.Space.m).glass().accessibilityElement(children: .combine).accessibilityIdentifier("tips.\(i + 1)")
        }
        NavigationLink { LostPhoneGuide() } label: { Label(T("手机丢了怎么办", "Lost your phone?"), systemImage: "iphone.slash").font(KP.Typo.cardTitle) }.accessibilityIdentifier("tips.lostPhone")
      }.padding(.horizontal, KP.Space.page).padding(.bottom, 132)
    }.background(MockBG()).navigationBarTitleDisplayMode(.inline)
  }
}

/// One calm line shown in context.
struct TipLine: View { let zh: String; let en: String; let id: String
  var body: some View { Label(T(zh, en), systemImage: "checkmark.shield").font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier(id) } }
