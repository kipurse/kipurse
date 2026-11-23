import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum KipurseError: Error, LocalizedError, Equatable {
  case loginLinkUsed, notLoggedIn, server(String), badServer, network(String)
  public var errorDescription: String? {
    switch self {
    case .loginLinkUsed: return L("这个登录码已经用过或无效。请在电脑上重新运行启动命令，再扫新的码。")
    case .notLoggedIn: return L("需要重新登录：请扫电脑上的新二维码。")
    case .server(let m): return m
    case .badServer: return L("服务器地址不对：要 https://，或者家里局域网的 http:// 地址。")
    case .network(let m): return L("连不上服务器：\(m)")
    }
  }
}

/// Owner session = the kit's HttpOnly `kp` cookie + its CSRF value. Stored by the app in the Keychain (see SessionVault).
public struct OwnerSession: Codable, Equatable { public let server: URL; public let cookie: String; public var csrf: String?
  public init(server: URL, cookie: String, csrf: String? = nil) { self.server = server; self.cookie = cookie; self.csrf = csrf } }

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
  func urlSession(_ s: URLSession, task: URLSessionTask, willPerformHTTPRedirection r: HTTPURLResponse, newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Talks to kit/server.mjs: /login (one-time code -> cookie), /api/csrf, /api/<fn>. No keys ever pass through the app.
public final class OwnerAPI {
  public private(set) var session: OwnerSession?
  private let http: URLSession
  public init(session: OwnerSession? = nil) {
    self.session = session
    let cfg = URLSessionConfiguration.ephemeral; cfg.httpCookieStorage = nil; cfg.httpShouldSetCookies = false; cfg.timeoutIntervalForRequest = 20
    http = URLSession(configuration: cfg, delegate: NoRedirect(), delegateQueue: nil)
  }

  /// Redeem the one-time link. Returns the new session (caller stores it in the Keychain).
  public func login(_ link: OwnerLink) async throws -> OwnerSession {
    var c = URLComponents(url: link.server.appendingPathComponent("login"), resolvingAgainstBaseURL: false)!
    c.queryItems = [URLQueryItem(name: "code", value: link.code)]
    let (_, resp) = try await data(URLRequest(url: c.url!))
    guard let h = resp as? HTTPURLResponse else { throw KipurseError.network("no response") }
    if h.statusCode == 403 { throw KipurseError.loginLinkUsed }
    guard let ck = Self.kpCookie(h.value(forHTTPHeaderField: "Set-Cookie")) else { throw KipurseError.server(L("登录失败（\(h.statusCode)）")) }
    var s = OwnerSession(server: link.server, cookie: ck); session = s
    s.csrf = try await fetchCSRF(); session = s; return s
  }

  public static func kpCookie(_ header: String?) -> String? {
    guard let header = header, let r = header.range(of: #"kp=([0-9a-f]{64})"#, options: .regularExpression) else { return nil }
    return String(header[r].dropFirst(3))
  }

  func fetchCSRF() async throws -> String {
    guard let s = session else { throw KipurseError.notLoggedIn }
    var r = URLRequest(url: s.server.appendingPathComponent("api/csrf")); r.setValue("kp=\(s.cookie)", forHTTPHeaderField: "Cookie")
    let (d, resp) = try await data(r)
    if (resp as? HTTPURLResponse)?.statusCode == 401 { throw KipurseError.notLoggedIn }
    guard let j = try? JSONDecoder().decode([String:String].self, from: d), let c = j["csrf"] else { throw KipurseError.server(L("CSRF 失败")) }
    return c
  }

  /// POST/GET /api/<fn>. Retries once after refreshing CSRF.
  @discardableResult public func call(_ fn: String, _ body: [String:JSONValue]? = nil) async throws -> JSONValue {
    guard var s = session else { throw KipurseError.notLoggedIn }
    if s.csrf == nil { s.csrf = try await fetchCSRF(); session = s }
    var r = URLRequest(url: s.server.appendingPathComponent("api/\(fn)"))
    r.setValue("kp=\(s.cookie)", forHTTPHeaderField: "Cookie"); r.setValue(s.csrf, forHTTPHeaderField: "x-kp-csrf")
    r.setValue(Loc.isChinese ? "zh" : "en", forHTTPHeaderField: "x-kp-lang")
    if let b = body { r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "Content-Type"); r.httpBody = try JSONEncoder().encode(b) }
    let (d, resp) = try await data(r)
    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
    let j = (try? JSONDecoder().decode(JSONValue.self, from: d)) ?? .null
    if code == 401 { throw KipurseError.notLoggedIn }
    if code >= 400 { throw KipurseError.server(ServerText.text(code: j["error"]?.string, status: code)) }
    return j
  }

  public func state() async throws -> WalletState { WalletState(try await call("state")) }

  /// A fresh one-time web link for the SAME owner (server: POST /api/webLink), opened in Safari-based views for passkey signing.
  public func webLink(next: String) async throws -> URL {
    let j = try await call("webLink", ["next": .string(next)])
    guard let u = j["url"]?.string.flatMap(URL.init(string:)) else { throw KipurseError.server(L("webLink 失败")) }
    return u
  }

  private func data(_ r: URLRequest) async throws -> (Data, URLResponse) {
    do {
      return try await withCheckedThrowingContinuation { cont in
        http.dataTask(with: r) { d, resp, e in if let e = e { cont.resume(throwing: e) } else { cont.resume(returning: (d ?? Data(), resp!)) } }.resume()
      }
    } catch let e as KipurseError { throw e } catch { throw KipurseError.network(error.localizedDescription) }
  }
}

public extension OwnerSession {
  /// Stable public host of the owner's kit, from the app's build config (Info.plist KipurseServer). nil = no migration.
  nonisolated(unsafe) static var stableServer: URL?
  /// Sessions created through a temporary quick tunnel (*.trycloudflare.com) move to the stable host. The kp cookie is a server-side
  /// session sent by the app itself (not a browser cookie), so it stays valid on the new origin: no re-login needed.
  func migrated() -> OwnerSession {
    guard let stable = OwnerSession.stableServer, let h = server.host, h.hasSuffix(".trycloudflare.com") else { return self }
    return OwnerSession(server: stable, cookie: cookie, csrf: csrf)
  }
}
