import Foundation

/// t821: "even if Kipurse stops": everything here is built and checked ON THE PHONE from public chain data.
/// The only signer is the user's own Coinbase wallet (Coinbase passkey); money can only go to that same account.
public enum ChainRescue {
  public static let spm = "0xf85210b21cc50302f477ba56686d2019dc9b67ad"   // Coinbase SpendPermissionManager (AI allowances)
  public static let sel = (executeBatch: "34fcd5be", transfer: "a9059cbb", sweep: "35faa416", reconcileFloat: "2847ba43", vaultAddress: "1cb3d314",
                           floatAddress: "632889d6", reserved: "fe60d12c", ownerAtIndex: "8ea69029", nextOwnerIndex: "d948fd2e", removeOwnerAtIndex: "89625b57",
                           setPaused: "16c38b3c", isPaused: "5b14f183")

  public struct Balances: Equatable {
    public var wallet: Int64, vault: Int64, vaultReserved: Int64, float: Int64
    public var vaultAddress: String?, floatAddress: String?
    public init(wallet: Int64, vault: Int64, vaultReserved: Int64 = 0, float: Int64 = 0, vaultAddress: String? = nil, floatAddress: String? = nil) {
      self.wallet = wallet; self.vault = vault; self.vaultReserved = vaultReserved; self.float = float; self.vaultAddress = vaultAddress; self.floatAddress = floatAddress }
    /// Everything the user owns (what the balance shows).
    public var total: Int64 { wallet + vault + float }
    /// What one rescue transaction can take right now (vault amounts reserved for in-flight payments stay until they settle).
    public var takeNow: Int64 { wallet + max(vault - vaultReserved, 0) + float }
    public var pending: Int64 { total - takeNow }
  }
  public struct Call: Equatable { public let to: String; public let data: String; public let label: String }
  public struct Plan: Equatable {
    public let wallet: String, to: String, amount: Int64, steps: [Call]
    /// The ONE call the Coinbase wallet signs: wallet.executeBatch(steps).
    public var call: Call { Call(to: wallet, data: ChainRescue.executeBatch(steps), label: "executeBatch") }
  }
  public enum Refusal: Error, Equatable { case badAddress, notYourAccount, nothingToTake }

  // MARK: ABI
  static func clean(_ a: String) -> String? { let h = a.lowercased().replacingOccurrences(of: "0x", with: ""); return h.count == 40 && h.allSatisfy(\.isHexDigit) ? h : nil }
  static func word(_ h: String) -> String { String(repeating: "0", count: max(64 - h.count, 0)) + h }
  static func uint(_ v: Int64) -> String { word(String(v, radix: 16)) }
  public static func addrArg(_ s: String, _ a: String) -> String? { clean(a).map { "0x" + s + word($0) } }
  public static func transfer(_ to: String, _ amount: Int64) -> String? { clean(to).map { "0x" + sel.transfer + word($0) + uint(amount) } }
  /// executeBatch((address target,uint256 value,bytes data)[])
  public static func executeBatch(_ calls: [Call]) -> String {
    var heads = [String](), tails = [String](); var off = calls.count * 32
    for c in calls {
      let d = c.data.lowercased().replacingOccurrences(of: "0x", with: ""); let n = d.count / 2
      let pad = d + String(repeating: "0", count: (64 - d.count % 64) % 64)
      let t = word(clean(c.to) ?? "") + uint(0) + uint(96) + uint(Int64(n)) + pad
      heads.append(uint(Int64(off))); tails.append(t); off += t.count / 2
    }
    return "0x" + sel.executeBatch + uint(32) + uint(Int64(calls.count)) + heads.joined() + tails.joined()
  }

  /// The rescue: (collect prepaid float) -> (collect vault) -> ALL to the user's own Coinbase wallet. The destination is not a parameter
  /// a person can type: it is the owner account, and it must be the one the phone recorded at setup when it has one.
  public static func plan(wallet: String, owner: String, recordedOwner: String?, adapter: String = PhoneTrust.mainnetAdapter, usdc: String = VaultCheck.usdc, b: Balances) throws -> Plan {
    guard let w = clean(wallet), let o = clean(owner) else { throw Refusal.badAddress }
    if let r = recordedOwner { guard clean(r) == o else { throw Refusal.notYourAccount } }
    guard o != w, o != clean(usdc) else { throw Refusal.badAddress }
    var s = [Call]()
    if b.float > 0, let d = addrArg(sel.reconcileFloat, wallet) { s.append(Call(to: adapter, data: d, label: "float")) }
    if b.vault - b.vaultReserved > 0, let v = b.vaultAddress { s.append(Call(to: v, data: "0x" + sel.sweep, label: "vault")) }
    guard b.takeNow > 0, let t = transfer(owner, b.takeNow) else { throw Refusal.nothingToTake }
    s.append(Call(to: usdc, data: t, label: "transfer"))
    return Plan(wallet: "0x" + w, to: "0x" + o, amount: b.takeNow, steps: s)
  }
  /// Stop ALL AI payments without Kipurse (t1238, decision 108). Coinbase's popup now refuses any owner change ("Account owner or
  /// upgrade calls are not allowed."), so this no longer removes the SpendPermissionManager. Instead the wallet switches on its own
  /// permanent pause on every Kipurse trust contract (V5.2 / V5.3 / V5.4): every AI payment and the small prepaid balance check this
  /// pause first and refuse (WalletPaused). One call the Coinbase wallet signs: wallet.executeBatch([trust.setPaused(true) ...]).
  /// It can be undone later with the normal "resume AI payments". No key is added or removed.
  /// t1250 (decision 119): a V5.5 wallet also pauses on the V5.5 trust (every other wallet: exactly the three trusts as before).
  public static let pauseTrusts = [KipurseSuite.v52.trust, KipurseSuite.v53.trust, KipurseSuite.v54.trust].map { $0.lowercased() }
  public static func pauseTrusts(wallet: String) -> [String] {
    let v55 = KipurseSuite.stored(wallet: wallet) == .v55 || (KipurseSuite.active == .v55 && Operator.wallet.lowercased() == wallet.lowercased())
    return pauseTrusts + (v55 ? [KipurseSuite.v55.trust.lowercased()] : []) }
  public static func stopAI(wallet: String) -> Call? {
    guard let w = clean(wallet) else { return nil }
    let steps = pauseTrusts(wallet: wallet).map { Call(to: $0, data: "0x" + sel.setPaused + uint(1), label: "pause") }
    return Call(to: "0x" + w, data: executeBatch(steps), label: "stopAI")
  }
  /// true = every Kipurse trust already reports this wallet paused (nothing left to stop); nil = could not read.
  public static func allPaused(wallet: String) async -> Bool? {
    guard let w = clean(wallet) else { return nil }
    for t in pauseTrusts(wallet: wallet) { guard let r = await ChainRPC.ethCall(t, "0x" + sel.isPaused + word(w)).flatMap(VaultCheck.decodeUInt) else { return nil }; if r == 0 { return false } }
    return true
  }

  /// Plain words shown BEFORE anything opens for signing.
  public static func preview(_ p: Plan) -> [String] {
    var out = [String]()
    for c in p.steps {
      switch c.label {
      case "float": out.append(T("收回 AI 小额预付", "Collect the small AI prepaid balance"))
      case "vault": out.append(T("收回结算金库里的钱", "Collect the money in your settlement vault"))
      default: out.append(T("把 \(AnswerRules.format(p.amount)) USDC 全部转到你自己的 Coinbase 钱包 \(shortAddr(p.to))", "Send all \(AnswerRules.format(p.amount)) USDC to your own Coinbase wallet \(shortAddr(p.to))"))
      }
    }
    out.append(T("网络手续费：不到 0.01 美元，用 USDC 付。从你的 Coinbase 钱包扣，不从启付余额扣。", "Network fee: under $0.01, paid in USDC. It comes from your Coinbase wallet, not from your Kipurse balance."))
    out.append(T("只能转给你自己，不能改成别的地址。启付不收服务费。", "It can only go to you; no other address is possible. Kipurse charges no service fee."))
    return out
  }
  /// Insufficient USDC always stops before the independent signing page opens.
  public static func gasMissingText(_ e: GasCheck.Estimate) -> String {
    T("你的 Coinbase 钱包里 USDC 不够付这点手续费，还差约 \(GasCheck.dollars(e.missingUSDC))。启付余额不能替它付。先打开 Coinbase，往这个钱包转入一点 USDC（大约 1 美元就够，网络选 Base），再回来确认。已停止，没有扣钱。",
      "Your Coinbase wallet needs about \(GasCheck.dollars(e.missingUSDC)) more for the small fee. Your Kipurse balance cannot pay it. Open Coinbase and transfer a little USDC to this wallet (about $1 is enough; choose the Base network), then come back to confirm. Stopped; nothing was charged.")
  }
  static func shortAddr(_ a: String) -> String { a.count > 12 ? String(a.prefix(6)) + "…" + String(a.suffix(4)) : a }

  // MARK: reads (public nodes, two must agree for the balance)
  public static func addr(_ word: String?) -> String? { VaultCheck.decode(word ?? "") }
  public static func balances(wallet: String, adapter: String = PhoneTrust.mainnetAdapter) async -> Balances? {
    guard let bw = addrArg(VaultCheck.selBalanceOf, wallet), let wv = await ChainRPC.ethCall(VaultCheck.usdc, bw, agreed: true), let w = VaultCheck.decodeUInt(wv) else { return nil }
    var b = Balances(wallet: w, vault: 0)
    if let q = addrArg(sel.vaultAddress, wallet), let v = addr(await ChainRPC.ethCall(adapter, q)), let qb = addrArg(VaultCheck.selBalanceOf, v) {
      guard let vb = await ChainRPC.ethCall(VaultCheck.usdc, qb, agreed: true).flatMap(VaultCheck.decodeUInt) else { return nil }
      b.vault = vb; b.vaultAddress = v
      b.vaultReserved = await ChainRPC.ethCall(v, "0x" + sel.reserved).flatMap(VaultCheck.decodeUInt) ?? 0
    }
    if let q = addrArg(sel.floatAddress, wallet), let f = addr(await ChainRPC.ethCall(adapter, q)), let code = try? await ChainRPC.call("eth_getCode", [f, "latest"]), code.count > 2,
       let qb = addrArg(VaultCheck.selBalanceOf, f), let fb = await ChainRPC.ethCall(VaultCheck.usdc, qb, agreed: true).flatMap(VaultCheck.decodeUInt) { b.float = fb; b.floatAddress = f }
    return b
  }
  /// Where the SpendPermissionManager sits in the wallet's owner list (nil = already removed / not found).
  public static func spmIndex(wallet: String) async -> Int? {
    guard let n = await ChainRPC.ethCall(wallet, "0x" + sel.nextOwnerIndex).flatMap(VaultCheck.decodeUInt), n < 64 else { return nil }
    for i in 0..<Int(n) {
      guard let r = await ChainRPC.ethCall(wallet, "0x" + sel.ownerAtIndex + uint(Int64(i))) else { continue }
      if r.lowercased().contains(word(String(spm.dropFirst(2)))) { return i }
    }
    return nil
  }
}
