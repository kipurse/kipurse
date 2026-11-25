import Foundation

/// t1091: the red line on Face ID enrollment. Only a real network failure uses the network sentence.
/// Everything else is a short reason. The disclosure under it still shows the raw description.
public enum PhoneEnrollCopy {
  public static let networkZH = "没能开启，请检查网络后再试一次。"
  public static let networkEN = "Couldn't turn it on. Check your connection and try again."
  public static let faceIDZH = "你取消了 Face ID，没有开启"
  public static let secureKeyZH = "这台手机没能生成安全钥匙，请稍后再试"
  public static let attestZH = "安全检查没通过，没有开启"
  public static let usdcZH = "启付钱包 USDC 不够付开启手续费"
  /// t1128 (owner "[zh]", decision 66): the first Face ID key rides in the opening fee. After opening (reinstall, new phone, or a wallet
  /// opened before the first key was bundled) turning it on takes ONE actual network fee from the Kipurse wallet: live quote, at most 0.05 USDC.
  public static let afterOpeningFeeZH = "新开户时，首次开启 Face ID 已含在开户费里。开户后再开启（重装、换手机或开户时没带）要从启付钱包付一笔实际网络费，确认前显示实时报价，最多 0.05 USDC；只改上限不会扣这笔钱。"
  public static let afterOpeningFeeEN = "For a new account, the first Face ID setup is included in the opening fee. Turning it on after opening (reinstall, new phone, or not set up at opening) takes one actual network fee from your Kipurse wallet, shown as a live quote before you confirm, at most 0.05 USDC; changing limits alone never charges it."
  public static let walletUnavailableZH = "现在暂时不能从启付钱包付这笔网络费，没有开启。这次没有扣钱，请稍后再试。"
  public static let overCapZH = "现在网络费超过 0.05 USDC 上限，没有开启。这次没有扣钱，请稍后再试。"
  public static let walletShortZH = "启付钱包 USDC 不够付开启 Face ID 的网络费，没有开启。这次没有扣钱。"
  public static let openingOnlyRefusedZH = "服务器暂时没有开启这一步。这次没有扣钱。"
  public static let badKeyZH = "手机钥匙不对，没有开启"
  public static let noPriceZH = "暂时算不出手续费，请稍后再试"
  public static let loginZH = "登录已过期，请重新连接"
  public static let serverZH = "启付服务器暂时出错，请稍后再试"
  public static let fallbackZH = "没能开启，请稍后再试"

  /// URL errors that mean the device has no usable connection. Cancelled is not one of these.
  public static let networkCodes: Set<Int> = [
    NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut,
    NSURLErrorCannotConnectToHost, NSURLErrorDNSLookupFailed, NSURLErrorCannotFindHost,
    NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed, NSURLErrorSecureConnectionFailed,
    NSURLErrorCannotLoadFromNetwork, NSURLErrorCallIsActive
  ]
  /// LAError cancel / biometric failure. Compared by raw value so this file does not import LocalAuthentication.
  /// t1153: -6 (biometryNotAvailable = Face ID off for Kipurse) is NOT a cancel; it gets FaceIDNotice guidance instead.
  private static let faceIDCodes: Set<Int> = [-1, -2, -3, -4, -7, -9]   // t1255: -8 (lockout) has its own guidance
  private static let laDomain = "com.apple.LocalAuthentication"
  private static let attestDomain = "com.apple.devicecheck.error"

  public static func line(_ error: Error) -> String {
    let n = error as NSError
    if n.domain == NSURLErrorDomain, networkCodes.contains(n.code) { return T(networkZH, networkEN) }
    if n.domain == laDomain, n.code == FaceIDNotice.biometryNotAvailable { return FaceIDNotice.faceIDOff.text }
    if n.domain == laDomain, n.code == FaceIDNotice.biometryLockout { return FaceIDNotice.lockout.text }
    if n.domain == laDomain, faceIDCodes.contains(n.code) { return T(faceIDZH, "Face ID was cancelled, so this stayed off.") }
    if n.domain == "NSOSStatusErrorDomain" || n.domain == "com.apple.security" {
      if n.code == -128 || n.code == -25293 { return T(faceIDZH, "Face ID was cancelled, so this stayed off.") }
      return T(secureKeyZH, "This iPhone couldn't create a secure key. Try again later.")
    }
    let code = (n.userInfo[ServerText.errorCodeKey] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
    if n.domain == attestDomain || code == "app_attest_required" || code == "app_attest" {
      return T(attestZH, "The security check failed, so this stayed off.")
    }
    if n.domain == "kipurse" || !code.isEmpty {
      if n.code == 401 || code == "unauthorized" || code == "invalid_token" { return T(loginZH, "Your sign-in expired. Connect again.") }
      switch code {
      case "needs_usdc": return T(usdcZH, "The Kipurse wallet doesn't have enough USDC for the fee to turn on Face ID approvals.")
      case "opening_only": return T(openingOnlyRefusedZH, "The server isn't turning this on right now. Nothing was charged.")
      case "wallet_needs_usdc": return T(walletShortZH, "The Kipurse wallet doesn't have enough USDC for the network fee to turn on Face ID, so it stayed off. Nothing was charged.")
      case "wallet_fee_unavailable": return T(walletUnavailableZH, "Paying this network fee from the Kipurse wallet isn't available right now, so it stayed off. Nothing was charged; try again later.")
      case "fee_over_cap": return T(overCapZH, "The network fee is over the 0.05 USDC cap right now, so it stayed off. Nothing was charged; try again later.")
      case "bad_key": return T(badKeyZH, "This phone key isn't valid, so this stayed off.")
      case "no_price": return T(noPriceZH, "The fee can't be priced right now. Try again later.")
      default: break
      }
      if n.code >= 500 { return T(serverZH, "The Kipurse server had a problem. Try again later.") }
      let raw = n.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
      if !raw.isEmpty { return raw }
    }
    if n.domain == NSURLErrorDomain, n.code == NSURLErrorCancelled { return T("你取消了，没有开启", "You cancelled, so this stayed off.") }
    let raw = n.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    return raw.isEmpty ? T(fallbackZH, "This didn't turn on. Try again later.") : raw
  }
}
