import Foundation
/// The owner one-time link, from a QR code or a deep link.
///   https://host/login?code=<hex>                      (what the kit writes / shows as QR)
///   kipurse://login?server=https%3A%2F%2Fhost&code=<hex>  (deep link)
public struct OwnerLink: Equatable {
  public let server: URL, code: String
  public static func parse(_ s: String) -> OwnerLink? {
    guard let u = URLComponents(string: s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    let code = u.queryItems?.first { $0.name == "code" }?.value ?? ""
    guard code.count >= 32, code.count <= 128, code.allSatisfy({ $0.isHexDigit }) else { return nil }
    if u.scheme == "kipurse" { return nil }   // t796 H1: the legacy kipurse://login?server=… deep link is gone (any web page could point the app at any server)
    guard u.path == "/login", let scheme = u.scheme, let host = u.host else { return nil }
    var b = URLComponents(); b.scheme = scheme; b.host = host; b.port = u.port
    guard let su = b.url, Server.isAllowed(su) else { return nil }
    return OwnerLink(server: su, code: code)
  }
}

public enum Server {
  /// HTTPS anywhere; plain HTTP only for localhost / private LAN (the kit on the owner's Mac). Passkey signing itself needs HTTPS.
  public static func isAllowed(_ u: URL) -> Bool {
    guard let h = u.host?.lowercased() else { return false }
    if u.scheme == "https" { return true }
    guard u.scheme == "http" else { return false }
    if h == "localhost" || h == "127.0.0.1" || h.hasSuffix(".local") { return true }
    let p = h.split(separator: ".").compactMap { Int($0) }
    guard p.count == 4 else { return false }
    return p[0] == 10 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && (16...31).contains(p[1]))
  }
  public static func signingNeedsHTTPS(_ u: URL) -> Bool { u.scheme != "https" }
}
