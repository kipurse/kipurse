import SwiftUI
import KipurseCore

/// One pending Coinbase wallet signing page, held until the user has seen the fee and the balance check passes.
struct GasGate: Identifiable { let id = UUID(); let url: URL; let kind: GasCheck.Kind; let proceed: @MainActor () -> Void }

/// Shown before every Coinbase wallet signature.
///  - Phone upgrade (/phone/enroll?id=…): the network fee is paid from the KIPURSE WALLET's USDC (server quote = the exact amount
///    the batch refunds to the Coinbase wallet, max 0.05). Sign is disabled when the wallet's USDC < fee; a warning if the Base
///    Account has no ETH to pay the gas up front.
///  - Everything else: the user's own Coinbase wallet USDC (GasCheck.fetch). Never ETH. Kipurse never pays gas.
struct GasPreflightSheet: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  @EnvironmentObject var m: AppModel
  @State private var deposit = false
  static var mockLoads = 0
  let gate: GasGate
  @State private var est: GasCheck.Estimate?; @State private var quote: GasCheck.UpgradeQuote?; @State private var err = ""
  var account: String { Operator.ownerAccount ?? "" }

  var enrollID: String? { gate.kind == .phoneUpgrade ? GasCheck.enrollID(gate.url) : nil }
  var siri: Bool { Unbound.isSiriUpgrade(gate.url) }
  var canSign: Bool { enrollID != nil ? (quote?.enough ?? false) : (est?.enough ?? false) }
  @State private var why = false
  @State private var steps = false
  @State private var others = false
  var feeText: String { quote.map { T("约 \(GasCheck.usdc($0.fee))", "about \(GasCheck.usdc($0.fee))") } ?? T("金额计算中", "amount loading") }
  func stepRow(_ n: String, _ t: String, _ id: String) -> some View {
    HStack(alignment: .top, spacing: 8) { Text(n).font(.caption.bold()).foregroundStyle(.white).frame(width: 20, height: 20).background(Circle().fill(Brand.accent))
      Text(t).font(.callout).fixedSize(horizontal: false, vertical: true) }.accessibilityElement(children: .combine).accessibilityIdentifier(id)
  }
  var body: some View {
    NavigationStack {
      List {
        if enrollID != nil { upgradeSections } else { ethSections }
        if !err.isEmpty { Section { Label(T("暂时连不上网络，请稍后点重试。", "Can't connect right now. Please tap Retry in a moment."), systemImage: "wifi.exclamationmark").foregroundStyle(Brand.negative).accessibilityIdentifier("gas.error")
          Button(T("重试", "Retry")) { Task { await load() } }
          DisclosureGroup(T("详细信息", "Details")) { Text(err).font(.caption).foregroundStyle(.secondary) } } }
        if !(enrollID != nil && quote.map { !$0.enough } == true) { Section {
          Button { dismiss(); gate.proceed() } label: { Label(enrollID != nil ? (quote.map { T("用 Face ID 开启（手续费 \(GasCheck.usdc($0.fee))）", "Turn on with Face ID (fee \(GasCheck.usdc($0.fee)))") } ?? (siri ? T("支付一次性手续费并升级", "Pay the one-time network fee and upgrade") : T("用 Face ID 开启", "Turn on with Face ID"))) : T("去确认（手续费用 USDC 付）", "Continue (fee paid in USDC)"), systemImage: enrollID != nil ? "faceid" : "checkmark.circle").font(.headline).foregroundStyle(.white).frame(maxWidth: .infinity, minHeight: 44) }
            .disabled(!canSign).accessibilityIdentifier("gas.sign")
            .listRowBackground(canSign ? Brand.accent : Brand.accent.opacity(0.35))   // t877: primary Face ID button
        } }
        if enrollID != nil, let q = quote, !q.enough { Section {   // t877: not enough USDC -> deposit first, then this turns into the Face ID button by itself
          VStack(alignment: .leading, spacing: 6) {
            Label(T("先充值", "Add money first"), systemImage: "arrow.down.circle.fill").font(.headline).foregroundStyle(Brand.accent).accessibilityIdentifier("gas.depositTitle")
            Text(T("钱包里有 \(GasCheck.usdc(q.walletUSDC))，手续费 \(GasCheck.usdc(q.fee))。充值后这里会自动变成 Face ID 按钮。", "Your wallet has \(GasCheck.usdc(q.walletUSDC)); the fee is \(GasCheck.usdc(q.fee)). After you add money, this turns into the Face ID button by itself."))
              .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          }
          Button { Haptics.tap(); deposit = true } label: { Label(T("去充值", "Add money"), systemImage: "plus.circle.fill").font(.headline).foregroundStyle(.white).frame(maxWidth: .infinity, minHeight: 44) }
            .listRowBackground(Brand.accent).accessibilityIdentifier("gas.deposit")
        } }
      }.navigationTitle(gate.kind == .phoneUpgrade ? (siri ? Unbound.siriLabel : Unbound.bindLabel) : gate.kind.title).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(T("取消", "Cancel")) { dismiss() } }
    }.task { await load() }
    .task(id: quote.map { $0.enough }) {   // t877: while not enough and the sheet is visible: re-check the balance (no background jobs)
      guard enrollID != nil, quote?.enough == false else { return }
      while !Task.isCancelled { try? await Task.sleep(nanoseconds: CommandLine.arguments.contains("-kpGasGateLow") ? 2_000_000_000 : 10_000_000_000)
        if Task.isCancelled { break }; if phase == .active { await load(quiet: true) } }
    }
    .onChange(of: phase) { p in if p == .active, quote?.enough == false { Task { await load(quiet: true) } } }
    .sheet(isPresented: $deposit, onDismiss: { Task { await load(quiet: true) } }) { DepositChoiceSheet().environmentObject(m) }
  }
  @ViewBuilder var upgradeSections: some View {
    Section {
      Text(siri ? T("付一次很小的网络费，以后 Siri 就能在你设的额度内帮你付款。", "Pay one small network fee once; then Siri can pay within the allowance you set.") : T("以后在这台手机上用 Face ID 批准付款。旧手机或旧 App 的批准会自动停用，你的钱不受影响。", "From now on you approve payments on this phone with Face ID. The old phone or app stops automatically. Your money isn't affected.")).font(.callout).accessibilityIdentifier("gas.plain")
      if let q = quote {
        LabeledContent(T("手续费", "Fee"), value: T("约 \(GasCheck.usdc(q.fee))，从你的启付钱包扣", "About \(GasCheck.usdc(q.fee)), from your Kipurse wallet")).accessibilityIdentifier("gas.fee")
      } else if err.isEmpty { HStack { ProgressView(); Text(T("正在计算手续费…", "Working out the fee…")) } }
    }
    if let q = quote, !q.enough { Section {   // t849: say the amount plainly; no red, no "deposit first"
        Label(T("手续费 \(GasCheck.usdc(q.fee))，启付钱包里现在有 \(GasCheck.usdc(q.walletUSDC))，还不够付这笔手续费。", "The fee is \(GasCheck.usdc(q.fee)); your Kipurse wallet has \(GasCheck.usdc(q.walletUSDC)) right now, not enough for it."), systemImage: "info.circle").font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("gas.missing")
      } }
    Section {   // t893: short 3 steps + "only other AIs", both collapsed by default
      DisclosureGroup(isExpanded: $steps) {
        stepRow("1", T("开启 Face ID 批准：把这台手机登记为钱包批准人，只做一次。", "Turn on Face ID approval: register this phone as your wallet's approver. Once only."), "t893.step1")
        stepRow("2", T("开通费约 \(feeText)，从启付钱包余额扣，只扣一次。", "Pay one network fee (\(feeText), not a Kipurse charge, from your Kipurse wallet, once only)."), "t893.step2")
        stepRow("3", T("连接 Siri：像其他 AI 一样，自己设 Siri 的额度。额度内给付过的人付款不用 Face ID；超额、新收款方或恢复暂停才要。", "Connect Siri: like other AIs, set Siri's own allowance. Within it, paying people you've paid before needs no Face ID; over it, a new payee or resuming does."), "t893.step3")
      } label: { Text(T("三步开通", "3 steps")).font(.callout.weight(.semibold)).accessibilityIdentifier("t893.steps") }
      DisclosureGroup(isExpanded: $others) {
        Text(T("不需要这一步，也不用付这笔手续费。授权一次（默认 30 天）设好额度，额度内 AI 直接付款，不用每笔 Face ID。超额、给新收款方大额付款或恢复暂停的 AI，才需要 Face ID。", "You don't need this step or this fee. Authorize once (30 days by default) with a limit; within it the AI pays directly, no Face ID each time. Only going over the limit, a large payment to a new payee, or resuming a paused AI needs Face ID."))
          .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("t893.othersText")
      } label: { Text(T("只连接其他 AI（Muse/Grok/Claude）会怎样？", "Only connecting other AIs (Muse/Grok/Claude)?")).font(.callout.weight(.semibold)).accessibilityIdentifier("t893.others") }
    }
    Section { DisclosureGroup(isExpanded: $why) {
        Label(siri ? GasCheck.phoneSiriWhat : GasCheck.phoneSignerWhat, systemImage: "waveform").font(.callout).accessibilityElement(children: .combine).accessibilityIdentifier("gas.what")
        Label(GasCheck.upgradeNotice, systemImage: "dollarsign.circle").font(.callout).accessibilityElement(children: .combine).accessibilityIdentifier("gas.notice")
        Label(GasCheck.agentsFreeText, systemImage: "person.2").font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("gas.agentsFree")
      } label: { Text(T("为什么？", "Why?")).font(.callout.weight(.semibold)).accessibilityIdentifier("gas.why") } }
  }
  @ViewBuilder var ethSections: some View {
    Section { Label(GasCheck.notice, systemImage: "person.crop.circle.badge.exclamationmark").font(.callout).accessibilityIdentifier("gas.notice") }
    Section(T("预计手续费", "Estimated network fee")) {
      if let e = est {
        LabeledContent(T("预计（用 USDC 付）", "Estimate (paid in USDC)"), value: "≈ " + GasCheck.dollars(e.feeUSDC)).accessibilityIdentifier("gas.fee")
        LabeledContent(T("至少需要（含 \(GasCheck.marginPercent)% 余量）", "Needed (incl. \(GasCheck.marginPercent)% margin)"), value: GasCheck.dollars(e.requiredUSDC))
        LabeledContent(T("启付钱包余额", "Kipurse wallet balance"), value: String(format: "%.2f USDC", e.balanceUSDC)).accessibilityIdentifier("gas.balance")
      } else if err.isEmpty { HStack { ProgressView(); Text(T("正在读取手续费和你的余额…", "Reading fee and your balance…")) } }
    }
    if let e = est, !e.enough { Section { Label(GasCheck.missingText(e), systemImage: "exclamationmark.triangle.fill").foregroundStyle(Brand.negative).accessibilityIdentifier("gas.missing") } }
  }
  func load(quiet: Bool = false) async {
    err = ""; if !quiet { est = nil; quote = nil }
    do {
      if let id = enrollID {
        #if DEBUG
        if CommandLine.arguments.contains("-kpGasGateLow") {   // t877 tests: empty wallet; with -kpGasArrive money arrives on the 3rd check
          Self.mockLoads += 1; let arrived = CommandLine.arguments.contains("-kpGasArrive") && Self.mockLoads >= 3
          quote = GasCheck.UpgradeQuote(fee: 26_662, walletUSDC: arrived ? 5_000_000 : 0, ownerEthWei: 577e12, ownerGasWei: 11.8e12); return }
        #endif
        if CommandLine.arguments.contains("-kpGasGate") { quote = GasCheck.UpgradeQuote(fee: 42_600, walletUSDC: 9_040_387, ownerEthWei: 577e12, ownerGasWei: 11.8e12); return }   // simulator screenshot
        quote = try await GasCheck.fetchUpgradeQuote(server: PhoneKey.server, id: id)
      } else { est = try await GasCheck.fetch(kind: gate.kind, account: account) }
    } catch { err = error.localizedDescription }
  }
}


/// t877: the wallet's two deposit ways (Apple Pay 充值 / Coinbase 充值), reachable from the Face ID approval sheet.
struct DepositChoiceSheet: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var cb = false
  var body: some View {
    NavigationStack {
      ScrollView { VStack(alignment: .leading, spacing: 14) {
        Text(T("充值", "Add money")).font(.title2.bold())
        if let s = m.state {
          Button { Haptics.tap(); cb = true } label: {
            Label(T("从 Coinbase 钱包转入", "From your Coinbase wallet"), systemImage: "arrow.down.circle.fill").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
              .frame(maxWidth: .infinity, minHeight: 54).background(LinearGradient(colors: [Color(hex: 0x3B7BFF), Color(hex: 0x0052FF)], startPoint: .top, endPoint: .bottom), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          }.buttonStyle(Pressable()).accessibilityIdentifier("depchoice.coinbase")
          .navigationDestination(isPresented: $cb) { ScrollView { CoinbaseDepositView(s: s).padding(20) }.background(Brand.canvas).navigationTitle(T("Coinbase 充值", "Coinbase Top Up")) }
        } else { Text(L("还没有钱包地址")).foregroundStyle(.secondary) }
        Text(T("到账后回到上一页，会自动变成 Face ID 按钮。", "Once it arrives, go back; the Face ID button appears by itself.")).font(.footnote).foregroundStyle(.secondary)
      }.padding(20) }.background(Brand.canvas).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(T("完成", "Done")) { dismiss() }.accessibilityIdentifier("depchoice.done") }
    }
  }
}
