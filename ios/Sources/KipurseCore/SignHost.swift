import Foundation
import CryptoKit

/// t629 A1: Coinbase wallet signing pages are NOT loaded from the Kipurse server. They come from a separate static host
/// (Cloudflare, free plan) whose index.html SHA-256 is pinned here; index.html pins kpshell.js with Subresource Integrity and
/// kpshell.js pins every signing bundle the same way. The Kipurse server only supplies data. A compromised server therefore
/// cannot swap the code that refuses any batch other than the one this app decoded. Any mismatch -> fail closed.
public enum SignHost {
  public static let host = "sign.kipurse.com"   // t887: Kipurse-owned domain (same Worker, same pinned bytes)
  /// Old host, still served by the same Worker: links already opened keep working. Per build, from Info.plist KipurseSignLegacyHost
  /// (KIPURSE_SIGN_LEGACY_HOST in Config/Local.xcconfig). Empty (the default) = no legacy host is accepted, only `host`.
  public static let legacyHost: String = configuredHost(Bundle.main.object(forInfoDictionaryKey: "KipurseSignLegacyHost") as? String)
  /// A bare lowercase host name, or "" when unset / not a plain host (never matches anything then).
  static func configuredHost(_ v: String?) -> String {
    let s = (v ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard s.contains("."), s.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }), !s.hasPrefix("."), !s.hasSuffix(".") else { return "" }
    return s
  }
  public static let apiHost = "pay.kipurse.com"
  /// sha256(index.html) of the published static build (gateway/pages/PIN.json).
  public static let indexSHA256 = "7edff9ce36a4ef6ddae3648ed0bf776d944bdf7cc4a205f66e5b2e22aea9c6f1"  // t1139 /v12 = kpshell.v11.js + resume.v1.js (resume after an emergency stop: lift the on-chain pause, fee from the wallet); /v11 = 8699bc87… stays live for build 61. Was: t1125 /v11 = kpshell.v10.js + limits.v4.js (limits page signs only the decision 63 wallet-fee batch; no sub-account step; neutral refusal); /v10 = 273d742a… stays live for build 57. Was: t1120 /v10 = kpshell.v9.js + withdraw.v4.js (everyday withdraw: network fee from the wallet USDC, same confirmation); /v9 = a9007ee6… stays live for build 55. Was: t1103 /v9 = kpshell.v8.js + limits.v2.js (wallet-pays limits: approve 0x6666 + cap change); /v8 = f27cad0e… stays live for build 49. Was: t1040 /v8 set (dark glass CSS shell; business bundles same as /v7); /v7 = b249…; /v6 = 6def…; v1–v7 stay live for older builds
  /// The signing set this build uses on the sign host (the v1 set at "/" stays byte-identical for older builds).
  public static let setPrefix = "/v12"   // t1139: resume.v1 (lift the on-chain pause); /v11 remains for the previous build. Was: t1125: limits.v4 (wallet-fee batch only); /v10 remains for the previous build. Was: t1120: wallet-pays everyday withdraw bundle; /v9 remains for the previous build. Was: t1103: wallet-pays limits bundle; /v8 remains for the previous build. Was: t1040: /v8 = v7 + dark glass/neon CSS shell (kpshell.v7 + deposit-ui.v7 colors). Business JS same as /v7. /v7 unchanged for installed builds
  public static let previousPrefix = "/v11"   // prior pin set kept live for older builds
  /// Server pages that run a Coinbase wallet batch and therefore must open through the pinned shell.
  public static let moved: Set<String> = ["/onboard", "/onboard/new", "/deposit", "/owner/limits", "/owner/withdraw", "/owner/emergency", "/approve/trust", "/phone/enroll", "/phone/revoke", "/safety/resume"]

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
  /// t1266 (fix 2): the ONLY signing pages the app opens. A Kipurse server page must be https, no port, no user info, on the
  /// Kipurse API host (which must also be the configured server host when one is configured) and one of the `moved` paths; it is
  /// returned routed through the pinned shell. A shell URL itself must carry one of those paths too. Anything else -> nil (refuse).
  public static func signingPage(_ u: URL, serverHost: String?, legacy: String = legacyHost) -> URL? {
    guard u.scheme?.lowercased() == "https", u.port == nil, u.user == nil, u.password == nil, let h = u.host?.lowercased(), !h.isEmpty else { return nil }
    if isShell(u, legacy: legacy) {
      var p = u.path
      for pre in [setPrefix, previousPrefix] where p.hasPrefix(pre + "/") { p = String(p.dropFirst(pre.count)); break }
      return moved.contains(corePath(p)) ? u : nil
    }
    if let sh = serverHost?.lowercased(), !sh.isEmpty, sh != h { return nil }
    guard h == apiHost, moved.contains(corePath(u.path)) else { return nil }
    guard let s = shellURL(for: u, fragment: URLComponents(url: u, resolvingAgainstBaseURL: false)?.percentEncodedFragment ?? "", lang: Loc.code), isShell(s, legacy: legacy) else { return nil }
    return s
  }
  public static func isShell(_ u: URL) -> Bool { isShell(u, legacy: legacyHost) }
  static func isShell(_ u: URL, legacy: String) -> Bool {
    guard u.scheme == "https", u.port == nil, let h = u.host?.lowercased(), !h.isEmpty else { return false }
    return h == host || (!legacy.isEmpty && h == legacy)
  }
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
