import SwiftUI
import KipurseCore
import BackgroundTasks

@main
struct KipurseApp: App {
  @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
  @StateObject private var model = AppModel()
  @StateObject private var pay = PayDraftCenter.shared
  @Environment(\.scenePhase) private var phase
  /// t653u: dark "indigo night" is the default look; light look is an opt-in in Settings.
  init() {
    #if KP_ASSISTANT
    AssistantModule.install()   // optional Siri / Spotlight module (App/Assistant)
    #endif
    AppModel.registerBackgroundPoll(); AssistantHooks.launch?()
  }   // re-register phrases (incl. payee names) on every launch
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(model).environment(\.openURL, InApp.action).preferredColorScheme(CommandLine.arguments.contains("-kpDark") ? .dark : CommandLine.arguments.contains("-kpLight") ? .light : nil)   // t927: follow the system
        .overlay { if model.privacyCover && !model.locked { Rectangle().fill(.ultraThickMaterial).ignoresSafeArea().overlay(Image(systemName: "lock.fill").font(.largeTitle).foregroundStyle(.secondary)).accessibilityIdentifier("privacy.cover") } }   // app switcher shows no balances
        .onOpenURL { model.handle(url: $0) }
        .sheet(item: $model.oauthReq) { r in OAuthApproveSheet(req: r).environmentObject(model) }
        .fullScreenCover(item: $model.trustReq) { r in PhoneApproveTrustSheet(req: r).environmentObject(model) }
        .sheet(isPresented: $model.bindSheet) { NavigationStack { BindPhoneFlow() }.environmentObject(model) }   // kipurse://bind, "去绑定"
        .sheet(item: $model.connectReq) { r in ApproveConnectSheet(req: r).environmentObject(model).interactiveDismissDisabled() }                      // kipurse://login?... and kipurse://done?step=...
        .sheet(item: $pay.draft) { d in PayConfirmSheet(draft: d).environmentObject(model).interactiveDismissDisabled() }
        .onChange(of: phase) { p in model.scenePhase(p) }
        .task {
          #if DEBUG
          if CommandLine.arguments.contains("-kpGasGate") || CommandLine.arguments.contains("-kpGasGateLow") { try? await Task.sleep(nanoseconds: 1_200_000_000); model.gasGate = GasGate(url: URL(string: Mainnet.server.appendingPathComponent("phone/enroll").absoluteString + (CommandLine.arguments.contains("-kpGasEth") ? "" : "?id=demo") + (CommandLine.arguments.contains("-kpGasSiri") ? "&kpmode=siri" : ""))!, kind: .phoneUpgrade) {} }   // simulator screenshots of the fee preflight
          if CommandLine.arguments.contains("-kpPayDraft") { try? await Task.sleep(nanoseconds: 1_200_000_000); pay.draft = PayDraft(amount: 5_000_000, payee: .init(address: "0x1000000000000000000000000000000000000003", name: "Example Shop")) }
          #endif
        }
    }
  }
}

struct RootView: View {
  @EnvironmentObject var m: AppModel
  @State private var prompts = 0
  /// t853: once per install; UI tests only see it when they ask (-kpWelcome).
  @State private var showWelcome: Bool = {
    let a = CommandLine.arguments
    if a.contains("-kpWelcome") { return true }
    if a.contains("-demo") || a.contains(where: { $0.hasPrefix("-kp") }) { return false }
    return !UserDefaults.standard.bool(forKey: WelcomeIntro.seenKey)
  }()
  @ObservedObject var allow = AllowanceStore.shared
  var body: some View {
    VStack(spacing: 0) {
      #if DEBUG
      if !m.wipeReport.isEmpty { Text(m.wipeReport).font(.system(size: 1)).opacity(0.01).accessibilityIdentifier("debug.wipe") }
      if m.demo != nil && !m.lastLaunch.isEmpty { Text(m.lastLaunch).font(.system(size: 1)).opacity(0.01).accessibilityIdentifier("debug.launch") }
      Text("prompts:\(prompts)").font(.system(size: 1)).opacity(0.01).accessibilityHidden(!CommandLine.arguments.contains("-kpUITest") && !ProcessInfo.processInfo.environment.keys.contains("XCTestConfigurationFilePath")).accessibilityIdentifier("debug.prompts").onReceive(NotificationCenter.default.publisher(for: .init("kpPrompt"))) { _ in prompts = PromptLog.count }
      if m.faceTest { Text(m.faceTestResult.isEmpty ? "facetest: waiting" : m.faceTestResult).font(.caption.monospaced()).accessibilityIdentifier("debug.facetest") }
      #endif
      if m.demo != nil {   // every demo screen: sample data, never a real account
        HStack(spacing: 10) {
          Label(T("演示模式 · 示例数据", "Demo · sample data"), systemImage: "theatermasks.fill")
            .font(.footnote.weight(.semibold)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel(T("演示模式 · 全部是示例数据，不是真实账户", "Demo mode · all sample data, not a real account")).accessibilityIdentifier("demo.banner")
          Button { m.exitDemo() } label: { Text(T("退出演示", "Exit demo")).font(.footnote.weight(.semibold)).padding(.horizontal, 12).padding(.vertical, 6) }
            .buttonStyle(.plain).foregroundStyle(Brand.accent).background(Brand.accentSoft, in: Capsule()).frame(minHeight: 44).accessibilityIdentifier("demo.exit")
        }.padding(.horizontal, 16).padding(.vertical, 2).background(.ultraThinMaterial)
      }
      Group {
        if m.locked { LockView() }
        else if let d = m.demo { demoView(d) }
        else if m.state != nil { HomeView() } else if m.needsCoinbase { NavigationStack { CoinbaseSignInView() } } else { NavigationStack { MainnetGate() } }
      }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .background(Brand.canvas.ignoresSafeArea())
    .tint(Brand.accent)
    .sheet(item: $m.webSheet) { w in SignPage(url: w.url).ignoresSafeArea() }
    .sheet(isPresented: $m.showRescueGuide) { NavigationStack { RescueGuideView().toolbar { Button(T("关闭", "Close")) { m.showRescueGuide = false }.accessibilityIdentifier("rescue.close") } }.environmentObject(m) }   // t821
    .sheet(item: $m.onrampTrack) { t in OnrampStatusSheet(track: t).environmentObject(m) }
    .sheet(isPresented: Binding(get: { m.emergencyFirst != nil }, set: { if !$0 { m.emergencyFirst = nil } })) { if let u = m.emergencyFirst { EmergencyFirstSheet(url: u).environmentObject(m) } }
    .sheet(isPresented: Binding(get: { m.emergencyOffline != nil }, set: { if !$0 { m.emergencyOffline = nil } })) { if let u = m.emergencyOffline { EmergencyOfflineSheet(url: u).environmentObject(m) } }
    .sheet(isPresented: Binding(get: { m.afterErase != nil }, set: { if !$0 { m.afterErase = nil } })) { if let s = m.afterErase { NavigationStack { MainWithdrawView(s: s).toolbar { Button(L("完成")) { m.afterErase = nil }.accessibilityIdentifier("afterErase.done") } } } }
    .sheet(isPresented: $m.museSheet) { MuseConnectSheet().environmentObject(m) }
    .sheet(isPresented: $allow.open) { AllowancesSheet() }
    .sheet(item: $m.gasGate) { g in GasPreflightSheet(gate: g).environmentObject(m).interactiveDismissDisabled() }
    .sheet(isPresented: $m.showRecovery) { if let g = m.recovery { NavigationStack { RecoveryGuideView(g: g).toolbar { Button(L("完成")) { m.showRecovery = false } } } } }
    // t691: notes sit at the top under the demo banner (over the page title, never over list rows like Siri) and never block taps.
    .overlay(alignment: .top) { if let t = m.toast { Text(t).font(.subheadline.weight(.semibold)).foregroundStyle(.white).multilineTextAlignment(.center).padding(.horizontal, 18).padding(.vertical, 10).background(.black.opacity(0.86), in: Capsule()).padding(.horizontal, 24).padding(.top, m.demo != nil ? 54 : 8).allowsHitTesting(false).accessibilityIdentifier("app.toast").transition(.move(edge: .top).combined(with: .opacity)).task { try? await Task.sleep(nanoseconds: 2_500_000_000); withAnimation { m.toast = nil } } } }
    .animation(Brand.spring, value: m.toast)
    .overlay { if m.authOverlayShown { AuthOverlay().transition(.opacity) } }
    .overlay { if showWelcome { WelcomeIntro { withAnimation(.easeOut(duration: 0.35)) { showWelcome = false }; UserDefaults.standard.set(true, forKey: WelcomeIntro.seenKey) }.transition(.opacity).zIndex(10) } }
    .animation(.easeInOut(duration: 0.25), value: m.authOverlayShown)
    .onChange(of: m.phoneSignerChanged) { v in if let v { m.toast = v; m.phoneSignerChanged = nil } }
    .onReceive(NotificationCenter.default.publisher(for: .kpDemoNote)) { n in if m.demo != nil, let t = n.object as? String { m.toast = t } }
    .alert(item: $m.alert) { a in Alert(title: Text(a.title), message: Text(a.message), dismissButton: .default(Text(L("好")))) }
  }
  @ViewBuilder private func demoView(_ d: String) -> some View {
    switch d {
    case "onboarding": OnboardingView()
    case "setup": NavigationStack { SetupWizard() }
    default: HomeView()
    }
  }
}

struct LockView: View {
  @EnvironmentObject var m: AppModel
  var body: some View {
    VStack(spacing: 20) {
      Spacer()
      BrandMark(size: 72)
      Text(L("Kipurse 已锁定")).font(.title2.bold())
      Text(L("用 Face ID 解锁后才能查看和操作钱包。")).font(.subheadline).foregroundStyle(.secondary)
      Spacer()
      BigButton(L("用 Face ID 解锁"), icon: "faceid") { Task { await m.unlock() } }.padding(.horizontal, 24).padding(.bottom, 32)
    }.frame(maxWidth: .infinity).background(Brand.canvas)
    .task { await m.unlock() }
  }
}
