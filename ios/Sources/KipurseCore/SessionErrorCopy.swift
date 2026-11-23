import Foundation

/// t1156u (owner t1156s5267, handbook §6#75): what a save that needs the phone session says when it does not go through.
/// 「暂时连不上，请稍后再试。」 is only for real network / server errors. Face ID problems get calm guidance; nothing was sent.
public enum SessionErrorCopy {
  public enum Kind: Equatable { case faceID(FaceIDNotice), noApprovalKey, cancelled, network }

  public static let noKeyZH = "这台 iPhone 还没开启 Face ID 批准。请到 设置 › Face ID 批准 开启。这次没有保存，也没有扣钱。"
  public static let noKeyEN = "Face ID approvals aren't on for this iPhone. Go to Settings › Face ID approvals and turn them on. Nothing was saved or charged."
  public static let cancelZH = "Face ID 没有确认，这次没有保存，也没有扣钱。"
  public static let cancelEN = "Face ID wasn't confirmed. Nothing was saved or charged."
  public static let networkZH = "暂时连不上，请稍后再试。"
  public static let networkEN = "Can't connect right now. Try again later."

  static let laDomain = "com.apple.LocalAuthentication"
  /// LAError authenticationFailed / userCancel / systemCancel / userFallback / appCancel / notInteractive, and errSecUserCanceled.
  static let laCancel: Set<Int> = [-1, -2, -3, -4, -9, -1004]

  public static func kind(_ error: Error) -> Kind {
    let n = error as NSError
    if let f = FaceIDNotice.from(error) { return .faceID(f) }
    if n.domain == laDomain, laCancel.contains(n.code) { return .cancelled }
    if n.domain == "NSOSStatusErrorDomain", n.code == -128 { return .cancelled }
    return .network
  }
  public static func text(_ k: Kind) -> String {
    switch k {
    case .faceID(let f): return f.text
    case .noApprovalKey: return T(noKeyZH, noKeyEN)
    case .cancelled: return T(cancelZH, cancelEN)
    case .network: return T(networkZH, networkEN)
    }
  }
}

/// t1156u: the session-refresh rule for a user-initiated, idempotent save. No session -> sign in once (one Face ID), then POST.
/// HTTP 401 (session gone on the server) -> clear, sign in once more, POST once more. Never more than two POSTs.
public enum SessionRefresh {
  public static func post(hasSession: () -> Bool, signIn: () async throws -> Void, clear: () -> Void,
                          send: () async throws -> (Int, [String: Any])) async throws -> (Int, [String: Any]) {
    if !hasSession() { try await signIn() }
    let first = try await send()
    guard first.0 == 401 else { return first }
    clear(); try await signIn()
    return try await send()
  }
}
