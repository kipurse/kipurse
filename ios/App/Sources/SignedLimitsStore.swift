// SPDX-License-Identifier: Apache-2.0
import Foundation
import Security
import KipurseCore

/// t1275 (#2): the exact AI everyday limits the owner signed with Face ID on THIS phone, per wallet. Keychain, this device only,
/// readable after the first unlock, never synced / backed up. The trust ceiling comes ONLY from here (SignedLimits.ceiling);
/// the server's `everyday` reply can lower it but never raise it.
enum SignedLimitsStore {
  private static let svc = "com.kipurse.mainnet.signed-everyday"
  static func load(wallet: String) -> AISpendLimits.Saved? {
    if DemoGuard.active { return nil }
    guard let acc = SignedLimits.account(wallet: wallet) else { return nil }
    var out: CFTypeRef?
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: svc, kSecAttrAccount as String: acc, kSecReturnData as String: true]
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return SignedLimits.decode(String(data: d, encoding: .utf8))
  }
  /// Call ONLY with the numbers the phone key just signed and the server accepted.
  static func save(_ g: AISpendLimits.Saved, wallet: String) {
    if DemoGuard.active { return }
    guard let acc = SignedLimits.account(wallet: wallet), SignedLimits.decode(SignedLimits.encode(g)) == g else { return }
    let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: svc, kSecAttrAccount as String: acc]
    SecItemDelete(base as CFDictionary)
    var add = base; add[kSecValueData as String] = Data(SignedLimits.encode(g).utf8)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly; add[kSecAttrSynchronizable as String] = false
    let st = SecItemAdd(add as CFDictionary, nil)
    AuthLog.note("signed-limits", "saved status=\(st)")
  }
  /// Sign-out / wallet change: every wallet's copy goes.
  static func clear() { if DemoGuard.active { return }; SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: svc] as CFDictionary) }
  /// The ceiling for trust caps and the "AI can pay up to…" line. Demo: the sample limits (nothing is ever signed there).
  @MainActor static func ceiling(_ app: AppModel) -> (single: Int64, daily: Int64)? {
    let shown = AgentLimitsCard.policy(app.state ?? WalletState(.object([:])), demo: app.demo != nil)
    if DemoGuard.active || app.demo != nil { return OwnerAsk.trustCeiling(saved: shown) }
    return SignedLimits.ceiling(local: load(wallet: PhoneTrust.mainnetWallet), server: shown)
  }
}

/// t1275 (#2): the refusal when this phone holds no limits the owner signed here (e.g. they were set on another phone).
enum SignedLimitsCopy {
  static let noneZH = "这台手机上还没有你用 Face ID 签过的 AI 花钱上限，所以不能信任这个收款方，已停止，没有付款。请到「AI 花钱上限」点一次保存（Face ID），再回来批准。这次也可以选「只付这一次」。"
  static let noneEN = "This phone has no AI spending limits you signed here with Face ID, so this payee can't be trusted yet and nothing was paid. Open AI spending limits, tap Save once (Face ID), then approve again. You can also choose Pay just this once."
}
