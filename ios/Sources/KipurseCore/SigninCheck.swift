import Foundation
import CryptoKit

/// t789: the "Sign in with Coinbase" page must stay on pay.kipurse.com (the SIWE domain the Coinbase wallet shows and the server
/// checks is the page's own host), so it cannot move to the pinned sign host. Instead, before showing it, the phone fetches the
/// page and its bundle itself and refuses unless:
///   - the bundle /signin.js hashes to the sha384 pinned below (the same value the page's <script integrity> carries), and
///   - the page has exactly two scripts: the inert kp-data JSON and that one bundle tag with the pinned integrity,
///     and no iframe / form / object / embed / base / meta refresh / javascript: URL / inline event handler.
/// Safari then enforces the SRI itself when it loads the bundle. Residual risk (documented in the handbook): a server that is
/// already compromised could answer the phone's check and the browser differently; the page only ever asks for a free SIWE
/// signature, and every money step still goes through the pinned sign host + the phone's own batch checks.
public enum SigninCheck {
  public static let scriptSRI = "sha384-QNbm/X1nJaabK6dmly8sf65qfUHAkLgaCJHUfplx99ISQq9mkeXjtHosMwPAoJQ9"
  public static func sri(_ d: Data) -> String { "sha384-" + Data(SHA384.hash(data: d)).base64EncodedString() }
  /// nil = the page looks exactly like the published sign-in page; otherwise a short reason (never shown raw to users).
  public static func htmlProblem(_ html: String) -> String? {
    let lower = html.lowercased()
    guard lower.components(separatedBy: "<script").count - 1 == 2 else { return "script_count" }
    guard lower.contains("<script type=\"application/json\" id=kp-data>") else { return "no_data" }
    let tag = #"<script nonce="[A-Za-z0-9_-]{8,64}" src="/signin\.js\?v=[0-9a-z]{1,16}" integrity="([^"]+)"></script>"#
    guard let r = html.range(of: tag, options: .regularExpression) else { return "bundle_tag" }
    guard html[r].contains("integrity=\"\(scriptSRI)\"") else { return "bundle_sri" }
    for bad in ["<iframe", "<form", "<object", "<embed", "<base", "http-equiv", "javascript:", "<link"] where lower.contains(bad) { return "forbidden" }
    if lower.range(of: #"\son[a-z]+\s*="#, options: .regularExpression) != nil { return "handler" }
    return nil
  }
  public static func scriptProblem(_ js: Data) -> String? { sri(js) == scriptSRI ? nil : "bundle_hash" }
  public enum Failure: Error { case unreachable, mismatch(String) }
  /// Fetch the page + its bundle fresh and check both. Throws -> do not open the page.
  public static func verify(page: URL, session: URLSession = .shared) async throws {
    guard page.scheme == "https", page.host?.lowercased() == SignHost.apiHost, page.path == "/signin" else { throw Failure.mismatch("url") }
    func get(_ u: URL) async throws -> Data {
      var r = URLRequest(url: u); r.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData; r.timeoutInterval = 15; SignHost.likeSafari(&r)
      guard let (d, resp) = try? await session.data(for: r), (resp as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.unreachable }
      return d
    }
    let html = try await get(page)
    guard let s = String(data: html, encoding: .utf8) else { throw Failure.mismatch("encoding") }
    if let p = htmlProblem(s) { throw Failure.mismatch(p) }
    var c = URLComponents(); c.scheme = "https"; c.host = SignHost.apiHost; c.path = "/signin.js"
    let js = try await get(c.url!)
    if let p = scriptProblem(js) { throw Failure.mismatch(p) }
  }
  public static var stopText: String { T("登录页正在更新，请稍后再试。没有签任何东西，也没有扣费。",
                                          "The sign-in page is updating. Please try again in a moment. Nothing was signed or charged.") }   // t810: calm wording; the check itself stays strict
  public static var offlineText: String { T("现在连不上登录页，请检查网络后再试。", "Can't reach the sign-in page right now. Check your connection and try again.") }
}
