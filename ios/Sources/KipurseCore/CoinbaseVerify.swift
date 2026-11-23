import Foundation
/// t624u: Kipurse does no KYC of its own and collects no identity data. New wallets need Coinbase's public on-chain
/// "Verified Account" attestation on the user's Coinbase wallet (Coinbase already did the KYC). The SERVER decides; the app only guides.
public enum CoinbaseVerify {
  /// Official Coinbase pages only (checked 2026-10-27 against coinbase.com / help.coinbase.com).
  public static let signupURL = URL(string: "https://www.coinbase.com/signup")!
  public static let identityHelpURL = URL(string: "https://help.coinbase.com/en/coinbase/getting-started/getting-started-with-coinbase/id-doc-verification")!
  public static let onchainVerifyURL = URL(string: "https://www.coinbase.com/onchain-verify")!
  public static var all: [URL] { [signupURL, identityHelpURL, onchainVerifyURL] }
  /// Only https links on coinbase.com or its subdomains are ever opened from this flow (a server-sent URL elsewhere is ignored).
  public static func isOfficial(_ u: URL) -> Bool {
    guard u.scheme == "https", let h = u.host?.lowercased() else { return false }
    return h == "coinbase.com" || h.hasSuffix(".coinbase.com")
  }
  public enum Status: Equatable { case checking, verified, notVerified, unavailable }
  /// Server reply of GET /onboard/new/verified. Anything unexpected = unavailable (never "verified").
  public static func status(code: Int, json: [String: Any]?) -> Status {
    guard code == 200, let j = json else { return .unavailable }
    if (j["verified"] as? Bool) == true { return .verified }
    return (j["reason"] as? String) == "unavailable" ? .unavailable : .notVerified
  }
}
