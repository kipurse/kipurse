import SwiftUI
import AppIntents
import KipurseCore

/// The ONLY seam between the app and the optional Siri / Spotlight module (App/Assistant, compiled with -DKP_ASSISTANT).
/// Delete App/Assistant and its two lines in project.yml and the app still builds: every hook below is then nil (no Siri, no index).
enum AssistantHooks {
  /// New server state -> refresh entities, Spotlight index and App Shortcut parameters.
  static var stateChanged: (@MainActor (WalletState) -> Void)?
  /// Wipe everything Siri / Spotlight may hold (index, donations, caches). Called by LocalWipe.all().
  static var wipe: (() async -> Void)?
  /// What the module still holds (factory-reset self-check).
  static var remnants: (() -> [String])?
  /// View annotations (on-screen awareness): app object -> entity identifier.
  static var identifier: ((AssistantRef) -> EntityIdentifier?)?
  static var launch: (() -> Void)?
  #if DEBUG
  /// Self-test only: (seed every kind of Siri data and wait until Spotlight has it, count what Spotlight + donations still hold).
  static var selfTest: (seed: () async -> Void, leftover: () async -> String)?
  #endif
  static var installed: Bool { stateChanged != nil }
  /// Siri asked to approve / reject: userInfo ["id": Approval.id, "approve": Bool]. The app shows it and asks for Face ID.
  static let decision = Notification.Name("kp.assistant.decision")
}
enum AssistantRef { case payee(address: String), payment(txHash: String), approval(id: String) }

extension View {
  /// Tags a view with the entity it shows so Siri can act on "this" (iOS 18.4+; no-op without the module).
  func assistantRef(_ r: AssistantRef) -> some View { modifier(AssistantRefModifier(ref: r)) }
}
private struct AssistantRefModifier: ViewModifier {
  let ref: AssistantRef
  func body(content: Content) -> some View {
    if #available(iOS 18.4, *), let id = AssistantHooks.identifier?(ref) { content.appEntityIdentifier(id) } else { content }
  }
}
