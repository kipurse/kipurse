import Foundation

/// t1153 (owner t1153s5250, decision 74): calm guidance when the Face ID approval key cannot be used.
/// LAError -6 (biometryNotAvailable) = Face ID is turned off for Kipurse in iOS Settings (or never allowed).
/// An invalidated .biometryCurrentSet key (Face ID was reset / re-enrolled) = turn Face ID approvals on again.
/// Compared by raw value so KipurseCore does not import LocalAuthentication.
public enum FaceIDNotice: Equatable {
  case faceIDOff, keyInvalid, lockout

  public static let offZH = "Kipurse 的 Face ID 已关闭。请到 设置 › Kipurse › 打开面容 ID，再点重试。这次没有批准，也没有扣钱。"
  public static let offEN = "Face ID is turned off for Kipurse. Go to Settings › Kipurse, turn on Face ID, then tap Retry. Nothing was approved or charged."
  public static let keyZH = "这台 iPhone 的 Face ID 有变化，批准钥匙已失效。请到 设置 › Face ID 批准 重新开启。这次没有批准，也没有扣钱。"
  public static let keyEN = "Face ID changed on this iPhone, so the approval key no longer works. Go to Settings › Face ID approvals and turn it on again. Nothing was approved or charged."

  /// t1255 (decision 124): iOS locked Face ID after too many failed matches. The passcode only unlocks Face ID; it never approves.
  public static let lockZH = "Face ID 失败次数太多，iPhone 暂时锁住了 Face ID。点「重试」，输入锁屏密码解锁 Face ID（密码只用来解锁 Face ID，不会批准任何东西），然后再用 Face ID 批准。这次没有批准，也没有扣钱。"
  public static let lockEN = "Too many failed Face ID tries, so iPhone locked Face ID for now. Tap Retry and enter your passcode to unlock Face ID (the passcode only unlocks Face ID and approves nothing), then approve with Face ID. Nothing was approved or charged."
  /// The reason shown on the system passcode sheet.
  public static let unlockReasonZH = "Face ID 被锁住了。输入锁屏密码只用来解锁 Face ID，不会批准任何东西。"
  public static let unlockReasonEN = "Face ID is locked. Your passcode only unlocks Face ID; it approves nothing."
  /// LAError.biometryLockout
  public static let biometryLockout = -8

  static let laDomain = "com.apple.LocalAuthentication"
  /// LAError.biometryNotAvailable
  public static let biometryNotAvailable = -6
  /// Secure Enclave key that can no longer be used (biometry set changed): CryptoTokenKit errors, or the key item is gone.
  static let tokenDomains: Set<String> = ["CryptoTokenKit", "com.apple.CryptoTokenKit"]
  static let itemNotFound = -25300

  public static func from(_ error: Error) -> FaceIDNotice? { from(domain: (error as NSError).domain, code: (error as NSError).code) }
  public static func from(domain: String, code: Int) -> FaceIDNotice? {
    if domain == laDomain && code == biometryNotAvailable { return .faceIDOff }
    if domain == laDomain && code == biometryLockout { return .lockout }
    if tokenDomains.contains(domain) { return .keyInvalid }
    if domain == "NSOSStatusErrorDomain" && code == itemNotFound { return .keyInvalid }
    return nil
  }
  public var text: String { switch self { case .faceIDOff: return T(Self.offZH, Self.offEN); case .keyInvalid: return T(Self.keyZH, Self.keyEN); case .lockout: return T(Self.lockZH, Self.lockEN) } }
  public static var unlockReason: String { T(unlockReasonZH, unlockReasonEN) }
  /// The notice for a signing error, given whether iOS reports Face ID locked RIGHT NOW. A locked Face ID can surface as a
  /// CryptoTokenKit error; it must never be shown as "approval key invalid" (that would send the owner to re-enable approvals).
  public static func from(_ error: Error, lockedNow: Bool) -> FaceIDNotice? { lockedNow ? .lockout : from(error) }
}
