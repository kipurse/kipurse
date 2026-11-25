import Foundation

/// ON-DEVICE checks of what the server asks this user to sign, done BEFORE Face ID / the Coinbase wallet page opens.
/// The phone decodes the raw calldata itself and compares it with what the user chose; any mismatch blocks signing.
public enum RequestVerify {
  public static let spendPermissionManager = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad"
  public static let usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  static let selExecuteBatch = "34fcd5be", selRevoke = "78792f76", selApprove = "33211c30", selRegister = "8a5daae1"

  public struct Permission: Equatable { public var account, spender, token: String; public var allowance, period, start, end: UInt64?; public var policy: [String] }
  public struct Choice { public var single, daily, term: String; public var days: Int?
    /// t1185 (decision 85): daily on-chain operations the owner picked (nil = unchanged; no setOpsPerDay call allowed).
    public var opsPerDay: Int?
    /// t1281 (decision 141 (1)): the owner's own limits for strangers (atomic USDC; both nil = an older server / legacy formula, see subCaps).
    public var openSingle: String?, openDaily: String?
    public init(single: String, daily: String, term: String, days: Int?, opsPerDay: Int? = nil, openSingle: String? = nil, openDaily: String? = nil) { self.single = single; self.daily = daily; self.term = term; self.days = days; self.opsPerDay = opsPerDay; self.openSingle = openSingle; self.openDaily = openDaily } }
  public struct Result: Equatable { public var problems: [String] = []; public var notes: [String] = []; public var ok: Bool { problems.isEmpty }
    /// t1280 (Q3): the ABI arguments of the ONE revoke(SpendPermission) inside a limits batch (nil = no revoke). The App asks the chain
    /// (two agreeing nodes, RequestVerify.revokedIsLive) whether exactly this permission is the live one before the signing page opens.
    public var revokeArgs: [UInt8]? = nil }

  // ---- tiny ABI reader ----
  struct R { let b: [UInt8]
    func word(_ o: Int) -> [UInt8]? { o >= 0 && o + 32 <= b.count ? Array(b[o..<(o + 32)]) : nil }
    func int(_ o: Int) -> Int? { guard let w = word(o), w.prefix(24).allSatisfy({ $0 == 0 }) else { return nil }; return w.suffix(8).reduce(0) { $0 << 8 | Int($1) } }
    func u64(_ o: Int) -> UInt64? { guard let w = word(o), w.prefix(24).allSatisfy({ $0 == 0 }) else { return nil }; return w.suffix(8).reduce(0) { $0 << 8 | UInt64($1) } }
    func addr(_ o: Int) -> String? { guard let w = word(o), w.prefix(12).allSatisfy({ $0 == 0 }) else { return nil }; return Hex.encode(Array(w.suffix(20))).lowercased() }
    func dec(_ o: Int) -> String? { guard let w = word(o) else { return nil }; return decimal(w) }
    func bytes(_ o: Int) -> [UInt8]? { guard let n = int(o), o + 32 + n <= b.count else { return nil }; return Array(b[(o + 32)..<(o + 32 + n)]) }
  }
  static func decimal(_ w: [UInt8]) -> String { var d = [UInt8](); for byte in w { var c = Int(byte); for i in 0..<d.count { let v = Int(d[i]) * 256 + c; d[i] = UInt8(v % 10); c = v / 10 }; while c > 0 { d.append(UInt8(c % 10)); c /= 10 } }
    return d.isEmpty ? "0" : String(d.reversed().map { Character(String($0)) }) }
  static func lt(_ a: String, _ b: String) -> Bool { a.count != b.count ? a.count < b.count : a < b }
  static func lc(_ s: String) -> String { s.lowercased() }

  /// SpendPermission tuple whose head starts at `t` (args are relative to t).
  static func permission(_ r: R, at t: Int) -> Permission? {
    guard let a = r.addr(t), let s = r.addr(t + 32), let tok = r.addr(t + 64), let eo = r.int(t + 256), let ed = r.bytes(t + eo) else { return nil }
    let pr = R(b: ed); var pol = [String]()
    for i in 0..<12 { if i == 0 || i == 1 || i == 9 { guard let x = pr.addr(i * 32) else { return nil }; pol.append(x) } else { guard let x = pr.dec(i * 32) else { return nil }; pol.append(x) } }
    return Permission(account: a, spender: s, token: tok, allowance: r.u64(t + 96), period: r.u64(t + 128), start: r.u64(t + 160), end: r.u64(t + 192), policy: pol)
  }
  /// wallet.execute(USDC, 0, transfer(owner, fee<=0.05 USDC)). nil = OK.
  public static func feeRefundProblem(_ c: [String: Any], wallet: String, owner: String?, alsoTo: String? = nil) -> String? {
    guard let o = owner, let to = c["to"] as? String, lc(to) == lc(wallet), let d = (c["data"] as? String).flatMap(Hex.decode), d.count >= 4, Hex.encode(Array(d.prefix(4))) == "0xb61d27f6" else { return "unexpected extra call" }
    if let v = c["value"] as? String, v != "0x0", v != "0" { return "fee refund sends ETH" }
    let r = R(b: Array(d.dropFirst(4)))
    guard let tgt = r.addr(0), lc(tgt) == lc(usdc), r.dec(32) == "0", let io = r.int(64), let inner = r.bytes(io), inner.count >= 68, Hex.encode(Array(inner.prefix(4))) == "0xa9059cbb" else { return "fee refund is not a USDC transfer" }
    let ir = R(b: Array(inner.dropFirst(4)))
    guard let rcpt = ir.addr(0), lc(rcpt) == lc(o) || (alsoTo.map { lc(rcpt) == lc($0) } ?? false) else { return "fee refund goes to someone else" }
    guard let amt = ir.dec(32), let n = UInt64(amt), n <= 50_000 else { return "fee refund above 0.05 USDC" }
    return nil
  }
  /// One wallet call: wallet.executeBatch([...]) whose inner calls may ONLY be revoke/approve on the Spend Permission Manager and
  /// registerPermission on the Kipurse adapter, all for THIS wallet, with exactly the caps the user picked.
  /// t767: Kipurse ops account and per-op cap for legacy dues (pre-t1022 onboarding gas; vault fee slot). Fixed here, never from the server.
  /// t1123: the official Kipurse fee address (= server DUES_SLOT / withdraw feeTo / OwnerExit.withdrawFeeTo / UsdcGas.feeTo). Was the stale 0xfc0E…345B.
  public static let duesTo = "0xf14ef5dc4723245866c22c749a0a84afceba0dd9", duesMaxPerOp: UInt64 = 50_000, selSetBundlerFee = "f039b127"
  public static func limitsBatch(calls inCalls: [[String: Any]], wallet: String, chainId: Int, choice: Choice, currentExecutor: String?, adapter: String = PhoneTrust.mainnetAdapter, owner: String? = nil, vault: String? = nil, now: Date = Date(), walletPays: Bool = false, requireRevoke: Bool = false) -> Result {
    var res = Result(); func bad(_ s: String) { res.problems.append(s) }
    // t147: the retired third-party ERC-20 paymaster (Pimlico) shape is never signed. Later changes use limitsReply (Kipurse sponsor route).
    if walletPays { bad("the retired USDC paymaster path is not supported"); return res }
    // t606: an optional 2nd call = the wallet refunds the network fee (USDC only, max 0.05) to YOUR Coinbase wallet.
    var calls = inCalls
    if calls.count == 2 { let rf = calls[1]; calls = [calls[0]]
      if let why = feeRefundProblem(rf, wallet: wallet, owner: owner) { bad(why) } else { res.notes.append("wallet pays the network fee in USDC") } }
    if chainId != 8453 { bad("wrong chain \(chainId)") }
    guard calls.count == 1, let c = calls.first, let to = c["to"] as? String, let data = (c["data"] as? String).flatMap(Hex.decode) else { bad("expected exactly one call"); return res }
    if lc(to) != lc(wallet) { bad("call goes to another wallet") }
    if let v = c["value"] as? String, v != "0x0", v != "0" { bad("sends ETH") }
    guard data.count >= 4, Hex.encode(Array(data.prefix(4))) == "0x" + selExecuteBatch else { bad("not a wallet batch"); return res }
    let r = R(b: Array(data.dropFirst(4)))
    guard let ao = r.int(0), let n = r.int(ao), n > 0, n <= 8 else { bad("bad batch"); return res }
    var approved: Permission?, registered: Permission?, revoked: Permission?, revokeArgs: [UInt8]?, revokes = 0, dues = 0, opsSet = 0
    for i in 0..<n {
      guard let eo = r.int(ao + 32 + i * 32) else { bad("bad batch"); return res }; let e = ao + 32 + eo
      guard let target = r.addr(e), let val = r.dec(e + 32), let dofs = r.int(e + 64), let inner = r.bytes(e + dofs), inner.count >= 4 else { bad("bad inner call"); return res }
      if val != "0" { bad("inner call sends ETH") }
      let sel = String(Hex.encode(Array(inner.prefix(4))).dropFirst(2)); let ir = R(b: Array(inner.dropFirst(4)))
      // t767: optional LAST inner call vault.setBundlerFee(Kipurse ops, <= 0.05 USDC): only to this wallet's vault, only once
      if sel == selSetBundlerFee {
        if i != n - 1 || dues > 0 { bad("fee-slot step in an unexpected place") }
        if vault == nil || lc(target) != lc(vault!) { bad("fee-slot step targets something other than your vault") }
        if inner.count != 68 || lc(ir.addr(0) ?? "") != duesTo { bad("fee-slot step pays someone other than Kipurse's ops account") }
        if let m = ir.dec(32), let mv = UInt64(m), mv <= duesMaxPerOp, mv > 0 {} else { bad("fee-slot cap is above 0.05 USDC") }
        dues += 1; res.notes.append("account-opening fee fronted by Kipurse: 0.05 USDC, taken once with the first AI payment"); continue
      }
      // t1185 (decision 85): optional vault.setOpsPerDay(n) - ONLY to this wallet's V5.3 vault (computed on the phone), ONLY the number you picked, once
      if sel == OpsCap.selSetOpsPerDay {
        guard let want = choice.opsPerDay else { bad("changes the daily operations although you did not"); continue }
        if opsSet > 0 { bad("daily operations set twice") }
        let opsVault = lc(adapter) == lc(KipurseSuite.v55.adapter) ? KipurseSuite.v55.vault(wallet: wallet) : OpsCap.vault(wallet: wallet)   // t1250: V5.5 vault on V5.5
        if inner.count != 36 || lc(target) != (opsVault ?? "-") { bad("daily-operations step targets something other than your vault") }
        if ir.dec(0) != String(want) { bad("daily operations differ from your choice") }
        opsSet += 1; res.notes.append("daily on-chain operations: \(want)"); continue
      }
      guard let po = ir.int(0), let p = permission(ir, at: po) else { bad("unknown call \(sel) to \(target)"); continue }
      if lc(p.account) != lc(wallet) { bad("permission for another wallet") }
      if lc(p.spender) != lc(adapter) { bad("permission spender is not the Kipurse adapter") }
      if lc(p.token) != lc(usdc) { bad("permission token is not USDC") }
      switch (sel, lc(target)) {
      case (selRevoke, lc(spendPermissionManager)): revokes += 1; revoked = p; revokeArgs = Array(inner.dropFirst(4))
      case (selApprove, lc(spendPermissionManager)): approved = p
      case (selRegister, lc(adapter)): registered = p
      default: bad("unexpected call \(sel) to \(target)")
      }
    }
    if let want = choice.opsPerDay, opsSet == 0 { bad("your daily operations choice (\(want)) is missing") }
    guard let p = approved else { bad("no new permission"); return res }
    if let g = registered, g != p { bad("registered permission differs from the approved one") }
    if revokes > 1 { bad("revokes more than one permission") }
    // t1280 (Q3): a later limit change replaces exactly ONE permission (the live one; the App confirms it on chain via revokeArgs)
    if requireRevoke && revokes != 1 { bad("a limit change must replace exactly your current permission") }
    let pol = p.policy
    // t1280 (Q2): guardian / registry / fee ceilings / sub-caps by the server's own formula (change: from the revoked permission; opening: template)
    for why in policyProblems(pol, old: revokes == 1 ? revoked?.policy : nil, single: choice.single, daily: choice.daily, openSingle: choice.openSingle, openDaily: choice.openDaily, v55: lc(adapter) == lc(KipurseSuite.v55.adapter)) { bad(why) }
    if revokes == 1, let ra = revokeArgs { res.revokeArgs = ra }
    if pol[2] != choice.single { bad("per-payment cap differs from your choice") }
    if pol[3] != choice.daily { bad("daily cap differs from your choice") }
    if pol[4] != choice.term || p.allowance.map(String.init) != choice.term { bad("total differs from your choice") }
    if lt(choice.single, pol[5]) || lt(choice.daily, pol[6]) || lt(choice.single, pol[7]) || lt(choice.daily, pol[8]) { bad("a sub-cap is above your caps") }
    if pol[0] == "0x0000000000000000000000000000000000000000" || lc(pol[0]) == lc(wallet) { bad("bad AI signer") }
    if let cur = currentExecutor, lc(cur) != lc(pol[0]) { res.notes.append("AI signer key changes to \(pol[0])") }
    if let s = p.start, let e = p.end { let t = UInt64(now.timeIntervalSince1970)
      if e <= t { bad("already expired") }
      if let d = choice.days, e > s + UInt64(d) * 86400 + 120 { bad("term longer than you chose") }
      if e - s > 366 * 86400 { bad("term longer than a year") }
    } else { bad("bad term") }
    return res
  }
  // MARK: t1280 (Q2/Q3) - the SpendPermission policy fields the server must not choose freely
  /// Policy layout (gw abi.mjs POLICY_V5_T / KipurseAdapterV55.Policy): [0] executor, [1] guardian, [2] single, [3] daily, [4] term,
  /// [5] openSingle, [6] openDaily, [7] verifiedSingle, [8] verifiedDaily, [9] registry, [10] maxFeePpm, [11] maxNetworkFee.
  public static let zeroAddress = "0x0000000000000000000000000000000000000000"
  /// The Kipurse merchant registry every Kipurse permission names (same address in the live V5.2/V5.4 permissions and the onboarding template).
  public static let merchantRegistry = "0x26c707ccbd569624cf31f5c574d4fdf7e3f23998"
  /// Every registry a Kipurse permission may name: none, the Kipurse registry, or the V5.5 registry V2 (KipurseV55.registryV2, the
  /// server's V5.5 move switches a registry-using permission to it: gw wallet-v55.mjs permissionV55).
  public static var knownRegistries: [String] { [zeroAddress, merchantRegistry, KipurseV55.registryV2.lowercased()] }
  /// Absolute ceilings, whatever the server says: protocol fee rate <= 0.1 %, per-payment network fee <= 0.05 USDC (atomic).
  public static let maxFeePpmCeiling = "1000", maxNetworkFeeCeiling = "50000"
  /// The server's onboarding template permission (gw onboard-new.mjs policy()): guardian none, Kipurse registry, fee ceilings, sub-caps
  /// 0.1 / 0.2002 USDC (open payees) and 2 / 5.005 USDC (registry-verified merchants). Sub-caps of a new wallet = min(template, choice).
  public static let templatePolicy: [String] = ["", zeroAddress, "", "", "", "100000", "200200", "2000000", "5005000", merchantRegistry, "1000", "50000"]
  static func minDec(_ a: String, _ b: String) -> String { lt(a, b) ? a : b }
  /// Ceilings every new policy must meet (limits change, opening, V5.5 move).
  public static func policyCeilingProblems(_ pol: [String]) -> [String] {
    guard pol.count == 12 else { return ["bad policy"] }
    var p = [String]()
    if lc(pol[1]) != zeroAddress { p.append("the permission names an emergency pauser you did not choose") }
    if !knownRegistries.contains(lc(pol[9])) { p.append("the permission names an unknown merchant registry") }
    if lt(maxFeePpmCeiling, pol[10]) { p.append("the fee rate ceiling is above 0.1%") }
    if lt(maxNetworkFeeCeiling, pol[11]) { p.append("the network fee ceiling is above 0.05 USDC") }
    return p
  }
  /// The server formula (0A#10): change (`old` = the revoked policy) keeps guardian / registry / maxFeePpm / maxNetworkFee and sets each
  /// sub-cap to min(old sub-cap, your cap); opening (`old` = nil) uses the template the same way. Anything else is refused.
  /// `v55`: a V5.5 opening may name the V5.5 registry V2 instead of the template's registry (same template otherwise).
  /// t1281: `openSingle` / `openDaily` = the stranger limits the owner chose in the app (atomic; nil = legacy formula, an older server).
  /// Explicit values must be EXACTLY in the policy (subCaps); verified sub-caps keep min(base, your cap).
  public static func policyProblems(_ pol: [String], old: [String]?, single: String, daily: String, openSingle: String? = nil, openDaily: String? = nil, v55: Bool = false) -> [String] {
    var p = policyCeilingProblems(pol)
    guard pol.count == 12 else { return p }
    let base = old ?? templatePolicy
    guard base.count == 12 else { return p + ["bad current permission"] }
    let registryOK = lc(pol[9]) == lc(base[9]) || (old == nil && v55 && lc(pol[9]) == lc(KipurseV55.registryV2))
    if lc(pol[1]) != lc(base[1]) || !registryOK || pol[10] != base[10] || pol[11] != base[11] {
      p.append(old == nil ? "pauser / registry / fee ceilings differ from Kipurse's standard permission" : "pauser / registry / fee ceilings differ from your current permission") }
    let sc = subCaps(single: single, daily: daily, openSingle: openSingle, openDaily: openDaily, base: base)
    if let e = sc.error { p.append("your limits for new payees are not valid (\(e))") }
    else if let c = sc.caps {
      let openOK = pol[5] == c.openSingle && pol[6] == c.openDaily, verOK = pol[7] == c.verifiedSingle && pol[8] == c.verifiedDaily
      if openSingle != nil && !openOK { p.append("the limits for new payees differ from what you chose") }
      if !verOK || (openSingle == nil && !openOK) { p.append(old == nil ? "a sub-cap differs from Kipurse's standard sub-caps" : "a sub-cap differs from your current sub-caps") }
    }
    // the contract's own rule (_policy): stranger limits never above the main limits of the SAME policy
    if lt(pol[2], pol[5]) || lt(pol[3], pol[6]) { p.append("a limit for new payees is above your main limit") }
    return p
  }

  // MARK: t1281 (owner decision decision 141 (1)) - THE stranger sub-limit formula, identical to the server's (gw src/v5/limits-public.mjs
  // subCaps / strangerChoiceError; cross-test gw test/t1281-stranger-cap.test.mjs -> t1281-stranger-caps.json.txt).
  // "Stranger" = a payee you have not trusted that is not registry-listed: policy [5] openSingle = per payment (amount only),
  // [6] openDaily = per day INCLUDING fees, one counter for all strangers.
  //  - explicit (you chose them): exactly your numbers; must be 0 < openSingle <= single, 0 < openDaily <= daily, openSingle <= openDaily,
  //    else REFUSED (never clamped).   - legacy (both nil): min(base, your cap), as before.   - verified: always min(base, your cap).
  // FEE HEADROOM RULE: none. Openings and limit changes are built with headroom:false, so the on-chain daily IS your daily number (fees
  // count inside it); the stranger daily is treated the same (your number verbatim), so "same as my normal limits" = the policy daily.
  public struct SubCaps: Equatable { public var openSingle, openDaily, verifiedSingle, verifiedDaily: String }
  /// Decimal digits (at most 30) without leading zeros, or nil (same as the server's /^\d{1,30}$/ + BigInt).
  static func atomicDec(_ s: String?) -> String? {
    guard let s, !s.isEmpty, s.count <= 30, s.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
    let t = s.drop(while: { $0 == "0" }); return t.isEmpty ? "0" : String(t) }
  /// nil = OK (or legacy: both nil); else the server's error code. Same check order as the server.
  public static func strangerChoiceError(single: String, daily: String, openSingle: String?, openDaily: String?) -> String? {
    if openSingle == nil && openDaily == nil { return nil }
    if openSingle == nil || openDaily == nil { return "stranger_incomplete" }
    guard let os = atomicDec(openSingle), let od = atomicDec(openDaily), let s = atomicDec(single), let d = atomicDec(daily) else { return "bad_stranger_amount" }
    if os == "0" { return "stranger_single_zero" }
    if od == "0" { return "stranger_daily_zero" }
    if lt(s, os) { return "stranger_single_above_single" }
    if lt(d, od) { return "stranger_daily_above_daily" }
    if lt(od, os) { return "stranger_single_above_stranger_daily" }
    return nil
  }
  /// The four sub-limit words a policy must carry for your choice. `base` = the template (opening) or the revoked policy (change).
  public static func subCaps(single: String, daily: String, openSingle: String?, openDaily: String?, base: [String]) -> (caps: SubCaps?, error: String?) {
    if let e = strangerChoiceError(single: single, daily: daily, openSingle: openSingle, openDaily: openDaily) { return (nil, e) }
    guard base.count >= 9, let s = atomicDec(single), let d = atomicDec(daily), let b5 = atomicDec(base[5]), let b6 = atomicDec(base[6]), let b7 = atomicDec(base[7]), let b8 = atomicDec(base[8]) else { return (nil, "bad_amount") }
    let explicit = openSingle != nil
    return (SubCaps(openSingle: explicit ? atomicDec(openSingle)! : minDec(b5, s), openDaily: explicit ? atomicDec(openDaily)! : minDec(b6, d),
                    verifiedSingle: minDec(b7, s), verifiedDaily: minDec(b8, d)), nil)
  }
  /// t1280 (Q3): the SpendPermissionManager views over the SAME argument bytes the revoke carries.
  static let permTuple = "(address,address,address,uint160,uint48,uint48,uint48,uint256,bytes)"
  static var selIsValid: String { String(BatchVerify.sel("isValid" + "(" + permTuple + ")").dropFirst(2)) }
  static var selIsApproved: String { String(BatchVerify.sel("isApproved" + "(" + permTuple + ")").dropFirst(2)) }
  static var selIsRevoked: String { String(BatchVerify.sel("isRevoked" + "(" + permTuple + ")").dropFirst(2)) }
  static func boolWord(_ v: String?) -> Bool? { guard let v, let b = Hex.decode(v), b.count == 32, b.prefix(31).allSatisfy({ $0 == 0 }), b[31] <= 1 else { return nil }; return b[31] == 1 }
  public typealias ChainCall = (_ to: String, _ data: String) async -> String?
  /// true only when two agreeing public nodes say the permission being revoked is approved on the SpendPermissionManager and not revoked
  /// (isValid; if that is false, e.g. the term ended, isApproved && !isRevoked). Any read failure or disagreement = false (refuse).
  public static func revokedIsLive(_ args: [UInt8], call: ChainCall = { to, d in await ChainRPC.ethCall(to, d, agreed: true) }) async -> Bool {
    guard !args.isEmpty else { return false }
    let a = String(Hex.encode(args).dropFirst(2)), spm = spendPermissionManager
    if boolWord(await call(spm, "0x" + selIsValid + a)) == true { return true }
    guard boolWord(await call(spm, "0x" + selIsApproved + a)) == true, boolWord(await call(spm, "0x" + selIsRevoked + a)) == false else { return false }
    return true
  }

  /// t1104: the App's check of a /owner/limits/prepare reply (calls exactly as the server sent them).
  /// t147: the old wallet-pays shape (a third-party ERC-20 paymaster approve) is refused. The UsdcGas.split rules (approve only to the
  /// CDP paymaster, <= 0.25 USDC) stay exactly as before for every other batch. The live path is limitsReply.
  public static func limitsPrepared(calls: [[String: Any]], wallet: String, chainId: Int, choice: Choice, owner: String?, walletPays: Bool, now: Date = Date()) -> Result {
    if walletPays { return Result(problems: ["the retired USDC paymaster path is not supported"]) }
    let ug = UsdcGas.split(calls, wallet: wallet)
    if !ug.problems.isEmpty || ug.deposit > 0 { return Result(problems: ug.problems.isEmpty ? ["USDC deposit inside a limits change"] : ug.problems) }
    return limitsBatch(calls: ug.rest, wallet: wallet, chainId: chainId, choice: choice, currentExecutor: nil, owner: owner, now: now, walletPays: false, requireRevoke: true)
  }

  // MARK: t1123 (decision 63) — later limit changes: the network fee comes from the Kipurse wallet's USDC in the SAME confirmation.
  /// Server feeFrom for the only limits batch this build signs.
  public static let limitsWalletFeeFrom = "kipurse_wallet_fee"
  /// Fee ceiling for one limits change (0.01 USDC, exclusive), same as the server cap.
  public static let limitsFeeCapAtomic: UInt64 = 10_000
  /// The existing sponsor route the server registers this exact batch with (no Pimlico, no other paymaster).
  public static let limitsPaymasterPrefix = "https://pay.kipurse.com/onboard/new/paymaster?id=lw-"
  /// wallet.execute(USDC, 0, transfer(duesTo, F)) with 0 < F < 0.01 USDC, exact ABI encoding. Returns F, or nil + why.
  public static func walletFeeLeg(_ c: [String: Any], wallet: String) -> (fee: UInt64?, problem: String?) {
    guard let to = c["to"] as? String, lc(to) == lc(wallet) else { return (nil, "fee step is not from your Kipurse wallet") }
    if let v = c["value"] as? String, v != "0x0", v != "0" { return (nil, "fee step sends ETH") }
    guard let d = (c["data"] as? String).flatMap(Hex.decode), d.count == 4 + 32 * 4 + 96, Hex.encode(Array(d.prefix(4))) == "0xb61d27f6" else { return (nil, "fee step is not a single USDC transfer") }
    let r = R(b: Array(d.dropFirst(4)))
    guard let tgt = r.addr(0), lc(tgt) == lc(usdc), r.dec(32) == "0", r.int(64) == 96, let inner = r.bytes(96), inner.count == 68,
          Array(d.suffix(28)).allSatisfy({ $0 == 0 }), Hex.encode(Array(inner.prefix(4))) == "0xa9059cbb" else { return (nil, "fee step is not a single USDC transfer") }
    let ir = R(b: Array(inner.dropFirst(4)))
    guard let rcpt = ir.addr(0), lc(rcpt) == duesTo else { return (nil, "fee goes to someone other than Kipurse's fee address") }
    guard let amt = ir.dec(32), let n = UInt64(amt), n > 0, n < limitsFeeCapAtomic else { return (nil, "fee is not between 0 and 0.01 USDC") }
    return (n, nil)
  }
  public struct LimitsReply { public var result: Result; public var from: String?; public var fee: UInt64? }
  /// The App's whole check of a /owner/limits/prepare reply (what MainnetViews calls before the signing page opens).
  /// Accepts ONLY: feeFrom kipurse_wallet_fee, sent from YOUR Base Account (it only signs, needs no USDC), paymaster = Kipurse's
  /// sponsor route for this batch, and exactly [wallet -> Kipurse fee address F (< 0.01 USDC), the cap change you chose].
  /// Refuses the retired relay (wallet -> your Base Account + a third-party paymaster approve), any paymaster approve, a refund to you, and anything else.
  public static func limitsReply(_ j: [String: Any], wallet: String, owner: String?, choice: Choice, now: Date = Date()) -> LimitsReply {
    var res = Result(); func bad(_ s: String) { res.problems.append(s) }
    guard (j["feeFrom"] as? String) == limitsWalletFeeFrom else { bad("this change does not take the fee from your Kipurse wallet in the same confirmation"); return LimitsReply(result: res, from: nil, fee: nil) }
    guard let o = owner, !o.isEmpty else { bad("no Base Account to sign with"); return LimitsReply(result: res, from: nil, fee: nil) }
    if lc(j["owner"] as? String ?? "") != lc(o) { bad("the signer isn't your Base Account") }
    if lc(j["from"] as? String ?? "") != lc(o) { bad("sent from something other than your Base Account") }
    if lc(j["wallet"] as? String ?? "") != lc(wallet) { bad("another wallet") }
    if let ft = j["feeTo"] as? String, lc(ft) != duesTo { bad("fee goes to someone other than Kipurse's fee address") }
    if !(j["pm"] as? String ?? "").hasPrefix(limitsPaymasterPrefix) { bad("unexpected paymaster") }
    let chain = (j["chainId"] as? Int) ?? Int(j["chainId"] as? String ?? "") ?? 0
    guard let calls = j["calls"] as? [[String: Any]], calls.count == 2 else { bad("expected exactly the fee step and the cap change"); return LimitsReply(result: res, from: nil, fee: nil) }
    let leg = walletFeeLeg(calls[0], wallet: wallet)
    if let why = leg.problem { bad(why) }
    if let f = leg.fee, let q = (j["fee"] as? [String: Any])?["usdc"] as? String, q != String(f) { bad("fee differs from the quote") }
    let rest = limitsBatch(calls: [calls[1]], wallet: wallet, chainId: chain, choice: choice, currentExecutor: nil, owner: o, now: now, walletPays: false, requireRevoke: true)
    res.problems += rest.problems; res.notes += rest.notes; res.revokeArgs = rest.revokeArgs
    if leg.fee != nil { res.notes.append("network fee from your Kipurse wallet USDC, same confirmation") }
    return LimitsReply(result: res, from: res.ok ? o : nil, fee: leg.fee)
  }

  // MARK: t1139 (decision 71, owner decision t1139 option a) — resume after an emergency stop lifts the ON-CHAIN pause too.
  /// The only resume batch this build signs: [Kipurse wallet -> Kipurse fee address F (0 < F < 0.01 USDC), wallet.execute(KipurseTrust, 0, setPaused(false))],
  /// sent from YOUR Base Account (it only signs, pays no ETH), through Kipurse's sponsor route registered for exactly this batch (ur-).
  public static let resumePaymasterPrefix = "https://pay.kipurse.com/onboard/new/paymaster?id=ur-"
  /// wallet.execute(KipurseTrust, 0, setPaused(false)), exact ABI encoding.
  public static var unpauseCallData: String {
    let z = { (n: Int) in String(repeating: "0", count: n) }
    return "0xb61d27f6" + z(24) + String(BatchVerify.trust.lowercased().dropFirst(2)) + z(64) + z(62) + "60" + z(62) + "24" + "16c38b3c" + z(64) + z(56)
  }
  public struct ResumeReply { public var result: Result; public var id: String?; public var url: URL?; public var from: String?; public var calls: [[String: Any]]; public var fee: UInt64? }
  /// The App's whole check of a 202 /safety/resume reply (Face ID accepted, wallet still paused on chain) before the signing page opens.
  public static func resumeReply(_ j: [String: Any], wallet: String, owner: String?) -> ResumeReply {
    var res = Result(); func bad(_ s: String) { res.problems.append(s) }
    func out(_ calls: [[String: Any]] = [], fee: UInt64? = nil, id: String? = nil, url: URL? = nil) -> ResumeReply {
      ResumeReply(result: res, id: res.ok ? id : nil, url: res.ok ? url : nil, from: res.ok ? owner : nil, calls: res.ok ? calls : [], fee: res.ok ? fee : nil) }
    guard (j["state"] as? String) == "confirm_on_chain" else { bad("not a resume confirmation"); return out() }
    guard (j["feeFrom"] as? String) == limitsWalletFeeFrom else { bad("the fee is not taken from your Kipurse wallet in the same confirmation"); return out() }
    guard let o = owner, !o.isEmpty else { bad("no Base Account to sign with"); return out() }
    if lc(j["owner"] as? String ?? "") != lc(o) { bad("the signer isn't your Base Account") }
    if lc(j["from"] as? String ?? "") != lc(o) { bad("sent from something other than your Base Account") }
    if lc(j["wallet"] as? String ?? "") != lc(wallet) { bad("another wallet") }
    if lc(j["feeTo"] as? String ?? "") != duesTo { bad("fee goes to someone other than Kipurse's fee address") }
    if let t = j["trust"] as? String, lc(t) != lc(BatchVerify.trust) { bad("another contract") }
    if ((j["chainId"] as? Int) ?? Int(j["chainId"] as? String ?? "") ?? 0) != 8453 { bad("not Base") }
    guard let id = j["id"] as? String, id.count == 24, id == id.lowercased(), id.allSatisfy(\.isHexDigit) else { bad("bad plan id"); return out() }
    if (j["pm"] as? String ?? "") != resumePaymasterPrefix + id { bad("unexpected paymaster") }
    guard let us = j["url"] as? String, let u = URL(string: us), u.scheme == "https", u.host?.lowercased() == SignHost.apiHost, u.port == nil,
          SignHost.corePath(u.path) == "/safety/resume", URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "plan" })?.value == id else { bad("unexpected page"); return out() }
    guard let calls = j["calls"] as? [[String: Any]], calls.count == 2 else { bad("expected exactly the fee step and the unpause step"); return out() }
    let leg = walletFeeLeg(calls[0], wallet: wallet)
    if let why = leg.problem { bad(why) }
    if let f = leg.fee, ((j["fee"] as? [String: Any])?["usdc"] as? String) != String(f) { bad("fee differs from the quote") }
    let c1 = calls[1]
    if lc(c1["to"] as? String ?? "") != lc(wallet) { bad("unpause step is not from your Kipurse wallet") }
    if let v = c1["value"] as? String, v != "0x0", v != "0" { bad("unpause step sends ETH") }
    if lc(c1["data"] as? String ?? "") != unpauseCallData { bad("unpause step does something else") }
    if res.ok { res.notes.append("lifts the on-chain pause; network fee from your Kipurse wallet USDC, same confirmation") }
    return out(calls, fee: leg.fee, id: id, url: u)
  }

  /// Extra checks on a trust request beyond PhoneTrust.problems: payees sane, short deadline, expiry within a year, caps within the
  /// ceiling this phone remembers from its own enrollment (not only what the server says).
  /// "No expiry" marker the server uses for remembered payees (uint64 max).
  public static let noExpiry = "18446744073709551615"
  /// Reusable inline trust (V5.2): the signed deadline equals the trust expiry.
  public static func isReusableTrust(_ m: OwnerTrustMessage) -> Bool { !m.deadline.isEmpty && m.deadline == m.expiry }
  /// Owner-facing copy for "approve & remember" (zh, en).
  public static func rememberNote(zh: Bool) -> String { zh ? "记住这个收款方不上链、不收任何费用：以后付款时把你这次的 Face ID 确认一起带上，由合约当场核对。想取消记住时需要上链一次，手续费从你的钱包 USDC 按实际花费扣。" : "Remembering this payee costs nothing and needs no extra transaction: later payments carry this Face ID signature and the contract checks it on the spot. Removing it later takes one on-chain transaction; the network fee comes from your wallet's USDC at actual cost." }
  public static func rememberedDone(zh: Bool) -> String { zh ? "✅ 已记住，没有收费。回到 AI 让它付款。" : "✅ Remembered, no fee. Go back to the AI." }
  public static func trust(_ m: OwnerTrustMessage, wallet: String, localMaxSingle: String?, localMaxDaily: String?, now: Date = Date()) -> [String] {
    var p = [String](); let t = UInt64(now.timeIntervalSince1970)
    let zero = "0x0000000000000000000000000000000000000000"
    for a in m.payees { let x = lc(a); if x == zero || x == lc(wallet) || x == lc(PhoneTrust.mainnetAdapter) || x == lc(spendPermissionManager) || x == lc(usdc) { p.append("invalid payee \(a)") } }
    if Set(m.payees.map(lc)).count != m.payees.count { p.append("duplicate payee") }
    if m.payees.count > 10 { p.append("too many payees") }
    // V5.2 "approve & remember" (owner 2026-10-26 t553/t554): a REUSABLE signature attached to later payments and verified on chain
    // in the payment itself (no trust tx, no fee). Recognized by deadline == expiry; it never expires (server sends 2^64-1), only
    // the owner's revoke ends it; it may only name payees (no merchant signers). Otherwise the classic one-shot request: deadline within 1 hour, trust within a year.
    if RequestVerify.isReusableTrust(m) {
      if let e = UInt64(m.expiry) { if e <= t { p.append("request expired") } } else { p.append("bad expiry") }
      if !m.signers.isEmpty { p.append("remembered trust can only name payees") }
    } else {
      if let d = UInt64(m.deadline) { if d <= t { p.append("request expired") } else if d > t + 3600 + UInt64(ClockSkew.upperTolerance) { p.append("deadline too far away") } } else { p.append("bad deadline") }
      if let e = UInt64(m.expiry) { if e <= t || e > t + 366 * 86400 + UInt64(ClockSkew.upperTolerance) { p.append("trust must end within a year") } } else { p.append("bad expiry") }   // t1266: skew tolerance on the upper bounds only
    }
    if let s = localMaxSingle, lt(s, m.single) { p.append("per-payment cap above this phone's limit") }
    if let d = localMaxDaily, lt(d, m.daily) { p.append("daily cap above this phone's limit") }
    return p
  }
}
