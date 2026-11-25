import SwiftUI
import UIKit
import CryptoKit
import Security
import KipurseCore

// t821: "even if Kipurse stops". Calm banner, balance read straight from Base, an encrypted copy of recent activity,
// and a step-by-step guide to take ALL money back to the user's own Coinbase wallet. Every part has its FeatureSwitch.

/// Last wallet state, AES-GCM encrypted on this device (key in this app's Keychain, this device only). Wiped with every
/// LocalWipe (logout / delete account clear the Keychain and Library), so nothing survives account deletion.
enum LedgerCache {
  static let account = "kp.ledgercache.key.v1"
  static var file: URL { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("kp-ledger.cache") }
  static func key(create: Bool) -> SymmetricKey? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account, kSecReturnData as String: true]
    var out: CFTypeRef?
    if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data { return SymmetricKey(data: d) }
    guard create else { return nil }
    let k = SymmetricKey(size: .bits256); let d = k.withUnsafeBytes { Data($0) }
    let add: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account, kSecValueData as String: d,
                              kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? k : nil
  }
  struct Saved: Codable { let at: Date; let raw: JSONValue }
  static func save(_ s: WalletState) {
    guard FeatureSwitch.ledgerCache.on, !DemoGuard.active, let k = key(create: true), let d = try? JSONEncoder().encode(Saved(at: Date(), raw: s.raw)),
          let box = try? AES.GCM.seal(d, using: k).combined else { return }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? box.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
  static func load() -> (Date, WalletState)? {
    guard FeatureSwitch.ledgerCache.on, let k = key(create: false), let d = try? Data(contentsOf: file), let b = try? AES.GCM.SealedBox(combined: d),
          let p = try? AES.GCM.open(b, using: k), let s = try? JSONDecoder().decode(Saved.self, from: p) else { return nil }
    let ws = WalletState(s.raw)
    // t1238: never show another wallet's cached home (moved wallet / signed in to a different account)
    guard CacheGuard.usable(cachedWallet: ws.wallet, current: Operator.wallet) else { return nil }
    return (s.at, ws)
  }
  static func wipe() {
    try? FileManager.default.removeItem(at: file)
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account] as CFDictionary)
  }
}

enum RescueText {
  static var banner: String { T("暂时登不上启付？钱还在你自己的钱包里。查看「手机丢了怎么办」，了解用别的设备和 Coinbase 取回钱的步骤。", "Cannot sign in to Kipurse? Your money stays in your own wallet. See “Lost your phone?” for steps using another device and Coinbase.") }
  static var guideTitle: String { LostPhoneRecovery.title }
  static var guideLink: String { LostPhoneRecovery.title }
}

/// The user's wallet + the Coinbase wallet that owns it, from what this phone already knows (no server).
enum RescueIdentity {
  static var wallet: String? { let w = Operator.wallet; return !w.isEmpty ? w : Unbound.wallet }
  static var owner: String? { Operator.ownerAccount }
  /// After a reinstall the phone may not remember the owner: read the wallet's first owner (the Coinbase wallet set at setup) from the chain.
  static func resolveOwner(wallet: String) async -> String? {
    if let o = owner { return o }
    guard let r = await ChainRPC.ethCall(wallet, "0x8ea69029" + String(repeating: "0", count: 64), agreed: true) else { return nil }
    let h = r.lowercased().replacingOccurrences(of: "0x", with: "")
    guard h.count >= 192, let len = Int(h.dropFirst(64).prefix(64), radix: 16), len == 32 else { return nil }
    return VaultCheck.decode(String(h.dropFirst(128).prefix(64)))
  }
}

struct CalmBanner: View {
  @EnvironmentObject var m: AppModel
  var body: some View {
    Button { m.showRescueGuide = true } label: {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "lock.shield.fill").foregroundStyle(Brand.accent)
        VStack(alignment: .leading, spacing: 4) {
          Text(RescueText.banner).font(.footnote).foregroundStyle(.primary).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
          Text(RescueText.guideLink + " ›").font(.footnote.weight(.semibold)).foregroundStyle(Brand.accent)
        }
        Spacer(minLength: 0)
      }.padding(12).background(RoundedRectangle(cornerRadius: KP.Radius.control).fill(KP.surface))
    }.buttonStyle(.plain).padding(.horizontal, 16).padding(.top, 6).accessibilityElement(children: .combine).accessibilityIdentifier("calm.banner")
  }
}

/// Balance straight from Base (two public nodes must agree).
struct ChainBalanceRow: View {
  @EnvironmentObject var m: AppModel
  var body: some View {
    VStack(spacing: 4) {
      if let b = m.chainBalances {
        Text(AnswerRules.format(b.total) + " USDC").font(.title2.bold().monospacedDigit()).accessibilityIdentifier("chain.balance")
        Text(T("直接核对你钱包里的钱，不需要登录启付", "Checks the money in your wallet without a Kipurse sign-in")).font(.caption).foregroundStyle(.secondary)
        if b.pending > 0 { Text(T("其中 \(AnswerRules.format(b.pending)) USDC 是正在结算的付款，结算后也能提现", "\(AnswerRules.format(b.pending)) USDC is in payments still settling; you can take it back after they settle")).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center) }
      } else if m.chainLoading { ProgressView(T("正在查看你的钱包余额…", "Checking your wallet balance…")) }
      else if RescueIdentity.wallet != nil { Text(T("暂时查不到钱包余额，请检查网络后下拉刷新。你的钱不会因此受影响。", "We cannot check your wallet balance right now. Check your connection and try again. Your money is not affected.")).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
    }.task { await m.loadChainBalance() }
  }
}

/// Mainnet gate when the server can't be reached: calm words, the on-chain balance, last saved activity, the guide.
struct OfflineWalletCard: View {
  @EnvironmentObject var m: AppModel
  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "lock.shield").font(.system(size: 40)).foregroundStyle(Brand.accent)
      Text(RescueText.banner).font(.subheadline).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("offline.text")
      ChainBalanceRow()
      if let (at, s) = m.cachedState, case let rows = (s.raw["ledger"]?.array ?? []).compactMap(LedgerRow.init).filter({ !$0.suspicious }), !rows.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text(T("最近记录（本机保存于 ", "Recent activity (saved on this iPhone ") + at.formatted(date: .abbreviated, time: .shortened) + T("）", ")")).font(.caption).foregroundStyle(.secondary)
          ForEach(Array(rows.prefix(5).enumerated()), id: \.offset) { _, r in
            HStack { Text(LedgerText.title(r)).font(.footnote).lineLimit(1); Spacer(); Text((r.delta < 0 ? "-" : "+") + AnswerRules.short(abs(r.delta)) + " USDC").font(.footnote.monospacedDigit()) }
          }
        }.padding(12).background(RoundedRectangle(cornerRadius: KP.Radius.control).fill(KP.surface)).accessibilityIdentifier("offline.cachedLedger")
      }
      NavigationLink { RescueGuideView() } label: { Label(RescueText.guideLink, systemImage: "arrow.down.to.line").frame(maxWidth: .infinity) }
        .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("offline.guide")
      Button { Task { await m.enterWalletWithoutFaceID() } } label: { Label(T("重试连接", "Try again"), systemImage: "arrow.clockwise") }.font(.subheadline).accessibilityIdentifier("offline.retry")
    }.padding(20).card(padding: 4).padding(.horizontal, 16)
  }
}

/// '[zh]': plain steps, the live on-chain balance, the plain-words preview, then the user's own Coinbase confirmation.
struct RescueGuideView: View {
  @EnvironmentObject var m: AppModel
  @State private var plan: ChainRescue.Plan?
  @State private var stop: ChainRescue.Call?
  @State private var note: String?
  @State private var busy = false
  @State private var showTech = false
  @State private var showAppFallback = false
  var body: some View {
    ScrollView { VStack(alignment: .leading, spacing: KP.Space.cardGap) {
      // t1245 (decision 115 U28/U39): same header as [zh] (one big page title, no bar title); steps in glass cards
      // like [zh]; the rescue address on its own line (never split after "https://"), tap to copy.
      PageTitle(eyebrow: nil, title: LostPhoneRecovery.title, id: "lost.title")
      Text(LostPhoneRecovery.intro).font(KP.Typo.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      Text(T("没有启付 App，也按这几步做：", "Without the Kipurse app, follow these steps:")).font(KP.Typo.cardTitle).padding(.top, KP.Space.xs)
      ForEach(Array(LostPhoneRecovery.steps.enumerated()), id: \.offset) { i, text in
        step(i + 1, text).accessibilityIdentifier("lost.step\(i + 1)")
      }
      Text(LostPhoneRecovery.feeNote).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      Text(LostPhoneRecovery.publicPageNote).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled).accessibilityIdentifier("lost.publicPageNote")
      DisclosureGroup(LostPhoneRecovery.appFallbackTitle, isExpanded: $showAppFallback) {
        VStack(alignment: .leading, spacing: KP.Space.cardGap) {
          Text(T("只有这台设备还能打开启付时，才用下面的快捷准备；它不是手机丢失后的主步骤。", "Use these quick preparation controls only if this device can still open Kipurse. They are not the main steps after losing your phone.")).font(.footnote).foregroundStyle(.secondary)
          if FeatureSwitch.chainRead.on { ChainBalanceRow().frame(maxWidth: .infinity) }
      if FeatureSwitch.chainRescue.on {
        if let p = plan {
          VStack(alignment: .leading, spacing: 8) {
            Text(T("确认前请看清楚：", "Before you confirm:")).font(.headline)
            ForEach(Array(ChainRescue.preview(p).enumerated()), id: \.offset) { i, s in Label(s, systemImage: i == ChainRescue.preview(p).count - 1 ? "checkmark.shield" : "\(i + 1).circle").font(.subheadline) }
          }.padding(12).background(RoundedRectangle(cornerRadius: KP.Radius.control).fill(KP.surface)).accessibilityIdentifier("rescue.preview")
          BigButton(T("用 Coinbase 账户确认", "Confirm with Coinbase"), icon: "checkmark.seal") { Task { await confirm(p.call) } }.accessibilityIdentifier("rescue.confirm")
        } else {
          BigButton(busy ? T("正在检查…", "Checking…") : T("检查并准备提现", "Check and prepare"), icon: "magnifyingglass") { Task { await prepare() } }.disabled(busy).accessibilityIdentifier("rescue.prepare")
        }
      }
      if FeatureSwitch.chainRevoke.on {
        Divider()
        Text(T("只想先让 AI 停止付款？", "Just want to stop AI payments first?")).font(.headline)
        Text(T("这一步会取消所有 AI 的付款授权，不会转走你的钱。同样需要你用 Coinbase 确认，手续费从 Coinbase 钱包里的 USDC 付。以后要再用 AI 付款，重新开通即可。", "This cancels every AI payment permission without moving your money. You confirm with Coinbase and pay the small fee from the USDC in your Coinbase wallet. To use AI payments again later, set them up again.")).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        if let s = stop {
          Label(T("将要做：取消所有 AI 付款授权（不动你的钱）", "This will: cancel all AI payment permissions (your money is not moved)"), systemImage: "hand.raised").font(.subheadline).accessibilityIdentifier("rescue.stopPreview")
          BigButton(T("用 Coinbase 账户确认停止", "Confirm stop with Coinbase"), icon: "hand.raised.fill") { Task { await confirm(s) } }.accessibilityIdentifier("rescue.stopConfirm")
        } else {
          Button(T("准备停止全部 AI 付款", "Prepare to stop all AI payments")) { Task { await prepareStop() } }.accessibilityIdentifier("rescue.stopPrepare")
        }
      }
      if let n = note { Text(n).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("rescue.note") }
      if plan != nil || stop != nil {
        DisclosureGroup(T("技术人员方式（不需要任何网站）", "For technical helpers (no website needed)"), isExpanded: $showTech) {
          VStack(alignment: .leading, spacing: 6) {
            Text(T("用你的 Coinbase 钱包，向下面的钱包地址发送这笔数据（value 0，Base 网络）。任何支持 Coinbase 钱包的开源工具都可以。", "From your Coinbase wallet, send this data to the wallet address below (value 0, Base mainnet). Any open-source tool that supports Coinbase wallets works.")).font(.caption)
            if let c = plan?.call ?? stop { Text("to: \(c.to)\ndata: \(c.data)").font(.caption2.monospaced()).textSelection(.enabled).lineLimit(8)
              Button(T("复制", "Copy")) { UIPasteboard.general.string = "to: \(c.to)\ndata: \(c.data)"; Haptics.success() }.font(.caption) }
          }
        }.font(.footnote)
      }
        }
      }.font(.footnote).accessibilityIdentifier("rescue.appFallback")
    }.padding(20) }
    .background(MockBG()).navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("rescue.guide")
  }
  static let rescueURL = "https://kipurse.github.io/rescue/"
  @State private var urlCopied = false
  private func step(_ n: Int, _ s: String) -> some View {
    let hasURL = s.contains(Self.rescueURL)
    let shown = hasURL ? s.replacingOccurrences(of: " " + Self.rescueURL, with: T("下面的网址", " the address below")) : s
    return HStack(alignment: .top, spacing: KP.Space.s) {
      Image(systemName: "\(n).circle.fill").font(.title2).foregroundStyle(Brand.accent).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: KP.Space.xs) {
        Text(shown).font(KP.Typo.body).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        if hasURL {
          Button { UIPasteboard.general.string = Self.rescueURL; Haptics.success(); urlCopied = true } label: {
            HStack(spacing: 8) {
              Text(Self.rescueURL).font(.footnote.monospaced().weight(.semibold)).foregroundStyle(Brand.accent).lineLimit(1).minimumScaleFactor(0.7)
              Spacer(minLength: 0)
              Label(urlCopied ? T("已复制", "Copied") : T("复制", "Copy"), systemImage: urlCopied ? "checkmark" : "doc.on.doc").font(.caption.weight(.semibold)).foregroundStyle(.secondary).fixedSize()
            }.padding(.horizontal, 12).frame(minHeight: 44).background(KP.surface, in: RoundedRectangle(cornerRadius: KP.Radius.control, style: .continuous))
          }.buttonStyle(Pressable()).accessibilityLabel(Self.rescueURL).accessibilityHint(T("点一下复制网址", "Tap to copy the address")).accessibilityIdentifier("lost.url")
        }
      }
    }.frame(maxWidth: .infinity, alignment: .leading).card().accessibilityElement(children: .contain)
  }
  private func prepare() async {
    busy = true; defer { busy = false }; note = nil
    guard let w = RescueIdentity.wallet, let o = await RescueIdentity.resolveOwner(wallet: w) else { note = T("这台手机还没记下你的钱包。请在 Base App 或 keys.coinbase.com 用你的 Coinbase 账户登录，钱就在那个账户名下的 Kipurse 钱包里。", "This iPhone hasn't saved your wallet yet. Sign in to the Base App or keys.coinbase.com with your Coinbase account; the money is in the Kipurse wallet owned by that account."); return }
    if m.demo != nil { DemoGuard.say(); return }
    var mockOwner = false
    #if DEBUG
    mockOwner = CommandLine.arguments.contains("-kpRescueMockOwner")   // t1266: UI tests only, never in a release build
    #endif
    let ownerOK = mockOwner ? true : await VaultCheck.isOwner(wallet: w, address: o, rpc: nil) == true
    guard ownerOK else { note = T("没能确认这个 Coinbase 钱包是你本人的，先不继续。没有转钱，也没有扣手续费。", "We could not confirm that this Coinbase wallet is yours, so we stopped. No money was moved and no fee was charged."); return }
    guard let b = await m.loadChainBalance(force: true) else { note = T("暂时查不到你在启付里还有多少钱。请检查网络后再试，你的钱不会因此受影响。", "We cannot check how much money you have in Kipurse right now. Check your connection and try again. Your money is not affected."); return }
    do { plan = try ChainRescue.plan(wallet: w, owner: o, recordedOwner: Operator.ownerAccount, b: b) }
    catch ChainRescue.Refusal.nothingToTake { note = T("钱包里现在没有可以取的钱。", "There's nothing to take back right now.") }
    catch { note = T("收款地址不是你自己的 Coinbase 钱包，已停止。", "The destination isn't your own Coinbase wallet. Stopped.") }
  }
  private func prepareStop() async {
    guard let w = RescueIdentity.wallet else { return }
    // t1238 decision 108: pause on chain instead of removing a key (Coinbase refuses owner changes)
    if await ChainRescue.allPaused(wallet: w) == true { note = T("已经没有 AI 可以用这个钱包付款了，不用再停。", "No AI has permission to pay from this wallet now. There is nothing to stop."); return }
    stop = ChainRescue.stopAI(wallet: w)
  }
  /// Opens a pinned, hash-checked confirmation page in the in-app browser. The page only relays this exact call to Coinbase.
  private func confirm(_ c: ChainRescue.Call) async {
    if m.demo != nil { DemoGuard.say(); return }
    guard !busy else { return }
    busy = true; defer { busy = false }; note = nil
    guard let owner = await RescueIdentity.resolveOwner(wallet: c.to),
          await VaultCheck.isOwner(wallet: c.to, address: owner, rpc: nil) == true else {
      note = T("没能确认这个 Coinbase 钱包是你本人的，先不继续。没有转钱，也没有扣手续费。", "We could not confirm that this Coinbase wallet is yours, so we stopped. No money was moved and no fee was charged."); return
    }
    // t1042s4521: read public Base RPC, never depend on Kipurse or a sponsor.
    // A USDC balance is a prerequisite, NOT proof of the signing page's fee token.
    do {
      let gas = try await GasCheck.fetch(kind: .other, account: owner)
      guard gas.enough else { note = ChainRescue.gasMissingText(gas); return }
    } catch {
      note = T("暂时查不到你的 Coinbase 钱包里有多少 USDC，也没法确认手续费，先不继续。没有转钱，也没有扣手续费。请检查网络后再试。", "We cannot check your Coinbase wallet's USDC balance or the fee right now, so we stopped. No money was moved and no fee was charged. Check your connection and try again."); return
    }
    if let u = await RescuePages.firstGood(call: c, owner: owner) { m.webSheet = WebSheet(url: u); return }
    note = T("确认页现在打不开（它不放在启付服务器上，正在准备独立的备用地址）。钱还在你自己的钱包里，等一等不会影响你的钱；也可以请懂技术的人用下面的「技术人员方式」。", "The confirmation page can't be opened right now (it isn't on Kipurse's servers; an independent backup address is being prepared). Your money stays in your own wallet and waiting does not affect it; a technical helper can also use the method below.")
    showTech = true
  }
}

/// Independent confirmation pages (NOT pay.kipurse.com): Info.plist KipurseRescuePages = "https://host/path|sha256hex,…".
/// Each page is fetched and its SHA-256 must match the pinned value before it opens; the call rides in the #fragment (never sent to the host).
enum RescuePages {
  static var pinned: [(URL, String)] {
    ((Bundle.main.object(forInfoDictionaryKey: "KipurseRescuePages") as? String).flatMap { $0.contains("$(") ? nil : $0 } ?? "").split(separator: ",").compactMap { e in
      let p = e.split(separator: "|"); guard p.count == 2, let u = URL(string: String(p[0]).trimmingCharacters(in: .whitespaces)), u.scheme == "https" else { return nil }
      return (u, String(p[1]).trimmingCharacters(in: .whitespaces).lowercased()) }
  }
  static func firstGood(call: ChainRescue.Call, owner: String) async -> URL? {
    for (u, h) in pinned {
      var r = URLRequest(url: u, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6)
      r.httpMethod = "GET"
      guard let (d, resp) = try? await URLSession.shared.data(for: r), (resp as? HTTPURLResponse)?.statusCode == 200,
            SHA256.hash(data: d).map({ String(format: "%02x", $0) }).joined() == h else { continue }
      var c = URLComponents(url: u, resolvingAgainstBaseURL: false); c?.fragment = "to=\(call.to)&data=\(call.data)&owner=\(owner)&lang=\(Loc.code)"
      return c?.url
    }
    return nil
  }
}
