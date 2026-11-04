import AppIntents
import CoreSpotlight
import SwiftUI
import KipurseCore

/// Apple Intelligence / Siri / Shortcuts: native App Intents. Read-only and the emergency pause run without opening the app;
/// moving money (提现) opens the app and requires Face ID first. There is no "pay a stranger" intent: only the owner's own AI agents pay, within on-chain caps.
private func ownerAPI() throws -> OwnerAPI {
  guard let s = SessionVault.load() else { throw IntentError.notLoggedIn }
  return OwnerAPI(session: s)
}
enum IntentError: Error, CustomLocalizedStringResourceConvertible {
  case notLoggedIn, faceID
  var localizedStringResource: LocalizedStringResource {
    switch self { case .notLoggedIn: return "Open Kipurse and scan the sign-in code first."; case .faceID: return "Face ID failed. Cancelled." }
  }
}

struct BalanceIntent: AppIntent {
  static var title: LocalizedStringResource = "Check Kipurse balance"
  static var description = IntentDescription("Read the AI wallet's USDC balance (read-only).")
  func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    let st = try await ownerAPI().state()
    let txt = T("Kipurse 余额 \(AnswerRules.format(st.balance)) USDC", "Kipurse balance \(AnswerRules.format(st.balance)) USDC") + (st.approvals.isEmpty ? "" : T("，有 \(st.approvals.count) 件事等你批准", ", \(st.approvals.count) waiting for your approval"))
    return .result(value: txt, dialog: IntentDialog(stringLiteral: txt))
  }
}

struct PauseIntent: AppIntent {
  static var title: LocalizedStringResource = "Pause AI payments for 24 hours"
  static var description = IntentDescription("Emergency pause of all AI payments for 24 hours.")
  func perform() async throws -> some IntentResult & ProvidesDialog {
    try await ownerAPI().call("pause", [:])
    return .result(dialog: "All AI payments paused for 24 hours.")
  }
}

struct OpenApprovalsIntent: AppIntent {
  static var title: LocalizedStringResource = "Open Kipurse approvals"
  static var openAppWhenRun = true
  @MainActor func perform() async throws -> some IntentResult { UserDefaults.standard.set("approvals", forKey: "openTab"); return .result() }
}

struct WithdrawIntent: AppIntent {
  static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication   // moves money: never from a locked phone
  static var title: LocalizedStringResource = "Withdraw from Kipurse to my wallet"
  static var description = IntentDescription("Move USDC from the AI wallet back to your own wallet. Requires Face ID.")
  static var openAppWhenRun = true
  @Parameter(title: "Amount (USDC)") var amount: String
  @MainActor func perform() async throws -> some IntentResult & ProvidesDialog {
    if let e = AnswerRules.usdcError("withdraw", amount) { return .result(dialog: IntentDialog(stringLiteral: e)) }
    guard await BiometricGate.confirm(reason: T("提现 \(amount) USDC 到你的钱包", "Withdraw \(amount) USDC to your wallet")) else { throw IntentError.faceID }
    try await ownerAPI().call("withdraw", ["amount": .string(amount)])
    return .result(dialog: IntentDialog(stringLiteral: T("已提交提现 \(amount) USDC。", "Withdrawal of \(amount) USDC submitted.")))
  }
}

// MARK: Mainnet (real money on Base) — Siri / Apple Intelligence

/// Reads the real mainnet state with the phone's read-only session (made by Face ID when the app was opened; 12 h).
/// No Face ID prompt from Siri: if the session is gone, Siri says to open Kipurse once.
enum MainRead {
  static var zh: Bool { Loc.isChinese }
  static func state() async throws -> WalletState {
    do { return try await MainnetSession.state(interactive: false) }
    catch MainnetSession.Failure.needsSignIn { throw MainIntentError.openOnce }
    catch MainnetSession.Failure.noKey { throw MainIntentError.noSigner }
  }
}
enum MainIntentError: Error, CustomLocalizedStringResourceConvertible {
  case openOnce, noSigner, unknownPayee, badAmount
  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .openOnce: return "Open Kipurse and unlock with Face ID once; then you can ask Siri for 12 hours."
    case .noSigner: return "This iPhone isn't a signer of your Kipurse wallet yet."
    case .unknownPayee: return "Siri can only pay saved payees (addresses you've paid before, or your own Coinbase wallet). Pay new addresses in Kipurse."
    case .badAmount: return "That amount isn't valid."
    }
  }
}
struct MainBalanceIntent: AppIntent {
  static var title: LocalizedStringResource = "Check Kipurse balance and limits"
  static var description = IntentDescription("Read the AI wallet's USDC balance, per-payment and daily limits, and end date (read-only).")
  func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog & ShowsSnippetView {
    let s = try await MainRead.state(); let t = SiriAnswers.balance(s, zh: MainRead.zh)
    return .result(value: t, dialog: IntentDialog(stringLiteral: t), view: SiriBalanceSnippet(state: s))
  }
}
struct MainActivityIntent: AppIntent {
  static var title: LocalizedStringResource = "Check recent Kipurse activity"
  static var description = IntentDescription("Read recent payments and balance changes (read-only).")
  func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
    let s = try await MainRead.state(); let t = SiriAnswers.activity(s, zh: MainRead.zh)
    return .result(value: t, dialog: IntentDialog(stringLiteral: t))
  }
}
