import Foundation
import CryptoKit

/// t629 A1: Coinbase wallet signing pages are NOT loaded from the Kipurse server. They come from a separate static host
/// (Cloudflare, free plan) whose index.html SHA-256 is pinned here; index.html pins kpshell.js with Subresource Integrity and
/// kpshell.js pins every signing bundle the same way. The Kipurse server only supplies data. A compromised server therefore
/// cannot swap the code that refuses any batch other than the one this app decoded. Any mismatch -> fail closed.
public enum SignHost {
  public static let host = "sign.kipurse.com"   // t887: Kipurse-owned domain (same Worker, same pinned bytes)
  /// Old host, still served by the same Worker: links already opened keep working.
  public static let legacyHost = "kipurse-sign.example.workers.dev"
  public static let apiHost = "pay.kipurse.com"
  /// sha256(index.html) of the published static build (gateway/pages/PIN.json).
  public static let indexSHA256 = "a9007ee641b4df31efa8437e485ec68fd9e321d36f7ec216a6c860a1e8c67096"  // t1103 /v9 = kpshell.v8.js + limits.v2.js. /v8 = f27cad0e… stays live for build 49.
  /// The signing set this build uses on the sign host (v1–v8 stay byte-identical for older builds).
  public static let setPrefix = "/v9"   // t1103: wallet-pays limits bundle. /v8 remains for the previous build.
  public static let previousPrefix = "/v8"
  /// Server pages that run a Coinbase wallet batch and therefore must open through the pinned shell.
  public static let moved: Set<String> = ["/onboard", "/onboard/new", "/deposit", "/owner/limits", "/owner/withdraw", "/owner/emergency", "/approve/trust", "/phone/enroll", "/phone/revoke"]

  static func corePath(_ p: String) -> String {
    let parts = p.split(separator: "/", omittingEmptySubsequences: true)
    if parts.count >= 2, parts[0] == "t", parts[1].count == 42, parts[1].hasPrefix("0x") { return "/" + parts.dropFirst(2).joined(separator: "/") }
    return p
  }
  /// The shell URL for a Kipurse server signing page, or nil when the page is not one that moved (then the caller keeps the server URL).
  public static func shellURL(for u: URL, fragment: String, lang: String) -> URL? {
    guard u.scheme == "https", u.host?.lowercased() == apiHost, u.port == nil, moved.contains(corePath(u.path)),
          var c = URLComponents(url: u, resolvingAgainstBaseURL: false) else { return nil }
    var q = (c.queryItems ?? []).filter { $0.name != "lang" }; q.append(URLQueryItem(name: "lang", value: lang)); c.queryItems = q
    guard let pq = c.percentEncodedQuery, !c.percentEncodedPath.isEmpty else { return nil }
    let inner = c.percentEncodedPath + "?" + pq
    var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._~")
    guard let enc = inner.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
    var s = URLComponents(); s.scheme = "https"; s.host = host; s.percentEncodedPath = setPrefix + c.percentEncodedPath  // t732: same path as the server page (keeps /t/<wallet>) so the bundle's API base is right; the Worker serves the same pinned index.html there
    s.percentEncodedFragment = "u=" + enc + (fragment.isEmpty ? "" : "&" + fragment)
    return s.url
  }
  /// t784: every Kipurse server page that signs opens through the pinned shell. Keeps an existing #fragment (vh / vw commitments).
  /// Pages that are not signing pages (or are already on the shell) come back unchanged.
  public static func route(_ u: URL) -> URL {
    if isShell(u) { return u }
    return shellURL(for: u, fragment: URLComponents(url: u, resolvingAgainstBaseURL: false)?.percentEncodedFragment ?? "", lang: Loc.code) ?? u
  }
  public static func isShell(_ u: URL) -> Bool { u.scheme == "https" && u.port == nil && [host, legacyHost].contains(u.host?.lowercased() ?? "") }
  public static func matchesPin(_ data: Data) -> Bool { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() == indexSHA256 }

  /// t796 M1 (mitigation): the check asks exactly like the in-app Safari view does (same User-Agent family + Accept), so a host that tries to
  /// show the checker one page and Safari another must cloak on finer signals. Full elimination is not possible while Coinbase signing needs a Safari view.
  public static func likeSafari(_ r: inout URLRequest) {
    r.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
    r.setValue("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", forHTTPHeaderField: "Accept"); r.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
  }
  public enum Failure: Error { case unreachable, mismatch }
  /// Fetch the shell's index.html fresh and compare with the pin. Throws -> do not open the page.
  public static func verify(session: URLSession = .shared) async throws {
    var r = URLRequest(url: URL(string: "https://\(host)\(setPrefix)")!); r.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData; r.timeoutInterval = 15; SignHost.likeSafari(&r)
    let d: Data, resp: URLResponse
    do { (d, resp) = try await session.data(for: r) } catch { throw Failure.unreachable }
    guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.unreachable }
    guard matchesPin(d) else { throw Failure.mismatch }
  }
}
