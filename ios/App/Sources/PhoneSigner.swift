import SwiftUI
import UIKit
import Security
import CryptoKit
import LocalAuthentication
import KipurseCore

/// The owner's mainnet PHONE SIGNER: a Secure Enclave P-256 key (non-exportable, every use needs Face ID of the CURRENT enrolled
/// faces). On chain it is a scoped second owner of the wallet (KipursePhoneApprover): it can only approve / reject payee trust
/// requests (within the phone caps) — never move money, raise limits or change owners. Enrolled once with the Coinbase wallet.
enum PhoneKey {
  static let tag = "com.kipurse.phone-signer.mainnet.v1".data(using: .utf8)!
  static var server: URL { Mainnet.server }
  /// context: an already-evaluated LAContext (app unlock) -> signing with this key reuses it, no extra Face ID.
  /// Shared keychain group (Info.plist KipurseKeyGroup = <team>.<prefix>.keys) so the key survives bundle-id / build-variant changes.
  static var sharedGroup: String? { (Bundle.main.object(forInfoDictionaryKey: "KipurseKeyGroup") as? String).flatMap { $0.contains("$(") || $0.isEmpty ? nil : $0 } }
  static var lastStatus: OSStatus = 0
  /// Every Secure Enclave key with this tag in every keychain group this app can read.
  static func all(context: LAContext? = nil, tag: Data = PhoneKey.tag) -> [SecKey] {
    if DemoGuard.active { return [] }   // demo: never reads the keychain
    var q: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag, kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecReturnRef as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
    if let context { q[kSecUseAuthenticationContext as String] = context }
    var out: CFTypeRef?; lastStatus = SecItemCopyMatching(q as CFDictionary, &out)
    guard lastStatus == errSecSuccess else { return [] }
    if let a = out as? [SecKey] { return a }
    if let o = out, CFGetTypeID(o) == SecKeyGetTypeID() { return [o as! SecKey] }
    return []
  }
  static func fingerprint(_ k: SecKey) -> String? { xy(k).map { PhoneTrust.fingerprint(x: $0.0, y: $0.1) } }
  /// context: an already-evaluated LAContext (app unlock) -> signing with this key reuses it, no extra Face ID.
  /// With several keys, prefer the one the wallet has on chain (remembered in kp.phoneFP).
  static func existing(context: LAContext? = nil, tag: Data = PhoneKey.tag) -> SecKey? {
    let ks = all(context: context, tag: tag)
    AuthLog.note("key-find", "keys=\(ks.count) ctx=\(context != nil) status=\(lastStatus) fp=\(UserDefaults.standard.string(forKey: "kp.phoneFP") != nil)")   // t1256
    if ks.count > 1, let want = UserDefaults.standard.string(forKey: "kp.phoneFP"), let k = ks.first(where: { fingerprint($0) == want }) { return k }
    return ks.first
  }
  /// Existence only: attributes query, no key ref, no auth context -> never shows Face ID.
  static func isPresent(tag: Data = PhoneKey.tag) -> Bool {
    if DemoGuard.active { return false }
    let q: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?; return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess
  }
  /// Cached P-256 public (x||y hex). Written at create / after authenticated use — readable with no Face ID (t1027).
  private static let pubDefaultsKey = "kp.phonePubXY"
  static func cachePublic(_ k: SecKey) {
    guard let (x, y) = xy(k) else { return }
    // raw 128 hex chars (no 0x) — Hex.encode adds 0x and must not be concatenated
    let raw = (x + y).map { String(format: "%02x", $0) }.joined()
    UserDefaults.standard.set(raw, forKey: pubDefaultsKey)
    if let fp = fingerprint(k) { UserDefaults.standard.set(fp, forKey: "kp.phoneFP") }
  }
  /// Public key bytes without touching the biometry-gated private key ref (no Face ID).
  static func cachedXY() -> ([UInt8], [UInt8])? {
    guard let s = UserDefaults.standard.string(forKey: pubDefaultsKey), let d = Hex.decode(s), d.count == 64 else { return nil }
    return (Array(d[0..<32]), Array(d[32..<64]))
  }
  static func cachedFingerprint() -> String? {
    if let fp = UserDefaults.standard.string(forKey: "kp.phoneFP"), !fp.isEmpty { return fp }
    guard let (x, y) = cachedXY() else { return nil }
    return PhoneTrust.fingerprint(x: x, y: y)
  }
  static func create() throws -> SecKey {
    if DemoGuard.active { DemoGuard.say(); throw DemoGuard.Blocked() }
    // Reuse only with an explicit authenticated lookup elsewhere; here: attributes-only presence, then create if missing.
    // Calling existing() without a context can Face ID on launch paths — avoid. User-initiated enroll that needs the ref
    // should call existing(context:) after Face ID, or create when !isPresent().
    if isPresent() {
      // Last-resort: authenticated reuse (user already in an action). Prefer cached public for enroll bodies.
      if let k = existing() { cachePublic(k); return k }
    }
    var err: Unmanaged<CFError>?
    guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &err) else { throw err!.takeRetainedValue() as Error }
    let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256, kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag, kSecAttrAccessControl as String: ac]]
    if let g = sharedGroup { var a = attrs; a[kSecAttrAccessGroup as String] = g; if let k = SecKeyCreateRandomKey(a as CFDictionary, &err) { cachePublic(k); return k } }
    guard let k = SecKeyCreateRandomKey(attrs as CFDictionary, &err) else { throw err!.takeRetainedValue() as Error }
    cachePublic(k); return k
  }
  static func delete() { if DemoGuard.active { return }; SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag] as CFDictionary); UserDefaults.standard.removeObject(forKey: pubDefaultsKey); UserDefaults.standard.removeObject(forKey: "kp.phoneFP") }
  /// (x, y) of the public key.
  static func xy(_ k: SecKey) -> ([UInt8], [UInt8])? {
    guard let pub = SecKeyCopyPublicKey(k), let d = SecKeyCopyExternalRepresentation(pub, nil) as Data?, d.count == 65 else { return nil }
    let b = [UInt8](d); return (Array(b[1..<33]), Array(b[33..<65]))
  }
  /// Sign a 32-byte digest as-is (Face ID prompt comes from the Secure Enclave access control). Returns low-s (r, s).
  static func sign(_ digest: [UInt8], key: SecKey, reusesUnlock: Bool = false) throws -> ([UInt8], [UInt8]) {
    if DemoGuard.active { DemoGuard.say(); throw DemoGuard.Blocked() }
    if !reusesUnlock { PromptLog.add("key") }
    var err: Unmanaged<CFError>?
    let t0 = Date()
    guard let der = SecKeyCreateSignature(key, .ecdsaSignatureDigestX962SHA256, Data(digest) as CFData, &err) as Data? else {
      let e = err!.takeRetainedValue() as Error; let n = e as NSError
      AuthLog.note("key-sign", "FAIL reuse=\(reusesUnlock) after=\(Int(Date().timeIntervalSince(t0) * 1000))ms domain=\(n.domain) code=\(n.code)\((n.userInfo[NSUnderlyingErrorKey] as? NSError).map { " under=\($0.domain)/\($0.code)" } ?? "")")
      throw e }
    AuthLog.note("key-sign", "ok reuse=\(reusesUnlock) after=\(Int(Date().timeIntervalSince(t0) * 1000))ms")   // t1256: >~300ms with reuse=true means iOS showed a SECOND Face ID
    guard let rs = PhoneTrust.rs(fromDER: [UInt8](der)) else { throw NSError(domain: "kipurse", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad signature"]) }
    cachePublic(key)   // t1027: after authenticated use, public is cached for launch-safe reads
    return rs
  }
  static func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
    var r = URLRequest(url: server.appendingPathComponent(path)); r.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "content-type")
    // t1240 (decision 110 F1): "add this phone" needs owner proof - this phone's session (current Face ID phone) or a fresh Coinbase sign-in with this key
    if path == "phone/enroll", let tok = MainnetSession.load() { r.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization") }
    r.httpBody = try JSONSerialization.data(withJSONObject: body); let (d, resp) = try await URLSession.shared.data(for: r)
    let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    if let h = resp as? HTTPURLResponse, !(200..<300).contains(h.statusCode) { throw ServerText.error(j, status: h.statusCode) }   // t1275 (#3): only a 2xx is an answer; callers still check its fields
    return j
  }
  /// [zh]: create (or reuse) the Secure Enclave key, register it, open the Coinbase wallet page (fee sheet first).
  @MainActor static func startUpgrade(_ m: AppModel) async {
    let owed = await OwedSigninProof.fulfill(reason: T("开启 Face ID 批准", "Turn on Face ID approvals"))   // t1268 decision 133: a bind sign-in's key proof, with this action's Face ID
    defer { owed?.invalidate() }
    do { let k = try owed.flatMap { existing(context: $0) } ?? create(); guard let (x, y) = xy(k) else { return }
      let r = try await post("phone/enroll", ["x": Hex.encode(x), "y": Hex.encode(y)])
      if (r["already"] as? Bool) == true { m.toast = T("已开启", "On"); return }
      let old = (await status())?["approver"] as? String
      m.openPhonePage(url: try verifiedEnrollURL(r, x: x, y: y, replacing: old)) }
    catch { m.toast = PhoneEnrollCopy.line(error) }
  }
  static func status() async -> [String: Any]? {
    #if DEBUG
    if UserDefaults.standard.bool(forKey: "kpMockPhoneActive") { return ["approver": "0x3000000000000000000000000000000000000003", "fingerprint": "mock-old-phone", "version": "v2"] }   // UI test (t843): server says approvals are on elsewhere
    #endif
    guard let (d, _) = try? await URLSession.shared.data(from: server.appendingPathComponent("phone/status")) else { return nil }
    return ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any])?["active"] as? [String: Any]
  }
}

/// [zh] → [zh]: create the key, show its fingerprint, open the enrollment page (Coinbase wallet signs once), or revoke.
struct PhoneSignerView: View {
  @EnvironmentObject var m: AppModel
  @State private var fp: String? = nil; @State private var active: [String: Any]? = nil; @State private var err = ""; @State private var errLine = ""; @State private var busy = false
  var mine: Bool { guard let a = active, let f = fp else { return false }; return (a["fingerprint"] as? String) == f }
  var body: some View {
    List { Group {
      Section { FaceIDApprovalHeader(on: mine) }
      Section {
        if mine { Label(GasCheck.isV2(active) ? T("已开启 · 也能用 Siri 付款", "On · Siri payments work too") : T("已开启", "On"), systemImage: "checkmark.seal.fill").foregroundStyle(Brand.positive).accessibilityIdentifier("phone.active")
          if Operator.ownerPayEnabled && !GasCheck.isV2(active) {   // hidden once V2/V3 is the active approver (/phone/status version)
          Button { Task { await enroll(siri: true) } } label: { Label(Unbound.siriLabel, systemImage: "arrow.up.circle") }.disabled(busy).accessibilityIdentifier("phone.upgrade")
          } else if Operator.ownerPayEnabled && GasCheck.upgradeToV3(active) {   // only offered when the server turned V3 on
          Button { Task { await enroll(siri: true) } } label: { Label(T("更新 Face ID 批准", "Update Face ID approvals"), systemImage: "arrow.up.circle") }.disabled(busy).accessibilityIdentifier("phone.upgradeV3")
          }
          Button(T("关闭 Face ID 批准", "Turn off Face ID approvals")) { Task { do { m.openPhonePage(url: try await PhoneKey.verifiedRevokeURL()) } catch { note(error) } } }.foregroundStyle(Brand.negative)
        } else {
          if active != nil {   // t843: approvals live on another phone / app copy -> replace them here in one Coinbase confirmation (no dead end)
            Text(T("这台手机还没开启 Face ID 批准。开启后，旧手机或旧 App 里的批准会自动失效，你的钱不受影响。", "Face ID approvals aren't on for this phone yet. Turning them on here automatically retires the old phone or app copy. Your money isn't affected.")).foregroundStyle(.secondary).accessibilityIdentifier("phone.replaceNote")
            BigButton(T("在这台手机开启", "Turn on for this phone"), icon: "faceid", disabled: busy) { Task { await enroll(replacing: active?["approver"] as? String) } }.accessibilityIdentifier("phone.replace")
            Text(T("网络费按实时报价从你的启付钱包扣，最多 0.05 USDC。", "The network fee is a live quote from your Kipurse wallet, at most 0.05 USDC.")).font(.footnote).foregroundStyle(.secondary)
          } else {   // t1245 (decision 115 U29): the main action is a real brand button; the note is whole sentences
            BigButton(Unbound.bindLabel, icon: "faceid", disabled: busy) { Task { await enroll() } }.accessibilityIdentifier("phone.bind")
            Text(T(PhoneEnrollCopy.afterOpeningFeeZH + "开启和关闭都要在你的 Coinbase 账户里确认一次。", PhoneEnrollCopy.afterOpeningFeeEN + ". Turning it on or off is confirmed once in your Coinbase account.")).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }
      }
      if !err.isEmpty { Section { Label(errLine, systemImage: "exclamationmark.triangle").foregroundStyle(Brand.negative).accessibilityIdentifier("phone.error")
        DisclosureGroup(T("详细信息", "Details")) { Text(err).font(.caption).foregroundStyle(.secondary) } } }
    }.listRowBackground(GlassRowBG())
    }
    .listStyle(.insetGrouped).kpSectionRhythm().scrollContentBackground(.hidden).background(Brand.canvas).navigationTitle(T("Face ID 批准", "Face ID approvals"))
    .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel(T("刷新", "Refresh")).accessibilityIdentifier("phone.refresh") } }   // U29: refresh = small top-right button
    .task { await load() }
    .onChange(of: m.phoneSignerChanged) { v in if v != nil { Task { await load() } } }
  }
  func load() async {
    active = await PhoneKey.status(); let want = active?["fingerprint"] as? String
    // t1027: never PhoneKey.all() on appear — ReturnRef can Face ID. Use cached fingerprint only.
    let local = PhoneKey.cachedFingerprint()
    if let w = want, let local, w == local { fp = w; UserDefaults.standard.set(w, forKey: "kp.phoneFP") }
    else if let w = want, PhoneKey.isPresent() { fp = w; UserDefaults.standard.set(w, forKey: "kp.phoneFP") }
    else { fp = local }
  }
  func note(_ error: Error) {
    let raw = (error as NSError).localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    errLine = PhoneEnrollCopy.line(error)
    err = raw.isEmpty ? errLine : raw
  }
  func enroll(siri: Bool = false, replacing: String? = nil) async {
    busy = true; defer { busy = false }; err = ""; errLine = ""
    let owed = await OwedSigninProof.fulfill(reason: T("开启 Face ID 批准", "Turn on Face ID approvals"))   // t1268 decision 133: a bind sign-in's key proof, with this action's Face ID
    defer { owed?.invalidate() }
    do { let k = try owed.flatMap { PhoneKey.existing(context: $0) } ?? PhoneKey.create(); guard let (x, y) = PhoneKey.xy(k) else { return }; fp = PhoneTrust.fingerprint(x: x, y: y)
      let r = try await PhoneKey.post("phone/enroll", ["x": Hex.encode(x), "y": Hex.encode(y)])
      if (r["already"] as? Bool) == true { m.toast = T("已开启", "On"); await load(); return }
      m.openPhonePage(url: try PhoneKey.verifiedEnrollURL(r, x: x, y: y, siri: siri, replacing: replacing ?? active?["approver"] as? String)) }
    catch { note(error) }
  }
}

struct TrustReq: Identifiable { let id: String }

/// kipurse://approve-trust?id=… : show the request (from the fields the phone hashes itself), Face ID, sign, relay.
struct PhoneApproveTrustSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject var app: AppModel
  let req: TrustReq
  @State private var data: [String: Any]? = nil; @State private var msg: OwnerTrustMessage? = nil; @State private var hash: [UInt8]? = nil
  @State private var issues: [String] = []; @State private var state = ""; @State private var done = false; @State private var busy = false; @State private var notBound = false
  @State private var grant: OwnerSignerTrustMessage? = nil; @State private var grantHash: [UInt8]? = nil   // t1214 decision 102: V5.4 only (server sends it only then)
  var check: [String: Any]? { data?["addressCheck"] as? [String: Any] }
  var checkStatus: String { check?["status"] as? String ?? "" }
  var body: some View {
    NavigationStack {
      List {
        if let m = msg, let r = data?["request"] as? [String: Any] {
          if checkStatus == "lookalike", let looks = check?["lookalikes"] as? [[String: Any]], let known = looks.first?["address"] as? String, let payee = m.payees.first {
            Section {
              Label(T("小心：这个地址很像你认识的一个地址，但中间不一样，可能是假地址。", "Careful: this address looks like one you know, but the middle is different. It may be fake."), systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Brand.negative).font(.callout.weight(.semibold)).accessibilityIdentifier("trust.lookalike.warning")
              AddrCompare(title: T("你认识的地址", "Address you know") + ((looks.first?["label"] as? String).map { " · \($0)" } ?? ""), addr: known, other: payee, highlight: false)
              AddrCompare(title: T("这次要信任的地址", "Address in this request"), addr: payee, other: known, highlight: true)
              Text(T("红色的几组就是不一样的地方。拿不准就点“拒绝”。", "Red groups are the differences. If unsure, tap Reject.")).font(.caption).foregroundStyle(.secondary)
            }
          } else if checkStatus == "dust_only" {
            Section { Label(T("小心：这个地址只给你转过几分钱以下的零碎小额，常见于骗子“投毒”。拿不准就点“拒绝”。", "Careful: this address only sent you tiny amounts, a common scam trick. If unsure, tap Reject."), systemImage: "exclamationmark.triangle.fill")
              .foregroundStyle(Brand.negative).font(.callout.weight(.semibold)).accessibilityIdentifier("trust.dust.warning") }
          } else if checkStatus == "new" {
            Section { Label(T("新地址，以前没付过（未核实）。请对一下完整地址。", "New address you have not paid before (not verified). Check the full address."), systemImage: "questionmark.circle").font(.callout).accessibilityIdentifier("trust.new.note") }
          }
          Section(T("收款方", "Payee")) { Text(m.payees.map(fullAddr).joined(separator: "\n")).font(.system(.footnote, design: .monospaced)).accessibilityIdentifier("approve.payee.full")
            TipLine(zh: SafetyTips.payeeZh, en: SafetyTips.payeeEn, id: "tip.payee")
            if let own = Operator.ownerAccount?.lowercased(), m.payees.contains(where: { $0.lowercased() == own }) { Label(T("这是你自己的 Coinbase 钱包", "This is your own Coinbase wallet"), systemImage: "person.crop.circle.badge.checkmark").foregroundStyle(Brand.positive) } }
          Section { LabeledContent(T("每笔最多", "Per payment"), value: usdc(m.single)); LabeledContent(T("每天最多", "Per day"), value: usdc(m.daily))
            LabeledContent(T("到期", "Expires"), value: m.expiry == RequestVerify.noExpiry ? T("不过期，直到你取消", "Never, until you remove it") : Date(timeIntervalSince1970: Double(m.expiry) ?? 0).formatted(date: .abbreviated, time: .omitted)) } header: { Text(T("上限", "Limits")) } footer: { if let g = grant { Text(SignerGrantCopy.footer(g.name)).accessibilityIdentifier("trust.signerGrant.note") } }
          Section(T("AI 说的理由（仅供参考）", "AI's reason (for reference only)")) { Text("\(m.name) — \(r["reason"] as? String ?? "")").font(.callout)
            Text(T("申请的 AI：", "Requested by: ") + ((r["requestedBy"] as? [String])?.joined(separator: ", ") ?? "")).font(.caption).foregroundStyle(.secondary) }
          if let fr = FeeReceipt(data?["feePreview"] as? [String: Any]) { Section(T("费用（Face ID 之前看清）", "Fees (before Face ID)")) { ForEach(Array(fr.rows(zh: Loc.isChinese).enumerated()), id: \.offset) { LabeledContent($0.element.0, value: $0.element.1) } }.accessibilityIdentifier("trust.fee.preview") }
          if RequestVerify.isReusableTrust(m) { Section { Label(RequestVerify.rememberNote(zh: Loc.isChinese), systemImage: "checkmark.shield").font(.callout).accessibilityIdentifier("trust.remember.free") } }
          if !issues.isEmpty { Section { ForEach(issues, id: \.self) { Text($0).foregroundStyle(Brand.negative) } } }
          Section {
            if done { Label(state, systemImage: "checkmark.seal.fill").foregroundStyle(Brand.positive) }
            else { let risky = checkStatus == "lookalike" || checkStatus == "dust_only"
              if risky { Button(role: .destructive) { Task { await reject() } } label: { Label(T("拒绝（推荐）", "Reject (recommended)"), systemImage: "hand.raised.fill").font(.headline) }.disabled(busy).accessibilityIdentifier("trust.reject.primary") }
              Button { Task { await approve() } } label: { CenteredLabel(risky ? T("我确认地址没问题，用 Face ID 批准", "I checked it. Approve with Face ID") : T("用 Face ID 批准", "Approve with Face ID"), systemImage: "faceid").font(risky ? .callout : .headline) }.disabled(busy || !issues.isEmpty || hash == nil)
              if !risky { Button(T("拒绝（Face ID）", "Reject (Face ID)"), role: .destructive) { Task { await reject() } }.disabled(busy) }
              if !state.isEmpty { Text(state).font(.callout).foregroundStyle(.secondary) } }
          }
        } else if notBound {
          // t660: no dead-end error; say what's needed in plain words and offer the one fix right here
          Section { FaceIDApprovalHeader(on: false) }
          Section { NavigationLink { PhoneSignerView() } label: { Label(Unbound.bindLabel, systemImage: "faceid").font(.headline) }.accessibilityIdentifier("trust.goBind") }
            footer: { Text(T("开启后，这个请求会继续在这里等你。", "Once it's on, this request will be waiting here.")) }
        } else { Section { HStack(spacing: 10) { ProgressView(); Text(state.isEmpty ? T("正在读取请求…", "Loading…") : state) } } }
      }.scrollContentBackground(.hidden).background(Brand.canvas).navigationTitle(T("允许 AI 付给新收款方？", "Let AI pay a new payee?")).toolbar { Button(T("关闭", "Close")) { dismiss() } }
    }.task { await load() }
  }
  func usdc(_ v: String) -> String { "\((Double(v) ?? 0) / 1e6) USDC" }
  func load() async {
    guard PhoneKey.isPresent() else { notBound = true; return }
    do { let j = try await PhoneKey.post("approve/trust/phone-prepare", ["id": req.id]); data = j
      guard let m = j["message"] as? [String: Any], let ph = j["phone"] as? [String: Any] else { state = "bad response"; return }
      func s(_ k: String) -> String { if let v = m[k] as? String { return v }; if let n = m[k] as? NSNumber { return n.stringValue }; return "" }
      let om = OwnerTrustMessage(account: s("account"), merchant: s("merchant"), name: s("name"), epoch: s("epoch"), payees: m["payees"] as? [String] ?? [], signers: m["signers"] as? [String] ?? [],
        single: s("single"), daily: s("daily"), expiry: s("expiry"), nonce: s("nonce"), deadline: s("deadline")); msg = om
      issues = PhoneTrust.problems(om, maxSingle: ph["maxSingle"] as? String ?? "0", maxDaily: ph["maxDaily"] as? String ?? "0")
      issues += RequestVerify.trust(om, wallet: PhoneTrust.mainnetWallet, localMaxSingle: nil, localMaxDaily: nil)
      // t1266 (fix 5): the phone's OWN ceiling here too (the AI limits shown in the app, else 5 / 20 USDC; same rule as the new-payee card)
      // t1275 (#2): the ceiling is ONLY what the owner signed on this phone (server may lower it); none signed here -> refused
      let ceil0 = SignedLimitsStore.ceiling(app)
      if ceil0 == nil { issues.append(T(SignedLimitsCopy.noneZH, SignedLimitsCopy.noneEN)) }
      else if let ceil0, !OwnerAsk.trustCapProblems(om, ceiling: ceil0).isEmpty { issues.append(T("这次信任的额度超过你在手机上设的 AI 花钱上限，已停止。", "This trust is above the AI spending limits set on this phone, so it was stopped.")) }
      issues += PhoneTrust.suiteProblems(om)   // t1250 (decision 119): V5.5 wallets only - the KR-05 rules the V5.5 trust contract enforces
      // t1280 (Q4): the epoch must be the merchant's CURRENT trust epoch, read by this phone on chain (two agreeing nodes), not the server's word
      if !(await PhoneTrust.chainEpochMatches(account: om.account, merchant: om.merchant, epoch: om.epoch)) { issues.append(T("服务器给的内容和手机算出的不一致，已停止。", "Server data doesn't match what the phone computed. Stopped.")) }
      // t1250: on V5.5 a reusable ("remember") trust is OwnerInlineTrust (seat kind 6); else OwnerTrust, as before
      if let d = PhoneTrust.trustDigest(om) { if Hex.encode(d).lowercased() != (j["digest"] as? String ?? "").lowercased() { issues.append(T("服务器给的内容和手机算出的不一致，已停止。", "Server data doesn't match what the phone computed. Stopped.")) } else { hash = PhoneTrust.walletHash(d) } }
      // t1214 (decision 100/#102): V5.4 wallets only — the same Face ID also signs the merchant-signer grant; the phone recomputes it and it must match the card exactly
      if let gj = j["signerGrant"] as? [String: Any], let gm = gj["message"] as? [String: Any] {
        func g(_ k: String) -> String { if let v = gm[k] as? String { return v }; if let n = gm[k] as? NSNumber { return n.stringValue }; return "" }
        let gr = OwnerSignerTrustMessage(account: g("account"), merchant: g("merchant"), name: g("name"), epoch: g("epoch"), signers: gm["signers"] as? [String] ?? [],
          single: g("single"), daily: g("daily"), expiry: g("expiry"), nonce: g("nonce"), deadline: g("deadline"))
        if !PhoneTrust.signerTrustProblems(gr, card: om).isEmpty || !KipurseSuite.active.signerGrants /* t1250: V5.4 and V5.5 */ || !SignerGrantDomain.shownNameOK(gr.name) /* t1278 (A3): the footer names a readable domain */ { issues.append(T("服务器给的内容和手机算出的不一致，已停止。", "Server data doesn't match what the phone computed. Stopped.")) }
        else if let gd = PhoneTrust.signerTrustDigest(gr, adapter: KipurseSuite.active.adapter), Hex.encode(gd).lowercased() == (gj["digest"] as? String ?? "").lowercased() { grant = gr; grantHash = PhoneTrust.walletHash(gd) }
        else { issues.append(T("服务器给的内容和手机算出的不一致，已停止。", "Server data doesn't match what the phone computed. Stopped.")) }
      }
      // t1275 (#1): order signers are signed only together with a verified grant (the card shows them only through it)
      if !PhoneTrust.signerProblems(om, grantVerified: grant != nil && grantHash != nil).isEmpty { issues.append(T("服务器给的内容和手机算出的不一致，已停止。", "Server data doesn't match what the phone computed. Stopped.")) }
    } catch { state = error.localizedDescription }
  }
  func approve() async {
    if let gh = grantHash, let g = grant { await approveWithGrant(gh, g); return }
    guard let h = hash, let k = PhoneKey.existing() else { return }; busy = true; defer { busy = false }
    await FaceIDUnlock.ensure()   // t1255 decision 124: Face ID locked by iOS -> passcode unlocks Face ID only (approves nothing)
    do { let (r, s) = try PhoneKey.sign(h, key: k); state = T("正在核对并上链…（10–30 秒）", "Checking and writing on chain… (10–30 s)")
      let j = try await PhoneKey.post("approve/trust/phone-sign", ["id": req.id, "r": Hex.encode(r), "s": Hex.encode(s)])
      guard TrustSignReply.trusted(j) else { state = T(TrustSignReply.notConfirmedZH, TrustSignReply.notConfirmedEN); return }   // t1275 (#3): no ✅ without the server's "trusted"
      Haptics.success(); done = true; state = (j["inline"] as? Bool == true) ? RequestVerify.rememberedDone(zh: Loc.isChinese) : T("✅ 已允许。AI 现在可以在上限内付给它。", "✅ Allowed. Your AI can now pay it within your limits.")
    } catch { state = error.localizedDescription }
  }
  /// t1214 (decision 102, V5.4 only): ONE Face ID signs the trust (kind 1) and the merchant-signer grant (kind 5).
  func approveWithGrant(_ gh: [UInt8], _ g: OwnerSignerTrustMessage) async {
    guard let h = hash else { return }; busy = true; defer { busy = false }
    let ctx = LAContext(); ctx.localizedCancelTitle = T("取消", "Cancel"); ctx.touchIDAuthenticationAllowableReuseDuration = 0; defer { ctx.invalidate() }
    await FaceIDUnlock.ensure()   // t1255 decision 124: Face ID locked by iOS -> passcode unlocks Face ID only (approves nothing)
    guard (try? await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: T("用 Face ID 批准", "Approve with Face ID"))) == true, let k = PhoneKey.existing(context: ctx) else { state = T("已取消。", "Canceled."); return }
    do { let (r, s) = try PhoneKey.sign(h, key: k, reusesUnlock: true), (gr, gs) = try PhoneKey.sign(gh, key: k, reusesUnlock: true)
      state = T("正在核对并上链…（10–30 秒）", "Checking and writing on chain… (10–30 s)")
      let j = try await PhoneKey.post("approve/trust/phone-sign", ["id": req.id, "r": Hex.encode(r), "s": Hex.encode(s), "signerGrant": ["r": Hex.encode(gr), "s": Hex.encode(gs)]])
      guard TrustSignReply.trusted(j) else { state = T(TrustSignReply.notConfirmedZH, TrustSignReply.notConfirmedEN); return }   // t1275 (#3)
      Haptics.success(); done = true; state = (j["signerGrant"] as? String) == "stored" ? SignerGrantCopy.done(g.name) : T("✅ 已允许。AI 现在可以在上限内付给它。", "✅ Allowed. Your AI can now pay it within your limits.")
    } catch { state = error.localizedDescription }
  }
  func reject() async {
    guard let k = PhoneKey.existing(), let r = data?["request"] as? [String: Any], let payee = r["payee"] as? String else { return }; busy = true; defer { busy = false }
    let d = [UInt8](SHA256.hash(data: Data(PhoneTrust.rejectMessage(id: req.id, payee: payee).utf8)))
    await FaceIDUnlock.ensure()   // t1255 decision 124: Face ID locked by iOS -> passcode unlocks Face ID only (approves nothing)
    do { let (rr, ss) = try PhoneKey.sign(d, key: k); let j = try await PhoneKey.post("approve/trust/phone-reject", ["id": req.id, "r": Hex.encode(rr), "s": Hex.encode(ss)])
      guard TrustSignReply.rejected(j) else { state = T(TrustSignReply.notConfirmedZH, TrustSignReply.notConfirmedEN); return }   // t1275 (#3)
      done = true; state = T("已拒绝。", "Rejected.") }
    catch { state = error.localizedDescription }
  }
}

/// One address in 4-character groups; with highlight, groups that differ from `other` are red.
struct AddrCompare: View {
  let title: String, addr: String, other: String, highlight: Bool
  var body: some View {
    let g = AddressCheck.groups(addr), d = Set(AddressCheck.diffGroups(addr, other))
    VStack(alignment: .leading, spacing: 4) {
      Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      g.count == 10 ? (Text("0x ") + g.enumerated().map { i, s in Text(s + (i < 9 ? " " : "")).foregroundColor(highlight && d.contains(i) ? Brand.negative : .primary).fontWeight(highlight && d.contains(i) ? .bold : .regular) }.reduce(Text(""), +)).font(.system(.footnote, design: .monospaced))
        : Text(addr).font(.system(.footnote, design: .monospaced))
    }.accessibilityIdentifier(highlight ? "trust.addr.request" : "trust.addr.known")
  }
}

// t621 #1: the phone decodes the exact Coinbase wallet batch and commits to it (#vh) before the page opens; the page refuses anything else.
extension PhoneKey {
  static func stopErr(_ p: [String]) -> NSError { NSError(domain: "kipurse", code: 5, userInfo: [NSLocalizedDescriptionKey: T("安全检查没通过，已停止，没有扣钱：", "Safety check failed. Stopped; nothing charged: ") + p.joined(separator: "; ")]) }
  static func plan(_ r: [String: Any]) throws -> (calls: [[String: Any]], owner: String, wallet: String, chain: Int) {
    guard let calls = (r["calls"] as? [[String: Any]])?.map({ $0.compactMapValues { $0 as? String } }), let owner = r["owner"] as? String, let wallet = r["wallet"] as? String
    else { throw stopErr([T("服务器回应不对", "unexpected server reply")]) }
    if let o = Operator.ownerAccount, o.lowercased() != owner.lowercased() { throw stopErr([T("确认人不是你的 Coinbase 钱包", "the signer isn't your Coinbase wallet")]) }
    if !Operator.wallet.isEmpty, Operator.wallet.lowercased() != wallet.lowercased() { throw stopErr([T("这不是你的钱包", "not your wallet")]) }
    let chain = (r["chainId"] as? Int) ?? Int(r["chainId"] as? String ?? "") ?? 8453
    guard chain == BatchVerify.chainId else { throw stopErr([T("服务器回应不对", "unexpected server reply")]) }   // t1280 (L2): Base only, like limits / resume / owner-pay
    return (calls, owner, wallet, chain)
  }
  /// replacing: the old approver from phone/status (t843). The server's `replaces` must name the same one, and the batch must add-then-remove exactly it.
  static func verifiedEnrollURL(_ r: [String: Any], x: [UInt8], y: [UInt8], siri: Bool = false, replacing: String? = nil) throws -> URL {
    guard let u = r["url"] as? String, let url0 = URL(string: u) else { throw stopErr([T("没有确认页", "no signing page")]) }
    // t1266 (fix 2): only a Kipurse signing page (https, no port, the Kipurse API host, a known signing path)
    guard SignHost.signingPage(url0, serverHost: Mainnet.base.host) != nil else { throw stopErr([T("确认页不是启付的签名页", "the confirmation page isn't a Kipurse signing page")]) }
    let p = try plan(r)
    // t1128 (decision 66): a post-opening enable is only the wallet-pays shape: live fee <= 0.05 from the Kipurse wallet to Kipurse's fee address.
    if let e = EnrollFee.problem(r, owner: p.owner) { throw stopErr([e]) }
    let srv = (r["replaces"] as? String)?.lowercased()
    // server may say nothing to replace (old one already off chain); if it names one, it must be the one this phone saw
    if let sv = srv, sv != replacing?.lowercased() { throw stopErr([T("服务器要替换的旧批准和手机看到的不一致，已停止。", "The server's old approval doesn't match what this phone sees. Stopped.")]) }
    let rep = BatchVerify.enroll(calls: p.calls, wallet: p.wallet, owner: p.owner, x: x, y: y, replacing: srv == nil ? nil : replacing); guard rep.ok else { throw stopErr(rep.problems) }
    guard let url = BatchVerify.committedURL(siri ? Unbound.siriURL(url0) : url0, chainId: p.chain, from: p.owner, calls: p.calls) else { throw stopErr(["commit"]) }
    return url
  }
  static func verifiedRevokeURL() async throws -> URL {
    let (d, _) = try await URLSession.shared.data(from: server.appendingPathComponent("phone/revoke/plan"))
    let r = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    let p = try plan(r)
    let rep = BatchVerify.revoke(calls: p.calls, wallet: p.wallet, owner: p.owner, approver: r["approver"] as? String); guard rep.ok else { throw stopErr(rep.problems) }
    guard let url = BatchVerify.committedURL(server.appendingPathComponent("phone/revoke"), chainId: p.chain, from: p.owner, calls: p.calls) else { throw stopErr(["commit"]) }
    return url
  }
}

/// One-time plain explanation of Face ID approvals: what it is, when it shows up, what it can't do (t660 confusion fix).
struct FaceIDApprovalHeader: View {
  var on: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        Image(systemName: "faceid").font(.title.weight(.semibold)).foregroundStyle(.white).frame(width: 52, height: 52)
          .background(LinearGradient(colors: [Brand.accentHi, Brand.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: KP.Radius.control, style: .continuous))
        VStack(alignment: .leading, spacing: 2) {
          Text(T("AI 要付钱时，先问你", "Your AI asks before it pays")).font(.headline)
          Text(on ? T("已在这台 iPhone 上开启", "On for this iPhone") : T("还没在这台 iPhone 上开启", "Not on for this iPhone yet")).font(.subheadline).foregroundStyle(on ? Brand.positive : .secondary)
        }
      }
      VStack(alignment: .leading, spacing: 8) {
        Label(T("付给新商家，或超出你的上限时，会弹到这里", "New shop or over your limit? It pops up here"), systemImage: "bell.badge")
        Label(T("你看清楚后，用 Face ID 点一下同意或拒绝", "Check it, then approve or decline with Face ID"), systemImage: "hand.tap")
        Label(T("iPhone 自己不能转走你的钱", "Your iPhone can never move money on its own"), systemImage: "lock.shield")
      }.font(.subheadline).labelStyle(.titleAndIcon)
    }.padding(.vertical, 6).accessibilityElement(children: .combine).accessibilityIdentifier("phone.explain")
  }
}

/// t1214 (decision 102): the only new words on the existing trust card (V5.4 wallets, when the request names the merchant's order signer).
enum SignerGrantCopy {
  static func footer(_ name: String) -> String { T("同一次 Face ID 也会信任 \(name) 发来的订单：以后它的订单（每单收款地址可以不同）在上面的上限内自动付。", "The same Face ID also trusts orders from \(name): its future orders (each may use a different payee address) pay within the limits above.") }
  static func done(_ name: String) -> String { T("✅ 已允许。AI 现在可以在上限内付给它；\(name) 以后发来的订单也在上限内自动付。", "✅ Allowed. Your AI can now pay it within your limits; future orders from \(name) also pay within these limits.") }
}
