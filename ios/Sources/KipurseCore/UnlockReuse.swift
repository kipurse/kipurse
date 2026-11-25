import Foundation

/// t1243 (decision 113): ONE Face ID when the phone session has expired on an approval path.
/// The sign-in evaluates an LAContext once; the approval signatures that follow may reuse that SAME evaluated context, but only
/// - when the owner tapped the approve button on the full card (never from an automatic / lock-screen path), and
/// - within `window` seconds of the Face ID, and
/// - once (the first take consumes it; anything else discards it, and the app invalidates a discarded context).
/// When the session still exists nothing is held and the approval asks for Face ID exactly as before.
public enum UnlockReuse {
  public static let window: TimeInterval = 60
  public static func allows(evaluatedAt: Date, now: Date, userTapped: Bool, window: TimeInterval = UnlockReuse.window) -> Bool {
    guard userTapped, window > 0 else { return false }
    let age = now.timeIntervalSince(evaluatedAt)
    return age >= 0 && age <= min(window, UnlockReuse.window)
  }
}

/// Holds at most one evaluated unlock (an LAContext in the app; any value in tests). Not thread-safe: use from one actor (the main actor in the app).
public final class ReusableUnlock<Value> {
  private var held: (value: Value, at: Date, tag: String?)?
  private let discard: (Value) -> Void
  public init(discard: @escaping (Value) -> Void = { _ in }) { self.discard = discard }
  public var isHolding: Bool { held != nil }
  /// Keep a freshly evaluated unlock (an older one is discarded first).
  /// t1266 (fix 10): `tag` binds the unlock to one approval ("<id>|<mode>", or "<id>|*" when the owner has not picked a choice yet).
  public func hold(_ v: Value, at: Date, tag: String? = nil) { clear(); held = (v, at, tag) }
  /// The held unlock if the rules allow reuse now; it is removed either way (single use). A refused one is discarded.
  public func take(now: Date, userTapped: Bool, tag: String? = nil) -> Value? {
    guard let h = held else { return nil }
    held = nil
    if UnlockReuse.allows(evaluatedAt: h.at, now: now, userTapped: userTapped), ReusableUnlock.tagMatches(held: h.tag, wanted: tag) { return h.value }
    discard(h.value); return nil
  }
  /// Discard once the window has passed (the app calls this from a timer).
  @discardableResult public func expire(now: Date) -> Bool {
    guard let h = held, now.timeIntervalSince(h.at) > UnlockReuse.window || now < h.at else { return false }
    held = nil; discard(h.value); return true
  }
  public func clear() { if let h = held { held = nil; discard(h.value) } }
  /// An untagged hold matches only an untagged take; "<id>|*" matches any choice on that same request.
  public static func tagMatches(held: String?, wanted: String?) -> Bool {
    guard let h = held else { return wanted == nil }
    guard let w = wanted else { return false }
    if h == w { return true }
    if h.hasSuffix("|*") { return w.hasPrefix(String(h.dropLast(1))) && !w.hasSuffix("|*") }
    return false
  }
}

public extension PushPermission {
  /// t1243 (decision 113): the token this phone uploaded before ("apnsSent" holds token or token|wallet). Sent as `replaces` with a
  /// new token so the server drops the old one from this wallet's list (one push per phone). nil when it is the same token or unknown.
  static func replacedToken(lastSent: String?, newToken: String) -> String? {
    guard let l = lastSent, !l.isEmpty else { return nil }
    let old = String(l.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    guard !old.isEmpty, old.lowercased() != newToken.lowercased(), old.count >= 32, old.count <= 200,
          old.allSatisfy({ $0.isHexDigit }) else { return nil }
    return old
  }
}
