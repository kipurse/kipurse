import Foundation

/// t1220u (handbook §6#96): an AI payment / allowance request (push kind "mandate" or "owner_ask") must show on Home under
/// 「待你批准」 even when the App has no live server session (opening the App never asks for Face ID, 0A#2, so the list can't be
/// read then). The push itself names the request: remember it on this phone until the server list can be read again.
/// A remembered request can never be approved by itself: approving still loads the server's request and checks it (Face ID).
public struct PendingPushHint: Codable, Equatable {
  public let id: String
  public let kind: String
  public let text: String
  public let at: Double
  public init(id: String, kind: String, text: String, at: Double) { self.id = id; self.kind = kind; self.text = text; self.at = at }
}

public enum PendingPushHints {
  public static let kinds: Set<String> = ["mandate", "owner_ask"]
  /// requests live at most 7 days on the server (one-time payments 24 h); the server list replaces these whenever it is read
  public static let maxAge: TimeInterval = 7 * 86400
  public static let maxCount = 20

  /// The push the server sends: `kp.kind` + `kp.approvalId`, visible text in the alert body.
  public static func hint(userInfo: [AnyHashable: Any], body: String, at: Date) -> PendingPushHint? {
    guard let kp = userInfo["kp"] as? [String: Any], let kind = kp["kind"] as? String, kinds.contains(kind),
          let id = kp["approvalId"] as? String, !id.isEmpty, id.count <= 80 else { return nil }
    let t = body.trimmingCharacters(in: .whitespacesAndNewlines)
    return PendingPushHint(id: id, kind: kind, text: String(t.prefix(400)), at: at.timeIntervalSince1970)
  }

  /// One entry per request (the newest text wins), nothing older than `maxAge`, newest first, at most `maxCount`.
  public static func merge(_ old: [PendingPushHint], _ new: [PendingPushHint], now: Date) -> [PendingPushHint] {
    var byId: [String: PendingPushHint] = [:]
    for h in old + new where now.timeIntervalSince1970 - h.at < maxAge && h.at <= now.timeIntervalSince1970 + 300 {
      if let e = byId[h.id], e.at >= h.at { continue }
      byId[h.id] = h
    }
    return Array(byId.values.sorted { $0.at > $1.at }.prefix(maxCount))
  }

  /// Requests to show next to the server's list (`known` = ids the server list already has).
  public static func extra(_ hints: [PendingPushHint], known: Set<String>, now: Date) -> [PendingPushHint] {
    merge(hints, [], now: now).filter { !known.contains($0.id) }
  }

  public static func encode(_ l: [PendingPushHint]) -> Data? { try? JSONEncoder().encode(l) }
  public static func decode(_ d: Data?) -> [PendingPushHint] { d.flatMap { try? JSONDecoder().decode([PendingPushHint].self, from: $0) } ?? [] }
}
