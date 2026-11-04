import SwiftUI
import UIKit
import KipurseCore

/// Delete account: 1 what it means + balances → 2 先全部提现 (strongly offered) + ledger export → 3 type 删除我的账户 → 4 Face ID → 5 countdown → delete.
struct DeleteAccountView: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var step: AccountDeletion.Step = .overview
  @State private var preview: JSONValue?
  @State private var err = ""
  @State private var phrase = ""
  @State private var ticket: String?
  @State private var left = AccountDeletion.countdownSeconds
  @State private var ledgerURL: URL?
  @State private var working = false
  @State private var timer: Timer?

  private func amt(_ k: String) -> Int64 { preview?["balances"]?[k]?.atomic ?? 0 }
  private var total: Int64 { amt("total") }
  private var permValid: Bool { preview?["permissionValid"]?.bool ?? false }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        StepProgress(current: min(step.rawValue + 1, 5), total: 5)
        switch step {
        case .overview: overview
        case .withdrawFirst: withdrawFirst
        case .typePhrase: typePhrase
        case .faceID: faceID
        case .countdown, .done: countdown
        }
        if !err.isEmpty { ErrorText(text: err) }
      }.padding(20)
    }
    .background(Brand.canvas).navigationTitle(L("删除账户")).navigationBarTitleDisplayMode(.inline)
    .task { await load() }
    .onChange(of: m.webSheet?.id) { _ in Task { await load() } }   // back from the signing page
    .onDisappear { timer?.invalidate() }
  }

  private func load() async {
    do { preview = try await m.api.call("deletePreview", [:]); err = "" } catch { err = error.localizedDescription }
  }

  // 1. what deletion means + balances
  private var overview: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(L("删除前请看清楚")).font(.title2.bold())
      VStack(alignment: .leading, spacing: 8) {
        row(L("钱包里"), amt("wallet")); row(L("结算账户里"), amt("vault")); if amt("float") > 0 { row(L("小额预付里"), amt("float")) }
        Divider(); row(L("合计"), total, bold: true)
        if let w = preview?["wallet"]?.string { OwnAddress(address: w, id: "erase.wallet", copyable: false) }
      }.card()
      VStack(alignment: .leading, spacing: 8) {
        ForEach(Array((preview?["meaning"]?.array ?? []).enumerated()), id: \.offset) { _, s in
          Label(s.string ?? "", systemImage: "circle.fill").labelStyle(Bullet()).font(.subheadline)
        }
      }.card()
      if let n = preview?["agents"]?.atomic, n > 0 { WarnBox(text: L("\(n) 个 AI 连接会立刻失效。")) }
      BigButton(L("我明白了，下一步"), disabled: preview == nil) { step = .withdrawFirst }
    }
  }

  // 2. strongly offer withdraw-all first (+ ledger export)
  private var withdrawFirst: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(L("先全部提现")).font(.title2.bold())
      if total > 0 {
        WarnBox(text: L("强烈建议先把 \(AnswerRules.format(total)) USDC 全部转回你自己的地址，并在链上撤销 AI 的授权（一次确认完成）。"), tone: Brand.accent, icon: "arrow.uturn.backward.circle.fill")
        if let o = preview?["withdrawalAddress"]?.string { Text(L("转到：\(o)")).font(.caption.monospaced()).foregroundStyle(.secondary) }
        BigButton(L("先全部提现（推荐）"), icon: "arrow.down.to.line") { Task { await m.openRescue() } }
      } else if permValid {
        WarnBox(text: L("钱已经取完。建议再在链上撤销 AI 的付款授权（一次确认）。"), tone: Brand.accent, icon: "lock.shield")
        BigButton(L("在链上撤销授权（推荐）"), icon: "lock.shield") { Task { await m.openSigning(next: "/?return=kipurse&do=revoke") } }
      } else {
        Label(L("钱已取完，链上授权也已撤销。"), systemImage: "checkmark.seal.fill").foregroundStyle(Brand.positive)
      }
      BigButton(L("刷新余额"), kind: .secondary, icon: "arrow.clockwise") { Task { await load() } }
      Divider()
      Text(L("下载账本")).font(.headline)
      Text(L("删除后服务器上的付款记录、充值记录会一起删掉。可以先存一份（JSON）。")).font(.footnote).foregroundStyle(.secondary)
      if let u = ledgerURL { ShareLink(item: u) { Label(L("保存 / 分享账本文件"), systemImage: "square.and.arrow.up") }.font(.headline) }
      else { BigButton(L("导出账本"), kind: .secondary, icon: "doc.text") { Task { await exportLedger() } } }
      Divider()
      if total > 0 || permValid {
        Text(total > 0 ? L("跳过也可以：钱不会丢，一直在链上你的钱包里，删除后可按「离线提现指南」自己取。") : L("跳过也可以：AI 的执行密钥会被销毁，没人能再用这个授权；之后可随时按指南撤销。")).font(.footnote).foregroundStyle(.secondary)
      }
      BigButton(total > 0 ? L("跳过，继续删除") : L("下一步"), kind: total > 0 ? .danger : .primary) { step = .typePhrase }
    }
  }

  // 3. type the phrase (server issues a short-lived ticket only for the exact phrase)
  private var typePhrase: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(L("输入确认文字")).font(.title2.bold())
      Text(L("请输入「\(AccountDeletion.phrase)」")).font(.headline)
      TextField(AccountDeletion.phrase, text: $phrase).textInputAutocapitalization(.never).autocorrectionDisabled()
        .padding(14).background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      BigButton(L("下一步"), kind: .danger, disabled: !AccountDeletion.phraseOK(phrase) || working) {
        Task { working = true; defer { working = false }
          do { let r = try await m.api.call("deleteStart", ["confirm": .string(phrase)]); ticket = r["ticket"]?.string; err = ""; step = .faceID } catch { err = error.localizedDescription } }
      }
    }
  }

  // 4. Face ID
  private var faceID: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(L("用 Face ID 确认是你本人")).font(.title2.bold())
      BigButton(L("用 Face ID 确认"), kind: .danger, icon: "faceid") {
        Task { if await BiometricGate.confirm(reason: L("删除 Kipurse 账户")) { err = ""; startCountdown() } else { err = L("没有通过 Face ID") } }
      }
    }
  }

  // 5. final countdown confirm
  private var countdown: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(L("最后确认")).font(.title2.bold())
      if permValid { WarnBox(text: L("你没有在链上撤销授权。删除后我们的执行密钥会被销毁，没人能再用它付款；授权会在到期日自动失效。想更彻底，之后按「离线提现指南」撤销授权（要付一点手续费）。")) }
      if total > 0 { WarnBox(text: L("\(AnswerRules.format(total)) USDC 留在链上你的钱包里，删除后按指南自己提现。"), tone: Brand.accent, icon: "info.circle.fill") }
      Text(left > 0 ? L("\(left) 秒后可以删除") : L("现在可以删除")).font(.headline).monospacedDigit()
      BigButton(working ? L("正在删除…") : L("永久删除我的账户"), kind: .danger, icon: "trash", disabled: left > 0 || working || ticket == nil) { Task { await doDelete() } }
      BigButton(L("取消"), kind: .secondary) { timer?.invalidate(); dismiss() }
    }
  }

  private func startCountdown() {
    step = .countdown; left = AccountDeletion.countdownSeconds; timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { t in Task { @MainActor in left -= 1; if left <= 0 { t.invalidate() } } }
  }
  private func exportLedger() async {
    do { let j = try await m.api.call("exportLedger", [:]); let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
      let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmm"
      let u = FileManager.default.temporaryDirectory.appendingPathComponent("kipurse-ledger-\(f.string(from: Date())).json")
      try enc.encode(j).write(to: u, options: .completeFileProtection); ledgerURL = u; err = "" } catch { err = error.localizedDescription }
  }
  private func doDelete() async {
    guard let t = ticket else { return }
    working = true; defer { working = false }
    do { let r = try await m.api.call("deleteAccount", ["ticket": .string(t), "confirm": .string(AccountDeletion.phrase), "skippedRevoke": .bool(permValid)])
         Haptics.warn(); m.finishDeletion(r) }
    catch { err = error.localizedDescription }
  }
  private func row(_ t: String, _ v: Int64, bold: Bool = false) -> some View {
    HStack { Text(t); Spacer(); Text("\(AnswerRules.format(v)) USDC").monospacedDigit() }.font(bold ? .headline : .subheadline)
  }
}

private struct Bullet: LabelStyle {
  func makeBody(configuration c: Configuration) -> some View { HStack(alignment: .firstTextBaseline, spacing: 8) { Text("•"); c.title.fixedSize(horizontal: false, vertical: true) } }
}

/// After deletion: 离线提现指南 (also saved as a PDF in the app's Documents and shareable).
struct RecoveryGuideView: View {
  let g: RecoveryGuide
  @State private var pdf: URL?
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text(L("离线提现指南")).font(.largeTitle.bold())
        WarnBox(text: L("账户已删除，钱没有被删除：USDC 一直在链上你自己的智能钱包里，只有你自己的 Coinbase 账户能控制。"), tone: Brand.positive, icon: "checkmark.shield.fill")
        VStack(alignment: .leading, spacing: 6) {
          Text(L("钱包地址")).font(.caption).foregroundStyle(.secondary)
          Text(g.wallet).font(.callout.monospaced()).textSelection(.enabled)
          Button { UIPasteboard.general.string = g.wallet; Haptics.success() } label: { Label(L("复制地址"), systemImage: "doc.on.doc") }.font(.subheadline)
          Text(L("\(g.network) · 删除时余额 \(AnswerRules.format(g.balanceAtDeletion)) USDC")).font(.caption).foregroundStyle(.secondary)
        }.card()
        if let u = g.rescueUrl.flatMap(URL.init(string:)) {
          BigButton(L("打开「离线提现」"), icon: "lifepreserver") { InApp.open(u) }
        }
        ForEach(g.simpleMethods, id: \.id) { mth in methodCard(mth) }
        DisclosureGroup(L("高级（技术人员用的备用方法）")) {
          VStack(alignment: .leading, spacing: 12) { ForEach(g.advancedMethods, id: \.id) { mth in methodCard(mth) } }.padding(.top, 8)
        }.font(.subheadline).card()
        if let p = pdf { ShareLink(item: p) { Label(L("保存 / 分享 PDF"), systemImage: "square.and.arrow.up") }.font(.headline) }
        Text(L("请现在保存或分享这份 PDF：为了不留任何痕迹，关掉这页后 App 里不会再有它。")).font(.footnote).foregroundStyle(.secondary)
      }.padding(20)
    }
    .background(Brand.canvas)
    .task { pdf = RecoveryStore.pdfURL(g) }
    .onDisappear { if let p = pdf { try? FileManager.default.removeItem(at: p) } }
  }
  private func methodCard(_ mth: RecoveryGuide.Method) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack { Text(mth.title).font(.headline); Spacer(); if !mth.works { Chip(text: L("不可用")) } }
      if mth.works { Text(mth.needsGas).font(.caption).foregroundStyle(Brand.caution) }
      ForEach(Array(mth.steps.enumerated()), id: \.offset) { i, s in Text("\(i + 1). \(s)").font(.subheadline).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
    }.card()
  }
}

/// Keeps the guide after logout (UserDefaults JSON + a PDF in Documents) so it can be reopened from the start screen.
enum RecoveryStore {
  private static let key = "recoveryGuide"
  static func save(_ g: RecoveryGuide) { if let d = try? JSONEncoder().encode(g) { UserDefaults.standard.set(d, forKey: key) }; _ = pdfURL(g) }
  static func load() -> RecoveryGuide? { UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(RecoveryGuide.self, from: $0) } }
  static func clear() { UserDefaults.standard.removeObject(forKey: key) }
  /// Renders (once) and returns Documents/离线提现指南-<wallet>.pdf.
  static func pdfURL(_ g: RecoveryGuide) -> URL? {
    let docs = FileManager.default.temporaryDirectory
    let u = docs.appendingPathComponent(L("离线提现指南-\(g.wallet.prefix(10)).pdf"))
    let page = CGRect(x: 0, y: 0, width: 595, height: 842)
    let fmt = UISimpleTextPrintFormatter(text: g.text); fmt.font = .systemFont(ofSize: 11); fmt.perPageContentInsets = UIEdgeInsets(top: 48, left: 48, bottom: 48, right: 48)
    let r = UIPrintPageRenderer(); r.addPrintFormatter(fmt, startingAtPageAt: 0)
    r.setValue(NSValue(cgRect: page), forKey: "paperRect"); r.setValue(NSValue(cgRect: page), forKey: "printableRect")
    let data = NSMutableData(); UIGraphicsBeginPDFContextToData(data, page, nil)
    for i in 0..<max(r.numberOfPages, 1) { UIGraphicsBeginPDFPage(); r.drawPage(at: i, in: UIGraphicsGetPDFContextBounds()) }
    UIGraphicsEndPDFContext()
    do { try data.write(to: u, options: .atomic); return u } catch { return nil }
  }
}
