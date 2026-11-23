import Foundation

/// Coinbase Onramp (Apple Pay / debit card -> USDC on Base into this wallet). The server creates the one-time session
/// (POST /phone/onramp/session) and always sets the destination to the owner's own wallet; the phone only opens the page.
/// HONESTY (owner 2026-10-27): never say the money arrived before the server verified it (POST /phone/onramp/status).
public enum OnrampReply: Equatable {
  case open(URL, ref: String?)   // Coinbase pay page, prefilled (USDC, Base, this wallet)
  case fallback(URL)             // not configured / failed: Coinbase's buy page
  public static let coinbaseBuy = URL(string: "https://www.coinbase.com/buy/usdc")!
  public static func parse(_ code: Int?, _ j: [String: Any]?) -> OnrampReply {
    guard code == 200, let j, j["ok"] as? Bool == true, let s = j["url"] as? String, let u = URL(string: s),
          u.scheme == "https", u.host == "pay.coinbase.com",
          let q = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems,
          q.contains(where: { $0.name == "sessionToken" && !($0.value ?? "").isEmpty }) else {
      if let f = j?["fallbackUrl"] as? String, let u = URL(string: f), u.scheme == "https", u.host?.hasSuffix("coinbase.com") == true { return .fallback(u) }
      return .fallback(coinbaseBuy)
    }
    let ref = (j["ref"] as? String).flatMap { OnrampState.validRef($0) ? $0 : nil }
    return .open(u, ref: ref)
  }
}

/// What the server verified about one purchase.
public enum OnrampState: Equatable {
  case checking                                   // no answer yet
  case arrived(amount: String?, txHash: String?)  // verified: Coinbase send tx to this wallet, or wallet balance went up
  case arriving(amount: String?)                  // Coinbase is sending
  case failed
  case wrongDestination                           // must never happen; loud warning
  case inCoinbaseAccount                          // no send to the wallet found: the coins are most likely in the Coinbase account
  public static func validRef(_ r: String) -> Bool { r.range(of: "^kp-[0-9a-f]{24}$", options: .regularExpression) != nil }
  /// `secondsSinceReturn`: time since checkout came back to the app. No Onramp record 90 s after returning -> in Coinbase account.
  public static func parse(_ code: Int?, _ j: [String: Any]?, secondsSinceReturn: Double) -> OnrampState {
    guard code == 200, let j, j["ok"] as? Bool == true else { return .checking }
    let amt = j["amount"] as? String
    switch j["state"] as? String {
    case "arrived": return .arrived(amount: amt, txHash: j["txHash"] as? String)
    case "arriving": return .arriving(amount: amt)
    case "failed": return .failed
    case "wrong_destination": return .wrongDestination
    case "awaiting_payment", "unknown": return .checking
    case "not_found": return (j["maybeInCoinbaseAccount"] as? Bool == true || secondsSinceReturn >= 90) ? .inCoinbaseAccount : .checking
    default: return .checking
    }
  }
  public var isFinal: Bool { switch self { case .arrived, .failed, .wrongDestination: return true; default: return false } }
}

/// Apple Pay direct (Coinbase Headless Onramp, guest checkout): Coinbase buys and sends straight to this wallet on Base.
public enum ApplePayOnramp {
  public static func validPhone(_ p: String) -> String? {   // US cell in E.164 (+1XXXXXXXXXX); accepts "(415) 555-2671"
    let d = p.filter(\.isNumber); let n = d.count == 11 && d.hasPrefix("1") ? String(d.dropFirst()) : d
    guard n.count == 10, let f = n.first, ("2"..."9").contains(f) else { return nil }; return "+1" + n
  }
  public static func validEmail(_ e: String) -> Bool { e.range(of: #"^[^\s@]{1,64}@[^\s@]{1,190}\.[A-Za-z]{2,}$"#, options: .regularExpression) != nil }
  /// Pay link must be Coinbase https.
  public static func payURL(_ j: [String: Any]?) -> URL? {
    guard let s = j?["url"] as? String, let u = URL(string: s), u.scheme == "https", let h = u.host, h == "coinbase.com" || h.hasSuffix(".coinbase.com") else { return nil }; return u
  }
  /// Events from the Coinbase pay button (window.webkit.messageHandlers.cbOnramp).
  public enum Event: Equatable { case loaded, started, canceled, done, error(String) }
  public static func event(_ body: Any) -> Event? {
    var j = body as? [String: Any]
    if j == nil, let s = body as? String, let d = s.data(using: .utf8) { j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] }
    guard let name = j?["eventName"] as? String else { return nil }
    let msg = ((j?["data"] as? [String: Any])?["errorMessage"] as? String) ?? (j?["errorMessage"] as? String) ?? name
    switch name {
    case "onramp_api.load_success": return .loaded
    case "onramp_api.commit_success": return .started
    case "onramp_api.cancel": return .canceled
    case "onramp_api.polling_success": return .done
    default: return name.hasSuffix("error") ? .error(msg) : nil
    }
  }
}
