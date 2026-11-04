import SwiftUI
import CryptoKit
import KipurseCore

/// ONE LIMIT (owner 2026-10-27 t592u): the wallet's AI payment limit (home card) is the ONLY limit. This screen shows the AI's
/// requests (approve with Face ID), approved renewals, the per-AI stop buttons and spending sorted AUTOMATICALLY into
/// categories (日常/学习/宣传推广/开发/工作/其他). Categories are labels only, never limits. Approving = the phone signer signs the exact request text (the server re-checks the signature).
/// Stopping an allowance or one AI only needs Face ID on the phone (it can only make things safer).
struct AllowanceItem: Identifiable { let id: String; let purpose: String; let name: String; let line: String; let leftToday: String; let leftMonth: String; let kind: String }
struct ApprovalReq: Identifiable { let id: String; let by: String; let lines: [String]; let digest: String; let signText: String; let reason: String; let userRequest: String }
struct AgentCapRow: Identifiable { let id: String; let name: String; let stopped: Bool; let spentToday: String?; var single: String? = nil; var daily: String? = nil; var monthly: String? = nil }   // t899: this AI's own allowance
struct DefaultAllowance: Identifiable { var id: String { purpose }; let purpose: String; let name: String; let single: String; let daily: String; let monthly: String; var on: Bool }

@MainActor final class AllowanceStore: ObservableObject {
  static let shared = AllowanceStore()
  @Published var items: [AllowanceItem] = []
  @Published var approvals: [ApprovalReq] = []
  @Published var agents: [AgentCapRow] = []
  @Published var defaults: [DefaultAllowance] = []
  @Published var overall: String?
  @Published var loaded = false
  @Published var open = false
  @Published var reportLines: [(String, String)] = []
  @Published var reportTotal = ""
  @Published var csv = ""
  private var demoFilled = false

  static func purposeName(_ k: String) -> String {
    switch k { case "daily": return T("日常", "Everyday"); case "study": return T("学习", "Study"); case "promo": return T("宣传推广", "Promotion"); case "dev": return T("开发", "Development")
    case "work": return T("工作", "Work"); case "subscription": return T("订阅续费", "Subscriptions"); case "transfer": return T("转账给熟人", "Friends & family")
    case "other": return T("其他", "Other"); case "all": return T("AI 付款上限", "AI payment limit"); default: return k }
  }
  private static func s(_ v: Any?) -> String { if let x = v as? String { return x }; if let n = v as? NSNumber { return n.stringValue }; return "" }
  /// Owner 2026-10-27 14:23: no monthly cap; the limit is per payment / per day / TOTAL.
  static func limitLine(single: String, daily: String, total: String) -> String { let p = { (x: String) in Double(x).map(Beginner.plainAmount) ?? x }; let single = p(single), daily = p(daily), total = p(total); return T("每笔 \(single) · 每天 \(daily) · 总额 \(total) USDC", "\(single) per payment · \(daily) a day · \(total) total (USDC)") }
  private static func usdc(_ atomic: Any?) -> String { AnswerRules.format(Int64(s(atomic)) ?? 0) }
  private static func human(_ v: Any?) -> String { let h = v as? [String: Any]; return T(s(h?["zh"]), s(h?["en"])) }
  static func approval(_ p: [String: Any]) -> ApprovalReq? {
    guard let id = p["id"] as? String, let d = p["digest"] as? String, let t = p["signText"] as? String else { return nil }
    let lines = (p["items"] as? [[String: Any]] ?? []).map { human($0["human"]) }
    let by = s(p["by"]).replacingOccurrences(of: "agent:", with: "")
    return ApprovalReq(id: id, by: by == "owner" ? T("你自己", "You") : by, lines: lines, digest: d, signText: t, reason: s(p["reason"]), userRequest: s(p["user_request"]))
  }
  func parse(_ j: [String: Any]) {
    items = (j["allowances"] as? [[String: Any]] ?? []).compactMap { m in
      guard let id = m["id"] as? String else { return nil }; let u = m["usage"] as? [String: Any]
      return AllowanceItem(id: id, purpose: Self.s(m["purpose"]), name: Self.purposeName(Self.s(m["purpose"])), line: Self.human(m["human"]), leftToday: Self.s(u?["leftToday"]), leftMonth: Self.s(u?["leftMonth"]), kind: Self.s(m["kind"])) }
    approvals = (j["proposals"] as? [[String: Any]] ?? []).compactMap(Self.approval)
    agents = (j["agents"] as? [[String: Any]] ?? []).compactMap { a in guard let id = a["id"] as? String else { return nil }
      return AgentCapRow(id: id, name: Self.s(a["name"]).isEmpty ? id : Self.s(a["name"]), stopped: a["stopped"] as? Bool ?? false, spentToday: a["spentToday"] as? String, single: a["single"] as? String, daily: a["daily"] as? String, monthly: a["monthly"] as? String) }
    if let o = j["overall"] as? [String: Any] { overall = Self.limitLine(single: Self.usdc(o["single"]), daily: Self.usdc(o["daily"]), total: Self.usdc(o["total"] ?? o["monthly"])) } else { overall = nil }
    defaults = (j["defaults"] as? [[String: Any]] ?? []).map { d in DefaultAllowance(purpose: Self.s(d["purpose"]), name: Self.purposeName(Self.s(d["purpose"])), single: Self.s(d["single"]), daily: Self.s(d["daily"]), monthly: Self.s(d["monthly"]), on: d["on"] as? Bool ?? false) }
    loaded = true
  }
  func load() async {
    if DemoGuard.active { if !demoFilled { demo() }; return }
    guard let (c, j) = try? await SafetyPanel.get("safety/mandates"), c == 200 else { return }
    parse(j)
  }
  func loadReport() async {
    if DemoGuard.active { reportTotal = "7"; reportLines = [(Self.purposeName("promo"), "3"), (Self.purposeName("dev"), "2.3"), (Self.purposeName("study"), "1.2"), (Self.purposeName("other"), "0.5")]; csv = "date,category,item,amount_usdc\n"; return }
    guard let (c, j) = try? await SafetyPanel.get("safety/report?period=month&format=csv"), c == 200 else { return }
    reportTotal = Self.s(j["total"]); csv = Self.s(j["csv"])
    if let c = j["byCategory"] as? [[String: Any]] { reportLines = c.map { (Self.purposeName(Self.s($0["purpose"])), Self.s($0["amount"])) } }
    else { reportLines = (j["byPurpose"] as? [[String: Any]] ?? []).map { (Self.s($0["purposeName"]), Self.s($0["amount"])) } }
  }
  /// The phone checks that what it shows is what it signs: SHA-256(signText) == digest, and the text names THIS wallet.
  static func verified(_ a: ApprovalReq) -> [UInt8]? {
    let d = [UInt8](SHA256.hash(data: Data(a.signText.utf8)))
    guard Hex.encode(d).lowercased() == a.digest.lowercased(), a.signText.hasPrefix("Kipurse allowance approval v1\nwallet:" + Operator.wallet.lowercased() + "\nid:" + a.id + "\n") else { return nil }
    return d
  }
  /// Face ID (Secure Enclave key) -> signature -> server. Returns an error text or nil.
  func approve(_ a: ApprovalReq) async -> String? {
    if DemoGuard.active { DemoGuard.say(); approvals.removeAll { $0.id == a.id }; return nil }
    guard let d = Self.verified(a) else { return T("服务器给的内容和手机算出的不一致，已停止。", "Server data doesn't match what the phone computed. Stopped.") }
    guard let k = PhoneKey.existing() else { return T("这台 iPhone 还没开启 Face ID 批准：设置 → Face ID 批准。", "Face ID approvals aren't on for this iPhone yet: Settings → Face ID approvals.") }
    do { let (r, s) = try PhoneKey.sign(d, key: k)
      let (c, _) = try await MainnetSession.authedPost("safety/mandates/approve", ["id": a.id, "r": Hex.encode(r), "s": Hex.encode(s)])
      if c == 200 { Haptics.success(); await load(); return nil }
      return c == 403 ? T("确认不对，没有生效。", "The signature didn't match. Nothing changed.") : T("没有成功（\(c)），请再试一次。", "That didn't work (\(c)). Please try again.")
    } catch { return T("已取消。", "Canceled.") }
  }
  func reject(_ a: ApprovalReq) async { if DemoGuard.active { approvals.removeAll { $0.id == a.id }; return }
    _ = try? await MainnetSession.authedPost("safety/mandates/reject", ["id": a.id]); await load() }
  func revoke(_ i: AllowanceItem) async -> Bool { guard await SafetyPanel.faceID(T("停用这项自动续费", "Turn off this renewal")) else { return false }
    if DemoGuard.active { items.removeAll { $0.id == i.id }; return true }
    let ok = ((try? await MainnetSession.authedPost("safety/mandates/revoke", ["id": i.id]))?.0 ?? 0) == 200; await load(); return ok }
  func stop(_ a: AgentCapRow) async -> Bool { guard await SafetyPanel.faceID(T("停用这个 AI 的付款", "Turn off payments for this AI")) else { return false }
    if DemoGuard.active { agents = agents.map { $0.id == a.id ? AgentCapRow(id: a.id, name: a.name, stopped: true, spentToday: a.spentToday) : $0 }; return true }
    let ok = ((try? await MainnetSession.authedPost("safety/agents/stop", ["agentId": a.id]))?.0 ?? 0) == 200; await load(); return ok }
  /// t899: set one AI's own allowance (per payment + per day; Siri like every AI). ONE Face ID signs it; resume also turns a paused AI back on.
  func setAgentLimits(id: String, name: String, single: String, daily: String, resume: Bool) async -> String? {
    if let p = AgentLimits.problem(single: single, daily: daily, zh: Loc.isChinese) { return p }
    let cur = agents.first { $0.id == id }
    if DemoGuard.active { DemoGuard.say()
      let row = AgentCapRow(id: id, name: name, stopped: resume ? false : (cur?.stopped ?? false), spentToday: cur?.spentToday ?? "0", single: single, daily: daily, monthly: cur?.monthly)
      if agents.contains(where: { $0.id == id }) { agents = agents.map { $0.id == id ? row : $0 } } else { agents.append(row) }
      return nil }
    return await draftAndApprove([AgentLimits.item(agentId: id, single: single, daily: daily, monthly: cur?.monthly, resume: resume)])
  }
  /// Draft on the server (owner), then approve it with ONE Face ID.
  func draftAndApprove(_ items: [[String: Any]]) async -> String? {
    if DemoGuard.active { DemoGuard.say(); demoFilled = true
      self.items = items.map { d in let p = Self.s(d["purpose"]); return AllowanceItem(id: "demo-" + p, purpose: p, name: Self.purposeName(p), line: T("每笔最多 \(Self.s(d["single"]))，每天 \(Self.s(d["daily"]))，总额 \(Self.s(d["monthly"])) USDC", "Up to \(Self.s(d["single"])) per payment, \(Self.s(d["daily"])) a day, \(Self.s(d["monthly"])) total"), leftToday: Self.s(d["daily"]), leftMonth: Self.s(d["monthly"]), kind: "allowance") }
      if let a = agents.first(where: { $0.stopped }) { agents = agents.map { $0.id == a.id ? AgentCapRow(id: a.id, name: a.name, stopped: false, spentToday: a.spentToday) : $0 } }
      return nil }
    guard let (c, j) = try? await MainnetSession.authedPost("safety/mandates/draft", ["items": items]), c == 200, let a = Self.approval(j) else { return T("没有成功，请再试一次。", "That didn't work. Please try again.") }
    return await approve(a)
  }
  private func demo() {
    overall = Self.limitLine(single: "5", daily: "50", total: "500")
    let emptyDemo = CommandLine.arguments.contains("main-empty") || CommandLine.arguments.contains("empty")   // t927: an empty demo has nothing waiting
    approvals = emptyDemo ? [] : [ApprovalReq(id: "demo-apr", by: "Claude", lines: [T("只这一次：付 Example Shop 8 USDC（超出 AI 付款上限）", "One time only: pay Example Shop 8 USDC (over your AI payment limit)")], digest: "", signText: "", reason: "MANDATE_OVER_SINGLE", userRequest: T("把我的新游戏拿去竞价宣传", "Take my new game to bid for promotion"))]
    agents = [AgentCapRow(id: "claude", name: "Claude", stopped: false, spentToday: "1.2"), AgentCapRow(id: "grok-bot", name: "Grok", stopped: false, spentToday: "0"),
              AgentCapRow(id: "siri", name: "Siri", stopped: CommandLine.arguments.contains("-kpSiriPaused"), spentToday: "0.5", single: "2", daily: "10")]
    defaults = []
    loaded = true
  }
}

/// Home card: only pending AI requests (the limit itself lives on the AI payment limit card).
struct AllowancesCard: View {
  @ObservedObject var st = AllowanceStore.shared
  var body: some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: 0)   // keeps .task running while the card is still empty
      if !st.approvals.isEmpty {
        Button { st.open = true } label: {
          HStack { Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) { Text(T("AI 额度申请 \(st.approvals.count) 件", "AI allowance requests: \(st.approvals.count)")).font(.subheadline.weight(.semibold))
              Text(st.approvals.first?.lines.first ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            Spacer(); Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
        }.foregroundStyle(.primary).padding(12).background(Color.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 14)).accessibilityIdentifier("allow.card.pending")
      }
    }.task { await st.load() }
  }
}

struct AllowancesSheet: View {
  @ObservedObject var st = AllowanceStore.shared
  @State private var msg: String?
  @State private var busy = false
  var body: some View {
    NavigationStack {
      List {
        if !st.approvals.isEmpty {
          Section(T("等你同意", "Waiting for you")) {
            ForEach(st.approvals) { a in
              VStack(alignment: .leading, spacing: 6) {
                ForEach(a.lines, id: \.self) { Text($0).font(.subheadline.weight(.semibold)) }
                Text(T("申请的 AI：", "Asked by: ") + a.by).font(.caption).foregroundStyle(.secondary)
                if !a.userRequest.isEmpty { Text(T("你说的：“", "You said: \u{201C}") + a.userRequest + T("”", "\u{201D}")).font(.caption).foregroundStyle(.secondary) }
                HStack {
                  Button { Task { busy = true; msg = await st.approve(a); busy = false } } label: { Label(T("用 Face ID 同意", "Approve with Face ID"), systemImage: "faceid") }.buttonStyle(.borderedProminent).disabled(busy).accessibilityIdentifier("allow.pending.approve")
                  Button(T("拒绝", "Decline"), role: .destructive) { Task { await st.reject(a) } }.buttonStyle(.bordered).accessibilityIdentifier("allow.pending.reject")
                }
              }.padding(.vertical, 4)
            }
          }
        }
        Section { if let o = st.overall { Text(o).font(.subheadline.monospacedDigit().weight(.semibold)).accessibilityIdentifier("allow.limit") }
            else { Text(T("还没读到上限。", "Limit not loaded yet.")).font(.caption).foregroundStyle(.secondary) } }
          header: { Text(T("AI 付款上限（唯一的上限）", "AI payment limit (your only limit)")) }
          footer: { Text(T("上限内 AI 自己付；超出就发到你手机，用 Face ID 同意一次。在首页“AI 付款上限”里修改。骗子地址、冒充地址照样拦，10 分钟可取消和大额暂扣的规则一直有效。", "Within the limit the AI pays by itself; over it, it goes to your phone for one Face ID. Change it under AI payment limit on Home. Scam and lookalike addresses are still blocked; the 10-minute cancel and large-payment hold always apply.")).accessibilityIdentifier("allow.limit.footer") }
        if !st.items.isEmpty {
          Section(T("你批准过的自动续费", "Renewals you approved")) {
            ForEach(st.items) { i in
              VStack(alignment: .leading, spacing: 3) { Text(i.line).font(.subheadline) }
                .swipeActions { Button(T("停用", "Turn off"), role: .destructive) { Task { _ = await st.revoke(i) } } }.accessibilityIdentifier("allow.row.\(i.purpose)")
            }
          }
        }
        if !st.agents.isEmpty {
          Section { ForEach(st.agents) { a in HStack { VStack(alignment: .leading) { Text(a.name).font(.subheadline); if let t = a.spentToday { Text(T("今天花了 \(t) USDC", "Spent today \(t) USDC")).font(.caption).foregroundStyle(.secondary) } }
                Spacer()
                if a.stopped { Text(T("已停用", "Off")).font(.caption.weight(.semibold)).foregroundStyle(Brand.negative).accessibilityIdentifier("allow.agent.stopped") }
                else { Button(T("停用", "Turn off"), role: .destructive) { Task { _ = await st.stop(a) } }.buttonStyle(.bordered).accessibilityIdentifier("allow.agent.stop") } } } }
            header: { Text(T("每个 AI", "Each AI")) } footer: { Text(T("停用后这个 AI 立刻不能再付款，其他 AI 不受影响。", "A turned-off AI can't pay anymore; the others keep working.")) }
        }
        Section { 
          if st.reportLines.isEmpty { Text(T("还没有花费。", "Nothing spent yet.")).font(.caption).foregroundStyle(.secondary) }
          ForEach(st.reportLines, id: \.0) { l in LabeledContent(l.0, value: l.1 + " USDC") }
          if !st.reportTotal.isEmpty { LabeledContent(T("合计", "Total"), value: st.reportTotal + " USDC").font(.subheadline.weight(.semibold)) }
          if !st.csv.isEmpty { ShareLink(item: st.csv, preview: SharePreview(T("Kipurse 花费明细.csv", "Kipurse spending.csv"))) { Label(T("导出明细（带类别和收据）", "Export (with category and receipts)"), systemImage: "square.and.arrow.up") }.accessibilityIdentifier("allow.export") }
        } header: { Text(T("本月花在哪（自动分类）", "This month (sorted automatically)")) } footer: { Text(T("类别由 AI 按用途和商家自动分，只用来看账，不限制付款。", "Categories are picked automatically from the purpose and merchant. They're only for your records and never limit a payment.")) }
      }
      .navigationTitle(T("AI 付款和花费", "AI payments & spending"))
      .toolbar { Button(T("完成", "Done")) { st.open = false }.accessibilityIdentifier("allow.close") }
      .task { await st.load(); await st.loadReport() }
      .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in st.open = false }
      .alert(msg ?? "", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) { Button(T("好", "OK")) {} }
    }
  }
}
