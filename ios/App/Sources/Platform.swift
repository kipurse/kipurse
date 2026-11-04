import SwiftUI
import Security
import LocalAuthentication
import UserNotifications
import AuthenticationServices
import SafariServices
import AVFoundation
import KipurseCore
import WebKit
import BackgroundTasks
import CoreSpotlight
import AppIntents
import Intents

/// Build-time config (Config/*.xcconfig -> Info.plist). Nothing deployment-specific is hardcoded in the source.
enum AppConfig {
  static let server: URL? = (Bundle.main.object(forInfoDictionaryKey: "KipurseServer") as? String).flatMap { $0.isEmpty ? nil : URL(string: $0) }
  static var host: String { server?.host ?? L("你的 Kipurse 服务器") }
  static var mcpURL: String { server.map { $0.appendingPathComponent("mcp").absoluteString } ?? L("https://<你的服务器>/mcp") }
}

/// Owner session in the Keychain (this device only, after first unlock; never synced to iCloud).
enum SessionVault {
  private static let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.kipurse.owner-session", kSecAttrAccount as String: "owner"]
  static func save(_ s: OwnerSession) throws {
    let data = try JSONEncoder().encode(s); SecItemDelete(q as CFDictionary)
    var a = q; a[kSecValueData as String] = data; a[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let st = SecItemAdd(a as CFDictionary, nil); if st != errSecSuccess { throw KipurseError.server(L("钥匙串保存失败（\(st)）")) }
  }
  static func load() -> OwnerSession? {
    var a = q; a[kSecReturnData as String] = true; a[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?; guard SecItemCopyMatching(a as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    guard let old = try? JSONDecoder().decode(OwnerSession.self, from: d) else { return nil }
    OwnerSession.stableServer = AppConfig.server
    let m = old.migrated(); if m != old { try? save(m) }     // quick-tunnel host -> the configured stable host (same server-side session)
    return m
  }
  static func delete() { SecItemDelete(q as CFDictionary) }
}

/// App-level Face ID (falls back to the device passcode). Separate from the Coinbase wallet passkey used to sign on chain.
enum BiometricGate {
  private static var lastOK = Date.distantPast
  static func confirm(reason: String, graceSeconds: TimeInterval = 0) async -> Bool {
    if DemoGuard.active { DemoGuard.say(); return true }   // demo: never scan, just explain
    if graceSeconds > 0, Date().timeIntervalSince(lastOK) < graceSeconds { return true }
    let ctx = LAContext(); ctx.localizedCancelTitle = L("取消")
    var err: NSError?
    guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { return false }   // no passcode set: refuse owner actions
    PromptLog.add("gate")
    let ok = (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    if ok { lastOK = Date() }; return ok
  }
  /// ONE Face ID at unlock. The evaluated context is handed to the Secure Enclave key (kSecUseAuthenticationContext), so the
  /// read-session signature right after needs no second prompt. Biometrics policy, because the phone key is .biometryCurrentSet.
  static func unlockContext(reason: String) async -> LAContext? {
    if DemoGuard.active { DemoGuard.say(); return LAContext() }   // demo: no scan (the context is never used for a real key)
    let ctx = LAContext(); ctx.localizedCancelTitle = L("取消"); ctx.touchIDAuthenticationAllowableReuseDuration = 10
    var err: NSError?
    let policy: LAPolicy = .deviceOwnerAuthentication
    guard ctx.canEvaluatePolicy(policy, error: &err) else { return nil }
    PromptLog.add("unlock")
    guard (try? await ctx.evaluatePolicy(policy, localizedReason: reason)) == true else { return nil }
    lastOK = Date(); return ctx
  }
}

/// Counts Face ID prompts (DEBUG builds show it for testing). Release: no-op.
enum PromptLog {
  #if DEBUG
  static var count = 0, last = ""
  static func add(_ why: String) { count += 1; last = why; NotificationCenter.default.post(name: .init("kpPrompt"), object: nil) }
  #else
  static func add(_ why: String) {}
  #endif
}

enum Notifier {
  static func post(_ a: Approval) {
    let c = UNMutableNotificationContent(); c.title = "Kipurse · " + a.titleZh; c.body = a.bodyZh + L("（打开 App，用 Face ID 批准）"); c.sound = .default
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: a.id, content: c, trigger: nil))
  }
}

/// ASWebAuthenticationSession variant: ends when the page navigates to kipurse://done?... (kit app.js `back()`).
final class WebSigner: NSObject, ASWebAuthenticationPresentationContextProviding {
  static let shared = WebSigner(); private var s: ASWebAuthenticationSession?
  /// ephemeral = no "wants to use … to sign in" system prompt (owner pages need no cookies; the Coinbase wallet passkey is system-wide).
  func start(_ url0: URL, ephemeral: Bool = false, done: @escaping (URL?) -> Void) {
    let url = SignHost.route(url0)   // t784
    if SignHost.isShell(url) {   // pinned static signing host: verify before opening, fail closed
      Task { @MainActor in do { try await SignHost.verify(); self.open(url, ephemeral: ephemeral, done: done) } catch { done(nil) } }
      return
    }
    open(url, ephemeral: ephemeral, done: done)
  }
  private func open(_ url: URL, ephemeral: Bool, done: @escaping (URL?) -> Void) {
    s = ASWebAuthenticationSession(url: Loc.withLang(url), callbackURLScheme: "kipurse") { u, _ in done(u) }
    s?.presentationContextProvider = self; s?.prefersEphemeralWebBrowserSession = ephemeral; s?.start()
  }
  func cancel() { s?.cancel(); s = nil }
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
  }
}

/// Opens a signing page. Pages on the pinned static host (SignHost) are verified against the pinned hash first; on any
/// mismatch or network problem nothing is opened and nothing can be signed (fail closed).
struct SignPage: View {
  let url: URL
  init(url: URL) { self.url = SignHost.route(url) }   // t784: a Kipurse signing page never opens from the server directly
  @State private var ok: Bool? = nil
  var body: some View {
    if !SignHost.isShell(url) || ok == true { SafariView(url: url) }
    else if ok == false {
      VStack(spacing: 14) {
        Image(systemName: "hand.raised.circle").font(.system(size: 44)).foregroundStyle(.secondary)
        Text(T("为了安全，先停下了", "Paused for safety")).font(.title3.weight(.bold))
        Text(T("确认页面没有通过启付的安全核对，所以没有打开。你的钱还在钱包里，没有转出，也没有扣费。通常是网络不稳，稍后再试一次就好；如果一直这样，请先更新启付 App。", "The confirmation page didn’t pass Kipurse’s safety check, so it wasn’t opened. Your money is still in your wallet; nothing was sent or charged. Usually it’s the network: try again in a moment. If it keeps happening, update the Kipurse app first.")).multilineTextAlignment(.center).foregroundStyle(.secondary)
        Button(T("再试一次", "Try again")) { ok = nil }.buttonStyle(.borderedProminent).accessibilityIdentifier("sign.retry")
      }.padding(28).accessibilityIdentifier("sign.blocked")
    } else {
      ProgressView(T("正在做安全检查…", "Running safety check…")).task { do { try await SignHost.verify(); ok = true } catch { ok = false } }
    }
  }
}

/// t785u: every web page opened from the app stays INSIDE the app (SFSafariViewController on top of the current screen).
/// Kipurse signing pages are routed through the pinned sign host first. Non-web schemes (other apps: shortcuts://, agent apps,
/// kipurse://) go to the system as before. Exception kept on purpose: the Coinbase App hand-off links (see report t785).
enum InApp {
  static func isWeb(_ u: URL) -> Bool { let s = u.scheme?.lowercased(); return s == "https" || s == "http" }
  /// t866: open with a persistent hint banner in our own chrome (a small window above the in-app browser) until it is closed.
  @MainActor static func open(_ u0: URL, banner: String) { pendingBanner = banner; open(u0) }
  @MainActor static var pendingBanner: String?
  @MainActor static var bannerWindow: UIWindow?
  @MainActor static let finisher = Finisher()
  final class Finisher: NSObject, SFSafariViewControllerDelegate {
    func safariViewControllerDidFinish(_ controller: SFSafariViewController) { Task { @MainActor in InApp.hideBanner() } }
  }
  @MainActor static func hideBanner() { bannerWindow?.isHidden = true; bannerWindow = nil }
  @MainActor static func showBanner(_ text: String) {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
    hideBanner()
    let b: CGRect = scene.screen.bounds; let h: CGFloat = 52
    let inset: CGFloat = scene.windows.first?.safeAreaInsets.bottom ?? 34
    let y: CGFloat = b.height - inset - 70 - h
    let w = UIWindow(windowScene: scene); w.frame = CGRect(x: 12, y: y, width: b.width - 24, height: h); w.windowLevel = .alert + 1; w.backgroundColor = .clear
    let vc = UIViewController(); vc.view.backgroundColor = UIColor(red: 0.85, green: 0.12, blue: 0.16, alpha: 0.96); vc.view.layer.cornerRadius = 14; vc.view.clipsToBounds = true
    let l = UILabel(); l.text = text; l.textColor = .white; l.font = .systemFont(ofSize: 15, weight: .bold); l.textAlignment = .center; l.numberOfLines = 2; l.adjustsFontSizeToFitWidth = true
    l.translatesAutoresizingMaskIntoConstraints = false; vc.view.addSubview(l); vc.view.isAccessibilityElement = false; l.accessibilityIdentifier = "inapp.banner"
    NSLayoutConstraint.activate([l.leadingAnchor.constraint(equalTo: vc.view.leadingAnchor, constant: 10), l.trailingAnchor.constraint(equalTo: vc.view.trailingAnchor, constant: -10), l.centerYAnchor.constraint(equalTo: vc.view.centerYAnchor)])
    w.rootViewController = vc; w.isUserInteractionEnabled = false; w.isHidden = false; bannerWindow = w
  }
  @MainActor static func open(_ u0: URL) {
    guard isWeb(u0) else { pendingBanner = nil; UIApplication.shared.open(u0); return }
    let u = SignHost.route(u0)
    if SignHost.isShell(u) {   // pinned host: verify the hash first, fail closed (calm), same as SignPage
      Task { @MainActor in if (try? await SignHost.verify()) != nil { present(u) } }
      return
    }
    present(u)
  }
  @MainActor private static func present(_ u: URL) {
    let c = SFSafariViewController.Configuration(); c.entersReaderIfAvailable = false
    let v = SFSafariViewController(url: Loc.withLang(u), configuration: c); v.dismissButtonStyle = .done
    let banner = pendingBanner; pendingBanner = nil
    if let banner { v.delegate = finisher }
    guard var top = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
    while let p = top.presentedViewController { top = p }
    top.present(v, animated: true) { if let banner { InApp.showBanner(banner) } }
  }
  /// SwiftUI Link / openURL -> in-app
  static var action: OpenURLAction { OpenURLAction { url in Task { @MainActor in InApp.open(url) }; return .handled } }
}

/// SFSafariViewController variant (default): full Safari engine, so window.open to keys.coinbase.com and passkeys behave like Safari.
struct SafariView: UIViewControllerRepresentable {
  let url: URL
  func makeUIViewController(context: Context) -> SFSafariViewController {
    let c = SFSafariViewController.Configuration(); c.entersReaderIfAvailable = false
    let v = SFSafariViewController(url: Loc.withLang(url), configuration: c); v.dismissButtonStyle = .done; return v
  }
  func updateUIViewController(_ v: SFSafariViewController, context: Context) {}
}

/// Camera QR scanner for the owner one-time link.
struct QRScanner: UIViewControllerRepresentable {
  let found: (String) -> Void
  func makeUIViewController(context: Context) -> ScannerVC { let v = ScannerVC(); v.found = found; return v }
  func updateUIViewController(_ v: ScannerVC, context: Context) {}
  final class ScannerVC: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var found: ((String) -> Void)?; private let session = AVCaptureSession(); private var done = false
    override func viewDidLoad() {
      super.viewDidLoad(); view.backgroundColor = .black
      guard let dev = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: dev), session.canAddInput(input) else { return }
      session.addInput(input); let out = AVCaptureMetadataOutput(); guard session.canAddOutput(out) else { return }
      session.addOutput(out); out.setMetadataObjectsDelegate(self, queue: .main); out.metadataObjectTypes = [.qr]
      let layer = AVCaptureVideoPreviewLayer(session: session); layer.frame = view.bounds; layer.videoGravity = .resizeAspectFill; view.layer.addSublayer(layer)
      DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
    }
    override func viewWillDisappear(_ a: Bool) { super.viewWillDisappear(a); session.stopRunning() }
    func metadataOutput(_ o: AVCaptureMetadataOutput, didOutput objs: [AVMetadataObject], from c: AVCaptureConnection) {
      guard !done, let s = (objs.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
      done = true; session.stopRunning(); found?(s)
    }
  }
}

/// Factory reset of everything this app stored on the device (logout and account deletion): the app returns to fresh-install state.
/// Covers Keychain (every item of this app), UserDefaults (whole domain incl. @AppStorage: Coinbase address, rescue link,
/// signing mode, seen approvals, open tab), Documents / Library (Caches, Application Support, Preferences files) / tmp,
/// URLCache, cookies, WKWebView + SFSafariViewController website data, pending/delivered notifications + badge,
/// scheduled background polls, Spotlight items and App Intents donations. App Shortcuts phrases are code, not user data.
enum LocalWipe {
  static func keychainClasses() -> [CFString] { [kSecClassGenericPassword, kSecClassInternetPassword, kSecClassCertificate, kSecClassKey, kSecClassIdentity] }
  /// keepPhoneKey: logout / fresh-install cleanup keep the Secure Enclave phone signer (it is an on-chain owner of the wallet;
  /// losing it would need a Coinbase wallet revoke). Only "delete account" passes false.
  @MainActor static func all(keepPhoneKey: Bool = true) async {
    if DemoGuard.active { return }   // demo never wipes real data
    LedgerCache.wipe()   // t821: encrypted activity copy goes with every wipe
    for c in keychainClasses() where !(keepPhoneKey && c == kSecClassKey) { SecItemDelete([kSecClass as String: c, kSecAttrSynchronizable as String: kSecAttrSynchronizableAny] as CFDictionary) }
    if keepPhoneKey { deleteKeys(except: PhoneKey.tag) }
    if let id = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: id); UserDefaults.standard.synchronize() }
    UserDefaults(suiteName: SharedSpend.group)?.removePersistentDomain(forName: SharedSpend.group)   // widget snapshot (App Group)
    if let g = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: SharedSpend.group) { for f in (try? FileManager.default.contentsOfDirectory(at: g.appendingPathComponent("Library/Caches"), includingPropertiesForKeys: nil)) ?? [] { try? FileManager.default.removeItem(at: f) } }
    let fm = FileManager.default
    var dirs = [fm.temporaryDirectory]
    for d in [FileManager.SearchPathDirectory.documentDirectory, .cachesDirectory, .applicationSupportDirectory] { dirs += fm.urls(for: d, in: .userDomainMask) }
    for d in dirs { for f in (try? fm.contentsOfDirectory(at: d, includingPropertiesForKeys: nil)) ?? [] { try? fm.removeItem(at: f) } }
    URLCache.shared.removeAllCachedResponses()
    HTTPCookieStorage.shared.cookies?.forEach { HTTPCookieStorage.shared.deleteCookie($0) }
    await WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    await SFSafariViewController.DataStore.default.clearWebsiteData()
    let n = UNUserNotificationCenter.current(); n.removeAllPendingNotificationRequests(); n.removeAllDeliveredNotifications(); try? await n.setBadgeCount(0)
    BGTaskScheduler.shared.cancelAllTaskRequests()
    try? await CSSearchableIndex.default().deleteAllSearchableItems()   // Spotlight: indexed payees (PayeeEntity) and anything else
    try? await INInteraction.deleteAll()
    await AssistantHooks.wipe?()   // Siri module: its entities in Spotlight, every intent donation, its caches, App Shortcut parameters
  }
  /// Delete every key item except the ones with the given application tag.
  static func deleteKeys(except keep: Data) {
    var out: CFTypeRef?
    let q: [String: Any] = [kSecClass as String: kSecClassKey, kSecReturnAttributes as String: true, kSecReturnPersistentRef as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let items = out as? [[String: Any]] else { return }
    for i in items where (i[kSecAttrApplicationTag as String] as? Data) != keep { if let r = i[kSecValuePersistentRef as String] as? Data { SecItemDelete([kSecValuePersistentRef as String: r] as CFDictionary) } }
  }
  /// What a fresh install has: nothing. Used by the factory-reset self-check (Settings → 关于 / tests).
  static func remnants(includePhoneKey: Bool = false) -> [String] {
    var r: [String] = []
    if SessionVault.load() != nil { r.append(L("钥匙串登录")) }
    if MainnetSession.load() != nil { r.append(L("登录状态")) }
    if includePhoneKey, PhoneKey.isPresent() { r.append(L("手机确认钥匙")) }
    r += AssistantHooks.remnants?() ?? []
    if let id = Bundle.main.bundleIdentifier, let d = UserDefaults.standard.persistentDomain(forName: id), !d.isEmpty { r.append(L("偏好设置 \(d.keys.sorted().joined(separator: ","))")) }
    let fm = FileManager.default
    for d in [FileManager.SearchPathDirectory.documentDirectory, .applicationSupportDirectory] { for u in fm.urls(for: d, in: .userDomainMask) { if let c = try? fm.contentsOfDirectory(atPath: u.path), !c.isEmpty { r.append(L("\(u.lastPathComponent): \(c.count) 个文件")) } } }
    return r
  }
}

/// Auth / session errors with their real domain + code, appended to Documents/kp-auth.log (read with devicectl). No secrets logged.
enum AuthLog {
  static var url: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("kp-auth.log") }
  static func record(_ phase: String, _ e: Error) {
    let n = e as NSError; var line = "\(ISO8601DateFormatter().string(from: Date())) \(phase) domain=\(n.domain) code=\(n.code) desc=\(n.localizedDescription)"
    if let u = n.userInfo[NSUnderlyingErrorKey] as? NSError { line += " under=\(u.domain)/\(u.code)" }
    NSLog("[kp-auth] %@", line)
    let d = Data((line + "\n").utf8)
    if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(d); try? h.close() } else { try? d.write(to: url) }
  }
  static func isUserCancel(_ e: Error) -> Bool {
    let n = e as NSError
    if n.domain == "com.apple.LocalAuthentication" { return [-2, -4, -9].contains(n.code) }   // userCancel, systemCancel, appCancel
    if n.domain == NSOSStatusErrorDomain || n.domain == "CryptoTokenKit" { return n.code == -128 || n.code == -4 || n.code == -2 }
    return false
  }
  static func isURLCancel(_ e: Error) -> Bool { let n = e as NSError; return n.domain == NSURLErrorDomain && n.code == NSURLErrorCancelled }
  static func friendly(_ e: Error) -> String {
    let n = e as NSError
    if n.domain == NSURLErrorDomain { return isURLCancel(e) ? L("没有连上，请重试") : L("网络连接有问题，请重试") }
    #if DEBUG
    return e.localizedDescription + " (\(n.domain) \(n.code))"
    #else
    return e.localizedDescription
    #endif
  }
}
