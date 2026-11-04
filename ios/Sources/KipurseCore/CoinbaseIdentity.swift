import Foundation

/// "Sign in with Coinbase": the user's Coinbase wallet is the ONLY identity. The phone key is just "this phone may approve".
/// The server answers one of three outcomes after a free SIWE signature (no transaction).
public enum CoinbaseIdentity {
  public enum Outcome: String, Equatable { case reconnect, bind, new }
  public struct Result: Equatable {
    public let outcome: Outcome; public let owner: String; public let wallet: String?; public let path: String?
    /// One-page setup (new accounts): state of the wallet being opened on the sign-in page, and its address once done.
    public let setupState: String?; public let setupWallet: String?
    /// Parses GET /signin/status (state = done). Refuses anything malformed (bad address, reconnect/bind without a wallet, new WITH a wallet).
    public init?(_ j: JSONValue?) {
      guard let j, j["state"]?.string == "done", let o = j["result"]?.string.flatMap(Outcome.init(rawValue:)),
            let owner = j["owner"]?.string, CoinbaseIdentity.isAddress(owner) else { return nil }
      let w = j["wallet"]?.string
      switch o {
      case .reconnect, .bind: guard let w, CoinbaseIdentity.isAddress(w) else { return nil }
      case .new: if let w, !w.isEmpty { return nil }
      }
      outcome = o; self.owner = owner; wallet = o == .new ? nil : w
      let p = j["path"]?.string; path = p.flatMap { $0.hasPrefix("/t/0x") && $0.count == 45 ? $0 : nil }
      setupState = o == .new ? j["setup"]?["state"]?.string : nil
      setupWallet = o == .new ? j["setup"]?["wallet"]?.string.flatMap { CoinbaseIdentity.isAddress($0) ? $0 : nil } : nil
    }
  }
  public static func isAddress(_ s: String) -> Bool { s.count == 42 && s.hasPrefix("0x") && s.dropFirst(2).allSatisfy(\.isHexDigit) }
  /// Whether the existing phone key may be reused: ONLY when the server proved it is the active approver of THIS account's wallet.
  public static func reusesPhoneKey(_ r: Result) -> Bool { r.outcome == .reconnect }
  /// The wallet was opened on the sign-in page (one page, one free setup): go straight into the app with that wallet.
  public static func openedOnSignIn(_ r: Result) -> String? { r.outcome == .new && r.setupState == "done" ? r.setupWallet : nil }
  /// Default AI limits for the one-page setup (changeable later in the app; the same defaults the setup screen preselects).
  /// t603u: NO preset limits. The user chooses his own AI limits in the guided onboarding step (first authorization free).
  public static let presetSetup: [String: String]? = nil
  /// First launch of an install (UserDefaults is deleted with the app; the keychain is not) must never auto-resolve a wallet
  /// from a leftover phone key: the user signs in with Coinbase first.
  public static let verifiedKey = "kp.identity.verified"
  public static let ownerKey = "kp.identity.owner"
  public static func verified(_ d: UserDefaults = .standard) -> Bool { d.bool(forKey: verifiedKey) }
  /// Updating an install that already had a working wallet keeps it (it was set up with this Coinbase wallet before).
  public static func migrate(_ d: UserDefaults = .standard, launchedBefore: Bool, wallet: String) {
    if !d.bool(forKey: verifiedKey), launchedBefore, !wallet.isEmpty { d.set(true, forKey: verifiedKey) }
  }
}
