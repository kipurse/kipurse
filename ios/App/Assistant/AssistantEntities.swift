import AppIntents
import CoreSpotlight
import KipurseCore

/// A saved payee. Id = salted hash; title = nickname / "我的 Coinbase 钱包"; subtitle = last 4 only. Indexed in Spotlight.
struct PayeeEntity: AppEntity, IndexedEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(name: "Kipurse payee", numericFormat: "\(placeholder: .int) payees")
  static var defaultQuery = PayeeQuery()
  let id: String
  @Property(title: "Name") var name: String
  @Property(title: "Address last 4") var last4: String
  let isOwner: Bool
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)", subtitle: "…\(last4)", image: .init(systemName: isOwner ? "person.crop.circle.badge.checkmark" : "person.crop.circle")) }
  init(_ p: AssistantData.Payee) { id = p.id; isOwner = p.isOwner; name = p.label; last4 = p.last4 }
  var attributeSet: CSSearchableItemAttributeSet {
    let a = CSSearchableItemAttributeSet(contentType: .content); let t = AssistantData.indexText(AssistantStore.payees.first { $0.id == id } ?? .init(id: id, address: "", label: name, last4: last4, isOwner: isOwner))
    a.title = t[0]; a.contentDescription = t[1]; a.keywords = t; return a
  }
}
struct PayeeQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [PayeeEntity] { AssistantStore.payees.filter { identifiers.contains($0.id) }.map(PayeeEntity.init) }
  func entities(matching string: String) async throws -> [PayeeEntity] { _ = await AssistantStore.fresh(); return AssistantData.match(string, AssistantStore.payees).map(PayeeEntity.init) }
  func suggestedEntities() async throws -> [PayeeEntity] { _ = await AssistantStore.fresh(); return AssistantStore.payees.map(PayeeEntity.init) }
}

/// A past payment (amount, payee label, time). Indexed so "repeat my last payment" / "that 5 USDC to the shop" resolve. No tx hash, no balance.
struct PaymentEntity: AppEntity, IndexedEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(name: "Kipurse payment", numericFormat: "\(placeholder: .int) payments")
  static var defaultQuery = PaymentQuery()
  let id: String
  @Property(title: "Amount (USDC)") var amount: Double
  @Property(title: "Payee") var payeeName: String
  @Property(title: "Time") var date: Date?
  let payeeId: String
  let settled: Bool
  let title: String
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)", subtitle: date.map { "\($0.formatted(date: .abbreviated, time: .shortened))" } ?? "", image: .init(systemName: "arrow.up.right.circle"))
  }
  init(_ p: AssistantData.Payment) { id = p.id; payeeId = p.payeeId; settled = p.settled; title = p.title; amount = Double(p.amount) / 1_000_000; payeeName = p.payeeLabel; date = p.date }
  var attributeSet: CSSearchableItemAttributeSet {
    let a = CSSearchableItemAttributeSet(contentType: .content); a.title = title; a.keywords = [payeeName, "Kipurse"]; a.contentCreationDate = date; return a
  }
}
struct PaymentQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [PaymentEntity] { AssistantStore.payments.filter { identifiers.contains($0.id) }.map(PaymentEntity.init) }
  func suggestedEntities() async throws -> [PaymentEntity] { _ = await AssistantStore.fresh(); return AssistantStore.payments.map(PaymentEntity.init) }
}

/// Something waiting for the owner. Not indexed (live, and its text is written by AI agents: shown, never trusted).
struct ApprovalEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(name: "Kipurse approval", numericFormat: "\(placeholder: .int) approvals")
  static var defaultQuery = ApprovalQuery()
  let id: String
  @Property(title: "Title") var title: String
  @Property(title: "Details") var detail: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)", subtitle: "\(String(detail.prefix(80)))", image: .init(systemName: "checkmark.seal")) }
  init(_ a: Approval) { id = a.id; title = a.titleZh; detail = a.bodyZh }
}
struct ApprovalQuery: EntityQuery {
  func current() async -> [Approval] { (await AssistantStore.fresh() ?? AssistantStore.lastState)?.approvals ?? [] }
  func entities(for identifiers: [String]) async throws -> [ApprovalEntity] { await current().filter { identifiers.contains($0.id) }.map(ApprovalEntity.init) }
  func suggestedEntities() async throws -> [ApprovalEntity] { await current().map(ApprovalEntity.init) }
}
