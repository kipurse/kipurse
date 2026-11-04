import Foundation

/// ON-DEVICE checks of what the server asks this user to sign, done BEFORE Face ID / the Coinbase wallet page opens.
/// The phone decodes the raw calldata itself and compares it with what the user chose; any mismatch blocks signing.
public enum RequestVerify {
  public static let spendPermissionManager = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad"
  public static let usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  static let selExecuteBatch = "34fcd5be", selRevoke = "78792f76", selApprove = "33211c30", selRegister = "8a5daae1"

  public struct Permission: Equatable { public var account, spender, token: String; public var allowance, period, start, end: UInt64?; public var policy: [String] }
  public struct Choice { public var single, daily, term: String; public var days: Int?
    public init(single: String, daily: String, term: String, days: Int?) { self.single = single; self.daily = daily; self.term = term; self.days = days } }
  public struct Result: Equatable { public var problems: [String] = []; public var notes: [String] = []; public var ok: Bool { problems.isEmpty } }

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
  /// t767u: Kipurse ops account and per-op cap for repaying fronted onboarding gas (vault fee slot). Fixed here, never from the server.
  public static let duesTo = "0xfc0e68572cdba016c1c90a45e1792f3fe0ee345b", duesMaxPerOp: UInt64 = 50_000, selSetBundlerFee = "f039b127"
  public static func limitsBatch(calls inCalls: [[String: Any]], wallet: String, chainId: Int, choice: Choice, currentExecutor: String?, adapter: String = PhoneTrust.mainnetAdapter, owner: String? = nil, vault: String? = nil, now: Date = Date()) -> Result {
    var res = Result(); func bad(_ s: String) { res.problems.append(s) }
    // t606u: an optional 2nd call = the wallet refunds the network fee (USDC only, max 0.05) to YOUR Coinbase wallet.
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
    var approved: Permission?, registered: Permission?, revokes = 0, dues = 0
    for i in 0..<n {
      guard let eo = r.int(ao + 32 + i * 32) else { bad("bad batch"); return res }; let e = ao + 32 + eo
      guard let target = r.addr(e), let val = r.dec(e + 32), let dofs = r.int(e + 64), let inner = r.bytes(e + dofs), inner.count >= 4 else { bad("bad inner call"); return res }
      if val != "0" { bad("inner call sends ETH") }
      let sel = String(Hex.encode(Array(inner.prefix(4))).dropFirst(2)); let ir = R(b: Array(inner.dropFirst(4)))
      // t767u: optional LAST inner call vault.setBundlerFee(Kipurse ops, <= 0.05 USDC): only to this wallet's vault, only once
      if sel == selSetBundlerFee {
        if i != n - 1 || dues > 0 { bad("fee-slot step in an unexpected place") }
        if vault == nil || lc(target) != lc(vault!) { bad("fee-slot step targets something other than your vault") }
        if inner.count != 68 || lc(ir.addr(0) ?? "") != duesTo { bad("fee-slot step pays someone other than Kipurse's ops account") }
        if let m = ir.dec(32), let mv = UInt64(m), mv <= duesMaxPerOp, mv > 0 {} else { bad("fee-slot cap is above 0.05 USDC") }
        dues += 1; res.notes.append("account-opening fee fronted by Kipurse: 0.05 USDC, taken once with the first AI payment"); continue
      }
      guard let po = ir.int(0), let p = permission(ir, at: po) else { bad("unknown call \(sel) to \(target)"); continue }
      if lc(p.account) != lc(wallet) { bad("permission for another wallet") }
      if lc(p.spender) != lc(adapter) { bad("permission spender is not the Kipurse adapter") }
      if lc(p.token) != lc(usdc) { bad("permission token is not USDC") }
      switch (sel, lc(target)) {
      case (selRevoke, lc(spendPermissionManager)): revokes += 1
      case (selApprove, lc(spendPermissionManager)): approved = p
      case (selRegister, lc(adapter)): registered = p
      default: bad("unexpected call \(sel) to \(target)")
      }
    }
    guard let p = approved else { bad("no new permission"); return res }
    if let g = registered, g != p { bad("registered permission differs from the approved one") }
    if revokes > 1 { bad("revokes more than one permission") }
    let pol = p.policy
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

  /// Extra checks on a trust request beyond PhoneTrust.problems: payees sane, short deadline, expiry within a year, caps within the
  /// ceiling this phone remembers from its own enrollment (not only what the server says).
  /// "No expiry" marker the server uses for remembered payees (uint64 max).
  public static let noExpiry = "18446744073709551615"
  /// Reusable inline trust (V5.2): the signed deadline equals the trust expiry.
  public static func isReusableTrust(_ m: OwnerTrustMessage) -> Bool { !m.deadline.isEmpty && m.deadline == m.expiry }
  /// Owner-facing copy for "approve & remember" (zh, en).
  public static func rememberNote(zh: Bool) -> String { zh ? "记住这个收款方不上链、不收任何费用：以后付款时把你这次的 Face ID 确认一起带上，由合约当场核对。想取消记住时需要上链一次，手续费从你的钱包 USDC 按实际花费扣。" : "Remembering this payee is free and needs no extra transaction: later payments carry this Face ID signature and the contract checks it on the spot. Removing it later takes one on-chain transaction; the network fee comes from your wallet's USDC at actual cost." }
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
      if let d = UInt64(m.deadline) { if d <= t { p.append("request expired") } else if d > t + 3600 { p.append("deadline too far away") } } else { p.append("bad deadline") }
      if let e = UInt64(m.expiry) { if e <= t || e > t + 366 * 86400 { p.append("trust must end within a year") } } else { p.append("bad expiry") }
    }
    if let s = localMaxSingle, lt(s, m.single) { p.append("per-payment cap above this phone's limit") }
    if let d = localMaxDaily, lt(d, m.daily) { p.append("daily cap above this phone's limit") }
    return p
  }
}
