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
    return (s.at, WalletState(s.raw))
  }
  static func wipe() {
    try? FileManager.default.removeItem(at: file)
    SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account] as CFDictionary)
  }
}

enum RescueText {
  static var banner: String { T("登录服务暂时维护中。你的钱在你自己的链上钱包里，安全，随时可以提现。", "Sign-in is under maintenance. Your money is in your own on-chain wallet, safe, and you can take it back any time.") }
  static var guideTitle: String { T("离线提现指南（启付停了也能用）", "How to take back all your money, even if Kipurse stops") }
  static var guideLink: String { T("离线提现指南", "How to take back all your money") }
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
      }.padding(12).background(RoundedRectangle(cornerRadius: 14).fill(Color(.secondarySystemBackground)))
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
        Text(T("直接从 Base 区块链读取，不经过启付", "Read straight from the Base blockchain, not from Kipurse")).font(.caption).foregroundStyle(.secondary)
        if b.pending > 0 { Text(T("其中 \(AnswerRules.format(b.pending)) USDC 是正在结算的付款，结算后也能提现", "\(AnswerRules.format(b.pending)) USDC is in payments still settling; you can take it back after they settle")).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center) }
      } else if m.chainLoading { ProgressView(T("正在从区块链读取余额…", "Reading your balance from the blockchain…")) }
      else if RescueIdentity.wallet != nil { Text(T("暂时读不到区块链，请检查网络后下拉刷新。你的钱不会因此受影响。", "Can't reach the blockchain right now. Check your network and try again. Your money isn't affected.")).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center) }
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
        }.padding(12).background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground))).accessibilityIdentifier("offline.cachedLedger")
      }
      NavigationLink { RescueGuideView() } label: { Label(RescueText.guideLink, systemImage: "arrow.down.to.line").frame(maxWidth: .infinity) }
        .buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("offline.guide")
      Button { Task { await m.mainSignIn() } } label: { Label(T("重试连接", "Try again"), systemImage: "arrow.clockwise") }.font(.subheadline).accessibilityIdentifier("offline.retry")
    }.padding(20).card(padding: 4).padding(.horizontal, 16)
  }
}

/// '离线提现指南（启付停了也能用）': plain steps, the live on-chain balance, the plain-words preview, then the user's own Coinbase confirmation.
struct RescueGuideView: View {
  @EnvironmentObject var m: AppModel
  @State private var plan: ChainRescue.Plan?
  @State private var stop: ChainRescue.Call?
  @State private var note: String?
  @State private var busy = false
  @State private var showTech = false
  var body: some View {
    ScrollView { VStack(alignment: .leading, spacing: 16) {
      Text(T("先放心：", "First, relax:")).font(.headline)
      Text(T("钱在你自己的链上钱包里，不在启付手里。只有你本人的 Coinbase 账户（通行密钥 / Face ID）能把它转出，而且只能转回你自己的 Coinbase 钱包。就算启付的服务器、网页都打不开，甚至公司不在了，这些都不会变。", "Your money is in your own on-chain wallet, not with Kipurse. Only your own Coinbase account (passkey / Face ID) can move it, and only back to your own Coinbase wallet. Even if Kipurse's servers and web pages are down, or the company is gone, that does not change."))
        .fixedSize(horizontal: false, vertical: true)
      if FeatureSwitch.chainRead.on { ChainBalanceRow().frame(maxWidth: .infinity) }
      Text(T("一步一步来：", "Step by step:")).font(.headline)
      step(1, T("点下面的「检查并准备提现」。手机自己从区块链读出你的全部余额，算好要做的事，不经过启付。", "Tap “Check and prepare” below. Your iPhone reads your whole balance from the blockchain itself and works out what to do, without Kipurse."))
      step(2, T("看清楚预览：收到多少、转到哪个地址（只能是你自己的 Coinbase 钱包）。", "Read the preview: how much, and to which address (it can only be your own Coinbase wallet)."))
      step(3, T("点「用 Coinbase 账户确认」，在 Coinbase 官方页面（网址是 keys.coinbase.com）用 Face ID 确认一次。", "Tap “Confirm with Coinbase” and confirm once with Face ID on Coinbase's own page (the address is keys.coinbase.com)."))
      step(4, T("大约几秒钟到账。打开 Base App 或 keys.coinbase.com，用同一个 Coinbase 账户登录就能看到。", "It arrives in seconds. Open the Base App or keys.coinbase.com and sign in with the same Coinbase account to see it."))
      Text(T("网络费：不到 0.01 美元，由你自己的 Coinbase 钱包付（需要一点点 ETH，在 Coinbase 里往这个账户发 0.0001 ETH，网络选 Base 就够了）。启付不收任何费用。", "Network fee: under $0.01, paid by your own Coinbase wallet (it needs a tiny bit of ETH: send 0.0001 ETH on Base to it from Coinbase). Kipurse charges nothing."))
        .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      if FeatureSwitch.chainRescue.on {
        if let p = plan {
          VStack(alignment: .leading, spacing: 8) {
            Text(T("确认前请看清楚：", "Before you confirm:")).font(.headline)
            ForEach(Array(ChainRescue.preview(p).enumerated()), id: \.offset) { i, s in Label(s, systemImage: i == ChainRescue.preview(p).count - 1 ? "checkmark.shield" : "\(i + 1).circle").font(.subheadline) }
          }.padding(12).background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemBackground))).accessibilityIdentifier("rescue.preview")
          BigButton(T("用 Coinbase 账户确认", "Confirm with Coinbase"), icon: "checkmark.seal") { Task { await confirm(p.call) } }.accessibilityIdentifier("rescue.confirm")
        } else {
          BigButton(busy ? T("正在检查…", "Checking…") : T("检查并准备提现", "Check and prepare"), icon: "magnifyingglass") { Task { await prepare() } }.disabled(busy).accessibilityIdentifier("rescue.prepare")
        }
      }
      if FeatureSwitch.chainRevoke.on {
        Divider()
        Text(T("只想先让 AI 停止付款？", "Just want to stop AI payments first?")).font(.headline)
        Text(T("这一步会在链上取消所有 AI 的付款授权，同样只需要你的 Coinbase 账户确认一次，以后要再用 AI 付款，重新开通即可。", "This cancels every AI payment permission on chain. It also needs one confirmation from your Coinbase account; to use AI payments again later, just set them up again.")).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
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
    }.padding(20) }
    .navigationTitle(RescueText.guideTitle).navigationBarTitleDisplayMode(.inline)
    .accessibilityIdentifier("rescue.guide")
  }
  private func step(_ n: Int, _ s: String) -> some View {
    HStack(alignment: .top, spacing: 10) { Text("\(n)").font(.subheadline.bold()).frame(width: 24, height: 24).background(Circle().fill(Brand.accent.opacity(0.2))); Text(s).fixedSize(horizontal: false, vertical: true) }
  }
  private func prepare() async {
    busy = true; defer { busy = false }; note = nil
    guard let w = RescueIdentity.wallet, let o = await RescueIdentity.resolveOwner(wallet: w) else { note = T("这台手机还没记下你的钱包。请在 Base App 或 keys.coinbase.com 用你的 Coinbase 账户登录，钱就在那个账户名下的 Kipurse 钱包里。", "This iPhone hasn't saved your wallet yet. Sign in to the Base App or keys.coinbase.com with your Coinbase account; the money is in the Kipurse wallet owned by that account."); return }
    if m.demo != nil { DemoGuard.say(); return }
    guard await VaultCheck.isOwner(wallet: w, address: o, rpc: nil) == true || CommandLine.arguments.contains("-kpRescueMockOwner") else { note = T("区块链上查不到这个 Coinbase 账户是钱包主人，已停止，什么都没做。", "The blockchain doesn't show this Coinbase account as the wallet owner. Stopped; nothing was done."); return }
    guard let b = await m.loadChainBalance(force: true) else { note = T("暂时读不到区块链余额，请检查网络后再试。你的钱不受影响。", "Can't read the balance from the blockchain right now. Check your network and try again. Your money isn't affected."); return }
    do { plan = try ChainRescue.plan(wallet: w, owner: o, recordedOwner: Operator.ownerAccount, b: b) }
    catch ChainRescue.Refusal.nothingToTake { note = T("钱包里现在没有可以取的钱。", "There's nothing to take back right now.") }
    catch { note = T("收款地址不是你自己的 Coinbase 钱包，已停止。", "The destination isn't your own Coinbase wallet. Stopped.") }
  }
  private func prepareStop() async {
    guard let w = RescueIdentity.wallet else { return }
    if let i = await ChainRescue.spmIndex(wallet: w) { stop = ChainRescue.stopAI(wallet: w, spmIndex: i) }
    else { note = T("链上已经没有 AI 付款授权了，不用再停。", "There are no AI payment permissions left on chain. Nothing to stop.") }
  }
  /// Opens a pinned, hash-checked confirmation page in the in-app browser. The page only relays this exact call to Coinbase.
  private func confirm(_ c: ChainRescue.Call) async {
    if m.demo != nil { DemoGuard.say(); return }
    if let u = await RescuePages.firstGood(call: c, owner: (await RescueIdentity.resolveOwner(wallet: c.to)) ?? "") { m.webSheet = WebSheet(url: u); return }
    note = T("确认页现在打不开（它不放在启付服务器上，正在准备独立的备用地址）。你的钱在链上很安全，不会因为等待而受影响；也可以请懂技术的人用下面的「技术人员方式」。", "The confirmation page can't be opened right now (it isn't on Kipurse's servers; an independent backup address is being prepared). Your money is safe on chain and waiting doesn't affect it; a technical helper can also use the method below.")
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
