import SwiftUI
import UIKit
import KipurseCore

/// Muse (Meta) has no "add connector" deep link. Verified: muse.ai's apple-app-site-association routes https://muse.ai/chat
/// (and /chat/*) to the Muse iOS app (com.facebook.hatch); App Store id 6760173601. Muse adds a custom connector from a chat
/// message and then sends an OAuth sign-in link. So: copy the one message, open Muse, the owner pastes and approves.
enum MuseLauncher {
  static var mcpURL: String { Mainnet.mcpURL }
  static let chatURL = URL(string: "https://muse.ai/chat")!
  static let storeURL = URL(string: "itms-apps://apps.apple.com/app/id6760173601")!
  static var prompt: String {
    """
    Create a Custom Connector for a new remote MCP server, then connect to it:
    Name: Kipurse
    Transport: remote streamable HTTP
    URL: \(mcpURL)
    Auth: OAuth. Send me the sign-in link and I will approve it.
    """
  }
  /// Tap = small in-app page: the exact text to paste into Muse, 3 steps, "Copy and open Muse" / "Copy only".
  /// Muse has no prefill link (checked: AASA paths, web bundle params, docs), so the owner pastes once.
  @MainActor static func open(_ m: AppModel) { m.museSheet = true }
  /// Copies the text; open = then the Muse app (universal link), App Store if not installed.
  @MainActor static func copy(_ m: AppModel, open: Bool) {
    UIPasteboard.general.string = prompt; Haptics.success()
    #if DEBUG
    m.lastLaunch = open ? chatURL.absoluteString : "copy"
    if m.demo != nil { return }
    #endif
    guard open else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
      UIApplication.shared.open(chatURL, options: [.universalLinksOnly: true]) { ok in
        if !ok { DispatchQueue.main.async { UIApplication.shared.open(storeURL) } }
      }
    }
  }
}

struct MuseConnectSheet: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var copied = false
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text(T("三步连上 Muse，不用看懂任何设置。", "Three steps to connect Muse. No settings to understand."))
            .font(.title3).fixedSize(horizontal: false, vertical: true)
          VStack(alignment: .leading, spacing: 12) {
            step(1, T("点下面的「复制并打开 Muse」", "Tap “Copy and open Muse” below"))
            step(2, T("在 Muse 对话框里长按，点「粘贴」", "In the Muse chat, long-press the text box and tap Paste"))
            step(3, T("点发送，然后在手机上批准连接", "Tap send, then approve the connection on your phone"))
          }
          BigButton(copied ? T("已复制", "Copied") : T("复制并打开 Muse", "Copy and open Muse"), icon: copied ? "checkmark" : "arrow.up.forward.app") {
            MuseLauncher.copy(m, open: true); copied = true; museStartedFlag()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { m.museSheet = false }   // close: coming back for Face ID must not land here
          }.accessibilityIdentifier("muse.copyOpen")
          BigButton(T("只复制", "Copy only"), kind: .secondary, icon: "doc.on.doc") {
            MuseLauncher.copy(m, open: false); copied = true; m.toast = T("已复制", "Copied")
          }.accessibilityIdentifier("muse.copyOnly")
          DisclosureGroup(T("高级：查看要复制的文字", "Advanced: see the text that gets copied")) {
            Text(MuseLauncher.prompt)
              .font(.caption.monospaced()).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
              .padding(12).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
              .accessibilityIdentifier("muse.text")
          }.font(.footnote)
        }.padding(20)
      }
      .navigationTitle(T("连接 Muse", "Connect Muse")).navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button(T("关闭", "Close")) { dismiss() }.accessibilityIdentifier("muse.close") } }
    }
  }
  private func museStartedFlag() { UserDefaults.standard.set(true, forKey: "museConnectStarted") }
  private func step(_ n: Int, _ t: String) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Text("\(n)").font(.headline).foregroundStyle(.white).frame(width: 28, height: 28).background(Brand.accent, in: Circle())
      Text(t).font(.body).fixedSize(horizontal: false, vertical: true)
    }
  }
}

struct OAuthReq: Identifiable { let id: String }

/// kipurse://oauth?req=<id> from a consent page: one screen, Face ID, approve or decline.
struct OAuthApproveSheet: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  let req: OAuthReq
  var body: some View {
    let a = m.state?.approvals.first { $0.kind == .connectAgent && $0.serverId == req.id }
    VStack(alignment: .leading, spacing: 16) {
      Image(systemName: "link.badge.plus").font(.system(size: 40)).foregroundStyle(Brand.accent)
      if let a {
        Text(a.titleZh).font(.title2.weight(.bold))
        Text(a.bodyZh).foregroundStyle(.secondary)
        BigButton(L("用 Face ID 批准连接"), icon: "faceid") { Task { await m.approve(a); dismiss() } }
        BigButton(L("拒绝"), kind: .secondary) { Task { await m.reject(a); dismiss() } }
      } else {
        Text(T("找不到这个连接请求", "Request not found")).font(.title2.weight(.bold))
        Text(T("可能已过期，或者是正式钱包的请求：正式钱包在 AI 发来的网页里用你的 Coinbase 钱包（Face ID）批准。", "It may have expired, or it's for your Kipurse wallet: approve that one on the web page your AI sent, with your Coinbase wallet (Face ID).")).foregroundStyle(.secondary)
        BigButton(L("关闭"), kind: .secondary) { dismiss() }
      }
      Spacer()
    }.padding(24).presentationDetents([.medium, .large])
    .task { await m.refresh() }
  }
}

// MARK: - Use this AI to buy

/// A connected AI's card: "use this AI to buy". Example sentences first (copy / open the AI), then its allowance and what's left
/// today, its recent purchases with receipts, pause this AI. Reconnect / disconnect are secondary, at the bottom.
struct AgentBuyTarget: Hashable { let id: String; let name: String; let symbol: String?; let kinds: [String]; let card: AgentCard? 
  static func == (a: Self, b: Self) -> Bool { a.id == b.id }; func hash(into h: inout Hasher) { h.combine(id) } }

struct AgentBuyView: View {
  @EnvironmentObject var m: AppModel
  @ObservedObject var allow = AllowanceStore.shared
  let t: AgentBuyTarget; let s: WalletState
  @State private var copied: String?; @State private var picked: Tx?; @State private var askStop = false; @State private var msg: String?; @State private var editLimits = false
  var isSiri: Bool { t.id == "siri" }
  var mine: [Tx] { s.txs.filter { AgentBuy.isAgent($0.agent, kinds: t.kinds) } }
  var capRow: AgentCapRow? { allow.agents.first { AgentBuy.isAgent($0.id, kinds: t.kinds) } }
  var body: some View {
    List {
      if isSiri { Section { Label(T("不用任何设置，直接对 Siri 说下面任何一句。", "No setup needed. Just say any of these to Siri."), systemImage: "waveform").font(.subheadline).accessibilityIdentifier("siri.noSetup") } }
      Section {
        ForEach(AgentBuy.examples(for: t.id), id: \.self) { e in
          VStack(alignment: .leading, spacing: 8) {
            Text(e.text).font(.body).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            AdaptiveStack {
              Button { UIPasteboard.general.string = e.text; Haptics.success(); copied = e.en } label: {
                Label(copied == e.en ? T("已复制", "Copied") : T("复制", "Copy"), systemImage: copied == e.en ? "checkmark" : "doc.on.doc").lineLimit(1).fixedSize() }
                .buttonStyle(.bordered).accessibilityIdentifier("buy.copy")
              if let u = AgentBuy.openURL(for: t.id, text: e.text) {
                Button { open(u, e.text) } label: { Label(T("打开 \(t.name)", "Open \(t.name)"), systemImage: "arrow.up.forward.app").lineLimit(1) }
                  .buttonStyle(.borderedProminent).accessibilityIdentifier("buy.open")
              }
            }
          }.padding(.vertical, 4)
        }
      } header: { Text(isSiri ? T("对 Siri 这样说", "Say this to Siri") : T("复制一句话，发给 \(t.name) 就能买", "Copy a sentence, send it to \(t.name), and it buys")).accessibilityIdentifier("buy.title") }
      footer: { Text(isSiri ? T("在 Siri 的额度内给付过的收款方付款，直接付，不用 Face ID；超额、新收款方或恢复暂停，才要 Face ID。", "Within Siri's allowance, payments to payees you've paid before go through with no Face ID. Going over it, a new payee or resuming a pause needs Face ID.")
                            : T("在 AI 付款上限以内，AI 直接付；超出或第一次付给新商家，会先问你，你用 Face ID 同意。", "Within your AI payment limit the AI just pays; anything over it, or a new shop, asks you first; approve with Face ID.")) }

      // t927: the shared limit lives only in 设置 → AI 额度; this page keeps only this AI's own allowance + pause
      Section {
        if mine.isEmpty { Text(T("\(t.name) 还没买过东西。复制上面一句话试试。", "\(t.name) hasn't bought anything yet. Try a sentence above.")).foregroundStyle(.secondary).accessibilityIdentifier("buy.none") }
        ForEach(mine.prefix(10)) { x in Button { picked = x } label: { TxRow(t: x) }.buttonStyle(.plain) }
      } header: { Text(T("\(t.name) 最近买的（点开看收据）", "Recent purchases by \(t.name) (tap for receipt)")) }

      if isSiri, let p = SiriPending.value, capRow?.single == nil { Section {   // t902: apply the allowance picked in 连接 Siri step 1
          Button { Task { msg = await allow.setAgentLimits(id: capRow?.id ?? "siri", name: "Siri", single: p.0, daily: p.1, resume: false) ?? T("Siri 的额度已生效。", "Siri's allowance is on."); if capRow?.single != nil || DemoGuard.active { SiriPending.clear() } } } label: {
            Label(T("用 Face ID 应用你选的额度（每笔 \(p.0) · 每天 \(p.1)）", "Apply your allowance with Face ID (\(p.0) per payment · \(p.1) a day)"), systemImage: "faceid") }.accessibilityIdentifier("siri.applyPending") } }
      Section {   // t899: this AI's own allowance (Siri like every AI), owner sets it freely; saving = one Face ID
        if let c = capRow, c.single != nil || c.daily != nil {
          HStack { Text(T("每笔最多", "Per payment")); Spacer(); Text((c.single ?? "–") + " USDC").monospacedDigit().accessibilityIdentifier("agent.limit.single") }
          HStack { Text(T("每天最多", "Per day")); Spacer(); Text((c.daily ?? "–") + " USDC").monospacedDigit().accessibilityIdentifier("agent.limit.daily") }
        } else { Text(T("还没单独设置：按 设置 → AI 额度。", "Not set yet: Settings → AI allowance applies.")).foregroundStyle(.secondary).accessibilityIdentifier("agent.limit.none") }
        Button { editLimits = true } label: { Label(T("修改 \(t.name) 的额度", "Change \(t.name)'s allowance"), systemImage: "slider.horizontal.3") }.accessibilityIdentifier("agent.limit.edit")
      } header: { Text(T("\(t.name) 的额度", "\(t.name)'s allowance")) } footer: { Text(T("自己随便设。额度内直接付，不用 Face ID；超出才问你。保存时刷一次 Face ID。", "Set it as you like. Within it, payments go through with no Face ID; over it asks you. Saving takes one Face ID.")) }

      if true {
        Section {
          if capRow?.stopped == true {
            Label(T("\(t.name) 的付款已停用", "Payments by \(t.name) are off"), systemImage: "pause.circle.fill").foregroundStyle(Brand.caution)
            Button { Task { let c = capRow; msg = await allow.setAgentLimits(id: c?.id ?? t.kinds.first ?? t.id, name: t.name, single: c?.single ?? c?.daily ?? "1", daily: c?.daily ?? c?.single ?? "1", resume: true) ?? T("已恢复 \(t.name) 的付款。", "Payments by \(t.name) are back on.") } } label: { Label(T("用 Face ID 恢复 \(t.name)", "Resume \(t.name) with Face ID"), systemImage: "faceid") }.accessibilityIdentifier("buy.resume")
          }
          else { Button(role: .destructive) { askStop = true } label: { Label(T("暂停 \(t.name) 的付款", "Pause payments by \(t.name)"), systemImage: "pause.circle") }.accessibilityIdentifier("buy.pause") }
        } footer: { Text(T("只停这一个 AI，其他 AI 和你自己的付款不受影响。", "Only this AI stops; your other AIs and your own payments keep working.")) }
      }

      Section {
        if let c = t.card { Button { AgentLauncher.open(c, m) } label: { Label(T("重新连接 \(t.name)", "Reconnect \(t.name)"), systemImage: "arrow.clockwise") }.foregroundStyle(.secondary).accessibilityIdentifier("buy.reconnect") }
        if t.id == "muse" { Button { MuseLauncher.open(m) } label: { Label(T("重新连接 Muse", "Reconnect Muse"), systemImage: "arrow.clockwise") }.foregroundStyle(.secondary).accessibilityIdentifier("buy.reconnect") }
        Text(isSiri ? T("想马上停止 Siri 付款，用上面的“暂停”。", "To stop Siri payments right now, use Pause above.")
                    : T("想断开：在 \(t.name) 的连接器设置里删掉 Kipurse。想马上停止付款，用上面的“暂停”。", "To disconnect: remove Kipurse in \(t.name)'s connector settings. To stop payments right now, use Pause above."))
          .font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("buy.disconnect")
      } header: { Text(T("连接", "Connection")) }
    }
    .navigationTitle(t.name).navigationBarTitleDisplayMode(.inline)
    .task { if !allow.loaded { await allow.load() } }
    .sheet(item: $picked) { x in TxDetail(t: x, explorer: s.explorer).presentationDetents([.medium, .large]) }
    .sheet(isPresented: $editLimits) { AgentLimitSheet(id: capRow?.id ?? t.kinds.first ?? t.id, name: t.name, single: capRow?.single ?? "", daily: capRow?.daily ?? "").presentationDetents([.large]) }
    .confirmationDialog(T("暂停 \(t.name) 的付款？", "Pause payments by \(t.name)?"), isPresented: $askStop, titleVisibility: .visible) {
      Button(T("暂停", "Pause"), role: .destructive) { Task {
        let row = capRow ?? AgentCapRow(id: t.kinds.first ?? t.id, name: t.name, stopped: false, spentToday: nil)
        msg = await allow.stop(row) ? T("已暂停 \(t.name) 的付款。", "Payments by \(t.name) are paused.") : T("没有成功，请再试一次。", "That didn't work. Please try again.") } }
      Button(T("取消", "Cancel"), role: .cancel) {}
    }
    .alert(msg ?? "", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) { Button(T("好", "OK")) {} }
  }
  private func open(_ u: URL, _ text: String) {
    UIPasteboard.general.string = text; Haptics.success()
    #if DEBUG
    m.lastLaunch = u.absoluteString
    if m.demo != nil { m.toast = AgentBuy.prefills(t.id) ? T("已在 \(t.name) 里填好，点发送", "Filled in \(t.name) — tap send") : T("已复制，粘贴到 \(t.name)", "Copied — paste it in \(t.name)"); return }
    #endif
    UIApplication.shared.open(u) { ok in if !ok, t.id == "grok-bot", let c = t.card { UIApplication.shared.open(c.open) } }
    m.toast = AgentBuy.prefills(t.id) ? T("已在 \(t.name) 里填好，点发送", "Filled in \(t.name) — tap send") : T("已复制，粘贴到 \(t.name)", "Copied — paste it in \(t.name)")
  }
}

/// t899: edit one AI's own allowance (per payment + per day). Same for Siri and every AI; the owner sets any amount; one Face ID saves it.
struct AgentLimitSheet: View {
  @ObservedObject var allow = AllowanceStore.shared
  @Environment(\.dismiss) private var dismiss
  let id: String; let name: String
  @State var single: String; @State var daily: String
  @State private var err: String?; @State private var busy = false
  var body: some View {
    NavigationStack {
      Form {
        Section {
          HStack { Text(T("每笔最多", "Per payment")); TextField("2", text: $single).keyboardType(.decimalPad).multilineTextAlignment(.trailing).accessibilityIdentifier("agent.limit.singleField"); Text("USDC").foregroundStyle(.secondary) }
          HStack { Text(T("每天最多", "Per day")); TextField("10", text: $daily).keyboardType(.decimalPad).multilineTextAlignment(.trailing).accessibilityIdentifier("agent.limit.dailyField"); Text("USDC").foregroundStyle(.secondary) }
        } footer: { Text(T("额度内 \(name) 直接付，不用 Face ID；超出、新收款方会先问你。", "Within this, \(name) pays with no Face ID; over it or a new payee asks you first.")) }
        if let e = err { Section { Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Brand.negative).accessibilityIdentifier("agent.limit.error") } }
        Section { Button { Task { busy = true; err = await allow.setAgentLimits(id: id, name: name, single: single, daily: daily, resume: false); busy = false; if err == nil { Haptics.success(); dismiss() } } } label: {
            Label(T("用 Face ID 保存", "Save with Face ID"), systemImage: "faceid").frame(maxWidth: .infinity) }.disabled(busy).accessibilityIdentifier("agent.limit.save") }
      }
      .scrollDismissesKeyboard(.immediately)
      .navigationTitle(T("\(name) 的额度", "\(name)'s allowance")).navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button(T("取消", "Cancel")) { dismiss() } } }
    }
  }
}
