import Foundation

/// t1097: a wallet-safety-cap change can be paid from the Kipurse smart wallet's own USDC.
/// The paymaster is Pimlico's ERC-20 paymaster on EntryPoint v0.6. The token is Base USDC.
public enum UsdcGas {
  public static let baseUSDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  public static let erc20Paymaster = "0x6666666666667849c56f2850848ce1c4da65c68b"
  /// Coinbase CDP ERC-20 paymaster. The old limits path may approve only this spender, at most 0.25 USDC.
  public static let paymaster = "0x2FAEB0760D4230Ef2aC21496Bb4F0b47D634FD4c"
  public static let cdpApproveCap: UInt64 = 250_000
  public static let entryPointV06 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"
  public static let paymasterMethods: Set<String> = ["pm_getPaymasterStubData", "pm_getPaymasterData", "pimlico_getTokenQuotes"]
  /// 0.01 USDC, in atomic units. A quoted fee at or above this is not offered for signing.
  public static let defaultFeeCapAtomic: UInt64 = 10_000
  /// USDC.approve to the Pimlico paymaster may not exceed 0.05 USDC.
  public static let approveCapAtomic: UInt64 = 50_000
  public static let feeFrom = "kipurse_wallet"
  public static let insufficientCode = "kipurse_balance_insufficient_for_fee"
  public static let insufficientZH = "启付余额不足以支付网络费"

  public static func paymasterMethodAllowed(_ method: String) -> Bool { paymasterMethods.contains(method) }
  /// The only spender a wallet-pays cap change may approve.
  public static func approveTargetAllowed(_ address: String) -> Bool { address.lowercased() == erc20Paymaster.lowercased() }

  public struct Split { public var problems: [String] = []; public var rest: [[String: Any]] = []; public var deposit: UInt64 = 0 }
  /// Old limits batches: a USDC.approve is allowed only to the Coinbase fee paymaster and only up to 0.25 USDC, and is removed before the cap change is checked. A USDC transfer into this wallet is a deposit, not part of the cap change.
  public static func split(_ calls: [[String: Any]], wallet: String) -> Split {
    var s = Split()
    for c in calls {
      let to = (c["to"] as? String)?.lowercased() ?? ""
      let data = (c["data"] as? String)?.lowercased() ?? ""
      if to == baseUSDC.lowercased(), data.hasPrefix("0x095ea7b3") {
        if let spender = wordAddress(data, 0), spender == paymaster.lowercased(), let n = wordUInt64(data, 1), n > 0, n <= cdpApproveCap { continue }
        s.problems.append("USDC approval is not for the Coinbase fee paymaster or is above 0.25 USDC"); continue
      }
      if to == baseUSDC.lowercased(), data.hasPrefix("0xa9059cbb"), let rcpt = wordAddress(data, 0), rcpt == wallet.lowercased(), let n = wordUInt64(data, 1), n > 0 {
        s.deposit += n; continue
      }
      s.rest.append(c)
    }
    return s
  }
  static func word(_ data: String, _ i: Int) -> String? {
    let hex = data.hasPrefix("0x") ? String(data.dropFirst(2)) : data
    let start = 8 + i * 64
    guard hex.count >= start + 64 else { return nil }
    return String(hex.dropFirst(start).prefix(64))
  }
  static func wordAddress(_ data: String, _ i: Int) -> String? {
    guard let w = word(data, i), w.prefix(24).allSatisfy({ $0 == "0" }) else { return nil }
    return "0x" + w.suffix(40)
  }
  static func wordUInt64(_ data: String, _ i: Int) -> UInt64? {
    guard let w = word(data, i), w.prefix(48).allSatisfy({ $0 == "0" }) else { return nil }
    return UInt64(w.suffix(16), radix: 16)
  }

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
