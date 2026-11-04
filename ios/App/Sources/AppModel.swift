import LocalAuthentication
import SwiftUI
import KipurseCore
import UserNotifications
import BackgroundTasks

struct WebSheet: Identifiable { let id = UUID(); let url: URL }
/// One Coinbase Onramp purchase being checked after checkout (server ref kp-...).
struct OnrampTrack: Identifiable { var id: String { ref }; let ref: String; var returnedAt = Date() }
struct AlertItem: Identifiable { let id = UUID(); let title: String; let message: String }

/// App state. Owner session lives in the Keychain; owner actions go through the Face ID gate; approvals are polled and notified locally.
@MainActor
final class AppModel: ObservableObject {
  @Published var session: OwnerSession? = SessionVault.load()
  @Published var state: WalletState? { didSet { if state != nil && demo == nil && phoneUnbound { phoneUnbound = false; Unbound.forget() } } }
  /// Non-USDC coins found in the wallet (can't be used by the AI; the owner can send them back from the deposit page).
  @Published var stray: [StrayToken] = []
  /// No app lock: opening the app never asks for Face ID. Balances are hidden ("••••") until a tap + Face ID reveals them;
  /// they hide again after about 5 minutes away from the app (short trips keep them shown). Money moves always need their own Face ID signature.
  @Published var locked = false
  @Published var balanceRevealed = false { didSet { if balanceRevealed { revealedAt = Date() } } }
  private var revealedAt = Date.distantPast
  private var backgroundAt: Date?
  static let revealTTL: TimeInterval = 300
  @Published var privacyCover = false   // app-switcher snapshot hides balances
  /// Production app: mainnet (Base) only. The testnet kit was removed.
  let isMain = true
  @Published var mainNeedsSignIn = false
  /// The wallet exists but THIS phone isn't bound (reinstall / new phone): home shows the bind card + the no-phone emergency page.
  @Published var phoneUnbound = false
  /// kipurse://bind and the "去绑定" buttons: the bind flow as a sheet.
  @Published var bindSheet = false
  /// New install: the user must "Sign in with Coinbase" before any wallet is looked up (the keychain phone key survives app deletion).
  @Published var needsIdentity = false
  /// 退出登录 / 换账户: local only. Server records, on-chain state and funds are untouched; the phone key stays (signing back in
  /// with the same Coinbase account reconnects with a free signature). No Face ID: nothing is moved or signed.
  func signOut() {
    poll?.cancel(); MainnetSession.clear(); Operator.setWallet(nil)
    Unbound.forget(); phoneUnbound = false
    let d = UserDefaults.standard; for k in [CoinbaseIdentity.verifiedKey, CoinbaseIdentity.ownerKey, "seenApprovals"] { d.removeObject(forKey: k) }
    if demo != nil { exitDemo() }
    state = nil; balanceRevealed = false; mainNeedsSignIn = false; mainError = nil; webSheet = nil; needsIdentity = true
  }
  func identityVerified() { UserDefaults.standard.set(true, forKey: CoinbaseIdentity.verifiedKey); needsIdentity = false }
  @Published var mainError: String?
  // t821: Kipurse server unreachable -> calm banner + balance straight from Base + saved activity.
  @Published var serverDown = false
  @Published var showRescueGuide = false
  @Published var chainBalances: ChainRescue.Balances?
  @Published var chainLoading = false
  var cachedState: (Date, WalletState)? { LedgerCache.load() }
  @discardableResult func loadChainBalance(force: Bool = false) async -> ChainRescue.Balances? {
    guard FeatureSwitch.chainRead.on, demo == nil, let w = state?.wallet ?? RescueIdentity.wallet else { return nil }
    if let b = chainBalances, !force { return b }
    chainLoading = true; defer { chainLoading = false }
    let b = await ChainRescue.balances(wallet: w); if b != nil { chainBalances = b }; return b ?? chainBalances
  }
  /// Any HTTP answer from the Kipurse server = up; a network failure = down. Never shows the raw system error.
  func checkServer() async {
    guard FeatureSwitch.calmBanner.on, isMain, demo == nil else { serverDown = false; return }
    var r = URLRequest(url: Mainnet.base, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6); r.httpMethod = "HEAD"
    let down = (try? await URLSession.shared.data(for: r)) == nil
    if down != serverDown { serverDown = down }
    if down { await loadChainBalance() }
  }
  /// Signing pages run in SFSafariViewController (shares the owner's Safari/Coinbase login; ASWebAuthenticationSession ephemeral forced re-login).
  /// Leaving the app to fetch a code must never tear it down, so the app lock waits until the sheet is closed.
  @Published var webSheet: WebSheet? { didSet { if webSheet == nil, lockAfterSheet { lockAfterSheet = false; locked = true }; if webSheet == nil, let r = onrampPendingRef { onrampPendingRef = nil; onrampTrack = OnrampTrack(ref: r) } } }
  /// Onramp: ref of the checkout page now open; when it closes (redirect or Done) we start checking the purchase.
  var onrampPendingRef: String?
  @Published var onrampTrack: OnrampTrack?
  private var lockAfterSheet = false
  /// Last on-chain limits change (from kipurse://limits-updated or seen by polling): drives the success overlay + the 已更新 badge.
  @Published var limitsUpdated: LimitsUpdate?
  @Published var limitsCelebrate = false
  /// #3: emergency page could not be reached (offline): show the built-in fallback instead of a blank page.
  @Published var emergencyOffline: URL?
  @Published var emergencyFirst: URL?   // t796: native screen before the web page
  /// 授权中… (signed + submitted, waiting for Base) and its failure text. Shown full-screen instead of the old limits form.
  @Published var authPending: LimitsPending?
  @Published var authFailed: String?
  var authOverlayShown: Bool { limitsCelebrate || authPending != nil || authFailed != nil }
  @Published var phoneSignerChanged: String?
  @Published var alert: AlertItem?
  @Published var busy = false
  @Published var toast: String?
  @Published var museSheet = false
  /// A sheet can't open while the Connect-Muse sheet is up (SwiftUI shows one sheet at a time): the approval handed over
  /// from the consent page was silently dropped and the owner landed back on the Muse sheet. Close it first, then present.
  func afterMuse(_ f: @escaping () -> Void) {
    // Any open sheet blocks the next one (Connect-AI result, fee check, recovery, withdraw-after-erase, web page, Siri pay draft).
    let open = museSheet || agentSheet != nil || gasGate != nil || showRecovery || afterErase != nil || webSheet != nil || PayDraftCenter.shared.draft != nil
    museSheet = false; agentSheet = nil; gasGate = nil; showRecovery = false; afterErase = nil; webSheet = nil
    NotificationCenter.default.post(name: .kpCloseLocalSheets, object: nil)
    if open { DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { f() } } else { f() }
  }
  @Published var agentLink: JSONValue?

  @AppStorage("signingMode") var signingMode = SigningMode.safariView.rawValue
  private(set) var api: OwnerAPI
  @Published var recovery: RecoveryGuide?          // in memory only: deletion leaves nothing on the device
  @Published var showRecovery = false
  private var poll: Task<Void, Never>?
  private var seenApprovals: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "seenApprovals") ?? [])

  /// Screenshot/demo mode (Debug only): launch with `-demo onboarding|setup|fund|home|approvals|lock`. Uses fake local state, no network.
  @Published var demo: String?
  @Published var openTx: String?
  @Published var reportTx: String?
  @Published var celebrate: Tx?
  init() {
    api = OwnerAPI(session: SessionVault.load())
    NotificationCenter.default.addObserver(forName: AssistantHooks.decision, object: nil, queue: .main) { [weak self] n in MainActor.assumeIsolated { self?.assistantDecision(n) } }
    Awareness.registerCategories(); NotificationRouter.shared.model = self; UNUserNotificationCenter.current().delegate = NotificationRouter.shared
    if CommandLine.arguments.contains("-kpKeyDiag") { AppModel.keyDiag(); exit(0) }   // read-only: public fingerprints only, then quit (no wipe)
    // Fresh-install cleanup runs only on the very first launch of this install (UserDefaults is removed with the app) and never deletes
    // the phone signer key: a locked device or a background launch can hide keychain items, which used to look like "fresh install".
    #if DEBUG
    if CommandLine.arguments.contains("-kpIdentityOK") { UserDefaults.standard.set(true, forKey: CoinbaseIdentity.verifiedKey) }   // UI tests of later screens
    if CommandLine.arguments.contains("-kpFreshInstall") { for k in [CoinbaseIdentity.verifiedKey, CoinbaseIdentity.ownerKey, "kp.launchedBefore", "kp.assistant.demo"] {   // t806: Siri-test demo flag must not leak into a fresh-install test
      UserDefaults.standard.removeObject(forKey: k) }; Operator.setWallet(nil) }
    if CommandLine.arguments.contains("-kpFreshInstall") || (CommandLine.arguments.contains("-kp.lang") && !CommandLine.arguments.contains("-kpKeepUnbound")) { Unbound.forget() }   // UI tests never leak the bind card into each other
    if let i = CommandLine.arguments.firstIndex(of: "-kpKnownWallet"), i + 1 < CommandLine.arguments.count { Unbound.remember(wallet: CommandLine.arguments[i + 1], path: nil) }   // t851: wallet known, no session yet
    if CommandLine.arguments.contains("-kpUnbound") { Unbound.remember(wallet: "0x2000000000000000000000000000000000000002", path: nil); phoneUnbound = true }
    if let i = CommandLine.arguments.firstIndex(of: "-kpUnboundWallet"), i + 1 < CommandLine.arguments.count { Unbound.remember(wallet: CommandLine.arguments[i + 1], path: nil); phoneUnbound = true }   // t789 live UI test: a real wallet's emergency page   // reinstall / new phone: bind card
    #endif
    CoinbaseIdentity.migrate(launchedBefore: UserDefaults.standard.bool(forKey: "kp.launchedBefore"), wallet: Operator.wallet)   // app updates keep a working wallet
    needsIdentity = !CoinbaseIdentity.verified() && !AppModel.assistantDemo && !CommandLine.arguments.contains("-demo")
    if !UserDefaults.standard.bool(forKey: "kp.launchedBefore"), SessionVault.load() == nil, MainnetSession.load() == nil, !PhoneKey.isPresent(), !CommandLine.arguments.contains("-wipeSelfTest"), !AppModel.assistantDemo { Task { await LocalWipe.all(keepPhoneKey: true); UserDefaults.standard.set(true, forKey: "kp.launchedBefore") } } else { UserDefaults.standard.set(true, forKey: "kp.launchedBefore") }   // not logged in = fresh-install state: clear any leftovers (tmp PDF, caches)
    if isMain, !CommandLine.arguments.contains("-demo") { Task { await checkServer() } }   // t821
    if !CommandLine.arguments.contains("-demo"), !needsIdentity, SessionVault.load() != nil || isMain { Task { await resume() } }   // new install: nothing is resolved before Sign in with Coinbase   // open without Face ID: reuse a live session if there is one
    #if DEBUG
    if CommandLine.arguments.contains("-wipeSelfTest") { Task { let r = await AppModel.wipeSelfTest(); wipeReport = r } }
    if let i = CommandLine.arguments.firstIndex(of: "-demo"), i + 1 < CommandLine.arguments.count {
      demo = CommandLine.arguments[i + 1]; locked = demo == "lock" || CommandLine.arguments.contains("-kpFaceTest"); balanceRevealed = !CommandLine.arguments.contains("-kpMasked")
      DemoGuard.active = true; AppModel.demoOwner(); state = AppModel.demoState(demo!)   // t802: demo wallet first, so the sample state carries an address (clean install had an empty slot)
      if let k = CommandLine.arguments.firstIndex(of: "-kpStray"), k + 1 < CommandLine.arguments.count { stray = WrongToken.demo(CommandLine.arguments[k + 1]) }
      if CommandLine.arguments.contains("-kpAssistantDemo"), let s = state { Task { @MainActor in try? await Task.sleep(nanoseconds: 1_500_000_000)   // after the fresh-install wipe above
        AppModel.demoOwner(); UserDefaults.standard.set(true, forKey: "kp.assistant.demo"); AssistantHooks.stateChanged?(s) } }
      #if DEBUG   // UI tests: simulate the page's return URL (no signing, no network)
      if let j = CommandLine.arguments.firstIndex(of: "-openURL"), j + 1 < CommandLine.arguments.count, let u = URL(string: CommandLine.arguments[j + 1]) {
        let mm = self; DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { mm.handle(url: u) } }
      #endif
    }
    #endif
  }
  /// DEBUG simulator tests of the Siri module: the system relaunches the app in the background to run intents; keep the demo data then.
  static var assistantDemo: Bool {
    #if DEBUG
    return UserDefaults.standard.bool(forKey: "kp.assistant.demo") || CommandLine.arguments.contains("-kpAssistantDemo")
    #else
    return false
    #endif
  }
  #if DEBUG
  /// Simulator-only factory-reset check: seed every kind of local user data, wipe, report what is left. Never run on a real user's phone.
  @discardableResult static func wipeSelfTest() async -> String {
    try? SessionVault.save(OwnerSession(server: URL(string: "https://example.invalid")!, cookie: String(repeating: "a", count: 64), csrf: "c"))
    let d = UserDefaults.standard; d.set("0x0000000000000000000000000000000000000001", forKey: "coinbaseAddress"); d.set("https://example.invalid/rescue/#c=x", forKey: "rescueUrl"); d.set(["a"], forKey: "seenApprovals"); d.set("authSession", forKey: "signingMode")
    let fm = FileManager.default
    for u in [fm.urls(for: .documentDirectory, in: .userDomainMask)[0], fm.urls(for: .cachesDirectory, in: .userDomainMask)[0], fm.temporaryDirectory] { try? Data("x".utf8).write(to: u.appendingPathComponent("seed.txt")) }
    let c = UNMutableNotificationContent(); c.title = "seed"; try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "seed", content: c, trigger: UNTimeIntervalNotificationTrigger(timeInterval: 3600, repeats: false)))
    HTTPCookieStorage.shared.setCookie(HTTPCookie(properties: [.name: "kp", .value: "v", .domain: "example.invalid", .path: "/"])!)
    MainnetSession.save("kps_seed", expiresIn: 3600); Operator.setWallet("0x1000000000000000000000000000000000000001")
    await AssistantHooks.selfTest?.seed()   // Siri caches, nickname, Spotlight entities, an intent donation
    let spotBefore = await AssistantHooks.selfTest?.leftover() ?? "none"; await AssistantHooks.selfTest?.seed()
    let seeded = LocalWipe.remnants()
    await LocalWipe.all()
    let pending = await UNUserNotificationCenter.current().pendingNotificationRequests().count
    let tmpLeft = ((try? fm.contentsOfDirectory(atPath: fm.temporaryDirectory.path)) ?? []).filter { $0 == "seed.txt" }.count
    let cachesLeft = ((try? fm.contentsOfDirectory(atPath: fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].path)) ?? []).filter { $0 == "seed.txt" }.count
    let report = "WIPE_SELFTEST seeded=\(seeded.count) remnants=\(LocalWipe.remnants()) pendingNotifications=\(pending) tmpSeed=\(tmpLeft) cachesSeed=\(cachesLeft) cookies=\(HTTPCookieStorage.shared.cookies?.count ?? 0) siriBefore=[\(spotBefore)] siriAfter=[\(await AssistantHooks.selfTest?.leftover() ?? "none")]"
    print(report); return report
  }
  #endif
  /// Built-in demo (also for App Review): a full wallet with sample data, no server, nothing leaves the phone.
  #if DEBUG
  #endif
  func startDemo() { DemoGuard.active = true; demo = "main"; AppModel.demoOwner(); state = AppModel.demoState("main") }
  /// Demo / App Review path (works in Release): a placeholder owner so the withdraw and "your own account" screens render. No server, no chain.
  static func demoOwner() { Operator.demoOwner = "0x1000000000000000000000000000000000000004"; Operator.demoWallet = "0x1000000000000000000000000000000000000001" }
  func exitDemo() { demo = nil; state = nil; Operator.demoWallet = nil; Operator.demoOwner = nil; DemoGuard.active = false }
  static func demoState(_ d: String) -> WalletState {
    let w = "0x896E3fA0b1C2d4E5f60718293a4B5c6D7e8FA83f"
    var j: [String: Any] = ["mode": "MAIN", "chainId": 8453, "balance": "19790000", "quarantined": "0", "reserve": "200000",
      "limits": ["perPayment": "2000000", "perDay": "5000000", "termTotal": "20000000", "unrecognizedPerPayment": "200000", "unrecognizedPerDay": "500000", "depositDailyLimit": "20000000"],
      "main": ["single": "2000000", "daily": "5000000"],
      "agents": [["id": "a1", "name": "Codex"], ["id": "a2", "name": "Claude Code"]],
      "explorer": "https://basescan.org",
      "purchases": [["state": "settled", "amount": "10000", "agent": "Codex", "txHash": "0xabc", "createdAt": Date().timeIntervalSince1970 * 1000, "payee": "0x000000000000000000000000000000000000dEaD"], ["state": "settled", "amount": "250000", "agent": "Claude Code", "createdAt": Date().timeIntervalSince1970 * 1000 - 3_600_000, "payee": "0x4f2a9C1e0B7d3E8a6F5c2D1b0A9e8F7c6D5b4A3e"], ["state": "failed", "amount": "1200000", "agent": "Codex", "createdAt": Date().timeIntervalSince1970 * 1000 - 90_000_000, "payee": "0x7aB3c4D5e6F708192A3b4C5d6E7f8091A2b3C4d5"]]]
    switch d {
    case "fund": j["setup"] = ["active": false, "wallet": w, "calls": []]; j["balance"] = "120000"
    case "home", "approvals": j["setup"] = ["active": true, "wallet": w, "human": ["termDays": 90, "perDay": "5", "termTotal": "20"]]
      if d == "approvals" { j["trust"] = ["pending": [["id": "t1", "subject": ["id": "api.weather.dev"], "single": "1000000", "daily": "3000000", "reason": L("每天查天气数据")]]]
        j["pending"] = ["withdrawals": [["id": "w1", "amount": "5000000"]]] }
    case "empty": j["purchases"] = []; j["balance"] = "0"; j["reserve"] = "0"; j["agents"] = []
    case "main", "main-all", "main-nomuse", "main-empty", "main-connect", "main-new":
      let now = Date().timeIntervalSince1970
      j = ["mode": "MAIN", "chainId": 8453, "explorer": "https://basescan.org", "balance": "14100000", "reserve": "191437",
           "caps": ["single": "10050000", "daily": "12012000", "term": "30030000", "start": "1768529520", "end": "1800065520"], "ledger": [
             ["tx": "0x737e62abaa0b8f1b4f6c3e7d2a1f0e9d8c7b6a5948372615a4b3c2d1e0f9a8b7", "t": 1792643661, "account": "vault", "kind": "settle", "delta": "8157", "balance": "191437", "zh": "备用金：收回本笔费用 0.01673，付手续费 0.008563"],  // i18n-ok: paired zh/en or zh-only data
             ["tx": "0x737e62abaa0b8f1b4f6c3e7d2a1f0e9d8c7b6a5948372615a4b3c2d1e0f9a8b7", "t": 1792643661, "account": "wallet", "kind": "payment", "delta": "-26730", "balance": "14103220", "zh": "AI 付款 0.01 给 你的 Coinbase 钱包（含手续费和手续费 0.01673）"],  // i18n-ok: paired zh/en or zh-only data
             ["tx": "0x526f66df400000000000000000000000000000000000000000000000000000cc", "t": 1792642127, "account": "owner", "kind": "ownerfee", "delta": "-6111", "zh": "确认手续费 · 你的 Coinbase 钱包"],  // i18n-ok: paired zh/en or zh-only data
             ["tx": "0x8f3346bb300000000000000000000000000000000000000000000000000000aa", "t": 1792643589, "account": "vault", "kind": "gas", "delta": "-7105", "balance": "183280", "zh": "备用金：付手续费（钱包操作）"],  // i18n-ok: paired zh/en or zh-only data
             ["tx": "0x6219df22620000000000000000000000000000000000000000000000000000bb", "t": 1792622981, "account": "wallet", "kind": "deposit", "delta": "10000000", "balance": "14129950", "zh": "充值（来自 你的 Coinbase 钱包）"],  // i18n-ok: paired zh/en or zh-only data
             ["tx": "0x0d05700000000000000000000000000000000000000000000000000000000dd", "t": 1792600000, "account": "wallet", "kind": "deposit", "delta": "1", "balance": "4129950", "zh": "充值（来自 0x2222…2222）"]], "main": ["single": "10050000", "daily": "12012000"],  // i18n-ok: paired zh/en or zh-only data
           "spent": ["today": "10000", "term": "20000"], "setup": ["active": true, "wallet": PhoneTrust.mainnetWallet, "owner": "0x1000000000000000000000000000000000000003"],
           "agents": d == "main-nomuse" ? [] : [["id": "muse", "name": "Muse", "kind": "muse", "connected": true, "lastUsed": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: now - 600))]] + (d == "main" || d == "main-all" ? [["id": "grok-bot", "name": "Grok Bot", "kind": "grok-bot", "connected": true, "lastUsed": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: now - 5400))],
              ["id": "oauth-claude-desktop", "name": "Claude", "kind": "claude-desktop", "connected": d == "main-all"]] : []),
           "purchases": d == "main-empty" ? [] : [["state": "settled", "amount": "10000", "agent": "muse", "txHash": "0xabc", "createdAt": now * 1000 - 3_600_000, "payee": "0x1000000000000000000000000000000000000003"]],
           "connectRequests": d == "main-connect" ? [["id": "demoGrokBotReq01", "client": "Grok Bot", "kind": "grok-bot", "host": "www.cursor.com", "exp": now + 540]] : [],
           "trustRequests": ["pending": d == "main" ? [["id": "3f2b9c1e-0b7d-4e8a-9f5c-2d1b0a9e8f7c", "payee": "0x4f2a9C1e0B7d3E8a6F5c2D1b0A9e8F7c6D5b4A3e", "chainId": 8453, "single": "5000000", "total": "10000000", "merchantName": "Example Shop", "reason": "VPS", "requestedBy": ["muse"], "status": "awaiting_owner"]] : []]]
      if d == "main-empty" { j["ledger"] = [] }
      #if DEBUG
      if CommandLine.arguments.contains("-kpLifeDemo") {   // t665 screenshots only: richer SAMPLE data for 「AI 生活」 (demo mode, never a real account)
        let iso = ISO8601DateFormatter(); func ago(_ s: Double) -> String { iso.string(from: Date(timeIntervalSince1970: now - s)) }
        j["agents"] = [["id": "muse", "name": "Muse", "kind": "muse", "connected": true, "lastUsed": ago(7200)],
                       ["id": "grok-bot", "name": "Grok Bot", "kind": "grok-bot", "connected": true, "lastUsed": ago(20)],
                       ["id": "oauth-claude-desktop", "name": "Claude", "kind": "claude-desktop", "connected": true, "lastUsed": ago(1800)],
                       ["id": "siri", "name": "Siri", "kind": "siri", "connected": true, "paused": true, "lastUsed": ago(86400 * 3)]]
        let cal = Calendar.current, nowD = Date(timeIntervalSince1970: now), mStart = cal.dateInterval(of: .month, for: nowD)!.start.timeIntervalSince1970
        func at(_ back: Double) -> Double { max(mStart + 3600, now - back) }   // keep sample spend inside this month
        let yest = now - 86400
        // t681: sample numbers equal to the approved mockup (本月 $486: 餐饮 165 / 出行 88 / 订阅 87 / 购物 88 / 工具 58)
        let rows: [(String, String, String, Double, String)] = [(T("Lumi 拉面馆", "Lumi Ramen"), "oauth-claude-desktop", "18500000", now - 1500, "lunch"), ("CityRide", "grok-bot", "12300000", now - 9000, "ride"),  // i18n-ok: sample data
          ("Soundwave", "muse", "9990000", yest, "monthly plan"), ("Orbit Store", "siri", "42000000", yest - 3600, "headphones"),
          ("Noodle Lab", "siri", "146500000", at(86400 * 3), "dinner"), ("Skyline Air", "grok-bot", "75700000", at(86400 * 4), "flight"),
          ("Streamly", "muse", "77010000", at(86400 * 5), "subscription"), ("Market Hall", "oauth-claude-desktop", "46000000", at(86400 * 6), "groceries store"), ("Kumo Cloud", "muse", "58000000", at(86400 * 7), "VPS")]
        j["purchases"] = rows.enumerated().map { i, r in ["purchaseKey": "life\(i)", "state": "settled", "amount": r.2, "agent": r.1, "merchantName": r.0, "reason": r.4, "badge": i % 3 == 0 ? "verified" : "new",
          "txHash": "0x" + String(repeating: String(i % 10), count: 64), "createdAt": r.3 * 1000, "payee": "0x10000000000000000000000000000000000000\(10 + i)"] as [String: Any] }
        j["balance"] = "1284600000"; j["trustRequests"] = ["pending": [Any]()]
        if var c = j["caps"] as? [String: Any] { c["daily"] = "200000000"; c["single"] = "50000000"; c["term"] = "2000000000"; j["caps"] = c }
      }
      #endif
      if d == "main-new" { j["ledger"] = []; j["purchases"] = []; j["balance"] = "0"; j["reserve"] = "0"; j["agents"] = []; j["spent"] = ["today": "0", "term": "0"]   // just opened: guide shows 1/3
        j["caps"] = ["single": "5000000", "daily": "50000000", "term": "500000000", "start": "1768529520", "end": "1776305520"] }
    default: break
    }
    let data = try! JSONSerialization.data(withJSONObject: j)
    return WalletState(try! JSONDecoder().decode(JSONValue.self, from: data))
  }

  // MARK: owner-signing pages (Coinbase wallet) opened from the app
  /// ASWebAuthenticationSession (callback scheme kipurse): the page's redirect to kipurse://… closes it by itself and hands us the result.
  /// Backup: while it is open we also poll the read-only mainnet state and close it ourselves once the change is live on chain.
  private var ownerPoll: Task<Void, Never>?
  /// Before any page where the user's own Coinbase wallet signs a transaction: show the network fee they pay themselves and
  /// block signing if their Base wallet lacks the ETH (GasCheck). Kipurse never pays gas.
  @Published var gasGate: GasGate?
  func openOwnerPage(_ url: URL, done: @escaping @MainActor (AppModel) async -> Bool) {
    if demo != nil { DemoGuard.say(); return }   // demo: no real signing pages
    if GasCheck.enabled || GasCheck.Kind.from(url: url) == .phoneUpgrade { gasGate = GasGate(url: url, kind: GasCheck.Kind.from(url: url)) { [weak self] in self?.openOwnerPageChecked(url, done: done) }; return }
    openOwnerPageChecked(url, done: done)
  }
  /// Free pages (Sign in with Coinbase): no network-fee preflight.
  func openFreePage(_ url: URL, done: @escaping @MainActor (AppModel) async -> Bool) { if demo != nil { DemoGuard.say(); return }; openOwnerPageChecked(url, done: done) }
  private func openOwnerPageChecked(_ url0: URL, done: @escaping @MainActor (AppModel) async -> Bool) {
    let url = SignHost.route(url0)   // t784: Kipurse signing pages only open through the pinned, hash-checked sign host
    ownerPoll?.cancel()
    let sheet = WebSheet(url: url); webSheet = sheet
    ownerPoll = Task { @MainActor [weak self] in
      for _ in 0..<400 { try? await Task.sleep(nanoseconds: 3_000_000_000); guard let self, !Task.isCancelled else { return }
        if await done(self) { return }
        if self.webSheet?.id != sheet.id && self.authPending == nil { return }   // closed without signing: nothing to wait for
      }
    }
  }
  /// Demo / App Review: the withdraw screen with sample numbers (nothing is sent).
  var demoWithdraw: MainWithdrawView.Quote? {
    guard demo != nil else { return nil }
    let b = max(0, state?.balance ?? 0)   // t927: the demo withdraw equals the real balance shown on the home card (was a fixed 13.95)
    return .init(amount: b, inWallet: b, reserve: 0, to: "0x1111111111111111111111111111111111111111", vault: nil, fee: 3_000, wallet: state?.wallet ?? "0x1000000000000000000000000000000000000001")
  }
  func openLimitsSigning(_ url: URL) {
    let before = state?.capStart; limitsBefore = before
    openOwnerPage(url) { m in await m.limitsTick(before: before) }
  }
  private var limitsBefore: Date?
  /// One poll: on chain -> 授权完成; submitted -> close the page, 授权中…; server gave up -> failure + retry.
  func limitsTick(before: Date?) async -> Bool {
    await refresh()
    guard let s = state else { return false }
    if let a = s.capStart, a != before, let e = s.capEnd, let x = s.capSingle, let d = s.capDaily, let t = s.capTerm {
      celebrate(LimitsUpdate(single: x, daily: d, term: t, start: a, end: e)); return true }
    if let p = s.limitsPending {
      if p.failed { showAuthFailed(L("Base 还没有确认这次授权，没有扣钱。可以再查一次，或回到上限重新确认。")); return true }
      lockAfterSheet = false; webSheet = nil; if authPending == nil { Haptics.tap() }; authPending = p; authFailed = nil
      if Date().timeIntervalSince1970 - Double(p.since) > 240 { showAuthFailed(L("等了 4 分钟还没在链上看到结果，没有扣钱。可以再查一次。")); return true }
    }
    return false
  }
  func showAuthFailed(_ msg: String) { authPending = nil; authFailed = msg; webSheet = nil; Haptics.error() }
  /// 再查一次: keep waiting for the same change.
  func retryAuthCheck() {
    authFailed = nil; let before = limitsBefore
    authPending = authPending ?? LimitsPending(single: 0, daily: 0, term: 0, days: nil, since: Int64(Date().timeIntervalSince1970), failed: false)
    ownerPoll?.cancel()
    ownerPoll = Task { @MainActor [weak self] in
      for _ in 0..<60 { guard let self, !Task.isCancelled else { return }; if await self.limitsTick(before: before) { return }; try? await Task.sleep(nanoseconds: 3_000_000_000) }
      self?.showAuthFailed(L("还没在链上看到结果，没有扣钱。稍后到上限页查看。"))
    }
  }
  func dismissAuthOverlay() { authFailed = nil; authPending = nil; limitsCelebrate = false; ownerPoll?.cancel(); Task { await refresh() } }
  func openPhonePage(_ path: String) { openPhonePage(url: PhoneKey.server.appendingPathComponent(path)) }
  func openPhonePage(url: URL) {
    Task { @MainActor in
      let b0 = await PhoneKey.status(); let before = b0?["fingerprint"] as? String; let beforeAp = b0?["approver"] as? String
      openOwnerPage(url) { m in
        let s1 = await PhoneKey.status(); let now = s1?["fingerprint"] as? String; guard now != before || (s1?["approver"] as? String) != beforeAp else { return false }
        m.phoneSignerChanged = now == nil ? L("这台手机已解绑") : L("这台手机已绑定"); Haptics.success(); await m.refresh(); return true
      }
    }
  }
  func celebrate(_ u: LimitsUpdate) {
    lockAfterSheet = false; webSheet = nil; authPending = nil; authFailed = nil; limitsUpdated = u; limitsCelebrate = true; Haptics.success()
    if demo != nil, case .object(var j)? = state?.raw { j["caps"] = .object(["single": .string("\(u.single)"), "daily": .string("\(u.daily)"), "term": .string("\(u.term)"),
        "start": .string("\(Int(u.start.timeIntervalSince1970))"), "end": .string("\(Int(u.end.timeIntervalSince1970))")]); state = WalletState(.object(j)) }
    Task { await refresh() }
  }

  #if DEBUG
  /// UI tests only (demo): pretend Base confirms after a few seconds, or never (-kpSimulateFail).
  private func simulateChain(_ p: LimitsPending) {
    Task { @MainActor in try? await Task.sleep(nanoseconds: 4_000_000_000)
      if CommandLine.arguments.contains("-kpSimulateFail") { showAuthFailed(L("等了 4 分钟还没在链上看到结果，没有扣钱。可以再查一次。")); return }
      let a = Date(timeIntervalSince1970: 1792642081); celebrate(LimitsUpdate(single: p.single, daily: p.daily, term: p.term, start: a, end: a.addingTimeInterval(Double(p.days ?? 365) * 86400))) }
  }
  #endif

  // MARK: login
  func handle(url: URL) {
    if url.scheme == "kipurse", url.host == "bind" { bindSheet = true; return }
    if let u = LimitsUpdate.parse(url) { ownerPoll?.cancel(); celebrate(u); return }
    if let p = LimitsPending.parse(url) { webSheet = nil; authPending = p; authFailed = nil
      #if DEBUG
      if demo != nil { simulateChain(p); return }
      #endif
      retryAuthCheck(); return }
    if url.scheme == "kipurse", url.host == "deposit-done" {
      webSheet = nil; Task { await refresh() }
      let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      if q.contains(where: { $0.name == "cancel" }) { onrampPendingRef = nil; return }
      if let r = q.first(where: { $0.name == "onramp" })?.value, OnrampState.validRef(r) { onrampPendingRef = nil; onrampTrack = OnrampTrack(ref: r); return }   // verify before saying anything
      if onrampTrack != nil { return }
      alert = AlertItem(title: T("充值已提交", "Submitted"), message: q.contains(where: { $0.name == "mock" }) ? T("练习模式：没有真的扣钱。", "Practice mode — no money moved.") : T("还没到账。确认到账后首页余额会更新。", "Not arrived yet. Your home balance updates once it really arrives."))
      return
    }
    if url.scheme == "kipurse", url.host == "approve-trust" {   // public approval page -> phone signer sheet (Face ID)
      if let r = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value, r.range(of: "^[0-9a-f-]{36}$", options: .regularExpression) != nil { afterMuse { self.trustReq = TrustReq(id: r) } }; return }
    if url.scheme == "kipurse", url.host == "approve-connect" {   // consent page -> Face ID approval with the enrolled phone key
      if let r = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value, ConnectApproval.validId(r) { webSheet = nil; afterMuse { self.connectReq = ConnectReq(id: r) } }; return }
    if url.scheme == "kipurse", url.host == "oauth" {   // consent page -> one Face ID approve screen (falls back to the 待批准 tab)
      if let r = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "req" })?.value, !r.isEmpty, r.count <= 64 { afterMuse { self.oauthReq = OAuthReq(id: r) } } else { pendingTab = "approvals" }
      Task { await refresh() }; return }   // consent page -> 待批准 tab (Face ID approve)
    if url.scheme == "kipurse", url.host == "done" { webSheet = nil; Task { await refresh() }; return }
    // t796 H1: no login from deep links any more (kipurse://login?server=… could point the app at an attacker server). QR scan in the app only.
  }
  func login(_ link: OwnerLink) async {
    if Server.signingNeedsHTTPS(link.server) { show(L("服务器不安全"), L("正式版只接受 https:// 服务器。")); return }
    busy = true; defer { busy = false }
    do { let s = try await api.login(link); try SessionVault.save(s); session = s; locked = false; await refresh(); startPolling()
         _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) }
    catch { show(L("登录失败"), error.localizedDescription) }
  }
  static func keyDiag() {
    let ks = PhoneKey.all()
    print("KPKEYDIAG bundle=\(Bundle.main.bundleIdentifier ?? "?") group=\(PhoneKey.sharedGroup ?? "none") status=\(PhoneKey.lastStatus) keys=\(ks.count) fps=\(ks.compactMap { PhoneKey.fingerprint($0) })")
    var out: CFTypeRef?
    if SecItemCopyMatching([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: PhoneKey.tag, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll] as CFDictionary, &out) == errSecSuccess, let a = out as? [[String: Any]] {
      print("KPKEYDIAG groups=\(a.map { ($0[kSecAttrAccessGroup as String] as? String) ?? "?" }) created=\(a.map { ($0[kSecAttrCreationDate as String] as? Date).map { "\($0)" } ?? "?" })") }
    fflush(stdout)
  }
  /// Logout = end the server session + factory-reset the device (fresh-install state, nothing left).
  func logout() {
    let old = api; poll?.cancel(); session = nil; state = nil; api = OwnerAPI(); catalog = []; agentLink = nil; agentSheet = nil; webSheet = nil
    Task { _ = try? await old.call("logout", [:]); Awareness.wipe(); await LocalWipe.all(); seenApprovals = []; lastRemnants = LocalWipe.remnants() }
  }
  @Published var lastRemnants: [String] = []
  /// After delete-everything: the last wallet snapshot, memory only, so the user can still take the money out.
  @Published var afterErase: WalletState?
  @Published var wipeReport = ""
  /// Mainnet delete-everything: server records for this wallet (if the server allows, signed by this phone), then every local trace:
  /// Keychain (session, Secure Enclave key), preferences (payee cache, wallet), files, caches, Spotlight items, Siri donations.
  /// On-chain facts stay on chain; the phone approver is removed from the wallet separately (手机确认 → 撤销).
  func eraseMainnetEverything() async {
    if demo != nil { toast = T("演示里不会删除任何真实数据", "The demo never deletes real data"); return }
    if demo == nil, MainnetSession.load() == nil, PhoneKey.isPresent() { await mainSignIn() }   // no live session = the server erase would be skipped
    let keep = state                                                                       // memory only: the withdraw guide after the wipe
    WithdrawTarget.server = Mainnet.server; WithdrawTarget.owner = Operator.ownerAccount   // memory only: withdraw still works after the wipe
    let server = await MainnetSession.eraseServer()
    Awareness.wipe(); await LocalWipe.all(keepPhoneKey: false); state = nil; lastRemnants = LocalWipe.remnants(includePhoneKey: true)
    if let k = keep, k.wallet != nil { afterErase = k }
    toast = server ? L("已删除：服务器记录和这台手机上的数据") : L("已删除这台手机上的数据（服务器记录没有删：服务器未开通或未登录）")
  }
  /// Server confirmed deletion: keep the recovery guide (UserDefaults + PDF), then log out locally.
  func finishDeletion(_ r: JSONValue) {
    let g = r["recovery"].flatMap { $0 == .null ? nil : RecoveryGuide(recovery: $0) }
    logout()                                   // wipes the device first …
    if let g = g { recovery = g; showRecovery = true }   // … then shows the guide from memory only (save the PDF yourself)
  }

  // MARK: lock (LocalAuthentication; separate from the wallet passkey)
  private var unlocking = false
  /// Exactly ONE Face ID on mainnet. Runs in its own Task (NOT the LockView's .task, which is cancelled the moment the lock screen
  /// disappears — that cancelled the session request on device: NSURLErrorCancelled, shown as "已取消").
  ///  - valid read session (checked without any prompt): one LocalAuthentication unlock.
  ///  - session needed: the phone key's own Secure Enclave Face ID is the unlock (no separate LAContext prompt).
  func unlock() async { startUnlock() }
  /// Cold start inside the grace period: reuse the existing sessions without a prompt; anything missing falls back to the lock screen.
  func resume() async {
    if isMain {
      if MainnetSession.load() != nil, let s = try? await MainnetSession.state(interactive: false) { state = s; mainNeedsSignIn = false; mainError = nil; siriSync(s); startPolling() }
      else { mainNeedsSignIn = true }   // no live session: the first Face ID (显示余额 or a payment) gets one, single prompt
    } else { await refresh(); startPolling() }
  }
  func hideIfStale() {}   // t889: no time-based hiding; revealed stays until the eye is tapped again or the process ends
  private var revealing = false
  /// Tap on a hidden balance: ONE Face ID. Without a live mainnet session that one prompt is the session signature itself.
  func revealBalance() async {
    // t889: no Face ID. In memory only: a cold start (kill / reboot) is hidden again; background/foreground keeps it.
    balanceRevealed = true
  }
  /// Eye toggle -> hide right away, no Face ID.
  func hideBalance() { balanceRevealed = false }
  func startUnlock() {
    guard !unlocking else { return }; unlocking = true
    Task { @MainActor in await runUnlock(); unlocking = false }
  }
  private func runUnlock() async {
    if isMain && (demo == nil || faceTest) {
      #if DEBUG
      if faceTest { guard let ctx = await BiometricGate.unlockContext(reason: L("解锁 Kipurse")) else { return }; faceTestSign(ctx); ctx.invalidate(); locked = false; return }
      #endif
      if MainnetSession.load() != nil, let s = try? await MainnetSession.state(interactive: false) {
        guard await BiometricGate.unlockContext(reason: L("解锁 Kipurse")).map({ $0.invalidate(); return true }) ?? false else { return }
        state = s; locked = false; mainNeedsSignIn = false; mainError = nil; startPolling(); return
      }
      if needsCoinbase { locked = false; phoneUnbound = !needsIdentity; return }   // t851: no Face ID before the Coinbase login
      if PhoneKey.isPresent() {
        guard let ctx = await BiometricGate.unlockContext(reason: L("解锁 Kipurse")) else { return }   // the ONE prompt; every signature below reuses it
        defer { ctx.invalidate() }
        for attempt in 0..<2 {
          do { let s = try await MainnetSession.state(interactive: true, context: ctx); state = s; locked = false; mainNeedsSignIn = false; mainError = nil; startPolling(); return }
          catch {
            AuthLog.record("unlock-signin", error)
            if AuthLog.isUserCancel(error) { return }                               // stay on the lock screen; its button retries
            if AuthLog.isURLCancel(error), attempt == 0, MainnetSession.load() != nil { continue }  // signature done, request cut: retry without a prompt
            if case MainnetSession.Failure.unbound = error { locked = false; markUnbound(); return }
            locked = false; mainError = AuthLog.friendly(error); return
          }
        }
        return
      }
      guard await BiometricGate.confirm(reason: L("解锁 Kipurse")) else { return }
      locked = false; mainNeedsSignIn = false; return
    }
    if await BiometricGate.confirm(reason: L("解锁 Kipurse")) { locked = false; await refresh(); startPolling() }
  }
  var faceTest: Bool {
    #if DEBUG
    return CommandLine.arguments.contains("-kpFaceTest")
    #else
    return false
    #endif
  }
  #if DEBUG
  @Published var faceTestResult = ""
  /// Simulator check: a throwaway Secure Enclave key with the SAME access control as the phone key signs with the unlock context.
  /// If that needed its own Face ID, the signature would block on a second prompt.
  func faceTestSign(_ ctx: LAContext) {
    let tag = "com.kipurse.facetest.v1".data(using: .utf8)!
    if PhoneKey.existing(tag: tag) == nil {
      var err: Unmanaged<CFError>?
      let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &err)!
      var attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256,
        kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag, kSecAttrAccessControl as String: ac]]
      #if !targetEnvironment(simulator)
      attrs[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
      #endif
      _ = SecKeyCreateRandomKey(attrs as CFDictionary, &err)
    }
    guard let k = PhoneKey.existing(context: CommandLine.arguments.contains("-kpNoCtx") ? nil : ctx, tag: tag) else { faceTestResult = "nokey"; return }
    let ok = (try? PhoneKey.sign([UInt8](repeating: 7, count: 32), key: k, reusesUnlock: true)) != nil
    faceTestResult = "prompts=\(PromptLog.count) signed=\(ok)"
  }
  #endif
  func scenePhase(_ p: ScenePhase) {
    switch p {
    case .background: privacyCover = true; if backgroundAt == nil { backgroundAt = Date() }; poll?.cancel(); AppModel.scheduleBackgroundPoll()
    case .active:
      privacyCover = false
      backgroundAt = nil
      if !locked { startPolling() }
    case .inactive: privacyCover = true
    @unknown default: break
    }
  }

  // MARK: data
  func loadStray(_ s: WalletState) async {
    guard let w = s.wallet, let u = WrongToken.url(base: Mainnet.base, wallet: w) else { return }
    var r = URLRequest(url: u); r.cachePolicy = .reloadIgnoringLocalCacheData; r.timeoutInterval = 15
    if let (d, resp) = try? await URLSession.shared.data(for: r), (resp as? HTTPURLResponse)?.statusCode == 200 { stray = WrongToken.parse(d) }
  }
  func refresh() async {
    guard demo == nil else { return }
    if isMain {
      do { let s = try await MainnetSession.state(interactive: false); state = s; serverDown = false; LedgerCache.save(s); Task { await loadStray(s) }; mainNeedsSignIn = false; mainError = nil; notifyNew(s.approvals); Awareness.publish(s); siriSync(s) }
      catch MainnetSession.Failure.needsSignIn { if state == nil { mainNeedsSignIn = true } }
      catch MainnetSession.Failure.noKey { mainNeedsSignIn = false }
      catch MainnetSession.Failure.unbound { markUnbound() }
      catch { if state == nil { mainError = error.localizedDescription }; await checkServer() }
      return
    }
    guard session != nil else { return }
    do { let s = try await api.state(); state = s; notifyNew(s.approvals)
         let fresh = Awareness.newPayments(s.txs)
         for t in fresh.prefix(3) { Awareness.notifyPayment(t) }
         if let t = fresh.first { celebrate = t }
         Awareness.publish(s) }
    catch KipurseError.notLoggedIn { logout(); show(L("需要重新登录"), KipurseError.notLoggedIn.localizedDescription) }
    catch { /* keep last state; banner shows offline */ }
  }
  /// Keep Siri's recipient list (and Spotlight / App Shortcut parameters) in step with the real payees.
  func siriSync(_ s: WalletState) { AssistantHooks.stateChanged?(s) }
  /// Siri asked to approve / reject (after its own confirmation): same Face ID-gated path as the buttons.
  func assistantDecision(_ n: Notification) {
    guard let id = n.userInfo?["id"] as? String, let ok = n.userInfo?["approve"] as? Bool else { return }
    pendingTab = "approvals"
    Task { @MainActor in
      if state == nil { await refresh() }
      guard let a = state?.approvals.first(where: { $0.id == id }) else { return }
      if ok { if a.kind == .trustRequest { if isMain { trustReq = TrustReq(id: a.serverId) }; return }; await approve(a) }   // mainnet trust: the phone-signer sheet (Face ID) else { await reject(a) }   // trust requests: the card opens the signing page
    }
  }
  /// Face ID with the phone signer key -> read-only mainnet session.
  /// t890: the "用 Face ID 打开" / 重试 buttons. Always gives a visible result: one Face ID (passcode fallback) -> home;
  /// cancel / no Face ID / any failure -> straight to the Coinbase login, never a dead button and never a second prompt.
  @Published var openingWallet = false
  func openWallet() async {
    guard !openingWallet else { return }; openingWallet = true; defer { openingWallet = false }
    if demo != nil { mainNeedsSignIn = false; return }
    if needsCoinbase || !PhoneKey.isPresent() { mainNeedsSignIn = false; phoneUnbound = true; return }
    await mainSignIn()
    if state == nil && !phoneUnbound { mainNeedsSignIn = false; mainError = nil; phoneUnbound = true }   // Face ID never blocks entry: Coinbase login instead
  }
  func mainSignIn() async {
    if demo != nil { return }
    guard let ctx = await BiometricGate.unlockContext(reason: L("打开钱包")) else { mainNeedsSignIn = true; return }   // ONE prompt for the whole sign-in
    defer { ctx.invalidate() }
    do { let s = try await MainnetSession.state(interactive: true, context: ctx); state = s; mainNeedsSignIn = false; mainError = nil; siriSync(s); startPolling() }
    catch MainnetSession.Failure.unbound { markUnbound() }
    catch { AuthLog.record("signin", error); if AuthLog.isUserCancel(error) { mainNeedsSignIn = true } else { mainError = AuthLog.friendly(error) } }
  }
  /// t851: go to Sign in with Coinbase with NO Face ID first: no live session and no saved "one Face ID opens it" mark.
  var needsCoinbase: Bool {
    guard demo == nil, state == nil, !serverDown else { return false }
    #if DEBUG
    if CommandLine.arguments.contains("-kpSessionMark") { return needsIdentity || phoneUnbound }
    #endif
    return needsIdentity || phoneUnbound || (MainnetSession.load() == nil && !Unbound.sessionMarkUsable && (!Operator.wallet.isEmpty || Unbound.wallet != nil))
  }
  @Published var loginExpired = false
  func markUnbound() {
    if Unbound.sessionMarkUsable || MainnetSession.load() != nil { loginExpired = true }   // we tried with Face ID and the server said no: say it in one line
    Unbound.clearSessionMark()
    phoneUnbound = true; mainNeedsSignIn = false; mainError = nil
    if !Operator.wallet.isEmpty { Unbound.remember(wallet: Operator.wallet, path: Operator.tenantPath) }
  }
  func startPolling() {
    poll?.cancel()
    poll = Task { while !Task.isCancelled { await refresh(); try? await Task.sleep(nanoseconds: 5_000_000_000) } }
  }
  private func notifyNew(_ list: [Approval]) {
    let fresh = ApprovalDiff.newOnes(previous: seenApprovals, current: list)
    for a in fresh { Awareness.notifyApproval(a) }
    seenApprovals = Set(list.map(\.id)); UserDefaults.standard.set(Array(seenApprovals), forKey: "seenApprovals")
  }

  // MARK: owner actions (all behind Face ID)
  func ownerAction(_ reason: String, _ f: @escaping () async throws -> Void) async {
    guard await BiometricGate.confirm(reason: reason) else { return }
    busy = true; defer { busy = false }
    do { try await f(); await refresh() } catch { show(L("没有完成"), error.localizedDescription) }
  }
  func approve(_ a: Approval) async {
    await ownerAction(L("批准：\(a.titleZh)")) { [api] in
      switch a.kind {
      case .trust: try await api.call("trust", ["action": .string("approve"), "id": .string(a.serverId)])
      case .trustRequest: break // needs the owner's wallet signature: TrustRequestCard opens the signing page instead
      case .loosenLimits: try await api.call("limits", ["approveId": .string(a.serverId)])
      case .connectAgent: try await api.call("oauthDecide", ["req": .string(a.serverId), "approve": .bool(true)])
      case .withdraw: try await api.call("withdraw", ["approveId": .string(a.serverId)])
      }
    }
  }
  /// From the lock-screen action "Approve with Face ID": the same Face ID-gated approval as in the app.
  func approveById(_ id: String) async {
    if state == nil { await refresh() }
    guard let a = state?.approvals.first(where: { $0.id == id }) else { return }
    await approve(a)
  }
  func reportProblem(_ t: Tx, reason: String, note: String) async -> JSONValue? {
    do { let r = try await api.call("reportProblem", ["purchaseKey": .string(t.id), "reason": .string(reason), "note": .string(note)]); await refresh(); return r }
    catch { show(T("没有提交成功", "Couldn't send"), error.localizedDescription); return nil }
  }
  func rejectTrustRequest(_ id: String) async { await ownerAction(L("拒绝信任申请")) { [api] in try await api.call("trustRequestReject", ["id": .string(id)]) } }
  func reject(_ a: Approval) async {
    if a.kind == .trustRequest { await rejectTrustRequest(a.serverId); return }
    if a.kind == .connectAgent { await ownerAction(L("拒绝连接")) { [api] in try await api.call("oauthDecide", ["req": .string(a.serverId), "approve": .bool(false)]) }; return }
    guard a.kind == .trust else { return }
    await ownerAction(L("拒绝信任")) { [api] in try await api.call("trust", ["action": .string("reject"), "id": .string(a.serverId)]) }
  }
  func setLimits(_ ch: [String:String]) async {
    await ownerAction(L("修改上限")) { [api] in
      let r = try await api.call("limits", ["changes": .object(ch.mapValues { .string($0) })])
      if r["pendingOwnerApproval"] != nil && r["pendingOwnerApproval"] != .null { await MainActor.run { self.show(L("调高需要再确认"), L("请在“待批准”里点同意。")) } }
    }
  }
  func withdraw(_ amount: String) async { await ownerAction(L("提现 \(amount) USDC 到你的钱包")) { [api] in try await api.call("withdraw", ["amount": .string(amount)]) } }
  @Published var catalog: [JSONValue] = []
  /// One agent sheet at a time, with a stable identity created once per user action (never re-derived on refresh).
  @Published var agentSheet: AgentSheet?
  @Published var pendingTab: String?
  @Published var oauthReq: OAuthReq?
  @Published var trustReq: TrustReq?
  @Published var connectReq: ConnectReq?
  @Published var lastLaunch = ""
  private var connecting = false
  func loadCatalog() async { if demo != nil { return }; if let r = try? await api.call("agentCatalog", [:]) { catalog = r["agents"]?.array ?? [] } }
  func connectAgent(_ id: String, _ name: String) async {
    guard !connecting, agentSheet == nil else { return }      // one action at a time: no double taps, no stacked sheets
    connecting = true; defer { connecting = false }
    await ownerAction(L("给 \(name) 生成专用钥匙并连接")) { [api] in
      let r = try await api.call("connectAgent", ["agentId": .string(id)]); await MainActor.run { self.agentSheet = .result(r); Haptics.success() } }
  }
  func showAgentSheet(_ s: AgentSheet) { guard !connecting, agentSheet == nil else { return }; agentSheet = s }
  func pauseAgent(_ id: String, _ name: String, _ paused: Bool) async { await ownerAction(paused ? L("暂停 \(name) 付款") : L("恢复 \(name)")) { [api] in try await api.call("agentPause", ["id": .string(id), "paused": .bool(paused)]) } }
  func revokeAgent(_ id: String, _ name: String) async { await ownerAction(L("断开 \(name)（钥匙作废并删除）")) { [api] in try await api.call("deleteAgent", ["id": .string(id)]) } }
  func revokeTrust(_ key: String) async { await ownerAction(L("取消信任")) { [api] in try await api.call("trust", ["action": .string("revoke"), "key": .string(key)]) } }
  func pause() async { busy = true; defer { busy = false }; _ = try? await api.call("pause", [:]); await refresh() }   // emergency: no Face ID needed
  func newAgent() async { await ownerAction(L("给 AI 生成连接")) { [api] in let r = try await api.call("newAgent", ["name": .string(L("iPhone 上添加的 AI"))]); await MainActor.run { self.agentLink = r } } }

  /// Passkey / Coinbase wallet signing happens on the web page, inside a Safari-based view (window.open popups + passkeys work there; WKWebView is not used).
  func openSigning(next: String) async {
    guard await BiometricGate.confirm(reason: L("打开确认页面")) else { return }
    do {
      let url = try await api.webLink(next: next)
      switch SigningMode(rawValue: signingMode) ?? .safariView {
      case .safariView: webSheet = WebSheet(url: url)
      case .authSession: WebSigner.shared.start(url) { [weak self] _ in Task { await self?.refresh() } }
      case .externalSafari: webSheet = WebSheet(url: url)   // t785u: never leave the app (old setting now opens in-app)
      }
    } catch { show(L("打不开确认页面"), error.localizedDescription) }
  }
  func startSetup(answers: [String:String]) async {
    let json = (try? JSONEncoder().encode(answers)) ?? Data()
    let b64 = json.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    await openSigning(next: "/?return=kipurse&answers=\(b64)")
  }

  /// 「离线提现」: the static rescue page; the rescue card rides in the #fragment (saved locally so it works without our server).
  @AppStorage("rescueUrl") var rescueUrl = ""
  func openRescue() async {
    guard await BiometricGate.confirm(reason: L("打开「离线提现」")) else { return }
    if let r = try? await api.call("rescueLink", [:]), let u = r["url"]?.string { rescueUrl = u }
    guard let u = URL(string: rescueUrl), !rescueUrl.isEmpty else { show(L("打不开"), L("还没有离线提现链接：请先连上 Kipurse 一次。")); return }
    webSheet = WebSheet(url: u)
  }
  func show(_ t: String, _ m: String) { alert = AlertItem(title: t, message: m) }

  // MARK: background poll (best effort; iOS decides when it runs)
  nonisolated static func registerBackgroundPoll() {
    BGTaskScheduler.shared.register(forTaskWithIdentifier: "com.kipurse.poll", using: nil) { task in
      let t = Task { @MainActor in
        if let s = SessionVault.load(), let st = try? await OwnerAPI(session: s).state() {
          let seen = Set(UserDefaults.standard.stringArray(forKey: "seenApprovals") ?? [])
          for a in ApprovalDiff.newOnes(previous: seen, current: st.approvals) { Awareness.notifyApproval(a) }
          for t in Awareness.newPayments(st.txs).prefix(3) { Awareness.notifyPayment(t) }
          Awareness.publish(st)
          UserDefaults.standard.set(st.approvals.map(\.id), forKey: "seenApprovals")
        }
        scheduleBackgroundPoll(); task.setTaskCompleted(success: true)
      }
      task.expirationHandler = { t.cancel() }
    }
  }
  nonisolated static func scheduleBackgroundPoll() {
    let r = BGAppRefreshTaskRequest(identifier: "com.kipurse.poll"); r.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
    try? BGTaskScheduler.shared.submit(r)
  }
}

/// Agent sheet with a stable id (fixed at creation), so 5-second polling re-renders cannot dismiss and re-present it.
enum AgentSheet: Identifiable {
  case result(JSONValue), manage(key: JSONValue, card: JSONValue)
  var id: String {
    switch self {
    case .result(let r): return SheetIdentity.result(r)
    case .manage(let k, _): return SheetIdentity.manage(k)
    }
  }
}

enum SigningMode: String, CaseIterable, Identifiable {
  case safariView, authSession, externalSafari
  var id: String { rawValue }
  var zh: String { switch self { case .safariView: return L("App 内 Safari（推荐）"); case .authSession: return L("系统登录窗口"); case .externalSafari: return L("跳到 Safari") } }
}


extension Notification.Name { static let kpCloseLocalSheets = Notification.Name("kpCloseLocalSheets"); static let kpShowSiri = Notification.Name("kpShowSiri") }
