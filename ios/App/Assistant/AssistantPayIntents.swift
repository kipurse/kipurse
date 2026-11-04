import AppIntents
import SwiftUI
import KipurseCore

/// Every money / approval action: (1) unlocked phone (.requiresAuthentication), (2) Siri confirmation, (3) opens Kipurse,
/// (4) the in-app screen asks for Face ID. Siri input is untrusted: only saved payees, amounts re-checked, server + chain caps on top.
enum AssistantFlow {
  static var zh: Bool { AssistantStore.zh }
  @MainActor static func pay<I: AppIntent>(_ intent: I, payeeId: String, amount: Double) async throws -> IntentDialog {
    let s = await AssistantStore.fresh()
    #if DEBUG
    let demo = UserDefaults.standard.bool(forKey: "kp.assistant.demo")
    #else
    let demo = false
    #endif
    guard s != nil || demo else { throw MainIntentError.openOnce }   // never decide a payment from a stale cache
    switch AssistantData.checkPay(payeeId: payeeId, amount: amount, payees: AssistantStore.payees, state: s, zh: zh) {
    case .unknownPayee: throw MainIntentError.unknownPayee
    case .badAmount: throw MainIntentError.badAmount
    case .problem(let p): return IntentDialog(stringLiteral: p)
    case .ok(let p, let a):
      if !demo, let d = try await siriAgentPay(intent, address: p.address, name: p.display, amount: a, ask: !SiriSkip.inside(a, s)) { return d }
      let q = zh ? "付 \(AnswerRules.format(a)) USDC 给 \(p.display)？下一步在 Kipurse 里用 Face ID 确认。" : "Pay \(AnswerRules.format(a)) USDC to \(p.display)? You'll confirm with Face ID in Kipurse."
      try await confirm(intent, .pay, q)
      try await foreground(intent, zh ? "打开 Kipurse 用 Face ID 确认" : "Open Kipurse to confirm with Face ID")
      PayDraftCenter.shared.draft = PayDraft(amount: a, payee: SiriAnswers.Payee(address: p.address, name: p.label))
      return IntentDialog(stringLiteral: zh ? "已打开 Kipurse，请核对后用 Face ID 确认。" : "Opened Kipurse — check it and confirm with Face ID.")
    }
  }
  /// Siri = a free, server-authorized agent (like Claude / Grok Bot / Muse): the server applies the allowances, trust list,
  /// Siri's own cap / stop and the pause. Inside the allowance it pays; otherwise the owner gets the normal Face ID push.
  /// No on-chain setup, no fee to enable. nil = server route unavailable -> fall back to the in-app Face ID confirm.
  @MainActor static func siriAgentPay<I: AppIntent>(_ intent: I, address: String, name: String, amount: Int64, ask: Bool = true) async throws -> IntentDialog? {
    let amt = AnswerRules.format(amount)
    let q = zh ? "让 Siri 付 \(amt) USDC 给 \(name)？在零花钱额度内会直接付，超出会推送到手机让你用 Face ID 批准。" : "Have Siri pay \(amt) USDC to \(name)? Inside your allowance it pays now; otherwise you'll get a Face ID request."
    // Handbook §4.1: a saved (trusted / remembered) payee inside the allowance pays without an extra confirmation; the server still enforces every cap.
    if ask { try await confirm(intent, .pay, q) }
    let body: [String: Any] = ["purpose": "daily", "item": zh ? "Siri 付款给 \(name)" : "Siri payment to \(name)", "merchant": name, "to": address,
                               "amount": amt, "user_request": zh ? "Siri：付 \(amt) USDC 给 \(name)" : "Siri: pay \(amt) USDC to \(name)",
                               "idempotencyKey": "siri-" + UUID().uuidString, "lang": zh ? "zh" : "en"]
    guard let (st, j) = try? await MainnetSession.authedPost("siri/buy", body), st == 200 else { return nil }
    return IntentDialog(stringLiteral: SiriAgentAnswer.text(j, zh: zh))
  }
  @MainActor static func decide<I: AppIntent>(_ intent: I, _ a: ApprovalEntity, approve: Bool) async throws -> IntentDialog {
    let list = (await AssistantStore.fresh())?.approvals ?? AssistantStore.lastState?.approvals ?? []
    guard list.contains(where: { $0.id == a.id }) else { return IntentDialog(stringLiteral: zh ? "这件事已经不在待批准里了。" : "That request is no longer pending.") }
    let q = approve ? (zh ? "批准「\(a.title)」？下一步在 Kipurse 里用 Face ID 确认。" : "Approve “\(a.title)”? You'll confirm with Face ID in Kipurse.")
                    : (zh ? "拒绝「\(a.title)」？下一步在 Kipurse 里用 Face ID 确认。" : "Reject “\(a.title)”? You'll confirm with Face ID in Kipurse.")
    try await confirm(intent, approve ? .set : .do, q)
    try await foreground(intent, zh ? "打开 Kipurse 用 Face ID 确认" : "Open Kipurse to confirm with Face ID")
    NotificationCenter.default.post(name: AssistantHooks.decision, object: nil, userInfo: ["id": a.id, "approve": approve])
    return IntentDialog(stringLiteral: zh ? "已打开 Kipurse，请用 Face ID 确认。" : "Opened Kipurse — confirm with Face ID.")
  }
  static func confirm<I: AppIntent>(_ i: I, _ action: ConfirmationActionName, _ text: String) async throws {
    if #available(iOS 18.0, *) { try await i.requestConfirmation(actionName: action, dialog: IntentDialog(stringLiteral: text)) }
    else { try await i.requestConfirmation(result: .result(dialog: IntentDialog(stringLiteral: text)), confirmationActionName: action) }
  }
  static func foreground<I: AppIntent>(_ i: I, _ text: String) async throws {
    if #available(iOS 26.0, *) { try await i.continueInForeground(IntentDialog(stringLiteral: text), alwaysConfirm: false) }
    else if let f = i as? any ForegroundContinuableIntent { try await f.requestToContinueInForeground(IntentDialog(stringLiteral: text)) }
  }
}

/// Existing phrase "用 Kipurse 付款": asks for anything missing.
struct StartPaymentIntent: AppIntent, ForegroundContinuableIntent {
  static var title: LocalizedStringResource = "Start a Kipurse payment"
  static var description = IntentDescription("Pick a payee and amount. Within Siri's allowance it pays a saved payee; otherwise Kipurse asks for Face ID.")
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Amount (USDC)", requestValueDialog: "How much USDC?") var amount: Double?
  @Parameter(title: "Payee", requestValueDialog: "Pay whom?") var payee: PayeeEntity?
  static var parameterSummary: some ParameterSummary { Summary("Pay \(\.$amount) USDC to \(\.$payee)") }
  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
    let payee: PayeeEntity; if let p = self.payee { payee = p } else { payee = try await $payee.requestValue("Pay whom?") }
    let amount: Double; if let v = self.amount { amount = v } else { amount = try await $amount.requestValue("How much USDC?") }
    return .result(dialog: try await AssistantFlow.pay(self, payeeId: payee.id, amount: amount))
  }
}
/// "用 Kipurse 付给 楼下咖啡店 5 块" — both parameters, so Siri can fill them from one sentence.
struct PayIntent: AppIntent, ForegroundContinuableIntent {
  static var title: LocalizedStringResource = "Pay a payee with Kipurse"
  static var description = IntentDescription("Pay a saved payee. Within Siri's allowance it pays; over it or a new payee asks for Face ID.")
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Payee", requestValueDialog: "Pay whom?") var payee: PayeeEntity
  @Parameter(title: "Amount (USDC)", requestValueDialog: "How much USDC?") var amount: Double
  static var parameterSummary: some ParameterSummary { Summary("Pay \(\.$amount) USDC to \(\.$payee)") }
  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog { .result(dialog: try await AssistantFlow.pay(self, payeeId: payee.id, amount: amount)) }
}
/// "把上次那笔再付一次": newest settled payment (or the one Siri picked), same amount, same saved payee.
struct RepeatPaymentIntent: AppIntent, ForegroundContinuableIntent {
  static var title: LocalizedStringResource = "Repeat a Kipurse payment"
  static var description = IntentDescription("Repeat the last (or chosen) payment: same payee, same amount, confirmed with Face ID in Kipurse.")
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Payment") var payment: PaymentEntity?
  static var parameterSummary: some ParameterSummary { Summary("Pay again: \(\.$payment)") }
  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
    _ = await AssistantStore.fresh()
    let p = payment.flatMap { e in AssistantStore.payments.first { $0.id == e.id } } ?? AssistantData.lastRepeatable(AssistantStore.payments)
    guard let p else { return .result(dialog: IntentDialog(stringLiteral: AssistantFlow.zh ? "还没有可以重复的付款。" : "No payment to repeat yet.")) }
    return .result(dialog: try await AssistantFlow.pay(self, payeeId: p.payeeId, amount: Double(p.amount) / 1_000_000))
  }
}
/// Local label only (on this phone): no money, no server. Untrusted text is validated (no addresses / long hex).
struct AddPayeeNicknameIntent: AppIntent {
  static var title: LocalizedStringResource = "Name a Kipurse payee"
  static var description = IntentDescription("Give a saved payee an easy name (kept on this phone only).")
  @Parameter(title: "Payee") var payee: PayeeEntity
  @Parameter(title: "Name") var nickname: String
  static var parameterSummary: some ParameterSummary { Summary("Call \(\.$payee) \(\.$nickname)") }
  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let n = AssistantData.validNickname(nickname) else { throw $nickname.needsValueError(AssistantFlow.zh ? "名字要 1 到 24 个字，不能是地址。叫什么？" : "Use 1–24 characters, not an address. What name?") }
    guard let p = AssistantStore.payees.first(where: { $0.id == payee.id }) else { throw MainIntentError.unknownPayee }
    AssistantStore.setNickname(n, for: p.address); AssistantStore.update(nil)
    return .result(dialog: IntentDialog(stringLiteral: AssistantFlow.zh ? "好的，…\(p.last4) 以后叫「\(n)」。" : "OK, …\(p.last4) is now “\(n)”."))
  }
}
struct ApproveIntent: AppIntent, ForegroundContinuableIntent {
  static var title: LocalizedStringResource = "Approve a Kipurse request"
  static var description = IntentDescription("Approve a pending request. Asks you to confirm, then Kipurse opens for Face ID.")
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Approval", requestValueDialog: "Approve which one?") var approval: ApprovalEntity
  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog { .result(dialog: try await AssistantFlow.decide(self, approval, approve: true)) }
}
struct RejectIntent: AppIntent, ForegroundContinuableIntent {
  static var title: LocalizedStringResource = "Reject a Kipurse request"
  static var description = IntentDescription("Reject a pending request. Asks you to confirm, then Kipurse opens for Face ID.")
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
  @Parameter(title: "Approval", requestValueDialog: "Reject which one?") var approval: ApprovalEntity
  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog { .result(dialog: try await AssistantFlow.decide(self, approval, approve: false)) }
}

struct KipurseShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: MainBalanceIntent(), phrases: ["Check \(.applicationName) balance", "\(.applicationName) balance", "How much is in \(.applicationName)", "\(.applicationName) limits", "What's my \(.applicationName) balance", "Show \(.applicationName) balance", "\(.applicationName) how much money", "Open \(.applicationName) balance"], shortTitle: "Balance & limits", systemImageName: "dollarsign.circle")
    AppShortcut(intent: MainActivityIntent(), phrases: ["Recent \(.applicationName) payments", "\(.applicationName) spending summary", "\(.applicationName) activity", "What did I spend on \(.applicationName)", "\(.applicationName) history"], shortTitle: "Recent activity", systemImageName: "list.bullet.rectangle")
    AppShortcut(intent: StartPaymentIntent(), phrases: ["Pay with \(.applicationName)", "Make a payment with \(.applicationName)", "\(.applicationName) payment", "Send money with \(.applicationName)", "\(.applicationName) pay", "Start a \(.applicationName) payment"], shortTitle: "Start payment", systemImageName: "paperplane.circle")
    AppShortcut(intent: PayIntent(), phrases: ["Pay \(\.$payee) with \(.applicationName)", "\(.applicationName) pay \(\.$payee)"], shortTitle: "Pay payee", systemImageName: "person.crop.circle.badge.checkmark")
    AppShortcut(intent: RepeatPaymentIntent(), phrases: ["Repeat my last \(.applicationName) payment", "Pay again with \(.applicationName)"], shortTitle: "Pay again", systemImageName: "arrow.clockwise.circle")
    AppShortcut(intent: ApproveIntent(), phrases: ["Approve \(.applicationName) request", "\(.applicationName) approve"], shortTitle: "Approve", systemImageName: "checkmark.seal.fill")
    AppShortcut(intent: PauseIntent(), phrases: ["Pause \(.applicationName)", "Stop \(.applicationName) AI payments"], shortTitle: "Pause AI", systemImageName: "pause.circle")
    AppShortcut(intent: OpenApprovalsIntent(), phrases: ["\(.applicationName) approvals"], shortTitle: "Approval", systemImageName: "checkmark.seal")
    AppShortcut(intent: WithdrawIntent(), phrases: ["\(.applicationName) withdraw"], shortTitle: "Withdraw", systemImageName: "arrow.up.circle")
  }
}

