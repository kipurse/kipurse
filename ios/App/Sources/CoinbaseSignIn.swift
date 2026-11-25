import SwiftUI
import Security
import LocalAuthentication
import KipurseCore

/// First screen of every new install: "[zh]". The user's Coinbase wallet is the identity; the leftover phone key in the
/// keychain (it survives app deletion) is only reused when the server proves it is still the approver of THIS account's wallet.
enum SigninAPI {
  static func post(_ p: String, _ b: [String: Any]) async throws -> [String: Any] {
    var r = URLRequest(url: Mainnet.base.appendingPathComponent(p)); r.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "content-type"); r.timeoutInterval = 20
    r.httpBody = try JSONSerialization.data(withJSONObject: b); let (d, resp) = try await URLSession.shared.data(for: r)
    let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    if let h = resp as? HTTPURLResponse, h.statusCode >= 400 { throw NSError(domain: "kipurse", code: h.statusCode, userInfo: [NSLocalizedDescriptionKey: T("暂时连不上，请稍后再试。", "Can't connect right now. Please try again.")]) }
    return j
  }
  static func status(_ id: String, poll: String) async -> CoinbaseIdentity.Result? {
    var c = URLComponents(url: Mainnet.base.appendingPathComponent("signin/status"), resolvingAgainstBaseURL: false)!; c.queryItems = [URLQueryItem(name: "id", value: id), URLQueryItem(name: "poll", value: poll)]   // t796 H2: only the starter has the poll secret
    guard let u = c.url, let (d, _) = try? await URLSession.shared.data(from: u), let j = try? JSONDecoder().decode(JSONValue.self, from: d) else { return nil }
    return CoinbaseIdentity.Result(j)
  }
}

extension PhoneKey {
  static let retiredTag = "com.kipurse.phone-signer.mainnet.v1.retired".data(using: .utf8)!
  /// A key that does not belong to the signed-in account: never used again. Kept aside (renamed, not deleted) so nothing is lost
  /// by mistake; the normal tag becomes free for a fresh key.
  static func retire() {
    if DemoGuard.active { return }
    let upd = SecItemUpdate([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag] as CFDictionary, [kSecAttrApplicationTag as String: retiredTag] as CFDictionary)
    if upd != errSecSuccess && upd != errSecItemNotFound { delete() }
    UserDefaults.standard.removeObject(forKey: "kp.phoneFP")
  }
}

@MainActor final class CoinbaseSignInFlow: ObservableObject {
  enum Phase: Equatable { case idle, opening, waiting, reconnecting, next(CoinbaseIdentity.Outcome), failed(String) }
  @Published var phase: Phase = .idle
  @Published var pair: String? = nil   // t796 H2: pairing code, also shown on the sign-in page
  /// t1268: this sign-in still owes the server proof that this phone holds the key it sent (needed only for the read grant of a "bind").
  private struct KeyProof { let id: String; let poll: String; let digest: String; let x: [UInt8]; let y: [UInt8] }
  private var owedProof: KeyProof? = nil
  /// t1275: what this phone sent / got at /signin/start: its key (the SIWE statement must name it) and the nonce (the signed message must carry it).
  private var expectXY: ([UInt8], [UInt8])? = nil, expectNonce: String? = nil
  @Published var keyFp: String? = nil   // t1275: shown next to the pairing code; the Coinbase popup's text names the same key
  /// t1275: the owner the server names is used only after this phone checked the owner's own SIWE message + signature (SigninSiwe).
  private func verifiedOwner(_ r: CoinbaseIdentity.Result) async -> String? {
    #if DEBUG
    if Unbound.isMockSignin { return r.owner }   // UI tests: the page's answer without network or signing
    #endif
    let p = await SigninSiwe.check(owner: r.owner, message: r.siweMessage, signature: r.siweSignature, x: expectXY?.0, y: expectXY?.1, nonce: expectNonce)
    if let p { AuthLog.note("signin-siwe", p); return nil }
    return r.owner
  }
  /// t1268: the phone key signs SigninKeyProof.digest(id) with ONE Face ID (the given context, else one now). Only the key whose public
  /// part was sent may sign; nil = no proof (the server then leaves no grant / setup, sign-in itself still works).
  private static func keyProof(id: String, x: [UInt8], y: [UInt8], context: LAContext?) async -> ([UInt8], [UInt8], LAContext?)? {
    guard SigninKeyProof.validId(id) else { return nil }
    var ctx = context
    if ctx == nil { ctx = await BiometricGate.unlockContext(reason: T("确认这台 iPhone 的批准密钥", "Confirm this iPhone's approval key")) }
    guard let c = ctx, let k = PhoneKey.existing(context: c), let xy = PhoneKey.xy(k), xy.0 == x, xy.1 == y else { if context == nil { ctx?.invalidate() }; return nil }
    do { let (r, s) = try PhoneKey.sign(SigninKeyProof.digest(id: id), key: k, reusesUnlock: true); return (r, s, c) }
    catch { AuthLog.record("signin-keyproof", error); if context == nil { c.invalidate() }; return nil }
  }
  func start(_ m: AppModel) async {
    phase = .opening; owedProof = nil; expectXY = nil; expectNonce = nil; keyFp = nil
    #if DEBUG   // UI tests: the page's answer without network or signing
    if let i = CommandLine.arguments.firstIndex(of: "-kpSigninMock"), i + 1 < CommandLine.arguments.count {
      let o = CommandLine.arguments[i + 1], w = o == "new" ? "null" : "\"0x2000000000000000000000000000000000000002\""
      if let r = CoinbaseIdentity.Result(try? JSONDecoder().decode(JSONValue.self, from: Data(#"{"state":"done","result":"\#(o)","owner":"0x1000000000000000000000000000000000000003","wallet":\#(w)}"#.utf8))) {
        try? await Task.sleep(nanoseconds: 300_000_000); await finish(m, r) }
      return
    }
    #endif
    var body: [String: Any] = [:]
    // t1027: public key ONLY from cache / fresh create — never PhoneKey.existing() here (ReturnRef = Face ID on launch/login).
    if let (x, y) = PhoneKey.cachedXY() { body = ["x": Hex.encode(x), "y": Hex.encode(y)] }
    else if !PhoneKey.isPresent(), let (x, y) = try? OnboardAPI.key() { body = ["x": Hex.encode(x), "y": Hex.encode(y)] }   // t1001: fresh key, no Face ID
    if OnboardAPI.on, body["x"] != nil, let s = CoinbaseIdentity.presetSetup { body["setup"] = s }   // t603: no preset; a NEW account picks its own limits in the guided step
    let sentXY: ([UInt8], [UInt8])? = (body["x"] as? String).flatMap(Hex.decode).flatMap { x in (body["y"] as? String).flatMap(Hex.decode).map { (x, $0) } }
    // t1268: the one-page setup only opens for a PROVEN key, so with a setup the key signs the app-chosen id up front (one Face ID).
    // Without a setup nothing is signed here: a "reconnect" needs no proof (no Face ID on sign-in), a "bind" proves after the answer.
    if body["setup"] != nil, let (x, y) = sentXY {
      let id = SigninKeyProof.newId()
      if let (r, s, ctx) = await Self.keyProof(id: id, x: x, y: y, context: nil) { ctx?.invalidate(); body["id"] = id; body["r"] = Hex.encode(r); body["s"] = Hex.encode(s) }
    }
    do {
      let r = try await SigninAPI.post("signin/start", body)
      guard let id = r["id"] as? String, let poll = r["poll"] as? String, let u = (r["url"] as? String).flatMap(URL.init(string:)), u.host == Mainnet.base.host else { phase = .failed(T("服务器回应不对。", "Unexpected server reply.")); return }
      expectXY = sentXY; expectNonce = r["nonce"] as? String; keyFp = sentXY.map { PhoneTrust.fingerprint(x: $0.0, y: $0.1) }   // t1275
      if let (x, y) = sentXY, (r["proven"] as? Bool) != true, let d = (r["prove"] as? [String: Any])?["digest"] as? String { owedProof = KeyProof(id: id, poll: poll, digest: d, x: x, y: y) }
      // t789: the sign-in page stays on pay.kipurse.com (SIWE domain); the phone checks the page + its pinned bundle before showing it
      do { try await SigninCheck.verify(page: u) } catch SigninCheck.Failure.unreachable { phase = .failed(SigninCheck.offlineText); return } catch { phase = .failed(SigninCheck.stopText); return }
      pair = r["pair"] as? String; phase = .waiting
      m.openFreePage(u) { [weak self] mm in
        guard let res = await SigninAPI.status(id, poll: poll) else { return false }
        if let w = CoinbaseIdentity.openedOnSignIn(res) { mm.webSheet = nil; await self?.opened(mm, res, wallet: w); return true }
        if res.outcome == .new, mm.webSheet != nil, res.setupState != nil { return false }   // still on the page: the free setup step follows
        mm.webSheet = nil; await self?.finish(mm, res); return true
      }
    } catch { phase = .failed(error is URLError && FeatureSwitch.calmBanner.on ? RescueText.banner : error.localizedDescription) }   // t821: never the raw system error
  }
  /// One page did it all: signed in AND opened the wallet with this phone's key. Straight into the wallet home (one Face ID opens it).
  /// t1266 (fix 4): the wallet the server names is used only after two public Base nodes agree it is this owner's (and this phone's) wallet.
  static func chainConfirms(wallet w: String?, owner: String, hints: [String] = []) async -> Bool {
    #if DEBUG
    if Unbound.isMockSignin { return true }   // UI tests: the page's answer without network (no real wallet)
    #endif
    guard let w, CoinbaseIdentity.isAddress(w), CoinbaseIdentity.isAddress(owner) else { return false }
    let xy = PhoneKey.cachedXY()   // cached public key only (no Face ID)
    return await WalletVerify.confirmed(wallet: w, owner: owner, knownOwner: owner, x: xy?.0, y: xy?.1, approverHints: hints)   // t1268: server's seat / approver = candidates only
  }
  static let notConfirmed = T("没能在链上确认这个钱包属于你，已停止。你的钱没有任何变化，请稍后再试。", "Couldn't confirm on chain that this wallet is yours. Stopped; your money is unchanged. Please try again later.")
  private func opened(_ m: AppModel, _ r: CoinbaseIdentity.Result, wallet w: String) async {
    guard let owner = await verifiedOwner(r) else { phase = .failed(SigninSiwe.refusedText); return }   // t1275: adopt nothing unverified
    guard await Self.chainConfirms(wallet: w, owner: owner, hints: r.approverHints) else { phase = .failed(Self.notConfirmed); return }
    UserDefaults.standard.set(owner, forKey: CoinbaseIdentity.ownerKey)
    Operator.setWallet(w, owner: owner, path: "/t/" + w.lowercased())
    FirstUse.reset(); Haptics.success(); phase = .reconnecting
    m.identityVerified(); m.mainNeedsSignIn = false; await m.enterWalletWithoutFaceID()
    if m.state == nil { phase = .idle }
  }
  /// the tenant path is always the verified wallet's own (/t/<wallet>); a server path for another wallet is ignored
  static func path(_ r: CoinbaseIdentity.Result) -> String {
    guard let w = r.wallet else { return r.path ?? "" }
    if let p = r.path, p.isEmpty || p.lowercased() == "/t/" + w.lowercased() { return p }
    return "/t/" + w.lowercased()
  }
  private func finish(_ m: AppModel, _ r: CoinbaseIdentity.Result) async {
    guard let owner = await verifiedOwner(r) else { owedProof = nil; phase = .failed(SigninSiwe.refusedText); return }   // t1275: adopt nothing unverified
    switch r.outcome {
    case .reconnect:   // same person, same phone: reuse the key and the wallet. No re-binding, no fee.
      guard await Self.chainConfirms(wallet: r.wallet, owner: owner, hints: r.approverHints) else { phase = .failed(Self.notConfirmed); return }
      owedProof = nil   // the active approver needs no read grant
      UserDefaults.standard.set(owner, forKey: CoinbaseIdentity.ownerKey)
      Operator.setWallet(r.wallet, owner: owner, path: Self.path(r))
      m.identityVerified(); phase = .reconnecting
      await m.enterWalletWithoutFaceID()   // t1027 / 0A.2: land in wallet with no Face ID
      if m.state == nil { phase = .idle }
    case .bind:   // t849 + t1001 LOCKED: a returning user lands straight in the wallet home (read-only grant for this phone key).
      // Never a Face ID / phone-key setup step first: with 0 balance its network fee can't be paid (dead loop). Face ID approvals
      // are offered later, only when there is a balance and an action needs them ([zh] → Face ID [zh], or the approval that needs it).
      guard await Self.chainConfirms(wallet: r.wallet, owner: owner, hints: r.approverHints) else { phase = .failed(Self.notConfirmed); return }
      UserDefaults.standard.set(owner, forKey: CoinbaseIdentity.ownerKey)
      Unbound.remember(wallet: r.wallet, path: Self.path(r))
      Operator.setWallet(r.wallet, owner: owner, path: Self.path(r))
      m.identityVerified(); phase = .reconnecting
      if let p = owedProof { OwedSigninProof.save(id: p.id, poll: p.poll, digest: p.digest, x: p.x, y: p.y) }; owedProof = nil   // t1268 decision 133 (0A #2): no Face ID at sign-in; proved by the first action that needs Face ID
      #if DEBUG
      if Unbound.isMockSignin { m.state = AppModel.demoState("main-zero"); return }   // UI test: the wallet home the server would return, 0 balance
      #endif
      await m.enterWalletWithoutFaceID()
      if m.state == nil { phase = .failed(T("钱包暂时没打开，你的钱没有任何变化。请点「老用户登录」再试一次。", "Your wallet didn't open this time. Your money is unchanged. Tap Sign in to try again.")) }
    case .new:      // no wallet yet: the stale key is never used; onboarding (wallet creation) creates a fresh one
      owedProof = nil
      PhoneKey.retire(); Operator.setWallet(nil); UserDefaults.standard.set(owner, forKey: CoinbaseIdentity.ownerKey)
      Haptics.success(); phase = .next(r.outcome)
    }
  }
}

struct CoinbaseSignInView: View {
  @EnvironmentObject var m: AppModel
  @StateObject private var f = CoinbaseSignInFlow()
  @Environment(\.dynamicTypeSize) private var typeSize
  var body: some View {
    Group {
      if f.phase == .idle {
        GeometryReader { g in
          // Pin actions in normal portrait. Short windows / accessibility text can scroll, never clip controls.
          if g.size.height < 620 || typeSize.isAccessibilitySize {
            ScrollView { landing.padding(.vertical, 16) }
          } else {
            landing.padding(.top, 20).padding(.bottom, 12)
          }
        }
      } else {
        // Pairing, errors and next-step content retain their fully scrollable layout.
        ScrollView {
          VStack(spacing: KP.Space.cardGap) {
            BrandMark(size: 64).padding(.top, 40)
            switch f.phase {
            case .next(let o): next(o)
            case .reconnecting: ProgressView(T("好了，正在打开你的钱包…", "Done. Opening your wallet…")).padding(.top, 20)
            default: signIn
            }
          }.padding(.horizontal, 24).padding(.bottom, 30)
        }
      }
    }.background(Brand.canvas)
    #if DEBUG
    .onAppear {
      // Local UI fixtures only: never contact Coinbase or a server to exercise these states.
      if let i = CommandLine.arguments.firstIndex(of: "-kpLandingPhase"), i + 1 < CommandLine.arguments.count {
        switch CommandLine.arguments[i + 1] {
        case "waiting": f.pair = "123456"; f.phase = .waiting
        case "failed": f.phase = .failed(T("暂时连不上，请稍后再试。", "Can't connect right now. Please try again."))
        default: break
        }
      }
    }
    #endif
  }
  private var landing: some View {
    VStack(spacing: KP.Space.cardGap) {
      BrandMark(size: 64)
      heading
      AIWalletHero().frame(minHeight: 180, maxHeight: .infinity)
      VStack(spacing: KP.Space.cardGap) {
        actions
        footer
      }
    }.padding(.horizontal, 24)
  }
  @ViewBuilder private var heading: some View {
    Text(T("启付", "Kipurse")).font(.largeTitle.bold()).accessibilityIdentifier("cb.title")
    Text(T("AI 帮你付钱，你说了算", "Your AI pays, you decide")).font(.subheadline).foregroundStyle(.secondary)
    if m.loginExpired { Text(Unbound.loginExpiredText).font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("cb.expired") }
  }
  private var actions: some View {
    VStack(spacing: 14) {
      NavigationLink { RegisterIntroView(f: f) } label: {
        Label(T("新用户注册", "New here? Sign up"), systemImage: "sparkles").font(.title3.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 60)
      }.buttonStyle(.borderedProminent).controlSize(.large).kGlow().accessibilityIdentifier("cb.register")
      Button { Task { await f.start(m) } } label: {
        Label(f.phase == .opening ? T("正在打开…", "Opening…") : T("老用户登录", "I have an account: Sign in"), systemImage: "person.crop.circle.badge.checkmark").font(.title3.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 60)
      }.buttonStyle(.bordered).controlSize(.large).disabled(f.phase == .opening).accessibilityIdentifier("cb.signin")
    }
  }
  @ViewBuilder private var footer: some View {
    if let u = Unbound.emergencyURL(base: Mainnet.base, wallet: Unbound.wallet, path: UserDefaults.standard.string(forKey: Unbound.pathKey)) {
      Button { m.emergencyFirst = u } label: { Label(Unbound.emergencyLabel, systemImage: "lifepreserver") }.font(.footnote).tint(.secondary).accessibilityIdentifier("unbound.emergency").accessibilityValue(u.absoluteString)
    }
  }
  @ViewBuilder var signIn: some View {
    heading
    if case .failed(let e) = f.phase {
      Text(e).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).accessibilityIdentifier("cb.failed")
      Button(T("重试", "Retry")) { Task { await f.start(m) } }.font(.subheadline.weight(.semibold)).tint(Brand.accent).accessibilityIdentifier("cb.retry")
    }
    actions.padding(.top, 24)
    if f.phase == .waiting { Text(T("在弹出的页面里登录 Coinbase 并确认，完成后会自动回来。", "Sign in to Coinbase on the page that opens. You'll come back here automatically.")).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
    if f.phase == .waiting, let p = f.pair { VStack(spacing: 4) { Text(T("配对码", "Pairing code")).font(.caption).foregroundStyle(.secondary); Text(p).font(.system(size: 34, weight: .bold, design: .monospaced)).accessibilityIdentifier("cb.pair"); Text(T("网页上必须显示同样的号码。不一样就别继续。", "The web page must show the same number. If it doesn't, stop.")).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
      if let fp = f.keyFp { Text(T("Coinbase 弹窗里写的 iPhone 密钥必须是 \(fp)。", "The iPhone key in the Coinbase popup must be \(fp).")).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).accessibilityIdentifier("cb.keyfp") } } }   // t1275
    Spacer(minLength: 28)
    footer
  }
  @ViewBuilder func next(_ o: CoinbaseIdentity.Outcome) -> some View {
    Label(T("已登录", "Signed in"), systemImage: "checkmark.seal.fill").font(.title2.bold()).foregroundStyle(Brand.positive).accessibilityIdentifier("cb.done")
    Text(o == .new ? T("这个 Coinbase 账户还没有启付钱包。下一步：充值开户，并自己填好钱包安全上限（每笔、每天、总额）。", "This Coinbase account has no Kipurse wallet yet. Next: deposit to open it, and fill in your wallet safety limits (per payment, per day, total).")
                   : T("这个 Coinbase 账户已经有启付钱包。在这台 iPhone 上开启 Face ID 批准，就能继续用。", "This Coinbase account already has a Kipurse wallet. Turn on Face ID approvals on this iPhone to keep using it."))
      .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
    Text(o == .new ? T("只需在 Coinbase 里确认一次。" + Beginner.openingFeeZh, "Just one confirmation in Coinbase. " + Beginner.openingFeeEn)
                   : T("需要在 Coinbase 里确认一次。在这台手机开启 Face ID 批准，要从启付钱包余额付一笔实际网络费（确认前显示实时报价，最多 0.05 USDC），不需要 ETH。", "One confirmation in Coinbase. Turning Face ID approvals on for this iPhone takes one actual network fee from your Kipurse wallet balance (a live quote before you confirm, at most 0.05 USDC); no ETH needed."))
      .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
    if o == .bind {   // t802: returning user -> bind this phone to the EXISTING wallet, not new onboarding
      NavigationLink { BindPhoneFlow() } label: { Text(T("开启 Face ID 批准", "Turn on Face ID approvals")).frame(maxWidth: .infinity) }
        .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("cb.next")
    } else if OnboardAPI.on {
      NavigationLink { OnboardView() } label: { Text(o == .new ? T("开通我的钱包", "Set up my wallet") : T("开启 Face ID 批准", "Turn on Face ID approvals")).frame(maxWidth: .infinity) }
        .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("cb.next")
    } else {
      Text(T("这个版本的 App 没有打开开通功能，所以这里没有下一步按钮。你的钱包和资金都没有变化，请安装最新版启付后再试。", "Setup is turned off in this version of the app, so there is no next button here. Your wallet and funds are unchanged. Please install the latest Kipurse app and try again.")).font(.subheadline).foregroundStyle(Brand.caution).multilineTextAlignment(.center)
    }
      if o == .bind, let u = Unbound.emergencyURL(base: Mainnet.base, wallet: Unbound.wallet, path: UserDefaults.standard.string(forKey: Unbound.pathKey)) {
        Button { m.emergencyFirst = u } label: { Label(Unbound.emergencyLabel, systemImage: "exclamationmark.shield").frame(maxWidth: .infinity) }
          .buttonStyle(.bordered).controlSize(.large).tint(Brand.caution).accessibilityIdentifier("cb.emergency").accessibilityValue(u.absoluteString)
        Text(Unbound.emergencyHint).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
      }
  }
}


/// t1049: one physical glass purse, shared by four real AI agents. Illustration only.
/// A single bounded clock drives orbit depth and caustics; Reduce Motion creates no TimelineView.
private struct AIWalletHero: View {
  @Environment(\.accessibilityReduceMotion) private var systemReduce
  @Environment(\.scenePhase) private var scene
  @State private var visible = false
  private let agents = ["muse", "grok", "claude", "siri"]
  private var reduce: Bool {
    #if DEBUG
    if CommandLine.arguments.contains("-kpReduceMotion") { return true }
    #endif
    return systemReduce
  }
  var body: some View {
    Group {
      if reduce { sceneView(time: 0) }
      else {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !visible || scene != .active)) { context in
          sceneView(time: context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 16))
        }
      }
    }.allowsHitTesting(false)
      .onAppear { visible = true }.onDisappear { visible = false }
  }
  // A tilted ellipse with an explicit depth coordinate. The upper half is behind the purse;
  // the lower half threads across its translucent face, then emerges on the opposite side.
  private func orbit(_ angle: Double) -> CGPoint {
    // t1055: a breathing vortex with a second-harmonic dive through the wallet.
    let x = cos(angle) * (132 + 7 * cos(angle * 2)), y = sin(angle) * 88 + sin(angle * 2) * 11
    return CGPoint(x: 170 + x * 0.96 + y * 0.28, y: 143 - x * 0.28 + y * 0.96)
  }
  private func angle(_ i: Int, _ time: Double) -> Double {
    // A closed cycle: accelerate through the crossing, slow at the apex.
    let phase = time * .pi / 8
    return phase + sin(phase * 2) * 0.20 + Double(i) * .pi / 2 + .pi / 4
  }
  private func sceneView(time: Double) -> some View {
    GeometryReader { g in
      let scale = min(g.size.width / 340, g.size.height / 290)
      ZStack {
        atmosphere(time: time)
        ribbon(time: time, front: false)
        ForEach(0..<4) { i in
          let a = angle(i, time)
          if sin(a) < 0 { agent(i, angle: a) }
        }
        purse(time: time).position(x: 170, y: 148)
        ribbon(time: time, front: true)
        ForEach(0..<4) { i in
          let a = angle(i, time)
          if sin(a) >= 0 { agent(i, angle: a) }
        }
      }.frame(width: 340, height: 290)
        .scaleEffect(scale).frame(width: g.size.width, height: g.size.height).clipped()
        .accessibilityHidden(true)
        .overlay {
          Rectangle().fill(Color.clear).contentShape(Rectangle())
            .accessibilityElement(children: .ignore).accessibilityHidden(false)
            .accessibilityLabel(T("Muse、Grok、Claude、Siri 环绕共用一个琉璃钱包，你掌控付款", "Muse, Grok, Claude and Siri orbit one shared glass purse; you control payments"))
            .accessibilityIdentifier("cb.hero")
            .accessibilityValue(reduce ? "still" : "animated")
        }
    }
  }
  // t1053: official logos suspended inside a curved glass bead, never a planar icon tile.
  // t1060: same AgentGlassBead as AI [zh] (build-35 soft rim); orbit/depth unchanged.
  private func agent(_ i: Int, angle a: Double) -> some View {
    let depth = sin(a), size = 43.0 + depth * 4
    return ZStack {
      Circle().fill(MK.cyan.opacity(0.15)).frame(width: size + 11, height: size + 11).blur(radius: 9)
      AgentGlassBead(asset: "agent-\(agents[i])", size: size, tilt: true)
    }.frame(width: 60, height: 60)
      .shadow(color: .black.opacity(0.5), radius: 5, x: 0, y: 4)
      .opacity(0.82 + (depth + 1) * 0.09).position(orbit(a))
  }

  private func atmosphere(time: Double) -> some View {
    Canvas { context, _ in
      for i in 0..<3 {
        let a = time * .pi / 8 + Double(i) * 2.1
        let point = CGPoint(x: 170 + cos(a) * 46, y: 148 + sin(a) * 30)
        context.fill(Path(ellipseIn: CGRect(x: point.x - 112, y: point.y - 100, width: 224, height: 200)), with: .radialGradient(Gradient(colors: [(i == 1 ? MK.cyan : Brand.accent).opacity(0.22), .clear]), center: point, startRadius: 0, endRadius: 112))
      }
      for i in 0..<32 {
        let a = Double(i) * .pi / 16 + time * .pi / 32
        let p = CGPoint(x: 170 + cos(a) * 160, y: 146 + sin(a) * 121)
        context.fill(Path(ellipseIn: CGRect(x: p.x, y: p.y, width: i.isMultiple(of: 4) ? 2.4 : 1, height: i.isMultiple(of: 4) ? 2.4 : 1)), with: .color((i.isMultiple(of: 2) ? MK.cyan : Brand.accentHi).opacity(0.45)))
      }
    }
  }
  // t1055: braided aurora wakes depth-sorted with the beads, plus drifting ion sparks.
  // No full hoop: every luminous filament fades behind its moving glass lens.
  private func ribbon(time: Double, front: Bool) -> some View {
    Canvas { context, _ in
      for i in 0..<4 {
        let head = angle(i, time)
        let hue = i.isMultiple(of: 2) ? MK.cyan : Brand.accentHi
        for lane in 0..<3 {
          for j in 2..<44 {
            let age = Double(j) / 44
            let a = head - age * 1.12
            guard (sin(a) >= 0) == front else { continue }
            let p = wakePoint(a, age: age, lane: lane, time: time)
            let q = wakePoint(a - 0.028, age: age + 0.025, lane: lane, time: time)
            var filament = Path(); filament.move(to: p); filament.addLine(to: q)
            let fade = pow(1 - age, 1.6) * (front ? 0.75 : 0.34)
            context.stroke(filament, with: .color(hue.opacity(fade * 0.07)), style: StrokeStyle(lineWidth: 7, lineCap: .round))
            context.stroke(filament, with: .color((lane == 1 ? Color.white : hue).opacity(fade * (lane == 1 ? 0.65 : 0.8))), style: StrokeStyle(lineWidth: lane == 1 ? 0.65 : 1.1, lineCap: .round))
          }
        }
        for j in 0..<15 {
          let age = (Double(j) / 15 + time / 8).truncatingRemainder(dividingBy: 1)
          let a = head - 0.15 - age * 1.55
          guard (sin(a) >= 0) == front else { continue }
          let base = orbit(a)
          let spread = sin(Double(j) * 2.4) * (4 + age * 17)
          let p = CGPoint(x: base.x + cos(a) * spread, y: base.y + sin(a) * spread)
          let r = (j.isMultiple(of: 4) ? 1.7 : 0.9) * (1 - age * 0.7)
          context.fill(Path(ellipseIn: CGRect(x: p.x-r, y: p.y-r, width: r*2, height: r*2)), with: .color(hue.opacity((1-age) * (front ? 0.85 : 0.35))))
          if j.isMultiple(of: 4) {
            context.fill(Path(ellipseIn: CGRect(x: p.x-4, y: p.y-4, width: 8, height: 8)), with: .radialGradient(Gradient(colors: [hue.opacity((1-age) * 0.20), .clear]), center: p, startRadius: 0, endRadius: 4))
          }
        }
      }
    }
  }
  private func wakePoint(_ a: Double, age: Double, lane: Int, time: Double) -> CGPoint {
    let p = orbit(a)
    let twist = a * 5 - time * .pi / 4 + Double(lane) * .pi * 2 / 3
    let spread = sin(age * .pi) * 7
    return CGPoint(x: p.x + cos(twist) * spread, y: p.y + sin(twist) * spread)
  }
  // t1050: a slim folded leather-glass wallet, with one continuous rim and a discreet magnetic tab.
  private struct BodyShape: Shape {
    func path(in r: CGRect) -> Path {
      Path(roundedRect: r, cornerRadius: min(r.width, r.height) * 0.125)
    }
  }
  private func caustic(time: Double, width: CGFloat, height: CGFloat) -> some View {
    let sweep = sin(time * .pi / 8)
    return ZStack {
      Ellipse().stroke(MK.cyan.opacity(0.32), lineWidth: 10)
        .frame(width: width * 1.4, height: height * 0.7)
        .blur(radius: 12).rotationEffect(.degrees(-28)).offset(x: sweep * 28, y: height * 0.48)
      Ellipse().fill(Brand.accentHi.opacity(0.28))
        .frame(width: width * 0.7, height: height * 1.5).blur(radius: 22).offset(x: -sweep * 50)
      Rectangle().fill(LinearGradient(colors: [.clear, .white.opacity(0.22), MK.cyan.opacity(0.16), .clear], startPoint: .leading, endPoint: .trailing))
        .frame(width: 75, height: height * 2).rotationEffect(.degrees(25)).offset(x: sweep * width * 0.8)
      Rectangle().fill(.white.opacity(0.26)).frame(width: 0.7, height: height * 2)
        .rotationEffect(.degrees(25)).blur(radius: 0.5).offset(x: sweep * width * 0.8 - 30)
    }.frame(width: width, height: height).clipped()
  }
  private var walletFace: some View {
    BodyShape().fill(LinearGradient(stops: [
      .init(color: Color(hex: 0x8880CC), location: 0),
      .init(color: Color(hex: 0x4F4689), location: 0.30),
      .init(color: Color(hex: 0x272241), location: 0.70),
      .init(color: Color(hex: 0x55538D), location: 1)
    ], startPoint: .topLeading, endPoint: .bottomTrailing))
  }
  private func purse(time: Double) -> some View {
    ZStack {
      // A single folded back cover and narrow dark opening, not a stack of plastic cards.
      BodyShape().fill(Color(hex: 0x171725))
        .overlay { BodyShape().stroke(LinearGradient(colors: [.white.opacity(0.45), Brand.accentHi.opacity(0.3), MK.cyan.opacity(0.5)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.8) }
        .frame(width: 208, height: 132).offset(x: 2, y: -4)
      BodyShape().fill(LinearGradient(colors: [Color(hex: 0x211E36), Color(hex: 0x555076), Color(hex: 0x242139)], startPoint: .top, endPoint: .bottom))
        .frame(width: 209, height: 132).offset(x: 2, y: 4)
        .shadow(color: .black.opacity(0.65), radius: 12, x: 3, y: 14)
      walletFace
        .overlay { caustic(time: time, width: 208, height: 132).clipShape(BodyShape()) }
        .overlay {
          // Soft curved-face reflection gives the glass depth without changing the leather silhouette.
          Ellipse().fill(LinearGradient(colors: [.white.opacity(0.14), .clear], startPoint: .top, endPoint: .bottom))
            .frame(width: 290, height: 140).offset(x: -36, y: -66).blur(radius: 6)
            .frame(width: 208, height: 132).clipShape(BodyShape())
        }
        .overlay { BodyShape().stroke(LinearGradient(colors: [.white.opacity(0.75), Brand.accentHi.opacity(0.35), MK.cyan.opacity(0.75)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.9) }
        .frame(width: 208, height: 132)
      // Recessed fold at the spine and a restrained seam identify a real bifold wallet.
      BodyShape().stroke(.white.opacity(0.14), lineWidth: 0.55).frame(width: 195, height: 119)
      Capsule().fill(LinearGradient(colors: [.clear, .black.opacity(0.35), .clear], startPoint: .top, endPoint: .bottom))
        .frame(width: 7, height: 111).offset(x: -89)
      Capsule().fill(.white.opacity(0.14)).frame(width: 0.65, height: 104).offset(x: -85)
      // Small flush magnetic closure, offset to the edge rather than a cartoon envelope flap.
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .fill(LinearGradient(colors: [Color(hex: 0x686195), Color(hex: 0x302B4D)], startPoint: .topLeading, endPoint: .bottomTrailing))
        .overlay { RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(LinearGradient(colors: [.white.opacity(0.5), MK.cyan.opacity(0.3)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 0.7) }
        .frame(width: 39, height: 29)
        .shadow(color: .black.opacity(0.5), radius: 3, x: -2, y: 3).offset(x: 89, y: 5)
      Circle().fill(LinearGradient(colors: [Color(hex: 0xD4DAE8), Color(hex: 0x656281), Color(hex: 0xB9D7DE)], startPoint: .topLeading, endPoint: .bottomTrailing))
        .overlay { Circle().fill(Color(hex: 0x302D48)).padding(1.2) }
        .overlay { Circle().stroke(.white.opacity(0.25), lineWidth: 0.5).padding(3) }
        .frame(width: 10, height: 10).offset(x: 82, y: 5)
    }.frame(width: 230, height: 164)
      .rotationEffect(.degrees(-8))
      .rotation3DEffect(.degrees(13 + sin(time * .pi / 8) * 3), axis: (x: 0.3, y: 1, z: 0), perspective: 0.35)
      .offset(y: sin(time * .pi / 4) * 2)
      .shadow(color: Brand.accent.opacity(0.3), radius: 23, x: 0, y: 14)
  }
}

/// t853: new-user screen: what's needed (Coinbase), the one fixed opening fee, then the same Coinbase sign-in.
struct RegisterIntroView: View {
  @EnvironmentObject var m: AppModel
  @ObservedObject var f: CoinbaseSignInFlow
  @State private var showNoCB = false
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    ScrollView { VStack(spacing: 18) {
      Text(T("新用户注册", "Sign up")).font(.title2.bold()).accessibilityIdentifier("reg.title")
      Text(Beginner.progress(1, zh: Loc.isChinese)).font(.caption.weight(.semibold)).foregroundStyle(.secondary).accessibilityIdentifier("cb.progress")
      VStack(alignment: .leading, spacing: 12) {
        Label(T(Beginner.coinbaseWhyZh, Beginner.coinbaseWhyEn), systemImage: "person.badge.shield.checkmark").accessibilityIdentifier("cb.why")
        Label(T("登录后一步步设置你自己的 AI 额度。", "After sign-in, set your own AI allowance step by step."), systemImage: "sparkles")
        Label(T(Beginner.openingFeeZh, Beginner.openingFeeEn), systemImage: "creditcard").accessibilityIdentifier("reg.fee")
      }.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).card(padding: 16)
      BigButton(f.phase == .opening ? T("正在打开…", "Opening…") : T("用 Coinbase 注册", "Sign up with Coinbase"), icon: "person.crop.circle.badge.plus", disabled: f.phase == .opening) { Task { await f.start(m) } }.accessibilityIdentifier("reg.go")
      Button(T("还没有 Coinbase 账户？看怎么开", "No Coinbase account yet? See how to open one")) { showNoCB = true }.font(.subheadline.weight(.semibold)).tint(Brand.accent).accessibilityIdentifier("gate.nocb")
        .sheet(isPresented: $showNoCB) { NoCoinbaseGuide() }
    }.padding(.horizontal, 24).padding(.vertical, 24) }.background(Brand.canvas)
      .navigationBarBackButtonHidden(true)
      .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button { dismiss() } label: { Label(T("返回", "Back"), systemImage: "chevron.left").labelStyle(.titleAndIcon) }.accessibilityIdentifier("reg.back") } }
  }
}

/// t853: first-launch-only welcome. Brand purple, ~2.5 s, tap to skip, Reduce Motion = a calm fade. Shown once (flag).
struct WelcomeIntro: View {
  static let seenKey = "kp.welcomeSeen.v1"
  var done: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduce
  @State private var t = false; @State private var rings = false; @State private var text = false
  var body: some View {
    ZStack {
      LinearGradient(colors: [Brand.accentDeep, Color.black], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
      if !reduce { ForEach(0..<3) { i in
        Circle().stroke(LinearGradient(colors: [Brand.accentHi.opacity(0.7), Brand.accent.opacity(0)], startPoint: .top, endPoint: .bottom), lineWidth: 2)
          .frame(width: 140, height: 140).scaleEffect(rings ? 2.6 + Double(i) * 0.5 : 0.6).opacity(rings ? 0 : 0.9)
          .animation(.easeOut(duration: 1.6).delay(0.25 + Double(i) * 0.22), value: rings)
      } }
      Circle().fill(RadialGradient(colors: [Brand.accentHi.opacity(0.55), .clear], center: .center, startRadius: 0, endRadius: 180)).frame(width: 360, height: 360).blur(radius: 20).opacity(t ? 1 : 0)
      VStack(spacing: 22) {
        BrandMark(size: 96).scaleEffect(reduce ? 1 : (t ? 1 : 0.4)).rotationEffect(.degrees(reduce || t ? 0 : -25)).opacity(t ? 1 : 0)
          .shadow(color: Brand.accentHi.opacity(0.8), radius: t ? 30 : 0)
        VStack(spacing: 8) {
          Text(T("欢迎使用启付", "Welcome to Kipurse")).font(.largeTitle.bold()).foregroundStyle(.white)
          Text(T("AI 帮你付钱，你说了算", "Your AI pays, you decide")).font(.headline).foregroundStyle(.white.opacity(0.75))
        }.opacity(text ? 1 : 0).offset(y: reduce || text ? 0 : 14)
      }
      VStack { HStack { Spacer(); Button { done() } label: { Text(T("跳过", "Skip")).font(.subheadline.weight(.semibold)).foregroundStyle(.white.opacity(0.8)).padding(.horizontal, 20).frame(minWidth: 64, minHeight: 44).background(.white.opacity(0.12), in: Capsule()).contentShape(Capsule()) }.buttonStyle(Pressable()).accessibilityIdentifier("welcome.skip") }.padding(.horizontal, 20); Spacer() }
    }
    .contentShape(Rectangle()).onTapGesture { done() }
    .accessibilityElement(children: .contain).accessibilityIdentifier("welcome")
    .onAppear {
      withAnimation(reduce ? .easeIn(duration: 0.4) : .spring(response: 0.7, dampingFraction: 0.62)) { t = true }
      rings = true
      withAnimation(.easeOut(duration: 0.6).delay(reduce ? 0.2 : 0.55)) { text = true }
      DispatchQueue.main.asyncAfter(deadline: .now() + (CommandLine.arguments.contains("-kpWelcomeHold") ? 30 : CommandLine.arguments.contains("-kpWelcomeSlow") ? 8 : 2.6)) { done() }
    }
  }
}


/// t1268 (decision 133, locked rule 0A #2): the key proof a "bind" sign-in still owes (no Face ID at sign-in). The first action that needs
/// Face ID on this phone (turning on Face ID approvals) proves it with that same Face ID, so the server writes the 30-day read grant and the
/// enrollment's owner check passes. Holds no secret beyond the sign-in poll token; cleared when used or after 30 days.
enum OwedSigninProof {
  private static let key = "kp.owedSigninProof"
  struct P: Codable { let id, poll, digest, x, y: String; let at: Double }
  static func save(id: String, poll: String, digest: String, x: [UInt8], y: [UInt8]) {
    guard SigninKeyProof.validId(id), let d = try? JSONEncoder().encode(P(id: id, poll: poll, digest: digest, x: Hex.encode(x), y: Hex.encode(y), at: Date().timeIntervalSince1970)) else { return }
    UserDefaults.standard.set(d, forKey: key)
  }
  static var pending: P? {
    guard let d = UserDefaults.standard.data(forKey: key), let p = try? JSONDecoder().decode(P.self, from: d) else { return nil }
    if Date().timeIntervalSince1970 - p.at > 30 * 86400 { clear(); return nil }
    return p
  }
  static func clear() { UserDefaults.standard.removeObject(forKey: key) }
  /// Proves the owed key with ONE Face ID (the given evaluated context, else one now) and returns that context for the caller's next
  /// key use (no second prompt). nil = nothing owed / not proved (the caller just continues as before).
  @MainActor static func fulfill(reason: String) async -> LAContext? {
    guard let p = pending else { return nil }
    guard SigninKeyProof.serverDigestMatches(p.digest, id: p.id), let px = Hex.decode(p.x), let py = Hex.decode(p.y) else { clear(); return nil }
    guard let c = await BiometricGate.unlockContext(reason: reason) else { return nil }
    guard let k = PhoneKey.existing(context: c), let xy = PhoneKey.xy(k), xy.0 == px, xy.1 == py else { clear(); return c }
    do { let (r, s) = try PhoneKey.sign(SigninKeyProof.digest(id: p.id), key: k, reusesUnlock: true)
      _ = try await SigninAPI.post("signin/prove", ["id": p.id, "poll": p.poll, "r": Hex.encode(r), "s": Hex.encode(s)]); clear() }
    catch { AuthLog.record("signin-prove-owed", error); if (error as NSError).code == 400 || (error as NSError).code == 404 { clear() } }
    return c
  }
}
