import SwiftUI
import WebKit
import KipurseCore

/// PRIMARY way to add money (owner 2026-10-27): Apple Pay through Coinbase guest checkout. Coinbase buys USDC and sends it
/// straight to THIS Kipurse wallet on Base (the server sets the address); it never goes into a Coinbase account.
/// Coinbase rules: US only, a real US mobile number + email checked with a code, accept Coinbase's terms. "Arrived" only after verification.
struct ApplePayBuySheet: View {
  @EnvironmentObject var m: AppModel
  @Environment(\.dismiss) private var dismiss
  enum Step: Equatable { case loading, unavailable(String), needsVerify, terms, contact, amount, paying(URL, String), status(String) }
  @State private var step: Step = .loading
  @State private var agreedAt: Date?
  @State private var phone = ""
  @State private var email = ""
  @State private var phoneCode = ""
  @State private var emailCode = ""
  @State private var phoneSent = false
  @State private var emailSent = false
  @State private var phoneOK = false
  @State private var emailOK = false
  @State private var amount = 20
  @State private var busy = false
  @State private var err: String?
  @State private var state: OnrampState = .checking
  @StateObject private var cbv = CBVerifyModel()
  var mock: Bool {
    #if DEBUG
    return m.demo != nil && CommandLine.arguments.contains("-kpApplePayMock")
    #else
    return false
    #endif
  }
  func post(_ path: String, _ body: [String: Any]) async -> (Int, [String: Any])? {
    #if DEBUG
    if mock {
      try? await Task.sleep(nanoseconds: 300_000_000)
      switch path {
      case "info": return (200, ["ok": true, "mode": CommandLine.arguments.contains("-kpApplePayOff") ? "off" : "sandbox", "phoneVerified": false, "emailVerified": false])
      case "order": return (200, ["ok": true, "ref": "sandbox-kp-0123456789abcdef01234567", "url": "https://pay.coinbase.com/v2/api-onramp/apple-pay?demo=1&useApplePaySandbox=true", "sandbox": true])
      case "status": return (200, ["ok": true, "state": "arrived", "amount": "19.40", "txHash": "0x" + String(repeating: "cd", count: 32)])
      default: return (200, ["ok": true])
      }
    }
    #endif
    return try? await MainnetSession.authedPost("phone/onramp/applepay/" + path, body)
  }
  var body: some View {
    NavigationStack {
      ScrollView { VStack(alignment: .leading, spacing: 16) {
        Label(T("用 Apple Pay 买 USDC", "Buy USDC with Apple Pay"), systemImage: "applelogo").font(.title3.bold())
        switch step {
        case .loading: ProgressView().frame(maxWidth: .infinity)
        case .needsVerify:   // t635u: every purchase needs the owner's Coinbase Verified Account attestation (server enforces it)
          Text(T("先完成一次 Coinbase 认证，就能用 Apple Pay 买。提现和暂停永远不需要认证。", "Finish a one-time Coinbase verification to buy with Apple Pay. Withdrawing and pausing never need it.")).font(.body).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("applepay.needsVerify")
          CBVerifyGuide(v: cbv)
            .onChange(of: cbv.status) { s in if s == .verified { withAnimation { step = .terms } } }
        case .unavailable(let why):
          Label(why, systemImage: "info.circle").font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("applepay.unavailable")
        case .terms:
          Text(T("Coinbase 处理付款：买到的 USDC 由 Coinbase 直接发送到你的 Kipurse 钱包（Base 网络），不经过 Coinbase 账户，也不用登录 Coinbase。目前只支持美国手机号和美国的卡。", "Coinbase handles the payment and sends the USDC straight to your Kipurse wallet on Base. No Coinbase account or sign-in. US phone numbers and US cards only for now.")).font(.subheadline).fixedSize(horizontal: false, vertical: true)
          VStack(alignment: .leading, spacing: 4) {
            Link(T("Coinbase 访客结账条款", "Coinbase Guest Checkout Terms"), destination: URL(string: "https://www.coinbase.com/legal/guest-checkout/us")!)
            Link(T("Coinbase 用户协议", "Coinbase User Agreement"), destination: URL(string: "https://www.coinbase.com/legal/user_agreement")!)
            Link(T("Coinbase 隐私政策", "Coinbase Privacy Policy"), destination: URL(string: "https://www.coinbase.com/legal/privacy")!)
          }.font(.footnote)
          BigButton(T("我同意，继续", "I agree, continue"), icon: "checkmark") { agreedAt = Date(); step = (phoneOK && emailOK) ? .amount : .contact }.accessibilityIdentifier("applepay.agree")
        case .contact:
          Text(T("Coinbase 要求先验证手机号和邮箱（每 60 天一次）。", "Coinbase needs your phone and email checked once (every 60 days).")).font(.subheadline).foregroundStyle(.secondary)
          contactRow(T("美国手机号", "US mobile number"), text: $phone, code: $phoneCode, sent: $phoneSent, ok: phoneOK, id: "phone", keyboard: .phonePad, channel: "sms")
          contactRow(T("邮箱", "Email"), text: $email, code: $emailCode, sent: $emailSent, ok: emailOK, id: "email", keyboard: .emailAddress, channel: "email")
          if phoneOK && emailOK { BigButton(T("下一步", "Next"), icon: "arrow.right") { step = .amount }.accessibilityIdentifier("applepay.next") }
        case .amount:
          Text(T("买多少？", "How much?")).font(.subheadline.weight(.semibold))
          HStack { ForEach([5, 20, 50, 100], id: \.self) { a in Button("$\(a)") { amount = a }.buttonStyle(.bordered).tint(amount == a ? Brand.accent : .secondary).accessibilityIdentifier("applepay.amount.\(a)") } }
          Text(T("Coinbase 会收服务费和网络费，Apple Pay 里会显示到手多少 USDC。", "Coinbase charges a fee and a network fee; Apple Pay shows how much USDC you get.")).font(.footnote).foregroundStyle(.secondary)
          BigButton(busy ? T("正在准备…", "Preparing…") : T("用 Apple Pay 付 $\(amount)", "Pay $\(amount) with Apple Pay"), icon: "applelogo") { Task { await order() } }.disabled(busy).accessibilityIdentifier("applepay.order")
        case .paying(let u, let ref):
          Text(T("点下面的 Apple Pay 按钮付款。", "Tap the Apple Pay button below.")).font(.subheadline)
          if mock {
            Button(T("（演示）完成 Apple Pay", "(demo) Complete Apple Pay")) { step = .status(ref) }.buttonStyle(.borderedProminent).accessibilityIdentifier("applepay.demoPay")
          } else {
            OnrampPayWebView(url: u) { e in
              switch e {
              case .started, .done: step = .status(ref)
              case .canceled: err = T("已取消，没有付款。", "Canceled. Nothing was paid.")
              case .error(let s): err = s
              case .loaded: break
              }
            }.frame(height: 120).accessibilityIdentifier("applepay.web")
          }
        case .status(let ref): statusView.task { await poll(ref) }
        }
        if let err { Label(err, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(Brand.negative).accessibilityIdentifier("applepay.error") }
      }.padding(20) }
      .background(Brand.canvas)
      .navigationTitle(T("买 USDC", "Buy USDC")).navigationBarTitleDisplayMode(.inline)
      .toolbar { Button(state.isFinal ? T("完成", "Done") : T("关闭", "Close")) { dismiss() }.accessibilityIdentifier("applepay.close") }
    }
    .task { await load() }
  }
  @ViewBuilder func contactRow(_ title: String, text: Binding<String>, code: Binding<String>, sent: Binding<Bool>, ok: Bool, id: String, keyboard: UIKeyboardType, channel: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack { Text(title).font(.subheadline.weight(.semibold)); if ok { Image(systemName: "checkmark.seal.fill").foregroundStyle(Brand.positive).accessibilityIdentifier("applepay.\(id).ok") } }
      if !ok {
        TextField(title, text: text).keyboardType(keyboard).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder).accessibilityIdentifier("applepay.\(id)")
        if sent.wrappedValue {
          TextField(T("收到的验证码", "Code you received"), text: code).keyboardType(.numberPad).textFieldStyle(.roundedBorder).accessibilityIdentifier("applepay.\(id).code")
          Button(T("确认验证码", "Confirm code")) { Task { await submit(channel, code.wrappedValue) } }.buttonStyle(.borderedProminent).accessibilityIdentifier("applepay.\(id).submit")
        } else {
          Button(T("发送验证码", "Send code")) { Task { await start(channel, text.wrappedValue) } }.buttonStyle(.bordered).accessibilityIdentifier("applepay.\(id).send")
        }
      }
    }
  }
  var statusView: some View {
    VStack(alignment: .leading, spacing: 10) {
      switch state {
      case .arrived(let a, let tx):
        Label(T("已到账", "Arrived") + (a.map { " +\($0) USDC" } ?? ""), systemImage: "checkmark.circle.fill").font(.title3.bold()).foregroundStyle(Brand.positive).accessibilityIdentifier("applepay.arrived")
        if let tx { DisclosureGroup(T("查看交易", "Show transaction")) { Text(tx).font(.caption.monospaced()).textSelection(.enabled) }.font(.caption) }
      case .arriving(let a):
        HStack { ProgressView(); Text(T("到账中", "Arriving") + (a.map { " +\($0) USDC" } ?? "")).font(.headline) }.accessibilityIdentifier("applepay.arriving")
      case .failed: Label(T("没有成功，钱没有到钱包。如果扣了款，Coinbase 会退回。", "It didn't go through and nothing reached your wallet. If you were charged, Coinbase refunds it."), systemImage: "xmark.octagon.fill").foregroundStyle(Brand.negative).accessibilityIdentifier("applepay.failed")
      case .wrongDestination: Label(T("警告：这笔不是发到你的 Kipurse 钱包，请立刻联系我们。", "Warning: this was not sent to your Kipurse wallet. Contact us now."), systemImage: "exclamationmark.triangle.fill").foregroundStyle(Brand.negative)
      default: HStack { ProgressView(); Text(T("正在确认到账…", "Checking arrival…")).font(.headline) }.accessibilityIdentifier("applepay.checking")
      }
    }
  }
  func load() async {
    guard let (c, j) = await post("info", [:]), c == 200, let mode = j["mode"] as? String else { step = .unavailable(T("现在连不上服务器，请稍后再试。", "Can't reach the server. Try again later.")); return }
    if mode == "off" { step = .unavailable(T("申请中：我们正在向 Coinbase 申请开通 Apple Pay 充值，批准后这里才能用。现在不会扣钱，请先用「Coinbase 充值」。", "Applying: we're applying to Coinbase to turn on Apple Pay top-up. It works here only after approval. Nothing is charged; use Coinbase Top Up for now.")); return }
    phoneOK = j["phoneVerified"] as? Bool == true; emailOK = j["emailVerified"] as? Bool == true
    if !(mock && !CBVerifyModel.testing) { await cbv.check(); if cbv.status != .verified { step = .needsVerify; return } }
    step = .terms
  }
  func start(_ ch: String, _ v: String) async {
    err = nil; let d = ch == "sms" ? ApplePayOnramp.validPhone(v) : (ApplePayOnramp.validEmail(v) ? v.trimmingCharacters(in: .whitespaces) : nil)
    guard let d else { err = ch == "sms" ? T("请输入美国手机号（10 位）。", "Enter a 10-digit US mobile number.") : T("邮箱格式不对。", "That email doesn't look right."); return }
    let vs = await post("verify/start", ["channel": ch, "destination": d]); if vs?.0 == 403 || vs?.1["error"] as? String == "not_verified" { step = .needsVerify; return }
    guard let (c, j) = vs, c == 200, j["ok"] as? Bool == true else { err = T("验证码没发出去，请检查后重试。", "Couldn't send the code. Check and try again."); return }
    if ch == "sms" { phoneSent = true } else { emailSent = true }
  }
  func submit(_ ch: String, _ code: String) async {
    err = nil
    guard let (c, j) = await post("verify/submit", ["channel": ch, "code": code.filter(\.isNumber)]), c == 200, j["ok"] as? Bool == true else { err = T("验证码不对或已过期。", "Wrong or expired code."); return }
    if ch == "sms" { phoneOK = true } else { emailOK = true }
  }
  func order() async {
    busy = true; defer { busy = false }; err = nil
    guard let at = agreedAt else { step = .terms; return }
    let od = await post("order", ["amount": amount, "agreedAt": ISO8601DateFormatter().string(from: at)]); if od?.0 == 403 || od?.1["error"] as? String == "not_verified" { step = .needsVerify; return }
    if od?.0 == 503, od?.1["error"] as? String == "verify_unavailable" { err = T("暂时无法确认 Coinbase 验证状态，没有扣钱。请稍后再试。", "Couldn't check your Coinbase verification right now. Nothing was charged. Try again shortly."); return }
    guard let (c, j) = od, c == 200, j["ok"] as? Bool == true, let u = ApplePayOnramp.payURL(j), let ref = j["ref"] as? String else {
      err = T("现在没法用 Apple Pay 直接买（Coinbase 拒绝或还没开通）。钱没有动。", "Apple Pay direct buying isn't available right now (Coinbase declined or not enabled). No money moved."); return }
    step = .paying(u, ref)
  }
  func poll(_ ref: String) async {
    for _ in 0..<180 {
      if let (c, j) = await post("status", ["ref": ref]) { let s = OnrampState.parse(c, j, secondsSinceReturn: 0); withAnimation { state = s }; if s.isFinal { if case .arrived = s { Haptics.success(); await m.refresh() }; return } }
      try? await Task.sleep(nanoseconds: 4_000_000_000); if Task.isCancelled { return }
    }
  }
}

/// Coinbase's Apple Pay button page in a WKWebView; events arrive on window.webkit.messageHandlers.cbOnramp.
struct OnrampPayWebView: UIViewRepresentable {
  let url: URL
  let onEvent: (ApplePayOnramp.Event) -> Void
  func makeCoordinator() -> Coord { Coord(onEvent) }
  func makeUIView(context: Context) -> WKWebView {
    let cfg = WKWebViewConfiguration(); cfg.userContentController.add(context.coordinator, name: "cbOnramp")
    let w = WKWebView(frame: .zero, configuration: cfg); w.isOpaque = false; w.load(URLRequest(url: url)); return w
  }
  func updateUIView(_ v: WKWebView, context: Context) {}
  static func dismantleUIView(_ v: WKWebView, coordinator: Coord) { v.configuration.userContentController.removeScriptMessageHandler(forName: "cbOnramp") }
  final class Coord: NSObject, WKScriptMessageHandler {
    let onEvent: (ApplePayOnramp.Event) -> Void
    init(_ f: @escaping (ApplePayOnramp.Event) -> Void) { onEvent = f }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { guard m.name == "cbOnramp", let e = ApplePayOnramp.event(m.body) else { return }; DispatchQueue.main.async { self.onEvent(e) } }
  }
}
