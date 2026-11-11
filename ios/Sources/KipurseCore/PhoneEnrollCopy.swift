import Foundation

/// t1091: the red line on Face ID enrollment. Only a real network failure uses the network sentence.
/// Everything else is a short reason. The disclosure under it still shows the raw description.
public enum PhoneEnrollCopy {
  public static let networkZH = "没能开启，请检查网络后再试一次。"
  public static let networkEN = "Couldn't turn it on. Check your connection and try again."
  public static let faceIDZH = "你取消了 Face ID，没有开启"
  public static let secureKeyZH = "这台手机没能生成安全钥匙，请稍后再试"
  public static let attestZH = "安全检查没通过，没有开启"
  public static let usdcZH = "启付钱包 USDC 不够付开通费"
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
  private static let faceIDCodes: Set<Int> = [-1, -2, -3, -4, -6, -7, -8, -9]
  private static let laDomain = "com.apple.LocalAuthentication"
  private static let attestDomain = "com.apple.devicecheck.error"

  public static func line(_ error: Error) -> String {
    let n = error as NSError
    if n.domain == NSURLErrorDomain, networkCodes.contains(n.code) { return T(networkZH, networkEN) }
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
      case "needs_usdc": return T(usdcZH, "The Kipurse wallet doesn't have enough USDC for the setup fee.")
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
