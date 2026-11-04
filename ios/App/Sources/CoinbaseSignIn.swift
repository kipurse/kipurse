import SwiftUI
import Security
import KipurseCore

/// First screen of every new install: "用 Coinbase 登录". The user's Coinbase wallet is the identity; the leftover phone key in the
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
  func start(_ m: AppModel) async {
    phase = .opening
    #if DEBUG   // UI tests: the page's answer without network or signing
    if let i = CommandLine.arguments.firstIndex(of: "-kpSigninMock"), i + 1 < CommandLine.arguments.count {
      let o = CommandLine.arguments[i + 1], w = o == "new" ? "null" : "\"0x2000000000000000000000000000000000000002\""
      if let r = CoinbaseIdentity.Result(try? JSONDecoder().decode(JSONValue.self, from: Data(#"{"state":"done","result":"\#(o)","owner":"0x1000000000000000000000000000000000000003","wallet":\#(w)}"#.utf8))) {
        try? await Task.sleep(nanoseconds: 300_000_000); await finish(m, r) }
      return
    }
    #endif
    var body: [String: Any] = [:]
    if PhoneKey.isPresent(), let k = PhoneKey.existing(), let (x, y) = PhoneKey.xy(k) { body = ["x": Hex.encode(x), "y": Hex.encode(y)] }   // public key only, no Face ID
    else if OnboardAPI.on, let (x, y) = try? OnboardAPI.key() { body = ["x": Hex.encode(x), "y": Hex.encode(y)] }                        // fresh key (no Face ID to create)
    if OnboardAPI.on, body["x"] != nil, let s = CoinbaseIdentity.presetSetup { body["setup"] = s }   // t603u: no preset; a NEW account picks its own limits in the guided step
    do {
      let r = try await SigninAPI.post("signin/start", body)
      guard let id = r["id"] as? String, let poll = r["poll"] as? String, let u = (r["url"] as? String).flatMap(URL.init(string:)), u.host == Mainnet.base.host else { phase = .failed(T("服务器回应不对。", "Unexpected server reply.")); return }
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
  private func opened(_ m: AppModel, _ r: CoinbaseIdentity.Result, wallet w: String) async {
    UserDefaults.standard.set(r.owner, forKey: CoinbaseIdentity.ownerKey)
    Operator.setWallet(w, owner: r.owner, path: "/t/" + w.lowercased())
    FirstUse.reset(); Haptics.success(); phase = .reconnecting
    m.identityVerified(); m.mainNeedsSignIn = true; await m.mainSignIn()
    if m.state == nil { phase = .idle }
  }
  private func finish(_ m: AppModel, _ r: CoinbaseIdentity.Result) async {
    UserDefaults.standard.set(r.owner, forKey: CoinbaseIdentity.ownerKey)
    switch r.outcome {
    case .reconnect:   // same person, same phone: reuse the key and the wallet. No re-binding, no fee.
      Operator.setWallet(r.wallet, owner: r.owner, path: r.path ?? "")
      m.identityVerified(); phase = .reconnecting
      await m.mainSignIn()   // ONE Face ID: the phone key opens the session
      if m.state == nil { phase = .idle }
    case .bind where PhoneKey.isPresent() && !Unbound.isMockSignin:   // t849: verified owner, this phone's key isn't the approver yet -> read-only session, full wallet home
      Unbound.remember(wallet: r.wallet, path: r.path)
      Operator.setWallet(r.wallet, owner: r.owner, path: r.path ?? "")
      m.identityVerified(); phase = .reconnecting
      await m.mainSignIn()
      if m.state == nil { phase = .next(.bind) }
    case .new, .bind:      // the stale key is never used: put it aside; onboarding creates a fresh one
      if r.outcome == .bind { Unbound.remember(wallet: r.wallet, path: r.path) }   // the emergency page (no phone) still knows the wallet
      PhoneKey.retire(); Operator.setWallet(nil); UserDefaults.standard.set(r.owner, forKey: CoinbaseIdentity.ownerKey)
      Haptics.success(); phase = .next(r.outcome)
    }
  }
}

struct CoinbaseSignInView: View {
  @EnvironmentObject var m: AppModel
  @StateObject private var f = CoinbaseSignInFlow()
  @State private var showNoCB = false
  var body: some View {
    ScrollView {
      VStack(spacing: 18) {
        BrandMark(size: 64).padding(.top, 40)
        switch f.phase {
        case .next(let o): next(o)
        case .reconnecting: ProgressView(T("好了，正在打开你的钱包…", "Done. Opening your wallet…")).padding(.top, 20)
        default: signIn
        }
      }.padding(.horizontal, 24).padding(.bottom, 30)
    }.background(Brand.canvas)
  }
  /// t853: the start screen is two big choices only. Details live in the register screen, shown only when needed.
  @ViewBuilder var signIn: some View {
    Text(T("启付", "Kipurse")).font(.largeTitle.bold()).accessibilityIdentifier("cb.title")
    Text(T("AI 帮你付钱，你说了算", "Your AI pays, you decide")).font(.subheadline).foregroundStyle(.secondary)
    if m.loginExpired { Text(Unbound.loginExpiredText).font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("cb.expired") }
    if case .failed(let e) = f.phase {   // t810: calm text + retry (reruns the full strict check; no bypass)
      Text(e).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).accessibilityIdentifier("cb.failed")
      Button(T("重试", "Retry")) { Task { await f.start(m) } }.font(.subheadline.weight(.semibold)).tint(Brand.accent).accessibilityIdentifier("cb.retry")
    }
    VStack(spacing: 14) {
      NavigationLink { RegisterIntroView(f: f) } label: {
        Label(T("新用户注册", "New here? Sign up"), systemImage: "sparkles").font(.title3.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 60)
      }.buttonStyle(.borderedProminent).controlSize(.large).kGlow().accessibilityIdentifier("cb.register")
      Button { Task { await f.start(m) } } label: {
        Label(f.phase == .opening ? T("正在打开…", "Opening…") : T("老用户登录", "I have an account: Sign in"), systemImage: "person.crop.circle.badge.checkmark").font(.title3.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 60)
      }.buttonStyle(.bordered).controlSize(.large).disabled(f.phase == .opening).accessibilityIdentifier("cb.signin")
    }.padding(.top, 24)
    if f.phase == .waiting { Text(T("在弹出的页面里登录 Coinbase 并确认，完成后会自动回来。", "Sign in to Coinbase on the page that opens. You'll come back here automatically.")).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
    if f.phase == .waiting, let p = f.pair { VStack(spacing: 4) { Text(T("配对码", "Pairing code")).font(.caption).foregroundStyle(.secondary); Text(p).font(.system(size: 34, weight: .bold, design: .monospaced)).accessibilityIdentifier("cb.pair"); Text(T("网页上必须显示同样的号码。不一样就别继续。", "The web page must show the same number. If it doesn't, stop.")).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center) } }
    Spacer(minLength: 28)
    if let u = Unbound.emergencyURL(base: Mainnet.base, wallet: Unbound.wallet, path: UserDefaults.standard.string(forKey: Unbound.pathKey)) {   // t927: kept (withdraw-even-if-server-down rule), calmer label, only when this phone knows a wallet
      Button { m.emergencyFirst = u } label: { Label(Unbound.emergencyLabel, systemImage: "lifepreserver") }.font(.footnote).tint(.secondary).accessibilityIdentifier("unbound.emergency").accessibilityValue(u.absoluteString)
    }
    Button(T("先看看演示", "Try the demo")) { m.startDemo() }.font(.footnote).tint(.secondary).accessibilityIdentifier("gate.demo")
  }
  @ViewBuilder func next(_ o: CoinbaseIdentity.Outcome) -> some View {
    Label(T("已登录", "Signed in"), systemImage: "checkmark.seal.fill").font(.title2.bold()).foregroundStyle(Brand.positive).accessibilityIdentifier("cb.done")
    Text(o == .new ? T("这个 Coinbase 账户还没有启付钱包。下一步：设好 AI 付款上限，开启 Face ID 批准。", "This Coinbase account has no Kipurse wallet yet. Next: set AI limits and turn on Face ID approvals.")
                   : T("这个 Coinbase 账户已经有启付钱包。在这台 iPhone 上开启 Face ID 批准，就能继续用。", "This Coinbase account already has a Kipurse wallet. Turn on Face ID approvals on this iPhone to keep using it."))
      .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
    Text(o == .new ? T("只需确认一次（Face ID）。" + Beginner.openingFeeZh, "Just one confirmation (Face ID). " + Beginner.openingFeeEn)
                   : T("需要一次确认（Face ID）。开通费约 0.03 USDC，从启付钱包余额扣，不需要 ETH。", "One signature (Face ID). Setup fee about 0.03 USDC from your Kipurse wallet balance; no ETH needed."))
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
      VStack { HStack { Spacer(); Button(T("跳过", "Skip")) { done() }.font(.subheadline.weight(.semibold)).foregroundStyle(.white.opacity(0.8)).padding(.horizontal, 16).padding(.vertical, 8).background(.white.opacity(0.12), in: Capsule()).accessibilityIdentifier("welcome.skip") }.padding(.horizontal, 20); Spacer() }
    }
    .contentShape(Rectangle()).onTapGesture { done() }
    .accessibilityElement(children: .contain).accessibilityIdentifier("welcome")
    .onAppear {
      withAnimation(reduce ? .easeIn(duration: 0.4) : .spring(response: 0.7, dampingFraction: 0.62)) { t = true }
      rings = true
      withAnimation(.easeOut(duration: 0.6).delay(reduce ? 0.2 : 0.55)) { text = true }
      DispatchQueue.main.asyncAfter(deadline: .now() + (CommandLine.arguments.contains("-kpWelcomeHold") ? 30 : 2.6)) { done() }
    }
  }
}
