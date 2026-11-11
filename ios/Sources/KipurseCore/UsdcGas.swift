import Foundation

/// t1097: a wallet-safety-cap change can be paid from the Kipurse smart wallet's own USDC.
/// The paymaster is Pimlico's ERC-20 paymaster on EntryPoint v0.6. The token is Base USDC.
public enum UsdcGas {
  public static let baseUSDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  public static let erc20Paymaster = "0x6666666666667849c56f2850848ce1c4da65c68b"
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
