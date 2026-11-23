// Shared between the app and the widget extension: the snapshot the widget shows and the Live Activity attributes.
import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif
enum SharedSpend {
  static var group: String { Bundle.main.object(forInfoDictionaryKey: "KipurseAppGroup") as? String ?? "group.org.example.kipurse" }
  struct Snapshot: Codable { var balance: Int64; var spentToday: Int64; var dailyLimit: Int64; var lastAgent: String?; var lastAmount: Int64?; var lastAt: Date?; var paymentsToday: Int; var pending: Int; var chinese: Bool; var updated: Date }
  static var defaults: UserDefaults? { UserDefaults(suiteName: group) }
  static func save(_ s: Snapshot) { if let d = try? JSONEncoder().encode(s) { defaults?.set(d, forKey: "snapshot") } }
  static func load() -> Snapshot? { defaults?.data(forKey: "snapshot").flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) } }
  static func clear() { defaults?.removeObject(forKey: "snapshot") }
  static func fmt(_ a: Int64, _ zh: Bool) -> String { let v = String(format: "%.2f", Double(a) / 1_000_000); return zh ? v + " USDC" : "$" + v }
}
#if canImport(ActivityKit)
@available(iOS 16.1, *)
struct SpendActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable { var spentToday: Int64; var dailyLimit: Int64; var lastAgent: String; var lastAmount: Int64; var pending: Int; var chinese: Bool }
  var title: String
}
#endif
