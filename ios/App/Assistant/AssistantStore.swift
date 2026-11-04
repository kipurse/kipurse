import Foundation
import AppIntents
import CoreSpotlight
import Intents
import KipurseCore

/// Optional Siri / Spotlight module (app layer, removable). Local data lives under "kp.assistant.*" keys only and is wiped by LocalWipe.
/// Nothing here can move money: payments and approvals always end on the in-app Face ID screens; server + chain caps still apply.
enum AssistantModule {
  static func install() {
    AssistantHooks.stateChanged = { s in AssistantStore.update(s) }
    AssistantHooks.wipe = { await AssistantStore.wipe() }
    AssistantHooks.remnants = { AssistantStore.remnants() }
    AssistantHooks.identifier = { AssistantStore.identifier($0) }
    AssistantHooks.launch = { KipurseShortcuts.updateAppShortcutParameters() }
    #if DEBUG
    AssistantHooks.selfTest = (seed: { await AssistantStore.seedForSelfTest() }, leftover: { await AssistantStore.leftover() })
    #endif
    UserDefaults.standard.removeObject(forKey: "kp.siri.payees")   // pre-module cache held full addresses as ids
  }
}

enum AssistantStore {
  static let d = UserDefaults.standard
  static let keys = ["kp.assistant.salt", "kp.assistant.nicknames", "kp.assistant.payees", "kp.assistant.payments", "kp.siri.payees"]
  static var zh: Bool { Loc.isChinese }
  /// Per-install random salt: entity ids can't be linked to an address, and change after a wipe.
  static var salt: String {
    if let s = d.string(forKey: "kp.assistant.salt") { return s }
    let s = UUID().uuidString + UUID().uuidString; d.set(s, forKey: "kp.assistant.salt"); return s
  }
  static var nicknames: [String: String] { (d.dictionary(forKey: "kp.assistant.nicknames") as? [String: String]) ?? [:] }
  static func setNickname(_ n: String, for address: String) { var m = nicknames; m[address.lowercased()] = n; d.set(m, forKey: "kp.assistant.nicknames") }

  static var payees: [AssistantData.Payee] { load("kp.assistant.payees") ?? AssistantData.payees(nil, owner: Operator.ownerAccount, nicknames: nicknames, salt: salt, zh: zh) }
  static var payments: [AssistantData.Payment] { load("kp.assistant.payments") ?? [] }
  static var lastState: WalletState?
  static var indexing: Task<Void, Never>?
  private static func load<T: Decodable>(_ k: String) -> T? { d.data(forKey: k).flatMap { try? JSONDecoder().decode(T.self, from: $0) } }
  private static func save<T: Encodable>(_ v: T, _ k: String) { if let x = try? JSONEncoder().encode(v) { d.set(x, forKey: k) } }

  /// Server state -> entities -> Spotlight (only labels, last 4 and payment amounts; never balances or addresses).
  @MainActor static func update(_ s: WalletState?) {
    if let s { lastState = s }
    let p = AssistantData.payees(s ?? lastState, owner: Operator.ownerAccount, nicknames: nicknames, salt: salt, zh: zh)
    let y = AssistantData.payments(s ?? lastState, payees: p, salt: salt)
    let changed = p != payees || y != payments
    save(p, "kp.assistant.payees"); save(y, "kp.assistant.payments")
    guard changed else { return }
    let prev = indexing
    indexing = Task {
      await prev?.value
      let idx = CSSearchableIndex.default()
      try? await idx.deleteAppEntities(ofType: PayeeEntity.self); try? await idx.deleteAppEntities(ofType: PaymentEntity.self)
      try? await idx.indexAppEntities(p.map(PayeeEntity.init)); try? await idx.indexAppEntities(y.map(PaymentEntity.init))
      KipurseShortcuts.updateAppShortcutParameters()
    }
  }
  /// Fresh state when the phone's read-only session is alive; else the last cache (Siri can still offer choices, never pay from it).
  static func fresh() async -> WalletState? {
    #if DEBUG
    if d.bool(forKey: "kp.assistant.demo") { return lastState }
    #endif
    if let s = try? await MainRead.state() { await update(s); return s }
    return nil
  }
  static func wipe() async {
    await indexing?.value; indexing = nil   // never let a late index write land after the wipe
    let idx = CSSearchableIndex.default()
    try? await idx.deleteAppEntities(ofType: PayeeEntity.self); try? await idx.deleteAppEntities(ofType: PaymentEntity.self)
    try? await idx.deleteAllSearchableItems()
    for t in allIntentTypes { _ = try? await IntentDonationManager.shared.deleteDonations(matching: .intentType(t)) }
    try? await INInteraction.deleteAll()
    for k in keys { d.removeObject(forKey: k) }
    lastState = nil
    KipurseShortcuts.updateAppShortcutParameters()
  }
  static var allIntentTypes: [any AppIntent.Type] {
    [BalanceIntent.self, PauseIntent.self, OpenApprovalsIntent.self, WithdrawIntent.self, MainBalanceIntent.self, MainActivityIntent.self, StartPaymentIntent.self,
     PayIntent.self, RepeatPaymentIntent.self, AddPayeeNicknameIntent.self, ApproveIntent.self, RejectIntent.self]
  }
  #if DEBUG
  @MainActor static func seedForSelfTest() async {
    update(AppModelDemo.mainState()); if let p = payees.last { setNickname(T("测试店", "Test shop"), for: p.address) }; update(nil)
    await indexing?.value
    _ = try? await IntentDonationManager.shared.donate(intent: MainBalanceIntent())
  }
  /// Items of this app still in Spotlight (payees + payments) and donations still on record.
  static func leftover() async -> String {
    let n = await spotlightCount()
    var don = 0; for t in allIntentTypes { don += (try? await IntentDonationManager.shared.deleteDonations(matching: .intentType(t)).count) ?? 0 }
    return "spotlight=\(n) donations=\(don)"
  }
  static func spotlightCount() async -> Int {
    await withCheckedContinuation { c in
      let q = CSSearchQuery(queryString: "title == \"*\"", queryContext: { let x = CSSearchQueryContext(); x.fetchAttributes = ["title"]; return x }())
      var n = 0; q.foundItemsHandler = { n += $0.count }; q.completionHandler = { _ in c.resume(returning: n) }; q.start()
    }
  }
  #endif
  static func remnants() -> [String] { keys.filter { d.object(forKey: $0) != nil }.map { "Siri: \($0)" } }
  static func identifier(_ r: AssistantRef) -> EntityIdentifier? {
    switch r {
    case .payee(let a): return payees.first { $0.address.lowercased() == a.lowercased() }.map { EntityIdentifier(for: PayeeEntity.self, identifier: $0.id) }
    case .payment(let tx): return payments.first { $0.txHash?.lowercased() == tx.lowercased() }.map { EntityIdentifier(for: PaymentEntity.self, identifier: $0.id) }
    case .approval(let id): return EntityIdentifier(for: ApprovalEntity.self, identifier: id)
    }
  }
}
