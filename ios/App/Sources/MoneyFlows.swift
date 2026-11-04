import SwiftUI
import KipurseCore

// MARK: 提现 — where (my Coinbase / my Base wallet / paste or scan) → how much (presets + 全部 + 自己填) → plain fee → Face ID.
struct WithdrawFlow: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  enum Dest: String, CaseIterable, Identifiable { case coinbase, base, other; var id: String { rawValue } }
  @State private var dest: Dest = .base
  @AppStorage("coinbaseAddress") private var coinbaseAddr = ""
  @State private var pasted = ""
  @State private var amount = ""
  @State private var quote: JSONValue?
  @State private var err = ""
  @State private var scanning = false
  @State private var done: JSONValue?
  var to: String {
    switch dest { case .base: return s.owner ?? ""; case .coinbase: return AddressCheck.normalized(coinbaseAddr); case .other: return AddressCheck.normalized(pasted) }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if let d = done {
        VStack(spacing: 10) {
          Image(systemName: "checkmark.circle.fill").font(.system(size: 54)).foregroundStyle(Brand.positive)
          Text(L("已提现 \(AnswerRules.format(quote?["amount"]?.atomic ?? 0)) USDC")).font(.title2.bold())
          Text(L("到 \(fullAddr(to))")).font(.footnote.monospaced()).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          if let tx = d["txHash"]?.string, let u = URL(string: "\(s.raw["explorer"]?.string ?? "https://basescan.org")/tx/\(tx)") { Link(L("查看交易"), destination: u).font(.subheadline) }
        }.frame(maxWidth: .infinity).card(padding: 24)
      } else {
        Text(L("取到哪里？")).font(.headline)
        VStack(spacing: 10) {
          destRow(.base, L("我的 Base 钱包"), L("你登录 Kipurse 用的那个账户 \(shortAddr(s.owner ?? ""))"), "b.circle.fill")
          destRow(.coinbase, L("我的 Coinbase"), coinbaseAddr.isEmpty ? L("第一次要粘贴一下你的 Coinbase 收款地址") : fullAddr(coinbaseAddr), "c.circle.fill")
          destRow(.other, L("别的地址"), L("粘贴或扫码"), "qrcode.viewfinder")
        }
        if dest == .coinbase {
          VStack(alignment: .leading, spacing: 8) {
            Text(L("在 Coinbase App：点「收款」→ 选 USDC → 网络选 **Base** → 复制地址，再回来点「粘贴」。")).font(.footnote).foregroundStyle(.secondary)
            addressField($coinbaseAddr)
          }.card(padding: 14)
        }
        if dest == .other { VStack(alignment: .leading, spacing: 8) { addressField($pasted); Text(L("只能是 Base 网络上的地址。转错地址钱拿不回来。")).font(.footnote).foregroundStyle(.secondary) }.card(padding: 14) }
        AmountPicker(title: L("提现多少？"), presets: ["1", "2", "5", L("全部")], unit: "USDC", value: Binding(get: { amount }, set: { amount = $0; quote = nil; err = "" })).card(padding: 18)
        Text(L("钱包里有 \(AnswerRules.format(s.balance)) USDC")).font(.footnote).foregroundStyle(.secondary)
        if !err.isEmpty { ErrorText(text: err) }
        if let q = quote {
          VStack(alignment: .leading, spacing: 8) {
            row(L("对方收到"), q["amount"]); row(L("手续费（0.1%）"), q["fee"]); row(L("手续费（按实际花费，最多）"), q["gasMax"])
            Divider(); row(L("最多从钱包扣"), q["totalMax"], bold: true)
            Text(L("手续费用钱包里的 USDC 付，你不需要 ETH。")).font(.footnote).foregroundStyle(.secondary)
            ForEach(q["warnings"]?.array.compactMap(\.string) ?? [], id: \.self) { w in WarnBox(text: w) }
          }.card(padding: 16)
          BigButton(L("用 Face ID 确认提现"), icon: "faceid") { Task { await confirm() } }
        } else {
          BigButton(L("下一步：看费用"), icon: "arrow.right", disabled: amount.isEmpty || to.isEmpty) { Task { await getQuote() } }
        }
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in scanning = false }
    .sheet(isPresented: $scanning) {
      QRScanner { v in scanning = false; let a = AddressCheck.normalized(v.replacingOccurrences(of: "ethereum:", with: "")); if dest == .coinbase { coinbaseAddr = a } else { pasted = a }; quote = nil }.ignoresSafeArea()
    }
  }
  private func destRow(_ d: Dest, _ t: String, _ sub: String, _ icon: String) -> some View {
    Button { Haptics.select(); dest = d; quote = nil; err = "" } label: {
      HStack(spacing: 12) {
        Image(systemName: icon).font(.title2).foregroundStyle(Brand.accent).frame(width: 36)
        VStack(alignment: .leading, spacing: 2) { Text(t).font(.headline).foregroundStyle(.primary); Text(sub).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
        Spacer(); Image(systemName: dest == d ? "checkmark.circle.fill" : "circle").foregroundStyle(dest == d ? Brand.accent : .secondary).font(.title3)
      }.card(padding: 14)
    }.buttonStyle(Pressable())
  }
  private func addressField(_ b: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if !b.wrappedValue.isEmpty { Text(b.wrappedValue).font(.footnote.monospaced()).textSelection(.enabled) }
      HStack(spacing: 10) {
        BigButton(L("粘贴"), kind: .secondary, icon: "doc.on.clipboard") { b.wrappedValue = AddressCheck.normalized(UIPasteboard.general.string ?? ""); quote = nil; err = "" }
        BigButton(L("扫码"), kind: .secondary, icon: "qrcode.viewfinder") { scanning = true }
      }
    }
  }
  private func row(_ t: String, _ v: JSONValue?, bold: Bool = false) -> some View {
    HStack { Text(t).font(bold ? .headline : .subheadline); Spacer(); Text("\(AnswerRules.format(v?.atomic ?? 0)) USDC").font(bold ? .headline.monospacedDigit() : .subheadline.monospacedDigit()) }
  }
  private func getQuote() async {
    if let e = AddressCheck.error(to, wallet: s.wallet) { Haptics.warn(); err = e; return }
    let a = amount == L("全部") ? "all" : amount
    if a != "all", let e = AnswerRules.usdcError("withdraw", a) { err = e; return }
    do { let q = try await m.api.call("withdrawQuote", ["to": .string(to), "amount": .string(a)])
      if let p = q["problem"]?.string { Haptics.warn(); err = p; return }; quote = q }
    catch { Haptics.warn(); err = error.localizedDescription }
  }
  private func confirm() async {
    guard let q = quote, let amt = q["amount"]?.atomic else { return }
    let amtStr = AnswerRules.format(amt)
    await m.ownerAction(L("提现 \(amtStr) USDC 到 \(shortAddr(to))")) { [api = m.api, to] in
      let r = try await api.call("withdraw", ["to": .string(to), "amount": .string(amtStr)])
      await MainActor.run { done = r; Haptics.success() }
    }
  }
}
