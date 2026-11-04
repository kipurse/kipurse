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
    if ks.count > 1, let want = UserDefaults.standard.string(forKey: "kp.phoneFP"), let k = ks.first(where: { fingerprint($0) == want }) { return k }
    return ks.first
  }
  /// Existence only: attributes query, no key ref, no auth context -> never shows Face ID.
  static func isPresent(tag: Data = PhoneKey.tag) -> Bool {
    if DemoGuard.active { return false }
    let q: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag, kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?; return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess
  }
  static func create() throws -> SecKey {
    if DemoGuard.active { DemoGuard.say(); throw DemoGuard.Blocked() }
    if let k = existing() { return k }
    var err: Unmanaged<CFError>?
    guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &err) else { throw err!.takeRetainedValue() as Error }
    let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256, kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag, kSecAttrAccessControl as String: ac]]
    if let g = sharedGroup { var a = attrs; a[kSecAttrAccessGroup as String] = g; if let k = SecKeyCreateRandomKey(a as CFDictionary, &err) { return k } }
    guard let k = SecKeyCreateRandomKey(attrs as CFDictionary, &err) else { throw err!.takeRetainedValue() as Error }
    return k
  }
  static func delete() { if DemoGuard.active { return }; SecItemDelete([kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag] as CFDictionary) }
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
    guard let der = SecKeyCreateSignature(key, .ecdsaSignatureDigestX962SHA256, Data(digest) as CFData, &err) as Data? else { throw err!.takeRetainedValue() as Error }
    guard let rs = PhoneTrust.rs(fromDER: [UInt8](der)) else { throw NSError(domain: "kipurse", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad signature"]) }
    return rs
  }
  static func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any] {
    var r = URLRequest(url: server.appendingPathComponent(path)); r.setValue(Loc.code, forHTTPHeaderField: "x-kp-lang"); r.httpMethod = "POST"; r.setValue("application/json", forHTTPHeaderField: "content-type")
    r.httpBody = try JSONSerialization.data(withJSONObject: body); let (d, resp) = try await URLSession.shared.data(for: r)
    let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] ?? [:]
    if let h = resp as? HTTPURLResponse, h.statusCode >= 400 { throw ServerText.error(j, status: h.statusCode) }
    return j
  }
  /// 升级确认 / 添加这台手机: create (or reuse) the Secure Enclave key, register it, open the Coinbase wallet page (fee sheet first).
  @MainActor static func startUpgrade(_ m: AppModel) async {
    do { let k = try create(); guard let (x, y) = xy(k) else { return }
      let r = try await post("phone/enroll", ["x": Hex.encode(x), "y": Hex.encode(y)])
      let old = (await status())?["approver"] as? String
      m.openPhonePage(url: try verifiedEnrollURL(r, x: x, y: y, replacing: old)) }
    catch { m.toast = error.localizedDescription }
  }
  static func status() async -> [String: Any]? {
    #if DEBUG
    if UserDefaults.standard.bool(forKey: "kpMockPhoneActive") { return ["approver": "0x3000000000000000000000000000000000000003", "fingerprint": "mock-old-phone", "version": "v2"] }   // UI test (t843): server says approvals are on elsewhere
    #endif
    guard let (d, _) = try? await URLSession.shared.data(from: server.appendingPathComponent("phone/status")) else { return nil }
    return ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any])?["active"] as? [String: Any]
  }
}

/// 设置 → 手机确认（主网）: create the key, show its fingerprint, open the enrollment page (Coinbase wallet signs once), or revoke.
struct PhoneSignerView: View {
  @EnvironmentObject var m: AppModel
  @State private var fp: String? = nil; @State private var active: [String: Any]? = nil; @State private var err = ""; @State private var busy = false
  var mine: Bool { guard let a = active, let f = fp else { return false }; return (a["fingerprint"] as? String) == f }
  var body: some View {
    List {
      Section { FaceIDApprovalHeader(on: mine) }
      Section {
        if mine { Label(GasCheck.isV2(active) ? T("已开启 · 也能用 Siri 付款", "On · Siri payments work too") : T("已开启", "On"), systemImage: "checkmark.seal.fill").foregroundStyle(Brand.positive).accessibilityIdentifier("phone.active")
          if Operator.ownerPayEnabled && !GasCheck.isV2(active) {   // hidden once V2/V3 is the active approver (/phone/status version)
          Button { Task { await enroll(siri: true) } } label: { Label(Unbound.siriLabel, systemImage: "arrow.up.circle") }.disabled(busy).accessibilityIdentifier("phone.upgrade")
          } else if Operator.ownerPayEnabled && GasCheck.upgradeToV3(active) {   // only offered when the server turned V3 on
          Button { Task { await enroll(siri: true) } } label: { Label(T("更新 Face ID 批准（一次，手续费用 USDC 付）", "Update Face ID approvals (one time, fee in USDC)"), systemImage: "arrow.up.circle") }.disabled(busy).accessibilityIdentifier("phone.upgradeV3")
          }
          Button(T("关闭 Face ID 批准", "Turn off Face ID approvals")) { Task { do { m.openPhonePage(url: try await PhoneKey.verifiedRevokeURL()) } catch { err = error.localizedDescription } } }.foregroundStyle(Brand.negative)
        } else {
          if active != nil {   // t843: approvals live on another phone / app copy -> replace them here in one Coinbase confirmation (no dead end)
            Text(T("这台手机还没开启 Face ID 批准。开启后，旧手机或旧 App 里的批准会自动失效，你的钱不受影响。", "Face ID approvals aren't on for this phone yet. Turning them on here automatically retires the old phone or app copy. Your money isn't affected.")).foregroundStyle(.secondary).accessibilityIdentifier("phone.replaceNote")
            Button { Task { await enroll(replacing: active?["approver"] as? String) } } label: { Label(T("在这台手机开启", "Turn on for this phone"), systemImage: "faceid") }.disabled(busy).accessibilityIdentifier("phone.replace")
            Text(T("一次性手续费最多 0.05 USDC，从你的启付钱包扣。", "One-time fee of at most 0.05 USDC, from your Kipurse wallet.")).font(.footnote).foregroundStyle(.secondary)
          } else { Button { Task { await enroll() } } label: { Label(Unbound.bindLabel, systemImage: "faceid") }.disabled(busy).accessibilityIdentifier("phone.bind")
            Text(T("开通费约 0.03 USDC，从启付钱包余额扣 · 开启和关闭都要在你的 Coinbase 账户里确认一次", "Setup fee about 0.03 USDC from your Kipurse wallet balance · turning it on or off is confirmed once in your Coinbase account")).font(.footnote).foregroundStyle(.secondary) }
        }
        Button(T("刷新", "Refresh")) { Task { await load() } }
      }
      if !err.isEmpty { Section { Label(T("没能开启，请检查网络后再试一次。", "Couldn't turn it on. Check your connection and try again."), systemImage: "exclamationmark.triangle").foregroundStyle(Brand.negative).accessibilityIdentifier("phone.error")
        DisclosureGroup(T("详细信息", "Details")) { Text(err).font(.caption).foregroundStyle(.secondary) } } }
    }.scrollContentBackground(.hidden).background(Brand.canvas).navigationTitle(T("Face ID 批准", "Face ID approvals")).task { await load() }
    .onChange(of: m.phoneSignerChanged) { v in if v != nil { Task { await load() } } }
  }
  func load() async {
    active = await PhoneKey.status(); let want = active?["fingerprint"] as? String
    let fps = PhoneKey.all().compactMap { PhoneKey.fingerprint($0) }
    if let w = want, fps.contains(w) { fp = w; UserDefaults.standard.set(w, forKey: "kp.phoneFP") } else { fp = fps.first }
  }
  func enroll(siri: Bool = false, replacing: String? = nil) async {
    busy = true; defer { busy = false }; err = ""
    do { let k = try PhoneKey.create(); guard let (x, y) = PhoneKey.xy(k) else { return }; fp = PhoneTrust.fingerprint(x: x, y: y)
      let r = try await PhoneKey.post("phone/enroll", ["x": Hex.encode(x), "y": Hex.encode(y)])
      m.openPhonePage(url: try PhoneKey.verifiedEnrollURL(r, x: x, y: y, siri: siri, replacing: replacing ?? active?["approver"] as? String)) }
    catch { err = error.localizedDescription }
  }
}

struct TrustReq: Identifiable { let id: String }

/// kipurse://approve-trust?id=… : show the request (from the fields the phone hashes itself), Face ID, sign, relay.
struct PhoneApproveTrustSheet: View {
  @Environment(\.dismiss) private var dismiss
  let req: TrustReq
  @State private var data: [String: Any]? = nil; @State private var msg: OwnerTrustMessage? = nil; @State private var hash: [UInt8]? = nil
  @State private var issues: [String] = []; @State private var state = ""; @State private var done = false; @State private var busy = false; @State private var notBound = false
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
          Section(T("上限", "Limits")) { LabeledContent(T("每笔最多", "Per payment"), value: usdc(m.single)); LabeledContent(T("每天最多", "Per day"), value: usdc(m.daily))
            LabeledContent(T("到期", "Expires"), value: m.expiry == RequestVerify.noExpiry ? T("不过期，直到你取消", "Never, until you remove it") : Date(timeIntervalSince1970: Double(m.expiry) ?? 0).formatted(date: .abbreviated, time: .omitted)) }
          Section(T("AI 说的理由（仅供参考）", "AI's reason (for reference only)")) { Text("\(m.name) — \(r["reason"] as? String ?? "")").font(.callout)
            Text(T("申请的 AI：", "Requested by: ") + ((r["requestedBy"] as? [String])?.joined(separator: ", ") ?? "")).font(.caption).foregroundStyle(.secondary) }
          if let fr = FeeReceipt(data?["feePreview"] as? [String: Any]) { Section(T("费用（Face ID 之前看清）", "Fees (before Face ID)")) { ForEach(Array(fr.rows(zh: Loc.isChinese).enumerated()), id: \.offset) { LabeledContent($0.element.0, value: $0.element.1) } }.accessibilityIdentifier("trust.fee.preview") }
          if RequestVerify.isReusableTrust(m) { Section { Label(RequestVerify.rememberNote(zh: Loc.isChinese), systemImage: "checkmark.shield").font(.callout).accessibilityIdentifier("trust.remember.free") } }
          if !issues.isEmpty { Section { ForEach(issues, id: \.self) { Text($0).foregroundStyle(Brand.negative) } } }
          Section {
            if done { Label(state, systemImage: "checkmark.seal.fill").foregroundStyle(Brand.positive) }
            else { let risky = checkStatus == "lookalike" || checkStatus == "dust_only"
              if risky { Button(role: .destructive) { Task { await reject() } } label: { Label(T("拒绝（推荐）", "Reject (recommended)"), systemImage: "hand.raised.fill").font(.headline) }.disabled(busy).accessibilityIdentifier("trust.reject.primary") }
              Button { Task { await approve() } } label: { Label(risky ? T("我确认地址没问题，用 Face ID 批准", "I checked it. Approve with Face ID") : T("用 Face ID 批准", "Approve with Face ID"), systemImage: "faceid").font(risky ? .callout : .headline) }.disabled(busy || !issues.isEmpty || hash == nil)
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
      issues += RequestVerify.trust(om, wallet: PhoneTrust.mainnetWallet, localMaxSingle: UserDefaults.standard.string(forKey: "kp.phoneMaxSingle"), localMaxDaily: UserDefaults.standard.string(forKey: "kp.phoneMaxDaily"))
      if let d = PhoneTrust.digest(om) { if Hex.encode(d).lowercased() != (j["digest"] as? String ?? "").lowercased() { issues.append(T("服务器给的内容和手机算出的不一致，已停止。", "Server data doesn't match what the phone computed. Stopped.")) } else { hash = PhoneTrust.walletHash(d) } }
    } catch { state = error.localizedDescription }
  }
  func approve() async {
    guard let h = hash, let k = PhoneKey.existing() else { return }; busy = true; defer { busy = false }
    do { let (r, s) = try PhoneKey.sign(h, key: k); state = T("正在核对并上链…（10–30 秒）", "Checking and writing on chain… (10–30 s)")
      let j = try await PhoneKey.post("approve/trust/phone-sign", ["id": req.id, "r": Hex.encode(r), "s": Hex.encode(s)]); Haptics.success()
      done = true; state = (j["inline"] as? Bool == true) ? RequestVerify.rememberedDone(zh: Loc.isChinese) : T("✅ 已允许。AI 现在可以在上限内付给它。", "✅ Allowed. Your AI can now pay it within your limits.")
    } catch { state = error.localizedDescription }
  }
  func reject() async {
    guard let k = PhoneKey.existing(), let r = data?["request"] as? [String: Any], let payee = r["payee"] as? String else { return }; busy = true; defer { busy = false }
    let d = [UInt8](SHA256.hash(data: Data(PhoneTrust.rejectMessage(id: req.id, payee: payee).utf8)))
    do { let (rr, ss) = try PhoneKey.sign(d, key: k); _ = try await PhoneKey.post("approve/trust/phone-reject", ["id": req.id, "r": Hex.encode(rr), "s": Hex.encode(ss)]); done = true; state = T("已拒绝。", "Rejected.") }
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
    return (calls, owner, wallet, (r["chainId"] as? Int) ?? Int(r["chainId"] as? String ?? "") ?? 8453)
  }
  /// replacing: the old approver from phone/status (t843). The server's `replaces` must name the same one, and the batch must add-then-remove exactly it.
  static func verifiedEnrollURL(_ r: [String: Any], x: [UInt8], y: [UInt8], siri: Bool = false, replacing: String? = nil) throws -> URL {
    guard let u = r["url"] as? String, let url0 = URL(string: u) else { throw stopErr([T("没有确认页", "no signing page")]) }
    let p = try plan(r)
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
          .background(LinearGradient(colors: [Brand.accentHi, Brand.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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
