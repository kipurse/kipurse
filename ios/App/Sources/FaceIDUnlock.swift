import LocalAuthentication
import KipurseCore

/// t1255 (handbook §6#124): iOS locks Face ID after too many failed matches (LAError.biometryLockout). The only way back is the
/// device passcode. Before any Face ID approval / sign-in, this asks for the passcode on the system sheet ONLY to unlock Face ID.
/// It approves nothing: every Kipurse Secure Enclave key still needs Face ID afterwards (approvals never accept the passcode).
enum FaceIDUnlock {
  /// true = iOS reports Face ID locked right now.
  static var locked: Bool {
    let c = LAContext(); var e: NSError?
    if c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e) { return false }
    return e?.domain == LAErrorDomain && e?.code == LAError.biometryLockout.rawValue
  }
  /// If Face ID is locked, show the passcode sheet once (explained). Returns false only when it stayed locked (cancelled).
  @discardableResult @MainActor static func ensure() async -> Bool {
    #if DEBUG
    if CommandLine.arguments.contains("-kpSkipFaceID") { return true }
    #endif
    guard locked else { return true }
    let p = LAContext(); p.localizedCancelTitle = T("取消", "Cancel")
    defer { p.invalidate() }
    PromptLog.add("faceid-unlock")
    _ = try? await p.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: FaceIDNotice.unlockReason)
    return !locked
  }
  /// The notice for an error from a Face ID step (lockout first, so it is never shown as "approval key invalid").
  static func notice(_ error: Error) -> FaceIDNotice? { FaceIDNotice.from(error, lockedNow: locked) }
}
