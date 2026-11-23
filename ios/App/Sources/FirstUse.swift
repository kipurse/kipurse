import SwiftUI
import KipurseCore

/// First-use guide on the wallet home: three plain steps (AI limits, add money, connect an AI). Progress is real
/// (limits active, balance > 0, an AI connected); the user can hide it any time.
enum FirstUse {
  static let hiddenKey = "kp.firstUse.hidden"
  static var demoHidden = false   // demo / UI tests: remembered in memory (nothing persisted)
  static var hidden: Bool { demoHidden || UserDefaults.standard.bool(forKey: hiddenKey) }
  static func hide() { if DemoGuard.active { demoHidden = true; return }; UserDefaults.standard.set(true, forKey: hiddenKey) }
  static func reset() { UserDefaults.standard.removeObject(forKey: hiddenKey) }
  struct Progress: Equatable { let limits: Bool, money: Bool, ai: Bool; var done: Int { [limits, money, ai].filter { $0 }.count } }
  static func progress(_ s: WalletState) -> Progress { .init(limits: s.active, money: s.balance > 0, ai: !s.liveAgents.filter { $0["id"]?.string != "muse" && $0["kind"]?.string != "muse" }.isEmpty) }
}

struct FirstUseGuide: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState; @Binding var sheet: String?; @Binding var tab: AppTab
  @State private var hidden = FirstUse.hidden
  var body: some View {
    let p = FirstUse.progress(s)
    if !hidden && p.done < 3 {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .firstTextBaseline) {
          VStack(alignment: .leading, spacing: 2) {
            Text(T("3 步开始用", "Get started in 3 steps")).font(.title3.bold())
            Text(T("已完成 \(p.done)/3", "\(p.done) of 3 done")).font(.footnote.weight(.semibold)).foregroundStyle(Brand.accent).accessibilityIdentifier("guide.progress")
          }
          Spacer()
          Button(T("隐藏", "Hide")) { withAnimation(Brand.spring) { FirstUse.hide(); hidden = true } }.font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("guide.hide")
        }
        ProgressView(value: Double(p.done), total: 3).tint(Brand.accent)
        step(1, done: p.limits, icon: "gauge.with.dots.needle.33percent",
             title: T("AI 花钱上限", "AI spending limits"),
             body: T("开通时已设好：每笔 $\(AnswerRules.plain(s.capSingle ?? 0))，每天 $\(AnswerRules.plain(s.capDaily ?? 0))，总共 $\(AnswerRules.plain(s.capTerm ?? 0))。\(s.capDays.map { "有效期 \($0) 天。" } ?? "")AI 只能在这个范围内花，超出就付不了。可以随时在 App 里自己改：点下面按钮，签一次名就行（手续费用 USDC 付，约 $0.01 以内，不需要 ETH）。",
                     "Set when you opened the wallet: $\(AnswerRules.plain(s.capSingle ?? 0)) per buy, $\(AnswerRules.plain(s.capDaily ?? 0)) a day, $\(AnswerRules.plain(s.capTerm ?? 0)) total. Your AI can't spend beyond this. You can change it yourself in the app any time: tap below and sign once (network fee paid in USDC, about $0.01 or less, no ETH)."),
             button: T("看看 / 修改上限", "View / change"), id: "guide.limits") { sheet = "limits" }
        step(2, done: p.money, icon: "arrow.down.circle.fill",
             title: T("充值", "Add money"),
             body: T("点「充值」，从你的 Coinbase 钱包转入 USDC，到账后 App 会自动提示。", "Tap Add money and move USDC in from your Coinbase wallet; the app tells you when it arrives."),
             button: T("充值", "Add money"), id: "guide.deposit") { sheet = "fund" }
        step(3, done: p.ai, icon: "cpu.fill",
             title: T("连接你的 AI", "Connect your AI"),
             body: T("在「AI 智能体」里点你用的 AI（ChatGPT、Claude、Codex…），按提示复制一行发给它就连上了。每个 AI 有自己的钥匙，随时可以断开。", "In \"AI agents\", tap the AI you use (ChatGPT, Claude, Codex…) and send it the one line shown. Each AI gets its own key; disconnect any time."),
             button: T("去连接", "Connect"), id: "guide.ai") { tab = .agents }
        AIConnectSteps()
      }.card(padding: 18)
    }
  }
  @ViewBuilder func step(_ n: Int, done: Bool, icon: String, title: String, body: String, button: String, id: String, _ go: @escaping () -> Void) -> some View {
    HStack(alignment: .top, spacing: 12) {
      ZStack {
        Circle().fill(done ? Brand.positive : Brand.accentSoft).frame(width: 34, height: 34)
        if done { Image(systemName: "checkmark").font(.system(size: 15, weight: .bold)).foregroundStyle(.white) }
        else { Text("\(n)").font(.headline).foregroundStyle(Brand.accent) }
      }
      VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.headline).strikethrough(false)
        Text(body).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Button { Haptics.tap(); go() } label: { Label(done ? T("已完成 · ", "Done · ") + button : button, systemImage: done ? "checkmark.circle" : icon).font(.subheadline.weight(.semibold)) }
          .buttonStyle(.bordered).tint(done ? Brand.positive : Brand.accent).accessibilityIdentifier(id)
      }
    }
  }
}

/// Student pass: connecting an AI, one small step at a time.
struct AIConnectSteps: View {
  @State private var open = false
  static var steps: [String] { [
    T("打开下面的「AI 智能体」标签。", "Open the AI agents tab below."),
    T("点你用的 AI（ChatGPT、Claude、Codex…）。", "Tap the AI you use (ChatGPT, Claude, Codex…)."),
    T("点「复制」，把那一行发给你的 AI（粘贴到聊天里发送）。", "Tap Copy and send that one line to your AI (paste it into the chat)."),
    T("AI 回复“已连接”后，回到启付。这里会显示已连接。", "When your AI says it's connected, come back to Kipurse; it shows as connected here."),
    T("AI 要付款时，会在它的额度内自己付；超出的会来问你。只在启付 App 里点确认。", "When your AI pays, it stays within its limits; anything more asks you first. Only ever confirm inside the Kipurse app.")] }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button { Haptics.tap(); withAnimation { open.toggle() } } label: { Label(open ? T("收起步骤", "Hide steps") : T("怎么连？一步步看", "How? Step by step"), systemImage: open ? "chevron.up" : "list.number").font(.subheadline) }
        .accessibilityIdentifier("guide.aiSteps")
      if open {
        ForEach(Array(Self.steps.enumerated()), id: \.offset) { i, st in
          HStack(alignment: .top, spacing: 8) { Text("\(i + 1).").font(.subheadline.weight(.bold).monospacedDigit()).foregroundStyle(Brand.accent); Text(st).font(.subheadline).fixedSize(horizontal: false, vertical: true) }
            .accessibilityElement(children: .combine).accessibilityIdentifier("guide.aiStep\(i + 1)")
        }
      }
    }.padding(.leading, 46)
  }
}
