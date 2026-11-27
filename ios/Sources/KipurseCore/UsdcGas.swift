import Foundation
/// t1022: the sponsor paymaster only covers this exact batch, which pays the full opening fee in USDC from the user's Base Account in the SAME confirmation (Kipurse pays nothing)
/// (transfer to the Kipurse fee address = company Safe, t1346) and may also deposit into the Kipurse wallet. Never ETH. No dues. CDP erc20_usdc stays off
/// (Coinbase console has no ERC-20 USDC gas option). Mirrors server src/v5/usdc-gas.mjs.
public enum UsdcGas {
  public static let usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
  public static let paymaster = "0x2faeb0760d4230ef2ac21496bb4f0b47d634fd4c" // CDP ERC-20 (unused while switch off)
  public static let feeTo = FeeAddress.company // t1346: company Safe (was 0xf14E…0Dd9) — same-tx repay
  public static let approveCap: UInt64 = 250_000
  /// Hard cap on same-tx repay (0.25 USDC). Actual fee comes from the server quote (t1026).
  public static let openingFeeCap: UInt64 = 250_000
  @available(*, deprecated, message: "t1026: use quote.feeUSDC; this is the hard cap")
  public static let openingFee: UInt64 = openingFeeCap
  static let selApprove = "0x095ea7b3", selTransfer = "0xa9059cbb"
  public struct Split { public var leading: [[String: Any]] = []; public var rest: [[String: Any]] = []; public var problems: [String] = []; public var deposit: UInt64 = 0; public var approved: UInt64 = 0; public var feeRepaid: UInt64 = 0; public var vaultSeed: UInt64 = 0 }
  /// t1185 (decision 86): opening also moves 0.10..0.20 USDC (server: 0.15) of the owner's own money from his Base Account into his wallet's
  /// fee reserve (the payer vault) so the first AI payment works. Only to the vault THIS phone computes for this wallet, only as the LAST step, once.
  public static let vaultSeedMin: UInt64 = 100_000, vaultSeedMax: UInt64 = 200_000
  /// Payer vault of a wallet, computed on the phone for each known Kipurse suite (V5.2 live, V5.3): CREATE2(factory, salt = wallet, EIP-1167 clone of impl).
  public static let vaultSuites: [(factory: String, impl: String)] = [("0x6ce7bc537379a6e10b88d1e98a5c3803a9812be9", "0xc53ab278fe26b31f85b5ccc73eb5a7dd81e05038"),
                                                                     (OpsCap.v53Factory, OpsCap.v53VaultImpl)]
  public static func vaults(wallet: String) -> [String] {
    vaultSuites.compactMap { s in guard let f = Hex.decode(s.factory), f.count == 20, let w = Hex.decode(wallet), w.count == 20, let h = OpsCap.cloneInitHash(impl: s.impl) else { return nil }
      return Hex.encode(Array(Keccak.hash([0xff] + f + ([UInt8](repeating: 0, count: 12) + w) + h).suffix(20))).lowercased() } }
  public static func seedNote(_ atomic: UInt64) -> (zh: String, en: String) { let a = AnswerRules.format(Int64(atomic))
    return ("另放 \(a) USDC 到你钱包的手续费备用金，用来付 AI 付款的手续费。钱还是你的，取回时一起退给你。",
            "Plus \(a) USDC into your wallet's fee reserve to cover network fees for AI payments. It is still your money and comes back when you withdraw.") }
  static func args(_ hex: String) -> (sel: String, addr: String, amount: UInt64?)? {
    let h = hex.lowercased().hasPrefix("0x") ? String(hex.lowercased().dropFirst(2)) : hex.lowercased()
    guard h.count == 8 + 128 else { return nil }
    let sel = "0x" + h.prefix(8); let a = h.dropFirst(8).prefix(64), v = h.dropFirst(72).prefix(64)
    guard a.prefix(24).allSatisfy({ $0 == "0" }) else { return nil }
    let amt: UInt64? = v.prefix(48).allSatisfy({ $0 == "0" }) ? UInt64(v.suffix(16), radix: 16) : nil
    return (sel, "0x" + a.suffix(40), amt)
  }
  /// Splits off leading USDC calls. Allowed: transfer(feeTo, <=0.25), transfer(wallet, >0), approve(CDP, <=0.25).
  public static func split(_ calls: [[String: Any]], wallet: String, vault: String? = nil) -> Split {
    var s = Split(); var leading = true
    for (ci, c) in calls.enumerated() {
      let to = (c["to"] as? String ?? "").lowercased()
      // t1185 (decision 86): trailing fee-reserve seed (the vault must be one this phone computed for this wallet, and = the server's vault)
      if !leading && to == usdc && ci == calls.count - 1 && s.vaultSeed == 0, let v = vault?.lowercased(), vaults(wallet: wallet).contains(v) || v == KipurseSuite.v55.vault(wallet: wallet),   // t1250: + the V5.5 vault
         let d = c["data"] as? String, let p = args(d), p.sel == selTransfer, p.addr == v, let amt = p.amount, amt >= vaultSeedMin, amt <= vaultSeedMax,
         ["0x0", "0x", "0", ""].contains((c["value"] as? String ?? "0x0").lowercased()) { s.vaultSeed = amt; continue }
      if leading && to == usdc {
        let value = (c["value"] as? String ?? "0x0").lowercased()
        if !(value == "0x0" || value == "0x" || value == "0" || value.isEmpty) { s.problems.append("a USDC step sends ETH") }
        guard let d = c["data"] as? String, let p = args(d), let amt = p.amount, amt > 0 else { s.problems.append("unexpected USDC step"); continue }
        if p.sel == selApprove && p.addr == paymaster && amt <= approveCap { s.approved = amt }
        else if p.sel == selTransfer && p.addr == feeTo && amt <= approveCap { s.feeRepaid = amt }
        else if p.sel == selTransfer && p.addr == wallet.lowercased() { s.deposit += amt }
        else { s.problems.append(p.sel == selApprove ? "USDC approval is not for the Coinbase fee paymaster or is above 0.25 USDC" : "USDC goes somewhere other than the opening fee or your Kipurse wallet") }
        s.leading.append(c)
      } else {
        leading = false
        if to == usdc { s.problems.append("unexpected USDC step") }
        s.rest.append(c)
      }
    }
    return s
  }
  /// Fallback when quote not loaded yet (t1026: show quoted amount when available).
  /// t1114 (decision 60): the server charges the opening fee as its own USDC transfer from the user's Base account, on top of the
  /// deposit; it is not taken out of the deposit amount.
  public static let feeNoteZh = "开通手续费按实际网络费，在充值之外另从你的 Coinbase 钱包（Base 账户）扣，不从这次充值里扣；Kipurse 不出这笔钱。"
  public static let feeNoteEn = "Opening fee is the actual network cost, charged separately from your Coinbase wallet (Base account) on top of your deposit, not taken out of this deposit. Kipurse does not pay it."
  public static func feeNote(quotedUSDC: String?, seed: UInt64?) -> (zh: String, en: String) {
    let n = feeNote(quotedUSDC: quotedUSDC); guard let s = seed, s > 0 else { return n }; let x = seedNote(s); return (n.zh + x.zh, n.en + " " + x.en) }
  public static func feeNote(quotedUSDC: String?) -> (zh: String, en: String) {
    guard let a = quotedUSDC, !a.isEmpty, a != "0" else { return (feeNoteZh, feeNoteEn) }
    return ("开通手续费约 \(a) USDC（按实际网络费），在充值之外另从你的 Coinbase 钱包（Base 账户）扣，不从这次充值里扣；Kipurse 不出这笔钱。",
            "Opening fee about \(a) USDC (actual network cost), charged separately from your Coinbase wallet (Base account) on top of your deposit, not taken out of this deposit. Kipurse does not pay it.")
  }

  // t1097 / t147: wallet-safety-cap change fee comes from the Kipurse wallet's own USDC through Kipurse's existing sponsor route
  // (RequestVerify.limitsReply). The old third-party ERC-20 paymaster path (Pimlico) is removed; this build never approves it.
  public static let baseUSDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  /// 0.01 USDC, in atomic units. A quoted fee at or above this is not offered for signing.
  public static let defaultFeeCapAtomic: UInt64 = 10_000
  public static let feeFrom = "kipurse_wallet"
  public static let insufficientCode = "kipurse_balance_insufficient_for_fee"
  public static let insufficientZH = "启付余额不足以支付网络费"


  /// #vh sender. The new path commits the Kipurse smart wallet; the old path commits the Base Account.
  public static func limitsSender(owner: String, wallet: String, fromWallet: Bool) -> String { fromWallet ? wallet : owner }

  public static func feeDialog(usdc: String) -> String {
    "修改钱包安全上限需要一点网络费（约 \(usdc) USDC），从启付余额里扣"
  }

  /// nil when the quote may be shown. Otherwise the error code that blocks the confirm page.
  public static func limitsFeeBlock(fee: UInt64, wallet: UInt64?, cap: UInt64 = defaultFeeCapAtomic) -> String? {
    if fee >= cap { return "fee_above_cap" }
    if wallet == nil || wallet! < fee { return insufficientCode }
    return nil
  }
}
