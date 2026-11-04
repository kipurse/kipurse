import Foundation

/// Where deployment- and user-specific values come from. The open-source core compiles in NONE of them:
/// - operator values (server, owner-pay flag) come from the app's Info.plist, filled from Config/Local.xcconfig (git-ignored);
/// - the user's own wallet is learned at enrollment and kept in UserDefaults (deleted by the delete-everything path).
public enum Operator {
  /// Replaceable in tests.
  public static var info: [String: Any] = Bundle.main.infoDictionary ?? [:]
  public static let walletKey = "kp.mainnet.wallet"
  static func str(_ k: String) -> String? {
    guard let v = (info[k] as? String)?.trimmingCharacters(in: .whitespaces), !v.isEmpty, !v.hasPrefix("$(") else { return nil }
    return v
  }
  /// Mainnet server of this operator (nil = not configured; the app then shows no mainnet).
  public static var server: URL? { str("KipurseMainnetServer").flatMap(URL.init(string:)) }
  /// This user's wallet: what they enrolled, else the operator-provisioned one (single-user builds). Empty = none.
  public static let ownerKey = "kp.mainnet.owner", pathKey = "kp.mainnet.path"
  /// Multi-user: the wallet is never compiled in. The server tells the app (wallet discovery by phone key, or 开通) and it is kept here.
  public static var demoWallet: String?
  public static var wallet: String { demoWallet ?? UserDefaults.standard.string(forKey: walletKey) ?? "" }
  /// The wallet's URL space on the server: "/t/<wallet>" (or "" for a wallet whose record keeps the original URLs).
  public static var tenantPath: String { if let p = UserDefaults.standard.string(forKey: pathKey) { return p }; return wallet.isEmpty ? "" : "/t/" + wallet.lowercased() }
  public static func setWallet(_ w: String?, owner: String? = nil, path: String? = nil) {
    if demoWallet != nil { return }   // demo never overwrites the real wallet
    let d = UserDefaults.standard
    guard let w else { [walletKey, ownerKey, pathKey].forEach { d.removeObject(forKey: $0) }; return }
    d.set(w, forKey: walletKey); if let owner { d.set(owner, forKey: ownerKey) }; if let path { d.set(path, forKey: pathKey) }
  }
  /// The user's own account address (to warn when a payee is the owner's own account). Optional.
  /// In-memory only (demo / App Review path): never persisted, so a wipe or a real sign-in replaces it.
  public static var demoOwner: String?
  public static var ownerAccount: String? { demoOwner ?? UserDefaults.standard.string(forKey: ownerKey) }
  /// Owner-initiated payments (Siri/App). OFF unless the operator turns it on for a test build.
  public static var ownerPayEnabled: Bool { str("KipurseOwnerPay") == "YES" }
}
