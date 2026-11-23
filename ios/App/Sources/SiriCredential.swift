import Foundation
import Security
import KipurseCore

/// t1158u (§6#77): Siri's own pay-only credential. The server issues it only in the reply to the phone-signed (Face ID) Siri
/// connect approval, stores only its hash bound to this phone, accepts it ONLY on POST /siri/buy (every cap, the trust list,
/// Siri's own stop and the pause still apply) and revokes it when Siri is disconnected / stopped or AI payments are stopped.
/// Kept in this device's Keychain (never synced, never in a backup), readable once the phone was unlocked after boot so
/// Siri can use it on an unlocked phone (the intents keep .requiresAuthentication).
enum SiriCredential {
  private static let svc = "com.kipurse.mainnet.siri-credential"
  static func load() -> String? {
    if DemoGuard.active { return nil }
    var out: CFTypeRef?
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: svc, kSecReturnData as String: true]
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, let s = String(data: d, encoding: .utf8), SiriCredRule.isValid(s) else { return nil }
    return s
  }
  /// Saves only a well-formed credential; anything else leaves nothing behind.
  static func save(_ raw: Any?) {
    if DemoGuard.active { return }
    clear()
    guard let t = raw as? String, SiriCredRule.isValid(t) else { return }
    SecItemAdd([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: svc, kSecValueData as String: Data(t.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as CFDictionary, nil)
  }
  static func clear() { if DemoGuard.active { return }; SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: svc] as CFDictionary) }
  static var present: Bool { load() != nil }
  /// POST /siri/buy with the Siri credential (no phone session needed). 401 = revoked on the server -> forget it here too.
  static func siriBuy(_ body: [String: Any]) async throws -> (Int, [String: Any]) {
    guard let tok = load() else { throw MainnetSession.Failure.needsSignIn }
    var r = URLRequest(url: Mainnet.server.appendingPathComponent("siri/buy")); r.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); r.httpMethod = "POST"; r.timeoutInterval = 90
    r.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization"); r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (d, resp) = try await URLSession.shared.data(for: r)
    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
    if code == 401 { clear() }
    return (code, ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any]) ?? [:])
  }
}
