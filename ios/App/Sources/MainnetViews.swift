import SwiftUI
import CryptoKit
import Security
import UIKit
import KipurseCore
import LocalAuthentication

/// READ-ONLY mainnet session: the enrolled phone signer key (Secure Enclave, Face ID) signs a server challenge; the server returns a
/// 12-hour token that can only READ balance / agents / payments / pending requests. Stored in the Keychain (this device only).
enum MainnetSession {
  enum Failure: Error, LocalizedError {
    case noKey, needsSignIn, unbound, server(String)
    var errorDescription: String? {
      switch self { case .noKey: return T("这台 iPhone 还没开启 Face ID 批准", "Face ID approvals aren't on for this iPhone"); case .unbound: return Unbound.cardTitle; case .needsSignIn: return T("需要确认后才能完成这项操作", "Confirm to finish this action"); case .server(let m): return m }
    }
  }
  private static let svc = "com.kipurse.mainnet.read-session"
  static func load() -> String? {
    if DemoGuard.active { return nil }   // demo never reads the real session
    var out: CFTypeRef?
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: svc, kSecReturnData as String: true]
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, let s = String(data: d, encoding: .utf8) else { return nil }
    let p = s.split(separator: "|"); guard p.count == 2, let exp = Double(p[1]), exp > Date().timeIntervalSince1970 + 60 else { return nil }
    return String(p[0])
  }
  static func save(_ t: String, expiresIn: Double) {
    if DemoGuard.active { return }
    clear()
    let v = "\(t)|\(Date().timeIntervalSince1970 + expiresIn)"
    SecItemAdd([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: svc, kSecValueData as String: Data(v.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly] as CFDictionary, nil)
  }
  static func clear() { if DemoGuard.active { return }; SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: svc] as CFDictionary) }

  /// Face ID (Secure Enclave) once; returns a fresh read token.
  static func signIn(context: LAContext? = nil) async throws -> String {
    guard let k = PhoneKey.existing(context: context) else { throw Failure.noKey }
    // 404 (no wallet knows this key) / 403 not_phone_signer / 409 no_phone_signer: this phone isn't bound -> the bind card, never a bare retry
    func bound<R>(_ f: () async throws -> R) async throws -> R { do { return try await f() } catch let e as NSError where e.domain == "kipurse" && [403, 404, 409].contains(e.code) { throw Failure.unbound } }
    if Operator.wallet.isEmpty { guard CoinbaseIdentity.verified() else { throw Failure.needsSignIn }; try await bound { try await WalletDiscovery.find(key: k, reusesUnlock: context != nil) } }   // never from a leftover key before Sign in with Coinbase
    let c = try await bound { try await PhoneKey.post("phone/session/challenge", [:]) }
    guard let nonce = c["nonce"] as? String, Mainnet.validNonce(nonce) else { throw Failure.server(L("服务器回应不对")) }
    let d = Mainnet.sessionDigest(nonce: nonce)
    guard (c["digest"] as? String)?.lowercased() == Hex.encode(d).lowercased() else { throw Failure.server(L("服务器回应不对")) }  // phone computes what it signs itself
    if context == nil { await FaceIDUnlock.ensure() }   // t1255 §6#124: Face ID locked by iOS -> passcode unlocks Face ID only (approves nothing)
    let (r, s) = try PhoneKey.sign(d, key: k, reusesUnlock: context != nil)
    let j = try await bound { try await PhoneKey.post("phone/session", ["nonce": nonce, "r": Hex.encode(r), "s": Hex.encode(s)]) }
    guard let t = j["token"] as? String else { throw Failure.server(L("服务器回应不对")) }
    save(t, expiresIn: (j["expiresInSec"] as? NSNumber)?.doubleValue ?? 3600)
    Task { await PushBridge.ensurePermission() }   // t1208u §6#94: a mainnet session now exists -> ask iOS once, then upload the APNs token
    return t
  }
  /// Delete-everything, server side: the phone signs a fresh erase challenge (Face ID); the server wipes every record it keeps
  /// for this wallet. Returns false when the server has erase turned off or there is no session (local wipe still runs).
  static func eraseServer() async -> Bool {
    guard load() != nil, let k = PhoneKey.existing() else { return false }
    do {
      let (c, j) = try await authedPost("user/erase/challenge", [:])
      guard c == 200, let nonce = j["nonce"] as? String, Mainnet.validNonce(nonce) else { return false }
      let d = Mainnet.eraseDigest(nonce: nonce)
      guard (j["digest"] as? String)?.lowercased() == Hex.encode(d).lowercased() else { return false }
      await FaceIDUnlock.ensure()   // t1255 §6#124: Face ID locked by iOS -> passcode unlocks Face ID only (approves nothing)
      let (r, s) = try PhoneKey.sign(d, key: k)
      let (e, _) = try await authedPost("user/erase", ["nonce": nonce, "phrase": "DELETE", "r": Hex.encode(r), "s": Hex.encode(s)])
      return e == 200
    } catch { return false }
  }
  /// t1156u: user-initiated save. No valid session -> ONE Face ID (the approval key signs a fresh session), then the same POST.
  /// A 401 (session gone on the server) gets one fresh session and one retry. Only for idempotent saves, never for payments.
  static func authedPostSigningIn(_ path: String, _ body: [String: Any]) async throws -> (Int, [String: Any]) {
    try await SessionRefresh.post(hasSession: { load() != nil }, signIn: { _ = try await signIn() }, clear: { clear() },
                                  send: { try await authedPost(path, body) })
  }
  /// t1268: everyday (AI) limits, signed by the phone key. `context` is the ONE Face ID the user just gave: it opens a session if needed and
  /// unlocks the key (no second prompt). The phone builds the signed text itself (EverydaySign) for THIS phone's verified wallet; the
  /// server only supplies the single-use nonce. A 401 for a gone session gets one fresh session and one retry (SessionRefresh).
  static func signedEveryday(single: Int64, daily: Int64, term: Int64, context: LAContext) async throws -> (Int, [String: Any]) {
    guard EverydaySign.signable(single: single, daily: daily, term: term) else { throw Failure.server(T("金额不对，没有修改。", "Those amounts aren't valid. Nothing changed.")) }
    let w = PhoneTrust.mainnetWallet
    guard CoinbaseIdentity.isAddress(w) else { throw Failure.needsSignIn }
    guard let k = PhoneKey.existing(context: context) else { throw Failure.noKey }
    func once() async throws -> (Int, [String: Any]) {
      let (cc, c) = try await authedPost("everyday/challenge", [:])
      guard cc == 200 else { return (cc, c) }
      guard let nonce = c["nonce"] as? String, Mainnet.validNonce(nonce), (c["wallet"] as? String)?.lowercased() == w.lowercased() else { throw Failure.server(L("服务器回应不对")) }
      let (r, s) = try PhoneKey.sign(EverydaySign.digest(wallet: w, single: single, daily: daily, term: term, nonce: nonce), key: k, reusesUnlock: true)
      let p = try await authedPost("everyday", ["single": String(single), "daily": String(daily), "term": String(term), "nonce": nonce, "r": Hex.encode(r), "s": Hex.encode(s)])
      if p.0 == 401, (p.1["error"] as? String) != "phone_session_required" { return (403, p.1) }   // a refused signature is not a gone session: no retry
      return p
    }
    return try await SessionRefresh.post(hasSession: { load() != nil }, signIn: { _ = try await signIn(context: context) }, clear: { clear() }, send: once)
  }
  /// t1156u: calm text for a session save that did not go through (handbook §6#75). Network wording only for real network errors.
  static func saveErrorText(_ error: Error) -> String {
    if let f = error as? Failure {
      switch f { case .noKey: return SessionErrorCopy.text(.noApprovalKey); default: return f.errorDescription ?? SessionErrorCopy.text(.network) }
    }
    return SessionErrorCopy.text(SessionErrorCopy.kind(error))
  }
  /// POST with this phone's session token (owner-pay, erase). Returns (HTTP status, JSON body).
  static func authedPost(_ path: String, _ body: [String: Any], timeout: TimeInterval = 90) async throws -> (Int, [String: Any]) {
    guard let tok = load() else { throw Failure.needsSignIn }
    var r = URLRequest(url: Mainnet.server.appendingPathComponent(path)); r.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); r.httpMethod = "POST"; r.timeoutInterval = timeout
    r.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization"); r.setValue("application/json", forHTTPHeaderField: "Content-Type")
    r.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (d, resp) = try await URLSession.shared.data(for: r)
    return ((resp as? HTTPURLResponse)?.statusCode ?? 0, ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any]) ?? [:])
  }
  static func state(interactive: Bool, context: LAContext? = nil) async throws -> WalletState {
    var tok = load()
    if tok == nil { guard interactive else { throw Failure.needsSignIn }; tok = try await signIn(context: context) }
    for attempt in 0..<2 {
      var r = URLRequest(url: Mainnet.server.appendingPathComponent("phone/session/state")); r.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); r.setValue("Bearer \(tok!)", forHTTPHeaderField: "Authorization"); r.timeoutInterval = 20
      let (d, resp) = try await URLSession.shared.data(for: r)
      let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
      if code == 401 { clear(); guard interactive, attempt == 0 else { throw Failure.needsSignIn }; tok = try await signIn(context: context); continue }
      guard code == 200 else { throw Failure.server(L("暂时连不上，请稍后再试（\(code)）")) }
      let ws = WalletState(try JSONDecoder().decode(JSONValue.self, from: d)); Unbound.saveSessionMark(bound: ws.raw["bound"]?.bool != false); return ws
    }
    throw Failure.needsSignIn
  }
}

/// Shown on mainnet before the first read (no tabs yet = nothing to show). One clear action each.
struct MainnetGate: View {
  @EnvironmentObject var m: AppModel
  var body: some View {
    VStack(spacing: 18) {
      Spacer()
      BrandMark(size: 64)
      if m.serverDown && m.demo == nil && FeatureSwitch.calmBanner.on {   // t821: server unreachable: calm words, chain balance, guide
        OfflineWalletCard()
      } else if m.demo == nil && (m.phoneUnbound || (!PhoneKey.isPresent() && Unbound.wallet != nil)) {
        UnboundCard()
      } else if !PhoneKey.isPresent() && m.demo == nil {
        Text(OnboardAPI.on ? L("开通 Kipurse") : Unbound.cardTitle).font(.title3.bold()); Text(OnboardAPI.on ? T("用 Coinbase 实名账户连接，选金额充值就开户。", "Connect your verified Coinbase account, then deposit to open.") + " " + T(UsageGuide.openingFeeNoticeZh, UsageGuide.openingFeeNoticeEn) : T("开启后，AI 想付钱时你用 Face ID 点一下就能同意。", "Then when your AI wants to pay, one Face ID tap says yes.")).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 24)
        if OnboardAPI.on { NavigationLink { OnboardView() } label: { Text(L("开通")).frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).controlSize(.large).kGlow().padding(.horizontal, 24).accessibilityIdentifier("gate.onboard") }
        else { NavigationLink { PhoneSignerView() } label: { Text(L("开始绑定")).frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).controlSize(.large).padding(.horizontal, 24) }
        NavigationLink { UsageGuideView(current: 1) } label: { Text(T("使用指引", "How to start")).font(.subheadline.weight(.semibold)) }.tint(Brand.accent).accessibilityIdentifier("gate.usageGuide")
        // App Review / first look (works in Release): sample data only, no server, no chain, nothing signed.
        Button(T("先看看演示（不用登录）", "Try the demo (no sign-in)")) { m.startDemo() }.font(.subheadline.weight(.semibold)).tint(Brand.accent).accessibilityIdentifier("gate.demo")
      } else if let e = m.mainError {
        Text(e).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 24)
        BigButton(L("重试"), icon: "arrow.clockwise") { Task { await m.openWallet() } }.padding(.horizontal, 24).accessibilityIdentifier("main.retry")
      } else if m.mainNeedsSignIn {
        // t1028: no open-lock setting is on → never show the 「打开钱包 / 进入我的钱包」 page; go straight to the wallet home (t1027: no Face ID).
        ProgressView(L("连接中…")).task { await m.openWallet() }
      } else { ProgressView(L("连接中…")) }
      Spacer()
    }.frame(maxWidth: .infinity).background(Brand.canvas)
  }
}

/// Reinstall / new phone: the wallet exists but this phone isn't bound. One clear next step (bind) and a way out that needs no phone.
struct UnboundCard: View {
  @EnvironmentObject var m: AppModel
  var emergency: URL? { Unbound.emergencyURL(base: Mainnet.base, wallet: Unbound.wallet ?? (Operator.wallet.isEmpty ? nil : Operator.wallet), path: Unbound.wallet != nil ? UserDefaults.standard.string(forKey: Unbound.pathKey) : Operator.tenantPath) }
  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "iphone.badge.exclamationmark").font(.system(size: 40)).foregroundStyle(Brand.caution)
      Text(Unbound.cardTitle).font(.title3.bold()).accessibilityIdentifier("unbound.title")
      Text(Unbound.cardBody).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
      NavigationLink { BindPhoneFlow() } label: { CenteredLabel(Unbound.bindLabel, systemImage: "faceid").frame(maxWidth: .infinity) }
        .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("unbound.bind")
      if let u = emergency {
        Button { m.emergencyFirst = u } label: { Label(Unbound.emergencyLabel, systemImage: "exclamationmark.shield").frame(maxWidth: .infinity) }
          .buttonStyle(.borderless).font(.subheadline.weight(.semibold)).tint(Brand.caution).padding(.top, 4).accessibilityIdentifier("unbound.emergency").accessibilityValue(u.absoluteString)
        Text(Unbound.emergencyHint).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
      }
      Button(T("先看看演示（不用登录）", "Try the demo (no sign-in)")) { m.startDemo() }.font(.subheadline.weight(.semibold)).tint(Brand.accent).accessibilityIdentifier("gate.demo")
    }.padding(20).card(padding: 4).padding(.horizontal, 16)
  }
}
/// The bind flow: one-time setup on this phone (re-setup of the existing wallet) when onboarding is on, else the phone-signer screen.
struct BindPhoneFlow: View {
  @State private var ready = false
  var body: some View {
    // t802 owner rule: one person = one Kipurse wallet for life. A known wallet (Coinbase sign-in found it) only binds THIS phone;
    // never the new-wallet path (no Coinbase verification gate, no limits form). Onboarding stays only for a phone with no known wallet.
    if OnboardAPI.on && Unbound.wallet == nil && Operator.wallet.isEmpty { OnboardView() }
    else if ready { PhoneSignerView() }
    // the phone-signer screen talks to THIS wallet (the one Sign in with Coinbase found), never the server's default wallet
    else { ProgressView().task { if Operator.wallet.isEmpty, let w = Unbound.wallet { Operator.setWallet(w, owner: UserDefaults.standard.string(forKey: CoinbaseIdentity.ownerKey), path: UserDefaults.standard.string(forKey: Unbound.pathKey)) }; ready = true } }
  }
}

/// 充值: address + QR + copy (Coinbase app). While open (and on return to the foreground) the balance is re-read every 5s
/// for up to 10 min; an increase shows 充值成功 with the amount and the new balance. Read-only refresh, no Face ID.
struct DepositView: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var phase
  let s: WalletState
  @State private var baseline: Int64?
  @State private var watchUntil = Date().addingTimeInterval(600)
  @State private var waiting = false; @State private var showOther = false; @State private var applePay = false
  @State private var arrived: (Int64, Int64)?
  @State private var demoTicks = 0
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if let r = arrived {
        let plus = r.0, bal = r.1
        VStack(spacing: 14) {
          Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(Brand.positive)
          Text(T("充值成功", "Money added")).font(.title2.bold()).accessibilityIdentifier("deposit.success")
          Text("+" + MoneyText.usdc(plus)).font(.title.bold().monospacedDigit()).accessibilityIdentifier("deposit.success.amount")
          Text(T("钱包余额 \(MoneyText.usdc(bal))", "Wallet balance \(MoneyText.usdc(bal))")).font(.headline.monospacedDigit()).foregroundStyle(.secondary).accessibilityIdentifier("deposit.success.balance")
          BigButton(T("完成", "Done"), icon: "checkmark") { dismiss() }.accessibilityIdentifier("deposit.success.done")
        }.frame(maxWidth: .infinity).card(padding: 24)
      } else if let w = s.wallet, m.demo == nil, !Operator.wallet.isEmpty, Operator.wallet.lowercased() != w.lowercased() {
        // address integrity: the deposit address must be the wallet this phone signed up with, never one the server swapped in
        WarnBox(text: T("充值地址和这台手机登记的钱包不一致，为了安全已停止显示。请联系 Kipurse。", "The deposit address doesn't match the wallet registered on this phone, so it's hidden for safety. Please contact Kipurse."), tone: Brand.negative, icon: "exclamationmark.octagon.fill").accessibilityIdentifier("deposit.mismatch")
      } else if let w = s.wallet {
        StrayNotice(wallet: w)
        // t932: two ways in ONE place: Apple Pay 充值 (Coinbase Onramp, needs Coinbase Verified, 申请中 until approved) next to Coinbase 充值.
        Button { Haptics.tap(); applePay = true } label: {
          HStack { Label(T("Apple Pay 充值", "Add money with Apple Pay"), systemImage: "applelogo").font(.headline); Spacer(); Image(systemName: "chevron.right").foregroundStyle(.secondary) }
            .frame(maxWidth: .infinity, minHeight: 50)
        }.buttonStyle(.bordered).tint(.primary).accessibilityIdentifier("deposit.applepay")
        .sheet(isPresented: $applePay) { ApplePayBuySheet().environmentObject(m) }
        CoinbaseDepositView(s: s)
        Button { Haptics.tap(); withAnimation { showOther.toggle() } } label: {
          HStack { Label(T("用钱包地址从 Coinbase 钱包转入", "Use the wallet address (from your Coinbase Wallet)"), systemImage: "arrow.left.arrow.right.circle").font(.subheadline.weight(.semibold)); Spacer(); Image(systemName: showOther ? "chevron.up" : "chevron.down") }
        }.accessibilityIdentifier("deposit.other").accessibilityValue(showOther ? "open" : "closed")
        if !showOther {
          HowItWorksStrip(steps: [("c.circle.fill", T("从 Coinbase 钱包转入", "From your Coinbase Wallet")), ("clock.arrow.circlepath", T("几秒到账", "Arrives in seconds")), ("gauge.with.dots.needle.33percent", T("AI 只在你的上限内花", "AI spends only within your limits"))])
            .padding(.top, 8)
        }
        if showOther {   // t885: no Coinbase exchange / Onramp account buy; only the user's own Coinbase Wallet (Coinbase wallet) or any wallet -> address
        OnlyUSDCWarning()
        AddressQR(address: w, network: "Base")
        VStack(alignment: .leading, spacing: 10) {
          Label(T("从你的 Coinbase 钱包转入", "From your Coinbase Wallet"), systemImage: "c.circle.fill").font(.headline)
          Text(T("只连你自己的 Coinbase 钱包，不连交易所。在 Coinbase 弹窗里选金额并确认，钱直接进你自己的启付钱包。", "Only your own Coinbase Wallet, never the exchange. Pick the amount in the Coinbase popup and confirm; it goes straight into your own Kipurse wallet.")).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          BigButton(T("从 Coinbase 钱包转入", "Move in from Coinbase Wallet"), icon: "arrow.down.circle.fill") {
            Haptics.tap(); waiting = true; watchUntil = Date().addingTimeInterval(600)
            guard let u = CoinbaseDepositView.transferURL(wallet: w) else { return }
            if m.demo == nil { CoinbaseDepositView.openTransfer(m, u, baseline: m.state?.balance ?? 0) } else { m.lastLaunch = u.absoluteString }   // in-app browser only
          }.accessibilityIdentifier("deposit.coinbase")
          if waiting {
            HStack(spacing: 8) { ProgressView(); Text(T("正在等待到账…转账后回到这里，到账会自动提示。", "Waiting for your money… come back here after sending; you'll see it when it arrives.")).font(.footnote).foregroundStyle(.secondary) }
              .accessibilityElement(children: .combine).accessibilityIdentifier("deposit.waiting")
          }
        }.card(padding: 18)
        }
      } else { Text(L("还没有钱包地址")).foregroundStyle(.secondary) }
    }
    .onAppear { if baseline == nil { baseline = m.state?.balance ?? s.balance } }
    .task { while !Task.isCancelled { try? await Task.sleep(nanoseconds: 5_000_000_000); if Task.isCancelled { break }; await check() } }
    .onChange(of: phase) { p in if p == .active { Task { await check() } } }
  }
  private func check() async {
    guard arrived == nil, Date() < watchUntil, phase == .active else { return }
    if m.demo != nil {
      guard waiting, CommandLine.arguments.contains("-kpArrive") else { return }
      demoTicks += 1
      // t1209: -kpArrive UI-test hook only: arrive on the 2nd tick so "waiting" stays 5-10 s
      if demoTicks >= 2, case .object(var j)? = m.state?.raw { j["balance"] = .string("\((m.state?.balance ?? 0) + 10_000_000)"); m.state = WalletState(.object(j)) }
    } else { await m.refresh() }
    let now = m.state?.balance ?? 0
    if let b = baseline, now > b { arrived = (now - b, now); waiting = false; Haptics.success() }
  }
}

/// 上限 on mainnet: the owner picks the numbers; his Coinbase wallet signs one batch on the page (the phone key can't change limits).
struct MainLimitsView: View {
  /// t1038u: .wallet = 钱包总限额 (on-chain floor only, opened from the Wallet tab); .ai = AI 总限额 (agent allowances + everyday, from AI Life).
  enum Scope { case all, wallet, ai }
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  let s: WalletState
  var scope: Scope = .all
  /// t1245 (§6#115 U23): the AI being connected when this page was opened from a connect (shown in a notice at the top).
  var connectName: String? = nil
  /// Set only when this page was opened to finish a connect. Called after an explicit save, never on back/cancel.
  var onAuthorized: (() -> Void)? = nil
  @State private var single = ""; @State private var daily = ""; @State private var term = ""; @State private var days = "90"
  @State private var verifyErr: String?
  @State private var fee: LimitsFee?
  @State private var evSingle = ""; @State private var evDaily = ""; @State private var evTerm = ""; @State private var evMsg: String?; @State private var evSaving = false
  @State private var showTopup = false; @State private var topupNeeded = false
  @State private var advOpen = CommandLine.arguments.contains("-kpLimitsAdvanced")
  @State private var ops = ""   // t1185u (§6#85): daily on-chain operations (V5.3 vaults only)
  var opsState: OpsCap.State? { OpsCap.state(live.raw) }
  /// The number to send, only when the owner changed it (nil = no setOpsPerDay call in the batch).
  var opsChange: Int? { guard let o = opsState, let n = OpsCap.parse(ops), n != o.perDay else { return nil }; return n }
  var err: String? { Mainnet.limitsError(single: single, daily: daily, term: term, days: days) ?? (opsState != nil ? OpsCap.error(ops) : nil) }
  /// t1094: use live state so a read-only chain caps fallback can update this page.
  var live: WalletState { m.state ?? s }
  var evTotal: Int64? { AnswerRules.parseUSDC(evTerm) }
  var evReady: Bool {
    AILimitGate.allowsContinue(single: evSingle, daily: evDaily, term: evTerm, caps: live.capRead)
  }
  var evCost: EverydayLimits.Cost? {
    guard let a = AnswerRules.parseUSDC(evSingle), let b = AnswerRules.parseUSDC(evDaily), let fs = live.capSingle, let fd = live.capDaily else { return nil }
    return EverydayLimits.cost(single: Int64(a), daily: Int64(b), floorSingle: fs, floorDaily: fd) }
  func aboveWalletSafety(_ a: Int64, _ b: Int64, _ t: Int64) -> Bool {
    if let fs = live.capSingle, a > fs { return true }
    if let fd = live.capDaily, b > fd { return true }
    if let ft = live.capTerm, t > ft { return true }
    return false
  }
  var evCostText: String {
    AILimitGate.line(single: evSingle, daily: evDaily, term: evTerm, caps: live.capRead)
  }
  /// t1245 (§6#115 U18/U19): one card per amount (same layout as the wallet safety limit page); the yellow/green line only after input.
  @ViewBuilder var everydayCard: some View {
    VStack(alignment: .leading, spacing: KP.Space.cardGap) {
      Text(T(EverydayLimits.aiExplainZh, EverydayLimits.aiExplainEn)).font(.headline).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 2).accessibilityIdentifier("everyday.title")
      AmountPicker(title: T("日常每笔最多", "Everyday per payment"), presets: ["1", "2", "5", "10", "100"], unit: "USDC", value: $evSingle).card(padding: 18)
      AmountPicker(title: T("日常每天最多", "Everyday per day"), presets: ["5", "20", "50", "100", "1000"], unit: "USDC", showFooter: false, value: $evDaily).card(padding: 18)
      AmountPicker(title: T("总额最多", "Total"), presets: ["20", "50", "100", "200", "500", "1000"], unit: "USDC", showFooter: false, value: $evTerm).accessibilityIdentifier("ai.limit.total").card(padding: 18)
      if AILimitGate.showsLine(single: evSingle, daily: evDaily, term: evTerm) {
        Text(evCostText).font(.subheadline.weight(.semibold)).foregroundStyle(evCost == .free ? Brand.positive : Brand.caution).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 2).accessibilityIdentifier("everyday.cost")
      }
      if let e = evMsg { Text(e).font(.footnote).padding(.horizontal, 2).accessibilityIdentifier("everyday.msg") }
      if firstConnect {
        BigButton(T("继续", "Continue"), icon: "arrow.right", disabled: !evReady) { continueFirst() }.accessibilityIdentifier("ai.limits.continue")
      } else {
        BigButton(evSaving ? T("正在保存…", "Saving…") : T("保存日常额度（Face ID）", "Save everyday limits (Face ID)"), icon: "faceid", disabled: !evReady || evSaving) { Task { await saveEveryday() } }.accessibilityIdentifier("everyday.save")
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("ai.limits.state")
    .accessibilityValue(evSingle.isEmpty && evDaily.isEmpty && evTerm.isEmpty ? "blank" : (firstConnect ? (evReady ? "chosen" : "partial") : (evReady ? "saved" : "partial")))
  }
  @ViewBuilder var freeVsPaid: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Label(T("两层上限", "Two layers"), systemImage: "square.stack.3d.up.fill").font(.headline).symbolRenderingMode(.hierarchical).foregroundStyle(Brand.accent)
        Spacer()
        InfoTip(title: T("两层上限怎么用", "How the two layers work"),
                text: T(EverydayLimits.freeZh + "\n\n" + EverydayLimits.paidZh + "\n\n为什么：" + EverydayLimits.whyZh + "\n\n" + EverydayLimits.stayFreeZh,
                        EverydayLimits.freeEn + "\n\n" + EverydayLimits.paidEn + "\n\nWhy: " + EverydayLimits.whyEn + "\n\n" + EverydayLimits.stayFreeEn), id: "limits.info")
      }
      VStack(alignment: .leading, spacing: 10) {
        layerRow("slider.horizontal.3", T(EverydayLimits.aiTitleZh, EverydayLimits.aiTitleEn), T(EverydayLimits.aiExplainZh, EverydayLimits.aiExplainEn))
        layerRow("lock.shield.fill", T(EverydayLimits.walletTitleZh, EverydayLimits.walletTitleEn), T(EverydayLimits.walletExplainZh, EverydayLimits.walletExplainEn))
      }.accessibilityElement(children: .combine).accessibilityIdentifier("limits.simple")
    }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 16)
  }
  func layerRow(_ icon: String, _ t: String, _ sub: String) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: icon).font(.title3).foregroundStyle(Brand.accent).symbolRenderingMode(.hierarchical).frame(width: 30)
      VStack(alignment: .leading, spacing: 2) { Text(t).font(.body.weight(.semibold)); Text(sub).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
    }
  }
  var floorFeeLine: String {
    if fee?.firstFree == true { return T("这次修改：第一次不收手续费", "This change: no fee the first time") }
    if let quote = fee?.usdcText, !quote.isEmpty { return T("这次修改：约 \(quote) USDC，按实际网络费从启付钱包扣", "This change: about \(quote) USDC, the actual network fee, from your Kipurse wallet") }
    return T(EverydayLimits.walletExplainZh, EverydayLimits.walletExplainEn)
  }
  var firstConnect: Bool {
    #if DEBUG
    if CommandLine.arguments.contains("-kpAILimits") { return true }
    #endif
    return onAuthorized != nil && AIConnect.saved(in: s, demo: m.demo != nil) == nil
  }
  /// First connect only remembers the three amounts and returns to the same connection. It does not save and does not authorize.
  func continueFirst() {
    guard let a = AnswerRules.parseUSDC(evSingle), let b = AnswerRules.parseUSDC(evDaily), let t = AnswerRules.parseUSDC(evTerm), AILimitGate.allowsContinue(single: evSingle, daily: evDaily, term: evTerm, caps: live.capRead) else { return }
    AIConnect.pendingAmounts = AISpendLimits.Saved(single: a, daily: b, term: t)
    onAuthorized?()
  }
  func saveEveryday() async {
    guard !firstConnect else { return }
    guard let a = AnswerRules.parseUSDC(evSingle), let b = AnswerRules.parseUSDC(evDaily), let t = AnswerRules.parseUSDC(evTerm), AILimitGate.allowsContinue(single: evSingle, daily: evDaily, term: evTerm, caps: live.capRead) else { return }
    evSaving = true; defer { evSaving = false }
    #if DEBUG
    if CommandLine.arguments.contains("-kpAIAuthFail") {
      evMsg = T("没有通过 Face ID，没有修改。", "Face ID not confirmed. Nothing changed."); return
    }
    // t1156u UI test: the session step failed in one of these ways (no server involved).
    if let i = CommandLine.arguments.firstIndex(of: "-kpSessionFail"), i + 1 < CommandLine.arguments.count {
      let e: Error
      switch CommandLine.arguments[i + 1] {
      case "faceidoff": e = NSError(domain: "com.apple.LocalAuthentication", code: -6)
      case "nokey": e = MainnetSession.Failure.noKey
      case "cancel": e = NSError(domain: "com.apple.LocalAuthentication", code: -2)
      default: e = URLError(.notConnectedToInternet)
      }
      evMsg = MainnetSession.saveErrorText(e); return
    }
    if UserDefaults.standard.string(forKey: "kpMockLimits") != nil { evMsg = T("已保存，马上生效", "Saved, effective now"); return }
    #endif
    // t1266 (fix 9): raising AI everyday limits is an approval: Face ID only (the passcode may only unlock a locked Face ID first).
    // t1268: ONE Face ID. Its evaluated context opens a read session when there is none AND unlocks the phone key, which signs exactly
    // these three amounts (KipurseCore EverydaySign.text) over the server's single-use challenge; the server checks that signature
    // against this wallet's ACTIVE phone key (a session token alone can no longer change the limits).
    guard let ctx = await BiometricGate.unlockContext(reason: T("修改日常额度", "Change everyday limits")) else { evMsg = T("没有通过 Face ID，没有修改。", "Face ID not confirmed. Nothing changed."); return }
    defer { ctx.invalidate() }
    do { let (c, j) = try await MainnetSession.signedEveryday(single: a, daily: b, term: t, context: ctx)
      if c == 200 {
        SignedLimitsStore.save(AISpendLimits.Saved(single: a, daily: b, term: t), wallet: PhoneTrust.mainnetWallet)   // t1275: the exact numbers this phone key just signed = the only trust ceiling the phone accepts
        await m.refresh()
        if AISpendLimits.saved(m.state?.raw) != nil {
          evMsg = T("已保存，马上生效", "Saved, effective now")
          if onAuthorized != nil { onAuthorized?(); dismiss() }
        } else {
          evMsg = T("服务器没有确认每笔、每天和总额，没有保存。", "The server did not confirm the per-payment, daily, and total amounts. Nothing was saved.")
        }
      } else {
        evMsg = (j["error"] as? String) == "above_floor" ? T(EverydayLimits.aboveWalletZh, EverydayLimits.aboveWalletEn) : T("没有保存，请稍后再试。", "Not saved. Try again later.")
      }
    } catch { evMsg = MainnetSession.saveErrorText(error) }   // t1156u
  }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: KP.Space.cardGap) {
        if firstConnect, let n = connectName {   // t1245 (§6#115 U23): why this page opened in the middle of connecting
          KPNotice { Label(T("先设 AI 花钱上限，保存后继续连接 \(n)", "Set your AI spending limits first; then we continue connecting \(n)"), systemImage: "link.badge.plus").font(KP.Typo.body.weight(.semibold)).foregroundStyle(Brand.accent).fixedSize(horizontal: false, vertical: true) }
            .accessibilityIdentifier("ai.limits.connectNote")
        }
        if scope != .wallet { AgentLimitsCard(s: s) }   // t927: the one place that explains the limits (moved off the home page)
        if scope == .all { Button { withAnimation { advOpen.toggle() } } label: {
          HStack { Text(T("高级：链上安全底线", "Advanced: on-chain safety floor")).font(.headline); Spacer(); Image(systemName: advOpen ? "chevron.up" : "chevron.down").foregroundStyle(.secondary) }
            .contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityIdentifier("limits.advanced").accessibilityValue(advOpen ? T("已展开", "Expanded") : T("已收起", "Collapsed")) }
        if advOpen || scope == .wallet {
          VStack(alignment: .leading, spacing: 16) {
            freeVsPaid
            Text(T(EverydayLimits.walletTitleZh, EverydayLimits.walletTitleEn)).font(.title3.bold()).accessibilityIdentifier("floor.title")
            VStack(spacing: 0) {
              row(L("每笔最多"), live.capSingle); Divider(); row(L("每天最多"), live.capDaily); Divider(); row(L("总额最多"), live.capTerm)
              if let a = s.capStart { Divider(); HStack { Text(L("生效时间")); Spacer(); Text(Mainnet.localTime(a)).font(.body.monospacedDigit()).foregroundStyle(.secondary) }.padding(.vertical, 10) }
              if let e = s.capEnd { Divider(); HStack { Text(L("结束时间")); Spacer(); Text(Mainnet.localTime(e)).font(.body.monospacedDigit()).foregroundStyle(.secondary) }.padding(.vertical, 10) }
            }.card(padding: 16)
            AmountPicker(title: L("每笔最多"), presets: ["1", "2", "5", "10", "100", "1000"], unit: "USDC", value: $single).card(padding: 18)
            AmountPicker(title: L("每天最多"), presets: ["5", "20", "50", "100", "1000", "10000"], unit: "USDC", showFooter: false, value: $daily).card(padding: 18)
            AmountPicker(title: L("总额最多"), presets: ["1000", "5000", "10000", "50000", "100000", "500000"], unit: "USDC", showFooter: false, value: $term).card(padding: 18)
            AmountPicker(title: L("有效期"), presets: ["30", "90", "180", "365"], unit: L("天"), isDays: true, value: $days).card(padding: 18)
            if let os = opsState {   // t1185u (§6#85, owner-approved minimal addition): daily on-chain operations, same picker style
              VStack(alignment: .leading, spacing: 10) {
                HStack { Text(T("每天链上操作次数", "On-chain operations per day")).font(.headline); Spacer()
                  InfoTip(title: T("每天链上操作次数", "On-chain operations per day"), text: T(OpsCap.explainZh, OpsCap.explainEn), id: "ops.info") }
                Text(OpsCap.line(os)).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary).accessibilityIdentifier("ops.today")
                AmountPicker(title: T("每天最多", "Per day, at most"), presets: OpsCap.presets, unit: T("次", "ops"), idPrefix: "ops",
                             countHint: T("自己填（1–100000）", "Your own (1–100000)"), countFooter: T("每次 AI 付款大约用 1 次。用完了只是等到 UTC 0 点自动恢复，不会丢钱。", "Each AI payment uses about 1. If it runs out, payments just wait until 00:00 UTC; no money is lost."), value: $ops)
              }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 18).accessibilityElement(children: .contain).accessibilityIdentifier("ops.card")
            }
            if let e = err { ErrorText(text: e) } else {
              VStack(alignment: .leading, spacing: 6) {
                Text(L("你要确认的内容")).font(.headline)
                Text(L("每笔 \(single) · 每天 \(daily) · 总额 \(term) USDC · \(days) 天")).font(.subheadline.monospacedDigit()).accessibilityIdentifier("limits.summary")
                if let n = opsChange { Text(T("每天链上操作最多 \(n) 次", "On-chain operations: at most \(n) per day")).font(.subheadline.monospacedDigit()).accessibilityIdentifier("ops.summary") }
                Text(LimitsFee.text(fee)).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("limits.fee")
                Text(floorFeeLine).font(.subheadline.weight(.semibold)).accessibilityIdentifier("floor.cost")
              }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 16)
            }
            BigButton(T("去 Coinbase 确认", "Confirm in Coinbase"), icon: "signature", disabled: err != nil) {
              Task { await verifyThenSign() }
            }.accessibilityIdentifier("limits.sign")
          }.padding(.top, 8)
        }
        if scope != .wallet { everydayCard }
      }.padding(20)
    }.background(Brand.canvas).amountKeyboardToolbar().navigationTitle(scope == .wallet ? T(EverydayLimits.walletTitleZh, EverydayLimits.walletTitleEn) : scope == .ai ? T(EverydayLimits.aiTitleZh, EverydayLimits.aiTitleEn) : T("AI 额度", "AI allowance")).navigationBarTitleDisplayMode(.inline).task { if !DemoGuard.active { fee = await LimitsFee.load() }; if case .ready = live.capRead {} else { await m.chainBalanceFallback() } }
    .alert(T("没有打开确认页", "Signing page not opened"), isPresented: Binding(get: { verifyErr != nil }, set: { if !$0 { verifyErr = nil } })) {
      if topupNeeded { Button(T("去给钱包充值", "Top up wallet")) { topupNeeded = false; showTopup = true }; Button(T("以后再说", "Later"), role: .cancel) { topupNeeded = false } } else { Button(T("好", "OK")) {} }
    } message: { Text(verifyErr ?? "") }
    .sheet(isPresented: $showTopup) { NavigationStack { ScrollView { DepositView(s: s).padding(KP.Space.page) }.background(MockBG()).navigationTitle(T("充值", "Add money")) } }
    .onAppear {
      // t1074/t1094: fill the AI editors only from an explicit everyday save or pending choice. Never from chain caps; never invent default amounts.
      if evSingle.isEmpty, let g = AIConnect.saved(in: s, demo: m.demo != nil) {
        evSingle = AnswerRules.format(g.single); evDaily = AnswerRules.format(g.daily); evTerm = AnswerRules.format(g.term)
      } else if evSingle.isEmpty, firstConnect, let g = AIConnect.pendingAmounts {
        evSingle = AnswerRules.format(g.single); evDaily = AnswerRules.format(g.daily); evTerm = AnswerRules.format(g.term)
      }
      if ops.isEmpty, let o = opsState { ops = String(o.perDay) }
      if single.isEmpty {
        if let d = LimitTerm.days(start: live.capStart, end: live.capEnd) { days = String(d) }   // t1245 U20: today's validity, not a fixed 90
        if let v = live.capSingle { single = AnswerRules.format(v) }
        if let v = live.capDaily { daily = AnswerRules.format(v) }
        if let v = live.capTerm { term = AnswerRules.format(v) }
      }
    }
  }
  private func row(_ t: String, _ v: Int64?) -> some View {
    HStack { Text(t); Spacer(); Text(v.map { "\(AnswerRules.format($0)) USDC" } ?? "—").font(.body.monospacedDigit().weight(.semibold)) }.padding(.vertical, 10)   // t1245 U20: same number as the box below
  }
}

/// A pending mainnet trust request: the phone key approves it (Face ID) in PhoneApproveTrustSheet.
struct MainTrustCard: View {
  @EnvironmentObject var m: AppModel; let r: TrustRequest
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: KP.Space.s) {   // t991: limits chip under the title, never squeezed
        Avatar(name: r.merchantName, size: 40, symbol: "person.badge.shield.checkmark").kPulse()
        VStack(alignment: .leading, spacing: KP.Space.xxs) {
          Text(L("让 AI 付钱给新商家？")).font(KP.Typo.cardTitle).fixedSize(horizontal: false, vertical: true)
          Text(r.merchantName.isEmpty ? shortAddr(r.payee) : r.merchantName).font(KP.Typo.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          Text(T("每笔 ≤ \(Mainnet.whole(r.single)) · 每天 ≤ \(Mainnet.whole(r.total)) USDC", "Up to \(Mainnet.whole(r.single)) USDC each · \(Mainnet.whole(r.total)) USDC a day")).font(.caption.monospacedDigit().weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 4).background(Brand.accentSoft, in: Capsule()).foregroundStyle(Brand.accent).lineLimit(1).minimumScaleFactor(0.8).padding(.top, 2)
        }
        Spacer(minLength: 0)
      }
      if !r.requestedBy.isEmpty || !r.reason.isEmpty {
        HStack(spacing: 6) {
          Image(systemName: "sparkles").foregroundStyle(Brand.accent)
          if !r.requestedBy.isEmpty { Text(r.requestedBy.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: T("、", ", "))).fontWeight(.semibold).accessibilityLabel(T("谁申请的：", "Asked by: ") + r.requestedBy.joined(separator: T("、", ", "))).accessibilityIdentifier("approve.who") }
          if !r.reason.isEmpty { Text("“" + r.reason + "”").lineLimit(3).accessibilityLabel(T("AI 说的理由：", "AI's reason: ") + r.reason).accessibilityIdentifier("approve.why") }
        }.font(.footnote).foregroundStyle(.secondary)
      }
      BigButton(L("查看并批准"), icon: "faceid") { m.trustReq = TrustReq(id: r.id) }.accessibilityIdentifier("approve.open")
    }.card(padding: 18).assistantRef(.approval(id: "treq:" + r.id))
  }
}

/// All payments (pushed from 钱包 → 全部).
struct ActivityList: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  @State private var picked: Tx?
  var groups: [(String, [Tx])] {
    let cal = Calendar.current; let f = DateFormatter(); f.locale = Loc.isChinese ? Locale(identifier: "zh_CN") : Locale(identifier: "en_US"); f.dateFormat = L("M月d日 EEEE")
    var order: [String] = []; var map: [String: [Tx]] = [:]
    for t in s.txs {
      let k = t.date.map { cal.isDateInToday($0) ? L("今天") : cal.isDateInYesterday($0) ? L("昨天") : f.string(from: $0) } ?? L("更早")
      if map[k] == nil { order.append(k) }; map[k, default: []].append(t)
    }
    return order.map { ($0, map[$0]!) }
  }
  var body: some View {
    List {
      if s.txs.isEmpty { Section { EmptyState(icon: "list.bullet.rectangle", title: L("还没有记录"), text: "") } }
      ForEach(groups, id: \.0) { g in Section(g.0) { ForEach(g.1) { t in Button { picked = t } label: { TxRow(t: t) }.foregroundStyle(.primary) } } }
    }
    .listStyle(.insetGrouped).kpSectionRhythm().refreshable { await m.refresh() }
    .navigationTitle(L("记录"))
    .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in picked = nil }
    .sheet(item: $picked) { t in TxDetail(t: t, explorer: s.explorer, agentName: s.agentName(t), category: s.category(t)).presentationDetents([.medium, .large]) }
  }
}

/// Main wallet card on mainnet: the live caps + real on-chain start/end (phone's local time); 已更新 right after a change.
struct MainCapsCard: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack { Label(T(EverydayLimits.walletTitleZh, EverydayLimits.walletTitleEn), systemImage: "gauge.with.dots.needle.67percent").font(.headline).symbolRenderingMode(.hierarchical); Spacer()
        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        if m.limitsUpdated != nil { Label(L("已更新"), systemImage: "checkmark.circle.fill").font(.caption.weight(.bold)).foregroundStyle(.white)
          .padding(.horizontal, 8).padding(.vertical, 3).background(Capsule().fill(Brand.positive)).accessibilityIdentifier("caps.updated") } }
      Text(L("每笔 \(Mainnet.whole(s.capSingle ?? 0)) · 每天 \(Mainnet.whole(s.capDaily ?? 0)) · 总额 \(Mainnet.whole(s.capTerm ?? 0)) USDC"))
        .font(.subheadline.monospacedDigit().weight(.semibold)).accessibilityIdentifier("caps.values")
      if let d = s.capDaily, d > 0 {
        ProgressView(value: Double(min(s.spentToday, d)), total: Double(d)).tint(Brand.accent)
        Text(L("今天已花 \(AnswerRules.format(s.spentToday)) · 本期已花 \(AnswerRules.format(s.spentTerm))")).font(.caption.monospacedDigit()).foregroundStyle(.secondary).accessibilityIdentifier("caps.spent")
      }
      if let a = s.capStart, let e = s.capEnd { Text(Mainnet.termRange(a, e)).font(.caption2.monospacedDigit()).foregroundStyle(.tertiary).accessibilityIdentifier("caps.term") }
      Text(T("超出上限时，发到手机用 Face ID 同意", "Over the limit? Your phone asks for Face ID")).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("caps.explain")
    }.foregroundStyle(.primary).frame(maxWidth: .infinity, alignment: .leading).card(padding: 16)
  }
}

/// Full-screen 授权中… -> 授权完成 (or failure + retry). Never shows the stale pre-auth form. 授权完成 auto-dismisses to the wallet.
struct AuthOverlay: View {
  @EnvironmentObject var m: AppModel
  @State private var pop = false
  var body: some View {
    VStack(spacing: 14) {
      if m.limitsCelebrate, let u = m.limitsUpdated {
        Image(systemName: "checkmark.circle.fill").font(.system(size: 84)).foregroundStyle(Brand.positive).scaleEffect(pop ? 1 : 0.3).opacity(pop ? 1 : 0)
        Text(L("授权完成")).font(.title2.weight(.bold)).accessibilityIdentifier("auth.done")
        Text(L("新的钱包安全上限已生效")).foregroundStyle(.secondary).accessibilityIdentifier("limits.success")
        VStack(spacing: 6) {
          Text(L("每笔最多 \(AnswerRules.format(u.single)) USDC")); Text(L("每天最多 \(AnswerRules.format(u.daily)) USDC")); Text(L("总额最多 \(AnswerRules.format(u.term)) USDC"))
          Text(L("生效时间 \(Mainnet.localTime(u.start))")).foregroundStyle(.secondary); Text(L("结束时间 \(Mainnet.localTime(u.end))")).foregroundStyle(.secondary)
        }.font(.body.monospacedDigit())
        .onAppear { pop = false; withAnimation(.spring(response: 0.45, dampingFraction: 0.6)) { pop = true }
          if !CommandLine.arguments.contains("-kpHoldOverlay") { Task { try? await Task.sleep(nanoseconds: 2_600_000_000); withAnimation { m.limitsCelebrate = false } } } }
      } else if let f = m.authFailed {
        Image(systemName: "exclamationmark.circle.fill").font(.system(size: 84)).foregroundStyle(Brand.negative)
        Text(L("授权没有完成")).font(.title2.weight(.bold)).accessibilityIdentifier("auth.failed")
        Text(f).multilineTextAlignment(.center).foregroundStyle(.secondary)
        BigButton(L("再查一次"), icon: "arrow.clockwise") { m.retryAuthCheck() }.accessibilityIdentifier("auth.retry")
        BigButton(L("关闭"), kind: .secondary) { m.dismissAuthOverlay() }.accessibilityIdentifier("auth.close")
      } else if let p = m.authPending {
        ProgressView().controlSize(.large).scaleEffect(1.6).padding(12)
        Text(L("授权中…")).font(.title2.weight(.bold)).accessibilityIdentifier("auth.pending")
        Text(T("已提交，正在确认（通常 10–60 秒）。", "Submitted, confirming (usually 10–60 s).")).multilineTextAlignment(.center).foregroundStyle(.secondary)
        if p.term > 0 { Text(L("每笔 \(AnswerRules.format(p.single)) · 每天 \(AnswerRules.format(p.daily)) · 总额 \(AnswerRules.format(p.term)) USDC")).font(.subheadline.monospacedDigit()) }
      }
    }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity).background(Brand.canvas.ignoresSafeArea())
    .onTapGesture { if m.limitsCelebrate { withAnimation { m.limitsCelebrate = false } } }
  }
}

/// 余额变动: every on-chain USDC change of the wallet (and its fee reserve), with the balance after it. Tap = BaseScan.
/// Plain-language title for a ledger row (no "Coinbase wallet" / network-fee jargon); falls back to the server text.
enum LedgerText {
  /// Fee-type rows (audit #8): folded into one total instead of many small lines.
  static func isFee(_ r: LedgerRow) -> Bool { r.isVault || ["settle", "gas", "ownerfee"].contains(r.kind) }
  /// Where the payee address came from / its trust level (server tier).
  static func tier(_ t: String?) -> String? {
    switch t {
    case "trust_list": return T("收款方在你的信任名单里", "Payee on your trust list")
    case "verified": return T("已核实的收款方（以前付过款）", "Verified payee (paid before)")
    case "owner_direct": return T("地址是你亲自给的", "Address you gave yourself")
    case "ai_verified", "ai_upgraded", "stranger": return T("新收款方，你用 Face ID 批准过", "New payee you approved with Face ID")
    case "mandate": return T("在你设的 AI 付款上限内", "Within your AI payment limit")
    case "x402": return T("网页付款", "Web payment")
    default: return nil
    }
  }
  static func title(_ r: LedgerRow, feeStyle: MoneyText.FeeStyle? = nil) -> String {
    switch r.kind {
    case "deposit": return T("充值", "Deposit")
    case "withdraw":
      // t1129u: the wallet-paid network fee of the same withdrawal is part of this one row (amount shown = total that left).
      if let f = r.fee { return T("已提现到你的 Coinbase 钱包（含网络费 \(MoneyText.fee(f))）", "Withdrawn to your Coinbase wallet (incl. \(MoneyText.fee(f)) network fee)") }
      return T("已提现到你的 Coinbase 钱包", "Withdrawn to your Coinbase wallet")
    case "walletfee": return T("网络费（钱包操作，从余额扣）", "Network fee (wallet action, from your balance)")
    case "settle", "gas": return T("手续费", "Fee")
    case "ownerfee": return T("手续费（你的 Coinbase 付）", "Fee (paid by your Coinbase)")
    case "payment":
      guard Loc.isChinese else { return "AI payment" }
      // t1245 (§6#115 U41): no amount in the title (the right side shows what left the wallet, fees included) and no stray spaces:
      // 「AI 付款 0.01 给 你的 Coinbase 钱包（含手续费…）」 -> 「AI 付款给你自己（含手续费）」.
      let withFee = r.zh.contains("手续费")  // i18n-ok: zh-only branch
      var t = r.zh.replacingOccurrences(of: "（[^）]*）", with: "", options: .regularExpression)  // i18n-ok: zh-only branch
      t = t.replacingOccurrences(of: "你的 Coinbase 钱包", with: "你自己")  // i18n-ok
      t = t.replacingOccurrences(of: "付款\\s*[0-9][0-9.,]*\\s*(USDC)?\\s*给\\s*", with: "付款给", options: .regularExpression)  // i18n-ok: zh-only branch
      t = t.trimmingCharacters(in: .whitespaces)
      return withFee ? t + "（含手续费）" : t  // i18n-ok
    default:
      guard Loc.isChinese, !r.zh.isEmpty else { return r.delta >= 0 ? T("收到", "Received") : T("支出", "Spent") }
      return r.zh.replacingOccurrences(of: "你的 Coinbase 钱包", with: "你的账户").replacingOccurrences(of: "手续费", with: "手续费")  // i18n-ok: zh-only branch
    }
  }
}
struct LedgerRowView: View {
  let r: LedgerRow
  /// t1245 (§6#115 U26): fee rows use the page's one fee style; every other row is a plain 2-decimal USDC amount.
  var feeStyle: MoneyText.FeeStyle? = nil
  @EnvironmentObject var m: AppModel
  private var amountText: String {
    let a = r.delta >= 0 ? r.delta : -r.delta
    if LedgerText.isFee(r) || r.kind == "walletfee" { return (r.delta >= 0 ? "+" : "−") + MoneyText.fee(a, style: feeStyle ?? MoneyText.FeeStyle.page([a])) }
    return MoneyText.signed(r.delta)
  }
  private func hide(_ t: String) -> String { m.balanceRevealed ? t : t.replacingOccurrences(of: "[0-9][0-9.,]*", with: BalanceMask.short, options: .regularExpression) }
  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: r.kind == "deposit" ? "arrow.down" : r.kind == "withdraw" ? "arrow.uturn.down" : r.kind == "payment" ? "sparkles" : "circle.dotted")
        .font(.footnote.weight(.semibold)).foregroundStyle(r.delta >= 0 ? Brand.positive : Brand.accent)
        .frame(width: 32, height: 32).background((r.delta >= 0 ? Brand.positive : Brand.accent).opacity(0.12), in: Circle()).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        Text(hide(LedgerText.title(r, feeStyle: feeStyle))).font(.subheadline.weight(.medium)).lineLimit(2).multilineTextAlignment(.leading)
        Text(Mainnet.localTime(r.t) + (r.isVault ? T(" · 预留的手续费", " · set aside for network fees") : "")).font(.caption).foregroundStyle(.secondary)
        if r.kind == "payment", r.orderItem != nil || r.orderQuote != nil || r.orderTier != nil || r.payeeName != nil {
          VStack(alignment: .leading, spacing: 2) {
            if let n = r.payeeName { Text(T("收款方：", "Payee: ") + n).fontWeight(.medium) }
            if let i = r.orderItem { Text(T("买的：", "For: ") + i + (r.orderMerchant.map { " · " + $0 } ?? "")).lineLimit(2) }
            if let a = r.payeeAddress { Text(fullAddr(a)).font(.caption2.monospaced()).lineLimit(2) }
            if let q = r.orderQuote { Text(T("你说的：“", "You said: \u{201C}") + q + T("”", "\u{201D}")).lineLimit(3) }
            if let b = r.orderBudget { Text(T("预算：", "Budget: ") + b + " USDC") }
            if let t = LedgerText.tier(r.orderTier) { Text(t).foregroundStyle(r.orderTrial ? Brand.accent : Color.secondary) }
          }.font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("ledger.order")
        }
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 3) {
        Text(m.balanceRevealed ? amountText : BalanceMask.short).accessibilityValue(m.balanceRevealed ? r.signed : "").font(Brand.money(16, .semibold)).foregroundStyle(r.delta >= 0 ? Brand.positive : Color.primary)
        if let b = r.balance { Text(L("余额 \(m.balanceRevealed ? MoneyText.amount(b) : BalanceMask.short)")).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
        else { Text(T("不在钱包里扣", "Not from the wallet")).font(.caption).foregroundStyle(.secondary) }
      }
    }.padding(.vertical, 8).contentShape(Rectangle()).assistantRef(.payment(txHash: r.tx))
  }
}
/// §6#110 (owner 2026-11-21): wallet records split into 入金 (deposits) / 支付 (payments) / 提现 (withdrawals).
/// 全部 keeps every money movement (incl. wallet network-fee rows); fee rows stay visible as the fee total + fee detail (0A#5).
enum LedgerFilter: String, CaseIterable, Identifiable {
  case all, deposit, payment, withdraw
  var id: String { rawValue }
  var title: String {
    switch self {
    case .all: return T("全部", "All")
    case .deposit: return T("入金", "Deposits")
    case .payment: return T("支付", "Payments")
    case .withdraw: return T("提现", "Withdrawals")
    }
  }
  func keep(_ r: LedgerRow) -> Bool {
    guard !r.suspicious, !LedgerText.isFee(r) else { return false }
    return self == .all || r.kind == rawValue
  }
}
struct LedgerFilterPicker: View {
  @Binding var filter: LedgerFilter
  var body: some View {
    Picker(T("记录类型", "Record type"), selection: $filter) { ForEach(LedgerFilter.allCases) { f in Text(f.title).tag(f) } }
      .pickerStyle(.segmented).accessibilityIdentifier("ledger.filter")
  }
}
struct LedgerSection: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  @State private var filter: LedgerFilter = .all
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack { Header(text: T("入金 · 支付 · 提现记录", "Activity")).accessibilityIdentifier("ledger.title"); Spacer(); if !s.ledger.isEmpty { NavigationLink(L("全部")) { LedgerList(s: s, filter: filter) }.font(.subheadline.weight(.semibold)).accessibilityIdentifier("home.allActivity") } }
      if !s.ledger.isEmpty { LedgerFilterPicker(filter: $filter) }
      VStack(spacing: 0) {
        if s.ledger.isEmpty { VStack(spacing: 6) { Image(systemName: "list.bullet.rectangle").font(.title2).foregroundStyle(.tertiary); Text(L("还没有记录")).font(.subheadline.weight(.semibold)); Text(T("充值后，每一笔进出都会显示在这里。", "Every deposit and payment will show up here.")).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }.frame(maxWidth: .infinity).padding(.vertical, 20) }
        let clean = s.ledger.filter { filter.keep($0) }
        if !s.ledger.isEmpty && clean.isEmpty { Text(T("这一类还没有记录", "Nothing of this type yet")).font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 16).accessibilityIdentifier("ledger.filterEmpty") }
        ForEach(Array(clean.prefix(3).enumerated()), id: \.element.id) { i, r in
          Button { if let u = r.url(explorer: s.explorer) { m.webSheet = WebSheet(url: u) } } label: { LedgerRowView(r: r) }.foregroundStyle(.primary).accessibilityIdentifier("ledger.row.\(i)")
          if i < min(3, clean.count) - 1 { Divider() }
        }
        FeeTotalRow(rows: s.ledger)
        SuspiciousToggle(rows: s.ledger.filter(\.suspicious), explorer: s.explorer)
      }.card(padding: 14)
    }
  }
}
struct LedgerList: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  @State var filter: LedgerFilter = .all
  var body: some View {
    List { Section { LedgerFilterPicker(filter: $filter) }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
      Group {
      LedgerSummarySection(rows: s.ledger, filter: filter)   // t1245 U27: the summary follows the filter
      Section(filter == .all ? T("资金进出", "Money in and out") : filter.title) {
        let rows = s.ledger.filter { filter.keep($0) }
        if rows.isEmpty { Text(T("这一类还没有记录", "Nothing of this type yet")).foregroundStyle(.secondary) }
        ForEach(rows) { r in Button { if let u = r.url(explorer: s.explorer) { m.webSheet = WebSheet(url: u) } } label: { LedgerRowView(r: r, feeStyle: LedgerSummarySection.feeStyle(s.ledger)) }.foregroundStyle(.primary) } }
      FeeDetailSection(rows: s.ledger, explorer: s.explorer)   // 0A#5: every fee row stays one tap away under every filter
      SuspiciousToggle(rows: s.ledger.filter(\.suspicious), explorer: s.explorer)
      }.listRowBackground(GlassRowBG()) }
      // t1245 (§6#115 U8): glass list on the brand background, like the wallet card it is opened from
      .listStyle(.insetGrouped).kpSectionRhythm().scrollContentBackground(.hidden).background(MockBG())
      .navigationTitle(T("全部记录", "All activity")).navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .topBarTrailing) { BalanceEyeButton(font: .body) } }
  }
}


/// Where to take the money back from, remembered in memory just before "delete account" wipes the phone (so the
/// withdraw screen still works right after an erase). Never written to disk.
enum WithdrawTarget { static var server: URL?; static var owner: String? }

/// 提现到我的账户 — ONE screen for every way in (安全, home, after deleting the account).
/// t1116u: amount = any amount the user picks or 「全部」 (everything, incl. the small fee reserve) → to: your Coinbase wallet (fixed) → fee → one button.
/// After deleting the account (`fullOnly`) the screen keeps the old fixed full-balance row.
/// Button → confirm → Face ID → the phone checks the prepared batch itself → our page opens with it ready → tap 确认, passkey → back here: done.
struct MainWithdrawView: View {
  @EnvironmentObject var m: AppModel
  let s: WalletState
  var fullOnly = false   // t1116u: close-account path stays "everything"
  enum Phase: Equatable { case loading, ready, empty, failed(String), waiting, done(Int64) }
  @State private var phase: Phase = .loading
  @State private var q: Quote?
  @State private var ask = false
  @State private var planId: String?
  @State private var page: WebSheet?
  @State private var poll: Task<Void, Never>?
  @State private var chainTotal: Int64?   // t784: wallet + vault USDC read from the chain by this iPhone
  @State private var amountText = ""   // t1116u: 「全部」 or the typed / preset amount
  private var allLabel: String { T("全部", "All") }
  /// t1116u: what the user is about to withdraw (atomic USDC); nil while the choice is not valid.
  private var chosen: Int64? { guard let q else { return nil }; if fullOnly { return q.amount }; return amountProblem == nil ? WithdrawAmount.chosen(text: amountText, allLabel: allLabel, total: q.amount) : nil }
  private var amountProblem: WithdrawAmount.Problem? { guard let q, !fullOnly else { return nil }; return WithdrawAmount.problem(text: amountText, allLabel: allLabel, total: q.amount, fee: q.fee) }
  private func problemText(_ p: WithdrawAmount.Problem, _ q: Quote) -> String {
    switch p {
    case .empty: return T("请选择或填写要提现的金额。", "Choose or enter an amount to withdraw.")
    case .notANumber: return T("请输入像 10 或 12.5 这样的金额。", "Enter an amount like 10 or 12.5.")
    case .zero: return T("金额要大于 0。", "The amount must be more than 0.")
    case .overBalance: return T("超过了钱包余额（\(AnswerRules.format(q.amount)) USDC），不能提现这么多。", "That is more than your wallet balance (\(AnswerRules.format(q.amount)) USDC).")
    case .notAboveFee: return T("金额要大于网络手续费（约 \(AnswerRules.format(q.fee ?? 0)) USDC），不然到账是 0。", "The amount must be more than the network fee (about \(AnswerRules.format(q.fee ?? 0)) USDC), or nothing would arrive.")
    }
  }
  struct Quote { let amount: Int64, inWallet: Int64, reserve: Int64, to: String, vault: String?, fee: Int64?, wallet: String }
  private var server: URL { WithdrawTarget.server ?? Mainnet.server }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: KP.Space.cardGap) {
        switch phase {
        case .loading: ProgressView(T("正在查余额…", "Checking your balance…")).frame(maxWidth: .infinity).padding(.top, 40)
        case .done(let a): doneView(a)
        default: mainView
        }
      }.padding(20)
    }
    .background(Brand.canvas).amountKeyboardToolbar().navigationTitle(T("提现", "Withdraw")).navigationBarTitleDisplayMode(.inline)
    .task { await load() }
    // our own page opens on top of THIS screen (a root sheet can't show over a sheet)
    .onReceive(NotificationCenter.default.publisher(for: .kpCloseLocalSheets)) { _ in page = nil }
    .sheet(item: $page) { w in SignPage(url: w.url, signing: true).ignoresSafeArea() }   // t1266: only a checked Kipurse signing page
    .onDisappear { poll?.cancel() }
    .confirmationDialog(T("把钱提现到你的 Coinbase 钱包？", "Withdraw to your Coinbase wallet?"), isPresented: $ask, titleVisibility: .visible) {
      Button(T("确认提现", "Confirm withdrawal")) { Task { await go() } }.accessibilityIdentifier("withdraw.confirm")
      Button(T("取消", "Cancel"), role: .cancel) {}
    } message: { if let c = chosen { Text(T("\(AnswerRules.format(c)) USDC 会转到你自己的 Coinbase 钱包（就是你用 Coinbase 登录的那个，不是 Coinbase App 里的交易账户）。下一步在 Coinbase 窗口里点确认就好。", "\(AnswerRules.format(c)) USDC goes to your own Coinbase wallet (the account you sign in to with Coinbase, not your Coinbase exchange account). Next, just tap Confirm in the Coinbase window.")).accessibilityIdentifier("withdraw.confirmMessage") } }
  }

  @ViewBuilder private var mainView: some View {
    VStack(alignment: .leading, spacing: 0) {
      if fullOnly {
        row(T("提现金额（全部余额）", "Amount (full balance)")) { Text(q.map { AnswerRules.format($0.amount) + " USDC" } ?? "—").font(Brand.money(22, .semibold)).accessibilityIdentifier("withdraw.amount") }
      } else if let q {
        // t1116u: any amount or 「全部」; presets above the balance are unavailable (same idea as deposit)
        VStack(alignment: .leading, spacing: 8) {
          AmountPicker(title: T("提现金额", "Amount"), presets: ["1", "5", "10", "50", "100", allLabel], unit: "USDC", maxAtomic: q.amount, idPrefix: "withdraw", value: $amountText)
          if let p = amountProblem { Text(problemText(p, q)).font(.footnote).foregroundStyle(Brand.negative).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("withdraw.amountProblem") }
          else if let c = chosen { Text(T("这次提现 \(AnswerRules.format(c)) USDC（余额 \(AnswerRules.format(q.amount)) USDC）", "Withdrawing \(AnswerRules.format(c)) USDC (balance \(AnswerRules.format(q.amount)) USDC)")).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("withdraw.amount") }
        }.padding(.vertical, 12)
      }
      Divider()
      row(T("转到", "To")) {
        VStack(alignment: .trailing, spacing: 2) {
          Text(T("你的 Coinbase 钱包", "Your Coinbase wallet")).font(.subheadline.weight(.semibold))
          Text(T("用 Coinbase 登录的那个", "the one you sign in to with Coinbase")).font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("withdraw.toHint")
          if let q { OwnAddress(address: q.to, id: "withdraw.toAddr", copyable: false) }
        }.accessibilityIdentifier("withdraw.to")
      }
      Divider()
      if let c = chainTotal {
        row(T("余额核对（手机自己查）", "Balance check (by this iPhone)")) { Text(AnswerRules.format(c) + " USDC").font(.subheadline.monospacedDigit()).accessibilityIdentifier("withdraw.chainTotal") }
        Divider()
      }
      row(T("网络手续费", "Network fee")) { Text(q?.fee.map { T("约 \(AnswerRules.format($0)) USDC", "about \(AnswerRules.format($0)) USDC") } ?? T("确认时显示", "shown when you confirm")).font(.subheadline).accessibilityIdentifier("withdraw.fee") }
      if let f = q?.fee, let c = chosen, c > 0 {
        Divider()
        row(T("预计到账", "You receive")) { Text(T("约 ", "about ") + AnswerRules.format(WithdrawAmount.net(amount: c, fee: f)) + " USDC").font(.subheadline.weight(.semibold).monospacedDigit()).accessibilityIdentifier("withdraw.net") }
      }
    }.card()
    Text(T("钱只回到你自己的 Coinbase 账户。网络费用 USDC 从启付钱包里扣，Kipurse 不出这笔钱，也不收费。", "Money goes back only to your own Coinbase account. The network fee is paid in USDC from your Kipurse wallet; Kipurse pays none of it and charges nothing.") + T("\n平时提现都用这一页。手机丢了、登不上启付或已删除账户时，按「设置 › 手机丢了怎么办」里的步骤，用别的设备和 Coinbase 取回钱。", "\nUse this page for all everyday withdrawals. If your phone is lost, you cannot sign in to Kipurse or you deleted your account, follow Settings › Lost your phone? to recover with another device and Coinbase.")).font(.footnote).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("withdraw.plain")
    DisclosureGroup(T("详情", "Details")) { Text(T("钱只会回到你自己的 Coinbase 钱包，谁都改不了。提现不收启付服务费（启付的 0.1% 服务费只在每笔付款时收，付款前会显示）。网络手续费按实际成本，用 USDC 从启付钱包余额扣（和提现同一次确认），启付不加价，永远不用 ETH。AI 暂停或到期后也能取。", "It can only go to your own Coinbase wallet; nobody can change that. Withdrawing has no Kipurse service fee (Kipurse’s 0.1% service fee applies only to payments and is shown before each one). The network fee is the actual cost, paid in USDC from your Kipurse wallet balance in the same confirmation, with no markup, never ETH. Works even if AI is paused, expired or revoked.")).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }.font(.footnote).accessibilityIdentifier("withdraw.details")
    if let q, q.reserve > 0, chosen == q.amount {
      Text(T("提现金额里有 \(AnswerRules.format(q.reserve)) USDC 是付手续费用的零钱，也一起提现。", "The amount includes \(AnswerRules.format(q.reserve)) USDC set aside for network fees; it is withdrawn too."))
        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("withdraw.reserve")
    }
    switch phase {
    case .empty: WarnBox(text: T("钱包里没有钱，不需要提现。", "There's nothing in the wallet to withdraw."), tone: Brand.positive, icon: "checkmark.circle.fill")
    case .failed(let e): ErrorText(text: e)
    case .waiting: HStack(spacing: 10) { ProgressView(); Text(T("在 Coinbase 窗口里点确认，完成后会自动回到这里…", "Tap Confirm in the Coinbase window; you'll come back here automatically…")).font(.subheadline) }.accessibilityIdentifier("withdraw.waiting")
    default: EmptyView()
    }
    BigButton(T("提现到我的 Coinbase 钱包", "Withdraw to my Coinbase wallet"), icon: "arrow.down.circle.fill", disabled: q == nil || chosen == nil || phase == .empty || phase == .waiting) { ask = true }
      .accessibilityIdentifier("withdraw.go")
    if case .failed = phase { BigButton(T("再试一次", "Try again"), kind: .secondary) { Task { await load() } }.accessibilityIdentifier("withdraw.retry") }
  }
  private func doneView(_ a: Int64) -> some View {
    VStack(spacing: 14) {
      Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(Brand.positive).padding(.top, 30)
      Text(T("已提现", "Done")).font(.title.bold()).accessibilityIdentifier("withdraw.done")
      Text(AnswerRules.format(a) + " USDC").font(Brand.money(30, .semibold)).accessibilityIdentifier("withdraw.doneAmount")
      Text(T("已经到了你的 Coinbase 钱包。在 Base App 里，或 Coinbase 网页 keys.coinbase.com 用同一个账户登录就能看到（Coinbase App 的交易账户里不会显示）。", "It's in your Coinbase wallet. Sign in with the same account in the Base App or at keys.coinbase.com to see it (it won't show in your Coinbase exchange account)."))
        .multilineTextAlignment(.center).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }.frame(maxWidth: .infinity)
  }
  private func row<V: View>(_ k: String, @ViewBuilder _ v: () -> V) -> some View { HStack(alignment: .center) { Text(k).foregroundStyle(.secondary); Spacer(); v() }.padding(.vertical, 12) }

  static func post(_ base: URL, _ path: String, _ body: [String: Any] = [:]) async throws -> (Int, [String: Any]) {
    var r = URLRequest(url: base.appendingPathComponent(path)); r.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); r.httpMethod = "POST"; r.timeoutInterval = 30
    r.setValue("application/json", forHTTPHeaderField: "Content-Type"); r.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (d, resp) = try await URLSession.shared.data(for: r)
    return ((resp as? HTTPURLResponse)?.statusCode ?? 0, ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any]) ?? [:])
  }
  private func parse(_ j: [String: Any]) -> Quote? {
    guard let to = j["to"] as? String, let w = j["wallet"] as? String, let a = Int64(j["amount"] as? String ?? "") else { return nil }
    return Quote(amount: a, inWallet: Int64(j["inWallet"] as? String ?? "") ?? a, reserve: Int64(j["reserve"] as? String ?? "") ?? 0, to: to, vault: j["vault"] as? String, fee: Int64(j["feeUsdc"] as? String ?? ""), wallet: w)
  }
  /// The account the phone itself knows; if it doesn't know one yet, the server's answer is only accepted because the server
  /// re-checks it on chain (isOwnerAddress) — and the phone still rebuilds the whole batch for exactly that account.
  private var knownOwner: String? { WithdrawTarget.owner ?? Operator.ownerAccount }
  private func load() async {
    if case .done = phase { return }
    phase = .loading
    if let d = m.demoWithdraw { q = d; if amountText.isEmpty { amountText = allLabel }; phase = d.amount == 0 ? .empty : .ready; return }
    guard let (c, j) = try? await Self.post(server, "owner/withdraw/quote") else { phase = .failed(T("连不上网络，请稍后再试。", "Can't connect. Please try again.")); return }
    guard c == 200, let x = parse(j) else { phase = .failed((j["error"] as? String) == "owner_mismatch" ? T("链上的钱包主人和登记的不一致，为了安全已停止。", "The wallet's owner on chain doesn't match the registered one, so this was stopped for safety.") : T("暂时取不了，请稍后再试。", "Can't withdraw right now. Try again later.")); return }
    if let w = s.wallet, w.lowercased() != x.wallet.lowercased() { phase = .failed(T("这不是你的钱包，已停止。", "That isn't your wallet. Stopped.")); return }
    if let own = knownOwner, own.lowercased() != x.to.lowercased() { phase = .failed(T("收款账户和你的 Coinbase 钱包不一致，已停止。", "The destination isn't your Coinbase wallet. Stopped.")); return }
    // t784: the phone checks the chain itself before showing anything to sign (never trusts the server's numbers alone)
    if m.demoWithdraw == nil {
      let stopped = T("为了安全先停下了，没有转出任何钱，也没有扣费。", "Paused for safety. Nothing was sent or charged.")
      if knownOwner == nil, await VaultCheck.isOwner(wallet: x.wallet, address: x.to) != true { phase = .failed(T("没能在链上确认收款账户是这个钱包的主人。", "Couldn't confirm on-chain that the destination owns this wallet. ") + stopped); return }
      var vault: String? = nil
      if let v = x.vault {
        if VaultCheck.problem(server: v, chain: await VaultCheck.fetch(wallet: x.wallet)) != nil { phase = .failed(T("启付钱包地址和链上记录对不上。", "The vault address doesn't match the chain. ") + stopped); return }
        vault = v
      }
      // t1266 (fix 12): balances from two public nodes that agree (VaultCheck.usdcBalanceAgreed)
      var total: Int64? = await VaultCheck.usdcBalanceAgreed(x.wallet)
      if let v = vault, let t = total { if let b = await VaultCheck.usdcBalanceAgreed(v) { total = t + b } else { total = nil } }
      chainTotal = total
      if VaultCheck.withdrawProblem(planAmount: x.amount, onchainTotal: total) != nil { phase = .failed(T("要提现的金额和钱包余额对不上（或暂时读不到余额）。", "The amount doesn't match the on-chain balance (or it couldn't be read). ") + stopped); return }
    }
    q = x; if amountText.isEmpty { amountText = allLabel }; phase = x.amount == 0 ? .empty : .ready
  }
  private func go() async {
    guard let q0 = q, let amt = chosen, amt > 0 else { return }   // t1116u: exactly the amount the user just confirmed
    var skip = false
    #if DEBUG && targetEnvironment(simulator)
    skip = m.demoWithdraw != nil && ProcessInfo.processInfo.arguments.contains("-kpSkipFaceID")   // UI tests only
    #endif
    if !skip { guard await SafetyPanel.faceID(T("提现到你的 Coinbase 钱包", "Withdraw to your Coinbase wallet")) else { return } }
    if m.demoWithdraw != nil { phase = .waiting; try? await Task.sleep(nanoseconds: 800_000_000); Haptics.success(); phase = .done(amt); return }
    guard let (c, pl) = try? await Self.post(server, "owner/withdraw/prepare", ["amount": String(amt)]), c == 200, let id = pl["id"] as? String,
          let owner = pl["owner"] as? String, let w = pl["wallet"] as? String, let a = UInt64(pl["amount"] as? String ?? ""),
          let calls = (pl["calls"] as? [[String: Any]])?.map({ $0.compactMapValues { $0 as? String } }) else { phase = .failed(T("准备失败，请再试一次。", "Couldn't prepare it. Please try again.")); return }
    // t1116u: the plan must be for EXACTLY the confirmed amount (replaces the old "≥ 90% of the full balance" heuristic)
    guard WithdrawAmount.preparedMatches(prepared: a, confirmed: amt) else { phase = .failed(T("提现金额和你刚才确认的不一样，已停止，没有转出任何钱。", "The amount isn't the one you just confirmed. Stopped; nothing was sent.")); return }
    // RequestVerify: rebuild the batch on the phone and refuse anything that isn't "this amount → my own account"
    let mine = knownOwner ?? q0.to
    // t1266 (fix 12): the plan's wallet must be THIS phone's verified wallet (and the shown one)
    let mineW = Operator.wallet.isEmpty ? s.wallet : Operator.wallet   // after deleting the account: the in-memory snapshot of the verified wallet
    if mineW == nil || mineW?.lowercased() != w.lowercased() || (s.wallet.map { $0.lowercased() != w.lowercased() } ?? false) { phase = .failed(T("这不是你的钱包，已停止。", "That isn't your wallet. Stopped.")); return }
    if let e = OwnerExit.verifyAnyPlan(calls: calls, wallet: w, owner: mine, planOwner: owner, vault: pl["vault"] as? String, amount: UInt64(amt)) {   // t789: plain or wallet-pays (fee <= 0.25 USDC to the fixed Kipurse address), decoded on the phone
      phase = .failed(T("提现内容和你的账户对不上（\(e.rawValue)），已停止，没有转出任何钱。", "The withdrawal doesn't match your account (\(e.rawValue)). Stopped; nothing was sent.")); return }
    if m.demoWithdraw == nil, let ct = chainTotal, Int64(a) > ct { phase = .failed(T("提现金额超过了钱包余额，已停止，没有转出任何钱。", "The amount is more than the on-chain balance. Stopped; nothing was sent.")); return }
    if Operator.ownerAccount == nil, WithdrawTarget.owner == nil { WithdrawTarget.owner = mine }
    planId = id; phase = .waiting
    var u = URLComponents(url: server.appendingPathComponent("owner/withdraw"), resolvingAgainstBaseURL: false)!; u.queryItems = [URLQueryItem(name: "plan", value: id)]
    guard let wu = u.url, let cu = BatchVerify.committedURL(wu, chainId: (pl["chainId"] as? Int) ?? Int(pl["chainId"] as? String ?? "") ?? 8453, from: owner, calls: calls) else { phase = .failed(T("准备失败，请再试一次。", "Couldn't prepare it. Please try again.")); return }
    let srv = server, sheet = WebSheet(url: cu); page = sheet
    poll?.cancel()
    poll = Task { @MainActor in
      var after = 0
      for _ in 0..<200 {
        try? await Task.sleep(nanoseconds: 3_000_000_000); if Task.isCancelled { return }
        if let (c, j) = try? await Self.post(srv, "owner/withdraw/confirm", ["id": id]), c == 200, (j["ok"] as? Bool) == true {
          page = nil; Haptics.success(); phase = .done(Int64(j["amount"] as? String ?? "") ?? Int64(a)); await m.refresh(); return }
        if page?.id != sheet.id { after += 1; if after > 20 { break } }   // closed: the transfer may still be landing, check ~1 min
      }
      if phase == .waiting { phase = .ready }
    }
  }
}

// MARK: - Wallet discovery: the server says which wallet this phone key belongs to (no wallet is compiled into the app).
enum WalletDiscovery {
  static func find(key: SecKey, reusesUnlock: Bool) async throws {
    let c = try await post(Mainnet.base, "phone/find/challenge", [:])
    guard let nonce = c["nonce"] as? String, Mainnet.validNonce(nonce), let (x, y) = PhoneKey.xy(key) else { throw MainnetSession.Failure.server(L("服务器回应不对")) }
    let d = Mainnet.findDigest(nonce: nonce)
    guard (c["digest"] as? String)?.lowercased() == Hex.encode(d).lowercased() else { throw MainnetSession.Failure.server(L("服务器回应不对")) }
    if !reusesUnlock { await FaceIDUnlock.ensure() }   // t1255 §6#124: Face ID locked by iOS -> passcode unlocks Face ID only (approves nothing)
    let (r, s) = try PhoneKey.sign(d, key: key, reusesUnlock: reusesUnlock)
    let j = try await post(Mainnet.base, "phone/find", ["nonce": nonce, "x": Hex.encode(x), "y": Hex.encode(y), "r": Hex.encode(r), "s": Hex.encode(s)])
    guard let w = j["wallet"] as? String, w.count == 42, w.hasPrefix("0x") else { throw MainnetSession.Failure.server(L("没有找到这台手机的钱包")) }
    // t1266 (fix 4): never take the server's word for the wallet. Two public Base nodes must agree that the owner this phone signed in as
    // owns it and that THIS phone's key is its approver / key seat (or it is the address the factory gives that owner).
    let known = UserDefaults.standard.string(forKey: CoinbaseIdentity.ownerKey).flatMap { CoinbaseIdentity.isAddress($0) ? $0 : nil }
    guard let owner = (j["owner"] as? String) ?? known, CoinbaseIdentity.isAddress(owner),
          await WalletVerify.confirmed(wallet: w, owner: owner, knownOwner: known, x: x, y: y, approverHints: [j["approver"], j["seat"]].compactMap { $0 as? String }) else {
      AuthLog.note("find", "wallet not confirmed on chain"); throw MainnetSession.Failure.server(T("没能在链上确认这个钱包属于你，已停止。你的钱没有任何变化。", "Couldn't confirm on chain that this wallet is yours. Stopped; your money is unchanged.")) }
    let path = j["path"] as? String
    Operator.setWallet(w, owner: owner, path: path == nil || path?.lowercased() == "/t/" + w.lowercased() ? path : "/t/" + w.lowercased())
  }
  static func post(_ base: URL, _ path: String, _ body: [String: Any]) async throws -> [String: Any] {
    var r = URLRequest(url: base.appendingPathComponent(path)); r.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "content-type")
    r.httpBody = try JSONSerialization.data(withJSONObject: body); let (d, resp) = try await URLSession.shared.data(for: r)
    let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    if let h = resp as? HTTPURLResponse, h.statusCode >= 400 { throw NSError(domain: "kipurse", code: h.statusCode, userInfo: [NSLocalizedDescriptionKey: h.statusCode == 404 ? L("没有找到这台手机的钱包") : ServerText.text(code: j["error"] as? String, status: h.statusCode)]) }
    return j
  }
}

// MARK: - 开通 (0A/0B): deposit opens account; user pays ~0.05 USDC fee same-tx; NO Face ID at open; limits optional/auto; ONE Coinbase confirmation.
enum OnboardAPI {
  static var server: URL {
    #if DEBUG
    if let s = UserDefaults.standard.string(forKey: "kpOnboardServer"), let u = URL(string: s) { return u }
    #endif
    return Operator.wallet.isEmpty ? Mainnet.base : Mainnet.server
  }
  /// New user (no wallet yet): the global find-or-create endpoints; known wallet: that wallet's own re-setup endpoints.
  static var isNew: Bool { Operator.wallet.isEmpty }
  /// Off in production until the operator sets KipurseOnboard = YES; DEBUG test runs turn it on with -kpOnboard.
  static var on: Bool {
    #if DEBUG
    if CommandLine.arguments.contains("-kpOnboard") { return true }
    #endif
    return Onboard.enabled
  }
  /// t769u: calm Chinese reasons for every onboarding server error; never show raw English server text.
  static func friendly(_ code: String?, _ status: Int) -> String {
    switch code ?? "" {
    case "not_verified": return T("这个 Coinbase 账户还没有 Coinbase 实名认证证明。请打开 Coinbase 官方验证页 coinbase.com/onchain-verify，用 Coinbase 登录，点 Get verified，连接你登录启付用的同一个钱包，签一次（不花钱）的验证，然后回来重试。没有扣任何钱。", "This Coinbase account doesn't have Coinbase's verified-account proof yet. Open Coinbase's official page coinbase.com/onchain-verify, sign in with Coinbase, tap Get verified, connect the same wallet you use for Kipurse, sign the verification (no charge), then come back and try again. Nothing was charged.")
    case "verify_unavailable": return T("暂时查不到 Coinbase 认证状态，没有扣任何钱。请稍后再试。", "Coinbase verification status can't be checked right now. Nothing was charged. Please try again later.")
    case "rate_limited": return T("操作太频繁了，请等一会儿再试。没有扣任何钱。", "Too many tries. Please wait a moment and try again. Nothing was charged.")
    case "onboard_disabled": return T("开通功能暂时关闭，你的钱包和资金没有变化。请稍后再试。", "Setup is paused for now. Your wallet and funds are unchanged. Please try again later.")
    case "app_attest_required": return T("请用 App Store 上的正版启付 App 开通。没有扣任何钱。", "Please use the official Kipurse app from the App Store. Nothing was charged.")
    default: return T("这一步没有完成，没有扣任何钱。请稍后再试（代码 \(code ?? String(status))）。", "This step didn't finish and nothing was charged. Please try again later (code \(code ?? String(status))).")
    }
  }
  static func decode(_ d: Data, _ r: URLResponse) throws -> JSONValue {
    let j = (try? JSONDecoder().decode(JSONValue.self, from: d)) ?? .null
    if let h = r as? HTTPURLResponse, h.statusCode >= 400 { throw NSError(domain: "kipurse", code: h.statusCode, userInfo: [NSLocalizedDescriptionKey: friendly(j["error"]?.string, h.statusCode)]) }
    return j
  }
  static func get(_ p: String, owner: String? = nil) async throws -> JSONValue {
    var u = server.appendingPathComponent(p)
    if let owner, var c = URLComponents(url: u, resolvingAgainstBaseURL: false) { c.queryItems = [.init(name: "owner", value: owner)]; if let cu = c.url { u = cu } }
    let (d, r) = try await URLSession.shared.data(from: u); return try decode(d, r) }
  static func post(_ p: String, _ b: [String: Any]) async throws -> JSONValue {
    var q = URLRequest(url: server.appendingPathComponent(p)); q.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); q.httpMethod = "POST"; q.setValue("application/json", forHTTPHeaderField: "content-type")
    q.httpBody = try JSONSerialization.data(withJSONObject: b); let (d, r) = try await URLSession.shared.data(for: q); return try decode(d, r)
  }
  /// The phone key: Secure Enclave on a device. The simulator has no Secure Enclave, so DEBUG simulator runs use a throwaway software key.
  static func key() throws -> ([UInt8], [UInt8]) {
    #if targetEnvironment(simulator) && DEBUG
    let r = [UInt8](P256.Signing.PrivateKey().publicKey.x963Representation); return (Array(r[1..<33]), Array(r[33..<65]))
    #else
    let k = try PhoneKey.create(); guard let xy = PhoneKey.xy(k) else { throw NSError(domain: "kipurse", code: 1, userInfo: [NSLocalizedDescriptionKey: L("读不到这台手机的密钥")]) }; return xy
    #endif
  }
}

@MainActor final class OnboardFlow: ObservableObject {
  enum Phase: Equatable { case form, starting, signing, done(siri: Bool) }
  @Published var phase: Phase = .form; @Published var quote: Onboard.Quote?; @Published var err: String?; @Published var fingerprint: String?; @Published var fpMismatch: String?; @Published var removes = 0; @Published var laterChangeUSDC: String?
  func loadQuote() async { do { let owner = UserDefaults.standard.string(forKey: CoinbaseIdentity.ownerKey).flatMap { CoinbaseIdentity.isAddress($0) ? $0 : nil }
    let qj = try await OnboardAPI.get(OnboardAPI.isNew ? "onboard/new/quote" : "onboard/quote", owner: OnboardAPI.isNew ? owner : nil)
    quote = Onboard.Quote(qj); laterChangeUSDC = qj["limitsChangeUSDC"]?.string; if quote == nil { err = L("读不到手续费") } } catch { err = error.localizedDescription } }
  func start(_ m: AppModel, single: String, daily: String, term: String, days: String, deposit: String = "") async {
    err = nil; phase = .starting
    do {
      let (x, y) = try OnboardAPI.key(); fingerprint = PhoneTrust.fingerprint(x: x, y: y)
      var sb: [String: Any] = Onboard.startBody(x: x, y: y, single: single, daily: daily, term: term, days: days, owner: UserDefaults.standard.string(forKey: CoinbaseIdentity.ownerKey))
      if OnboardAPI.isNew, let att = await AppAttest.attest(x: Hex.encode(x), y: Hex.encode(y)) { sb["attest"] = att }   // genuine-app proof (t629)
      let r = try await OnboardAPI.post(OnboardAPI.isNew ? "onboard/new/start" : "onboard/start", sb)
      guard let id = r["id"]?.string, let u = r["url"]?.string.flatMap(URL.init(string:)) else { throw NSError(domain: "kipurse", code: 2, userInfo: [NSLocalizedDescriptionKey: L("服务器没有返回确认页")]) }
      // t1266 (fix 2): the page must be a Kipurse signing page (https, no port, the Kipurse API host, a known signing path)
      guard SignHost.signingPage(u, serverHost: Mainnet.base.host) != nil else { throw NSError(domain: "kipurse", code: 2, userInfo: [NSLocalizedDescriptionKey: T("服务器给的确认页不对，已停止，没有扣钱。", "The server's confirmation page isn't right. Stopped; nothing charged.")]) }
      if case .array(let a)? = r["removes"] { removes = a.count }
      if let sfp = r["fingerprint"]?.string, sfp != fingerprint { fpMismatch = sfp; throw NSError(domain: "kipurse", code: 3, userInfo: [NSLocalizedDescriptionKey: T("安全检查没通过：服务器发来的内容和这台 iPhone 的不一样。已停止，没有扣钱。", "Safety check failed: the server's data doesn't match this iPhone. Stopped; nothing charged.")]) }
      // t621 #1: the phone decodes the exact batch first and commits to it (#vh); the signing page refuses anything else.
      let (url, verifiedW, verifiedO) = try await Self.verifiedPage(u, id: id, start: r, x: x, y: y, single: single, daily: daily, term: term, days: days, deposit: deposit)
      phase = .signing
      m.openOwnerPage(url) { [weak self] mm in
        guard let j = try? await OnboardAPI.post("onboard/confirm", ["id": id]), j["ok"]?.bool == true else { return false }
        // t1275: only the wallet this phone checked itself, with the owner this phone holds (never the server's "owner" field)
        if let w = j["wallet"]?.string, w.count == 42, let vw = verifiedW, vw.lowercased() == w.lowercased() { Operator.setWallet(w, owner: verifiedO, path: "/t/" + w.lowercased()) }
        mm.webSheet = nil; Haptics.success(); self?.phase = .done(siri: j["siri"]?.bool ?? false); return true
      }
    } catch { err = error.localizedDescription; phase = .form }
  }
}

extension OnboardFlow {
  static func stop(_ msg: String) -> NSError { NSError(domain: "kipurse", code: 4, userInfo: [NSLocalizedDescriptionKey: msg]) }
  /// Returns the signing-page URL with the commitment, the wallet the phone itself checked (nil for the simulator mock), and the owner the
  /// phone itself holds (t1275: the SIWE-verified sign-in owner, or the stored owner of the known wallet; never a server field).
  static func verifiedPage(_ u: URL, id: String, start r: JSONValue, x: [UInt8], y: [UInt8], single: String, daily: String, term: String, days: String, deposit: String = "") async throws -> (URL, String?, String?) {
    #if DEBUG
    if UserDefaults.standard.string(forKey: "kpOnboardServer") != nil { return (u, nil, nil) }   // UI tests: local simulator mock, no real batch
    #endif
    let choice = RequestVerify.Choice(single: String(AnswerRules.parseUSDC(single) ?? 0), daily: String(AnswerRules.parseUSDC(daily) ?? 0), term: String(AnswerRules.parseUSDC(term) ?? 0), days: Int(days))
    let bad = { (p: [String]) in stop(T("手机检查发现开通内容和你选的不一致，已停止，没有扣钱：", "This iPhone found a mismatch in the setup. Stopped; nothing charged: ") + p.joined(separator: "; ")) }
    var owner: String, wallet: String, calls: [[String: Any]], chain = 8453, newWallet: Bool, vault: String? = nil, heldOwner: String?
    if OnboardAPI.isNew {
      guard let o = UserDefaults.standard.string(forKey: CoinbaseIdentity.ownerKey), CoinbaseIdentity.isAddress(o) else { throw stop(T("请先用 Coinbase 登录。", "Please sign in with Coinbase first.")) }
      var body: [String: Any] = ["id": id, "owner": o, "features": [String]()]   // t1008u: no dues slot (no new dues)
      if let d = Onboard.depositAtomic(deposit) { body["deposit"] = String(d) }
      let p = try await OnboardAPI.post("onboard/new/prepare", body)
      guard let c = BatchVerify.calls(p["calls"]), let w = p["wallet"]?.string else { throw stop(T("服务器回应不对，没有打开确认页。", "Unexpected server reply. Nothing to sign.")) }
      if let po = p["owner"]?.string, po.lowercased() != o.lowercased() { throw bad(["owner"]) }
      owner = o; wallet = w; calls = c; chain = BatchVerify.chainId(p["chainId"]) ?? 8453; newWallet = !(p["existing"]?.bool ?? false); vault = p["vault"]?.string; heldOwner = o
    } else {
      guard let c = BatchVerify.calls(r["calls"]), let o = Operator.ownerAccount ?? r["owner"]?.string else { throw stop(T("服务器回应不对，没有打开确认页。", "Unexpected server reply. Nothing to sign.")) }
      owner = o; wallet = Operator.wallet; calls = c; chain = BatchVerify.chainId(r["chainId"]) ?? 8453; newWallet = false; heldOwner = Operator.ownerAccount
    }
    // t1197u (§6#92): new wallets open on V5.3, older ones stay V5.2. The suite is the one whose vault (computed on this phone) is the
    // server's vault; the chain must agree (adapter.vaultAddress), and every step is then checked against THAT suite only.
    let suite = KipurseSuite.forVault(vault, wallet: wallet) ?? KipurseSuite.active   // vault is only set for a new Kipurse opening
    if let sv = vault, let pr = VaultCheck.problem(server: sv, chain: await VaultCheck.fetch(adapter: suite.adapter, wallet: wallet)) { throw bad([pr]) }
    let rep = BatchVerify.setup(calls: calls, wallet: wallet, owner: owner, x: x, y: y, choice: choice, newWallet: newWallet, vault: vault, suite: suite)
    // option A: the deposit inside the batch must be exactly what the user chose (or none when the server is on the old route)
    let ugs = UsdcGas.split(calls, wallet: wallet, vault: vault); if !ugs.problems.isEmpty { throw bad(ugs.problems) }; if newWallet && ugs.feeRepaid == 0 && ugs.approved == 0 { throw bad([T("开通必须在这次确认里用 USDC 付手续费", "Opening must pay the network fee in USDC in this confirmation")]) }; if ugs.deposit != 0, ugs.deposit != (Onboard.depositAtomic(deposit) ?? 0) { throw bad([T("充值金额和你选的不一致", "deposit amount differs from what you chose")]) }
    guard rep.ok else { throw bad(rep.problems) }
    if vault != nil { KipurseSuite.remember(suite, wallet: wallet) }
    guard let cu = BatchVerify.committedURL(u, chainId: chain, from: owner, calls: calls) else { throw bad(["commit"]) }
    return (cu, wallet, heldOwner)
  }
}

/// 开通: one screen, one fee page, one signature.
struct OnboardView: View {
  @EnvironmentObject var m: AppModel
  @StateObject private var f = OnboardFlow()
  @StateObject private var cbv = CBVerifyModel()
  @State private var single = ""; @State private var daily = ""; @State private var term = ""; @State private var days = "90"; @State private var deposit = ""   // t603u: no preset limits; t1008u: deposit = opening
  var limitsErr: String? { Mainnet.limitsError(single: single, daily: daily, term: term, days: days) }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: KP.Space.cardGap) {
        if case .done(let siri) = f.phase { done(siri) }
        else if CBVerifyModel.applies && cbv.status != .verified { CBVerifyGuide(v: cbv) }   // t624u: new wallets need Coinbase's on-chain verification (server re-checks)
        else { form }
      }.padding(20)
    }.background(Brand.canvas).amountKeyboardToolbar().navigationTitle(L("开通")).navigationBarTitleDisplayMode(.inline)
    .task { await f.loadQuote() }
    .task { if CBVerifyModel.applies { await cbv.check() } }
  }
  @ViewBuilder var form: some View {
    // t1024u + 0B: deposit opens the account first; one fee sentence; limits are secondary (also changeable after). No Face ID.
    Text(T("充值开户", "Deposit to open")).font(.title2.bold()).accessibilityIdentifier("onboard.step1")
    Text(T("选一个金额，在 Coinbase 里确认一次就开好。", "Pick an amount and confirm once in Coinbase.")).font(.subheadline).foregroundStyle(.secondary)
    AmountPicker(title: T("充值金额", "Deposit"), presets: ["1", "5", "10", "50", "100"], unit: "USDC", value: $deposit).card(padding: 18).accessibilityIdentifier("onboard.deposit")
    Text(Onboard.feeNote(quoted: f.quote?.feeUSDC, seed: f.quote?.vaultSeed)).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("onboard.feeNote")
    Text(Onboard.minBaseNote(quoted: f.quote?.feeUSDC, deposit: deposit, seed: f.quote?.vaultSeed)).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("onboard.minBase")   // t1113u: one added line, existing footnote style
    Text(T("钱包安全上限（每笔、每天、总额都要填；开户后也能改）", "Wallet safety limits (fill in all three; you can change them later)")).font(.headline).padding(.top, 8)
    GuidedSetupCard(single: $single, daily: $daily, term: $term, days: $days)
    DisclosureGroup(T("自己填", "Enter manually")) {
      AmountPicker(title: L("每笔最多"), presets: ["1", "2", "5", "10", "100", "1000"], unit: "USDC", showFooter: false, value: $single).padding(.top, 8)
      AmountPicker(title: L("每天最多"), presets: ["5", "20", "50", "100", "1000", "10000"], unit: "USDC", showFooter: false, value: $daily)
      AmountPicker(title: L("总额最多"), presets: ["100", "200", "500", "1000"], unit: "USDC", showFooter: false, value: $term)
      AmountPicker(title: L("有效期"), presets: ["30", "90", "180", "365"], unit: L("天"), isDays: true, value: $days)
    }.accessibilityIdentifier("onboard.manual")
    if let e = limitsErr ?? f.err { WarnBox(text: e, tone: Brand.caution, icon: "info.circle.fill") }
    BigButton(f.phase == .starting ? T("正在准备…", "Preparing…") : T("充值并开通", "Deposit and open"), icon: "arrow.down.circle.fill", disabled: !Onboard.canOpen(quote: f.quote, starting: f.phase == .starting, deposit: deposit, limitsError: limitsErr)) {
      // t1113u (§6#59, supersedes 0B.3 "limits never block opening"): no silent default plan; the user's own three limits go into the one opening batch.
      guard limitsErr == nil else { return }
      Task { await f.start(m, single: single, daily: daily, term: term, days: days, deposit: deposit) }
    }.accessibilityIdentifier("onboard.go")
    if f.phase == .signing, f.fingerprint != nil {
      VStack(alignment: .leading, spacing: 6) {
        Label(T("请在 Coinbase 里确认", "Confirm in Coinbase"), systemImage: "checkmark.shield").font(.headline).foregroundStyle(Brand.positive).accessibilityIdentifier("onboard.fpOK")
        Text(Onboard.feeNote(quoted: f.quote?.feeUSDC, seed: f.quote?.vaultSeed)).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("onboard.confirmFeeNote")
      }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 16)
    }
  }
  @ViewBuilder var feeCard: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack { Text(T("开户网络费", "Account opening network fee")).font(.headline); Spacer()
        Text(f.quote.map { "≈ \($0.feeUSDC) USDC" } ?? "…").font(.headline.monospacedDigit()).accessibilityIdentifier("onboard.fee") }
      // t1008u/t1018u/t1019u/t1022u LOCKED: the user pays the ~0.05 USDC opening fee from the Coinbase wallet balance in the same confirmation as the deposit. Kipurse pays nothing.
      Text(Onboard.feeNote(quoted: f.quote?.feeUSDC, seed: f.quote?.vaultSeed)).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("onboard.feeNote")
      if let q = f.quote, !q.sponsored, !q.userPaysUSDC { Label(T("今天开户名额已满，你的 Coinbase 账户没有任何变化。请明天再试。", "Today's account openings are full. Nothing changed in your Coinbase account. Please try again tomorrow."), systemImage: "clock").font(.footnote).foregroundStyle(Brand.caution) }
      Text(f.laterChangeUSDC.map { T("以后每次修改上限：按实际手续费，现在约 \($0) USDC，用 USDC 付，0 加价，永远不用 ETH。", "Each later limit change: the actual network fee, now about \($0) USDC, paid in USDC at 0% markup. Never ETH.") } ?? T("以后每次修改上限：按实际手续费用 USDC 付，0 加价，永远不用 ETH。", "Each later limit change: the actual network fee in USDC, 0% markup. Never ETH.")).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("onboard.laterFee")
    }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 16)
  }
  @ViewBuilder func done(_ siri: Bool) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(L("已开通"), systemImage: "checkmark.seal.fill").font(.title2.bold()).foregroundStyle(Brand.positive).accessibilityIdentifier("onboard.done")
      Label(L("AI 上限：每笔 \(single) · 每天 \(daily) · 总额 \(term) USDC"), systemImage: "gauge.with.dots.needle.33percent")
      Label(Onboard.feeNote(quoted: f.quote?.feeUSDC, seed: f.quote?.vaultSeed), systemImage: "info.circle").font(.footnote)
      Text(T("下一步：钱包安全上限在钱包页、AI 花钱上限在 AI 生活页，随时可以改；然后逐个连接 AI。", "Next: wallet safety limits are on the Wallet tab and AI spending limits on the AI Life tab; change them any time. Then connect your AIs one by one.")).font(.footnote).foregroundStyle(.secondary).accessibilityIdentifier("onboard.next")
    }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 18)
    BigButton(T("进入我的钱包", "Go to my wallet"), icon: "wallet.pass") {   // t1004u: lands in the wallet home; no Face ID setup step
      m.identityVerified(); Task { await m.enterWalletWithoutFaceID() }
    }.accessibilityIdentifier("onboard.open")
  }
}

/// Real per-change fee from the server (/owner/limits/fee): actual network cost in USDC, 0% markup, first authorization free.
struct LimitsFee: Equatable { let usdcText: String; let firstFree: Bool; let fromWallet: Bool
  static func load() async -> LimitsFee? {
    guard let (d, resp) = try? await URLSession.shared.data(from: Mainnet.server.appendingPathComponent("owner/limits/fee")), (resp as? HTTPURLResponse)?.statusCode == 200,
          let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let t = j["usdcText"] as? String, (j["gasToken"] as? String) == Principles.gasToken else { return nil }
    return LimitsFee(usdcText: t, firstFree: (j["firstFree"] as? Bool) ?? false, fromWallet: (j["feeFrom"] as? String) == UsdcGas.feeFrom) }
  static func text(_ f: LimitsFee?) -> String {
    guard let f else { return T("手续费按实际成本用 USDC 付，0 加价，永远不用 ETH。", "Network fee: actual cost in USDC, 0% markup. Never ETH.") }
    if f.fromWallet { return T(UsdcGas.feeDialog(usdc: f.usdcText), "Changing the wallet safety limit needs a small network fee (about \(f.usdcText) USDC), taken from your Kipurse balance.") }
    return f.firstFree ? T("这是你第一次设置上限：这次不收手续费。以后每次修改约 \(f.usdcText) USDC（实际手续费），用 USDC 付，0 加价，永远不用 ETH。", "This is your first limit setup: there is no network fee this time. Each later change costs about \(f.usdcText) USDC (actual network fee), paid in USDC at 0% markup. Never ETH.")
      : T("这次修改的手续费约 \(f.usdcText) USDC（实际成本），从启付钱包余额扣，用 USDC 付，0 加价，永远不用 ETH。", "Network fee for this change: about \(f.usdcText) USDC (actual cost), paid in USDC from your Kipurse wallet balance at 0% markup. Never ETH.") }
}

// MARK: - Limits: the phone decodes the exact batch the server built and compares it with the user's choice BEFORE the signing page opens.
extension MainLimitsView {
  func verifyThenSign() async {
    guard let u0 = Mainnet.limitsURL(single: single, daily: daily, term: term, days: days),
          let sA = AnswerRules.parseUSDC(single), let dA = AnswerRules.parseUSDC(daily), let tA = AnswerRules.parseUSDC(term) else { return }
    let opsN = opsChange
    let choice = RequestVerify.Choice(single: String(sA), daily: String(dA), term: String(tA), days: Int(days), opsPerDay: opsN)
    #if DEBUG
    if UserDefaults.standard.string(forKey: "kpMockLimits") == "tampered" {   // UI test: a server that returns a batch for someone else's wallet
      let res = RequestVerify.limitsBatch(calls: [["to": "0x2000000000000000000000000000000000000004", "data": "0x34fcd5be"]], wallet: PhoneTrust.mainnetWallet, chainId: 8453, choice: choice, currentExecutor: nil)
      verifyErr = T("手机检查发现服务器给的内容和你选的不一致，已停止：", "This iPhone found a mismatch with what you chose. Stopped: ") + res.problems.joined(separator: "; "); return }
    #endif
    do {
      var r = URLRequest(url: Mainnet.server.appendingPathComponent("owner/limits/prepare")); r.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "content-type")
      var body: [String: Any] = ["single": String(sA), "daily": String(dA), "term": String(tA), "days": Int(days) ?? 0]
      if let n = opsN { body["opsPerDay"] = n }   // t1185u: only when the owner changed it
      r.httpBody = try JSONSerialization.data(withJSONObject: body)
      let (d, resp) = try await URLSession.shared.data(for: r)
      if (resp as? HTTPURLResponse)?.statusCode == 402 { let e = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]; let t = (e?["fee"] as? [String: Any])?["usdcText"] as? String ?? "?"
        let det = e?["detail"] as? [String: Any]; let code = e?["error"] as? String
        topupNeeded = code == "wallet_needs_topup"
        if code == UsdcGas.insufficientCode { verifyErr = T(UsdcGas.insufficientZH, "The Kipurse balance can't cover the network fee."); return }
        verifyErr = (det?["zh"] as? String).flatMap { z in (det?["en"] as? String).map { T(z, $0) } ?? z } ?? T("手续费约 \(t) USDC，用 USDC 付（永远不用 ETH）。现在 USDC 不够，已停止，没有扣钱。", "The network fee (about \(t) USDC) is paid in USDC (never ETH). There isn't enough USDC now, so nothing was sent or charged."); return }
      if let st = (resp as? HTTPURLResponse)?.statusCode, st != 200, let e = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let det = e["detail"] as? [String: Any], let z = det["zh"] as? String {
        verifyErr = T(z, (det["en"] as? String) ?? z); return }   // t1123u: server stopped (e.g. fee can't be taken from the wallet right now); nothing was charged
      guard let j = try JSONSerialization.jsonObject(with: d) as? [String: Any], let id = j["id"] as? String, let calls = j["calls"] as? [[String: Any]] else { verifyErr = T("服务器回应不对，没有打开确认页。", "Unexpected server reply. Nothing to sign."); return }
      let chain = (j["chainId"] as? Int) ?? Int(j["chainId"] as? String ?? "") ?? 0
      if let o = j["owner"] as? String, let own = Operator.ownerAccount, o.lowercased() != own.lowercased() { verifyErr = T("确认人不是你的 Coinbase 钱包，已停止。", "The signer isn't your Coinbase wallet. Stopped."); return }
      // t1123u (§6#63): only the wallet-fee batch is signed: [Kipurse wallet -> Kipurse fee address (< 0.01 USDC), your cap change], sent from
      // your Base Account (signs only). The paused relay / Pimlico approve / refund-to-you shapes are refused here, before any page opens.
      let rep = RequestVerify.limitsReply(j, wallet: PhoneTrust.mainnetWallet, owner: Operator.ownerAccount ?? (j["owner"] as? String), choice: choice)
      guard rep.result.ok, let from = rep.from else { verifyErr = T("手机检查发现服务器给的内容和你选的不一致，已停止：", "This iPhone found a mismatch with what you chose. Stopped: ") + rep.result.problems.joined(separator: "; "); return }
      var c = URLComponents(url: u0, resolvingAgainstBaseURL: false)!; c.queryItems = (c.queryItems ?? []) + [.init(name: "plan", value: id)]
      guard let u1 = c.url, !from.isEmpty, let u = BatchVerify.committedURL(u1, chainId: chain, from: from, calls: calls) else { verifyErr = T("服务器回应不对，没有打开确认页。", "Unexpected server reply. Nothing to sign."); return }
      m.openLimitsSigning(u)
    } catch { verifyErr = T("暂时连不上，请稍后再试。", "Can't connect right now. Try again later.") }
  }
}

/// Strong beginner warning on the deposit screen. Recovery wording matches what the deposit page really offers.
struct OnlyUSDCWarning: View {
  @State private var open = false
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button { withAnimation { open.toggle() } } label: { HStack { Label(T("转账前看一眼：选 USDC，网络选 Base", "Before you send: pick USDC, network Base"), systemImage: "info.circle").font(.subheadline.weight(.semibold)); Spacer(); Image(systemName: open ? "chevron.up" : "chevron.down").font(.caption) } }.foregroundStyle(.primary).accessibilityIdentifier("deposit.onlyUSDC.toggle")
      if open { Text(T("在 Coinbase 里发送时只选 USDC，不要选 USDT、ETH 或其他币。转错的币 AI 不能用。在 Base 网络上转错的 ETH、USDT、WETH、DAI、cbBTC 会显示在这里，可以一键退回你的 Coinbase 账户（手续费你自己付，一般不到 $0.01）。其他币，或选了别的网络（比如 Ethereum、Solana），启付没法帮你找回。", "When sending in Coinbase, choose USDC only, not USDT, ETH or any other coin. Your AI can’t use the wrong coin. ETH, USDT, WETH, DAI or cbBTC sent on Base by mistake will show up here and can be sent back to your Coinbase account in one tap (you pay the network fee, usually under $0.01). Other coins, or another network (like Ethereum or Solana), can’t be recovered by Kipurse.")).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
    }.frame(maxWidth: .infinity, alignment: .leading).padding(14).background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: KP.Radius.control)).accessibilityElement(children: .contain).accessibilityIdentifier("deposit.onlyUSDC")
  }
}

/// "Received 3.5 USDT …" with a one-tap return. The return itself happens on the deposit page (Coinbase popup, destination fixed
/// to the owner's own Coinbase account, he pays the fee); nothing is signed in the app.
struct StrayNotice: View {
  @EnvironmentObject var m: AppModel
  let wallet: String
  var body: some View {
    if !m.stray.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        Label(T("钱包里收到了不能用的币", "Your wallet received coins it can’t use"), systemImage: "exclamationmark.octagon.fill").font(.headline).foregroundStyle(.orange)
        ForEach(m.stray) { t in Text(WrongToken.notice(t)).font(.subheadline).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("stray.\(t.sym)") }
        BigButton(T("一键退回到我的 Coinbase 账户", "Send it back to my Coinbase account"), icon: "arrow.uturn.backward.circle.fill") {
          var c = URLComponents(url: Mainnet.base.appendingPathComponent("deposit"), resolvingAgainstBaseURL: false)!; c.queryItems = [URLQueryItem(name: "w", value: wallet)]
          if let u0 = c.url { let u = BatchVerify.depositURL(u0, wallet: wallet); m.openFreePage(u) { mm in if let s = mm.state { await mm.loadStray(s) }; return false } }
        }.accessibilityIdentifier("stray.return")
        Text(T("只能退回到你登录用的 Coinbase 账户。在 Coinbase 弹窗里确认，网络手续费由你自己的 Coinbase 账户付（一般不到 1 美分）。", "It can only go back to the Coinbase account you signed in with. Confirm in the Coinbase popup; your own Coinbase account pays the network fee (usually under 1 cent).")).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 16).accessibilityElement(children: .contain).accessibilityIdentifier("stray.card")
    }
  }
}

/// Tiny incoming transfers (< 0.01 USDC): collapsed by default, with a plain warning. They are never a payee source.
struct SuspiciousToggle: View {
  @EnvironmentObject var m: AppModel
  let rows: [LedgerRow]; let explorer: String
  @State private var open = false
  var body: some View {
    if !rows.isEmpty {
      VStack(alignment: .leading, spacing: 6) {
        Button { withAnimation { open.toggle() } } label: {
          HStack(spacing: 6) { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Brand.caution)
            Text(open ? T("收起可疑记录", "Hide suspicious records") : T("隐藏了 \(rows.count) 条可疑小额转账", "\(Beginner.plural(rows.count, "suspicious tiny transfer", "suspicious tiny transfers")) hidden")); Spacer(); Image(systemName: open ? "chevron.up" : "chevron.down") }
            .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
        }.buttonStyle(.plain).padding(.top, 8).accessibilityIdentifier("ledger.suspicious.toggle")
        if open {
          Text(T("可疑小额转账，可能是假地址，别用它付款。", "Suspicious tiny transfer. It may come from a fake address. Never pay it.")).font(.caption).foregroundStyle(Brand.negative).accessibilityIdentifier("ledger.suspicious.warning")
          ForEach(rows) { r in Button { if let u = r.url(explorer: explorer) { m.webSheet = WebSheet(url: u) } } label: { LedgerRowView(r: r).opacity(0.5) }.foregroundStyle(.primary) }
        }
      }
    }
  }
}

// MARK: - UX audit 2026-10-26 additions (copy / layout only; no rule or fee change)

/// Secondary: buy with a Coinbase account (lives under "其他方式").
struct BuyWithCoinbaseAccount: View {
  @EnvironmentObject var m: AppModel
  @State private var busy = false
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button { Haptics.tap(); Task { await buy() } } label: { Text(busy ? T("正在打开…", "Opening…") : T("用 Coinbase 账户买 USDC", "Buy USDC with a Coinbase account")).font(.subheadline) }.disabled(busy).accessibilityIdentifier("deposit.buy")
      Text(T("用 Coinbase 账户买时，币可能先留在你的 Coinbase 账户，需要再转一次。", "With a Coinbase account the coins may stay in that account and need one more transfer.")).font(.caption).foregroundStyle(.secondary)
    }.frame(maxWidth: .infinity, alignment: .leading).card(padding: 16)
  }
  /// Onramp session from the server (destination = this wallet only). Not configured / failed -> Coinbase's buy page.
  func buy() async {
    busy = true; defer { busy = false }
    var reply = OnrampReply.fallback(OnrampReply.coinbaseBuy)
    #if DEBUG
    if m.demo != nil {
      if CommandLine.arguments.contains("-kpOnrampMock") { reply = OnrampReply.parse(200, ["ok": true, "ref": "kp-0123456789abcdef01234567", "url": "https://pay.coinbase.com/buy/select-asset?sessionToken=demo&defaultNetwork=base&defaultAsset=USDC&partnerUserRef=kp-0123456789abcdef01234567"]) }
      switch reply {
      case .open(let u, let ref): m.lastLaunch = u.absoluteString; if let ref { m.onrampTrack = OnrampTrack(ref: ref) }   // demo: pretend checkout came back
      case .fallback(let u): m.lastLaunch = u.absoluteString }
      return
    }
    #endif
    if let (c, j) = try? await MainnetSession.authedPost("phone/onramp/session", ["redirectUrl": "kipurse://deposit-done"]) { reply = OnrampReply.parse(c, j) }
    switch reply {
    case .open(let u, let ref): m.onrampPendingRef = ref; m.openFreePage(u) { _ in false }
    case .fallback(let u): InApp.open(u)   // t785u: stays in the app
    }
  }
}

/// After checkout: poll the server until the purchase is verified. Never claims "arrived" before the server saw it.
struct OnrampStatusSheet: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  let track: OnrampTrack
  @State private var state: OnrampState = .checking
  var wallet: String { m.state?.wallet ?? "" }
  func plus(_ a: String?) -> String { a.map { " +\($0) USDC" } ?? "" }
  var body: some View {
    NavigationStack {
      ScrollView { VStack(alignment: .leading, spacing: KP.Space.cardGap) {
        switch state {
        case .checking:
          HStack(spacing: 10) { ProgressView(); Text(T("正在确认这笔购买有没有到你的 Kipurse 钱包…", "Checking whether this purchase reached your Kipurse wallet…")).font(.headline) }.accessibilityIdentifier("onramp.checking")
          Text(T("还没到账。Coinbase 发送通常要几分钟。", "Not arrived yet. Coinbase usually sends within a few minutes.")).font(.subheadline).foregroundStyle(.secondary)
        case .arriving(let a):
          HStack(spacing: 10) { ProgressView(); Text(T("到账中", "Arriving") + plus(a)).font(.headline) }.accessibilityIdentifier("onramp.arriving")
          Text(T("Coinbase 正在发送到你的钱包，到账后这里会变成“已到账”。", "Coinbase is sending it to your wallet. This turns into “arrived” when it lands.")).font(.subheadline).foregroundStyle(.secondary)
        case .arrived(let a, let tx):
          Label(T("已到账", "Arrived") + plus(a), systemImage: "checkmark.circle.fill").font(.title3.bold()).foregroundStyle(Brand.positive).accessibilityIdentifier("onramp.arrived")
          if let tx { DisclosureGroup(T("查看交易", "Show transaction")) { Text(tx).font(.caption.monospaced()).textSelection(.enabled) }.font(.caption) }
        case .failed:
          Label(T("这笔购买没有成功，钱没有到钱包。请在 Coinbase 里查看订单。", "This purchase did not go through and nothing reached your wallet. Check the order in Coinbase."), systemImage: "xmark.octagon.fill").foregroundStyle(Brand.negative).accessibilityIdentifier("onramp.failed")
        case .wrongDestination:
          Label(T("警告：Coinbase 显示这笔发到了别的地址，不是你的 Kipurse 钱包。请立刻联系我们。", "Warning: Coinbase shows this was sent to a different address, not your Kipurse wallet. Contact us now."), systemImage: "exclamationmark.triangle.fill").foregroundStyle(Brand.negative).accessibilityIdentifier("onramp.wrong")
        case .inCoinbaseAccount:
          Label(T("币还在你的 Coinbase 账户里", "The coins are still in your Coinbase account"), systemImage: "building.columns.fill").font(.title3.bold()).foregroundStyle(Brand.caution).accessibilityIdentifier("onramp.inCoinbase")
          Text(T("我们没在你的 Kipurse 钱包里看到这笔。在 Coinbase 页面登录账户购买时，币常常先留在 Coinbase 账户。照下面做一次转账就能转进来：", "We don't see this purchase in your Kipurse wallet. When you buy while signed in to Coinbase, the coins often stay in your Coinbase account. Move them in with one transfer:")).font(.subheadline).fixedSize(horizontal: false, vertical: true)
          VStack(alignment: .leading, spacing: 6) {
            Text(T("1. 打开 Coinbase App → 发送", "1. Open the Coinbase app → Send"))
            Text(T("2. 币种选 USDC", "2. Choose USDC"))
            Text(T("3. 网络选 Base（一定要选 Base）", "3. Network: Base (it must be Base)"))
            Text(T("4. 粘贴下面的地址，填金额，发送", "4. Paste the address below, enter the amount, send"))
          }.font(.subheadline)
          if !wallet.isEmpty {
            OwnAddress(address: DemoGuard.active ? DemoAddress.placeholder : wallet, id: "onramp.address", copyable: false)   // t1266: never a real-looking address in the demo
            BigButton(T("复制地址", "Copy address"), kind: .secondary, icon: "doc.on.doc") { UIPasteboard.general.string = wallet; Haptics.success(); m.toast = T("地址已复制", "Address copied") }.accessibilityIdentifier("onramp.copy")
          }
          BigButton(T("打开 Coinbase", "Open Coinbase"), icon: "arrow.up.forward.app") { InApp.open(URL(string: "https://www.coinbase.com/")!) }.accessibilityIdentifier("onramp.openCoinbase")
          Text(T("转好后，首页余额会在到账后更新。", "Your home balance updates once it arrives.")).font(.footnote).foregroundStyle(.secondary)
        }
      }.padding(20) }
      .navigationTitle(T("购买进度", "Purchase status")).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(state.isFinal ? T("完成", "Done") : T("关闭", "Close")) { dismiss() }.accessibilityIdentifier("onramp.close") }
    }
    .task { await poll() }
  }
  func poll() async {
    for _ in 0..<180 {
      let since = Date().timeIntervalSince(track.returnedAt)
      #if DEBUG
      if m.demo != nil {
        let a = CommandLine.arguments; let v = a.firstIndex(of: "-kpOnrampState").flatMap { a.indices.contains($0 + 1) ? a[$0 + 1] : nil } ?? "arrived"
        let j: [String: Any] = v == "coinbase" ? ["ok": true, "state": "not_found", "maybeInCoinbaseAccount": true] : v == "arriving" ? ["ok": true, "state": "arriving", "amount": "4.88"] : ["ok": true, "state": v, "amount": "4.88", "txHash": "0x" + String(repeating: "ab", count: 32)]
        try? await Task.sleep(nanoseconds: 800_000_000); withAnimation { state = OnrampState.parse(200, j, secondsSinceReturn: since) }; return
      }
      #endif
      let r = try? await MainnetSession.authedPost("phone/onramp/status", ["ref": track.ref])
      let st = OnrampState.parse(r?.0, r?.1, secondsSinceReturn: since)
      if st != .checking || state == .checking { withAnimation { state = st } }
      if st.isFinal { if case .arrived = st { Haptics.success(); await m.refresh() }; return }
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      if Task.isCancelled { return }
    }
  }
}

/// #8: one line "fees total" instead of many tiny fee rows on home.
struct FeeTotalRow: View {
  @EnvironmentObject var m: AppModel
  let rows: [LedgerRow]
  var body: some View {
    let fees = rows.filter { LedgerText.isFee($0) && !$0.suspicious }
    if !fees.isEmpty {
      let total = fees.reduce(Int64(0)) { $0 + abs($1.delta) }
      Divider()
      HStack(spacing: 12) { Image(systemName: "fuelpump").font(.footnote.weight(.semibold)).foregroundStyle(.secondary).frame(width: 32, height: 32).background(Color.secondary.opacity(0.12), in: Circle())
        Text(T("手续费合计（\(fees.count) 笔）", "Fees (\(Beginner.plural(fees.count, "payment", "payments")))")).font(.subheadline)
        Spacer(); Text(m.balanceRevealed ? MoneyText.feeUSDC(total) : BalanceMask.short).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
      }.padding(.vertical, 8).accessibilityElement(children: .combine).accessibilityIdentifier("ledger.feeTotal")
    }
  }
}

/// #8: grouped summary on "All activity": added, AI payments, withdrawn, fees.
/// t1245 (§6#115 U26/U27): one 「AI 付款合计」 line (no 「付给 其他」), the lines follow the filter, amounts use the one money rule
/// (2 decimals; fees in the page's fee style).
struct LedgerSummarySection: View {
  @EnvironmentObject var m: AppModel
  let rows: [LedgerRow]
  var filter: LedgerFilter = .all
  /// Every fee amount this page can show (each fee row, the fee inside a withdrawal, and their total) -> one fee style.
  static func feeStyle(_ rows: [LedgerRow]) -> MoneyText.FeeStyle {
    let ok = rows.filter { !$0.suspicious }
    let each = ok.filter { LedgerText.isFee($0) || $0.kind == "walletfee" }.map { abs($0.delta) } + ok.compactMap { $0.kind == "withdraw" ? $0.fee : nil }
    return MoneyText.FeeStyle.page(each + [each.reduce(0, +)])
  }
  var body: some View {
    let ok = rows.filter { !$0.suspicious }
    let added = ok.filter { $0.kind == "deposit" }.reduce(Int64(0)) { $0 + $1.delta }
    let paid = ok.filter { $0.kind == "payment" && $0.delta < 0 }.reduce(Int64(0)) { $0 - $1.delta }
    // t1129u: fees = server fee rows + network fees the wallet paid itself (fee-only rows and the fee inside a withdrawal).
    let fees = ok.filter { LedgerText.isFee($0) }.reduce(Int64(0)) { $0 + abs($1.delta) }
      + ok.filter { $0.kind == "walletfee" }.reduce(Int64(0)) { $0 + abs($1.delta) }
      + ok.filter { $0.kind == "withdraw" }.reduce(Int64(0)) { $0 + ($1.fee ?? 0) }
    let withdrawn = ok.filter { $0.kind == "withdraw" }.reduce(Int64(0)) { $0 + abs($1.delta) - ($1.fee ?? 0) }
    let style = Self.feeStyle(rows)
    let money: (Int64) -> String = { m.balanceRevealed ? MoneyText.usdc($0) : BalanceMask.short }
    Section(T("汇总", "Summary")) {
      if filter == .all || filter == .deposit { LabeledContent(T("充值合计", "Added"), value: money(added)) }
      if (filter == .all && paid > 0) || filter == .payment { LabeledContent(T("AI 付款合计", "AI payments"), value: money(paid)) }
      if (filter == .all && withdrawn > 0) || filter == .withdraw { LabeledContent(T("提现合计", "Withdrawn"), value: money(withdrawn)) }
      if filter == .all { LabeledContent(T("手续费合计", "Fees total"), value: m.balanceRevealed ? MoneyText.feeUSDC(fees, style: style) : BalanceMask.short) }
    }.accessibilityIdentifier("ledger.summary")
  }
}

/// #8: fee rows still available, folded.
struct FeeDetailSection: View {
  @EnvironmentObject var m: AppModel
  let rows: [LedgerRow]; let explorer: String
  @State private var open = false
  var body: some View {
    let fees = rows.filter { LedgerText.isFee($0) && !$0.suspicious }
    if !fees.isEmpty {
      Section {
        Button { withAnimation { open.toggle() } } label: { HStack { Text(T("查看每一笔费用（\(fees.count)）", "Show each fee (\(fees.count))")); Spacer(); Image(systemName: open ? "chevron.up" : "chevron.down") } }.accessibilityIdentifier("ledger.feeToggle")
        if open { ForEach(fees) { r in Button { if let u = r.url(explorer: explorer) { m.webSheet = WebSheet(url: u) } } label: { LedgerRowView(r: r, feeStyle: LedgerSummarySection.feeStyle(rows)) }.foregroundStyle(.primary) } }
      }
    }
  }
}

/// #3: the emergency page is a web page; check it answers before opening (3 s), else show what to do offline.
enum EmergencyCheck {
  static func reachable(_ u: URL) async -> Bool {
    #if DEBUG
    if CommandLine.arguments.contains("-kpEmergencyOffline") { return false }
    #endif
    var r = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5); r.httpMethod = "GET"   // t789: a 404 page is not "reachable"
    guard let (_, resp) = try? await URLSession.shared.data(for: r), let h = resp as? HTTPURLResponse else { return false }
    return h.statusCode == 200
  }
}
/// t796: native emergency screen first, in plain words; the web page opens only after Continue.
struct EmergencyFirstSheet: View {
  @EnvironmentObject var m: AppModel
  let url: URL
  var body: some View {
    NavigationStack {
      ScrollView { VStack(alignment: .leading, spacing: KP.Space.cardGap) {
        Label(T("紧急：停下 AI 或提现", "Emergency: stop AI or get your money back"), systemImage: "exclamationmark.shield").font(.title3.bold())
        Text(T("你的钱在你自己的钱包里。下一步你可以：暂停 AI 付款，或把钱全部提现到你的 Coinbase 钱包。", "Your money is in your own wallet. Next you can pause all AI payments, or move all your money back to your Coinbase account.")).font(.subheadline).fixedSize(horizontal: false, vertical: true)
        Text(T("需要用你的 Coinbase 账户确认。钱只会回到你自己的账户。", "You confirm with your Coinbase account. Money can only go back to your own account.")).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        BigButton(T("继续", "Continue"), icon: "arrow.right") { let u = url; m.emergencyFirst = nil; Task { if await EmergencyCheck.reachable(u) { m.openFreePage(u) { _ in false } } else { m.emergencyOffline = u } } }.accessibilityIdentifier("emergency.continue")
      }.padding(20) }
      .navigationTitle(T("紧急", "Emergency")).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(T("取消", "Cancel")) { m.emergencyFirst = nil }.accessibilityIdentifier("emergency.cancel") }
    }.accessibilityIdentifier("emergency.first")
  }
}
struct EmergencyOfflineSheet: View {
  @EnvironmentObject var m: AppModel
  let url: URL
  var body: some View {
    NavigationStack {
      ScrollView { VStack(alignment: .leading, spacing: KP.Space.cardGap) {
        Label(T("现在连不上紧急页", "Can't reach the emergency page right now"), systemImage: "wifi.exclamationmark").font(.title3.bold())
        Text(T("你的钱还在你自己的钱包里，Kipurse 不能动它。", "Your money is still in your own wallet; Kipurse can't move it.")).font(.subheadline)
        Text(T("不用等启付：手机可以直接把钱全部提现到你自己的 Coinbase 钱包，只需要你的 Coinbase 账户确认一次。", "No need to wait for Kipurse: your iPhone can take all the money back to your own Coinbase wallet directly on the blockchain, with one confirmation from your Coinbase account.")).font(.subheadline).fixedSize(horizontal: false, vertical: true)
        if FeatureSwitch.chainRescue.on { NavigationLink { RescueGuideView() } label: { Label(RescueText.guideLink, systemImage: "arrow.down.to.line").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("emergency.guide") }
        DisclosureGroup(T("详情", "Details")) { Text(url.absoluteString).font(.caption.monospaced()).textSelection(.enabled).foregroundStyle(.secondary) }.font(.footnote)
        BigButton(T("重试", "Retry"), icon: "arrow.clockwise") { let u = url; Task { if await EmergencyCheck.reachable(u) { m.emergencyOffline = nil; m.openFreePage(u) { _ in false } } else { Haptics.error(); m.toast = T("还是连不上", "Still can't connect") } } }.accessibilityIdentifier("emergency.retry")
        BigButton(T("复制网址", "Copy address"), kind: .secondary, icon: "doc.on.doc") { UIPasteboard.general.string = url.absoluteString; Haptics.success() }
      }.padding(20) }
      .navigationTitle(T("紧急", "Emergency")).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(T("关闭", "Close")) { m.emergencyOffline = nil }.accessibilityIdentifier("emergency.close") }
    }.accessibilityIdentifier("emergency.offline")
  }
}
