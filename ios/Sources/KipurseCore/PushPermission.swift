import Foundation

/// t1208 / decision 94: when the app asks iOS for notification permission and when it (re)uploads the APNs token.
/// Pure decisions (unit-tested); the app does the UNUserNotificationCenter / UIApplication calls.
public enum PushPermission {
  /// iOS authorization status, mirrored so the core stays UIKit-free.
  public enum Status: Equatable { case notDetermined, denied, authorized, provisional, ephemeral }
  /// Ask once: only for a real (non-demo) mainnet account that has a session or a bound wallet, and only while iOS has not decided.
  /// A refusal is final (iOS never shows the prompt twice); the app keeps working and in-app cards stay the fallback.
  public static func shouldAsk(status: Status, hasSession: Bool, walletBound: Bool, demo: Bool) -> Bool {
    !demo && status == .notDetermined && (hasSession || walletBound)
  }
  /// After a grant (or an earlier grant) register with APNs so a token arrives and gets uploaded.
  public static func shouldRegister(status: Status, demo: Bool) -> Bool {
    !demo && [.authorized, .provisional, .ephemeral].contains(status)
  }
  /// Upload the token when it is new to the server, once a session exists.
  public static func shouldUpload(token: String?, lastSent: String?, hasSession: Bool) -> Bool {
    guard let t = token, !t.isEmpty, hasSession else { return false }
    return t != lastSent
  }
  /// t1238/t1239 (decision 109): the server keeps push tokens per wallet. After a wallet move or a sign-in to another wallet the
  /// token itself is unchanged, so "sent" must remember the wallet too, or the new wallet never gets the token (no pushes).
  public static func sentKey(token: String, wallet: String) -> String {
    let w = wallet.lowercased(); return w.isEmpty ? token : token + "|" + w
  }
  public static func shouldUpload(token: String?, lastSent: String?, hasSession: Bool, wallet: String) -> Bool {
    guard let t = token, !t.isEmpty, hasSession else { return false }
    return sentKey(token: t, wallet: wallet) != lastSent
  }
}
