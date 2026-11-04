import SwiftUI
import KipurseCore

/// t902 (owner): tapping 连接 Siri first explains what Siri does with the wallet and the 3 steps. The Face ID approval sheet
/// (with its one-time network fee) opens ONLY from the last step's 下一步 button.
enum SiriPending {   // step 1 choice, applied (one Face ID) once Face ID approval is on
  static let key = "kp.siri.pendingLimits"
  static var value: (String, String)? { guard let a = UserDefaults.standard.array(forKey: key) as? [String], a.count == 2 else { return nil }; return (a[0], a[1]) }
  static func set(_ s: String, _ d: String) { UserDefaults.standard.set([s, d], forKey: key) }
  static func clear() { UserDefaults.standard.removeObject(forKey: key) }
}

struct SiriIntroView: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  let faceIDOn: Bool
  @State private var single = SiriPending.value?.0 ?? "2"; @State private var daily = SiriPending.value?.1 ?? "10"
  @State private var step1 = SiriPending.value != nil; @State private var step2 = false
  @State private var err: String?; @State private var phrases = false; @State private var deposit = false
  static let maxFee: Int64 = 50_000   // server cap for the one-time approver fee (0.05 USDC); the exact quote shows on the next sheet
  var enough: Bool { (m.state?.balance ?? 0) >= Self.maxFee }
  var body: some View {
    NavigationStack {
      List {
        Section {
          VStack(alignment: .leading, spacing: 8) {
            Label(T("Siri 能帮你", "What Siri can do"), systemImage: "waveform").font(.headline).foregroundStyle(Brand.accent)
            Text(T("“嘿 Siri，用 Kipurse 付款”：在你自己设的额度内，给付过的人直接付。", "“Hey Siri, pay with Kipurse”: pays people you've paid before, within your own allowance.")).font(.callout)
            Text(T("“嘿 Siri，查 Kipurse 余额”：问余额和最近花了多少。", "“Hey Siri, check Kipurse balance”: balance and recent spending.")).font(.callout).foregroundStyle(.secondary)
          }.accessibilityElement(children: .combine).accessibilityIdentifier("siri.intro.what")
        }
        Section {
          row("1", T("设 Siri 的额度", "Set Siri's allowance"), done: step1, id: "siri.intro.step1")
          if !step1 {
            HStack { Text(T("每笔最多", "Per payment")); TextField("2", text: $single).keyboardType(.decimalPad).multilineTextAlignment(.trailing).accessibilityIdentifier("siri.intro.single"); Text("USDC").foregroundStyle(.secondary) }
            HStack { Text(T("每天最多", "Per day")); TextField("10", text: $daily).keyboardType(.decimalPad).multilineTextAlignment(.trailing).accessibilityIdentifier("siri.intro.daily"); Text("USDC").foregroundStyle(.secondary) }
            if let e = err { Text(e).font(.footnote).foregroundStyle(Brand.negative) }
            Button(T("选好了", "Done")) { if let p = AgentLimits.problem(single: single, daily: daily, zh: Loc.isChinese) { err = p } else { err = nil; SiriPending.set(single, daily); withAnimation { step1 = true } } }.accessibilityIdentifier("siri.intro.step1.done")
          } else { Text(T("每笔 \(single) · 每天 \(daily) USDC，随时可改", "\(single) per payment · \(daily) a day (USDC), change any time")).font(.footnote).foregroundStyle(.secondary) }
        }
        Section {
          row("2", T("对 Siri 说一句话", "Say it to Siri"), done: step2, id: "siri.intro.step2")
          Text(T("装好就能说：“嘿 Siri，用 Kipurse 付款”。", "Just say: “Hey Siri, pay with Kipurse”.")).font(.footnote).foregroundStyle(.secondary)
          HStack { Button(T("看全部说法", "All phrases")) { phrases = true }.accessibilityIdentifier("siri.intro.phrases"); Spacer()
            if !step2 { Button(T("知道了", "Got it")) { withAnimation { step2 = true } }.accessibilityIdentifier("siri.intro.step2.done") } }.buttonStyle(.borderless)
        }
        Section {
          row("3", T("开启 Face ID 批准（最后一步）", "Turn on Face ID approval (last step)"), done: faceIDOn, id: "siri.intro.step3")
          Text(T("只在超额、新收款方、恢复暂停时用。开通费约 0.03 USDC，从启付钱包余额扣，只扣一次。", "Only for over-allowance, new payees or resuming. Setup fee about 0.03 USDC, taken once from your Kipurse wallet balance.")).font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("siri.intro.fee")
          if faceIDOn { Button(T("完成", "Done")) { dismiss() } }
          else if !enough && m.demo == nil {
            Label(T("先充值：钱包 USDC 不够付手续费", "Add money first: not enough USDC for the fee"), systemImage: "arrow.down.circle.fill").font(.callout).foregroundStyle(Brand.accent)
            Button { deposit = true } label: { Label(T("去充值", "Add money"), systemImage: "plus.circle.fill") }.accessibilityIdentifier("siri.intro.deposit")
          } else {
            Button { next() } label: { Text(T("下一步", "Next")).font(.headline).frame(maxWidth: .infinity) }
              .disabled(!(step1 && step2)).accessibilityIdentifier("siri.intro.next")
          }
        }
      }
      .scrollDismissesKeyboard(.immediately)
      .navigationTitle(T("连接 Siri", "Connect Siri")).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(T("取消", "Cancel")) { dismiss() } }
      .sheet(isPresented: $phrases) { SiriPhrasesSheet().presentationDetents([.medium, .large]) }
      .sheet(isPresented: $deposit) { DepositChoiceSheet().environmentObject(m) }
    }
  }
  func row(_ n: String, _ t: String, done: Bool, id: String) -> some View {
    HStack(spacing: 10) {
      ZStack { Circle().fill(done ? Brand.positive : Brand.accent).frame(width: 24, height: 24)
        if done { Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white) } else { Text(n).font(.caption.bold()).foregroundStyle(.white) } }
      Text(t).font(.headline)
    }.accessibilityElement(children: .combine).accessibilityIdentifier(id).accessibilityValue(done ? "done" : "todo")
  }
  func next() {
    dismiss()
    Task { try? await Task.sleep(nanoseconds: 600_000_000)
      #if DEBUG
      if m.demo != nil { m.gasGate = GasGate(url: URL(string: "https://sign.kipurse.com/phone/enroll?id=demo")!, kind: .phoneUpgrade) {}; return }
      #endif
      await PhoneKey.startUpgrade(m) }
  }
}
